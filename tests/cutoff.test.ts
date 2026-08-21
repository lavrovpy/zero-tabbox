/**
 * Unit tests for the schedule maths (tasks.md 3.1).
 *
 * Two styles are mixed on purpose:
 *
 *  - Zone-agnostic invariants, run in whatever timezone the machine (or CI) is
 *    set to. They assert relationships that hold everywhere — "the returned
 *    instant has the requested wall-clock time", "it is strictly in the future".
 *  - Zone-pinned cases, which set `process.env.TZ` around the call. Node honours
 *    a TZ change at runtime (>= 16), so the DST-forward, DST-back and
 *    UTC-offset cases can be asserted with exact numbers instead of hand-waving.
 *    If a host ever stops honouring it, `TZ_SWITCHING_WORKS` turns those blocks
 *    into skips rather than false failures.
 */
import { describe, expect, it } from 'bun:test';

import { cutoffId, isValidHhMm, latestElapsedCutoff, nextOccurrence, parseHhMm } from '../src/cutoff';

const HOUR_MS = 3_600_000;

/**
 * Minimal local declaration of the one Node global these tests touch. The
 * project deliberately builds against `@types/chrome` only (tsconfig `types`),
 * so there is no `@types/node` to borrow `process` from.
 */
declare const process: { env: Record<string, string | undefined> };

/**
 * The zone the test runner started in (`bun test` pins this to UTC unless TZ
 * is exported). Restoration below assigns this concrete name rather than
 * deleting TZ: after a `delete process.env.TZ`, Bun keeps the previous zone
 * cached and silently ignores every later TZ assignment, which would leave all
 * the switches below stuck on the first zone used.
 */
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Runs `fn` with `process.env.TZ` temporarily set to `tz`. */
function withTz<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ ?? HOST_TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

/** New York is UTC-5 in January; if that is what we observe, TZ switching works. */
const TZ_SWITCHING_WORKS = withTz(
  'America/New_York',
  () => new Date(2026, 0, 15, 12, 0).getTimezoneOffset() === 300,
);

const describeZoned = TZ_SWITCHING_WORKS ? describe : describe.skip;

describe('parseHhMm / isValidHhMm', () => {
  it('accepts zero-padded 24-hour times', () => {
    expect(parseHhMm('00:00')).toEqual({ hours: 0, minutes: 0 });
    expect(parseHhMm('09:05')).toEqual({ hours: 9, minutes: 5 });
    expect(parseHhMm('13:00')).toEqual({ hours: 13, minutes: 0 });
    expect(parseHhMm('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('rejects "9:00" — padding is required so ids stay lexically comparable', () => {
    expect(parseHhMm('9:00')).toBeNull();
    expect(isValidHhMm('9:00')).toBe(false);
    expect(isValidHhMm('09:00')).toBe(true);
  });

  it('rejects out-of-range and malformed values', () => {
    for (const bad of [
      '24:00',
      '25:00',
      '23:60',
      '99:99',
      '18:0',
      '180:0',
      '18:00 ',
      ' 18:00',
      '18.00',
      '18-00',
      '',
      'nope',
      '1800',
      '+8:00',
      '18:00:00',
    ]) {
      expect(isValidHhMm(bad), bad).toBe(false);
    }
  });
});

describe('cutoffId', () => {
  it('takes the date from the Date and the time from the HH:MM', () => {
    // 03:00 local on 19 Aug 2026 + cutoff "18:00" => that day's 18:00 cutoff.
    expect(cutoffId(new Date(2026, 7, 19, 3, 0), '18:00')).toBe('2026-08-19T18:00');
  });

  it('zero-pads every field', () => {
    expect(cutoffId(new Date(2026, 0, 5, 12, 0), '09:05')).toBe('2026-01-05T09:05');
    expect(cutoffId(new Date(999, 8, 9, 0, 0), '00:00')).toBe('0999-09-09T00:00');
  });

  it('throws on an invalid HH:MM', () => {
    expect(() => cutoffId(new Date(), '9:00')).toThrow(RangeError);
    expect(() => cutoffId(new Date(), '24:00')).toThrow(RangeError);
  });

  it('sorts lexically in chronological order', () => {
    const chronological = [
      cutoffId(new Date(2025, 11, 31, 12, 0), '18:00'),
      cutoffId(new Date(2026, 0, 1, 12, 0), '09:05'),
      cutoffId(new Date(2026, 0, 1, 12, 0), '13:00'),
      cutoffId(new Date(2026, 0, 1, 12, 0), '18:00'),
      cutoffId(new Date(2026, 0, 2, 12, 0), '00:00'),
      cutoffId(new Date(2026, 9, 5, 12, 0), '18:00'),
    ];
    expect([...chronological].sort()).toEqual(chronological);
    // The empty-marker default sorts before every real id, so the very first
    // cutoff after install always sweeps (storage.getLastAutoCutoffId).
    expect([...chronological, ''].sort()[0]).toBe('');
  });
});

describe('latestElapsedCutoff', () => {
  it('returns null when nothing valid is configured', () => {
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 12, 0), [])).toBeNull();
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 12, 0), ['9:00', 'nope'])).toBeNull();
  });

  it('returns today’s cutoff once it has elapsed', () => {
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 19, 0), ['18:00'])).toBe('2026-08-19T18:00');
  });

  it('counts a cutoff exactly at `now` as elapsed', () => {
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 18, 0, 0, 0), ['18:00'])).toBe(
      '2026-08-19T18:00',
    );
    // ...and one millisecond earlier it is not.
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 17, 59, 59, 999), ['18:00'])).toBe(
      '2026-08-18T18:00',
    );
  });

  it('wraps to yesterday before today’s first cutoff', () => {
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 9, 0), ['18:00'])).toBe('2026-08-18T18:00');
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 0, 0, 0, 1), ['18:00'])).toBe(
      '2026-08-18T18:00',
    );
  });

  it('wraps across a month and a year boundary', () => {
    expect(latestElapsedCutoff(new Date(2026, 8, 1, 9, 0), ['18:00'])).toBe('2026-08-31T18:00');
    expect(latestElapsedCutoff(new Date(2026, 0, 1, 9, 0), ['18:00'])).toBe('2025-12-31T18:00');
  });

  it('picks the most recent of several cutoffs, in any input order', () => {
    const schedule = ['18:00', '13:00'];
    // Before the first: yesterday's last.
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 12, 0), schedule)).toBe('2026-08-18T18:00');
    // Between them: today's first.
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 15, 0), schedule)).toBe('2026-08-19T13:00');
    // After both: today's last. Several missed cutoffs collapse to one id, which
    // is what makes the catch-up sweep run once (sweep-schedule.spec).
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 20, 0), schedule)).toBe('2026-08-19T18:00');
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 20, 0), ['13:00', '18:00'])).toBe(
      '2026-08-19T18:00',
    );
  });

  it('handles a full four-cutoff schedule including midnight', () => {
    const schedule = ['00:00', '09:00', '13:00', '18:00'];
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 0, 0), schedule)).toBe('2026-08-19T00:00');
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 8, 59), schedule)).toBe('2026-08-19T00:00');
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 23, 59), schedule)).toBe('2026-08-19T18:00');
  });

  it('ignores invalid entries instead of failing the whole schedule', () => {
    expect(latestElapsedCutoff(new Date(2026, 7, 19, 20, 0), ['nope', '18:00', '9:00'])).toBe(
      '2026-08-19T18:00',
    );
  });
});

