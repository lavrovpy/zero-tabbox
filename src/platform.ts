/**
 * The one module allowed to know which browser it is running in (design.md D1).
 *
 * Two asymmetries are worth the shim:
 *  - `sessions.forgetClosedTab/Window` exists only on Firefox, and is what
 *    closes the "Reopen closed tab" backdoor (tab-sweep.spec).
 *  - `alarms.create({persistAcrossSessions})` is Chrome 150+ only; Firefox and
 *    older Chrome reject the unknown property, so it must be feature-detected
 *    rather than passed unconditionally.
 *
 * Everything else in the codebase talks to {@link api} and stays portable.
 */

/**
 * The extension API namespace.
 *
 * `browser.*` is promise-based everywhere it exists (Firefox, and Chrome 148+);
 * `chrome.*` is the callback namespace on Firefox but promise-based on Chrome
 * for MV3. Preferring `browser` when present gives promises on both targets.
 * Typed as `typeof chrome` because `@types/chrome` is the type surface we build
 * against; Firefox-only members are reached through the narrow helpers below.
 */
export const api: typeof chrome =
  (globalThis as { browser?: typeof chrome }).browser ?? globalThis.chrome;

/** The Firefox-only half of `sessions`, absent from `@types/chrome`. */
interface FirefoxSessions {
  getRecentlyClosed?: (filter?: chrome.sessions.Filter) => Promise<chrome.sessions.Session[]>;
  forgetClosedTab?: (windowId: number, sessionId: string) => Promise<void>;
  forgetClosedWindow?: (sessionId: string) => Promise<void>;
}

/**
 * Whether this build is running on Firefox.
 *
 * Detected at runtime (not at build time) from a Firefox-only API surface, so
 * the same bundle behaves correctly wherever it is loaded and the branch is
 * reachable from unit tests. Two independent signals, either of which is
 * conclusive: the `moz-extension:` URL scheme, and `runtime.getBrowserInfo`
 * (Firefox-only). Never throws — a missing `runtime` just means "not Firefox".
 */
export function isFirefox(): boolean {
  const scoped = (globalThis as { browser?: typeof chrome }).browser;
  const runtime = scoped?.runtime as
    | (typeof chrome.runtime & { getBrowserInfo?: unknown })
    | undefined;
  if (!runtime) return false;
  try {
    if (typeof runtime.getURL === 'function' && runtime.getURL('').startsWith('moz-extension://')) {
      return true;
    }
  } catch {
    // getURL can throw outside an extension context; fall through to the next signal.
  }
  return typeof runtime.getBrowserInfo === 'function';
}

/**
 * `persistAcrossSessions` support, cached for the life of this background
 * context. Module state is fine here and only here: it is a capability probe,
 * not state the schedule depends on, and re-probing after a cold start is free.
 */
let persistAcrossSessionsSupported: boolean | undefined;

/**
 * Creates a named one-shot alarm, adding `persistAcrossSessions: true` only
 * where it is supported.
 *
 * Persistence is a bonus, never a correctness requirement: `reconcile()`
 * re-arms every alarm on each wake, which is also Chrome's own documented
 * remedy for alarms that may not survive a restart. The flag is Chrome 150+;
 * Firefox and older Chrome reject unknown `alarmInfo` properties, so it is
 * probed once by attempt and then remembered.
 *
 * @param name alarm name, e.g. `sweep:18:00`, `notice:18:00`, `badge`, `settle`
 * @param when epoch milliseconds at which the alarm should fire
 */
export async function createAlarm(name: string, when: number): Promise<void> {
  if (persistAcrossSessionsSupported !== false) {
    try {
      await api.alarms.create(name, { when, persistAcrossSessions: true });
      persistAcrossSessionsSupported = true;
      return;
    } catch {
      persistAcrossSessionsSupported = false;
    }
  }
  await api.alarms.create(name, { when });
}

/**
 * Creates a repeating alarm (the 1-minute badge countdown, design.md D5).
 *
 * Never carries `persistAcrossSessions`: a countdown that outlives the browser
 * session would tick against a cutoff that `reconcile()` has already re-armed.
 *
 * @param name alarm name
 * @param periodInMinutes repeat period; must be ≥ 0.5 to be honoured by Chrome
 */
