## 1. Project setup

- [ ] 1.1 Initialise repo: TypeScript, `Bun.build` bundling to `dist/` (plus a copy step for static `.html` / `.css` assets), `@types/chrome`, `@types/bun`, `bun test` (per design.md D11); scripts `build`, `watch`, `test`, `typecheck` (the names CI invokes)
- [ ] 1.2 Write per-browser MV3 manifests (shared base + build-time overlay, per design.md D1). Common: `action` with popup, `options_ui`, `commands` (`end-day-now`, default `Alt+Shift+E`), `incognito: "spanning"`, permissions `tabs`, `alarms`, `storage`, `notifications`, `bookmarks` (the escape hatch, design.md D12); no host permissions. Chrome overlay: `background.service_worker`. Firefox overlay: event-page `background.scripts`, `browser_specific_settings.gecko.id`, `browser_specific_settings.gecko.data_collection_permissions` = `{"required": ["none"]}` (now required for all new Firefox extensions — addons-linter reports `MISSING_DATA_COLLECTION_PERMISSIONS` without it, and "none" is the honest value here per D6), and the `sessions` permission
- [ ] 1.3 Add `platform.ts` shim: `forgetClosed()` no-op on Chrome, wired to `browser.sessions.forgetClosedTab/Window` on Firefox

## 2. Storage and settings

- [ ] 2.1 Define typed storage schema (`settings`, `lastAutoCutoffId`, `lastSweep` — including the aggregate `bookmarked` flag — `stats`, `accepted`, `version`) with defaults (`cutoffs: ['18:00']`, `noticeMinutes: 10`, `notify: true`, `autoBookmark: false`, `keepPinned: false`)
- [ ] 2.2 Implement `storage.ts` with `getSettings/setSettings`, `getLastAutoCutoffId/setLastAutoCutoffId`, `getLastSweep/setLastSweep`, `bumpStats`; validate cutoffs (1–4 entries, `HH:MM`, unique, sorted)
- [ ] 2.3 Unit-test validation and defaults

## 3. Schedule engine

- [ ] 3.1 Implement `cutoff.ts`: `cutoffId(date, hhmm)`, `latestElapsedCutoff(now, cutoffs)`, `nextOccurrence(now, hhmm)` using local time; unit-test DST forward/back, midnight wrap, multiple cutoffs
- [ ] 3.2 Implement `reconcile(trigger)`: read settings + `lastAutoCutoffId`, sweep if latest elapsed cutoffId > `lastAutoCutoffId`, then re-arm all `sweep:*` and `notice:*` alarms with `when` = next occurrence and `persistAcrossSessions: true`. On `trigger === 'settings-changed'`, fast-forward `lastAutoCutoffId` to the latest elapsed cutoff under the new schedule instead of sweeping
- [ ] 3.3 Register top-level listeners in `background.ts`: `runtime.onInstalled`, `runtime.onStartup`, `alarms.onAlarm`, `storage.onChanged` (settings), `commands.onCommand`, `runtime.onMessage` (popup) — each calls `reconcile(trigger)` or `sweep('manual')`
- [ ] 3.4 Unit-test idempotency: same cutoffId never sweeps twice; multiple missed cutoffs → one sweep; manual sweep does not advance `lastAutoCutoffId` (next scheduled cutoff still fires); settings edit to an already-past time fast-forwards the marker without sweeping
- [ ] 3.5 Implement the startup settle pass: after an `onStartup` catch-up sweep, set a one-shot `settle` alarm (60 s) whose handler repeats the sweep for the same cutoff, bypassing the idempotency check and folding its closed count into the same sweep's stats; unit-test that it fires once and never advances the marker

## 4. Sweep

- [ ] 4.0 Implement `bookmarks.ts` (design.md D12): `atRiskTabs(keepPinned)` (the set the next sweep would close) and `bookmarkAtRiskTabs(keepPinned, now)` writing titles+URLs to `zero-tabbox / YYYY-MM-DD` under the browser's default bookmark parent, appending to an existing day folder; one failed bookmark must not abort the rest
- [ ] 4.1 Implement `sweep(reason)`: when `autoBookmark` is on, first `bookmarkAtRiskTabs` (failure logged, sweep proceeds); enumerate normal windows; pick keep-window (most pinned tabs when `keepPinned`, else focused-or-first); when `keepPinned`, move pinned tabs from other windows into the keep-window and re-pin them (`tabs.move` drops pinned state); create a new tab only if the keep-window would otherwise be empty; batch `tabs.remove` (windows close themselves when their last tab is removed); record counters, call `platform.forgetClosed()`, set badge to closed count and clear after 60 s
- [ ] 4.2 Exclude popup/app/devtools windows. Private windows per spec: untouched without private-browsing access; with access, same rules applied per context — pinned consolidation never crosses the private/regular boundary, no new-tab page created in private windows, the surviving clean window is always regular
- [ ] 4.3 Manual test matrix on Chrome and Firefox: 1 window / 3 windows / tab groups / pinned on-off / pinned tabs spread across windows with `keepPinned` on / audible tab / discarded tabs / options page open / `beforeunload` page / private window with and without private-browsing access (with access: private tabs closed, pinned private tabs stay private); on Firefox additionally verify swept tabs are absent from the recently-closed list

