## 1. Project setup

- [ ] 1.1 Initialise repo: TypeScript, esbuild bundling to `dist/`, `@types/chrome`, vitest; npm scripts `build`, `watch`, `test`
- [ ] 1.2 Write `manifest.json` (MV3): `background.service_worker`, `action` with popup, `options_ui`, `commands` (`end-day-now`, default `Alt+Shift+E`), permissions `tabs`, `alarms`, `storage`, `notifications`; no host permissions
- [ ] 1.3 Add `platform.ts` shim: `forgetClosed()` no-op on Chrome, wired to `browser.sessions.forgetClosedTab/Window` on Firefox; export a `getRecentlyClosedIfSupported()` guard

## 2. Storage and settings

- [ ] 2.1 Define typed storage schema (`settings`, `lastAutoCutoffId`, `lastSweep`, `stats`, `onboarded`, `version`) with defaults (`cutoffs: ['18:00']`, `noticeMinutes: 10`, `notify: true`, `keepPinned: false`)
- [ ] 2.2 Implement `storage.ts` with `getSettings/setSettings`, `getLastAutoCutoffId/setLastAutoCutoffId`, `getLastSweep/setLastSweep`, `bumpStats`; validate cutoffs (1–4 entries, `HH:MM`, unique, sorted)
- [ ] 2.3 Unit-test validation and defaults

## 3. Schedule engine

- [ ] 3.1 Implement `cutoff.ts`: `cutoffId(date, hhmm)`, `latestElapsedCutoff(now, cutoffs)`, `nextOccurrence(now, hhmm)` using local time; unit-test DST forward/back, midnight wrap, multiple cutoffs
- [ ] 3.2 Implement `reconcile(trigger)`: read settings + `lastAutoCutoffId`, sweep if latest elapsed cutoffId > `lastAutoCutoffId`, then re-arm all `sweep:*` and `notice:*` alarms with `when` = next occurrence and `persistAcrossSessions: true`. On `trigger === 'settings-changed'`, fast-forward `lastAutoCutoffId` to the latest elapsed cutoff under the new schedule instead of sweeping
- [ ] 3.3 Register top-level listeners in `background.ts`: `runtime.onInstalled`, `runtime.onStartup`, `alarms.onAlarm`, `storage.onChanged` (settings), `commands.onCommand`, `runtime.onMessage` (popup) — each calls `reconcile(trigger)` or `sweep('manual')`
- [ ] 3.4 Unit-test idempotency: same cutoffId never sweeps twice; multiple missed cutoffs → one sweep; manual sweep does not advance `lastAutoCutoffId` (next scheduled cutoff still fires); settings edit to an already-past time fast-forwards the marker without sweeping
- [ ] 3.5 Implement the startup settle pass: after an `onStartup` catch-up sweep, set a one-shot `settle` alarm (60 s) whose handler repeats the sweep for the same cutoff, bypassing the idempotency check and folding its closed count into the same sweep's stats; unit-test that it fires once and never advances the marker

## 4. Sweep

- [ ] 4.1 Implement `sweep(reason)`: enumerate normal windows; pick keep-window (most pinned tabs when `keepPinned`, else focused-or-first); when `keepPinned`, move pinned tabs from other windows into the keep-window and re-pin them (`tabs.move` drops pinned state); create a new tab only if the keep-window would otherwise be empty; batch `tabs.remove` (windows close themselves when their last tab is removed); record counters, call `platform.forgetClosed()`, set badge to closed count and clear after 60 s
- [ ] 4.2 Ensure incognito/popup/app/devtools windows are excluded and the extension does not request incognito access
- [ ] 4.3 Manual test matrix on Chrome: 1 window / 3 windows / tab groups / pinned on-off / pinned tabs spread across windows with `keepPinned` on / audible tab / discarded tabs / options page open / `beforeunload` page

## 5. Notice and badge

- [ ] 5.1 On `notice:*` alarm: show one `chrome.notifications` basic notification (no buttons) if `notify` is on; start 1-minute `badge` alarm
- [ ] 5.2 Badge alarm handler: write minutes-remaining to badge; clear when the sweep runs or `noticeMinutes` is 0

## 6. UI

- [ ] 6.1 Popup: next cutoff time, "End day now" button (sends message → `sweep('manual')`, closes popup), link to options; light theme, no other controls
- [ ] 6.2 Options page: cutoff list (add/remove, max 4), notice minutes (0–60), notify toggle, keep-pinned toggle, read-only stats; autosave on change; contract statement block shown always but highlighted on first open
- [ ] 6.3 `onInstalled` (`reason === 'install'`) opens options once and sets `onboarded`; updates open nothing

## 7. Verification and packaging

- [ ] 7.1 End-to-end manual scenarios from specs: cutoff fires; catch-up on restart with "Continue where you left off" on (verify the 60 s settle pass catches late-restored tabs); sleep across cutoff; two cutoffs same day; manual sweep then scheduled sweep; cutoff edited to an already-past time (no immediate sweep)
- [ ] 7.2 Verify storage contents after a sweep contain no per-tab data (spec `tab-sweep` / no archive)
- [ ] 7.3 Write README: contract, known backdoors (Cmd+Shift+T on Chrome, browser history, per-profile install), install-unpacked instructions
- [ ] 7.4 Produce zip for self-hosted install; note Web Store submission as optional follow-up
