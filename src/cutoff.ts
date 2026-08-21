/**
 * Cutoff arithmetic: pure, local-time, no extension APIs and no I/O.
 *
 * Everything here is deliberately side-effect free so the DST / midnight-wrap /
 * multi-cutoff cases can be unit-tested against a fake `now` (tasks.md 3.1).
 * All computation uses the host's *current* local timezone via the `Date`
 * constructor, which is what makes "18:00 means 18:00 wall clock after a DST
 * shift" true (sweep-schedule.spec "Cutoffs follow local wall-clock time").
 *
 * Two rules hold throughout and must survive every edit:
 *
 *  1. Never `toISOString()` / `getUTC*()`. A `cutoffId` is a *local* calendar
 *     day plus a local wall-clock time; a UTC round-trip would shift the day
 *     part for most of the world and break the idempotency marker.
 *  2. Never add 24 h to get "tomorrow". Instants are always rebuilt from local
 *     calendar fields (`new Date(y, m, d + n, h, min)`), which is what keeps the
 *     wall-clock time stable across a DST transition (design.md D2).
 */

/** A parsed `HH:MM` cutoff time. */
export interface HhMm {
  /** 0–23. */
  hours: number;
  /** 0–59. */
  minutes: number;
}

/**
 * Zero-padded 24-hour `HH:MM`, anchored at both ends.
 *
 * Anchoring is what rejects `'18:00 '` and `'118:00'`; the alternations are what
 * reject `'24:00'` and `'09:60'`; the two-digit groups are what reject `'9:05'`.
 * Requiring the padding is not pedantry — `cutoffId` values are compared
 * lexically, and `'9:05'` sorts after `'18:00'`.
 */
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses a zero-padded 24-hour `HH:MM` string.
 *
 * Strict: exactly two digits, a colon, two digits, in range. `'9:05'`,
 * `'09:5'`, `'24:00'` and `'18:00 '` are all rejected.
 *
 * @param hhmm candidate time string
 * @returns the parsed value, or `null` if `hhmm` is not a valid `HH:MM`
 */
export function parseHhMm(hhmm: string): HhMm | null {
  if (typeof hhmm !== 'string') return null;
  const match = HHMM_RE.exec(hhmm);
  if (match === null) return null;
  // Both groups matched a fixed-width digit run, so `Number` cannot be NaN.
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Whether `hhmm` is a valid zero-padded 24-hour `HH:MM` string.
 *
 * @param hhmm candidate time string
 */
export function isValidHhMm(hhmm: string): boolean {
  return parseHhMm(hhmm) !== null;
}

/** Left-pads a non-negative integer to at least `width` digits. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * The *local* calendar day of `date` as `YYYY-MM-DD`.
 *
 * The date half of a {@link cutoffId}, and the name of the dated bookmarks
 * folder the escape hatch writes into (design.md D12). Local getters only —
 * see rule 1 in the module header.
 */
export function localDateStamp(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * Builds the idempotency marker for a cutoff on a given local calendar day.
 *
 * Format: `YYYY-MM-DDTHH:MM`, where the date part is `date`'s *local* calendar
 * day and the time part is `hhmm` verbatim. Fixed width, so lexical ordering
 * equals chronological ordering (design.md D3).
 *
 * Note the date comes from `date` and the time from `hhmm`: callers pass the
 * day on which the cutoff occurred, not the instant it fired.
 *
 * @param date any instant on the local calendar day of the cutoff
 * @param hhmm the cutoff time, valid `HH:MM`
 * @returns e.g. `'2026-08-19T18:00'`
 * @throws {RangeError} if `hhmm` is not a valid `HH:MM`
 */
export function cutoffId(date: Date, hhmm: string): string {
  if (!isValidHhMm(hhmm)) {
    throw new RangeError(`cutoffId: "${hhmm}" is not a zero-padded 24-hour HH:MM time`);
  }
  return `${localDateStamp(date)}T${hhmm}`;
}

/**
 * The local instant of `time` on the calendar day `dayOffset` days from `now`.
 *
 * Built from calendar fields, so `dayOffset: 1` means "the same wall-clock time
 * tomorrow" (23, 24 or 25 hours later depending on DST), and a wall-clock time
 * that does not exist on a spring-forward day rolls forward within that day
 * exactly as the browser's own clock does.
 */
function instantOn(now: Date, dayOffset: number, time: HhMm): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    time.hours,
    time.minutes,
    0,
    0,
  );
}

/**
 * The most recent cutoff instant at or before `now`, as a `cutoffId`.
 *
 * Searches today's cutoffs first, then falls back to yesterday's latest cutoff
 * when none of today's has elapsed yet (the midnight-wrap case). A cutoff whose
 * local instant equals `now` counts as elapsed.
 *
 * The caller compares the result lexically against `lastAutoCutoffId` to decide
 * whether to sweep; only the single most recent cutoff matters, which is what
 * makes several missed cutoffs collapse into one catch-up sweep
 * (sweep-schedule.spec "Multiple cutoffs missed").
 *
 * @param now current instant
 * @param cutoffs configured cutoffs, `HH:MM`; order is irrelevant, invalid
 *   entries are ignored
 * @returns the `cutoffId` of the latest elapsed cutoff, or `null` when
 *   `cutoffs` is empty (or holds no valid entry)
 */
export function latestElapsedCutoff(now: Date, cutoffs: readonly string[]): string | null {
  const nowMs = now.getTime();
  let bestMs = Number.NEGATIVE_INFINITY;
  let bestId: string | null = null;

  for (const hhmm of cutoffs) {
    const time = parseHhMm(hhmm);
    if (time === null) continue;
    // Today, then yesterday. Two days is enough: yesterday's latest cutoff is
    // at most ~24 h old, so it always elapsed if today's has not.
    for (const dayOffset of [0, -1]) {
      const at = instantOn(now, dayOffset, time);
      const ms = at.getTime();
      if (ms <= nowMs && ms > bestMs) {
        bestMs = ms;
        bestId = cutoffId(at, hhmm);
      }
    }
  }

  return bestId;
}

/**
 * The next local instant at which `hhmm` occurs, strictly after `now`.
 *
 * Today's occurrence if it is still ahead, otherwise tomorrow's. Computed from
 * local calendar fields rather than by adding 24 h, so DST transitions keep the
 * wall-clock time stable. Used as the `when` for the non-repeating `sweep:*`
 * and (offset by `noticeMinutes`) `notice:*` alarms (design.md D2).
 *
 * @param now current instant
 * @param hhmm cutoff time, valid `HH:MM`
 * @returns a `Date` strictly greater than `now`
 * @throws {RangeError} if `hhmm` is not a valid `HH:MM`
 */
export function nextOccurrence(now: Date, hhmm: string): Date {
  const time = parseHhMm(hhmm);
  if (time === null) {
    throw new RangeError(`nextOccurrence: "${hhmm}" is not a zero-padded 24-hour HH:MM time`);
  }

  const nowMs = now.getTime();
  let dayOffset = 0;
  let next = instantOn(now, dayOffset, time);
  // Normally one step at most. The bound is defensive: a zone that skips a
  // whole wall-clock day (none currently do) must not spin forever.
  while (next.getTime() <= nowMs && dayOffset < 3) {
    dayOffset += 1;
    next = instantOn(now, dayOffset, time);
  }
  return next;
}
