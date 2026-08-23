/**
 * Options page (design.md D10, sweep-controls.spec "Settings surface").
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
 *
 * The one control here that is not a sweep control is the language picker: it
 * writes `settings.locale`, which changes what the UI says and never what the
 * sweep does (design.md D14). The page re-localizes in place rather than
 * reloading — see {@link relocalize}.
 */
import { activeLocale, localeTag, localize, resolveLocale, t } from '../i18n';
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
import type { LocaleSetting, Settings } from '../types';
import { el } from './dom';

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

const cutoffList = el<HTMLDivElement>('cutoff-list');
const addCutoffButton = el<HTMLButtonElement>('add-cutoff');
const cutoffError = el<HTMLParagraphElement>('cutoff-error');
const noticeOptions = el<HTMLDivElement>('notice-options');
const noticeSummary = el<HTMLSpanElement>('notice-summary');
const notifyInput = el<HTMLInputElement>('notify');
const autoBookmarkInput = el<HTMLInputElement>('auto-bookmark');
const keepPinnedInput = el<HTMLInputElement>('keep-pinned');
const localeSelect = el<HTMLSelectElement>('locale');
const statLast = el<HTMLElement>('stat-last');
const statLifetime = el<HTMLElement>('stat-lifetime');
const acceptBanner = el<HTMLElement>('accept-banner');
const acceptButton = el<HTMLButtonElement>('accept');
const acceptLabel = el<HTMLSpanElement>('accept-label');

/** A private copy of the defaults; `cutoffs` is cloned so nothing can mutate it. */
function freshSettings(): Settings {
  return { ...DEFAULT_SETTINGS, cutoffs: [...DEFAULT_SETTINGS.cutoffs] };
}

/**
 * The last successfully persisted settings, kept so the cutoff chips can be
 * re-rendered in the normalised (sorted) order storage hands back, so the
 * notice picker knows the current value (it has no input element of its own),
 * and so a locale change can be told apart from every other kind of save.
 */
let saved: Settings = freshSettings();

// --------------------------------------------------------------- messaging

function showError(message: string): void {
  cutoffError.textContent = message;
}

function clearError(): void {
  cutoffError.textContent = '';
}

/**
 * Maps a validation failure from storage.ts onto copy the user can act on.
 *
 * The limits go in as placeholders rather than baked into the sentence: a
 * translator who sees the digit in the string will sooner or later translate
 * around it. The name `count` is load-bearing — it selects the plural form.
 */
function cutoffErrorMessage(error: InvalidCutoffsError): string {
  switch (error.code) {
    case 'too-few':
      return t('optionsErrorTooFew', { count: LIMITS.minCutoffs });
    case 'too-many':
      return t('optionsErrorTooMany', { count: LIMITS.maxCutoffs });
    case 'duplicate':
      return t('optionsErrorDuplicate', {
        value: error.value ?? t('optionsErrorDuplicateFallback'),
      });
    case 'format':
      return t('optionsErrorFormat', { value: error.value ?? t('optionsErrorFormatFallback') });
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
 * The language picked in the `<select>`.
 *
 * The fallback is the stored value rather than `'auto'`, so an unreadable
 * `<select>` cannot silently retune the user's language.
 */
function selectedLocale(): LocaleSetting {
  const value = localeSelect.value;
  return value === 'auto' || value === 'en' || value === 'uk' ? value : saved.locale;
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
    showError(t('optionsErrorEmptyCutoff'));
    return null;
  }
  return {
    cutoffs,
    noticeMinutes,
    notify: notifyInput.checked,
    autoBookmark: autoBookmarkInput.checked,
    keepPinned: keepPinnedInput.checked,
    locale: selectedLocale(),
  };
}

// ---------------------------------------------------------------- persistence

/**
 * Re-applies the active locale to a page that is already on screen.
 *
 * `localize()`'s DOM walk only reaches the static `data-i18n` markup in
 * ui/options.html, so everything this file writes from script has to be
 * rebuilt by hand. Miss one and the page ends up half in each language.
 */
async function relocalize(): Promise<void> {
  await localize();
  renderCutoffs(saved.cutoffs);
  renderNotice();
  renderAcceptLabel();
  // Not only words: the counters are grouped per locale, see renderStats().
  await renderStats().catch(() => undefined);
}

/**
 * Persists settings and refreshes {@link saved} from storage.
 *
 * The language check lives here rather than in the picker's own handler, so
 * every path that can write a locale re-localizes.
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
        t('optionsErrorNoticeRange', {
          min: LIMITS.minNoticeMinutes,
          max: LIMITS.maxNoticeMinutes,
        }),
      );
    } else {
      showError(t('optionsErrorSaveFailed'));
    }
    return false;
  }
  try {
    saved = await getSettings();
  } catch {
    saved = next;
  }
  clearError();
  if (resolveLocale(saved.locale) !== activeLocale()) {
    // relocalize() re-renders everything the two calls below do, so it stands
    // in for them. On the RESOLVED comparison, see adoptForeignLocale().
    await relocalize();
    return true;
  }
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

/** Namespace SVG elements must be created in; `createElement` yields a dead node. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The chip's × glyph, built node by node.
 *
 * Every other icon in this extension is authored in the markup; this one has to
 * be created per chip, and it is still built with the DOM rather than parsed
 * from a string, so no user-influenced value can ever reach an HTML parser.
 */
function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M18 6 6 18M6 6l12 12');
  svg.append(path);
  return svg;
}

