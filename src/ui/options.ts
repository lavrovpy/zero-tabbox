/**
 * Options page (tasks.md 6.2).
 *
 * Contract: this page persists changes through `storage.ts` only. Writing
 * `settings` is what makes the background reschedule via `storage.onChanged`
 * (design.md D3) — the page never messages the background about the schedule,
 * and never triggers a sweep.
 *
 * Autosave, no Save button (sweep-controls.spec "Settings surface"). Every
 * refusal is explained in `#cutoff-error` instead of being silently swallowed,
 * because a settings page that quietly drops an edit is worse than one that
 * says no.
 *
 * First-install onboarding is its own page (ui/onboarding.html, design.md D7);
 * this page only carries the standing contract sentence in its header.
 */
import { api } from '../platform';
import {
  InvalidCutoffsError,
  getLastSweep,
  getSettings,
  getStats,
  isAccepted,
  markAccepted,
  setSettings,
} from '../storage';
import { DEFAULT_SETTINGS, LIMITS } from '../types';
import type { Settings } from '../types';

/**
 * Times offered when the user adds a cutoff, first unused one wins. There are
 * more candidates than {@link LIMITS.maxCutoffs}, so one is always free.
 */
const SUGGESTED_CUTOFFS = ['18:00', '13:00', '09:00', '22:00', '16:00'] as const;

/**
 * The notice-window choices, per the redesign: fixed stops instead of a free
 * number field. Validation still accepts any 0–60 (storage.ts owns the rule),
 * so a previously stored in-between value keeps working until a stop is picked.
 */
const NOTICE_CHOICES = [0, 5, 10, 20, 30, 60] as const;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`options.html is missing #${id}`);
  return node as T;
}

const cutoffList = el<HTMLDivElement>('cutoff-list');
const addCutoffButton = el<HTMLButtonElement>('add-cutoff');
const cutoffError = el<HTMLParagraphElement>('cutoff-error');
const noticeOptions = el<HTMLDivElement>('notice-options');
const noticeSummary = el<HTMLSpanElement>('notice-summary');
const notifyInput = el<HTMLInputElement>('notify');
const autoBookmarkInput = el<HTMLInputElement>('auto-bookmark');
const keepPinnedInput = el<HTMLInputElement>('keep-pinned');
const statLast = el<HTMLElement>('stat-last');
const statLifetime = el<HTMLElement>('stat-lifetime');
const acceptBanner = el<HTMLElement>('accept-banner');
const acceptButton = el<HTMLButtonElement>('accept');
const acceptLabel = el<HTMLSpanElement>('accept-label');

/**
 * The last successfully persisted settings, kept so the cutoff chips can be
 * re-rendered in the normalised (sorted) order storage hands back, and so the
 * notice picker knows the current value (it has no input element of its own).
 */
let saved: Settings = { ...DEFAULT_SETTINGS, cutoffs: [...DEFAULT_SETTINGS.cutoffs] };

// --------------------------------------------------------------- messaging

function showError(message: string): void {
  cutoffError.textContent = message;
}

function clearError(): void {
  cutoffError.textContent = '';
}

/** Maps a validation failure from storage.ts onto copy the user can act on. */
function cutoffErrorMessage(error: InvalidCutoffsError): string {
  switch (error.code) {
    case 'too-few':
      return `Keep at least ${LIMITS.minCutoffs} cutoff time.`;
    case 'too-many':
      return `You can have at most ${LIMITS.maxCutoffs} cutoff times.`;
    case 'duplicate':
      return `${error.value ?? 'That time'} is already in the list.`;
    case 'format':
      return `${error.value ?? 'That value'} is not a valid time. Use HH:MM.`;
  }
}

// ------------------------------------------------------------ form reading

function cutoffInputs(): HTMLInputElement[] {
  return [...cutoffList.querySelectorAll<HTMLInputElement>('input[type="time"]')];
}

function cutoffValues(): string[] {
  return cutoffInputs().map((input) => input.value);
}

