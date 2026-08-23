# zero-tabbox

**Every tab closes at your cutoff. Nothing is saved.**

A Chrome and Firefox extension that closes all your tabs at configured times of
day. There is no archive, no undo, no restore, no whitelist, and no snooze. The
loss is the feature — a tab you did not bookmark was not worth keeping, and
knowing that in advance is what changes how you use tabs.

---

## The contract

This is the whole product. Read it before you install it.

At each cutoff, every tab in every normal window closes — regardless of focus,
audio, or tab group — and the browser is left with one clean window holding a
single new-tab page. Nothing about the closed tabs is stored, beyond
aggregates: when the last sweep ran, how many tabs it closed, whether they
were bookmarked first. The only way to keep a page is bookmarking it first,
via "Bookmark all" in the popup or the opt-in "bookmark everything first"
setting, which write the at-risk tabs to a dated `zero-tabbox` folder in
*your browser's* bookmarks — the extension keeps no reference to them and
never reads them back. There's no undo, archive, pause, snooze, or per-tab
protection; the only exemption is a global "keep pinned tabs" setting, off by
default.

A cutoff missed while the browser was shut, asleep, or crashed still sweeps at
the next start, plus a follow-up pass about 60 seconds later for tabs session
restore materialises late — and nothing above is armed until you accept the
contract, on the page that opens at install or on the settings page. "End day
now" works even before you accept, because clicking it is its own consent.

Defaults: one cutoff at `18:00` local time, 10 minutes of notice, system
notification on, keep-pinned off.

## What you get before the cutoff

Starting N minutes before each cutoff, the toolbar badge counts down the
minutes and — if you leave it on — one system notification fires at N minutes
naming the cutoff time. N is one of six fixed stops — 0, 5, 10, 20, 30, 60 —
and defaults to 10; the settings page offers nothing in between, though an
in-between value stored by an earlier version keeps working until you pick a
stop. The notification has no buttons. Setting N to 0 disables both.

After a sweep the badge shows the number of tabs closed for up to 60 seconds,
then clears. Nothing else announces it.

## Known backdoors

These are real and documented rather than fixed, because the extension APIs do
not allow fixing them. If you want the contract to hold absolutely, you have to
want it yourself.

- **Chrome's "Reopen closed tab" (`Cmd+Shift+T` / `Ctrl+Shift+T`).** Chrome's
  `chrome.sessions` API exposes only `getRecentlyClosed`, `restore` and
  `getDevices` — there is no way for an extension to clear Chrome's own
  recently-closed list. Swept tabs can therefore be reopened for the rest of the
  browser session. Restarting the browser after a sweep closes this window.
  **On Firefox this backdoor is closed**: the extension calls
  `sessions.forgetClosedTab` / `forgetClosedWindow` after every sweep, so swept
  tabs are absent from the recently-closed menu.
- **Browser history.** The extension never touches history — it holds no
  `history` permission and never will, since clearing your history is a much
  larger promise than closing your tabs. Anything you visited is still findable
  in `Ctrl+H`. What you lose is the *arrangement*: the 60 open tabs, not the
  record that you saw them.
- **Per-profile installs.** Extensions are scoped to one browser profile. A
  second profile (or a second browser) is untouched unless you install it there
  too. The extension cannot see, let alone sweep, another profile's tabs.
- **Private / incognito windows.** Left alone by default, because browsers do
  not give extensions access to private browsing unless you switch it on
  per-extension. If you do switch it on, private windows are swept under the
  same rules — with the one difference that a new-tab page is never created in a
  private window, and kept pinned private tabs stay in a private window.
- **Disabling the extension.** Nothing stops you. But the catch-up sweep runs
  when it comes back, so the cutoffs you skipped are not forgiven — the most
  recent missed one still fires. This is a habit tool, not a parental control.

## Install

Neither store listing exists yet; both flows below install a local build.

```bash
bun install
bun run build      # writes dist/chrome and dist/firefox
bun run package    # writes artifacts/zero-tabbox-<browser>-<version>.zip
```

### Chrome (unpacked)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/chrome` directory.

The unpacked install survives restarts. Requires Chrome 120 or newer.

To let it sweep private windows, open the extension's details and enable
**Allow in Incognito**. Leave it off if you want private windows untouched.

If `Alt+Shift+E` does nothing, another extension has claimed it — extension
shortcut collisions are silent, and the loser simply gets no shortcut. Remap at
`chrome://extensions/shortcuts`.

### Firefox (temporary install, for development)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `dist/firefox/manifest.json`.

Requires Firefox 140 or newer. A temporary add-on is removed when Firefox
closes, which makes it useful for trying the extension out and useless for
actually living with it — for that you need a signed build.

For a permanent Firefox install, or to publish either store listing, see
[`publishing.md`](publishing.md).

## Data collection

None. The Firefox manifest declares
`browser_specific_settings.gecko.data_collection_permissions = {"required":
["none"]}`, which Firefox surfaces in the install prompt, so the no-archive
guarantee is checkable *before* you install rather than only by reading storage
afterwards.

The extension declares no host permissions, runs no content scripts, and makes
no network request of any kind (even its two typefaces ship inside the
package). Its five permissions are `tabs` (enumerate and close them), `alarms`
(know when the cutoff is), `storage` (the settings and the counters),
`notifications` (the pre-cutoff notice), and `bookmarks` (the explicit
escape hatch — bookmarks are written only when you click "Bookmark all" or
enable "bookmark everything first", and they belong to your browser, not the
extension). Firefox adds `sessions`, which is what closes the
reopen-closed-tab backdoor.

Everything it stores lives in `storage.local` under exactly six keys:
`settings`, `lastAutoCutoffId`, `lastSweep`, `stats`, `accepted`, `version`.
Nothing per-tab, ever. That fixed list is what makes the contract auditable.

## Development

Requires Bun 1.3 or newer. See `package.json` for the full script list;
`bun run verify` runs typecheck, test, build, and lint in that order. The
exact version CI runs is pinned in `.bun-version` (read by
`oven-sh/setup-bun`), so bumping Bun is a one-line commit that CI verifies.
`bun run watch` uses recursive `fs.watch`, which is well supported on macOS
and Windows but historically patchy on Linux — if a save does not trigger a
rebuild there, re-run `bun run build`.

TypeScript, bundled with Bun.build. No framework, no Tailwind, no React — the UI
is three small pages (popup, options, onboarding) sharing one hand-written
stylesheet, `src/ui/theme.css`, in which every color is a design token. Light
and dark follow the OS via `prefers-color-scheme`; there is deliberately no
theme setting.

The tests cover the parts that are pure logic and would be miserable to verify
by hand — the cutoff arithmetic (including DST transitions and midnight wrap),
storage validation, the idempotency rules, and the badge. Anything that needs a
real browser — the sweep across several windows, pinned-tab consolidation,
private windows, the startup catch-up with session restore, theming — has to
be walked through by a person against the scenarios in the spec files.

### Specs

The behaviour is specified before it is implemented. `design.md` holds the
architecture decisions; `tab-sweep.spec.md`, `sweep-schedule.spec.md` and
`sweep-controls.spec.md` hold the requirements the code is answerable to. If a
change contradicts a spec, the spec is what gets changed first.

## License

MIT.
