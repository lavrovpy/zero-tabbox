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
Starting N minutes before each cutoff (N configurable, default 10, allowed range 0–60), the extension SHALL show a countdown in the toolbar badge (minutes remaining) and, if the user has enabled it, one system notification at N minutes stating the cutoff time. The notice SHALL NOT offer snooze, postpone, or cancel controls.

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
After a sweep the extension SHALL update the toolbar badge to show the number of tabs closed for at most 60 seconds, then clear it. No notification, popup, or new tab SHALL be opened to announce the sweep.

#### Scenario: Badge after sweep
- **WHEN** a sweep closes 37 tabs
- **THEN** the badge shows `37` and clears within 60 seconds

### Requirement: Settings surface
The options page SHALL expose exactly: cutoff times (1–4), pre-notice minutes, "system notification" on/off, "keep pinned tabs" on/off, and read-only stats (last sweep time, tabs closed last sweep, lifetime total). Changes SHALL be saved without a separate "Save" step.

#### Scenario: Add a second cutoff
- **WHEN** the user adds `13:00` to an existing `18:00` schedule
- **THEN** the schedule is persisted as `13:00, 18:00` and the next 13:00 sweep is armed

#### Scenario: Attempt a fifth cutoff
- **WHEN** four cutoffs are configured and the user tries to add another
- **THEN** the UI refuses and explains the limit is 4

### Requirement: Visual design and theming
The popup and options page SHALL share one stylesheet built on CSS custom properties (design tokens) covering surface, text, border, focus-ring, primary and destructive roles, plus a single radius scale. All rules SHALL reference tokens rather than literal color values. The UI SHALL support a light and a dark theme, selected automatically from the browser/OS preference via `prefers-color-scheme`, and SHALL declare `color-scheme: light dark` so browser-painted chrome (popup backdrop, form controls, scrollbars) matches the active theme. No in-extension theme setting SHALL be offered.

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
The "End day now" button SHALL be styled with the destructive token role, visually distinct from any neutral or secondary control, in both themes. It SHALL NOT be the only affordance carrying meaning by color alone — its label SHALL state the action in words.

#### Scenario: Popup button styling
- **WHEN** the user opens the popup in either theme
- **THEN** "End day now" is rendered in the destructive style and labelled with text, not an icon alone

### Requirement: Accessible interaction states
Interactive controls SHALL have a visible keyboard focus indicator using the focus-ring token, SHALL be reachable and operable by keyboard alone, and text SHALL meet WCAG AA contrast (4.5:1 for body text, 3:1 for large text and UI boundaries) in both themes.

#### Scenario: Keyboard-only use of the popup
- **WHEN** the user opens the popup and presses Tab
- **THEN** focus moves to "End day now" with a visible ring, and Enter runs the sweep

#### Scenario: Contrast in both themes
- **WHEN** the popup and options page are measured in light and in dark theme
- **THEN** all text and control boundaries meet the stated contrast ratios

### Requirement: No softening controls
The extension SHALL NOT provide any of the following: pause/disable toggle, "skip today", snooze, undo/restore, archive view, whitelist, per-tab protection, or export of swept tabs. Turning the extension off requires the browser's own extension management page.

#### Scenario: Popup contents
- **WHEN** the user opens the toolbar popup
- **THEN** it shows the next cutoff time, the "End day now" button, and a link to settings — nothing else

#### Scenario: Options page contents
- **WHEN** the user opens the options page
- **THEN** no pause, skip, snooze, or restore control is present

### Requirement: One-time onboarding states the contract
On first install the extension SHALL open its options page once, with a short statement that all tabs will close at the cutoff, that nothing is saved, and that bookmarks are the only way to keep a page. This page SHALL NOT be shown again automatically.

#### Scenario: First install
- **WHEN** the extension is installed for the first time
- **THEN** the options page opens with the contract statement and the default `18:00` cutoff pre-filled

#### Scenario: Update
- **WHEN** the extension is updated to a new version
- **THEN** no page is opened automatically
