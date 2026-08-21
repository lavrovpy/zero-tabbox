/**
 * The bookmark escape hatch, and the two ways it must never hurt the user
 * (design.md D12, tab-sweep.spec "Bookmarks are the only escape hatch").
 *
 * `windows`, `tabs` and `bookmarks` are faked behind the `platform` module, so
 * both the real `bookmarks.ts` and — for the two sweep scenarios — the real
 * `sweep.ts` run against them. That matters here: the point of the sweep tests
 * is that the *actual* wiring between the two modules survives a bookmarking
 * failure and stays silent when nobody asked for a bookmark, which a stubbed
 * `bookmarkAtRiskTabs` would not prove.
 */
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { LastSweep, Settings } from '../src/types';

/** A tab as the fake `windows.getAll({ populate: true })` reports it. */
interface FakeTab {
  id: number;
  pinned: boolean;
  url: string | undefined;
  title: string | undefined;
}

/** A window as the fake `windows.getAll` reports it. */
interface FakeWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  tabs: FakeTab[];
}

/** A node in the fake bookmark tree. A folder is a node without a `url`. */
interface FakeNode {
  id: string;
  parentId: string | undefined;
  title: string;
  url: string | undefined;
}

const { state, mockApi } = (() => {
  const state = {
    windows: [] as FakeWindow[],
    nodes: [] as FakeNode[],
    /** Every `bookmarks.create` call, including the ones made to reject. */
    createCalls: [] as { parentId?: string; title?: string; url?: string }[],
    /** Flipped by a test to make folder lookup — i.e. the whole write — fail. */
    failSearch: false,
    /** URLs whose `bookmarks.create` rejects, for per-tab failure isolation. */
    failUrls: new Set<string>(),
    removed: [] as number[][],
    createdTabs: 0,
    lastSweep: undefined as LastSweep | undefined,
    lifetimeClosed: 0,
    settings: {} as Settings,
    warnings: [] as string[],
  };

  const mockApi = {
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: () => Promise.resolve(state.windows),
      create: () => Promise.resolve({}),
    },
    tabs: {
      remove: (ids: number[]) => {
        state.removed.push(ids);
        return Promise.resolve();
      },
      create: () => {
        state.createdTabs += 1;
        return Promise.resolve({});
      },
    },
    bookmarks: {
      search: (query: { title?: string }) => {
        if (state.failSearch) return Promise.reject(new Error('bookmarks unavailable'));
        return Promise.resolve(state.nodes.filter((node) => node.title === query.title));
      },
      create: (details: { parentId?: string; title?: string; url?: string }) => {
        state.createCalls.push(details);
        if (details.url !== undefined && state.failUrls.has(details.url)) {
          return Promise.reject(new Error(`restricted URL ${details.url}`));
        }
        const node: FakeNode = {
          id: `n${state.nodes.length + 1}`,
          parentId: details.parentId,
          title: details.title ?? '',
          url: details.url,
        };
        state.nodes.push(node);
        return Promise.resolve(node);
      },
    },
  };

  return { state, mockApi };
})();

mock.module('../src/platform', () => ({
  api: mockApi as unknown as typeof chrome,
  isFirefox: () => false,
  forgetClosed: () => Promise.resolve(),
}));

mock.module('../src/badge', () => ({
  setClosedBadge: () => Promise.resolve(),
  clearBadge: () => Promise.resolve(),
}));

mock.module('../src/storage', () => ({
  getSettings: () => Promise.resolve(state.settings),
  getLastSweep: () => Promise.resolve(state.lastSweep),
  setLastSweep: (value: LastSweep) => {
    state.lastSweep = value;
    return Promise.resolve();
  },
  bumpStats: (closed: number) => {
    state.lifetimeClosed += closed;
    return Promise.resolve({ lifetimeClosed: state.lifetimeClosed });
  },
}));

const { atRiskTabs, bookmarkAtRiskTabs, bookmarkableTabs } = await import('../src/bookmarks');
const { sweep } = await import('../src/sweep');

// --- Fixtures ---------------------------------------------------------------

const DEFAULTS: Settings = {
  cutoffs: ['18:00'],
  noticeMinutes: 10,
  notify: true,
  autoBookmark: false,
  keepPinned: false,
};

function fakeTab(id: number, url: string, options: { pinned?: boolean } = {}): FakeTab {
  return { id, pinned: options.pinned ?? false, url, title: `Tab ${id}` };
}

function fakeWindow(
  id: number,
  tabs: FakeTab[],
  options: { incognito?: boolean; focused?: boolean } = {},
): FakeWindow {
  return {
    id,
    focused: options.focused ?? id === 1,
    incognito: options.incognito ?? false,
    tabs,
  };
}

