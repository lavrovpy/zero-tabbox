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

interface MockWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  tabs: { id: number; windowId: number; pinned: boolean; lastAccessed?: number }[];
}

/** A normal window holding `tabIds`, unpinned unless listed in `pinned`. */
function win(id: number, tabIds: number[], extra: Partial<MockWindow> & { pinned?: number[] } = {}) {
  const { pinned = [], ...rest } = extra;
  return {
    id,
    focused: false,
    incognito: false,
    tabs: tabIds.map((tabId) => ({ id: tabId, windowId: id, pinned: pinned.includes(tabId) })),
    ...rest,
  };
}

const { store, mockApi } = (() => {
  const store = {
    lastSweep: undefined as LastSweep | undefined,
    lifetimeClosed: 0,
    /** `since` argument of every `forgetClosed` call. */
    forgetSince: [] as (number | undefined)[],
    removed: [] as number[][],
    created: 0,
    windowsCreated: 0,
    /** `[tabId, windowId, index]` of every `tabs.move`. */
    moved: [] as [number, number, number][],
    /** `exceptWindowId` of every auto-bookmark run. */
    bookmarkedExcept: [] as (number | undefined)[],
    settings: { keepPinned: false, autoBookmark: false },
    windows: [] as MockWindow[],
  };

  const mockApi = {
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: () => Promise.resolve(store.windows),
      create: () => {
        store.windowsCreated += 1;
        return Promise.resolve({ id: 99 });
      },
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
      move: (tabId: number, props: { windowId: number; index: number }) => {
        store.moved.push([tabId, props.windowId, props.index]);
        return Promise.resolve({});
      },
      update: () => Promise.resolve({}),
      get: (tabId: number) => {
        const move = [...store.moved].reverse().find(([id]) => id === tabId);
        return Promise.resolve({ id: tabId, windowId: move?.[1] });
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

mock.module('../src/bookmarks', () => ({
  bookmarkAtRiskTabs: (_keepPinned: boolean, _now: Date, options: { exceptWindowId?: number }) => {
    store.bookmarkedExcept.push(options.exceptWindowId);
    return Promise.resolve({ count: 0, folderPath: '' });
  },
}));

mock.module('../src/storage', () => ({
  getSettings: () =>
    Promise.resolve({ cutoffs: ['18:00'], noticeMinutes: 10, notify: true, ...store.settings }),
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

const { sweep, tabUsedBetween } = await import('../src/sweep');

beforeEach(() => {
  store.lastSweep = undefined;
  store.lifetimeClosed = 0;
  store.forgetSince.length = 0;
  store.removed.length = 0;
  store.created = 0;
  store.windowsCreated = 0;
  store.moved.length = 0;
  store.bookmarkedExcept.length = 0;
  store.settings = { keepPinned: false, autoBookmark: false };
  store.windows = [win(1, [11, 12, 13], { focused: true })];
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

describe('sweep — scoped to spare the clean window (design.md D8)', () => {
  it('closes only the other regular windows, and leaves private ones alone', async () => {
    store.windows = [
      win(1, [11, 12], { focused: true }), // the clean window, now holding the user's tabs
      win(2, [21, 22]), // restored after the catch-up
      win(3, [31], { incognito: true }), // opened by the user; restore never brings one back
    ];

    const result = await sweep('settle', {}, { cleanWindowId: 1 });

    expect(store.removed).toEqual([[21, 22]]);
    expect(result).toEqual({ closed: 2, cleanWindowId: 1 });
    expect(store.created).toBe(0); // the clean window already has tabs
  });

  it('spares the clean window even when it is not the focused one', async () => {
    store.windows = [win(1, [11]), win(2, [21], { focused: true })];

    await sweep('settle', {}, { cleanWindowId: 1 });

    expect(store.removed).toEqual([[21]]);
  });

  it('does nothing at all once the clean window is gone', async () => {
    store.windows = [win(2, [21, 22], { focused: true })];

    const result = await sweep('settle', {}, { cleanWindowId: 1 });

    expect(result).toEqual({ closed: 0 });
    expect(store.removed).toEqual([]);
    expect(store.lastSweep).toBeUndefined();
  });

  it('moves late pinned tabs in behind the clean window\'s own pinned block', async () => {
    store.settings.keepPinned = true;
    store.windows = [
      win(1, [10, 11], { focused: true, pinned: [10] }),
      win(2, [20, 21], { pinned: [20] }),
    ];

    await sweep('settle', {}, { cleanWindowId: 1 });

    // Index 1: after the one pinned tab, not after every tab in the window.
    expect(store.moved).toEqual([[20, 1, 1]]);
    expect(store.removed).toEqual([[21]]);
  });

  it('does not bookmark the clean window\'s tabs before the pass', async () => {
    store.settings.autoBookmark = true;
    store.windows = [win(1, [11], { focused: true }), win(2, [21])];

    await sweep('settle', {}, { cleanWindowId: 1 });
    await sweep('auto');

    expect(store.bookmarkedExcept).toEqual([1, undefined]);
  });
});

describe('sweep — reports the window it left clean', () => {
  it('names the kept regular window', async () => {
    store.windows = [win(1, [11]), win(2, [21], { focused: true })];

    expect((await sweep('auto')).cleanWindowId).toBe(2);
  });

  it('names the window it had to create when only private windows were open', async () => {
    store.windows = [win(3, [31], { incognito: true, focused: true })];

    const result = await sweep('auto');

    expect(store.windowsCreated).toBe(1);
    expect(result.cleanWindowId).toBe(99);
  });

  it('names none when there was no window at all', async () => {
    store.windows = [];

    expect(await sweep('auto')).toEqual({ closed: 0, cleanWindowId: undefined });
  });
});

describe('tabUsedBetween', () => {
  beforeEach(() => {
    // Tab 13 has no `lastAccessed`, as on Chrome < 121.
    store.windows = [
      {
        id: 1,
        focused: true,
        incognito: false,
        tabs: [
          { id: 12, windowId: 1, pinned: false, lastAccessed: 1_000 },
          { id: 13, windowId: 1, pinned: false },
        ],
      },
    ];
  });

  it('finds a tab activated inside the half-open window', async () => {
    expect(await tabUsedBetween(1_000, 1_001)).toBe(true);
    expect(await tabUsedBetween(500, 1_000)).toBe(false);
  });

  it('treats a tab without lastAccessed as unused', async () => {
    expect(await tabUsedBetween(0, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(await tabUsedBetween(2_000, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
