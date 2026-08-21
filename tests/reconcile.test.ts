/**
 * Idempotency and scheduling rules of the engine (tasks.md 3.4, 3.5).
 *
 * These are the tests that keep the product honest: every rule here maps to a
 * sweep-schedule.spec scenario about a sweep that must happen exactly once, or
 * must not happen at all. They drive `reconcile.ts` through its injected
 * dependencies with a fake clock, fake storage and a fake alarm table, so no
 * browser and none of the sibling modules' implementations are involved.
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import type { ReconcileDeps } from '../src/reconcile';
import { DEFAULT_SETTINGS, type Settings, type SweepReason } from '../src/types';

// `platform.ts` reads `globalThis.chrome` at module scope. Static imports would
// hoist above this assignment, so `reconcile` is imported dynamically below —
// after the fake is in place — and the module graph loads the same way it would
// in a browser.
(globalThis as Record<string, unknown>).chrome = {
  alarms: {
    create: async () => undefined,
    clear: async () => true,
    getAll: async () => [],
    onAlarm: { addListener: () => undefined },
  },
  runtime: { onStartup: { addListener: () => undefined } },
};

const { ALARM, armSettlePass, handleAlarm, handleNoticeAlarm, reconcile, runSweep, SETTLE_DELAY_MS } =
  await import('../src/reconcile');

// --- Local, deliberately independent cutoff arithmetic -----------------------
// `cutoff.ts` has its own tests; reimplementing the three functions here keeps
// these tests about the *decisions* reconcile makes, and keeps them runnable
// while the sibling module is still being written.

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function idFor(date: Date, hhmm: string): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${hhmm}`;
}

function atLocal(reference: Date, hhmm: string, dayOffset = 0): Date {
  return new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() + dayOffset,
    Number(hhmm.slice(0, 2)),
    Number(hhmm.slice(3, 5)),
    0,
    0,
  );
}

function latestElapsedCutoff(now: Date, cutoffs: readonly string[]): string | null {
  const sorted = [...cutoffs].sort();
  const last = sorted.at(-1);
  if (last === undefined) return null;
  let best: string | null = null;
  for (const hhmm of sorted) {
    if (atLocal(now, hhmm).getTime() <= now.getTime()) best = idFor(now, hhmm);
  }
  return best ?? idFor(atLocal(now, '00:00', -1), last);
}

function nextOccurrence(now: Date, hhmm: string): Date {
  const today = atLocal(now, hhmm);
  return today.getTime() > now.getTime() ? today : atLocal(now, hhmm, 1);
}

// --- Harness ----------------------------------------------------------------

interface State {
  now: Date;
  settings: Settings;
  marker: string;
  closedPerSweep: number;
  sweeps: SweepReason[];
  alarms: Map<string, number>;
  badge: (number | null)[];
  notices: string[];
}

const REPEATING = -1;

/**
 * A marker old enough that every cutoff in these tests is newer than it. The
 * default is deliberately *not* `''`: an unset marker means "fresh profile",
 * which seeds instead of sweeping (sweep-schedule.spec "Fresh install") and is
 * exercised on its own below.
 */
const LONG_AGO = '2020-01-01T00:00';

