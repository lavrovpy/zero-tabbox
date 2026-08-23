/**
 * The only module that touches `chrome.storage`.
 *
 * `storage.local` only — no `sync` (design.md D6). Every getter applies the
 * documented default for a missing key, so callers never see `undefined` for a
 * key that has one. The exported key list is exhaustive and is the artefact
 * that makes the "no archive" guarantee checkable: nothing else is ever
 * written.
 *
 * Getters are also *total*: a corrupt or half-written value falls back to the
 * default for that field instead of rejecting. The background must always be
 * able to schedule; there is no user-visible recovery path for "storage is
 * malformed", and refusing to schedule would silently disable the sweep.
 */
import { isValidHhMm } from './cutoff';
import { api } from './platform';
import { DEFAULT_SETTINGS, LIMITS, STORAGE_VERSION } from './types';
import type { LastSweep, LocaleSetting, Settings, Stats, StorageShape } from './types';

/**
 * Every key this extension may write, ever. Adding one means re-checking
 * tab-sweep.spec ("Sweep does not create a recoverable archive") and the
 * Firefox `data_collection_permissions` declaration.
 */
export const STORAGE_KEYS = [
  'version',
  'settings',
  'lastAutoCutoffId',
  'lastSweep',
  'stats',
  'accepted',
] as const satisfies readonly (keyof StorageShape)[];

/** Why a candidate cutoff list was rejected. Drives the options-page message. */
export type CutoffErrorCode =
  /** Fewer than `LIMITS.minCutoffs` entries. */
  | 'too-few'
  /** More than `LIMITS.maxCutoffs` entries. */
  | 'too-many'
  /** An entry is not a zero-padded 24-hour `HH:MM`. */
  | 'format'
  /** The same time appears twice. */
  | 'duplicate';

/** Thrown by {@link validateCutoffs} (and therefore by {@link setSettings}). */
export class InvalidCutoffsError extends Error {
  /** Machine-readable reason, for mapping to UI copy. */
  readonly code: CutoffErrorCode;
  /** The offending entry, when the failure is about one specific value. */
  readonly value: string | undefined;

  constructor(code: CutoffErrorCode, message: string, value?: string) {
    super(message);
    this.name = 'InvalidCutoffsError';
    this.code = code;
    this.value = value;
  }
}

/**
 * Validates and normalises a cutoff list.
 *
 * Rules (sweep-schedule.spec): 1–4 entries, each a zero-padded 24-hour `HH:MM`,
 * no duplicates. Normalisation is sorting ascending — the stored list is always
 * sorted, so the options page can render it in order without sorting again.
 *
 * Sorting is plain lexical `<`: for zero-padded fixed-width `HH:MM` that is
 * chronological order, which is the same property `cutoffId` relies on.
 *
 * @param cutoffs candidate list, in any order
 * @returns a new, sorted array (the input is never mutated)
 * @throws {InvalidCutoffsError} on the first rule violation found
 */
export function validateCutoffs(cutoffs: readonly string[]): string[] {
  if (!Array.isArray(cutoffs)) {
    throw new InvalidCutoffsError('too-few', 'Cutoffs must be a list of HH:MM times.');
  }
  if (cutoffs.length < LIMITS.minCutoffs) {
    throw new InvalidCutoffsError(
      'too-few',
      `At least ${LIMITS.minCutoffs} cutoff time is required.`,
    );
  }
  if (cutoffs.length > LIMITS.maxCutoffs) {
    throw new InvalidCutoffsError('too-many', `At most ${LIMITS.maxCutoffs} cutoff times allowed.`);
  }

  for (const cutoff of cutoffs) {
    if (typeof cutoff !== 'string' || !isValidHhMm(cutoff)) {
      throw new InvalidCutoffsError(
        'format',
        `"${String(cutoff)}" is not a 24-hour HH:MM time (zero-padded, e.g. 09:05).`,
        typeof cutoff === 'string' ? cutoff : undefined,
      );
    }
  }

  const sorted = [...cutoffs].sort();
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current !== undefined && current === sorted[i - 1]) {
      throw new InvalidCutoffsError('duplicate', `${current} is listed twice.`, current);
    }
  }
  return sorted;
}

// --- storage.local plumbing -------------------------------------------------

