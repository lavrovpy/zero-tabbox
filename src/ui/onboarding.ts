/**
 * First-install onboarding (design.md D7): one screen stating the terms
 * of the contract, opened once by the background's `onInstalled` handler.
 *
 * Nothing destructive happens until the contract is explicitly accepted:
 * viewing this page writes nothing, and the background arms no schedule
 * while the `accepted` flag is unset. "I understand" writes it and closes
 * the page; "Pick a different time" goes to settings in the same tab, where
 * the equivalent accept button waits; the plain-text decline underneath
 * hands off to the browser's own uninstall confirmation — uninstalling is
 * the one thing an extension may do to itself without extra permissions
 * (disabling requires the "management" permission, which we don't ask for).
 */
import { api } from '../platform';
import { getSettings, markAccepted } from '../storage';
import { el } from './dom';

const accept = el<HTMLButtonElement>('accept');
const pickTime = el<HTMLButtonElement>('pick-time');
const decline = el<HTMLButtonElement>('decline');

/** Closes this page's own tab; falls back to `window.close` if the API balks. */
async function closeSelf(): Promise<void> {
  try {
    const tab = await api.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await api.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Fall through to window.close below.
  }
  window.close();
}

accept.addEventListener('click', () => {
  void (async () => {
    try {
      await markAccepted();
    } catch {
      // Failing to record acceptance fails safe — the schedule stays unarmed.
      // Keep the page open so the click can be retried.
      return;
    }
    await closeSelf();
  })();
});

pickTime.addEventListener('click', () => {
  // Same-tab navigation, not `openOptionsPage()`: the user is mid-flow and a
  // second tab would leave this one behind, still showing the terms. Not an
  // acceptance — the options page shows its own accept button until then.
  window.location.href = api.runtime.getURL('ui/options.html');
});

decline.addEventListener('click', () => {
  // The browser shows its own confirmation dialog; cancelling it rejects the
  // promise, which is not an error — the user simply changed their mind.
  void api.management.uninstallSelf({ showConfirmDialog: true }).catch(() => undefined);
});

async function init(): Promise<void> {
  // The headline states the real first cutoff, which on a fresh install is the
  // default 18:00 — but if the user reaches settings first and comes back, the
  // words still tell the truth.
  try {
    const settings = await getSettings();
    const first = settings.cutoffs[0];
    if (first !== undefined) {
      el<HTMLSpanElement>('cutoff-time').textContent = first;
      el<HTMLSpanElement>('accept-label').textContent = `I understand. Start at ${first}.`;
    }
  } catch {
    // The static 18:00 in the markup matches the default settings.
  }
}

void init();