function harness(overrides: Partial<Pick<State, 'now' | 'marker' | 'closedPerSweep'>> & {
  settings?: Partial<Settings>;
} = {}): { state: State; deps: ReconcileDeps } {
  const state: State = {
    now: overrides.now ?? new Date(2026, 7, 19, 18, 5),
    settings: { ...DEFAULT_SETTINGS, ...overrides.settings },
    marker: overrides.marker ?? LONG_AGO,
    closedPerSweep: overrides.closedPerSweep ?? 7,
    sweeps: [],
    alarms: new Map(),
    badge: [],
    notices: [],
  };

  const deps: ReconcileDeps = {
    now: () => state.now,
    getSettings: async () => state.settings,
    getLastAutoCutoffId: async () => state.marker,
    setLastAutoCutoffId: async (cutoffId) => {
      state.marker = cutoffId;
    },
    sweep: async (reason) => {
      state.sweeps.push(reason);
      return { closed: state.closedPerSweep };
    },
    latestElapsedCutoff,
    nextOccurrence,
    getAlarms: async () => [...state.alarms.keys()].map((name) => ({ name })),
    createAlarm: async (name, when) => {
      state.alarms.set(name, when);
    },
    createRepeatingAlarm: async (name) => {
      state.alarms.set(name, REPEATING);
    },
    clearAlarm: async (name) => {
      state.alarms.delete(name);
    },
    setCountdownBadge: async (minutes) => {
      state.badge.push(minutes);
    },
    clearBadge: async () => {
      state.badge.push(null);
    },
    showNotice: async (hhmm) => {
      state.notices.push(hhmm);
    },
  };

  return { state, deps };
}

describe('reconcile — idempotency', () => {
  it('sweeps the first time a cutoff has elapsed and records its id', async () => {
    const { state, deps } = harness({ settings: { cutoffs: ['18:00'] } });

    await reconcile('alarm', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-19T18:00');
  });

  it('never sweeps the same cutoffId twice, however often it is triggered', async () => {
    const { state, deps } = harness({ settings: { cutoffs: ['18:00'] } });

    await reconcile('alarm', deps);
    // The alarm is re-delivered 45 s later, the worker cold-starts, the user
    // restarts the browser: all of them land back here (sweep-schedule.spec
    // "Timer fires twice" / "Restart after sweep").
    state.now = new Date(2026, 7, 19, 18, 5, 45);
    await reconcile('alarm', deps);
    state.now = new Date(2026, 7, 19, 18, 10);
    await reconcile('startup', deps);
    await reconcile('installed', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-19T18:00');
  });

  it('collapses several missed cutoffs into exactly one catch-up sweep', async () => {
    // Schedule 13:00 + 18:00, last swept yesterday 18:00, first opened at 20:00
    // (sweep-schedule.spec "Multiple cutoffs missed").
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 20, 0),
      marker: '2026-08-18T18:00',
      settings: { cutoffs: ['13:00', '18:00'] },
    });

    await reconcile('startup', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-19T18:00');
  });

  it('does not sweep on startup when no cutoff has elapsed since the last one', async () => {
    // Quit at 15:00, reopened at 16:00, cutoff 18:00, swept yesterday at 18:00.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 16, 0),
      marker: '2026-08-18T18:00',
      settings: { cutoffs: ['18:00'] },
    });

    await reconcile('startup', deps);

    expect(state.sweeps).toEqual([]);
    expect(state.marker).toBe('2026-08-18T18:00');
  });

  it('sweeps yesterday\'s last cutoff after midnight when today has none yet', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 9, 0),
      settings: { cutoffs: ['18:00'] },
    });

    await reconcile('startup', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-18T18:00');
  });
});

describe('reconcile — fresh install', () => {
  // sweep-schedule.spec "Default schedule / Fresh install": installing does not
  // sweep, it schedules. `latestElapsedCutoff` always names *some* elapsed
  // cutoff (yesterday's, after midnight), so without seeding the unset marker
  // the install itself would close every open tab — including the onboarding
  // page the extension just opened — with no pre-notice.
  it('seeds the marker instead of sweeping when it is unset', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 10, 0),
      marker: '',
      settings: { cutoffs: ['18:00'] },
    });

    await reconcile('installed', deps);

    expect(state.sweeps).toEqual([]);
    expect(state.marker).toBe('2026-08-18T18:00');
  });

  it('seeds on a bootstrap or startup reconcile too, and arms no settle pass', async () => {
    // Both entry points fire at install: the top-level bootstrap and onStartup.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 10, 0),
      marker: '',
      settings: { cutoffs: ['18:00'] },
    });

    await reconcile('wake', deps);
    await reconcile('startup', deps);

    expect(state.sweeps).toEqual([]);
    expect(state.alarms.has(ALARM.settle)).toBe(false);
    expect(state.marker).toBe('2026-08-18T18:00');
  });

  it('sweeps at the next cutoff after the seed, not before it', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 10, 0),
      marker: '',
      settings: { cutoffs: ['18:00'] },
    });

    await reconcile('installed', deps);
    expect(state.alarms.get(`${ALARM.sweepPrefix}18:00`)).toBe(
      new Date(2026, 7, 19, 18, 0).getTime(),
    );

    state.now = new Date(2026, 7, 19, 18, 0);
    await reconcile('alarm', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-19T18:00');
  });
});

