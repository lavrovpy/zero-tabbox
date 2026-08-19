/**
 * Background entry point: service worker on Chrome, event page on Firefox.
 *
 * This file is the listener layer and nothing else — every decision lives in
 * `reconcile.ts`. Two rules govern it and must survive every future edit:
 *
 *  1. Every listener is registered synchronously at the top level. A listener
 *     added inside a callback or after an `await` does not wake the background,
 *     which would silently break the "sweeps are unavoidable" guarantee.
 *  2. No state lives in module scope between events. The background is torn
 *     down when idle (~30 s on Chrome; "a few seconds" on Firefox) and globals
 *     do not survive. Only `alarms` and `storage.local` do.
 */
import { api } from './platform';
import { armSettlePass, handleAlarm, reconcile, runSweep } from './reconcile';
import type { MessageResponse } from './types';

/**
 * The onboarding entry point (design.md D7).
 *
 * `?onboarding=1` rather than a bare `openOptionsPage()`: the options page is
 * the only writer of the `onboarded` flag, so opening it in its onboarding
 * state must not depend on which of the two contexts wins a race to storage.
 * `options_ui.open_in_tab` is true, so this is the same surface the browser's
 * own "Options" menu item opens.
 */
const ONBOARDING_PAGE = 'ui/options.html?onboarding=1';

/**
 * Runs a handler, logging and swallowing both synchronous throws and
 * rejections. A background listener that throws takes the whole event
 * dispatch down with it.
 */
function guard(label: string, work: () => Promise<unknown>): void {
  try {
    void work().catch((error: unknown) => {
      console.error(`[zero-tabbox] ${label} failed`, error);
    });
  } catch (error) {
    console.error(`[zero-tabbox] ${label} threw`, error);
  }
}

// --- Top-level listener registration. Order does not matter; timing does. ---

// Cold start of the background context. Chrome fires neither onStartup nor
// onInstalled when a disabled extension is re-enabled, so reconciling at the
// top level (not only from listeners) is what covers that path, plus crashes.
// `reconcile` serialises its callers, so this and `onStartup` cannot both sweep.
//
// The trigger is `'wake'`, not `'startup'`: the background is cold-started by
// every `sweep:*` alarm too, and this call — queued synchronously at module
// evaluation — always reaches the queue before the alarm dispatch that woke us.
// Calling it `'startup'` would therefore hang a D8 settle pass off every
// scheduled cutoff, closing whatever the user opened in the following minute.
const bootstrap = reconcile('wake');
guard('bootstrap reconcile', () => bootstrap);

api.runtime.onStartup.addListener(() => {
  // Browser start: the catch-up path, and the only trigger that owes a settle
  // pass (design.md D8). Because `bootstrap` above is queued first, it is
  // normally the call that performs the catch-up sweep, so the settle pass has
  // to be armed on its behalf here — this listener is the only evidence that
  // the cold start was a browser start rather than an alarm wake.
  guard('onStartup', async () => {
    const bootstrapSwept = await bootstrap.catch(() => false);
    const swept = await reconcile('startup');
    if (bootstrapSwept && !swept) await armSettlePass();
  });
});

api.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // One-time onboarding (design.md D7). Updates open nothing.
    guard('onboarding', async () => {
      await api.tabs.create({ url: api.runtime.getURL(ONBOARDING_PAGE) });
    });
  }
  guard('onInstalled', () => reconcile('installed'));
});

api.alarms.onAlarm.addListener((alarm) => {
  // sweep:* -> reconcile, notice:* -> notification + countdown, badge -> tick,
  // badge-clear -> clear, settle -> the D8 second pass.
  guard('onAlarm', () => handleAlarm(alarm));
});

api.storage.onChanged.addListener((changes, areaName) => {
  // Settings edits reschedule immediately, without sweeping retroactively.
  if (areaName !== 'local' || !('settings' in changes)) return;
  guard('onChanged', () => reconcile('settings-changed'));
});

api.commands.onCommand.addListener((command) => {
  // `end-day-now` (default Alt+Shift+E). No confirmation, by design.
  if (command !== 'end-day-now') return;
  guard('onCommand', () => runSweep('manual'));
});

api.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const type = messageType(message);
  if (type === 'end-day-now') {
    void (async () => {
      try {
        const closed = await runSweep('manual');
        sendResponse({ ok: true, closed } satisfies MessageResponse);
      } catch (error) {
        sendResponse({ ok: false, error: String(error) } satisfies MessageResponse);
      }
    })();
    return true; // response is sent asynchronously
  }
  // `Message` in types.ts declares exactly one case, and this is it. The popup
  // reads the schedule and stats straight from storage rather than waking the
  // background to render a clock, so there is no status message to answer.
  return false;
});

/** Narrows an untrusted message to its `type`, if it has one. */
function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