describe('nextOccurrence', () => {
  it('returns today when the time is still ahead', () => {
    const now = new Date(2026, 7, 19, 9, 0);
    const next = nextOccurrence(now, '18:00');
    expect(next.getDate()).toBe(19);
    expect(next.getHours()).toBe(18);
    expect(next.getMinutes()).toBe(0);
  });

  it('returns tomorrow when the time has passed', () => {
    const next = nextOccurrence(new Date(2026, 7, 19, 19, 0), '18:00');
    expect(next.getDate()).toBe(20);
    expect(next.getHours()).toBe(18);
  });

  it('is strictly in the future, even exactly at the cutoff', () => {
    // The alarm for a cutoff that just fired must be tomorrow's, never a
    // re-arm of the same instant (which would fire immediately, forever).
    const now = new Date(2026, 7, 19, 18, 0, 0, 0);
    const next = nextOccurrence(now, '18:00');
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getDate()).toBe(20);
  });

  it('wraps across month and year boundaries', () => {
    expect(nextOccurrence(new Date(2026, 7, 31, 19, 0), '18:00').getMonth()).toBe(8);
    const newYear = nextOccurrence(new Date(2026, 11, 31, 19, 0), '18:00');
    expect(newYear.getFullYear()).toBe(2027);
    expect(newYear.getMonth()).toBe(0);
    expect(newYear.getDate()).toBe(1);
  });

  it('always lands on the requested wall clock, in whatever zone the host uses', () => {
    for (const hhmm of ['00:00', '09:05', '13:00', '18:00', '23:59']) {
      // Narrows `HhMm | null` without a cast, and fails loudly if this fixture
      // list ever drifts away from valid HH:MM.
      const expected = parseHhMm(hhmm);
      if (expected === null) throw new Error(`fixture "${hhmm}" is not valid HH:MM`);
      const { hours, minutes } = expected;

      for (const now of [
        new Date(2026, 2, 8, 1, 30),
        new Date(2026, 6, 19, 12, 0),
        new Date(2026, 10, 1, 1, 30),
        new Date(2026, 11, 31, 23, 30),
      ]) {
        const next = nextOccurrence(now, hhmm);
        expect(next.getHours(), `${hhmm} @ ${now.toString()}`).toBe(hours);
        expect(next.getMinutes(), `${hhmm} @ ${now.toString()}`).toBe(minutes);
        const delta = next.getTime() - now.getTime();
        expect(delta).toBeGreaterThan(0);
        // At most a day plus the largest DST step.
        expect(delta).toBeLessThanOrEqual(26 * HOUR_MS);
      }
    }
  });

  it('throws on an invalid HH:MM', () => {
    expect(() => nextOccurrence(new Date(), '9:00')).toThrow(RangeError);
  });
});

