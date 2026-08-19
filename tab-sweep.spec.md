## Purpose

Defines what a single sweep does to the browser: which tabs and windows are closed, the one permitted exemption, the state the browser is left in, and the guarantee that the extension keeps no recoverable copy of what it closed.

## ADDED Requirements

### Requirement: Sweep closes every tab in every normal window
A sweep SHALL close all tabs in all normal browser windows (ordinary browsing windows, as opposed to popup, installed-app, or developer-tools windows) belonging to the current browser profile, regardless of window focus, tab activity, audio state, tab group membership, or whether the tab is discarded/suspended.

#### Scenario: Multiple windows and tab groups
- **WHEN** a sweep runs while the profile has 3 normal windows containing 40 tabs, some in tab groups and some playing audio
- **THEN** all 40 tabs are closed and no window from before the sweep remains open

#### Scenario: Suspended (discarded) tabs
- **WHEN** a sweep runs and some tabs have been discarded by the browser's memory saver
- **THEN** those tabs are closed exactly like active tabs

### Requirement: Sweep leaves exactly one clean window
After closing tabs, a sweep SHALL leave the profile with exactly one normal (non-private) window, so the browser stays running and the user sees an empty state rather than an exited application. That window SHALL contain exactly one new-tab page — or, when the pinned-tab exemption applies, the kept pinned tabs (with a new-tab page added only if there are none).

#### Scenario: Browser had one window
- **WHEN** a sweep runs on a single window with 25 tabs
- **THEN** that window (or a replacement) remains open with a single new-tab page and zero other tabs

#### Scenario: Browser had several windows
- **WHEN** a sweep runs on 3 normal windows
- **THEN** exactly one normal window remains, containing a single new-tab page

### Requirement: Non-normal windows are out of scope
A sweep SHALL NOT close tabs in popup windows, installed web app (PWA) windows, developer-tools windows, or other special-purpose windows, and SHALL NOT touch private/incognito windows unless the user has allowed the extension to run in private browsing (a browser-level setting, off by default).

#### Scenario: Popup and app windows survive
- **WHEN** a sweep runs while a popup window and an installed PWA window are open
- **THEN** those windows and their tabs are left untouched

#### Scenario: Private window, access not granted
- **WHEN** a sweep runs while a private/incognito window is open and the user has not allowed the extension in private browsing
- **THEN** the private window is left untouched

### Requirement: Private windows follow the same rules when allowed
If the user has allowed the extension to run in private browsing, a sweep SHALL treat private windows exactly like normal windows: every tab in them is closed under the same rules and the same single pinned-tab exemption. Kept pinned tabs from private windows SHALL remain in a surviving private window and SHALL NOT be moved into a regular window (private tabs never mix with regular ones). A sweep SHALL NOT create a new-tab page in a private window: when nothing in a private window is kept, the window simply closes, and the clean-window guarantee is met by the regular window.

#### Scenario: Access granted
- **WHEN** the extension is allowed in private browsing and a sweep runs with 1 regular window (10 tabs) and 1 private window (5 tabs)
- **THEN** all 15 tabs are closed, the private window closes, and one clean regular window remains

#### Scenario: Pinned tabs in a private window
- **WHEN** the extension is allowed in private browsing, "keep pinned tabs" is enabled, and a sweep runs while a private window has 2 pinned tabs
- **THEN** the 2 pinned tabs survive, still pinned, in a private window — not moved into the surviving regular window

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
The extension SHALL NOT persist the URL, title, favicon, group, or any per-tab data of closed tabs to any storage (extension storage, bookmarks, history, files, or remote), and SHALL NOT expose any UI that reopens swept tabs. Where the browser allows extensions to clear its own recently-closed list (Firefox), the sweep SHALL also remove swept tabs from that list.

#### Scenario: Storage after a sweep
- **WHEN** a sweep has closed 40 tabs
- **THEN** extension storage contains only aggregate data (e.g. count of tabs closed, timestamp of the sweep) and no per-tab records

#### Scenario: Recently-closed list on Firefox
- **WHEN** a sweep closes tabs on Firefox
- **THEN** the swept tabs cannot be reopened via "Reopen closed tab" or the recently-closed-tabs menu

#### Scenario: No restore surface
- **WHEN** the user opens the extension popup or options page after a sweep
- **THEN** no list of swept tabs and no "restore"/"undo" control is presented

### Requirement: The extension declares that it collects no data
The Firefox manifest SHALL declare `browser_specific_settings.gecko.data_collection_permissions` with `required: ["none"]`, stating that the extension collects no user data. This declaration SHALL remain accurate: if any future change causes the extension to transmit, sync, or persist anything beyond the aggregate counters of `Sweep records only aggregate counters`, the declaration SHALL be updated before that change ships. The extension SHALL declare no host permissions and SHALL make no network requests.

Mozilla requires this key for all new Firefox extensions; `addons-linter` reports `MISSING_DATA_COLLECTION_PERMISSIONS` without it and AMO enforces it at signing. Firefox surfaces the declared value in the install prompt, which makes it the user-visible counterpart of the no-archive guarantee: the contract is checkable before install, not only by reading storage afterwards.

Chrome has no equivalent manifest key. The Chrome Web Store collects the same disclosure through its privacy-practices form at listing time, so the answers there SHALL match this declaration.

#### Scenario: Firefox install prompt
- **WHEN** a user installs the extension on Firefox
- **THEN** the browser reports that the extension collects no data

#### Scenario: Linting the Firefox build
- **WHEN** `web-ext lint` runs against the Firefox build
- **THEN** it reports no `MISSING_DATA_COLLECTION_PERMISSIONS` warning and the build lints with zero findings

#### Scenario: Declaration matches behaviour
- **WHEN** the extension's storage and network activity are inspected after a sweep
- **THEN** storage holds only the aggregate counters, and no request has been made to any remote host

### Requirement: Sweep is atomic from the user's perspective
A sweep SHALL close all in-scope tabs as one batch operation; if a tab cannot be closed (e.g. the page asks for confirmation before closing), the sweep SHALL still close every other tab and SHALL record the sweep as completed.

#### Scenario: A page blocks unload
- **WHEN** a sweep runs and one tab shows a "Leave site?" dialog
- **THEN** all other tabs are closed and the sweep is recorded as completed; the blocked tab is left for the user to resolve

### Requirement: Sweep records only aggregate counters
After each sweep the extension SHALL store the timestamp of the sweep and the number of tabs closed, and SHALL keep a running total of tabs closed since installation.

#### Scenario: Counters update
- **WHEN** a sweep closes 37 tabs
- **THEN** the "last sweep" timestamp is set to now, "last sweep closed" is 37, and the lifetime total increases by 37