describe('reconcile — manual sweeps', () => {
  it('does not advance the marker, so the next cutoff still fires', async () => {
    // "End day now" at 16:30, cutoff 18:00 (sweep-schedule.spec "Manual sweep
    // before cutoff"): the 18:00 sweep must still close what was opened after.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 16, 30),
      marker: '2026-08-18T18:00',
      settings: { cutoffs: ['18:00'] },
    });

    const closed = await runSweep('manual', undefined, deps);

    expect(closed).toBe(7);
    expect(state.sweeps).toEqual(['manual']);
    expect(state.marker).toBe('2026-08-18T18:00');

    state.now = new Date(2026, 7, 19, 18, 0);
    await reconcile('alarm', deps);

    expect(state.sweeps).toEqual(['manual', 'auto']);
    expect(state.marker).toBe('2026-08-19T18:00');
  });

  it('arms a one-shot badge clear and stops the countdown', async () => {
    const { state, deps } = harness({ now: new Date(2026, 7, 19, 16, 30) });
    state.alarms.set(ALARM.badge, REPEATING);

    await runSweep('manual', undefined, deps);

    expect(state.alarms.has(ALARM.badge)).toBe(false);
    expect(state.alarms.get(ALARM.badgeClear)).toBe(state.now.getTime() + 60_000);
  });
});

describe('reconcile — schedule changes', () => {
  it('fast-forwards the marker without sweeping when a cutoff moves into the past', async () => {
    // At 17:00 the cutoff changes 18:00 -> 16:00 (sweep-schedule.spec "Cutoff
    // moved to a time already past"): no immediate sweep, next one tomorrow.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 17, 0),
      marker: '2026-08-18T18:00',
      settings: { cutoffs: ['16:00'] },
    });

    await reconcile('settings-changed', deps);

    expect(state.sweeps).toEqual([]);
    expect(state.marker).toBe('2026-08-19T16:00');
    expect(state.alarms.get(`${ALARM.sweepPrefix}16:00`)).toBe(
      new Date(2026, 7, 20, 16, 0).getTime(),
    );

    // And a later wake-up must not retroactively sweep for it either.
    state.now = new Date(2026, 7, 19, 17, 30);
    await reconcile('alarm', deps);
    expect(state.sweeps).toEqual([]);
  });

  it('still arms a cutoff that is later today when it moves earlier', async () => {
    // At 15:00 the cutoff changes 18:00 -> 16:00: a sweep must run at 16:00.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 15, 0),
      marker: '2026-08-18T18:00',
      settings: { cutoffs: ['16:00'] },
    });

    await reconcile('settings-changed', deps);
    expect(state.sweeps).toEqual([]);
    expect(state.alarms.get(`${ALARM.sweepPrefix}16:00`)).toBe(
      new Date(2026, 7, 19, 16, 0).getTime(),
    );

    state.now = new Date(2026, 7, 19, 16, 0);
    await reconcile('alarm', deps);
    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-19T16:00');
  });

  it('drops alarms for cutoffs that no longer exist', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 12, 0),
      marker: '2026-08-19T09:00',
      settings: { cutoffs: ['18:00'], noticeMinutes: 10 },
    });
    state.alarms.set(`${ALARM.sweepPrefix}09:00`, 1);
    state.alarms.set(`${ALARM.noticePrefix}09:00`, 1);

    await reconcile('settings-changed', deps);

    expect([...state.alarms.keys()].sort()).toEqual([
      `${ALARM.noticePrefix}18:00`,
      `${ALARM.sweepPrefix}18:00`,
    ]);
    expect(state.alarms.get(`${ALARM.noticePrefix}18:00`)).toBe(
      new Date(2026, 7, 19, 17, 50).getTime(),
    );
  });

  it('arms no notice alarm when the pre-notice is disabled', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 12, 0),
      marker: '2026-08-19T09:00',
      settings: { cutoffs: ['18:00'], noticeMinutes: 0 },
    });

    await reconcile('alarm', deps);

    expect([...state.alarms.keys()]).toEqual([`${ALARM.sweepPrefix}18:00`]);
    expect(state.badge).toEqual([]);
  });
});

