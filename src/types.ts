/**
 * Shared types for zero-tabbox.
 *
 * This module is the single source of truth for the shape of everything that
 * reaches `storage.local`. design.md D6 fixes the key list deliberately: the
 * "nothing is archived" contract is checkable by reading storage, and the
 * Firefox `data_collection_permissions: {required: ["none"]}` declaration is
 * only honest while every key here stays an aggregate counter or a setting.
 * Adding a key that records anything per-tab breaks the spec and the manifest
 * declaration at the same time.
 */

/**
 * The two shipped catalogs (`_locales/<lang>/messages.json`).
 *
 * Defined here, not in `i18n.ts`, so the dependency arrow points one way:
 * `i18n.ts` → `storage.ts` → `types.ts`.
 */
export type Locale = 'en' | 'uk';

/** The stored `locale` setting: a fixed locale, or follow the browser. */
export type LocaleSetting = 'auto' | Locale;

/**
 * User-editable settings: the five sweep controls sweep-controls.spec allows,
 * plus `locale`, which is not a sixth one — it changes nothing about what
 * closes or when (design.md D14).
 */
export interface Settings {
  /**
   * Daily cutoff times as `HH:MM` in local wall-clock time.
   * Invariants (enforced by `validateCutoffs`): 1–4 entries, zero-padded
   * 24-hour `HH:MM`, unique, sorted ascending.
   */
  cutoffs: string[];
  /** Minutes of pre-cutoff notice; 0 disables badge countdown and notification. Range 0–60. */
  noticeMinutes: number;
  /** Whether the pre-cutoff system notification is shown. */
  notify: boolean;
  /**
   * Whether every sweep first writes the at-risk tabs to a dated folder in the
   * browser's bookmarks (design.md D12). The bookmarks are the browser's — the
   * extension still stores nothing.
   */
  autoBookmark: boolean;
  /** Whether pinned tabs survive a sweep. The only exemption that exists. */
  keepPinned: boolean;
  /** Which language the UI renders in. Never the manifest — the browser owns that. */
  locale: LocaleSetting;
}

/** Why a sweep ran. Only `auto` advances the idempotency marker (design.md D3). */
export type SweepReason = 'auto' | 'manual' | 'settle';

/**
 * Display-only record of the most recent sweep. Never consulted by scheduling
 * logic — `lastAutoCutoffId` is the marker that decides whether to sweep.
 *
 * `reason` is narrower than `SweepReason` on purpose: a `settle` pass is part
 * of the catch-up sweep that spawned it (design.md D8), so it is recorded as
 * `auto` and its closed count is folded into that sweep's totals.
 */
export interface LastSweep {
  /** `auto` for scheduled/catch-up/settle sweeps, `manual` for "End day now". */
  reason: 'auto' | 'manual';
  /** Epoch milliseconds when the sweep completed. */
  at: number;
  /** Number of tabs closed by this sweep (including any folded-in settle pass). */
  closed: number;
  /**
   * Whether the closed tabs were written to the browser's bookmarks first —
   * by the auto-bookmark setting or by the popup's "Bookmark all" just before
   * "End day now". Display-only: it picks the popup's "Day ended" wording.
   * An aggregate flag, not per-tab data (design.md D6).
   */
  bookmarked?: boolean;
}

/** Lifetime aggregate counters. No per-tab data, ever. */
export interface Stats {
  /** Total tabs closed since install, across all sweeps. */
  lifetimeClosed: number;
}

/**
 * The complete `chrome.storage.local` shape. The runtime store is sparse —
 * keys are absent until first written — so readers must apply defaults; that
 * is what `storage.ts` exists for.
 */
export interface StorageShape {
  /** Schema version, for future migrations. Currently {@link STORAGE_VERSION}. */
  version: number;
  /** User settings; defaults to {@link DEFAULT_SETTINGS} when absent. */
  settings: Settings;
  /**
   * Idempotency marker: the `cutoffId` of the most recent automatic sweep, or
   * `''` before any has run. Always `YYYY-MM-DDTHH:MM`, so lexical comparison
   * is a valid chronological comparison. Manual sweeps never write it.
   */
  lastAutoCutoffId: string;
  /** Stats for the last sweep of any kind; absent before the first sweep. */
  lastSweep?: LastSweep;
  /** Lifetime counters; defaults to `{lifetimeClosed: 0}` when absent. */
  stats: Stats;
  /**
   * Set once, when the user explicitly accepts the contract — "I understand"
   * on the onboarding page, or its options-page equivalent. Until it is true
   * the background arms no alarms and runs no automatic sweep (design.md D7);
   * merely viewing the onboarding page does not set it.
   */
  accepted?: boolean;
}

/** Current storage schema version. Bump only alongside a migration. */
export const STORAGE_VERSION = 1;

/** Defaults per tasks.md 2.1 / sweep-schedule.spec "Default schedule". */
export const DEFAULT_SETTINGS: Settings = {
  cutoffs: ['18:00'],
  noticeMinutes: 10,
  notify: true,
  autoBookmark: false,
  keepPinned: false,
  locale: 'auto',
};

/**
 * Messages the popup sends to the background.
 *
 * Deliberately one case: the popup owns no logic beyond asking for a sweep. It
 * reads settings and stats straight from `storage.ts` for display.
 */
export type Message = {
  /** "End day now" was clicked. The background answers, then the popup closes. */
  type: 'end-day-now';
  /**
   * `true` when the popup's "Bookmark all" already ran in this popup session,
   * so the sweep record can say the tabs were saved first. Advisory and
   * display-only; it never changes what the sweep closes.
   */
  alreadyBookmarked?: boolean;
};

/** Reply to a {@link Message}. */
export interface MessageResponse {
  /** `false` when the sweep threw; the popup closes regardless. */
  ok: boolean;
  /** Tabs closed, when `ok`. */
  closed?: number;
  /** Message of the failure, when not `ok`. Logged, not shown. */
  error?: string;
}

/** Hard limits from the specs, kept here so UI and validation cannot drift. */
export const LIMITS = {
  /** sweep-schedule.spec: between 1 and 4 cutoffs per day. */
  minCutoffs: 1,
  maxCutoffs: 4,
  /** sweep-controls.spec: pre-notice range 0–60 minutes. */
  minNoticeMinutes: 0,
  maxNoticeMinutes: 60,
} as const;