/**
 * Assembles a complete {@link Settings} from the form.
 *
 * Only the failure the browser cannot express in the markup is checked here —
 * an empty time input — everything else is left to `validateCutoffs` in
 * storage.ts so there is one definition of a valid schedule. `noticeMinutes`
 * comes from {@link saved} plus the picker, which only offers valid stops.
 *
 * @param cutoffs the cutoff list to use, so callers can add/remove entries
 * @param noticeMinutes the notice value to persist
 * @returns the settings to persist, or `null` when the form is not saveable
 *   (the reason has already been shown)
 */
function readForm(cutoffs: string[], noticeMinutes: number): Settings | null {
  if (cutoffs.some((value) => value === '')) {
    showError('Every cutoff needs a time.');
    return null;
  }
  return {
    cutoffs,
    noticeMinutes,
    notify: notifyInput.checked,
    autoBookmark: autoBookmarkInput.checked,
    keepPinned: keepPinnedInput.checked,
  };
}

// ---------------------------------------------------------------- persistence

/**
 * Persists settings and refreshes {@link saved} from storage.
 *
 * @returns `true` when the write succeeded; on failure the reason is shown and
 *   nothing has changed on disk
 */
async function persist(next: Settings): Promise<boolean> {
  try {
    await setSettings(next);
  } catch (error) {
    if (error instanceof InvalidCutoffsError) {
      showError(cutoffErrorMessage(error));
    } else if (error instanceof RangeError) {
      showError(
        `Notice must be between ${LIMITS.minNoticeMinutes} and ${LIMITS.maxNoticeMinutes} minutes.`,
      );
    } else {
      showError('Could not save your settings.');
    }
    return false;
  }
  try {
    saved = await getSettings();
  } catch {
    saved = next;
  }
  clearError();
  renderNotice();
  renderAcceptLabel();
  return true;
}

/** Autosave path for edits that do not change the number of chips. */
async function saveFromForm(): Promise<void> {
  const next = readForm(cutoffValues(), saved.noticeMinutes);
  if (next === null) return;
  await persist(next);
}

// -------------------------------------------------------------- cutoff chips

/**
 * Rebuilds the cutoff chips (time input + remove button each), keeping the
 * dashed "Add cutoff" button last in the row.
 *
 * Called on load and after add/remove only — never after a plain edit, because
 * storage returns the list sorted and re-ordering chips under a caret is the
 * kind of "helpful" behaviour that makes a settings page hostile.
 *
 * @param cutoffs the times to render, in the order they should appear
 * @param focusIndex chip whose time input should receive focus, or -1 for none
 */
