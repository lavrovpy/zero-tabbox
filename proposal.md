## Why

Open tabs silently accumulate into a 100–200 tab backlog that is neither read nor discarded, and every existing "auto-close" tool (Tab Wrangler, Tabsence, Auto Close Inactive Tabs, Chrome Memory Saver) treats closing as a loss to be softened with archives, whitelists and one-click restore — which is exactly why they never change behaviour. This extension takes the opposite stance: a tab is a commitment for *today only*. At a fixed cutoff every tab closes, unrecoverably from the extension's side. If a page mattered, the user bookmarked it deliberately during the day; if they didn't, it wasn't important. The loss is the feature.

## What Changes

- New browser extension for Chrome and Firefox (WebExtension, Manifest V3, one shared codebase) that closes **all** tabs in **all** normal windows at one or more configured daily cutoff times. On Firefox the sweep also clears swept tabs from the browser's recently-closed list, closing the "Reopen closed tab" backdoor; on Chrome that backdoor is a documented limitation.
- A "catch-up" rule so the cutoff cannot be dodged: if the browser was closed at cutoff and reopened later (including with "Continue where you left off" restoring the previous session), the missed sweep runs on startup before the user can touch anything.
- A manual "End day now" action (toolbar button + keyboard shortcut) that runs the same sweep on demand, without confirmation.
- A short, non-dismissable pre-cutoff notice (badge countdown + optional system notification) so the user has a window to bookmark what matters. **No snooze, no postpone, no undo.**
- Minimal settings page: cutoff times, pre-notice lead time, and a single opt-in "keep pinned tabs" exemption (off by default). No whitelists, no per-domain rules, no archive.
- Private/incognito windows are untouched by default. If the user explicitly allows the extension in private browsing (the browser's own per-extension setting), sweeps treat private windows exactly like regular ones — same rules, same pinned exemption, nothing archived.
- Explicitly **not** included: any archive/session snapshot, "recently swept" list, restore button, or persistence of tab URLs/titles by the extension. Only aggregate counters (tabs closed per sweep, last sweep time) are stored.

## Capabilities

### New Capabilities
- `tab-sweep`: what one sweep does — which tabs/windows are affected, exemptions, the post-sweep state of the browser, and the guarantee that nothing is archived.
- `sweep-schedule`: when sweeps happen — cutoff times, timezone/DST behaviour, catch-up on browser startup and on late-firing alarms, idempotency (never sweep twice for the same cutoff).
- `sweep-controls`: user-facing surface — manual "End day now", pre-cutoff notice, settings, and the deliberately absent controls (no snooze/undo/restore).

### Modified Capabilities
<!-- none — greenfield project -->

## Impact

- New codebase: WebExtension (Manifest V3), TypeScript, non-persistent background (service worker on Chrome, event page on Firefox), options page, minimal action popup. UI is hand-written CSS on a shadcn-style design-token set with light and dark themes taken from the OS preference — no UI framework, no Tailwind, no theme setting. One codebase, per-browser manifest. No backend, no network access, no analytics.
- Browser permissions: `tabs`, `alarms`, `storage`, `notifications`; `sessions` only in the Firefox manifest (to forget closed tabs). No host permissions.
- User-visible risk: it deletes work-in-progress tabs by design. Onboarding must make the contract explicit once and never again.
- Distribution: personal use first — unpacked on Chrome, AMO-signed self-distribution on Firefox; Chrome Web Store / addons.mozilla.org listings later. MV2 is irrelevant (Web Store removes MV2 items on 2026-08-31).
