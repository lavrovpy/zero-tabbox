## Purpose

Defines when sweeps happen: the configured daily cutoff times, how the browser being closed or asleep at cutoff is handled so the cutoff cannot be dodged, and the guarantee that each cutoff triggers at most one sweep.

## ADDED Requirements

### Requirement: One or more daily cutoff times
The extension SHALL let the user configure between 1 and 4 cutoff times per day (HH:MM, local time). Each cutoff SHALL trigger a sweep every day, including weekends, unless the user changes the schedule.

#### Scenario: Single cutoff
- **WHEN** the schedule is `18:00` and the local time reaches 18:00
- **THEN** a sweep runs

#### Scenario: Two cutoffs in one day
- **WHEN** the schedule is `13:00, 18:00`
- **THEN** a sweep runs at 13:00 and another at 18:00 on the same day

### Requirement: Default schedule
On first install the schedule SHALL default to a single cutoff at `18:00` local time and the pre-cutoff notice to 10 minutes.

#### Scenario: Fresh install
- **WHEN** the extension is installed and the user has not opened settings
- **THEN** a sweep runs at the next local 18:00

### Requirement: Cutoffs follow local wall-clock time
Cutoff times SHALL be interpreted in the device's current local timezone at the moment they are evaluated, so a `18:00` cutoff fires at 18:00 wall-clock after a timezone change or DST transition rather than at a fixed UTC instant.

#### Scenario: DST transition
- **WHEN** the schedule is `18:00` and clocks move forward overnight
- **THEN** the next sweep runs at 18:00 new local time

### Requirement: Missed cutoffs are caught up on startup
When the browser starts (including after being closed at cutoff, after a crash, or after the extension is enabled/updated), the extension SHALL determine whether any cutoff has elapsed since the last recorded automatic sweep; if so, it SHALL run a sweep immediately, before the user's restored session can be used, and SHALL run one follow-up pass shortly afterwards to catch tabs that session restore materialises late.

#### Scenario: Browser closed at cutoff, reopened next morning with session restore
- **WHEN** the browser was quit at 17:30 with 60 tabs, the cutoff is 18:00, and the browser is reopened at 09:00 the next day with "Continue where you left off" restoring those 60 tabs
- **THEN** a sweep runs on startup and the user is left with one clean window

#### Scenario: Browser closed and reopened before the cutoff
- **WHEN** the browser was quit at 15:00 and reopened at 16:00 with cutoff 18:00 and the last sweep recorded at 18:00 the previous day
- **THEN** no sweep runs on startup

#### Scenario: Multiple cutoffs missed
- **WHEN** the schedule is `13:00, 18:00`, the last sweep was yesterday 18:00, and the browser is first opened today at 20:00
- **THEN** exactly one catch-up sweep runs (not two)

#### Scenario: Session restore finishes after the startup sweep
- **WHEN** a catch-up sweep runs at startup while "Continue where you left off" is still restoring tabs, and more restored tabs appear within the next minute
- **THEN** a follow-up pass within about 60 seconds closes those tabs as part of the same catch-up

### Requirement: Late-firing timers still sweep
If the browser was running but the device was asleep or the timer was delayed at cutoff, the sweep SHALL run as soon as the timer fires or the extension next wakes, whichever is first.

#### Scenario: Laptop lid closed at cutoff
- **WHEN** the device sleeps from 17:50 to 08:30 with cutoff 18:00
- **THEN** a sweep runs shortly after the device wakes at 08:30

### Requirement: Each cutoff sweeps at most once
The extension SHALL record the identity of the last cutoff swept (date + cutoff time) and SHALL NOT run a second automatic sweep for the same cutoff, even if the timer fires again, the extension's background process restarts, or the browser restarts multiple times. The startup follow-up pass counts as part of the same catch-up sweep, not a second sweep.

#### Scenario: Timer fires twice
- **WHEN** the 18:00 sweep has completed and the timer event is delivered again at 18:00:45
- **THEN** no second sweep runs

#### Scenario: Restart after sweep
- **WHEN** the 18:00 sweep completed and the browser is restarted at 18:10
- **THEN** no catch-up sweep runs

### Requirement: Manual sweep does not replace scheduled cutoffs
A manual "End day now" sweep SHALL be recorded in the stats like any sweep, but SHALL NOT advance the automatic sweep marker: every configured cutoff still fires at its scheduled time regardless of intervening manual sweeps.

#### Scenario: Manual sweep before cutoff
- **WHEN** the user runs "End day now" at 16:30 with cutoff 18:00 and then opens 5 tabs
- **THEN** the 18:00 sweep still runs and closes those 5 tabs

### Requirement: Schedule changes take effect immediately
When the user edits cutoff times, the extension SHALL reschedule so that the next sweep honours the new times without a browser restart. Editing the schedule SHALL NOT trigger a retroactive sweep for a cutoff time that is already past at the moment of the edit.

#### Scenario: Cutoff moved earlier
- **WHEN** at 15:00 the user changes the cutoff from 18:00 to 16:00
- **THEN** a sweep runs at 16:00 today

#### Scenario: Cutoff moved to a time already past
- **WHEN** at 17:00 the user changes the cutoff from 18:00 to 16:00
- **THEN** no sweep runs immediately; the next sweep runs at 16:00 the following day
