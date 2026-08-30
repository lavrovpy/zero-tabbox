# Store compliance audit

Audit of `zero-tabbox` against the **Chrome Web Store program policies** and the
**Mozilla add-on policies (AMO)**, re-run on 2026-08-23 against
`claude/extension-store-guidelines-781cr3` rebased onto `main` at `1884ff8` —
i.e. after localization (`_locales/en`, `_locales/uk`, `src/i18n.ts`) landed.

**Verdict: nothing in the code, the manifests or the build output violates
either store's policies.** Both packages are publishable as they stand. What is
missing is submission paperwork — a hosted privacy policy, the Chrome privacy
practices answers, AMO source-code build instructions and listing screenshots —
none of which is a code change. Sections 4 and 5 supply the paperwork verbatim.

Evidence for every ✅ below was produced by running the project's own gates:
`bun run typecheck`, `bun run test` (8 files, all pass), `bun run build`,
`bunx web-ext lint --source-dir dist/firefox` in both `--self-hosted` and
listed mode (0 errors, 0 warnings, 0 notices in each), plus a static sweep of
`src/` for remote-code patterns and a full inventory of the extension APIs the
code actually calls.

---

## 1. The permission ledger

Every API the source calls, and the manifest key that authorises it. This table
is the backing evidence for "minimum permissions" on both stores and for the
per-permission justifications in section 4.

| Declared | Called by | Where |
| --- | --- | --- |
| `tabs` | `tabs.remove`, `tabs.create`, `tabs.move`, `tabs.update`, `tabs.get`, `tabs.getCurrent`, `windows.getAll({populate:true})`, `windows.create` | `sweep.ts`, `bookmarks.ts`, `background.ts`, `ui/onboarding.ts` |
| `alarms` | `alarms.create`, `alarms.getAll`, `alarms.clear`, `alarms.onAlarm` | `reconcile.ts`, `platform.ts`, `background.ts` |
| `storage` | `storage.local.get/set`, `storage.onChanged` | `storage.ts`, `background.ts`, `ui/*` |
| `notifications` | `notifications.create` | `badge.ts` |
| `bookmarks` | `bookmarks.search`, `bookmarks.create` | `bookmarks.ts` |
| `sessions` *(Firefox only)* | `sessions.getRecentlyClosed`, `forgetClosedTab`, `forgetClosedWindow` | `platform.ts` |

Used without needing a permission, correctly:

- `action.setBadgeText` — authorised by the `action` manifest key.
- `commands.onCommand` — authorised by the `commands` manifest key.
- `runtime.*` — never permission-gated.
- `i18n.getUILanguage()` (via `i18n.ts`'s `browserUiLanguage`) — the `i18n` API
  has never required a permission on either platform. Note what `i18n.ts` does
  *not* do: UI strings are resolved from catalogs **imported at build time**
  (`import enMessages from '../_locales/en/messages.json'`), not fetched at
  runtime and not routed through `chrome.i18n.getMessage()`. That is what keeps
  the no-remote-code guarantee true after localization — there is no request to
  load a catalog, because there is no request at all.
- **`management.uninstallSelf`** (`ui/onboarding.ts`, the decline button) —
  `uninstallSelf()` and `getSelf()` are the two `management` methods that do
  **not** require the `management` permission, on Chrome and on Firefox alike,
  because they cannot touch another extension. Declaring `management` here
  would have been an over-request and a review flag; not declaring it is right.

**No permission is declared that the code does not call, and no API is called
that the manifest does not authorise.** There are no `host_permissions`, no
`content_scripts`, no `<all_urls>`, and no optional permissions. CI already
asserts the absence of `host_permissions` on the Chrome manifest.

---

## 2. Chrome Web Store

| Policy | Status | Evidence |
| --- | --- | --- |
| **Single purpose** — narrow and easy to understand | ✅ | "Close every open tab at times of day the user schedules." Every module serves it; there is no second feature. |
| **Minimum permissions** | ✅ | Section 1. Five permissions, all exercised, none broad. |
| **No remote code** (MV3 hard ban) | ✅ | Zero matches across `src/` for `eval(`, `new Function`, `document.write`, dynamic `import()`, `fetch`, `XMLHttpRequest`, `WebSocket`. No remote `<script>`, stylesheet or font — both typefaces ship as `.woff2` inside the package. Bundled with `minify: false`, `sourcemap: 'none'`. |
| **No obfuscation** | ✅ | Bundler output is a plain unminified IIFE with original identifiers. |
| **Deceptive installation / unexpected behavior** | ✅ | The `accepted` gate in `reconcile.ts` means no alarm is armed and no automatic sweep runs until the user presses "I understand" on `ui/onboarding.html`, which states the whole contract including "no undo". |
| **User data — Limited Use** | ✅ | Nothing is transmitted anywhere. `storage.local` holds exactly six keys (`version`, `settings`, `lastAutoCutoffId`, `lastSweep`, `stats`, `accepted`); nothing per-tab is ever written. Bookmarks are written to *the browser's* bookmark tree on explicit user action and never read back. |
| **Content Security Policy** | ✅ | No `content_security_policy` override; the default MV3 policy applies. No inline `<script>` or inline event handlers in any of the three HTML pages — each loads one external `.js`. No `innerHTML`/`outerHTML` anywhere. |
| **Manifest field limits** | ✅ | `name` 11 chars (limit 75); `version` `0.1.0` is a valid 1–4 part dotted integer. `description` is now the placeholder `__MSG_extDescription__`, which the browser substitutes — the limit applies to the *resolved* string, and both catalogs clear it: en 59 chars, uk 79 chars (limit 132). |
| **Icons** | ✅ | 16/32/48/128 present and dimensionally correct; 128×128 is the store-required size. |
| **Keyboard commands** | ✅ | One command; `Alt+Shift+E` is a legal combination. Note that a collision with another extension is silent — the README already documents `chrome://extensions/shortcuts`. |
| **Localization** | ✅ | `default_locale: "en"` with `_locales/en` and `_locales/uk` shipped in both packages. The placeholders (`__MSG_extDescription__`, `__MSG_commandEndDayNow__`) resolve in both catalogs, so no locale renders a raw `__MSG_*` token. Plural categories differ correctly per language (en `one`/`other`, uk `one`/`few`/`many`), which is why the catalogs are not key-for-key identical. See L1 for the listing-side consequence. |
| **Package hygiene** | ✅ | `scripts/package.mjs` zips from inside `dist/<browser>` so `manifest.json` sits at the archive root, strips extra file attributes (`-X`) and excludes `*.DS_Store`, `__MACOSX/*` and `*.map`. 512 KB per package, far under any limit. |
| **Privacy policy URL** | ⚠️ Missing | The store requires a publicly reachable privacy policy linked from the dashboard. None existed; `PRIVACY.md` now supplies the text — it still has to be hosted and the URL pasted into the dashboard. |
| **Privacy practices tab** | ⚠️ Not prepared | Every item must supply a single-purpose statement, a justification per permission, and the data-collection disclosure + limited-use certification before it can be published or updated. Answers are drafted in section 4. |
| **Listing assets** | ⚠️ Partly | All five 1280×800 screenshots are committed under `store/screenshots/` and current, generated by `store/capture.mjs` + `store/compose.mjs` from the real extension (see `store/README.md`). The 440×280 promo tile is in `store/promo/`, and the description, category and support URL are in `store/listing.md`. |

### Chrome findings

**C1 — Privacy policy is required, and the 2026 update makes it load-bearing.**
Google's policy refresh took effect 1 August 2026: data collected must be
strictly necessary to the disclosed single purpose, disclosures must be
complete, and reviewers now cross-check the Privacy tab against what the
extension actually does. zero-tabbox is the easy case — it collects nothing —
but "collects nothing" still has to be *stated*, in a hosted policy and on the
Privacy tab, and the statement has to match the Firefox manifest's `none`.
`PRIVACY.md` is written so both answers are the same sentence.

**C2 — `tabs` reads URLs, so answer the data question deliberately.** The
`tabs` permission exposes tab titles and URLs, which fall in the store's
"web history"-shaped data category, and `bookmarks.ts` does read them. Under
the store's definitions *collection* means handling data **off** the user's
device; this extension never transmits, so the honest answer is "does not
collect", and the three limited-use certifications can be checked in good
faith. Say why in the justification field rather than leaving a reviewer to
infer it — section 4 does.

**C3 — Expect review friction from the destructive design, and pre-empt it.**
An extension that requests `tabs`, claims incognito compatibility and then
closes every tab with no undo is a shape reviewers are trained to be suspicious
of. Nothing here breaks a policy, but the reviewer notes should lead with the
consent gate (nothing is armed until `accepted` is written) and with the fact
that no data leaves the machine. This is a presentation risk, not a compliance
defect.

**C4 — Consider `1.0.0` for the first listing.** `0.1.0` is accepted by the
store, but a 0.x version on a public listing reads as pre-release. Cosmetic.

**C5 — Fixed.** A 12-hour browser UI language used to clip the cutoff chips to
`06:00 P`. `.chip-time` no longer carries a fixed width, so the control sizes
itself to whatever string its host renders; `sweep-controls.spec.md` carries
the requirement and `store/README.md` has the mechanism. Never a policy
violation, and not a listing problem either.

Verified on a host that actually formats the control in 12-hour, which is the
case the fix exists for: the chip measures 74px with `scrollWidth ==
clientWidth`, i.e. nothing to clip. The committed `03-options.png` is the
24-hour render, so the shot is not the evidence — the measurement is.

**L1 — Shipping Ukrainian strings does not give you a Ukrainian listing.**
`_locales/uk` localizes the *extension*: the install prompt, the manifest
description on `chrome://extensions`, and the UI. It does not localize the
*store listing* — the title, detailed description, screenshots and promo text
a shopper reads. Both stores keep listing copy in the dashboard, separately
from the package: Chrome under the listing's language tabs, AMO under its own
per-locale listing fields. So a Ukrainian speaker currently finds an
English-only listing that installs a Ukrainian extension. Not a policy breach —
just value already paid for and not collected. If a Ukrainian listing is
wanted, the copy in section 4 and the captions in `store/README.md` are what
need translating, and `store/capture.mjs` can regenerate the screenshots
against `locale: 'uk'` for a localized set.

---

## 3. Mozilla AMO

| Policy | Status | Evidence |
| --- | --- | --- |
| **addons-linter** | ✅ | 0 errors, 0 warnings, 0 notices — in `--self-hosted` mode *and* in listed mode. CI runs the `--self-hosted` pass with `--warnings-as-errors`; the listed-mode run was manual. |
| **Data collection consent** | ✅ | `browser_specific_settings.gecko.data_collection_permissions = {"required":["none"]}`. Mandatory for new extensions since 3 November 2025 and being extended to all extensions through 2026; `"none"` is exclusive and is correctly alone, and `has_previous_consent` is correctly absent. The declaration is accurate — see section 1. |
| **No obfuscated code** | ✅ | Unminified, original identifiers. Obfuscation is a blockable offence on AMO whether listed or self-distributed; this is nowhere near it. |
| **No remote code** | ✅ | Same sweep as Chrome. Fonts bundled. |
| **Minimum permissions / no surprises** | ✅ | Section 1. `sessions` is Firefox-only and is genuinely used, to clear the recently-closed list after a sweep. |
| **Add-on ID and versions** | ✅ | `zero-tabbox@lavrov.dev` is explicit, as MV3 submissions require; `strict_min_version` 140.0, Android 142.0 (the floor at which `data_collection_permissions` is supported on Android, which is why the separate key is needed). |
| **`management.uninstallSelf`** | ✅ | Permission-free on Firefox as on Chrome. |
| **Source code submission** | ⚠️ Required | See F1. |
| **Reproducible build from official package managers** | ⚠️ Partly | See F2. |
| **Android compatibility claim** | ⚠️ Unverified | See F3. |

### Firefox findings

**F1 — AMO source-code submission is mandatory here, and is not optional
paperwork.** Mozilla's rule is that reviewers must be able to read the code
that ships. Transpiled, minified *or otherwise machine-generated* code is
allowed only if a copy of the pre-build source is submitted along with
instructions to reproduce the build. `Bun.build` is a module bundler, and the
bundler case is called out by name in Mozilla's guidance, so the rule applies
even though `minify: false` keeps the output readable. Submitting only
`dist/firefox` will get the review bounced. Section 5 is the reviewer note to
paste at submission.

One thing works strongly in this project's favour: **the build is
byte-reproducible.** Building twice from a clean checkout produced identical
SHA-256 hashes for every file in `dist/`. A reviewer can therefore verify the
uploaded package against a build of the source exactly, which is the smoothest
possible path through source-code review.

**F2 — Pin and document how a reviewer installs Bun itself.** Mozilla requires
that every build dependency is either bundled in the source archive or fetched
through an official package manager, and rejects unmaintained tooling. npm
dependencies are fine: `bun.lock` is committed and `bun install
--frozen-lockfile` restores them from the npm registry. But **Bun**, the build
tool, is not covered — `package.json` says `"bun": ">=1.3"` and `.bun-version`
(currently `1.3.14`) is documented as a CI input. Give the reviewer one exact,
official-package-manager command: `npm install -g bun@1.3.14`, matching
`.bun-version`. Section 5 does this. Nothing in the build needs to change; the
gap is purely in what the submission tells the reviewer.

**F3 — `gecko_android` claims Android support that has not been verified.**
Declaring `gecko_android.strict_min_version` puts the add-on forward as
Android-compatible, which affects the listing and what reviewers test. Two
declared surfaces are doubtful there: `commands` (Firefox for Android has no
keyboard shortcuts, so "End day now" via `Alt+Shift+E` is unreachable) and
`sessions` (the recently-closed backdoor may simply not close). The code
degrades safely — `platform.ts` guards with `if (!sessions?.getRecentlyClosed)
return;` and never throws — so this is a listing-accuracy question, not a
policy breach. Either walk the manual matrix in `tasks.md` 7.1 on Firefox for
Android, or drop `gecko_android` until someone has.

---

## 4. Chrome Web Store privacy practices — answers to submit

Paste into the Privacy practices tab of the developer dashboard.

**Single purpose**

> zero-tabbox closes every open tab at times of day the user schedules. That is
> the extension's only function. It shows a countdown badge before each
> scheduled time, offers to bookmark the open tabs first, and does nothing
> else. No scheduled close runs until the user has accepted the terms on the
> page shown at install; the manual "End day now" button closes tabs when
> pressed, which is what pressing it asks for. The interface is available in
> English and Ukrainian; the language setting changes only which words are
> shown, never what closes or when.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `tabs` | Enumerating the open tabs and closing them is the extension's only function. Titles and URLs are read solely to write bookmarks when the user asks for them, and to display a count of tabs at risk. Neither is stored by the extension or sent anywhere. |
| `alarms` | Waking the background at each scheduled cutoff, and at the user's chosen notice lead time before it (0–60 minutes, 10 by default) to start the countdown badge, which then refreshes once a minute until the cutoff. |
| `storage` | `storage.local` holds the user's settings (cutoff times, notice lead time, three toggles, interface language), the aggregate counters shown on the settings page, and the flag recording that the user accepted the terms. Six keys, nothing per-tab. |
| `notifications` | One system notification before each scheduled close, so the user can bookmark anything they need. It has no buttons and no click action. |
| `bookmarks` | The extension's only way to keep a page: "Bookmark all tabs" in the popup, and the opt-in "bookmark everything first" setting, write the open tabs to a dated folder in the user's own bookmarks. Bookmarks are only ever written, never read back, and only on explicit user action. |

**Data disclosure** — check *does not collect user data*, and check all three
limited-use certifications. Justification if a free-text field is offered:

> The extension makes no network request of any kind and has no host
> permissions or content scripts. Tab titles and URLs are read in memory only,
> to close tabs and to write bookmarks the user asked for, and are never
> stored by the extension or transmitted off the device. The same declaration
> is made machine-readably in the Firefox build as
> `data_collection_permissions: {"required": ["none"]}`.

**Privacy policy URL** — host `PRIVACY.md` publicly and link it here.

---

## 5. AMO submission — reviewer notes

Upload `artifacts/zero-tabbox-firefox-<version>.zip` as the add-on, upload a
source archive of this repository (excluding `node_modules/`, `dist/` and
`artifacts/`), and paste the following as the notes to the reviewer.

> **Why source is attached:** the extension is bundled with `Bun.build`
> (a module bundler), so `background.js` and `ui/*.js` in the package are
> generated files. The sources are TypeScript under `src/`. Nothing is
> minified or obfuscated — `build.mjs` sets `minify: false` and
> `sourcemap: 'none'`.
>
> **Build environment:** any OS with Node.js and npm. Bun is the only build
> tool and is installed from npm.
>
> ```
> npm install -g bun@1.3.14     # the version pinned in .bun-version
> bun install --frozen-lockfile # restores exactly bun.lock, from npm
> bun run build:firefox         # writes dist/firefox
> ```
>
> **The build is byte-reproducible.** `dist/firefox` will match the uploaded
> package file for file; you can verify with
> `find dist/firefox -type f -exec sha256sum {} \;`.
>
> **Full verification** — typecheck, unit tests, both browser builds, and
> addons-linter with warnings treated as errors:
>
> ```
> bun run verify
> ```
>
> **What it does:** closes every tab in every normal window at times of day the
> user configures. There is no undo, by design; the terms are stated on a page
> opened at install and no schedule is armed until the user accepts them
> (`accepted` in `storage.local`, enforced in `src/reconcile.ts`).
>
> **Data:** none collected or transmitted. No host permissions, no content
> scripts, no network request of any kind — the two bundled typefaces are the
> only reason there are any assets at all. Declared as
> `data_collection_permissions: {"required": ["none"]}`.
>
> **`management.uninstallSelf`** is called from the decline button on the
> onboarding page. It is one of the two `management` methods that require no
> permission, which is why `management` is not declared.

---

## 6. What is left to do before either listing

1. Host `PRIVACY.md` at a public URL (GitHub renders it; a Pages URL is
   tidier) and link it in both dashboards. *(C1)*
2. Fill the Chrome privacy practices tab with section 4. *(C1, C2)*
3. Attach source + section 5's reviewer notes to the AMO submission. *(F1, F2)*
4. ~~Produce the 440×280 small promo tile, the detailed description, category
   and support contact.~~ Done: `store/promo/small-tile-440x280.png` and
   `store/listing.md`. *(Chrome listing)*
5. Decide whether the store listings get a Ukrainian translation, now that the
   extension has one. *(L1)*
6. Decide on `gecko_android`: verify on Firefox for Android, or drop it. *(F3)*
7. Optional: bump to `1.0.0` for a first public listing. *(C4)*

Items 1–5 are submission artifacts. Item 6 is the only one that touches the
manifest, and only if the decision is to drop the claim.
