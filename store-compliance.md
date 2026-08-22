# Store compliance audit

Audit of `zero-tabbox` against the **Chrome Web Store program policies** and the
**Mozilla add-on policies (AMO)**, run against commit `HEAD` of
`claude/extension-store-guidelines-781cr3` on 2026-08-22.

**Verdict: nothing in the code, the manifests or the build output violates
either store's policies.** Both packages are publishable as they stand. What is
missing is submission paperwork — a hosted privacy policy, the Chrome privacy
practices answers, AMO source-code build instructions and listing screenshots —
none of which is a code change. Sections 4 and 5 supply the paperwork verbatim.

Evidence for every ✅ below was produced by running the project's own gates:
`bun run typecheck`, `bun run test` (6 files, all pass), `bun run build`,
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
| **Deceptive installation / unexpected behavior** | ✅ | The `accepted` gate in `reconcile.ts` means no alarm is armed and no automatic sweep runs until the user presses "I understand" on `ui/onboarding.html`, which states the whole contract including "no undo". Nothing destructive precedes consent. |
| **User data — Limited Use** | ✅ | Nothing is transmitted anywhere. `storage.local` holds exactly six keys (`version`, `settings`, `lastAutoCutoffId`, `lastSweep`, `stats`, `accepted`); nothing per-tab is ever written. Bookmarks are written to *the browser's* bookmark tree on explicit user action and never read back. |
| **Content Security Policy** | ✅ | No `content_security_policy` override; the default MV3 policy applies. No inline `<script>` or inline event handlers in any of the three HTML pages — each loads one external `.js`. No `innerHTML`/`outerHTML` anywhere. |
| **Manifest field limits** | ✅ | `name` 11 chars (limit 75), `description` 59 chars (limit 132), `version` `0.1.0` is a valid 1–4 part dotted integer. |
| **Icons** | ✅ | 16/32/48/128 present and dimensionally correct; 128×128 is the store-required size. |
| **Keyboard commands** | ✅ | One command; `Alt+Shift+E` is a legal combination. Note that a collision with another extension is silent — the README already documents `chrome://extensions/shortcuts`. |
| **Package hygiene** | ✅ | `scripts/package.mjs` zips from inside `dist/<browser>` so `manifest.json` sits at the archive root, strips extra file attributes (`-X`) and excludes `*.DS_Store`, `__MACOSX/*` and `*.map`. 512 KB per package, far under any limit. |
| **Privacy policy URL** | ⚠️ Missing | The store requires a publicly reachable privacy policy linked from the dashboard. None existed; `PRIVACY.md` now supplies the text — it still has to be hosted and the URL pasted into the dashboard. |
| **Privacy practices tab** | ⚠️ Not prepared | Every item must supply a single-purpose statement, a justification per permission, and the data-collection disclosure + limited-use certification before it can be published or updated. Answers are drafted in section 4. |
| **Listing assets** | ⚠️ Partly | Five 1280×800 screenshots are now committed under `store/screenshots/`, generated by `store/capture.mjs` + `store/compose.mjs` from the real extension (see `store/README.md`). Still missing: the 440×280 small promo tile, the detailed description, category and support contact. One of the five is blocked — see C5. |

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

**C5 — A 12-hour browser UI language clips the cutoff chips, which blocks the
settings screenshot.** `.chip-time` in `ui/theme.css` is `width: 4.2em`, sized
for a `HH:MM` field. Chromium renders `<input type="time">` from its **UI
language**, not from `navigator.language`, so on a 12-hour UI language — en-US,
the store's largest audience — the field is `06:00 PM` and clips to `06:00 P`.
`store/screenshots/03-options.png` shows this, because it is what the UI
actually does. Not a policy violation, but a listing cannot ship a screenshot
of its main setting rendered broken, and the underlying bug is worse than the
screenshot. Fix, then re-run the two scripts. `store/README.md` has the detail
and the two candidate fixes; the choice belongs in `sweep-controls.spec.md`
first.

**C4 — Consider `1.0.0` for the first listing.** `0.1.0` is accepted by the
store, but a 0.x version on a public listing reads as pre-release. Cosmetic.

---

## 3. Mozilla AMO

| Policy | Status | Evidence |
| --- | --- | --- |
| **addons-linter** | ✅ | 0 errors, 0 warnings, 0 notices — in `--self-hosted` mode *and* in listed mode. CI already runs this with `--warnings-as-errors`. |
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
> else. No tab is closed until the user has accepted the terms on the page
> shown at install.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `tabs` | Enumerating the open tabs and closing them is the extension's only function. Titles and URLs are read solely to write bookmarks when the user asks for them, and to display a count of tabs at risk. Neither is stored by the extension or sent anywhere. |
| `alarms` | Waking the background at each scheduled cutoff, and one minute before it to start the countdown badge. |
| `storage` | `storage.local` holds the user's settings (cutoff times, notice lead time, three toggles), the aggregate counters shown on the settings page, and the flag recording that the user accepted the terms. Six keys, nothing per-tab. |
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
4. Fix the cutoff-chip clipping and re-run `store/capture.mjs` +
   `store/compose.mjs`, so shot 3 is usable. *(C5)*
5. Produce the 440×280 small promo tile, the detailed description, category and
   support contact. Screenshots themselves are done — `store/screenshots/`,
   specs and upload steps in `store/README.md`. *(Chrome listing)*
6. Decide on `gecko_android`: verify on Firefox for Android, or drop it. *(F3)*
7. Optional: bump to `1.0.0` for a first public listing. *(C4)*

Items 1–3 and 5 are submission artifacts. Item 4 is a UI bug. Item 6 is the
only one that touches the manifest, and only if the decision is to drop the
claim.
