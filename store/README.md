# Store listing assets

The screenshots both listings need, and the scripts that regenerate them.

```bash
bun add --dev playwright && bunx playwright install chromium   # once, ad hoc
bun run build                 # store/capture.mjs loads dist/chrome
bun store/capture.mjs         # store/.raw/*.png — the extension, rendering itself
bun store/compose.mjs         # store/screenshots/*.png and store/promo/*.png
```

Playwright is deliberately **not** a devDependency. It is heavy, it is needed
once per listing refresh, and `package.json` staying at five devDependencies is
worth something during AMO source review. `store/.raw/` and `store/.profile/`
are intermediates and are gitignored; only `store/screenshots/` is committed.

`CHROMIUM_PATH` — see the header of `store/capture.mjs`.

## What is real in these images

`capture.mjs` drives a real Chromium with `dist/chrome` loaded unpacked. Every
pixel of UI inside every frame is the extension rendering its own HTML, CSS and
fonts against its own `chrome.storage`. "24 tabs close at" is counted live by
`bookmarks.ts` from 24 tabs genuinely open in that profile — the tab strip is
real, but no image shows it, because a page capture only ever sees page
content. The historical numbers are not live: `capture.mjs` seeds the settings
and the history — "4,187 tabs closed" and "31 last sweep" on the options page,
"23 tabs closed" in the swept popup — into `chrome.storage`, because a capture
profile has no past to show. The extension renders those from storage; nothing
is typed into a mockup. The decoy tabs are invented placeholder titles, never
real browsing: these images are public forever, and the listing's whole claim
is that the extension records nothing.

`compose.mjs` frames each capture on a backdrop in the extension's own colours
— copied out of `src/ui/theme.css` by hand, not read from it (see `PALETTE`) —
under a headline and a caption. The frame rounds, borders and shadows the
capture; inside it nothing is retouched, redrawn or enhanced, and no browser
chrome is imitated.

The captures pin `settings.locale` to `en` so a rerun is deterministic whatever
language the capturing machine is in. For a Ukrainian listing, flip that to
`'uk'` in `capture.mjs`, translate the captions below, and regenerate — the
extension is localized, but store listing copy lives in each dashboard and is
not covered by `_locales` (see `store-compliance.md`, finding L1).

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

Chrome additionally wants a **440×280 small promo tile**, which `compose.mjs`
also renders, to `store/promo/small-tile-440x280.png`. It holds no capture —
a popup is illegible at that size — only the icon, the name and the tagline.
The optional 1400×560 marquee is not generated. The listing copy to paste
alongside these is in [`listing.md`](listing.md).

## The set

Order matters on Chrome: the first screenshot is what appears on search cards
and at the top of the listing.

| # | File | Shows | AMO caption |
| --- | --- | --- | --- |
| 1 | `01-popup-live.png` | The popup: how many tabs are at risk, the next cutoff, the countdown, both actions | What is at stake, and how long you have. |
| 2 | `02-onboarding.png` | The install-time contract | Nothing is scheduled until you accept these terms. |
| 3 | `03-options.png` | Every setting there is, including the interface language | Up to four cutoffs. No pause, no snooze, no restore. |
| 4 | `04-popup-swept.png` | The "Day ended" state | The day ends at zero. Nothing is saved. |
| 5 | `05-theme.png` | The popup in light and dark | Follows the system theme. |

Shot 2 does double duty: it is the most distinctive thing the extension has,
and it is the answer to the question a reviewer asks first about an extension
that requests `tabs` and then closes everything — *did the user agree to this?*

**Not covered:** the pre-cutoff badge countdown and the system notification.
Both are browser and OS chrome, which a page screenshot cannot capture — a
headless capture only ever sees page content. Getting those honestly needs a
real desktop screen capture with the extension installed. Do not mock them.

## Shot 3's time format

Chromium formats `<input type="time">` from the browser's UI language, which
`capture.mjs` pins via `SHOT_LANG` (default `en-GB`) — so the committed shot
reads `13:00` / `18:00`, and `SHOT_LANG=en-US` gives the 12-hour render. Why
the chip has to survive either is `sweep-controls.spec.md` § "The cutoff time
is legible in any browser UI language".

`--lang` alone does not pin it. That flag and Playwright's `locale` set
`navigator.language` and `Intl`; this control reads neither. Measured against
the built theme on a host whose own locale is 12-hour: with `--lang=en-GB` and
`locale: 'en-GB'` the chip is still the 12-hour widget at 74px, and only
`LANG=en_GB.UTF-8` in the browser process's environment brings it to 47px.
`capture.mjs` therefore passes `LANG`/`LANGUAGE`/`LC_ALL` through `env` as
well; without that the format is silently inherited from whatever shell the
capture runs in, which is what made an earlier committed set unreproducible on
another machine.

## What "regenerate" does and does not guarantee

Re-running the two scripts reproduces the *content* of the committed set. It
does not reproduce the bytes, and cannot: text rasterization depends on the
host's font stack, so the same commands on two machines give images that
differ across most of the frame while showing the same thing. Measured: on one
machine, a rerun is pixel-identical to that machine's previous run except where
content actually changed, while the same shot rendered on a different machine
differs over the whole canvas.

So do not treat a diff in `store/screenshots/` as a regression, and do not
re-commit a regenerated set just because the bytes moved — only when the
content did. Otherwise the images churn once per contributor.

## Where these get uploaded

**Chrome** — Developer Dashboard → the item → **Store listing** → *Graphic
assets*. Screenshots (drag to order), the 128×128 icon, the 440×280 tile. Save
draft, then **Submit for review**. Screenshots can be swapped later without a
code review, but any listing edit re-enters review.

**AMO** — Developer Hub → the add-on → **Edit Product Page** → *Screenshots*.
Upload and add the caption from the table above to each.
