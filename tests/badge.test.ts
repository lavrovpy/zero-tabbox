/**
 * Unit tests for the badge and the pre-cutoff notification (tasks.md 5.1/5.2,
 * sweep-controls.spec "Pre-cutoff notice" / "Post-sweep feedback is minimal").
 *
 * `action` and `notifications` are faked behind the `platform` module, so these
 * exercise the real code path. The property under test in almost every case is
 * the same one: **nothing in badge.ts may reject**. `sweep()` awaits
 * `setClosedBadge`, so a badge failure that escaped would turn a completed sweep
 * into a failed one and lose its counters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, mockApi, fail } = vi.hoisted(() => {
  const calls = {
    badge: [] as string[],
    notifications: [] as { id: string; options: Record<string, unknown> }[],
  };
  /** Flipped by a test to make every extension call reject. */
  const fail = { now: false };

  const mockApi = {
    action: {
      setBadgeText({ text }: { text: string }): Promise<void> {
        if (fail.now) return Promise.reject(new Error('no action API'));
        calls.badge.push(text);
        return Promise.resolve();
      },
    },
    notifications: {
      create(id: string, options: Record<string, unknown>): Promise<string> {
        if (fail.now) return Promise.reject(new Error('notifications disabled'));
        calls.notifications.push({ id, options });
        return Promise.resolve(id);
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://zero-tabbox/${path}`,
    },
  };

  return { calls, mockApi, fail };
});

vi.mock('../src/platform', () => ({
  api: mockApi as unknown as typeof chrome,
  isFirefox: () => false,
  createAlarm: () => Promise.resolve(),
  createRepeatingAlarm: () => Promise.resolve(),
  forgetClosed: () => Promise.resolve(),
}));

const { clearBadge, setClosedBadge, setCountdownBadge, showNoticeNotification } = await import(
  '../src/badge'
);

beforeEach(() => {
  calls.badge.length = 0;
  calls.notifications.length = 0;
  fail.now = false;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('setCountdownBadge', () => {
  it('shows the whole minutes remaining', async () => {
    // sweep-controls.spec: cutoff 18:00, N=10, time 17:52 -> the badge shows 8.
    await setCountdownBadge(8);
    expect(calls.badge).toEqual(['8']);
  });

  it('clears rather than showing 0 once the cutoff has arrived', async () => {
    // The sweep's own count takes the badge over within the second; a stale `0`
    // would be the only moment the badge lied.
    await setCountdownBadge(0);
    await setCountdownBadge(-3);
    expect(calls.badge).toEqual(['', '']);
  });

  it('clears on a non-finite count instead of writing "NaN"', async () => {
    await setCountdownBadge(Number.NaN);
    expect(calls.badge).toEqual(['']);
  });
});

describe('setClosedBadge', () => {
  it('shows the number of tabs closed', async () => {
    // sweep-controls.spec "Badge after sweep": 37 tabs closed -> badge shows 37.
    await setClosedBadge(37);
    expect(calls.badge).toEqual(['37']);
  });

  it('clears when a sweep closed nothing', async () => {
    await setClosedBadge(0);
    expect(calls.badge).toEqual(['']);
  });

  it('never rejects, so a badge failure cannot fail the sweep that set it', async () => {
    fail.now = true;
    await expect(setClosedBadge(37)).resolves.toBeUndefined();
  });
});

describe('clearBadge', () => {
  it('writes empty text', async () => {
    await clearBadge();
    expect(calls.badge).toEqual(['']);
  });

  it('never rejects', async () => {
    fail.now = true;
    await expect(clearBadge()).resolves.toBeUndefined();
  });
});

describe('showNoticeNotification', () => {
  it('names the cutoff time and carries no action buttons', async () => {
    await showNoticeNotification('18:00', 10);

    expect(calls.notifications).toHaveLength(1);
    const { options } = calls.notifications[0]!;
    expect(options['type']).toBe('basic');
    expect(options['title']).toContain('18:00');
    expect(options['message']).toContain('10 minutes');
    // sweep-controls.spec "Notification has no actions" — and Firefox supports
    // only these four properties, so anything else would be dropped anyway.
    expect(Object.keys(options).sort()).toEqual(['iconUrl', 'message', 'title', 'type']);
  });

  it('provides the packaged iconUrl that notifications.create requires', async () => {
    await showNoticeNotification('18:00', 10);
    expect(calls.notifications[0]!.options['iconUrl']).toContain('icons/icon128.png');
  });

  it('reuses one id so a second notice replaces the first rather than stacking', async () => {
    await showNoticeNotification('13:00', 10);
    await showNoticeNotification('18:00', 10);
    const [first, second] = calls.notifications;
    expect(first!.id).toBe(second!.id);
  });

  it('says "1 minute", not "1 minutes"', async () => {
    await showNoticeNotification('18:00', 1);
    expect(calls.notifications[0]!.options['message']).toContain('1 minute ');
  });

  it('never rejects when the browser refuses the notification', async () => {
    fail.now = true;
    await expect(showNoticeNotification('18:00', 10)).resolves.toBeUndefined();
  });
});
