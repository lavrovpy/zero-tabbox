/**
 * Toolbar popup (tasks.md 6.1).
 *
 * Contract: the popup owns no sweep logic and no schedule logic. It reads
 * settings through `storage.ts`, derives the next cutoff with the pure helpers
 * in `cutoff.ts`, counts the at-risk tabs with `bookmarks.ts`'s enumeration,
 * and asks the background to sweep by message. It shows what is at stake (how
 * many tabs close at the next cutoff), the one honest way to prepare
 * ("Bookmark all" — the escape hatch of design.md D12), and "End day now".
 * Right after a sweep it shows the "Day ended" state instead. Anything
 * resembling a pause, snooze or restore control is out of scope by spec, not
 * by omission (sweep-controls.spec "No softening controls").
 *
 * Status is computed here rather than fetched from the background on purpose:
 * `Message` in types.ts is frozen to the single `end-day-now` case, and waking
 * a terminated service worker just to render a clock would be a worse trade
 * than recomputing two Date fields from the same storage the background reads.
 */
import { atRiskTabs, bookmarkAtRiskTabs, bookmarkableTabs } from '../bookmarks';
import { nextOccurrence } from '../cutoff';
import { api } from '../platform';
import { getLastSweep, getSettings } from '../storage';
import type { Message, Settings } from '../types';
import { el } from './dom';

/** The next configured cutoff, resolved to a concrete upcoming instant. */
interface NextCutoff {
  /** The configured `HH:MM`, shown verbatim so it matches the options page. */
  hhmm: string;
  /** The local instant it next occurs at, strictly in the future. */
  at: Date;
}

/**
 * How long after a sweep the popup opens on the "Day ended" state. The same
 * 60 s the post-sweep badge lives (sweep-controls.spec "Post-sweep feedback is
 * minimal") — the two are one moment of feedback, then the product moves on.
 */
const SWEPT_VIEW_MS = 60_000;

const viewLive = el<HTMLElement>('view-live');
const viewSwept = el<HTMLElement>('view-swept');
const atRiskLine = el<HTMLParagraphElement>('at-risk');
const cutoffTime = el<HTMLSpanElement>('next-cutoff-time');
const cutoffEta = el<HTMLSpanElement>('next-cutoff-eta');
const openOptions = el<HTMLAnchorElement>('open-options');
const bookmarkAll = el<HTMLButtonElement>('bookmark-all');
const bookmarkAllLabel = el<HTMLSpanElement>('bookmark-all-label');
const bookmarkSaved = el<HTMLParagraphElement>('bookmark-saved');
const bookmarkFolder = el<HTMLSpanElement>('bookmark-folder');
const endDayNow = el<HTMLButtonElement>('end-day-now');
const sweptCount = el<HTMLSpanElement>('swept-count');
const sweptUnit = el<HTMLSpanElement>('swept-unit');
const sweptNote = el<HTMLParagraphElement>('swept-note');
const sweptNextCutoff = el<HTMLSpanElement>('swept-next-cutoff');
const backToDay = el<HTMLButtonElement>('back-to-day');

/** Whether "Bookmark all" succeeded in this popup session (display-only). */
let bookmarkedThisSession = false;

let etaTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------- actions

endDayNow.addEventListener('click', () => {
  // No confirmation dialog, by design (sweep-controls.spec "Manual End day now").
  // The popup closes either way: a failed sweep is logged, not argued about.
  // The `catch` is what makes "logged" true — `finally` re-throws, and a
  // popup that is being torn down has nowhere to report an unhandled rejection.
  endDayNow.disabled = true;
  const message: Message = { type: 'end-day-now', alreadyBookmarked: bookmarkedThisSession };
  void Promise.resolve(api.runtime.sendMessage(message))
    .catch((error: unknown) => {
      console.warn('[zero-tabbox] end-day-now could not be delivered', error);
    })
    .finally(() => window.close());
});

openOptions.addEventListener('click', (event) => {
  event.preventDefault();
  api.runtime.openOptionsPage();
});

bookmarkAll.addEventListener('click', () => {
  bookmarkAll.disabled = true;
  void (async () => {
    try {
      const settings = await getSettings();
      const result = await bookmarkAtRiskTabs(settings.keepPinned);
      bookmarkedThisSession = true;
      bookmarkFolder.textContent = result.folderPath;
      bookmarkAll.hidden = true;
      bookmarkSaved.hidden = false;
    } catch (error) {
      console.warn('[zero-tabbox] bookmark all failed', error);
      bookmarkAll.disabled = false;
    }
  })();
});

backToDay.addEventListener('click', () => {
  void showLive();
});

// ---------------------------------------------------------------- helpers

/**
 * The soonest upcoming cutoff across the whole schedule.
 *
 * Invalid entries are skipped rather than thrown on: a popup that renders
 * "no cutoff configured" is better than one that renders nothing.
 *
 * @returns the nearest cutoff, or `null` when none is configured or valid
 */