describe('reconcile — startup settle pass (design.md D8)', () => {
  it('arms the settle alarm after a startup catch-up sweep', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 9, 0),
      settings: { cutoffs: ['18:00'] },
    });

    await reconcile('startup', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.alarms.get(ALARM.settle)).toBe(state.now.getTime() + SETTLE_DELAY_MS);
  });

  it('does not arm it for a sweep that did not come from startup', async () => {
    const { state, deps } = harness({ settings: { cutoffs: ['18:00'] } });

    await reconcile('alarm', deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.alarms.has(ALARM.settle)).toBe(false);
  });

  it('does not arm it for a background cold start at an ordinary cutoff', async () => {
    // The background is cold-started by the `sweep:18:00` alarm itself, and the
    // bootstrap `reconcile('wake')` in background.ts is queued before the alarm
    // is dispatched, so it is the call that sweeps. Arming a settle pass here
    // would close whatever the user opened in the following minute, every day.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 18, 0),
      marker: '2026-08-18T18:00',
      settings: { cutoffs: ['18:00'] },
    });

    const swept = await reconcile('wake', deps);

    expect(swept).toBe(true);
    expect(state.sweeps).toEqual(['auto']);
    expect(state.alarms.has(ALARM.settle)).toBe(false);
  });

  it('reports whether it swept, so onStartup can arm the pass the bootstrap earned', async () => {
    // background.ts hands off on this boolean: at a real browser start the
    // bootstrap sweeps and `onStartup` arms the settle pass on its behalf.
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 9, 0),
      marker: '2026-08-18T09:00',
      settings: { cutoffs: ['18:00'] },
    });

    expect(await reconcile('wake', deps)).toBe(true);
    expect(await reconcile('startup', deps)).toBe(false);
    expect(state.sweeps).toEqual(['auto']);

    await armSettlePass(deps);
    expect(state.alarms.get(ALARM.settle)).toBe(state.now.getTime() + SETTLE_DELAY_MS);
  });

  it('sweeps once more without reading or advancing the marker', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 9, 0),
      settings: { cutoffs: ['18:00'] },
    });
    await reconcile('startup', deps);
    const markerAfterCatchUp = state.marker;

    state.now = new Date(2026, 7, 19, 9, 1);
    await handleAlarm({ name: ALARM.settle }, deps);

    expect(state.sweeps).toEqual(['auto', 'settle']);
    expect(state.marker).toBe(markerAfterCatchUp);
  });

  it('fires once: nothing re-arms it, and it does not sweep again', async () => {
    const { state, deps } = harness({
      now: new Date(2026, 7, 19, 9, 0),
      settings: { cutoffs: ['18:00'] },
    });
    await reconcile('startup', deps);

    state.now = new Date(2026, 7, 19, 9, 1);
    await handleAlarm({ name: ALARM.settle }, deps);
    state.alarms.delete(ALARM.settle); // a one-shot alarm is gone once fired

    // Later wake-ups reconcile normally and must neither sweep nor re-arm it.
    state.now = new Date(2026, 7, 19, 9, 5);
    await reconcile('alarm', deps);
    await reconcile('startup', deps);

    expect(state.sweeps).toEqual(['auto', 'settle']);
    expect(state.alarms.has(ALARM.settle)).toBe(false);
  });
});