/** Reads one key. Returns `undefined` when absent (or when the read fails). */
async function read(key: (typeof STORAGE_KEYS)[number]): Promise<unknown> {
  try {
    const got = (await api.storage.local.get(key)) as Record<string, unknown> | undefined;
    return got?.[key];
  } catch {
    // A read failure is indistinguishable from "not set yet" for our purposes:
    // both mean "use the default". Never propagate — see the module header.
    return undefined;
  }
}

/**
 * Writes a patch, stamping the schema version alongside it.
 *
 * Every write carries `version`, so the key exists from the first write onward
 * without a separate initialisation step (design.md "Migration Plan").
 */
async function write(patch: Partial<StorageShape>): Promise<void> {
  await api.storage.local.set({ version: STORAGE_VERSION, ...patch });
}

/** Narrows an unknown stored value to a plain object for field-wise reading. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Whether `value` is a finite, non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Merges a stored (possibly partial, possibly corrupt) settings object over
 * {@link DEFAULT_SETTINGS}, field by field. Any field that fails its own check
 * falls back individually, so one bad value cannot discard the rest.
 */
function mergeSettings(stored: unknown): Settings {
  const raw = asRecord(stored);

  let cutoffs = [...DEFAULT_SETTINGS.cutoffs];
  if (Array.isArray(raw.cutoffs)) {
    try {
      cutoffs = validateCutoffs(raw.cutoffs as readonly string[]);
    } catch {
      cutoffs = [...DEFAULT_SETTINGS.cutoffs];
    }
  }

  const noticeMinutes = isNoticeMinutes(raw.noticeMinutes)
    ? raw.noticeMinutes
    : DEFAULT_SETTINGS.noticeMinutes;

  return {
    cutoffs,
    noticeMinutes,
    notify: typeof raw.notify === 'boolean' ? raw.notify : DEFAULT_SETTINGS.notify,
    autoBookmark:
      typeof raw.autoBookmark === 'boolean' ? raw.autoBookmark : DEFAULT_SETTINGS.autoBookmark,
    keepPinned:
      typeof raw.keepPinned === 'boolean' ? raw.keepPinned : DEFAULT_SETTINGS.keepPinned,
    // Absent for anyone who installed before the picker existed; the field-wise
    // merge hands them `'auto'`. That is the whole migration — no version bump.
    locale: isLocaleSetting(raw.locale) ? raw.locale : DEFAULT_SETTINGS.locale,
  };
}

/** Whether `value` is one of the three locale settings (design.md D14). */
function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === 'auto' || value === 'en' || value === 'uk';
}

/** Whether `value` is a whole number of minutes inside the allowed notice range. */
function isNoticeMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= LIMITS.minNoticeMinutes &&
    value <= LIMITS.maxNoticeMinutes
  );
}

// --- settings ---------------------------------------------------------------

/**
 * Reads the settings, filling in {@link DEFAULT_SETTINGS} for anything absent
 * or malformed. Never throws: a corrupt stored value falls back to the default
 * for that field rather than leaving the background unable to schedule.
 */
export async function getSettings(): Promise<Settings> {
  return mergeSettings(await read('settings'));
}

/**
 * Writes the settings after validating them.
 *
 * Writing settings is what makes `storage.onChanged` fire, which is the trigger
 * for `reconcile('settings-changed')` in the background (design.md D3) — so a
 * caller must not need to notify the background separately.
 *
 * @param settings the complete settings object to persist; `cutoffs` is
 *   normalised by {@link validateCutoffs} before being written
 * @throws {InvalidCutoffsError} if `cutoffs` is invalid; nothing is written
 * @throws {RangeError} if `noticeMinutes` is outside 0–60
 */
