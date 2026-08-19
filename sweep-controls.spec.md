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
