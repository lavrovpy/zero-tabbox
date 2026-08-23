/**
 * The schedule engine (design.md D2, D3, D5, D8).
 *
 * `background.ts` is only the listener layer; everything it dispatches to lives
 * here. Two properties are load-bearing and worth stating up front:
 *
 *  1. **Alarms are hints, not the schedule.** Correctness comes from
 *     `reconcile()` re-deriving everything from the clock and `storage` on every
 *     wake, so a dropped, delayed or duplicated alarm cannot cause a missed or
 *     doubled sweep. This is also Chrome's own documented remedy for alarms
 *     that may not survive a restart.
 *  2. **Every entry point is serialised.** The background wakes with several
 *     events at once (the bootstrap `reconcile` plus `runtime.onStartup` at
 *     browser start, for instance); without a queue two of them could both read
 *     the pre-sweep marker and sweep twice.
 *
 * Every dependency is injectable so the idempotency rules can be tested against
 * a fake clock and fake storage without a browser (tests/reconcile.test.ts).
 */
import { clearBadge, setCountdownBadge, showNoticeNotification } from './badge';
import { latestElapsedCutoff, nextOccurrence } from './cutoff';
import { api, createAlarm, createRepeatingAlarm } from './platform';
import { getLastAutoCutoffId, getSettings, isAccepted, setLastAutoCutoffId } from './storage';
import { sweep, type SweepOptions, type SweepResult } from './sweep';
import type { Settings, SweepReason } from './types';

/** What caused `reconcile()` to run. Only the reason differs, not the logic. */
export type ReconcileTrigger =
  /**
   * `runtime.onStartup` — a real browser start, and the only trigger that arms
   * the D8 settle pass. A cold start of the background context is `'wake'`:
   * the two are indistinguishable inside this module, and the background is
   * cold-started by every alarm, so treating them alike would put a settle
   * pass after every scheduled cutoff.
   */
  | 'startup'
  /** Any cold start of the background context (alarm wake, re-enable, crash). */
  | 'wake'
  /** `runtime.onInstalled` (install, update, or browser update). */
  | 'installed'
  /** A `sweep:*` or `notice:*` alarm fired. */
  | 'alarm'
  /** `settings` changed — fast-forwards the marker instead of sweeping. */
  | 'settings-changed';

/** Alarm names. `HH:MM` is appended to the two prefixed ones. */
export const ALARM = {
  /** `sweep:18:00` — the cutoff itself. */
  sweepPrefix: 'sweep:',
  /** `notice:18:00` — `noticeMinutes` before the cutoff. */
  noticePrefix: 'notice:',
  /** Repeating 1-minute badge countdown between the notice and the cutoff. */
  badge: 'badge',
  /** One-shot 60 s post-startup settle pass (design.md D8). */
  settle: 'settle',
  /**
   * One-shot clear of the post-sweep count badge. An alarm, not a `setTimeout`:
   * the background is torn down long before 60 s are up.
   */
  badgeClear: 'badge-clear',
} as const;

/** Delay of the post-startup settle pass (design.md D8). */
export const SETTLE_DELAY_MS = 60_000;

/** How long the post-sweep count stays on the badge (sweep-controls.spec). */
export const BADGE_CLEAR_MS = 60_000;

const MINUTE_MS = 60_000;

/**
 * Everything the engine touches that is not pure arithmetic. Injected so the
 * scheduling rules are testable; the defaults are the real browser-backed
 * implementations.
 */
