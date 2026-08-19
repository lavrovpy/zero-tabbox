## 1. Project setup

- [ ] 1.1 Initialise repo: TypeScript, esbuild bundling to `dist/` (plus a copy step for static `.html` / `.css` assets), `@types/chrome`, vitest; npm scripts `build`, `watch`, `test`
- [ ] 1.2 Write per-browser MV3 manifests (shared base + build-time overlay, per design.md D1). Common: `action` with popup, `options_ui`, `commands` (`end-day-now`, default `Alt+Shift+E`), `incognito: "spanning"`, permissions `tabs`, `alarms`, `storage`, `notifications`; no host permissions. Chrome overlay: `background.service_worker`. Firefox overlay: event-page `background.scripts`, `browser_specific_settings.gecko.id`, and the `sessions` permission
- [ ] 1.3 Add `platform.ts` shim: `forgetClosed()` no-op on Chrome, wired to `browser.sessions.forgetClosedTab/Window` on Firefox

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
- [ ] 4.2 Exclude popup/app/devtools windows. Private windows per spec: untouched without private-browsing access; with access, same rules applied per context — pinned consolidation never crosses the private/regular boundary, no new-tab page created in private windows, the surviving clean window is always regular
- [ ] 4.3 Manual test matrix on Chrome and Firefox: 1 window / 3 windows / tab groups / pinned on-off / pinned tabs spread across windows with `keepPinned` on / audible tab / discarded tabs / options page open / `beforeunload` page / private window with and without private-browsing access (with access: private tabs closed, pinned private tabs stay private); on Firefox additionally verify swept tabs are absent from the recently-closed list

## 5. Notice and badge

- [ ] 5.1 On `notice:*` alarm: show one `chrome.notifications` basic notification (no buttons) if `notify` is on; start 1-minute `badge` alarm
- [ ] 5.2 Badge alarm handler: write minutes-remaining to badge; clear when the sweep runs or `noticeMinutes` is 0

## 6. UI

- [ ] 6.0 Build `ui/theme.css` per design.md D10: shadcn-style OKLCH token set (`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`), dark overrides under `@media (prefers-color-scheme: dark)`, `color-scheme: light dark`, and base element styles for button / input / label / switch / focus ring. No Tailwind, no Radix, no React
- [ ] 6.1 Popup: next cutoff time, "End day now" button (destructive token role, text label; sends message → `sweep('manual')`, closes popup), link to options; no other controls
- [ ] 6.2 Options page: cutoff list (add/remove, max 4), notice minutes (0–60), notify toggle, keep-pinned toggle, read-only stats; autosave on change; contract statement block shown always but highlighted on first open (styled with the `--card` / `--muted` roles, not a raw paragraph); no theme selector
- [ ] 6.3 `onInstalled` (`reason === 'install'`) opens options once and sets `onboarded`; updates open nothing
- [ ] 6.4 Theme verification: popup and options page in light and dark browser themes on Chrome and Firefox — no light flash before paint, popup backdrop and form controls follow the theme, OS theme change repaints an open options page without reload
- [ ] 6.5 Accessibility pass: keyboard-only traversal of popup and options page, visible focus ring on every control, WCAG AA contrast checked in both themes

## 7. Verification and packaging

- [ ] 7.1 End-to-end manual scenarios from specs: cutoff fires; catch-up on restart with "Continue where you left off" on (verify the 60 s settle pass catches late-restored tabs); sleep across cutoff; two cutoffs same day; manual sweep then scheduled sweep; cutoff edited to an already-past time (no immediate sweep)
- [ ] 7.2 Verify storage contents after a sweep contain no per-tab data (spec `tab-sweep` / no archive)
- [ ] 7.2a Verify `ui/theme.css` is the only place color literals appear and the dark theme is expressed purely as token overrides (spec `sweep-controls` / visual design)
- [ ] 7.3 Write README: contract, known backdoors (Cmd+Shift+T on Chrome — closed on Firefox, browser history, per-profile install), install instructions for both browsers
- [ ] 7.4 Produce per-browser artifacts: Chrome zip for unpacked/self-hosted install; Firefox xpi signed via AMO self-distribution; note store listings as optional follow-up
