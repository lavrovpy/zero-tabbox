## Purpose

Defines the user-facing surface of the extension: the manual "End day now" trigger, the pre-cutoff notice, the settings that exist, and the controls that are deliberately absent so the forcing function cannot be softened.

## ADDED Requirements

### Requirement: Manual "End day now"
The extension SHALL provide an "End day now" action via the toolbar button and a configurable keyboard shortcut (default `Alt+Shift+E`, i.e. `Option+Shift+E` on macOS) that runs a sweep immediately, without a confirmation dialog.

#### Scenario: Toolbar action
- **WHEN** the user clicks "End day now" in the toolbar popup
- **THEN** a sweep runs immediately and the popup closes

#### Scenario: Keyboard shortcut
- **WHEN** the user presses the configured shortcut
- **THEN** a sweep runs immediately

### Requirement: Pre-cutoff notice
Starting N minutes before each cutoff (N configurable, default 10), the extension SHALL show a countdown in the toolbar badge (minutes remaining) and, if the user has enabled it, one system notification at N minutes stating the cutoff time. The settings page SHALL offer N as the fixed stops 0, 5, 10, 20, 30 and 60 minutes; any stored value from 0 to 60 SHALL remain valid. While the notice window is active, the popup's time-remaining SHALL switch to a per-second countdown rendered in the accent color. The notice SHALL NOT offer snooze, postpone, or cancel controls.

#### Scenario: Badge countdown
- **WHEN** the cutoff is 18:00, N is 10, and the time is 17:52
- **THEN** the toolbar badge shows `8`

#### Scenario: Notification has no actions
- **WHEN** the pre-cutoff notification is shown
- **THEN** it contains no action buttons and clicking it does nothing beyond dismissing it

#### Scenario: Notice disabled
- **WHEN** N is set to 0
- **THEN** no badge countdown and no notification are shown before the sweep

### Requirement: Post-sweep feedback is minimal
After a sweep the extension SHALL update the toolbar badge to show the number of tabs closed for at most 60 seconds, then clear it. No notification, popup, or new tab SHALL be opened to announce the sweep. If the user opens the popup within that same 60-second window, it SHALL show a "Day ended" summary — tabs closed, whether they were bookmarked first, and the next cutoff — instead of the live view, with a control returning to the live view; after the window the popup SHALL open on the live view again.

#### Scenario: Badge after sweep
- **WHEN** a sweep closes 37 tabs
- **THEN** the badge shows `37` and clears within 60 seconds

#### Scenario: Popup right after a sweep
- **WHEN** a sweep closed 37 bookmarked-first tabs less than 60 seconds ago and the user opens the popup
- **THEN** it shows "Day ended", `37` tabs closed, that they were bookmarked first, and the next cutoff — and "Back to the day" returns to the live view

### Requirement: Settings surface
The options page SHALL expose exactly: cutoff times (1–4, as removable chips with an "Add cutoff" affordance), the badge-countdown start (the fixed stops of "Pre-cutoff notice", with a plain-words summary such as "10 min before" or "no warning"), "system notification" on/off, "bookmark everything first" on/off, "keep pinned tabs" on/off, and read-only stats since install (lifetime tabs closed and tabs closed by the last sweep). Changes SHALL be saved without a separate "Save" step. The page header SHALL carry the standing contract sentence: at each cutoff every tab closes, nothing is saved, bookmark what matters.

#### Scenario: Add a second cutoff
- **WHEN** the user adds `13:00` to an existing `18:00` schedule
- **THEN** the schedule is persisted as `13:00, 18:00` and the next 13:00 sweep is armed

#### Scenario: Attempt a fifth cutoff
- **WHEN** four cutoffs are configured and the user tries to add another
- **THEN** the UI refuses and explains the limit is 4

#### Scenario: Remove the last cutoff
- **WHEN** one cutoff is configured and the user tries to remove it
- **THEN** the UI refuses and explains the schedule cannot be empty

#### Scenario: Pick a notice stop
- **WHEN** the user selects the `20` stop
- **THEN** the setting is persisted as 20 minutes, the summary reads "20 min before", and no separate Save step is needed

