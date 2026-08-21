/**
 * The one honest escape hatch (design.md D12).
 *
 * Bookmarking is the only way to keep a page past a cutoff, and this module is
 * the only code that writes bookmarks. Two invariants keep it compatible with
 * the no-archive contract (tab-sweep.spec "Bookmarks are the only escape
 * hatch"):
 *
 *  1. It writes to the *browser's* bookmarks — `bookmarks / zero-tabbox /
 *     YYYY-MM-DD` — never to extension storage. The extension retains no copy
 *     and no reference; deleting the folder is entirely the user's business.
 *  2. It runs only on an explicit user action: the popup's "Bookmark all"
 *     button, or a sweep with the opt-in "Bookmark everything first" setting
 *     enabled. Nothing is bookmarked silently.
 */
import { localDateStamp } from './cutoff';
import { api } from './platform';

/** What a bookmark-all run wrote. */
export interface BookmarkAllResult {
  /** Tabs written. 0 when there was nothing at risk. */
  count: number;
  /** Human-readable folder path, e.g. `bookmarks / zero-tabbox / 2026-08-21`. */
  folderPath: string;
}

/** Title of the extension's root folder inside the browser's bookmarks. */
const ROOT_FOLDER = 'zero-tabbox';

/** A tab a sweep would close, reduced to the two fields a bookmark needs. */
export interface AtRiskTab {
  title: string;
  url: string;
}

/**
 * The tabs the next sweep would close, i.e. every tab in every normal window
 * minus pinned tabs when `keepPinned` is on. This is the popup's "N tabs close
 * at" number, and it counts private-window tabs because the sweep closes them
 * too — the warning must match what actually happens.
 *
 * Not the set "Bookmark all" writes; that is {@link bookmarkableTabs}.
 *
 * Tabs without a URL (still loading, or restricted pages the API redacts) are
 * excluded: they cannot be bookmarked, and with the `tabs` permission granted
 * they do not occur in practice.
 */
export async function atRiskTabs(keepPinned: boolean): Promise<AtRiskTab[]> {
  return collect(keepPinned, { includePrivate: true });
}

/**
 * The subset of {@link atRiskTabs} that may be written to the browser's
 * bookmarks: the same tabs minus everything in a private window.
 *
 * The two differ because the two actions differ in permanence. Sweeping a
 * private tab is ephemeral — it closes, and the session it belonged to was
 * never going to outlive the window anyway. Bookmarking one is permanent: the
 * title and URL would land in a bookmark folder that survives the private
 * session, the browser restart and the extension itself, which is exactly the
 * record a private window exists to not leave. Private windows are only
 * visible here at all when the user granted private-browsing access, and that
 * grant is not consent to make their browsing permanent.
 *
 * So with private windows open the popup honestly shows two numbers: the sweep
 * closes more tabs than "Bookmark all" can save.
 */
export async function bookmarkableTabs(keepPinned: boolean): Promise<AtRiskTab[]> {
  return collect(keepPinned, { includePrivate: false });
}

/** Shared enumeration behind {@link atRiskTabs} and {@link bookmarkableTabs}. */
async function collect(
  keepPinned: boolean,
  options: { includePrivate: boolean },
): Promise<AtRiskTab[]> {
  const windows = await api.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const tabs: AtRiskTab[] = [];
  for (const window of windows) {
    if (window.incognito && !options.includePrivate) continue;
    for (const tab of window.tabs ?? []) {
      if (keepPinned && tab.pinned) continue;
      if (!tab.url) continue;
      tabs.push({ title: tab.title || tab.url, url: tab.url });
    }
  }
  return tabs;
}

/**
 * Finds or creates a bookmark folder by title.
 *
 * `parentId` omitted means the browser's default parent, which is "Other
 * bookmarks" on both Chrome and Firefox — deliberately not a hard-coded root
 * id, because the ids differ per browser (`'2'` vs `'unfiled_____'`).
 */
async function ensureFolder(title: string, parentId?: string): Promise<string> {
  const candidates = await api.bookmarks.search({ title });
  const existing = candidates.find(
    (node) =>
      node.url === undefined &&
      node.title === title &&
      (parentId === undefined || node.parentId === parentId),
  );
  if (existing) return existing.id;
  const created = await api.bookmarks.create(parentId ? { parentId, title } : { title });
  return created.id;
}

/**
 * Writes every bookmarkable at-risk tab to `bookmarks / zero-tabbox /
 * YYYY-MM-DD` (dated with the local calendar day of `now`), creating the
 * folders as needed and appending when the day's folder already exists.
 *
 * Private-window tabs are never written (see {@link bookmarkableTabs}), so on a
 * profile with private windows open this saves fewer tabs than the sweep
 * closes.
 *
 * One failed bookmark does not abort the rest — saving 46 of 47 tabs before a
 * sweep beats saving none — but the enumeration itself failing rejects, so
 * callers can tell "nothing at risk" apart from "could not save".
 *
 * @param keepPinned current `keepPinned` setting, so the saved set matches the
 *   swept set
 * @param now instant used for the dated folder name
 */
export async function bookmarkAtRiskTabs(
  keepPinned: boolean,
  now: Date = new Date(),
): Promise<BookmarkAllResult> {
  const tabs = await bookmarkableTabs(keepPinned);
  const day = localDateStamp(now);
  const folderPath = `bookmarks / ${ROOT_FOLDER} / ${day}`;
  if (tabs.length === 0) return { count: 0, folderPath };

  const rootId = await ensureFolder(ROOT_FOLDER);
  const dayId = await ensureFolder(day, rootId);

  let count = 0;
  for (const tab of tabs) {
    try {
      await api.bookmarks.create({ parentId: dayId, title: tab.title, url: tab.url });
      count += 1;
    } catch (error) {
      // Restricted URL schemes land here; the rest of the set still saves.
      console.warn('[zero-tabbox] could not bookmark a tab', error);
    }
  }
  return { count, folderPath };
}
