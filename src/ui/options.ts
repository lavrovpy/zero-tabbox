/**
 * Options page (tasks.md 6.2), which doubles as the one-time onboarding surface
 * (design.md D7): the contract statement is always rendered and merely
 * highlighted on first open.
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
 */
import { api } from '../platform';
import {
  InvalidCutoffsError,
  getLastSweep,
  getSettings,
  getStats,
  isOnboarded,
  markOnboarded,
  setSettings,
} from '../storage';
import { DEFAULT_SETTINGS, LIMITS } from '../types';
import type { Settings } from '../types';

/**
 * Times offered when the user adds a cutoff, first unused one wins. There are
 * more candidates than {@link LIMITS.maxCutoffs}, so one is always free.
 */
const SUGGESTED_CUTOFFS = ['18:00', '13:00', '09:00', '22:00', '16:00'] as const;

/** How long the "Saved" acknowledgement stays on screen, in milliseconds. */
const SAVED_NOTICE_MS = 1800;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`options.html is missing #${id}`);
  return node as T;
}

const contract = el<HTMLElement>('contract');
const contractNote = el<HTMLElement>('contract-note');
const cutoffList = el<HTMLDivElement>('cutoff-list');
const addCutoffButton = el<HTMLButtonElement>('add-cutoff');
const cutoffError = el<HTMLParagraphElement>('cutoff-error');
const noticeMinutesInput = el<HTMLInputElement>('notice-minutes');
const notifyInput = el<HTMLInputElement>('notify');
const keepPinnedInput = el<HTMLInputElement>('keep-pinned');
const statLast = el<HTMLElement>('stat-last');
const statLastClosed = el<HTMLElement>('stat-last-closed');
const statLifetime = el<HTMLElement>('stat-lifetime');
const saveStatus = el<HTMLParagraphElement>('save-status');

/**
 * The last successfully persisted settings, kept only so the cutoff rows can be
 * re-rendered in the normalised (sorted) order storage hands back.
 */
let saved: Settings = { ...DEFAULT_SETTINGS, cutoffs: [...DEFAULT_SETTINGS.cutoffs] };

let savedNoticeTimer: ReturnType<typeof setTimeout> | undefined;

// --------------------------------------------------------------- messaging

function showError(message: string): void {
  cutoffError.textContent = message;
}

function clearError(): void {
  cutoffError.textContent = '';
}

function announceSaved(): void {
  saveStatus.textContent = 'Saved';
  if (savedNoticeTimer !== undefined) clearTimeout(savedNoticeTimer);
  savedNoticeTimer = setTimeout(() => {
    saveStatus.textContent = '';
  }, SAVED_NOTICE_MS);
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
 * Only the two failures the browser cannot express in the markup are checked
 * here — an empty time input and a number input the user has typed out of range
 * — everything else is left to `validateCutoffs` in storage.ts so there is one
 * definition of a valid schedule.
 *
 * @param cutoffs the cutoff list to use, so callers can add/remove entries
 * @returns the settings to persist, or `null` when the form is not saveable
 *   (the reason has already been shown)
 */
function readForm(cutoffs: string[]): Settings | null {
  if (cutoffs.some((value) => value === '')) {
    showError('Every cutoff needs a time.');
    return null;
  }
  const minutes = noticeMinutesInput.valueAsNumber;
  if (
    !Number.isInteger(minutes) ||
    minutes < LIMITS.minNoticeMinutes ||
    minutes > LIMITS.maxNoticeMinutes
  ) {
    showError(
      `Notice must be a whole number of minutes from ${LIMITS.minNoticeMinutes} to ${LIMITS.maxNoticeMinutes}.`,
    );
    return null;
  }
  return {
    cutoffs,
    noticeMinutes: minutes,
    notify: notifyInput.checked,
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
  announceSaved();
  return true;
}

/** Autosave path for edits that do not change the number of rows. */
async function saveFromForm(): Promise<void> {
  const next = readForm(cutoffValues());
  if (next === null) return;
  await persist(next);
}

// -------------------------------------------------------------- cutoff rows

/**
 * Rebuilds the cutoff rows.
 *
 * Called on load and after add/remove only — never after a plain edit, because
 * storage returns the list sorted and re-ordering rows under a caret is the
 * kind of "helpful" behaviour that makes a settings page hostile.
 *
 * @param cutoffs the times to render, in the order they should appear
 * @param focusIndex row whose time input should receive focus, or -1 for none
 */
function renderCutoffs(cutoffs: readonly string[], focusIndex = -1): void {
  cutoffList.replaceChildren();

  cutoffs.forEach((value, index) => {
    const row = document.createElement('div');
    row.className = 'cutoff-row';

    const inputId = `cutoff-${index}`;
    const label = document.createElement('label');
    label.className = 'label cutoff-label';
    label.htmlFor = inputId;
    label.textContent = `Cutoff ${index + 1}`;

    const input = document.createElement('input');
    input.id = inputId;
    input.className = 'input input-time';
    input.type = 'time';
    input.required = true;
    input.value = value;
    input.addEventListener('change', () => {
      void saveFromForm();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-sm cutoff-remove';
    remove.textContent = 'Remove';
    // The visible label is just "Remove"; assistive tech gets the whole story.
    remove.setAttribute('aria-label', `Remove cutoff ${index + 1}, ${value || 'not set'}`);
    remove.addEventListener('click', () => {
      void removeCutoff(index);
    });

    row.append(label, input, remove);
    cutoffList.append(row);
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
  const next = readForm([...values, added]);
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
  const next = readForm(values.filter((_, i) => i !== index));
  if (next === null) return;
  if (await persist(next)) {
    renderCutoffs(saved.cutoffs);
    addCutoffButton.focus();
  }
}

// --------------------------------------------------------------------- stats

function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function renderStats(): Promise<void> {
  const [stats, lastSweep] = await Promise.all([getStats(), getLastSweep()]);
  statLifetime.textContent = String(stats.lifetimeClosed);
  statLast.textContent = lastSweep ? formatTimestamp(lastSweep.at) : 'Never';
  statLastClosed.textContent = lastSweep ? String(lastSweep.closed) : '—';
}

// ---------------------------------------------------------------- onboarding

/**
 * Highlights the contract on first open (design.md D7). The statement itself is
 * in the markup and always visible; this only adds emphasis, then records that
 * onboarding has happened so it never emphasises again.
 *
 * `?onboarding=1` forces the highlight, which is how the background can open
 * this page in its onboarding state without depending on write ordering.
 */
async function applyOnboarding(): Promise<void> {
  const forced = new URLSearchParams(window.location.search).get('onboarding') === '1';
  const first = forced || !(await isOnboarded());
  if (!first) return;
  contract.classList.add('is-highlighted');
  contractNote.hidden = false;
  await markOnboarded();
}

// --------------------------------------------------------------------- init

async function init(): Promise<void> {
  try {
    saved = await getSettings();
  } catch {
    saved = { ...DEFAULT_SETTINGS, cutoffs: [...DEFAULT_SETTINGS.cutoffs] };
  }

  renderCutoffs(saved.cutoffs);
  noticeMinutesInput.value = String(saved.noticeMinutes);
  notifyInput.checked = saved.notify;
  keepPinnedInput.checked = saved.keepPinned;

  addCutoffButton.addEventListener('click', () => {
    void addCutoff();
  });
  for (const control of [noticeMinutesInput, notifyInput, keepPinnedInput]) {
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

  await renderStats().catch(() => undefined);
  await applyOnboarding().catch(() => undefined);
}

void init();
