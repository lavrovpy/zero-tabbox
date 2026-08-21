/**
 * First-install onboarding (design.md D7): one screen stating the five terms
 * of the contract, opened once by the background's `onInstalled` handler.
 *
 * Both buttons accept the contract — there is deliberately no "no thanks"
 * button, because declining is the browser's own uninstall flow, not ours.
 * "I understand" closes the page and leaves the default schedule armed;
 * "Pick a different time" goes to settings in the same tab. Either way the
 * `onboarded` flag is written so this page is never opened again
 * automatically (sweep-controls.spec "One-time onboarding").
 */
import { api } from '../platform';
import { getSettings, markOnboarded } from '../storage';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`onboarding.html is missing #${id}`);
  return node as T;
}

const accept = el<HTMLButtonElement>('accept');
const pickTime = el<HTMLButtonElement>('pick-time');

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
  void closeSelf();
});

pickTime.addEventListener('click', () => {
  // Same-tab navigation, not `openOptionsPage()`: the user is mid-flow and a
  // second tab would leave this one behind, still showing the terms.
  window.location.href = api.runtime.getURL('ui/options.html');
});

async function init(): Promise<void> {
  // The flag is written on view, not on click: the page has been shown, which
  // is all "once" means. Both buttons work even if this write fails.
  await markOnboarded().catch(() => undefined);

  // The headline states the real first cutoff, which on a fresh install is the
  // default 18:00 — but if the user reaches settings first and comes back, the
  // words still tell the truth.
  try {
    const settings = await getSettings();
    const first = settings.cutoffs[0];
    if (first !== undefined) {
      for (const id of ['cutoff-time', 'cutoff-time-2']) {
        el<HTMLSpanElement>(id).textContent = first;
      }
      el<HTMLSpanElement>('accept-label').textContent = `I understand. Start at ${first}.`;
    }
  } catch {
    // The static 18:00 in the markup matches the default settings.
  }
}

void init();
