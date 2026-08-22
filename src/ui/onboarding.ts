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
import { localize, t } from '../i18n';
import { api } from '../platform';
import { getSettings, markAccepted } from '../storage';
import { DEFAULT_SETTINGS } from '../types';
import { el } from './dom';

/**
 * The cutoff the markup's static English already names, and the fallback for
 * both strings written below.
 *
 * `DEFAULT_SETTINGS.cutoffs` is never empty, so the `??` is `noUncheckedIndexedAccess`
 * paying its way rather than a real branch — but deriving the value keeps the
 * literal `18:00` in `onboarding.html` and the default in `types.ts` from
 * drifting apart silently.
 */
const DEFAULT_CUTOFF = DEFAULT_SETTINGS.cutoffs[0] ?? '18:00';

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

/**
 * The first cutoff — the time both the headline and the accept label name.
 *
 * `getSettings()` is total, so the catch is belt and braces; either way the
 * answer is a real HH:MM, because a page that cannot read storage must still
 * state the contract rather than a blank.
 */
async function firstCutoff(): Promise<string> {
  try {
    return (await getSettings()).cutoffs[0] ?? DEFAULT_CUTOFF;
  } catch {
    // The static 18:00 in the markup is this same default, so the sentence is
    // still true — it is only the language that may be wrong for a moment.
    return DEFAULT_CUTOFF;
  }
}

async function init(): Promise<void> {
  // The read is started BEFORE `localize()` is awaited so the two storage round
  // trips overlap. `localize()` is what un-hides the body, and neither string
  // written below is part of its DOM walk (both interpolate the time), so
  // reading serially would paint the English defaults for a frame first.
  const cutoff = firstCutoff();
  await localize();
  // The headline states the real first cutoff, which on a fresh install is the
  // default 18:00 — but if the user reaches settings first and comes back, the
  // words still tell the truth.
  const time = await cutoff;
  // The whole <h1> is rewritten, not just #cutoff-time: Ukrainian puts «о»
  // before the time and reorders the sentence around it, so the time is not a
  // slot the surrounding English can keep. #cutoff-time stays in the markup as
  // part of the visible English default and is not read back.
  el<HTMLHeadingElement>('headline').textContent = t('onboardingHeadline', { time });
  el<HTMLSpanElement>('accept-label').textContent = t('onboardingAccept', { time });
}

void init();
