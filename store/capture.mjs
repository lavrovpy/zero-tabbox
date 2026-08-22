/**
 * Captures the real zero-tabbox UI for the store listings (store/README.md).
 *
 *   bun store/capture.mjs        # writes store/.raw/*.png
 *
 * Everything it writes is the extension rendering itself: a real Chromium with
 * `dist/chrome` loaded unpacked, real `chrome.storage`, and a real tab strip —
 * the "N tabs close at" number is counted by the extension, never typed in
 * here. `compose.mjs` is the only step that adds anything, and it only adds a
 * backdrop around these images.
 *
 * Playwright is deliberately NOT a devDependency: it is heavy, it is needed
 * once per listing refresh, and AMO source review is easier with a short
 * dependency list. Install it ad hoc:
 *
 *   bun add --dev playwright && bunx playwright install chromium
 *
 * Set CHROMIUM_PATH to use a Chromium that is already on the machine.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'dist', 'chrome');
const OUT = join(HERE, '.raw');
const PROFILE = join(HERE, '.profile');

/**
 * Chromium formats `<input type="time">` from its own UI language, not from
 * the JS locale, so a 12-hour build renders the cutoff chips as `06:00 PM`.
 * See store/README.md — the chips clip at the current `.chip-time` width.
 */
const LANG = process.env.SHOT_LANG ?? 'en-GB';

rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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

const decoy = (title) =>
  `data:text/html,<!doctype html><html><head><meta charset=utf-8>` +
  `<title>${encodeURIComponent(title)}</title></head><body></body></html>`;

/** A believable established install, not a fresh profile. */
const SETTINGS = {
  cutoffs: ['13:00', '18:00'],
  noticeMinutes: 10,
  notify: true,
  keepPinned: false,
  autoBookmark: false,
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  colorScheme: 'light',
  locale: LANG,
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

async function shot(name, url, width, height, colorScheme = 'light') {
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme });
  await p.setViewportSize({ width, height });
  await p.goto(`chrome-extension://${id}/${url}`);
  await p.waitForTimeout(1200); // fonts settle; the ETA ticks at least once

  // The popup and the onboarding card each draw their own container, so they
  // are captured as elements; the options page is captured as a full page.
  const isBox = name.startsWith('popup') || name.startsWith('onboarding');
  const target = name.startsWith('popup')
    ? p.locator('body')
    : name.startsWith('onboarding')
      ? p.locator('.onboarding-card')
      : p;
  await target.screenshot({ path: join(OUT, `${name}.png`), ...(isBox ? {} : { fullPage: true }) });
  console.log(`${name}: ${(await p.evaluate(() => document.body.innerText)).split('\n')[0]}`);
  await p.close();
}

await shot('popup-live', 'ui/popup.html', 320, 240);
await shot('popup-live-dark', 'ui/popup.html', 320, 240, 'dark');
await shot('options', 'ui/options.html', 700, 400);
await shot('onboarding', 'ui/onboarding.html', 700, 640);

// The "Day ended" state only renders within 60 s of a sweep.
await inExtension(async () => {
  await chrome.storage.local.set({
    lastSweep: { reason: 'auto', at: Date.now(), closed: 23, bookmarked: false },
  });
});
await shot('popup-swept', 'ui/popup.html', 320, 240);

await ctx.close();
rmSync(PROFILE, { recursive: true, force: true });
console.log('captured to store/.raw');
