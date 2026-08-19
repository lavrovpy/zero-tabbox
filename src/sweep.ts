/**
 * One sweep: the thing the whole extension exists to do (design.md D4,
 * tab-sweep.spec).
 *
 * Owned by tasks.md section 4. Nothing in here persists anything about the
 * tabs it closes — only counts, via `storage.ts`.
 */
import { clearBadge, setClosedBadge } from './badge';
import { api, forgetClosed } from './platform';
import { bumpStats, getLastSweep, getSettings, setLastSweep } from './storage';
import type { SweepReason } from './types';

/** Outcome of a single sweep, for stats and the post-sweep badge. */
export interface SweepResult {
  /**
   * Number of tabs the sweep asked the browser to close.
   *
   * A tab that survives because it showed a `beforeunload` dialog is still
   * counted: the sweep is atomic from the user's perspective and is recorded as
   * completed either way (tab-sweep.spec "Sweep is atomic from the user's
   * perspective").
   */
  closed: number;
}

/**
 * A normal window, narrowed to the fields the algorithm needs and with the
 * optionals resolved. `windows.getAll` types `id` and `tabs` as optional;
 * a window without an id cannot be operated on, so it is dropped up front.
 */
interface NormalWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  tabs: chrome.tabs.Tab[];
}

/**
 * Closes every tab in every normal window of this profile.
 *
 * Contract (tab-sweep.spec):
 *  - Enumerates only `windowTypes: ['normal']` — popup, PWA and devtools
 *    windows are out of scope. Private windows appear in the enumeration only
 *    when the user has granted private-browsing access, which is what makes the
 *    default "leave private alone" behaviour free.
 *  - Exactly one clean *regular* window survives, holding a single new-tab page
 *    — or the kept pinned tabs when `keepPinned` is on, with a new-tab page
 *    added only if there would otherwise be none.
 *  - With `keepPinned` on, pinned tabs are consolidated into the surviving
 *    window of their own context; pinned tabs never cross the private/regular
 *    boundary, and no new-tab page is ever created in a private window.
 *  - No exemption exists other than `keepPinned` — audible, grouped and
 *    discarded tabs are closed like any other, as are the extension's own pages.
 *
 * Side effects on completion: `lastSweep` and `stats` are written, the badge is
 * set to the closed count (the caller clears it within 60 s), and
 * `platform.forgetClosed()` is called so Firefox's recently-closed list does not
 * become the archive this extension refuses to keep.
 *
 * `reason` never changes which tabs are closed. It only decides bookkeeping:
 * `auto` advances `lastAutoCutoffId` (done by the caller), `manual` and
 * `settle` do not (design.md D3/D8). A `settle` pass folds its count into the
 * sweep it belongs to rather than recording a second sweep.
 *
 * Never rejects for a per-tab failure; rejects only if the tab enumeration
 * itself fails.
 */
export async function sweep(reason: SweepReason): Promise<SweepResult> {
  const settings = await getSettings();
  const windows = await enumerateNormalWindows();

  // Private and regular windows are two independent contexts: `tabs.move`
  // cannot cross the boundary, and the clean window is always a regular one.
  const regular = windows.filter((window) => !window.incognito);
  const priv = windows.filter((window) => window.incognito);

  const toClose = [
    ...(await planContext(regular, settings.keepPinned, { allowNewTab: true })),
    ...(await planContext(priv, settings.keepPinned, { allowNewTab: false })),
  ];

  // A private-only profile state would leave zero windows behind; keep the
  // browser alive with one regular window (tab-sweep.spec "one clean window").
  if (regular.length === 0 && toClose.length > 0) {
    await createCleanWindow();
  }

  // Read before the removal: it bounds `forgetClosed` to the entries this
  // sweep creates, so tabs and windows the user closed by hand earlier stay in
  // the browser's recently-closed list.
  const removalStarted = Date.now();
  if (toClose.length > 0) {
    // One batch call: the browser completes it even if the background dies
    // mid-sweep, and a window whose last tab goes closes itself.
    try {
      await api.tabs.remove(toClose);
    } catch (error) {
      // `beforeunload` stragglers and tabs that vanished between enumeration
      // and removal both land here. The sweep still counts as completed.
      console.warn('[zero-tabbox] some tabs could not be closed', error);
    }
  }

  await record(reason, toClose.length);
  await forgetClosed(removalStarted);
  return { closed: toClose.length };
}

/** Reads the normal windows of this profile, dropping any without an id. */
async function enumerateNormalWindows(): Promise<NormalWindow[]> {
  // Allow-list, not deny-list: the documented default filter is
  // ['normal', 'popup'], so omitting `windowTypes` would sweep popups.
  const windows = await api.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const normal: NormalWindow[] = [];
  for (const window of windows) {
    if (window.id === undefined || window.id === api.windows.WINDOW_ID_NONE) continue;
    normal.push({
      id: window.id,
      focused: window.focused,
      incognito: window.incognito,
      tabs: window.tabs ?? [],
    });
  }
  return normal;
}

/**
 * Plans (and performs the pinned-tab moves for) one context.
 *
 * @returns the ids of the tabs to close in this context
 */
