# Store listing assets

The screenshots both listings need, and the scripts that regenerate them.

```bash
bun add --dev playwright && bunx playwright install chromium   # once, ad hoc
bun run build                 # store/capture.mjs loads dist/chrome
bun store/capture.mjs         # store/.raw/*.png — the extension, rendering itself
bun store/compose.mjs         # store/screenshots/*.png — the 1280x800 canvases
```

Playwright is deliberately **not** a devDependency. It is heavy, it is needed
once per listing refresh, and `package.json` staying at five devDependencies is
worth something during AMO source review. `store/.raw/` and `store/.profile/`
are intermediates and are gitignored; only `store/screenshots/` is committed.

Set `CHROMIUM_PATH` to reuse a Chromium already on the machine instead of the
one Playwright downloads.

## What is real in these images

`capture.mjs` drives a real Chromium with `dist/chrome` loaded unpacked. Every
pixel of UI inside every frame is the extension rendering its own HTML, CSS and
fonts against its own `chrome.storage` and a real tab strip — including the
counts. "24 tabs close at" is counted by `bookmarks.ts` from 24 tabs that are
genuinely open; it is not typed into a mockup. The decoy tabs are invented
placeholder titles, never real browsing: these images are public forever, and
the listing's whole claim is that the extension records nothing.

`compose.mjs` adds only a backdrop in the extension's own palette
(`--color-stone-*` / `--color-ember-*` from `ui/theme.css`) and a caption. It
imitates no browser chrome and redraws no UI. Nothing about the extension's
appearance is enhanced for the store.

## Specs

Both stores are satisfied by one set at **1280×800**.

| | Chrome Web Store | AMO |
| --- | --- | --- |
| Size | 1280×800 (640×400 also accepted) | 1280×800 recommended — the max display size; otherwise 1.6:1 |
| Count | 1–5 | Optional, more allowed |
| Format | 24-bit PNG (no alpha) or JPEG | PNG or JPEG |
| Framing | Full-bleed, square corners, no padding | Same |
| Captions | Not supported | Supported — use them |

The committed files are 1280×800 24-bit RGB PNGs with no alpha channel, so they
satisfy the stricter of the two.

Chrome additionally wants a **440×280 small promo tile** (and an optional
1400×560 marquee). Neither is generated here yet.

## The set

Order matters on Chrome: the first screenshot is what appears on search cards
and at the top of the listing.

| # | File | Shows | AMO caption |
| --- | --- | --- | --- |
| 1 | `01-popup-live.png` | The popup: how many tabs are at risk, the next cutoff, the countdown, both actions | What is at stake, and how long you have. |
| 2 | `02-onboarding.png` | The install-time contract | Nothing is scheduled until you accept these terms. |
| 3 | `03-options.png` | Every setting there is | Up to four cutoffs. No pause, no snooze, no restore. |
| 4 | `04-popup-swept.png` | The "Day ended" state | The day ends at zero. Nothing is saved. |
| 5 | `05-theme.png` | The popup in light and dark | Follows the system theme. |

Shot 2 does double duty: it is the most distinctive thing the extension has,
and it is the answer to the question a reviewer asks first about an extension
that requests `tabs` and then closes everything — *did the user agree to this?*

**Not covered:** the pre-cutoff badge countdown and the system notification.
Both are browser and OS chrome, which a page screenshot cannot capture — a
headless capture only ever sees page content. Getting those honestly needs a
real desktop screen capture with the extension installed. Do not mock them.

## Known issue blocking shot 3

`03-options.png` currently shows the cutoff chips as `01:00 P` and `06:00 P`.
That is not a capture artifact — it is the shipped UI. `.chip-time` in
`ui/theme.css` is `width: 4.2em`, sized for a `HH:MM` field, but Chromium
renders `<input type="time">` from its **UI language**, and a 12-hour UI
language (en-US, the Chrome Web Store's largest audience) renders
`06:00 PM` — which clips to `06:00 P`.

It reproduces at every JS locale, because `navigator.language` is not what
decides the widget format; only the browser UI language is. So the setting that
matters most on that page is unreadable for a large share of users.

Fix it before this shot goes on a listing, then re-run the two scripts. The
options are to let the field size itself (drop the fixed width, accept slightly
wider chips at 24-hour locales) or to widen `4.2em` to fit `HH:MM AM`. Which
one is a design call, and `sweep-controls.spec.md` is where it should be
settled first.

## Where these get uploaded

**Chrome** — Developer Dashboard → the item → **Store listing** → *Graphic
assets*. Screenshots (drag to order), the 128×128 icon, the 440×280 tile. Save
draft, then **Submit for review**. Screenshots can be swapped later without a
code review, but any listing edit re-enters review.

**AMO** — Developer Hub → the add-on → **Edit Product Page** → *Screenshots*.
Upload and add the caption from the table above to each.