/** Folder nodes (no `url`) carrying `title`. */
function folders(title: string): FakeNode[] {
  return state.nodes.filter((node) => node.url === undefined && node.title === title);
}

/** The single folder named `title`; fails the test if it is missing. */
function folder(title: string): FakeNode {
  const found = folders(title);
  expect(found.length, `expected exactly one "${title}" folder`).toBe(1);
  return found[0] as FakeNode;
}

/** The URLs bookmarked into `parentId`, in write order. */
function urlsIn(parentId: string): string[] {
  return state.nodes
    .filter((node) => node.parentId === parentId && node.url !== undefined)
    .map((node) => node.url as string);
}

/** Every URL written to the bookmark tree, wherever it landed. */
function allBookmarkedUrls(): string[] {
  return state.nodes.filter((node) => node.url !== undefined).map((node) => node.url as string);
}

beforeEach(() => {
  state.windows = [];
  state.nodes = [];
  state.createCalls.length = 0;
  state.failSearch = false;
  state.failUrls.clear();
  state.removed.length = 0;
  state.createdTabs = 0;
  state.lastSweep = undefined;
  state.lifetimeClosed = 0;
  state.settings = { ...DEFAULTS, cutoffs: [...DEFAULTS.cutoffs] };
  state.warnings.length = 0;
  spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    state.warnings.push(args.map((arg) => String(arg)).join(' '));
  });
});

// --- The folder contract ----------------------------------------------------

describe('bookmarkAtRiskTabs — the folder contract', () => {
  it('writes every at-risk tab to zero-tabbox / YYYY-MM-DD', async () => {
    state.windows = [
      fakeWindow(1, [fakeTab(11, 'https://a.example'), fakeTab(12, 'https://b.example')]),
    ];

    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result).toEqual({ count: 2, folderPath: 'bookmarks / zero-tabbox / 2026-08-21' });
    const root = folder('zero-tabbox');
    expect(root.parentId).toBeUndefined(); // the browser's default parent, not a hard-coded id
    const day = folder('2026-08-21');
    expect(day.parentId).toBe(root.id);
    expect(urlsIn(day.id)).toEqual(['https://a.example', 'https://b.example']);
  });

  it('dates the folder by the local calendar day, at both ends of that day', async () => {
    // 00:30 and 23:30 local sit on opposite sides of UTC midnight in most zones,
    // so a UTC-derived stamp would split them into two folders.
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];

    await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 0, 30));
    await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 23, 30));

    expect(folders('2026-08-21').length).toBe(1);
    expect(folders('2026-08-20').length).toBe(0);
    expect(folders('2026-08-22').length).toBe(0);
  });

  it('appends to the day folder instead of duplicating it', async () => {
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];
    await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 9, 0));

    state.windows = [fakeWindow(1, [fakeTab(12, 'https://b.example')])];
    const second = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(second.count).toBe(1);
    expect(folders('zero-tabbox').length).toBe(1);
    const day = folder('2026-08-21');
    expect(urlsIn(day.id)).toEqual(['https://a.example', 'https://b.example']);
  });

  it('starts a new folder on the next day, keeping the old one', async () => {
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];
    await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));
    await bookmarkAtRiskTabs(false, new Date(2026, 7, 22, 18, 0));

    expect(folders('zero-tabbox').length).toBe(1);
    expect(urlsIn(folder('2026-08-21').id)).toEqual(['https://a.example']);
    expect(urlsIn(folder('2026-08-22').id)).toEqual(['https://a.example']);
  });

  it('creates no folder at all when there is nothing at risk', async () => {
    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result).toEqual({ count: 0, folderPath: 'bookmarks / zero-tabbox / 2026-08-21' });
    expect(state.createCalls).toEqual([]);
  });

  it('rejects when enumeration fails, so "could not save" is not "nothing at risk"', async () => {
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];
    state.failSearch = true;

    await expect(bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0))).rejects.toThrow(
      'bookmarks unavailable',
    );
  });
});

// --- keepPinned -------------------------------------------------------------

