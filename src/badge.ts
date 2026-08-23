/**
 * Toolbar badge and the pre-cutoff notification (tasks.md section 5,
 * sweep-controls.spec "Pre-cutoff notice" / "Post-sweep feedback is minimal").
 *
 * The badge is the whole pre-cutoff UI; there is no snooze, postpone or cancel
 * anywhere in this module by design.
 *
 * Two rules shape every function here:
 *
 *  1. **Nothing in this module ever rejects.** The badge is feedback about a
 *     sweep, not part of one. `sweep()` awaits `setClosedBadge`, so a badge
 *     failure that propagated would turn a completed sweep into a failed one and
 *     lose its counters — the sweep is recorded as completed either way
 *     (tab-sweep.spec "Sweep is atomic from the user's perspective").
 *  2. **No colors are set.** `action.setBadgeBackgroundColor` /
 *     `setBadgeTextColor` are deliberately not called: the browser's own default
 *     badge colors already follow its theme, and calling them would put color
 *     literals outside `ui/theme.css` (tasks.md 7.2a). The badge carries a
 *     number, and the number is the whole message.
 */
import { initI18n, t } from './i18n';
import { api } from './platform';

/** Id of the pre-cutoff notification, fixed so a second notice replaces the first. */
const NOTICE_ID = 'zero-tabbox-notice';

/** Packaged icon for the notification. `iconUrl` is required by `notifications.create`. */
const NOTICE_ICON = 'icons/icon128.png';

/**
 * Writes badge text, swallowing failures.
 *
 * @param text badge text, or `''` to clear it
 */
async function writeBadge(text: string): Promise<void> {
  try {
    await api.action.setBadgeText({ text });
  } catch (error) {
    console.warn('[zero-tabbox] could not set the badge', error);
  }
}

/**
 * Shows the minutes remaining before a cutoff, e.g. `8`.
 *
 * @param minutesRemaining minutes until the cutoff; values ≤ 0 clear the badge
 */
export async function setCountdownBadge(minutesRemaining: number): Promise<void> {
  // At zero the cutoff is here; the sweep's own count takes the badge over
  // within the second, and an empty badge is better than a stale `0`.
  if (!Number.isFinite(minutesRemaining) || minutesRemaining <= 0) {
    await clearBadge();
    return;
  }
  await writeBadge(String(Math.round(minutesRemaining)));
}

/**
 * Shows how many tabs a sweep just closed. The caller clears it within 60 s
 * (sweep-controls.spec "Badge after sweep") via the `badge-clear` alarm.
 *
 * @param closed tab count from {@link SweepResult}
 */
export async function setClosedBadge(closed: number): Promise<void> {
  if (!Number.isFinite(closed) || closed <= 0) {
    await clearBadge();
    return;
  }
  await writeBadge(String(Math.round(closed)));
}

/** Clears the badge text. Safe to call when no badge is set. */
export async function clearBadge(): Promise<void> {
  await writeBadge('');
}

/**
 * Shows the single pre-cutoff system notification, if `settings.notify` is on.
 *
 * One basic notification, no action buttons, nothing happens on click
 * (sweep-controls.spec "Notification has no actions"). Firefox supports only
 * `type`/`title`/`message`/`iconUrl`, so the options must stay within those
 * four; `iconUrl` is a packaged extension icon.
 *
 * The copy (`noticeTitle`, and the `noticeMessage` plural group) states the
 * cutoff time and restates the contract, because this is the last moment at
 * which bookmarking anything is still possible. The body stays ONE message with
 * `$COUNT$` inline; never re-split it into a count and a fixed tail, which
 * Ukrainian cannot translate as independent halves (design.md D14).
 *
 * No DOM here, so the locale comes from {@link initI18n}, not `localize()`, and
 * per notice rather than once: the background is torn down between the alarm
 * being set and it firing, and a woken worker starts on `'en'`.
 *
 * @param cutoffHhMm the cutoff the notice is for, `HH:MM`, named in the message
 * @param minutesAhead how far ahead of the cutoff the notice is firing
 */
export async function showNoticeNotification(
  cutoffHhMm: string,
  minutesAhead: number,
): Promise<void> {
  const minutes = Math.max(0, Math.round(minutesAhead));
  try {
    await initI18n();
  } catch (error) {
    // Caught separately from the notification below: an unresolvable locale
    // costs the user a translation, never the notice itself.
    console.warn('[zero-tabbox] could not resolve the notice locale', error);
  }
  try {
    await api.notifications.create(NOTICE_ID, {
      type: 'basic',
      iconUrl: api.runtime.getURL(NOTICE_ICON),
      title: t('noticeTitle', { time: cutoffHhMm }),
      message: t('noticeMessage', { count: minutes }),
    });
  } catch (error) {
    // A notification the browser refused (permission revoked, focus assist,
    // a platform that dropped the API) must not stop the badge countdown.
    console.warn('[zero-tabbox] could not show the pre-cutoff notice', error);
  }
}