### Requirement: Bookmark escape hatch
The popup SHALL offer a "Bookmark all N tabs" action, where N is the number of at-risk tabs (the tabs the next sweep would close, honouring the keep-pinned setting). It SHALL write those tabs' titles and URLs to the browser's own bookmarks under a `zero-tabbox / YYYY-MM-DD` folder (dated with the local calendar day, appended to if it already exists) and then show a confirmation naming the folder. The options page SHALL offer a "bookmark everything first" setting (default off) that makes every sweep perform the same write before closing tabs; a failed write SHALL be logged and SHALL NOT prevent the sweep. The extension SHALL keep no reference to the created bookmarks beyond an aggregate "bookmarked first" flag on the last-sweep record, and SHALL NOT offer any UI that reads bookmarks back or reopens swept tabs.

#### Scenario: Bookmark all from the popup
- **WHEN** 47 tabs are at risk and the user clicks "Bookmark all 47 tabs" on 2026-08-21
- **THEN** 47 bookmarks are created under `zero-tabbox / 2026-08-21` and the popup confirms "Saved to bookmarks / zero-tabbox / 2026-08-21"

#### Scenario: Bookmark everything first
- **WHEN** "bookmark everything first" is enabled and the 18:00 sweep runs
- **THEN** the at-risk tabs are written to the dated folder before they are closed, and the day-ended summary says they were bookmarked first

#### Scenario: Bookmarking fails
- **WHEN** "bookmark everything first" is enabled and the bookmark write fails
- **THEN** the sweep still runs to completion and the failure is only logged

### Requirement: Visual design and theming
The popup and all extension pages SHALL share one stylesheet built on CSS custom properties (design tokens): the stone neutral and ember accent color ramps with semantic aliases (background, surface, border, three text levels, accent, success/danger), a single radius scale, and an accent-colored focus ring. All rules SHALL reference tokens rather than literal color values. Type SHALL use the two bundled faces — Geist for UI text and JetBrains Mono for numerals and labels, shipped with the extension so no network request is ever made for them — with times, countdowns and counters rendered in the mono face with tabular numerals. The UI SHALL support a light and a dark theme, selected automatically from the browser/OS preference via `prefers-color-scheme`, and SHALL declare `color-scheme: light dark` so browser-painted chrome (popup backdrop, form controls, scrollbars) matches the active theme. No in-extension theme setting SHALL be offered.

#### Scenario: Dark browser theme
- **WHEN** the browser or OS is set to a dark color scheme and the user opens the popup or options page
- **THEN** both render in the dark theme, with no light-themed flash before first paint and no white backdrop around the popup body

#### Scenario: Light browser theme
- **WHEN** the browser or OS is set to a light color scheme
- **THEN** both surfaces render in the light theme

#### Scenario: Theme changes while open
- **WHEN** the OS color scheme changes while the options page is open
- **THEN** the page switches theme without a reload

#### Scenario: No theme control
- **WHEN** the user opens the options page
- **THEN** no light/dark/system theme selector is present

#### Scenario: Tokens are the only source of color
- **WHEN** the stylesheet is inspected
- **THEN** color values appear only in the token definition blocks, and the dark theme is expressed solely as token overrides

### Requirement: Destructive action is visually distinct
The "End day now" button SHALL be styled with the solid accent (ember) role — the strongest visual weight in the popup, reserved for the actions that accept the sweep's consequence — and SHALL be visually distinct from any neutral or secondary control, in both themes. No other control in the popup or options page may use the solid accent fill (selected and on states use the soft accent tint). It SHALL NOT be the only affordance carrying meaning by color alone — its label SHALL state the action in words.

#### Scenario: Popup button styling
- **WHEN** the user opens the popup in either theme
- **THEN** "End day now" is the only solid-accent control and is labelled with text, not an icon alone

### Requirement: Accessible interaction states
Interactive controls SHALL have a visible keyboard focus indicator using the focus-ring token, SHALL be reachable and operable by keyboard alone, and text SHALL meet WCAG AA contrast (4.5:1 for body text, 3:1 for large text and UI boundaries) in both themes.