function renderCutoffs(cutoffs: readonly string[], focusIndex = -1): void {
  for (const chip of cutoffList.querySelectorAll('.chip')) chip.remove();

  cutoffs.forEach((value, index) => {
    const chip = document.createElement('div');
    chip.className = 'chip';

    const input = document.createElement('input');
    input.className = 'chip-time';
    input.type = 'time';
    input.required = true;
    input.value = value;
    input.setAttribute('aria-label', `Cutoff ${index + 1}`);
    input.addEventListener('change', () => {
      void saveFromForm();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    // The visible affordance is just an ×; assistive tech gets the whole story.
    remove.setAttribute('aria-label', `Remove cutoff ${value || 'not set'}`);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M18 6 6 18M6 6l12 12" /></svg>';
    remove.addEventListener('click', () => {
      void removeCutoff(index);
    });

    chip.append(input, remove);
    cutoffList.insertBefore(chip, addCutoffButton);
  });

  if (focusIndex >= 0) {
    cutoffInputs()[focusIndex]?.focus();
  }
}

/** First suggested time not already scheduled. */
function suggestCutoff(existing: readonly string[]): string {
  return SUGGESTED_CUTOFFS.find((time) => !existing.includes(time)) ?? '12:00';
}

async function addCutoff(): Promise<void> {
  const values = cutoffValues();
  // Refuse rather than disable, so the limit is explained when it is hit
  // (sweep-controls.spec "Attempt a fifth cutoff").
  if (values.length >= LIMITS.maxCutoffs) {
    showError(`You can have at most ${LIMITS.maxCutoffs} cutoff times.`);
    return;
  }
  const added = suggestCutoff(values);
  const next = readForm([...values, added], saved.noticeMinutes);
  if (next === null) return;
  if (await persist(next)) {
    renderCutoffs(saved.cutoffs, saved.cutoffs.indexOf(added));
  }
}

async function removeCutoff(index: number): Promise<void> {
  const values = cutoffValues();
  if (values.length <= LIMITS.minCutoffs) {
    showError(`Keep at least ${LIMITS.minCutoffs} cutoff time. The schedule cannot be empty.`);
    return;
  }
  const next = readForm(values.filter((_, i) => i !== index), saved.noticeMinutes);
  if (next === null) return;
  if (await persist(next)) {
    renderCutoffs(saved.cutoffs);
    addCutoffButton.focus();
  }
}

// ------------------------------------------------------------ notice picker

/** Reflects `saved.noticeMinutes` in the segmented picker and its summary. */
function renderNotice(): void {
  noticeSummary.textContent =
    saved.noticeMinutes === 0 ? 'no warning' : `${saved.noticeMinutes} min before`;
  for (const button of noticeOptions.querySelectorAll<HTMLButtonElement>('.seg')) {
    button.setAttribute(
      'aria-pressed',
      String(Number(button.dataset.minutes) === saved.noticeMinutes),
    );
  }
}

function buildNoticePicker(): void {
  for (const minutes of NOTICE_CHOICES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seg';
    button.dataset.minutes = String(minutes);
    button.textContent = String(minutes);
    button.setAttribute(
      'aria-label',
      minutes === 0 ? 'No warning' : `${minutes} minutes before the cutoff`,
    );
    button.addEventListener('click', () => {
      const next = readForm(cutoffValues(), minutes);
      if (next === null) return;
      void persist(next);
    });
    noticeOptions.append(button);
  }
}

// ---------------------------------------------------------------- acceptance

/**
 * Keeps the not-yet-accepted commit button naming the earliest cutoff, so the
 * words stay true while the user edits the schedule above it (design.md D7).
 */
function renderAcceptLabel(): void {
  const first = saved.cutoffs[0];
  if (first !== undefined) acceptLabel.textContent = `I understand. Start at ${first}.`;
}

/**
 * The options-page half of the consent gate: onboarding's "Pick a different
 * time" lands here without accepting, so the banner offers the same commit.
 * Accepting is what arms the schedule (via `storage.onChanged`); until then
 * every edit on this page merely describes what the user is about to agree to.
 */
async function initAccept(): Promise<void> {
  acceptBanner.hidden = await isAccepted();
  renderAcceptLabel();
  acceptButton.addEventListener('click', () => {
    void (async () => {
      try {
        await markAccepted();
      } catch {
        showError('Could not save your acceptance. Try again.');
        return;
      }
      acceptBanner.hidden = true;
    })();
  });
}

// --------------------------------------------------------------------- stats

async function renderStats(): Promise<void> {
  const [stats, lastSweep] = await Promise.all([getStats(), getLastSweep()]);
  statLifetime.textContent = stats.lifetimeClosed.toLocaleString('en-US');
  statLast.textContent = lastSweep ? lastSweep.closed.toLocaleString('en-US') : '—';
}

// --------------------------------------------------------------------- init

async function init(): Promise<void> {
  try {
    saved = await getSettings();
  } catch {
    saved = { ...DEFAULT_SETTINGS, cutoffs: [...DEFAULT_SETTINGS.cutoffs] };
  }

  buildNoticePicker();
  renderCutoffs(saved.cutoffs);
  renderNotice();
  notifyInput.checked = saved.notify;
  autoBookmarkInput.checked = saved.autoBookmark;
  keepPinnedInput.checked = saved.keepPinned;

  addCutoffButton.addEventListener('click', () => {
    void addCutoff();
  });
  for (const control of [notifyInput, autoBookmarkInput, keepPinnedInput]) {
    control.addEventListener('change', () => {
      void saveFromForm();
    });
  }

  // A sweep can land while this page is open; the stats are the only part of
  // it that changes underneath the user, so only the stats are re-read.
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if ('stats' in changes || 'lastSweep' in changes) void renderStats().catch(() => undefined);
  });

  await initAccept().catch(() => undefined);
  await renderStats().catch(() => undefined);
}

void init();
