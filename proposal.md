## Why

Open tabs silently accumulate into a 100–200 tab backlog that is neither read nor discarded, and every existing "auto-close" tool (Tab Wrangler, Tabsence, Auto Close Inactive Tabs, Chrome Memory Saver) treats closing as a loss to be softened with archives, whitelists and one-click restore — which is exactly why they never change behaviour. This extension takes the opposite stance: a tab is a commitment for *today only*. At a fixed cutoff every tab closes, unrecoverably from the extension's side. If a page mattered, the user bookmarked it deliberately during the day; if they didn't, it wasn't important. The loss is the feature.

## What Changes

- New browser extension (Chrome MV3 first; Firefox as a follow-up because it has strictly better APIs for this) that closes **all** tabs in **all** normal windows at one or more configured daily cutoff times.
- A "catch-up" rule so the cutoff cannot be dodged: if the browser was closed at cutoff and reopened later (including with "Continue where you left off" restoring the previous session), the missed sweep runs on startup before the user can touch anything.
- A manual "End day now" action (toolbar button + keyboard shortcut) that runs the same sweep on demand, without confirmation.
- A short, non-dismissable pre-cutoff notice (badge countdown + optional system notification) so the user has a window to bookmark what matters. **No snooze, no postpone, no undo.**
- Minimal settings page: cutoff times, pre-notice lead time, and a single opt-in "keep pinned tabs" exemption (off by default). No whitelists, no per-domain rules, no archive.
- Explicitly **not** included: any archive/session snapshot, "recently swept" list, restore button, or persistence of tab URLs/titles by the extension. Only aggregate counters (tabs closed per sweep, last sweep time) are stored.

## Capabilities

### New Capabilities
- `tab-sweep`: what one sweep does — which tabs/windows are affected, exemptions, the post-sweep state of the browser, and the guarantee that nothing is archived.
- `sweep-schedule`: when sweeps happen — cutoff times, timezone/DST behaviour, catch-up on browser startup and on late-firing alarms, idempotency (never sweep twice for the same cutoff).
- `sweep-controls`: user-facing surface — manual "End day now", pre-cutoff notice, settings, and the deliberately absent controls (no snooze/undo/restore).

### Modified Capabilities
<!-- none — greenfield project -->

## Impact

- New codebase: WebExtension (Manifest V3), TypeScript, service-worker background, options page, minimal action popup. No backend, no network access, no analytics.
- Browser permissions: `tabs`, `alarms`, `storage`, `notifications`; `sessions` only for the Firefox build (to forget closed tabs). No host permissions.
- User-visible risk: it deletes work-in-progress tabs by design. Onboarding must make the contract explicit once and never again.
- Distribution: unpacked/self-hosted first (personal use), Chrome Web Store later; MV2 is irrelevant (Web Store removes MV2 items on 2026-08-31).
