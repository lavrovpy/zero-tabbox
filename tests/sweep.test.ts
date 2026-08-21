/**
 * Bookkeeping rules of a single sweep (tasks.md 4.1, design.md D8).
 *
 * The tab-closing algorithm itself is exercised through a fake `windows`/`tabs`
 * API; what these tests are really about is the two rules that decide what a
 * sweep leaves behind: which sweep a `settle` pass folds its count into, and
 * that Firefox's recently-closed list is only cleared of entries this sweep
 * created (tab-sweep.spec "Sweep does not create a recoverable archive").
 */
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { LastSweep } from '../src/types';

const { store, mockApi } = (() => {
  const store = {
    lastSweep: undefined as LastSweep | undefined,
    lifetimeClosed: 0,
    /** `since` argument of every `forgetClosed` call. */
    forgetSince: [] as (number | undefined)[],
    removed: [] as number[][],
    created: 0,
  };

  const windows = [
    {
      id: 1,
      focused: true,
      incognito: false,
      tabs: [
        { id: 11, windowId: 1, pinned: false },
        { id: 12, windowId: 1, pinned: false },
        { id: 13, windowId: 1, pinned: false },
      ],
    },
  ];

  const mockApi = {
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: () => Promise.resolve(windows),
      create: () => Promise.resolve({}),
    },
    tabs: {
      remove: (ids: number[]) => {
        store.removed.push(ids);
        return Promise.resolve();
      },
      create: () => {
        store.created += 1;
        return Promise.resolve({});
      },
    },
  };

  return { store, mockApi };
})();

mock.module('../src/platform', () => ({
  api: mockApi as unknown as typeof chrome,
  isFirefox: () => false,
  forgetClosed: (since?: number) => {
    store.forgetSince.push(since);
    return Promise.resolve();
  },
}));

mock.module('../src/badge', () => ({
  setClosedBadge: () => Promise.resolve(),
  clearBadge: () => Promise.resolve(),
}));

mock.module('../src/storage', () => ({
  getSettings: () =>
    Promise.resolve({ cutoffs: ['18:00'], noticeMinutes: 10, notify: true, keepPinned: false }),
  getLastSweep: () => Promise.resolve(store.lastSweep),
  setLastSweep: (value: LastSweep) => {
    store.lastSweep = value;
    return Promise.resolve();
  },
  bumpStats: (closed: number) => {
    store.lifetimeClosed += closed;
    return Promise.resolve({ lifetimeClosed: store.lifetimeClosed });
  },
}));

const { sweep } = await import('../src/sweep');

beforeEach(() => {
  store.lastSweep = undefined;
  store.lifetimeClosed = 0;
  store.forgetSince.length = 0;
  store.removed.length = 0;
  store.created = 0;
  spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('sweep — records', () => {
  it('closes every tab and records the count', async () => {
    const result = await sweep('auto');

    expect(result.closed).toBe(3);
    expect(store.removed).toEqual([[11, 12, 13]]);
    expect(store.created).toBe(1); // the one guaranteed clean new-tab page
    expect(store.lastSweep).toMatchObject({ reason: 'auto', closed: 3 });
    expect(store.lifetimeClosed).toBe(3);
  });

  it('records a manual sweep as manual', async () => {
    await sweep('manual');
    expect(store.lastSweep).toMatchObject({ reason: 'manual', closed: 3 });
  });
});

describe('sweep — the settle pass (design.md D8)', () => {
  it('folds its count into the catch-up sweep that armed it', async () => {
    store.lastSweep = { reason: 'auto', at: Date.now() - 30_000, closed: 40 };

    await sweep('settle');

    // One sweep in the stats, with the full total — not a second sweep.
    expect(store.lastSweep).toMatchObject({ reason: 'auto', closed: 43 });
  });

  it('does not fold into an "End day now" that landed in the 60 s gap', async () => {
    // The manual sweep's own record must not be rewritten by a settle pass it
    // has nothing to do with (sweep-schedule.spec "Manual sweep does not
    // replace scheduled cutoffs" — the two are separate events).
    store.lastSweep = { reason: 'manual', at: Date.now() - 1_000, closed: 2 };

    await sweep('settle');

    expect(store.lastSweep).toMatchObject({ reason: 'auto', closed: 3 });
  });

  it('does not fold into an unrelated older sweep', async () => {
    store.lastSweep = { reason: 'auto', at: Date.now() - 6 * 60 * 60 * 1000, closed: 40 };

    await sweep('settle');

    expect(store.lastSweep).toMatchObject({ reason: 'auto', closed: 3 });
  });
});

describe('sweep — recently-closed list', () => {
  it('bounds the Firefox forget pass to the entries this sweep created', async () => {
    const before = Date.now();

    await sweep('auto');

    const since = store.forgetSince[0];
    expect(typeof since).toBe('number');
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
  });
});