/**
 * Rebuilds the cutoff chips (time input + remove button each), keeping the
 * dashed "Add cutoff" button last in the row.
 *
 * Called on load, after add/remove, and after a language change — never after a
 * plain edit, because storage returns the list sorted and re-ordering chips
 * under a caret is the kind of "helpful" behaviour that makes a settings page
 * hostile.
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
    // Positional, not a quantity — the catalog has no plural group for it.
    input.setAttribute('aria-label', t('optionsCutoffAriaLabel', { index: index + 1 }));
    input.addEventListener('change', () => {
      void saveFromForm();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    // The visible affordance is just an ×, so the whole story goes to assistive
    // tech and to the hover tooltip alike, and the glyph itself is hidden from
    // the accessibility tree (design.md D10, icon-only controls).
    const removeLabel = t('optionsRemoveCutoffAriaLabel', {
      time: value || t('optionsCutoffNotSet'),
    });
    remove.setAttribute('aria-label', removeLabel);
    remove.title = removeLabel;
    remove.append(closeIcon());
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
    showError(t('optionsErrorTooMany', { count: LIMITS.maxCutoffs }));
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
    // Its own key, not `optionsErrorTooFew`: this refusal is pre-emptive, so it
    // carries a second sentence the storage-side error has no room for.
    showError(t('optionsErrorTooFewRemove', { count: LIMITS.minCutoffs }));
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

/**
 * Reflects `saved.noticeMinutes` in the segmented picker and its summary.
 *
 * The aria-labels are (re)written here rather than in the obvious home,
 * {@link buildNoticePicker}, because the picker is built once and the language
 * can change under it.
 */
function renderNotice(): void {
  noticeSummary.textContent =
    saved.noticeMinutes === 0
      ? t('optionsNoticeSummaryOff')
      : t('optionsNoticeSummary', { minutes: saved.noticeMinutes });
  for (const button of noticeOptions.querySelectorAll<HTMLButtonElement>('.seg')) {
    const minutes = Number(button.dataset.minutes);
    button.setAttribute('aria-pressed', String(minutes === saved.noticeMinutes));
    // The visible text is only the numeral, so the label carries the unit and
    // says what the number is measured against.
    button.setAttribute(
      'aria-label',
      minutes === 0
        ? t('optionsNoticeOptionOffAriaLabel')
        : t('optionsNoticeOptionAriaLabel', { count: minutes }),
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
 *
 * `onboardingAccept` is deliberately the same key the onboarding page uses:
 * this is the same consent gate, and the two must read identically.
 */
function renderAcceptLabel(): void {
  const first = saved.cutoffs[0];
  if (first !== undefined) acceptLabel.textContent = t('onboardingAccept', { time: first });
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
        showError(t('optionsErrorAcceptFailed'));
        return;
      }
      acceptBanner.hidden = true;
    })();
  });
}

// --------------------------------------------------------------------- stats

async function renderStats(): Promise<void> {
  const [stats, lastSweep] = await Promise.all([getStats(), getLastSweep()]);
  // Grouped for the chosen interface language, not the browser's: a counter
  // sits against a localized caption, and `12,345 вкладок` mixes two
  // conventions in one card.
  const tag = localeTag(activeLocale());
  statLifetime.textContent = stats.lifetimeClosed.toLocaleString(tag);
  statLast.textContent = lastSweep ? lastSweep.closed.toLocaleString(tag) : '—';
}

// --------------------------------------------------------------------- init

async function init(): Promise<void> {
  // Started before `localize()` is awaited so the two storage round trips
  // overlap; `localize()` is what un-hides the body, so serialising them would
  // just add a beat of blank page.
  const settings = getSettings().catch(() => freshSettings());
  await localize();
  saved = await settings;

  buildNoticePicker();
  renderCutoffs(saved.cutoffs);
  renderNotice();
  notifyInput.checked = saved.notify;
  autoBookmarkInput.checked = saved.autoBookmark;
  keepPinnedInput.checked = saved.keepPinned;
  localeSelect.value = saved.locale;

  addCutoffButton.addEventListener('click', () => {
    void addCutoff();
  });
  for (const control of [notifyInput, autoBookmarkInput, keepPinnedInput, localeSelect]) {
    control.addEventListener('change', () => {
      void saveFromForm();
    });
  }

  // Only the stats and the locale are re-read. Re-applying a schedule the user
  // may be part-way through editing would fight them.
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if ('stats' in changes || 'lastSweep' in changes) void renderStats().catch(() => undefined);
    if ('settings' in changes) void adoptForeignLocale();
  });

  await initAccept().catch(() => undefined);
  await renderStats().catch(() => undefined);
}

/**
 * Picks up a `locale` written by someone other than this page.
 *
 * Our own saves fire `storage.onChanged` too, and either this or {@link persist}
 * may observe the write first. Both therefore ask the same question — does the
 * RESOLVED locale differ from the one already on screen? — so whichever gets
 * there first does the work and the other finds nothing left to do.
 */
async function adoptForeignLocale(): Promise<void> {
  let locale: LocaleSetting;
  try {
    locale = (await getSettings()).locale;
  } catch {
    return;
  }
  // Ahead of the early return: `'auto'` and `'en'` render identically in an
  // English browser, but the control must still show the choice that is stored.
  saved = { ...saved, locale };
  localeSelect.value = locale;
  if (resolveLocale(locale) === activeLocale()) return;
  await relocalize();
}

void init();