describe('alarm routing', () => {
  let state: State;
  let deps: ReconcileDeps;

  beforeEach(() => {
    ({ state, deps } = harness({
      now: new Date(2026, 7, 19, 17, 50),
      marker: '2026-08-19T09:00',
      settings: { cutoffs: ['18:00'], noticeMinutes: 10 },
    }));
  });

  it('shows one notification and starts the countdown on a notice alarm', async () => {
    await handleAlarm({ name: `${ALARM.noticePrefix}18:00` }, deps);

    expect(state.notices).toEqual(['18:00']);
    expect(state.alarms.get(ALARM.badge)).toBe(REPEATING);
    expect(state.badge).toEqual([10]);
    expect(state.sweeps).toEqual([]);
  });

  it('counts the badge down in minutes', async () => {
    state.now = new Date(2026, 7, 19, 17, 52);

    await handleAlarm({ name: ALARM.badge }, deps);

    // sweep-controls.spec "Badge countdown": 17:52 before an 18:00 cutoff is 8.
    expect(state.badge).toEqual([8]);
  });

  it('skips the notification when the user turned it off', async () => {
    state.settings = { ...state.settings, notify: false };

    await handleNoticeAlarm(`${ALARM.noticePrefix}18:00`, deps);

    expect(state.notices).toEqual([]);
    expect(state.alarms.get(ALARM.badge)).toBe(REPEATING);
  });

  it('ignores a notice alarm left over from a deleted cutoff', async () => {
    await handleAlarm({ name: `${ALARM.noticePrefix}09:00` }, deps);

    expect(state.notices).toEqual([]);
    expect(state.badge).toEqual([]);
    expect(state.alarms.has(ALARM.badge)).toBe(false);
  });

  it('stands the countdown down once the cutoff window has passed', async () => {
    state.alarms.set(ALARM.badge, REPEATING);
    state.now = new Date(2026, 7, 19, 18, 30);

    await handleAlarm({ name: ALARM.badge }, deps);

    expect(state.alarms.has(ALARM.badge)).toBe(false);
    expect(state.badge).toEqual([null]);
  });

  it('clears the badge when the one-shot clear fires', async () => {
    await handleAlarm({ name: ALARM.badgeClear }, deps);

    expect(state.badge).toEqual([null]);
  });

  it('routes a sweep alarm through reconcile', async () => {
    state.now = new Date(2026, 7, 19, 18, 0);

    await handleAlarm({ name: `${ALARM.sweepPrefix}18:00` }, deps);

    expect(state.sweeps).toEqual(['auto']);
    expect(state.marker).toBe('2026-08-19T18:00');
  });

  it('keeps an overdue notice alarm that has not been delivered yet', async () => {
    // Alarm delivery can lag. Re-arming must not throw away the pending
    // notification for a cutoff that is still ahead (sweep-controls.spec
    // "Pre-cutoff notice"), and must not re-arm it either — that would re-fire
    // the notification on every wake inside the window.
    const armedAt = new Date(2026, 7, 19, 17, 50).getTime();
    state.now = new Date(2026, 7, 19, 17, 55);
    state.alarms.set(`${ALARM.noticePrefix}18:00`, armedAt);

    await reconcile('wake', deps);

    expect(state.alarms.get(`${ALARM.noticePrefix}18:00`)).toBe(armedAt);
    expect(state.notices).toEqual([]);
  });

  it('resumes the countdown when the browser starts inside the notice window', async () => {
    // Restart at 17:55 with a 10-minute notice: the notice alarm time is
    // already past, so re-arming has to pick the countdown up directly.
    state.now = new Date(2026, 7, 19, 17, 55);

    await reconcile('startup', deps);

    expect(state.alarms.has(`${ALARM.noticePrefix}18:00`)).toBe(false);
    expect(state.alarms.get(ALARM.badge)).toBe(REPEATING);
    expect(state.badge).toEqual([5]);
  });
});
