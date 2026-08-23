# Privacy policy — zero-tabbox

Last updated: 2026-08-22.

**zero-tabbox collects no data. Nothing you do with it is transmitted anywhere,
and nothing about the tabs it closes is retained.**

That is the whole policy. The rest of this document is the detail behind it, so
the claim can be checked rather than taken on faith.

## No data is collected or transmitted

The extension makes no network request of any kind. It declares no host
permissions, runs no content scripts, and contains no analytics, telemetry,
crash reporting, advertising or tracking code. Even its two typefaces ship
inside the package rather than being fetched, so there is no request to a font
host either. There is no server, no account, and no third party involved.

The same declaration is made machine-readably in the Firefox build, as
`browser_specific_settings.gecko.data_collection_permissions =
{"required": ["none"]}`, which Firefox shows you in the install prompt before
you install the extension.

## What is stored on your device

Everything the extension stores lives in your browser's local extension storage
(`storage.local`), on your device, under exactly six keys:

| Key | What it holds |
| --- | --- |
| `settings` | Your cutoff times, how many minutes of notice you want, three on/off switches, and which interface language you picked. |
| `accepted` | Whether you accepted the extension's terms. Nothing is scheduled until you have. |
| `lastAutoCutoffId` | Which scheduled cutoff last ran, so it does not run twice. |
| `lastSweep` | When the last close ran, how many tabs it closed, and whether they were bookmarked first. |
| `stats` | How many tabs have been closed since you installed it. |
| `version` | The storage format version. |

Nothing per-tab is ever written. No URL, no page title, no favicon, no tab
group, no window layout — not for the tabs it closes, and not for any other
tab. There is no archive, no history and no export, which is the point of the
extension rather than an oversight.

Uninstalling the extension removes this storage with it.

## What the extension reads, and why

To close your tabs it has to enumerate them, so it holds the `tabs` permission,
which gives it access to the titles and URLs of your open tabs. Those values
are used for three things, all in memory and all on your device:

1. counting how many tabs the next close would take, to show you the number;
2. writing bookmarks, when you press "Bookmark all tabs" or turn on "bookmark
   everything first";
3. closing the tabs.

They are not written to extension storage, not logged, and not sent anywhere.

## Bookmarks

Bookmarking is the only way to keep a page past a cutoff, and it happens only
when you ask for it — by pressing "Bookmark all tabs" in the popup, or by
turning on the "bookmark everything first" setting. Nothing is bookmarked
silently.

Bookmarks are written to a dated folder (`zero-tabbox / YYYY-MM-DD`) in **your
browser's own bookmarks**. They belong to you and to your browser, not to this
extension: the extension keeps no copy and no reference to them, never reads
them back, and cannot reopen the pages they point to. Deleting them is entirely
your business, in your browser's bookmark manager.

## Private and incognito windows

Browsers do not give extensions access to private browsing unless you switch it
on for that extension, and this extension does not ask you to. If you do switch
it on, private windows are closed under the same rules — but their tabs are
never bookmarked, because a bookmark would outlive the private session and
leave exactly the record a private window exists not to leave.

## Notifications

If the system notification is left on, one notification appears before each
cutoff, naming the time. It is generated locally by your browser, has no
buttons, and nothing is reported when it appears or is dismissed.

## Children

The extension is not directed at children and collects no data from anyone,
including children.

## Changes to this policy

If this ever changes — which would mean the extension had stopped being the
thing described here — the change will be published in this document with a new
date, and in the extension's store listings.

## Contact

Questions, or a claim in this document you think is wrong: open an issue at
<https://github.com/lavrovpy/zero-tabbox/issues>.