describe('bookmarkAtRiskTabs — keepPinned', () => {
  it('leaves pinned tabs out of the written set when the setting is on', async () => {
    state.windows = [
      fakeWindow(1, [
        fakeTab(11, 'https://pinned.example', { pinned: true }),
        fakeTab(12, 'https://a.example'),
      ]),
    ];

    const result = await bookmarkAtRiskTabs(true, new Date(2026, 7, 21, 18, 0));

    // The saved set matches the swept set: a tab that survives is not "saved".
    expect(result.count).toBe(1);
    expect(allBookmarkedUrls()).toEqual(['https://a.example']);
  });

  it('writes pinned tabs when the setting is off, because the sweep closes them', async () => {
    state.windows = [
      fakeWindow(1, [
        fakeTab(11, 'https://pinned.example', { pinned: true }),
        fakeTab(12, 'https://a.example'),
      ]),
    ];

    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result.count).toBe(2);
    expect(allBookmarkedUrls()).toEqual(['https://pinned.example', 'https://a.example']);
  });

  it('applies keepPinned to both enumerations alike', async () => {
    state.windows = [
      fakeWindow(1, [
        fakeTab(11, 'https://pinned.example', { pinned: true }),
        fakeTab(12, 'https://a.example'),
      ]),
    ];

    await expect(atRiskTabs(true)).resolves.toEqual([
      { title: 'Tab 12', url: 'https://a.example' },
    ]);
    await expect(bookmarkableTabs(true)).resolves.toEqual([
      { title: 'Tab 12', url: 'https://a.example' },
    ]);
  });
});

// --- Per-tab failure isolation ---------------------------------------------

describe('bookmarkAtRiskTabs — per-tab failure isolation', () => {
  it('saves the rest of the set when one bookmark cannot be written', async () => {
    // Saving 3 of 4 tabs before an unavoidable sweep beats saving none.
    state.windows = [
      fakeWindow(1, [
        fakeTab(11, 'https://a.example'),
        fakeTab(12, 'chrome://settings'),
        fakeTab(13, 'https://b.example'),
        fakeTab(14, 'https://c.example'),
      ]),
    ];
    state.failUrls.add('chrome://settings');

    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result.count).toBe(3); // the count reports what was actually written
    expect(urlsIn(folder('2026-08-21').id)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    expect(state.warnings.some((line) => line.includes('could not bookmark a tab'))).toBe(true);
  });

  it('still resolves when every single bookmark fails', async () => {
    state.windows = [
      fakeWindow(1, [fakeTab(11, 'https://a.example'), fakeTab(12, 'https://b.example')]),
    ];
    state.failUrls.add('https://a.example');
    state.failUrls.add('https://b.example');

    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result.count).toBe(0);
    expect(allBookmarkedUrls()).toEqual([]);
  });
});

// --- The privacy fix --------------------------------------------------------

describe('private windows are swept but never bookmarked (regression guard)', () => {
  // Do not delete or relax these: bookmarking a private tab writes its title and
  // URL into a folder that outlives the private session, the browser restart and
  // the extension — exactly the record a private window exists to not leave.
  // Private-browsing access is permission to see those tabs, not consent to make
  // them permanent. The sweep, by contrast, must still count and close them, or
  // the popup's warning would understate what is about to happen.

  function mixedProfile(): void {
    state.windows = [
      fakeWindow(1, [
        fakeTab(11, 'https://regular.example'),
        fakeTab(12, 'https://also-regular.example'),
      ]),
      fakeWindow(
        2,
        [fakeTab(21, 'https://private-one.example'), fakeTab(22, 'https://private-two.example')],
        { incognito: true },
      ),
    ];
  }

  it('atRiskTabs INCLUDES private-window tabs — the sweep closes them', async () => {
    mixedProfile();

    const at = await atRiskTabs(false);

    expect(at.map((entry) => entry.url)).toEqual([
      'https://regular.example',
      'https://also-regular.example',
      'https://private-one.example',
      'https://private-two.example',
    ]);
  });

  it('bookmarkableTabs EXCLUDES private-window tabs — nothing private is kept', async () => {
    mixedProfile();

    const bookmarkable = await bookmarkableTabs(false);

    expect(bookmarkable.map((entry) => entry.url)).toEqual([
      'https://regular.example',
      'https://also-regular.example',
    ]);
    for (const entry of bookmarkable) {
      expect(entry.url).not.toContain('private');
    }
  });

  it('the two sets differ by the private tabs, so the popup can show both numbers', async () => {
    mixedProfile();

    const at = await atRiskTabs(false);
    const bookmarkable = await bookmarkableTabs(false);

    expect(at.length).toBe(4);
    expect(bookmarkable.length).toBe(2);
    expect(at.length).toBeGreaterThan(bookmarkable.length);
  });

  it('honours keepPinned inside a private window without letting its tabs through', async () => {
    state.windows = [
      fakeWindow(1, [fakeTab(11, 'https://regular.example')]),
      fakeWindow(
        2,
        [
          fakeTab(21, 'https://private.example', { pinned: true }),
          fakeTab(22, 'https://private-two.example'),
        ],
        { incognito: true },
      ),
    ];

    await expect(atRiskTabs(true)).resolves.toEqual([
      { title: 'Tab 11', url: 'https://regular.example' },
      { title: 'Tab 22', url: 'https://private-two.example' },
    ]);
    await expect(bookmarkableTabs(true)).resolves.toEqual([
      { title: 'Tab 11', url: 'https://regular.example' },
    ]);
  });

  it('writes no private URL to the bookmark tree, on any path', async () => {
    mixedProfile();

    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result.count).toBe(2);
    expect(allBookmarkedUrls()).toEqual([
      'https://regular.example',
      'https://also-regular.example',
    ]);
    // Not even as a rejected attempt: the private URLs never reach the API.
    expect(JSON.stringify(state.createCalls)).not.toContain('private');
  });

  it('bookmarks nothing at all on a private-only profile', async () => {
    state.windows = [fakeWindow(2, [fakeTab(21, 'https://private.example')], { incognito: true })];

    const result = await bookmarkAtRiskTabs(false, new Date(2026, 7, 21, 18, 0));

    expect(result.count).toBe(0);
    expect(state.createCalls).toEqual([]);
  });

  it('the auto-bookmark sweep saves the regular tabs and closes the private ones', async () => {
    mixedProfile();
    state.settings = { ...state.settings, autoBookmark: true };

    const result = await sweep('auto');

    expect(result.closed).toBe(4); // all four, private included
    expect(allBookmarkedUrls()).toEqual([
      'https://regular.example',
      'https://also-regular.example',
    ]);
  });
});