export async function setSettings(settings: Settings): Promise<void> {
  const cutoffs = validateCutoffs(settings.cutoffs);
  if (!isNoticeMinutes(settings.noticeMinutes)) {
    throw new RangeError(
      `noticeMinutes must be a whole number between ${LIMITS.minNoticeMinutes} and ` +
        `${LIMITS.maxNoticeMinutes}; got ${String(settings.noticeMinutes)}.`,
    );
  }
  // An explicit whitelist, not a spread: it is the second half of the "nothing
  // is archived" guarantee (a caller cannot smuggle an extra field into
  // storage), which also makes it the place a new setting is easiest to forget.
  // Omitting one here fails silently — the control appears to work, then the
  // next unrelated save writes the object without it and it reverts.
  const next: Settings = {
    cutoffs,
    noticeMinutes: settings.noticeMinutes,
    notify: Boolean(settings.notify),
    autoBookmark: Boolean(settings.autoBookmark),
    keepPinned: Boolean(settings.keepPinned),
    locale: isLocaleSetting(settings.locale) ? settings.locale : DEFAULT_SETTINGS.locale,
  };
  await write({ settings: next });
}

// --- idempotency marker -----------------------------------------------------

/**
 * The idempotency marker: the `cutoffId` of the most recent automatic sweep.
 *
 * @returns the stored id, or `''` if no automatic sweep has ever run (`''`
 *   sorts before every real `cutoffId`, so the first cutoff always sweeps)
 */
export async function getLastAutoCutoffId(): Promise<string> {
  const stored = await read('lastAutoCutoffId');
  return typeof stored === 'string' ? stored : '';
}

/**
 * Advances the idempotency marker.
 *
 * Written by exactly two paths: a completed automatic sweep, and the
 * fast-forward on a settings change (design.md D3 — editing the schedule must
 * never sweep retroactively). Manual and settle sweeps must NOT call this.
 *
 * @param cutoffId a `YYYY-MM-DDTHH:MM` id
 */
export async function setLastAutoCutoffId(cutoffId: string): Promise<void> {
  await write({ lastAutoCutoffId: cutoffId });
}

// --- display-only stats -----------------------------------------------------

/**
 * The display-only record of the most recent sweep.
 *
 * @returns the record, or `undefined` before the first sweep
 */
export async function getLastSweep(): Promise<LastSweep | undefined> {
  const raw = asRecord(await read('lastSweep'));
  const { reason, at, closed } = raw;
  if ((reason !== 'auto' && reason !== 'manual') || !isCount(at) || !isCount(closed)) {
    return undefined;
  }
  return { reason, at, closed, bookmarked: raw.bookmarked === true };
}

/**
 * Records the most recent sweep for display. Called by every sweep, including
 * manual ones. Never read by scheduling logic.
 */
export async function setLastSweep(lastSweep: LastSweep): Promise<void> {
  await write({
    lastSweep: {
      reason: lastSweep.reason,
      at: lastSweep.at,
      closed: lastSweep.closed,
      bookmarked: lastSweep.bookmarked === true,
    },
  });
}

/**
 * Reads the lifetime counters, defaulting to `{lifetimeClosed: 0}`.
 */
export async function getStats(): Promise<Stats> {
  const raw = asRecord(await read('stats'));
  return { lifetimeClosed: isCount(raw.lifetimeClosed) ? raw.lifetimeClosed : 0 };
}

/**
 * Adds to the lifetime counter.
 *
 * Read-modify-write: `storage.local` has no atomic increment. Sweeps are the
 * only writer and never overlap (a sweep is a single awaited call chain), so
 * the race is not reachable in practice; a lost increment would cost one
 * display-only number, never correctness.
 *
 * @param closed tabs closed by this sweep; may be 0 (a sweep that found nothing
 *   to close still completed)
 * @returns the updated stats
 */
export async function bumpStats(closed: number): Promise<Stats> {
  const current = await getStats();
  const delta = isCount(closed) ? closed : 0;
  const next: Stats = { lifetimeClosed: current.lifetimeClosed + delta };
  await write({ stats: next });
  return next;
}

// --- acceptance -------------------------------------------------------------

/**
 * Records that the user explicitly accepted the contract (design.md D7) —
 * an "I understand" click on the onboarding page or the options page, never
 * a mere page view. Idempotent. Writing it fires `storage.onChanged`, which
 * is what makes the background arm the schedule.
 */
export async function markAccepted(): Promise<void> {
  await write({ accepted: true });
}

/**
 * Whether the contract has been accepted. Until this is true, `reconcile()`
 * arms nothing and sweeps nothing (design.md D7) — the extension is inert.
 */
export async function isAccepted(): Promise<boolean> {
  return (await read('accepted')) === true;
}