## 5. Notice and badge

- [ ] 5.1 On `notice:*` alarm: show one `chrome.notifications` basic notification (no buttons) if `notify` is on; start 1-minute `badge` alarm
- [ ] 5.2 Badge alarm handler: write minutes-remaining to badge; clear when the sweep runs or `noticeMinutes` is 0

## 6. UI

- [ ] 6.0 Build `ui/theme.css` per design.md D10: the "ab" design-system tokens from the redesign canvas (stone/ember ramps + semantic aliases, Geist/JetBrains Mono `@font-face` for the bundled `ui/fonts/*.woff2`, radius scale, warm shadows, ember focus ring, `--ease-ab`), dark overrides under `@media (prefers-color-scheme: dark)` only, `color-scheme: light dark`, and component styles for buttons (accent role reserved for the commitment actions), chips, segmented picker, switch, stat cards. No Tailwind, no Radix, no React
- [ ] 6.1 Popup per the redesign: at-risk count sentence, next cutoff as headline numeral with live ETA (per-second accent countdown inside the notice window), "Bookmark all N tabs" (→ `bookmarkAtRiskTabs`, then the saved-to-folder confirmation), "End day now" (solid accent, text label; sends message → `sweep('manual')` with the already-bookmarked flag, closes popup), gear to options; for 60 s after a sweep show the "Day ended" state (closed count, bookmarked-first note, next cutoff, "Back to the day") instead
- [ ] 6.2 Options page per the redesign: contract sentence in the header; cutoff chips (time input + remove ×, dashed "Add cutoff", max 4); badge-countdown picker with stops 0/5/10/20/30/60 and a summary label; notify, bookmark-everything-first and keep-pinned switches; "Since install" stat cards (lifetime closed, last sweep closed); autosave on change; no theme selector
- [ ] 6.3 First-install onboarding page (`ui/onboarding.html`, design.md D7): terms list, headline naming the first cutoff, "I understand" (writes `accepted`, closes the tab), "Pick a different time" (same-tab to options, which shows its own accept button until `accepted` is set) and a plain-text decline (browser's own uninstall confirmation); nothing is armed and no automatic sweep runs until `accepted` is written; `onInstalled` (`reason === 'install'`) opens it once, updates open nothing
- [ ] 6.4 Theme verification: popup, options and onboarding pages in light and dark browser themes on Chrome and Firefox — no light flash before paint, popup backdrop and form controls follow the theme, OS theme change repaints an open options page without reload
- [ ] 6.5 Accessibility pass: keyboard-only traversal of all three surfaces, visible focus ring on every control, WCAG AA contrast checked in both themes

## 7. Verification and packaging

- [ ] 7.1 End-to-end manual scenarios from specs: cutoff fires; catch-up on restart with "Continue where you left off" on (verify the 60 s settle pass catches late-restored tabs); sleep across cutoff; two cutoffs same day; manual sweep then scheduled sweep; cutoff edited to an already-past time (no immediate sweep)
- [ ] 7.2 Verify storage contents after a sweep contain no per-tab data, and that no bookmark exists unless "Bookmark all" was clicked or "bookmark everything first" is on (spec `tab-sweep` / no archive)
- [ ] 7.2a Verify `ui/theme.css` is the only place color literals appear and the dark theme is expressed purely as token overrides (spec `sweep-controls` / visual design)
- [ ] 7.2b Verify the no-data-collection declaration end to end: Firefox build lints with zero findings, the install prompt reports no data collection, and no network request is made during a sweep (spec `tab-sweep` / declares that it collects no data). Mirror the same answers on the Chrome Web Store privacy-practices form if the extension is ever listed
- [ ] 7.3 Write README: contract, known backdoors (Cmd+Shift+T on Chrome — closed on Firefox, browser history, per-profile install), install instructions for both browsers
- [ ] 7.4 Produce per-browser artifacts: Chrome zip for unpacked/self-hosted install; Firefox xpi signed via AMO self-distribution; note store listings as optional follow-up