// --- The two sweep scenarios ------------------------------------------------

describe('sweep — bookmarking fails (sweep-controls.spec)', () => {
  it('runs to completion and only logs the failure', async () => {
    state.windows = [
      fakeWindow(1, [fakeTab(11, 'https://a.example'), fakeTab(12, 'https://b.example')]),
    ];
    state.settings = { ...state.settings, autoBookmark: true };
    state.failSearch = true;

    const result = await sweep('auto');

    // The sweep is unavoidable: a failed save does not buy the tabs a reprieve.
    expect(result.closed).toBe(2);
    expect(state.removed).toEqual([[11, 12]]);
    expect(state.lifetimeClosed).toBe(2);
    expect(state.lastSweep).toMatchObject({ reason: 'auto', closed: 2 });
    // ...and the record does not claim the tabs were saved first.
    expect(state.lastSweep?.bookmarked).toBe(false);
    const logged = state.warnings.some((line) =>
      line.includes('auto-bookmark before the sweep failed'),
    );
    expect(logged).toBe(true);
  });

  it('still records the sweep when every individual bookmark fails', async () => {
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];
    state.settings = { ...state.settings, autoBookmark: true };
    state.failUrls.add('https://a.example');

    const result = await sweep('auto');

    expect(result.closed).toBe(1);
    expect(state.removed).toEqual([[11]]);
    expect(state.lastSweep).toMatchObject({ reason: 'auto', closed: 1 });
  });
});

describe('sweep — no silent bookmarking (tab-sweep.spec)', () => {
  it('creates no bookmark when autoBookmark is off and nobody clicked "Bookmark all"', async () => {
    state.windows = [
      fakeWindow(1, [fakeTab(11, 'https://a.example'), fakeTab(12, 'https://b.example')]),
    ];

    const result = await sweep('auto');

    expect(result.closed).toBe(2);
    // Not one call — no folder, no tab, nothing. The escape hatch is opt-in.
    expect(state.createCalls).toEqual([]);
    expect(state.nodes).toEqual([]);
    expect(state.lastSweep?.bookmarked).toBe(false);
  });

  it('stays silent for a manual sweep too', async () => {
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];

    await sweep('manual');

    expect(state.createCalls).toEqual([]);
    expect(state.lastSweep).toMatchObject({ reason: 'manual', bookmarked: false });
  });

  it('records "bookmarked" without writing anything when the popup already saved', async () => {
    // The popup's "Bookmark all" click did the writing; the sweep must not
    // repeat it, only report it (design.md D12).
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];

    await sweep('manual', { alreadyBookmarked: true });

    expect(state.createCalls).toEqual([]);
    expect(state.lastSweep?.bookmarked).toBe(true);
  });

  it('writes bookmarks only once autoBookmark is turned on', async () => {
    state.windows = [fakeWindow(1, [fakeTab(11, 'https://a.example')])];
    state.settings = { ...state.settings, autoBookmark: true };

    await sweep('auto');

    expect(allBookmarkedUrls()).toEqual(['https://a.example']);
    expect(state.lastSweep?.bookmarked).toBe(true);
  });
});