export function soonestCutoff(now: Date, cutoffs: readonly string[]): NextCutoff | null {
  let best: NextCutoff | null = null;
  for (const hhmm of cutoffs) {
    let at: Date;
    try {
      at = nextOccurrence(now, hhmm);
    } catch {
      continue;
    }
    if (best === null || at.getTime() < best.at.getTime()) {
      best = { hhmm, at };
    }
  }
  return best;
}

/**
 * Human "time remaining" outside the notice window, derived from whole minutes
 * so it agrees with the badge countdown (sweep-controls.spec "Badge countdown"
 * counts minutes).
 *
 * @param minutes minutes until the cutoff; negatives are clamped to 0
 */
export function formatEta(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return 'in less than a minute';
  if (total < 60) return `in ${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

/**
 * `MM:SS left` — the per-second countdown shown once the notice window has
 * started, when the remaining time deserves urgency rather than an estimate.
 *
 * @param seconds seconds until the cutoff; negatives are clamped to 0
 */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = String(Math.floor(total / 60)).padStart(2, '0');
  const secs = String(total % 60).padStart(2, '0');
  return `${mins}:${secs} left`;
}

// --------------------------------------------------------------- rendering

/** Writes the ETA next to the cutoff time; called once a second while open. */
function renderEta(settings: Settings, next: NextCutoff): void {
  const secondsLeft = (next.at.getTime() - Date.now()) / 1000;
  const inNotice = settings.noticeMinutes > 0 && secondsLeft <= settings.noticeMinutes * 60;
  cutoffEta.textContent = inNotice
    ? formatCountdown(secondsLeft)
    : formatEta(secondsLeft / 60);
  cutoffEta.classList.toggle('is-notice', inNotice);
}

/** Renders the live ("N tabs close at …") state. */
async function showLive(): Promise<void> {
  viewSwept.hidden = true;
  viewLive.hidden = false;
  if (etaTimer !== undefined) clearInterval(etaTimer);

  let settings: Settings;
  try {
    settings = await getSettings();
  } catch {
    atRiskLine.textContent = 'Schedule unavailable';
    return;
  }

  const next = soonestCutoff(new Date(), settings.cutoffs);
  if (next === null) {
    atRiskLine.textContent = 'No cutoff configured';
    cutoffTime.textContent = '--:--';
    cutoffEta.textContent = '';
  } else {
    cutoffTime.textContent = next.hhmm;
    renderEta(settings, next);
    etaTimer = setInterval(() => renderEta(settings, next), 1000);
  }

  // What is at stake: the tabs the next sweep would close. The button counts a
  // different set — private tabs are swept but never bookmarked — so with a
  // private window open the two numbers legitimately disagree, and each has to
  // tell the truth about its own action. Failure degrades to the sentence
  // without a number — the schedule is still shown.
  try {
    const [atRisk, saveable] = await Promise.all([
      atRiskTabs(settings.keepPinned),
      bookmarkableTabs(settings.keepPinned),
    ]);
    const count = atRisk.length;
    const saveableCount = saveable.length;
    atRiskLine.textContent =
      count === 1 ? '1 tab closes at' : `${count} tabs close at`;
    bookmarkAllLabel.textContent =
      saveableCount === 1 ? 'Bookmark the tab' : `Bookmark all ${saveableCount} tabs`;
    bookmarkAll.hidden = bookmarkedThisSession;
    bookmarkAll.disabled = saveableCount === 0;
  } catch {
    atRiskLine.textContent = 'Tabs close at';
    bookmarkAllLabel.textContent = 'Bookmark all tabs';
    bookmarkAll.hidden = bookmarkedThisSession;
  }
}

/** Renders the "Day ended" state shown right after a sweep. */
function showSwept(closed: number, bookmarked: boolean, nextHhmm: string | null): void {
  viewLive.hidden = true;
  viewSwept.hidden = false;
  if (etaTimer !== undefined) clearInterval(etaTimer);

  sweptCount.textContent = String(closed);
  sweptUnit.textContent = closed === 1 ? 'tab closed' : 'tabs closed';
  sweptNote.textContent = bookmarked
    ? 'All of them were bookmarked first. One clean window is left.'
    : 'Nothing was saved. One clean window is left.';
  sweptNextCutoff.textContent = nextHhmm ?? '--:--';
}

async function render(): Promise<void> {
  try {
    const [settings, lastSweep] = await Promise.all([getSettings(), getLastSweep()]);
    if (lastSweep !== undefined && Date.now() - lastSweep.at <= SWEPT_VIEW_MS) {
      const next = soonestCutoff(new Date(), settings.cutoffs);
      showSwept(lastSweep.closed, lastSweep.bookmarked === true, next?.hhmm ?? null);
      return;
    }
  } catch {
    // Fall through: the live view has its own degraded rendering.
  }
  await showLive();
}

void render();