export interface ReconcileDeps {
  /** Current instant. Cutoffs are local wall-clock, so this is a `Date`. */
  now(): Date;
  /** Whether the user has explicitly accepted the contract (design.md D7). */
  isAccepted(): Promise<boolean>;
  getSettings(): Promise<Settings>;
  getLastAutoCutoffId(): Promise<string>;
  setLastAutoCutoffId(cutoffId: string): Promise<void>;
  sweep(reason: SweepReason, options?: SweepOptions): Promise<SweepResult>;
  latestElapsedCutoff(now: Date, cutoffs: readonly string[]): string | null;
  nextOccurrence(now: Date, hhmm: string): Date;
  getAlarms(): Promise<{ name: string }[]>;
  createAlarm(name: string, when: number): Promise<void>;
  createRepeatingAlarm(name: string, periodInMinutes: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  setCountdownBadge(minutesRemaining: number): Promise<void>;
  clearBadge(): Promise<void>;
  showNotice(cutoffHhMm: string, minutesAhead: number): Promise<void>;
}

/** The browser-backed dependency set used everywhere outside tests. */
export const defaultDeps: ReconcileDeps = {
  now: () => new Date(),
  isAccepted,
  getSettings,
  getLastAutoCutoffId,
  setLastAutoCutoffId,
  sweep,
  latestElapsedCutoff,
  nextOccurrence,
  getAlarms: () => api.alarms.getAll(),
  createAlarm,
  createRepeatingAlarm,
  clearAlarm: async (name) => {
    await api.alarms.clear(name);
  },
  setCountdownBadge,
  clearBadge,
  showNotice: showNoticeNotification,
};

/**
 * Serialises every public entry point.
 *
 * Chained rather than locked, so a rejected run cannot wedge the queue and no
 * caller ever has to handle "busy". Only the public functions enter the queue;
 * internal helpers must not, or `reconcile()` would deadlock on its own sweep.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * The heart of the schedule (design.md D2/D3). Reads settings and
 * `lastAutoCutoffId`, sweeps when the latest elapsed cutoff is newer than the
 * marker, then re-arms every `sweep:*` and `notice:*` alarm from the current
 * local clock. The alarm is only a wake-up hint; correctness lives here.
 *
 * On `'settings-changed'` it fast-forwards `lastAutoCutoffId` to the latest
 * elapsed cutoff under the new schedule *instead of* sweeping, so moving a
 * cutoff to a time already past does not close the options page being edited.
 * An unset marker (a fresh profile) takes the same branch: the first run seeds
 * the marker and the first sweep happens at the next cutoff, not on install
 * (sweep-schedule.spec "Fresh install").
 *
 * On `'startup'` a catch-up sweep also arms the 60 s settle pass (design.md D8),
 * because session restore may still be materialising tabs.
 *
 * Safe to call repeatedly and concurrently: every wake event calls it.
 *
 * @returns whether this call performed a catch-up sweep — which is what the
 *   caller needs to decide whether the settle pass is owed (see `background.ts`)
 */
export function reconcile(
  trigger: ReconcileTrigger,
  deps: ReconcileDeps = defaultDeps,
): Promise<boolean> {
  return serialize(() => reconcileNow(trigger, deps));
}

/**
 * Arms the one-shot settle pass (design.md D8). Exported because at a real
 * browser start the bootstrap `reconcile('wake')` is queued before
 * `runtime.onStartup` is dispatched, so the call that performs the catch-up
 * sweep is not the call that knows the browser just started.
 */
export async function armSettlePass(deps: ReconcileDeps = defaultDeps): Promise<void> {
  await deps.createAlarm(ALARM.settle, deps.now().getTime() + SETTLE_DELAY_MS);
}

async function reconcileNow(trigger: ReconcileTrigger, deps: ReconcileDeps): Promise<boolean> {
  if (!(await deps.isAccepted())) {
    // Consent gate (design.md D7): until the user explicitly accepts the
    // contract, no automatic sweep runs, no marker is seeded and no schedule
    // or badge alarm is armed — the extension is inert. Writing `accepted`
    // fires `storage.onChanged`, whose listener reconciles again; that call
    // seeds the marker (unset → fast-forward, so acceptance never sweeps
    // retroactively) and arms the schedule.
    for (const alarm of await deps.getAlarms()) {
      if (isScheduleAlarm(alarm.name) || alarm.name === ALARM.badge) {
        await deps.clearAlarm(alarm.name);
      }
    }
    return false;
  }

  const settings = await deps.getSettings();
  const now = deps.now();
  const latest = deps.latestElapsedCutoff(now, settings.cutoffs);
  const marker = await deps.getLastAutoCutoffId();
  let swept = false;

  if (trigger === 'settings-changed' || marker === '') {
    // Two cases, one rule: adopt the latest elapsed cutoff as already-done
    // instead of sweeping for it.
    //  - settings change: never sweep retroactively for a schedule the user
    //    just typed (design.md D3).
    //  - unset marker: a fresh profile has nothing to catch up on, and
    //    `latestElapsedCutoff` always names *some* elapsed cutoff, so without
    //    this the install itself would close every open tab with no notice.
    if (latest !== null && latest !== marker) await deps.setLastAutoCutoffId(latest);
  } else if (latest !== null && latest > marker) {
    // Lexical comparison is chronological: every id is `YYYY-MM-DDTHH:MM`.
    // Several missed cutoffs collapse into this one sweep — sweeping is not
    // cumulative.
    await sweepNow('auto', latest, deps);
    swept = true;
    if (trigger === 'startup') await armSettlePass(deps);
  }

  await rearm(settings, trigger, deps);
  return swept;
}

/**
 * Everything `runSweep` takes beyond the reason, as one bag. These were three
 * trailing optionals, which forced callers to pad with `undefined` to reach
 * the one they actually meant (`runSweep('manual', undefined, undefined, x)`).
 */
export interface RunSweepOptions extends SweepOptions {
  /** The id to record for an `auto` sweep; omitted otherwise. */
  cutoffId?: string;
  /** Injected dependency seam for tests; defaults to the real dependencies. */
  deps?: ReconcileDeps;
}

/**
 * Runs a sweep and records it. `auto` advances `lastAutoCutoffId`; `manual` and
 * `settle` do not (design.md D3/D8), which is what keeps "End day now" from
 * cancelling the evening cutoff and keeps the settle pass part of the same
 * catch-up rather than a second sweep.
 *
 * @returns the number of tabs closed, for the badge and the popup's reply
 */
export function runSweep(reason: SweepReason, opts: RunSweepOptions = {}): Promise<number> {
  const { cutoffId, deps = defaultDeps, ...options } = opts;
  return serialize(() => sweepNow(reason, cutoffId, deps, options));
}

async function sweepNow(
  reason: SweepReason,
  cutoffId: string | undefined,
  deps: ReconcileDeps,
  options?: SweepOptions,
): Promise<number> {
  const result = await deps.sweep(reason, options);
  if (reason === 'auto' && cutoffId) await deps.setLastAutoCutoffId(cutoffId);

  // The countdown is over and the badge now shows the closed count instead.
  await deps.clearAlarm(ALARM.badge);
  await deps.createAlarm(ALARM.badgeClear, deps.now().getTime() + BADGE_CLEAR_MS);
  return result.closed;
}

/**
 * Re-arms the schedule: one non-repeating `sweep:HH:MM` per cutoff at its next
 * local occurrence, plus `notice:HH:MM` at `cutoff − noticeMinutes`.
 *
 * Recomputing `when` from local calendar fields on every wake (rather than a
 * 24 h period) is what makes DST and timezone changes work. Stale alarms for
 * cutoffs the user removed are cleared, but `settle`, `badge` and `badge-clear`
 * are deliberately left alone — a blanket `clearAll()` would drop the settle
 * pass that was just armed. A `notice:*` alarm whose time is already past but
 * whose cutoff is still ahead is left alone too: it may be an overdue delivery
 * still owed to the user, and clearing it would drop that notification.
 */
async function rearm(
  settings: Settings,
  trigger: ReconcileTrigger,
  deps: ReconcileDeps,
): Promise<void> {
  const now = deps.now();
  const wanted = new Map<string, number>();
  const pending = new Set<string>();

  for (const hhmm of settings.cutoffs) {
    let next: Date;
    try {
      next = deps.nextOccurrence(now, hhmm);
    } catch {
      continue; // A malformed stored cutoff must not stop the others arming.
    }
    wanted.set(ALARM.sweepPrefix + hhmm, next.getTime());
    if (settings.noticeMinutes > 0) {
      const noticeAt = next.getTime() - settings.noticeMinutes * MINUTE_MS;
      // A notice time already past means we are inside the window right now.
      // Re-arming it would re-fire the notification on every wake, so
      // `syncCountdown` picks the badge up instead — but any alarm already
      // armed for it is kept, in case its delivery is merely late.
      if (noticeAt > now.getTime()) wanted.set(ALARM.noticePrefix + hhmm, noticeAt);
      else pending.add(ALARM.noticePrefix + hhmm);
    }
  }

  for (const alarm of await deps.getAlarms()) {
    if (!isScheduleAlarm(alarm.name)) continue;
    if (!wanted.has(alarm.name) && !pending.has(alarm.name)) await deps.clearAlarm(alarm.name);
  }
  for (const [name, when] of wanted) {
    await deps.createAlarm(name, when);
  }

  await syncCountdown(settings, now, trigger, deps);
}

function isScheduleAlarm(name: string): boolean {
  return name.startsWith(ALARM.sweepPrefix) || name.startsWith(ALARM.noticePrefix);
}

/**
 * Keeps the badge countdown consistent with the schedule after a re-arm — the
 * case that matters is waking up *inside* a notice window (restart at 17:55
 * with an 18:00 cutoff), where the `notice:` alarm is already in the past.
 *
 * The badge itself is only cleared on a settings change: at any other moment it
 * may be showing a post-sweep count that has its own 60 s clear armed.
 */
async function syncCountdown(
  settings: Settings,
  now: Date,
  trigger: ReconcileTrigger,
  deps: ReconcileDeps,
): Promise<void> {
  const minutes = minutesToNextCutoff(settings, now, deps);
  if (settings.noticeMinutes > 0 && minutes !== null && minutes <= settings.noticeMinutes) {
    await deps.createRepeatingAlarm(ALARM.badge, 1);
    await deps.setCountdownBadge(minutes);
    return;
  }
  await deps.clearAlarm(ALARM.badge);
  if (trigger === 'settings-changed') await deps.clearBadge();
}

/** Whole minutes until the soonest upcoming cutoff, or `null` if none is set. */
function minutesToNextCutoff(
  settings: Settings,
  now: Date,
  deps: ReconcileDeps,
): number | null {
  let soonest = Number.POSITIVE_INFINITY;
  for (const hhmm of settings.cutoffs) {
    try {
      soonest = Math.min(soonest, deps.nextOccurrence(now, hhmm).getTime());
    } catch {
      continue;
    }
  }
  if (!Number.isFinite(soonest)) return null;
  // Ceil so 17:52:00 before an 18:00 cutoff reads 8, not 7
  // (sweep-controls.spec "Badge countdown").
  return Math.ceil((soonest - now.getTime()) / MINUTE_MS);
}

/**
 * `notice:HH:MM` fired: one system notification (if enabled) and the start of
 * the 1-minute badge countdown (design.md D5). No snooze, postpone or cancel
 * exists anywhere in this path, by spec.
 */
export async function handleNoticeAlarm(
  name: string,
  deps: ReconcileDeps = defaultDeps,
): Promise<void> {
  const hhmm = name.slice(ALARM.noticePrefix.length);
  const settings = await deps.getSettings();
  // A leftover alarm for a cutoff the user has since removed must do nothing.
  if (settings.noticeMinutes <= 0 || !settings.cutoffs.includes(hhmm)) {
    await deps.clearAlarm(name);
    return;
  }
  if (settings.notify) await deps.showNotice(hhmm, settings.noticeMinutes);
  await deps.createRepeatingAlarm(ALARM.badge, 1);
  const minutes = minutesToNextCutoff(settings, deps.now(), deps);
  await deps.setCountdownBadge(minutes ?? settings.noticeMinutes);
}

/**
 * `badge` fired: write the minutes remaining, or stand the countdown down once
 * the window has passed (the sweep clears it too, and `noticeMinutes: 0`
 * disables it entirely).
 */
export async function handleBadgeAlarm(deps: ReconcileDeps = defaultDeps): Promise<void> {
  const settings = await deps.getSettings();
  const minutes = minutesToNextCutoff(settings, deps.now(), deps);
  if (settings.noticeMinutes <= 0 || minutes === null || minutes > settings.noticeMinutes) {
    await deps.clearAlarm(ALARM.badge);
    await deps.clearBadge();
    return;
  }
  await deps.setCountdownBadge(minutes);
}

/**
 * Routes one alarm to its handler. Anything unrecognised — including a
 * `sweep:*` alarm for a cutoff that has since been edited — falls through to
 * `reconcile()`, which re-derives the truth from settings and the clock.
 */
export async function handleAlarm(
  alarm: { name: string },
  deps: ReconcileDeps = defaultDeps,
): Promise<void> {
  const name = alarm.name;
  if (name === ALARM.settle) {
    // Repeats the catch-up sweep for the same cutoff: it neither reads nor
    // advances the marker, and its count folds into that sweep (design.md D8).
    await runSweep('settle', { deps });
    return;
  }
  if (name === ALARM.badge) {
    await handleBadgeAlarm(deps);
    return;
  }
  if (name === ALARM.badgeClear) {
    await deps.clearBadge();
    return;
  }
  if (name.startsWith(ALARM.noticePrefix)) {
    await handleNoticeAlarm(name, deps);
    return;
  }
  await reconcile('alarm', deps);
}

