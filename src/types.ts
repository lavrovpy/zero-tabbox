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

/** User-editable settings. Exactly the four controls sweep-controls.spec allows. */
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
  /** Whether pinned tabs survive a sweep. The only exemption that exists. */
  keepPinned: boolean;
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
  /** Set once, when the first-install onboarding options page has been opened. */
  onboarded?: boolean;
}

/** Current storage schema version. Bump only alongside a migration. */
export const STORAGE_VERSION = 1;

/** Defaults per tasks.md 2.1 / sweep-schedule.spec "Default schedule". */
export const DEFAULT_SETTINGS: Settings = {
  cutoffs: ['18:00'],
  noticeMinutes: 10,
  notify: true,
  keepPinned: false,
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
