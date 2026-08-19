/**
 * Toolbar popup (tasks.md 6.1).
 *
 * Contract: the popup owns no sweep logic and no schedule logic. It reads
 * settings through `storage.ts`, derives the next cutoff with the pure helpers
 * in `cutoff.ts`, and asks the background to sweep by message. It shows exactly
 * three things — the next cutoff, "End day now", and the settings link. Stats
 * belong to the options page, and anything resembling a pause, snooze or
 * restore control is out of scope by spec, not by omission (sweep-controls.spec
 * "No softening controls" / "Settings surface").
 *
 * Status is computed here rather than fetched from the background on purpose:
 * `Message` in types.ts is frozen to the single `end-day-now` case, and waking
 * a terminated service worker just to render a clock would be a worse trade
 * than recomputing two Date fields from the same storage the background reads.
 */
import { nextOccurrence } from '../cutoff';
import { api } from '../platform';
import { getSettings } from '../storage';
import type { Message } from '../types';

/** The next configured cutoff, resolved to a concrete upcoming instant. */
interface NextCutoff {
  /** The configured `HH:MM`, shown verbatim so it matches the options page. */
  hhmm: string;
  /** The local instant it next occurs at, strictly in the future. */
  at: Date;
}

const endDayNow = document.querySelector<HTMLButtonElement>('#end-day-now');
const openOptions = document.querySelector<HTMLAnchorElement>('#open-options');
const cutoffTime = document.querySelector<HTMLParagraphElement>('#next-cutoff-time');
const cutoffEta = document.querySelector<HTMLParagraphElement>('#next-cutoff-eta');

endDayNow?.addEventListener('click', () => {
  // No confirmation dialog, by design (sweep-controls.spec "Manual End day now").
  // The popup closes either way: a failed sweep is logged, not argued about.
  // The `catch` is what makes "logged" true — `finally` re-throws, and a
  // popup that is being torn down has nowhere to report an unhandled rejection.
  endDayNow.disabled = true;
  const message: Message = { type: 'end-day-now' };
  void Promise.resolve(api.runtime.sendMessage(message))
    .catch((error: unknown) => {
      console.warn('[zero-tabbox] end-day-now could not be delivered', error);
    })
    .finally(() => window.close());
});

openOptions?.addEventListener('click', (event) => {
  event.preventDefault();
  api.runtime.openOptionsPage();
});

/**
 * The soonest upcoming cutoff across the whole schedule.
 *
 * Invalid entries are skipped rather than thrown on: a popup that renders
 * "no cutoff configured" is better than one that renders nothing.
 *
 * @returns the nearest cutoff, or `null` when none is configured or valid
 */
export function soonestCutoff(now: Date, cutoffs: readonly string[]): NextCutoff | null {
  let best: NextCutoff | null = null;
  for (const hhmm of cutoffs) {
    let at: Date;
    try {
      at = nextOccurrence(now, hhmm);
    } catch {
      continue;
    }
    if (best === null || at.getTime() < best.at.getTime()) {
      best = { hhmm, at };
    }
  }
  return best;
}

/**
 * Human "time remaining", always derived from whole minutes so it agrees with
 * the badge countdown (sweep-controls.spec "Badge countdown" counts minutes).
 *
 * @param minutes minutes until the cutoff; negatives are clamped to 0
 */
export function formatEta(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return 'in less than a minute';
  if (total < 60) return `in ${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

/** Renders the header from storage. Failures degrade to placeholders. */
async function render(): Promise<void> {
  const now = new Date();

  try {
    const settings = await getSettings();
    const next = soonestCutoff(now, settings.cutoffs);
    if (next === null) {
      if (cutoffTime) cutoffTime.textContent = '--:--';
      if (cutoffEta) cutoffEta.textContent = 'No cutoff configured';
    } else {
      const minutes = (next.at.getTime() - now.getTime()) / 60_000;
      if (cutoffTime) cutoffTime.textContent = next.hhmm;
      if (cutoffEta) cutoffEta.textContent = formatEta(minutes);
    }
  } catch {
    if (cutoffEta) cutoffEta.textContent = 'Schedule unavailable';
  }
}

void render();
