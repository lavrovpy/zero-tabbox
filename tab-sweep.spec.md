## Purpose

Defines what a single sweep does to the browser: which tabs and windows are closed, the one permitted exemption, the state the browser is left in, and the guarantee that the extension keeps no recoverable copy of what it closed.

## ADDED Requirements

### Requirement: Sweep closes every tab in every normal window
A sweep SHALL close all tabs in all windows of type `normal` belonging to the current browser profile, regardless of window focus, tab activity, audio state, tab group membership, or whether the tab is discarded/suspended.

#### Scenario: Multiple windows and tab groups
- **WHEN** a sweep runs while the profile has 3 normal windows containing 40 tabs, some in tab groups and some playing audio
- **THEN** all 40 tabs are closed and no window from before the sweep remains open

#### Scenario: Suspended (discarded) tabs
- **WHEN** a sweep runs and some tabs have been discarded by the browser's memory saver
- **THEN** those tabs are closed exactly like active tabs

### Requirement: Sweep leaves exactly one clean window
After closing tabs, a sweep SHALL leave the profile with exactly one normal window, so the browser stays running and the user sees an empty state rather than an exited application. That window SHALL contain exactly one new-tab page — or, when the pinned-tab exemption applies, the kept pinned tabs (with a new-tab page added only if there are none).

#### Scenario: Browser had one window
- **WHEN** a sweep runs on a single window with 25 tabs
- **THEN** that window (or a replacement) remains open with a single new-tab page and zero other tabs

#### Scenario: Browser had several windows
- **WHEN** a sweep runs on 3 normal windows
- **THEN** exactly one normal window remains, containing a single new-tab page

### Requirement: Non-normal windows are out of scope
A sweep SHALL NOT close tabs in windows of type `popup`, `app`, `devtools`, or `panel`, and SHALL NOT touch incognito windows unless the user has explicitly allowed the extension in incognito.

#### Scenario: Popup and app windows survive
- **WHEN** a sweep runs while a `popup` window and an installed PWA window are open
- **THEN** those windows and their tabs are left untouched

#### Scenario: Incognito not allowed
- **WHEN** a sweep runs, the extension is not allowed in incognito, and an incognito window is open
- **THEN** the incognito window is left untouched

### Requirement: Pinned tabs are closed unless explicitly exempted
By default a sweep SHALL close pinned tabs. If and only if the user has enabled the "keep pinned tabs" setting, a sweep SHALL keep every pinned tab from every normal window open: pinned tabs from non-surviving windows are moved into the surviving window and remain pinned, and the surviving window gains a new-tab page only if it would otherwise be empty.

#### Scenario: Default behaviour
- **WHEN** "keep pinned tabs" is disabled and a sweep runs on a window with 3 pinned and 10 unpinned tabs
- **THEN** all 13 tabs are closed

#### Scenario: Exemption enabled
- **WHEN** "keep pinned tabs" is enabled and a sweep runs on a window with 3 pinned and 10 unpinned tabs
- **THEN** the 10 unpinned tabs are closed and the 3 pinned tabs remain in the surviving window, with no additional new-tab page

#### Scenario: Pinned tabs spread across windows
- **WHEN** "keep pinned tabs" is enabled and a sweep runs on 2 normal windows, one with 2 pinned tabs and one with 1 pinned tab
- **THEN** exactly one window survives containing all 3 pinned tabs (still pinned) and no new-tab page is added

### Requirement: No other exemptions exist
A sweep SHALL NOT support whitelists, per-domain rules, per-tab "protect" flags, audio-tab protection, or any exemption other than the pinned-tab setting.

#### Scenario: Audible tab
- **WHEN** a sweep runs while a tab is playing audio or hosting a video call
- **THEN** that tab is closed like any other

#### Scenario: Extension's own pages
- **WHEN** a sweep runs while the extension's options page is open in a tab
- **THEN** that tab is closed like any other

### Requirement: Sweep does not create a recoverable archive
The extension SHALL NOT persist the URL, title, favicon, group, or any per-tab data of closed tabs to any storage (extension storage, bookmarks, history, files, or remote), and SHALL NOT expose any UI that reopens swept tabs.

#### Scenario: Storage after a sweep
- **WHEN** a sweep has closed 40 tabs
- **THEN** extension storage contains only aggregate data (e.g. count of tabs closed, timestamp of the sweep) and no per-tab records

#### Scenario: No restore surface
- **WHEN** the user opens the extension popup or options page after a sweep
- **THEN** no list of swept tabs and no "restore"/"undo" control is presented

### Requirement: Sweep is atomic from the user's perspective
A sweep SHALL close all in-scope tabs as one batch operation; if a tab cannot be closed (e.g. a `beforeunload` prompt is shown), the sweep SHALL still close every other tab and SHALL record the sweep as completed.

#### Scenario: A page blocks unload
- **WHEN** a sweep runs and one tab shows a "Leave site?" dialog
- **THEN** all other tabs are closed and the sweep is recorded as completed; the blocked tab is left for the user to resolve

### Requirement: Sweep records only aggregate counters
After each sweep the extension SHALL store the timestamp of the sweep and the number of tabs closed, and SHALL keep a running total of tabs closed since installation.

#### Scenario: Counters update
- **WHEN** a sweep closes 37 tabs
- **THEN** the "last sweep" timestamp is set to now, "last sweep closed" is 37, and the lifetime total increases by 37