async function planContext(
  windows: NormalWindow[],
  keepPinned: boolean,
  options: { allowNewTab: boolean },
): Promise<number[]> {
  const keepWindow = chooseKeepWindow(windows, keepPinned);
  if (!keepWindow) return [];

  const kept = new Set<number>();
  if (keepPinned) {
    for (const tab of keepWindow.tabs) {
      if (tab.pinned && tab.id !== undefined) kept.add(tab.id);
    }
    const strays = windows
      .filter((window) => window.id !== keepWindow.id)
      .flatMap((window) => window.tabs)
      .filter((tab) => tab.pinned && tab.id !== undefined);
    for (const id of await consolidatePinned(keepWindow, strays, kept.size)) {
      kept.add(id);
    }
  }

  // The new tab is created *before* the removal so the keep-window never drops
  // to zero tabs, which would close it and possibly exit the browser.
  if (options.allowNewTab && kept.size === 0) {
    await createNewTab(keepWindow.id);
  }

  const toClose: number[] = [];
  for (const window of windows) {
    for (const tab of window.tabs) {
      if (tab.id === undefined || kept.has(tab.id)) continue;
      toClose.push(tab.id);
    }
  }
  return toClose;
}

/**
 * The window that survives this context: with `keepPinned`, the one holding the
 * most pinned tabs (ties broken by focus, then enumeration order); otherwise
 * the focused window, else the first.
 */
function chooseKeepWindow(
  windows: NormalWindow[],
  keepPinned: boolean,
): NormalWindow | undefined {
  if (windows.length === 0) return undefined;
  let contenders = windows;
  if (keepPinned) {
    const most = Math.max(...windows.map(countPinned));
    contenders = windows.filter((window) => countPinned(window) === most);
  }
  return contenders.find((window) => window.focused) ?? contenders[0];
}

function countPinned(window: NormalWindow): number {
  return window.tabs.filter((tab) => tab.pinned).length;
}

/**
 * Moves pinned tabs from the other windows of a context into the keep-window,
 * re-asserting `pinned` afterwards.
 *
 * Two documented hazards drive the shape of this: moving a pinned tab to a
 * position after unpinned tabs fails *silently* (so the insert index is the end
 * of the pinned block, and the result is verified by re-query), and whether a
 * cross-window move preserves the pinned flag is not specified anywhere (so it
 * is re-asserted either way).
 *
 * @param pinnedInKeepWindow how many pinned tabs the keep-window already holds,
 *   i.e. the first index after its pinned block
 * @returns the ids that survive the sweep — the consolidated ones plus any that
 *   could not be moved, which stay pinned where they are
 */
async function consolidatePinned(
  keepWindow: NormalWindow,
  strays: chrome.tabs.Tab[],
  pinnedInKeepWindow: number,
): Promise<number[]> {
  const keptIds: number[] = [];
  let index = pinnedInKeepWindow;
  for (const tab of strays) {
    const id = tab.id;
    if (id === undefined) continue;
    keptIds.push(id);
    if (!(await moveInto(id, keepWindow.id, index)) && !(await moveInto(id, keepWindow.id, -1))) {
      // Kept where it is: the exemption outranks the one-window guarantee, so
      // the stray window survives holding it. Should not happen in practice.
      console.warn('[zero-tabbox] could not consolidate pinned tab', id);
      continue;
    }
    index += 1;
  }
  return keptIds;
}

/** One move attempt, verified by re-query because failures can be silent. */
async function moveInto(tabId: number, windowId: number, index: number): Promise<boolean> {
  try {
    await api.tabs.move(tabId, { windowId, index });
    await api.tabs.update(tabId, { pinned: true });
  } catch (error) {
    console.warn('[zero-tabbox] pinned-tab move failed', error);
  }
  try {
    const tab = await api.tabs.get(tabId);
    return tab.windowId === windowId;
  } catch {
    return false;
  }
}

/** The single new-tab page the surviving window is guaranteed to hold. */
async function createNewTab(windowId: number): Promise<void> {
  try {
    await api.tabs.create({ windowId, active: true });
  } catch (error) {
    console.warn('[zero-tabbox] could not create the clean new tab', error);
  }
}

/** Last resort when the profile holds private windows and nothing else. */
async function createCleanWindow(): Promise<void> {
  try {
    await api.windows.create({ incognito: false });
  } catch (error) {
    console.warn('[zero-tabbox] could not create the clean window', error);
  }
}

/**
 * How long after a catch-up sweep a `settle` pass may still fold into it. The
 * pass is armed for 60 s later (design.md D8); the rest is slack for a late
 * alarm delivery.
 */
const SETTLE_FOLD_WINDOW_MS = 5 * 60_000;

/**
 * Writes the aggregate record of a sweep. Nothing per-tab is stored, ever
 * (tab-sweep.spec "Sweep does not create a recoverable archive").
 *
 * A `settle` pass is not a sweep of its own (design.md D8): it folds its count
 * into the catch-up sweep that spawned it, so the popup shows one sweep with
 * the full total. It folds only into *that* sweep, though — an "End day now"
 * that lands in the 60 s gap replaces `lastSweep` with a `manual` record, and
 * folding into that one would rewrite the user's manual sweep instead.
 */
async function record(reason: SweepReason, closed: number): Promise<void> {
  let total = closed;
  if (reason === 'settle') {
    const previous = await getLastSweep();
    const owns =
      previous !== undefined &&
      previous.reason === 'auto' &&
      Date.now() - previous.at <= SETTLE_FOLD_WINDOW_MS;
    total = owns ? previous.closed + closed : closed;
    await setLastSweep({ reason: 'auto', at: Date.now(), closed: total });
  } else {
    await setLastSweep({
      reason: reason === 'manual' ? 'manual' : 'auto',
      at: Date.now(),
      closed,
    });
  }
  await bumpStats(closed);
  await (total > 0 ? setClosedBadge(total) : clearBadge());
}