export async function createRepeatingAlarm(
  name: string,
  periodInMinutes: number,
): Promise<void> {
  await api.alarms.create(name, { periodInMinutes, delayInMinutes: periodInMinutes });
}

/** Upper bound on enumerate-and-forget passes; up to 25 entries each. */
const FORGET_PASSES = 10;

/**
 * Clock slack when deciding whether a recently-closed entry belongs to this
 * sweep. Entries are stamped by the browser, not by us.
 */
const FORGET_SLACK_MS = 5_000;

/**
 * When a recently-closed entry was closed, in epoch milliseconds.
 *
 * `Session.lastModified` is documented as seconds on Chrome and behaves as
 * milliseconds on Firefox, so the unit is inferred: any plausible epoch in
 * seconds is far below 1e11, any plausible epoch in milliseconds far above it.
 *
 * @returns the instant, or `undefined` when the entry carries no usable stamp
 *   — in which case the caller treats it as ours (fail open: leaving a swept
 *   tab restorable is a spec violation, forgetting one extra entry is not)
 */
function closedAtMs(entry: { lastModified?: number }): number | undefined {
  const stamp = entry.lastModified;
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return undefined;
  return stamp < 1e11 ? stamp * 1000 : stamp;
}

/**
 * Removes the just-swept entries from the browser's recently-closed list.
 *
 * No-op on Chrome — `chrome.sessions` exposes no forget API there, so
 * Cmd+Shift+T remains a documented backdoor for the rest of the session.
 *
 * On Firefox this is not a single call: session ids only come from
 * `sessions.getRecentlyClosed()`, whose results are capped at
 * `sessions.MAX_SESSION_RESULTS` (25), and post-sweep entries are mostly closed
 * *windows* (`forgetClosedWindow(sessionId)`) rather than closed tabs
 * (`forgetClosedTab(windowId, sessionId)`). A sweep that closes more than the
 * cap therefore needs a bounded enumerate-and-forget loop, stopping when the
 * list stops shrinking.
 *
 * Never rejects: failing to clear the list must not fail the sweep.
 *
 * @param since epoch milliseconds captured just before the sweep's
 *   `tabs.remove`. Entries closed before it are the user's own earlier manual
 *   closes and are left alone — tab-sweep.spec asks only that *swept* tabs
 *   become unrestorable. Omit to forget the whole list.
 */
export async function forgetClosed(since?: number): Promise<void> {
  try {
    if (!isFirefox()) return;
    const sessions = api.sessions as (typeof chrome.sessions & FirefoxSessions) | undefined;
    if (!sessions?.getRecentlyClosed) return;
    const cutoff = typeof since === 'number' ? since - FORGET_SLACK_MS : undefined;

    // Bounded: one enumeration returns at most MAX_SESSION_RESULTS (25) entries
    // and older ones surface as those are forgotten, so loop — but stop as soon
    // as a pass achieves nothing, and never more than FORGET_PASSES times.
    for (let pass = 0; pass < FORGET_PASSES; pass += 1) {
      const entries = await sessions.getRecentlyClosed();
      if (entries.length === 0) return;

      let forgotten = 0;
      for (const entry of entries) {
        try {
          if (cutoff !== undefined) {
            const closedAt = closedAtMs(entry);
            if (closedAt !== undefined && closedAt < cutoff) continue;
          }
          const windowSessionId = entry.window?.sessionId;
          const tab = entry.tab;
          if (windowSessionId && sessions.forgetClosedWindow) {
            await sessions.forgetClosedWindow(windowSessionId);
            forgotten += 1;
          } else if (tab?.sessionId !== undefined && sessions.forgetClosedTab) {
            await sessions.forgetClosedTab(tab.windowId, tab.sessionId);
            forgotten += 1;
          }
        } catch {
          // One stubborn entry must not abort the rest, nor fail the sweep.
        }
      }
      if (forgotten === 0) return;
    }
  } catch (error) {
    console.warn('[zero-tabbox] forgetClosed failed', error);
  }
}
