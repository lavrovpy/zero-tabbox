/**
 * Captures the real zero-tabbox UI for the store listings (store/README.md).
 *
 *   bun store/capture.mjs        # writes store/.raw/*.png
 *
 * What may appear in these captures is fixed by store/README.md — "What is
 * real in these images". Nothing added here may fall outside it.
 *
 * Playwright is deliberately NOT a devDependency — store/README.md says why.
 * Install it ad hoc:
 *
 *   bun add --dev playwright && bunx playwright install chromium
 *
 * Both scripts take CHROMIUM_PATH to use a Chromium that is already on the
 * machine, instead of the one Playwright downloads.
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { HERE, executablePath, removeDir, resetDir } from './shared.mjs';

const EXT = join(HERE, '..', 'dist', 'chrome');
const OUT = join(HERE, '.raw');
const PROFILE = join(HERE, '.profile');

/**
 * Pinned like the timezone and colour scheme below: Chromium formats
 * `<input type="time">` from the browser UI language, so this is what decides
 * whether shot 3 reads `13:00` or `01:00 PM` (sweep-controls.spec.md).
 */
const LANG = process.env.SHOT_LANG ?? 'en-GB';

/**
 * The widget's language comes from the browser process's own locale
 * environment — NOT from `--lang`, and not from Playwright's `locale`. Both of
 * those set `navigator.language` and `Intl`, and this control ignores both:
 * measured on the built theme, `--lang=en-GB` alone still renders the 12-hour
 * widget (74px) while `LANG=en_GB.UTF-8` renders the 24-hour one (47px).
 *
 * So `LANG` has to reach the child process, or the format is inherited from
 * whatever shell the capture happens to run in and `SHOT_LANG` is decorative.
 * That is what made the committed set unreproducible across machines. All
 * three are still set: the other two are what `navigator.language` and `Intl`
 * read, and the UI uses those for everything that is not this widget.
 */
const POSIX_LANG = `${LANG.replace('-', '_')}.UTF-8`;

resetDir(OUT);
removeDir(PROFILE);

/** Plausible but obviously generic decoy tabs. Never real browsing. */
const DECOYS = [
  'Inbox (14)', 'Design review — notes', 'Pull request #482', 'CI: build 1194',
  'Postgres index tuning', 'Flight options — Mar 14', 'Rust ownership, again',
  'invoice-template.xlsx', 'Standup notes 2026-08', 'OKLCH color picker',
  'How does an event page sleep?', 'Kitchen shelving ideas', 'Recipe: braised leeks',
  'Ticket ENG-2213', 'Changelog v4.2', 'Comparison: A vs B', 'font pairing tests',
  'Bun 1.3 release notes', 'MDN — Web Extensions', 'Apartment listing',
  'Tab hoarding, a study',
];

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The document is escaped for HTML and then percent-encoded as a whole, in that
 * order. Encoding only the title would put the escapes in the rendered tab name
 * (`Design%20review`), and leaving the document raw would let a `#` in a title
 * start a URL fragment and truncate the page.
 */
const decoy = (title) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><html><head><title>${escapeHtml(title)}</title></head>` +
      `<body></body></html>`,
  );

/** A believable established install, not a fresh profile. */
const SETTINGS = {
  cutoffs: ['13:00', '18:00'],
  noticeMinutes: 10,
  notify: true,
  keepPinned: false,
  autoBookmark: false,
  // Pinned so the capture is deterministic whatever language the browser is
  // in. This is the UI's own locale setting (design.md D14), not the
  // manifest's `default_locale`. SHOT_LOCALE=uk renders the Ukrainian UI for
  // the localized listing set (store/README.md).
  locale: process.env.SHOT_LOCALE ?? 'en',
};

/*
 * `channel: 'chromium'` selects Playwright's full Chromium; the default under
 * `headless: true` is the headless shell, which cannot load extensions and
 * leaves the service-worker wait below to time out. Branded Google Chrome is
 * no use as CHROMIUM_PATH either — 137+ ignores `--load-extension`.
 */
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  channel: executablePath ? undefined : 'chromium',
  executablePath,
  colorScheme: 'light',
  locale: LANG,
  env: { ...process.env, LANG: POSIX_LANG, LANGUAGE: LANG.replace('-', '_'), LC_ALL: POSIX_LANG },
  deviceScaleFactor: 3, // 3x sources stay crisp once composited
  timezoneId: 'Asia/Kolkata', // puts local "now" at a natural mid-afternoon
  args: [`--lang=${LANG}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
const id = new URL(sw.url()).host;

const page = ctx.pages()[0] ?? (await ctx.newPage());

/** Runs code inside a real extension page, where `chrome.*` is available. */
async function inExtension(fn, arg) {
  await page.goto(`chrome-extension://${id}/ui/options.html`);
  return page.evaluate(fn, arg);
}

await inExtension(async (settings) => {
  await chrome.storage.local.set({
    version: 1,
    settings,
    accepted: true,
    stats: { lifetimeClosed: 4187 },
    lastSweep: { reason: 'auto', at: Date.now() - 16 * 3600_000, closed: 31, bookmarked: false },
  });
}, SETTINGS);

for (const title of DECOYS) {
  const p = await ctx.newPage();
  await p.goto(decoy(title));
}

/** `element` is the selector of the container a page draws for itself. */
async function shot(name, url, width, height, { element, colorScheme = 'light' } = {}) {
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme });
  await p.setViewportSize({ width, height });
  await p.goto(`chrome-extension://${id}/${url}`);
  await p.waitForTimeout(1200); // fonts settle; the ETA ticks at least once

  const target = element ? p.locator(element) : p;
  await target.screenshot({
    path: join(OUT, `${name}.png`),
    ...(element ? {} : { fullPage: true }),
  });
  console.log(`${name}: ${(await p.evaluate(() => document.body.innerText)).split('\n')[0]}`);
  await p.close();
}

await shot('popup-live', 'ui/popup.html', 320, 240, { element: 'body' });
await shot('popup-live-dark', 'ui/popup.html', 320, 240, { element: 'body', colorScheme: 'dark' });
await shot('options', 'ui/options.html', 700, 400);
await shot('onboarding', 'ui/onboarding.html', 700, 640, { element: '.onboarding-card' });

// The "Day ended" state only renders within 60 s of a sweep.
await inExtension(async () => {
  await chrome.storage.local.set({
    lastSweep: { reason: 'auto', at: Date.now(), closed: 23, bookmarked: false },
  });
});
await shot('popup-swept', 'ui/popup.html', 320, 240, { element: 'body' });

await ctx.close();
removeDir(PROFILE);
console.log('captured to store/.raw');