Any control rendered as an icon alone SHALL carry a text alternative naming its action, its decorative artwork SHALL be hidden from assistive technology, and its clickable area SHALL be padded beyond the drawn glyph. Only secondary navigation MAY be icon-only; the "End day now" action SHALL remain text-labelled (see "Destructive action is visually distinct").

#### Scenario: Keyboard-only use of the popup
- **WHEN** the user opens the popup and presses Tab
- **THEN** focus moves to "End day now" with a visible ring, and Enter runs the sweep

#### Scenario: Contrast in both themes
- **WHEN** the popup and options page are measured in light and in dark theme
- **THEN** all text and control boundaries meet the stated contrast ratios

#### Scenario: The settings gear announces itself
- **WHEN** a screen reader reaches the settings gear in the popup
- **THEN** it is announced as "Settings", and the gear artwork itself is not announced as a separate element

#### Scenario: The settings gear is reachable by keyboard
- **WHEN** the user tabs past "End day now"
- **THEN** focus moves to the settings gear with a visible ring, and Enter opens the options page

### Requirement: No softening controls
The extension SHALL NOT provide any of the following: pause/disable toggle, "skip today", snooze, undo/restore, archive view, whitelist, per-tab protection, or export of swept tabs. Turning the extension off requires the browser's own extension management page.

#### Scenario: Popup contents
- **WHEN** the user opens the toolbar popup outside the post-sweep window
- **THEN** it shows the at-risk tab count, the next cutoff time with its time-remaining, the "Bookmark all" action (or its saved confirmation), the "End day now" button, and an icon-only settings link (a gear) — nothing else

#### Scenario: Options page contents
- **WHEN** the user opens the options page
- **THEN** no pause, skip, snooze, or restore control is present

### Requirement: One-time onboarding states the contract
On first install the extension SHALL open a dedicated one-screen onboarding page, once. It SHALL state the first cutoff time in its headline, that bookmarks are the only way to keep a page, and the contract as numbered terms: every tab in every normal window is included, with no undo, snooze or per-tab exception; closing the browser does not dodge the cutoff; and no data is collected. It SHALL offer three actions: an accept button confirming the stated cutoff, a button leading to the settings page to pick a different time (which is not itself acceptance), and a plain-text decline that starts the browser's own uninstall confirmation. This page SHALL NOT be shown again automatically.

#### Scenario: First install
- **WHEN** the extension is installed for the first time
- **THEN** the onboarding page opens with the terms and "Every tab closes at 18:00" (the default cutoff) in the headline

#### Scenario: Pick a different time
- **WHEN** the user chooses "Pick a different time"
- **THEN** the same tab navigates to the settings page, which offers the same accept button until the contract is accepted

#### Scenario: Decline
- **WHEN** the user chooses the decline action
- **THEN** the browser's own uninstall confirmation opens; cancelling it leaves the page as it was

#### Scenario: Update
- **WHEN** the extension is updated to a new version
- **THEN** no page is opened automatically

### Requirement: No sweep before the contract is accepted
Until the user explicitly accepts the contract — the accept button on the onboarding page, or its equivalent on the settings page — the extension SHALL NOT run an automatic sweep and SHALL NOT arm any schedule alarm. Viewing the onboarding page SHALL NOT count as acceptance. Acceptance SHALL arm the schedule from that moment; cutoffs that elapsed before acceptance SHALL NOT be swept retroactively. An explicit "End day now" remains available before acceptance — the click is its own consent for that one sweep.

#### Scenario: Onboarding closed without accepting
- **WHEN** the extension is installed and the onboarding page is closed without pressing an accept button
- **THEN** no sweep runs at the next cutoff and no schedule alarm is armed

#### Scenario: Acceptance after a cutoff has elapsed
- **WHEN** the user accepts at 19:05 with an 18:00 cutoff
- **THEN** no sweep runs for the elapsed 18:00, and the next sweep is at the following day's 18:00