describeZoned('DST (America/New_York)', () => {
  it('spring forward: the next 18:00 is 21 real hours away, not 22', () => {
    withTz('America/New_York', () => {
      // Sat 7 Mar 20:00 EST. Clocks jump 02:00 -> 03:00 on Sun 8 Mar.
      const now = new Date(2026, 2, 7, 20, 0);
      const next = nextOccurrence(now, '18:00');
      expect(next.getDate()).toBe(8);
      expect(next.getHours()).toBe(18); // still 18:00 wall clock
      expect((next.getTime() - now.getTime()) / HOUR_MS).toBe(21); // 22 - 1 lost hour
    });
  });

  it('fall back: the next 18:00 is 23 real hours away, not 22', () => {
    withTz('America/New_York', () => {
      // Sat 31 Oct 20:00 EDT. Clocks repeat 01:00-02:00 on Sun 1 Nov.
      const now = new Date(2026, 9, 31, 20, 0);
      const next = nextOccurrence(now, '18:00');
      expect(next.getDate()).toBe(1);
      expect(next.getMonth()).toBe(10);
      expect(next.getHours()).toBe(18);
      expect((next.getTime() - now.getTime()) / HOUR_MS).toBe(23); // 22 + 1 repeated hour
    });
  });

  it('a cutoff inside the skipped hour fires when the clock jumps past it', () => {
    withTz('America/New_York', () => {
      // 02:30 does not exist on 8 Mar 2026; the browser's own clock goes
      // 01:59:59 -> 03:00:00, so the alarm lands at 03:30 that day.
      const next = nextOccurrence(new Date(2026, 2, 8, 1, 0), '02:30');
      expect(next.getDate()).toBe(8);
      expect(next.getHours()).toBe(3);
      expect(next.getMinutes()).toBe(30);
    });
  });

  it('a cutoff inside the repeated hour uses its first occurrence', () => {
    withTz('America/New_York', () => {
      // 01:30 happens twice on 1 Nov 2026; the first (EDT) one wins, so the
      // sweep runs at the earlier of the two, never twice.
      const now = new Date(2026, 10, 1, 0, 30);
      const next = nextOccurrence(now, '01:30');
      expect(next.getHours()).toBe(1);
      expect((next.getTime() - now.getTime()) / HOUR_MS).toBe(1);
    });
  });

  it('latestElapsedCutoff keeps the wall-clock day across a spring forward', () => {
    withTz('America/New_York', () => {
      // Noon on the short day: yesterday's 18:00 is the latest elapsed cutoff,
      // 17 real hours ago rather than 18.
      const now = new Date(2026, 2, 8, 12, 0);
      expect(latestElapsedCutoff(now, ['18:00'])).toBe('2026-03-07T18:00');
      const yesterdayCutoff = new Date(2026, 2, 7, 18, 0);
      expect((now.getTime() - yesterdayCutoff.getTime()) / HOUR_MS).toBe(17);
    });
  });

  it('latestElapsedCutoff keeps the wall-clock day across a fall back', () => {
    withTz('America/New_York', () => {
      const now = new Date(2026, 10, 1, 12, 0);
      expect(latestElapsedCutoff(now, ['18:00'])).toBe('2026-10-31T18:00');
      const yesterdayCutoff = new Date(2026, 9, 31, 18, 0);
      expect((now.getTime() - yesterdayCutoff.getTime()) / HOUR_MS).toBe(19);
    });
  });
});

describeZoned('timezone independence', () => {
  it('uses the local calendar day, never the UTC one', () => {
    // 08:00 in Tokyo on 19 Aug is still 18 Aug in UTC. The id must say the 19th,
    // or the marker would jump a day for everyone east of Greenwich.
    withTz('Asia/Tokyo', () => {
      const morning = new Date(2026, 7, 19, 8, 0);
      expect(morning.toISOString().slice(0, 10)).toBe('2026-08-18'); // UTC would lie
      expect(cutoffId(morning, '18:00')).toBe('2026-08-19T18:00');
      expect(latestElapsedCutoff(morning, ['18:00'])).toBe('2026-08-18T18:00');
    });
    // Same wall-clock reading west of Greenwich, where UTC agrees on the date.
    withTz('Pacific/Honolulu', () => {
      expect(cutoffId(new Date(2026, 7, 19, 20, 0), '18:00')).toBe('2026-08-19T18:00');
    });
  });

  it('gives the same cutoffId for the same wall clock in any zone', () => {
    const ids = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata'].map(
      (tz) => withTz(tz, () => latestElapsedCutoff(new Date(2026, 7, 19, 20, 0), ['18:00'])),
    );
    expect(new Set(ids)).toEqual(new Set(['2026-08-19T18:00']));
  });
});
