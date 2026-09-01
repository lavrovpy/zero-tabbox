/**
 * Composites store/.raw/*.png onto the 1280x800 canvases both stores want,
 * and renders the Chrome-only 440x280 small promo tile (store/README.md).
 * Run `capture.mjs` first.
 *
 * This step only frames what capture.mjs produced. store/README.md — "What is
 * real in these images" is the claim it must not break.
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, executablePath, removeDir, resetDir } from './shared.mjs';

const RAW = join(HERE, '.raw');
/**
 * Listing language. `en` writes the committed default set (screenshots/ and
 * the promo tile); any other locale writes screenshots-<locale>/ and leaves
 * promo/ alone — the tile cannot be localized on the dashboard, so there is
 * exactly one, in the default language. Run capture.mjs with the same
 * SHOT_LOCALE first, or the captions will not match the UI inside the frames.
 */
const LOCALE = process.env.SHOT_LOCALE ?? 'en';
const OUT = join(HERE, LOCALE === 'en' ? 'screenshots' : `screenshots-${LOCALE}`);
const PROMO = join(HERE, 'promo');
const STAGE = join(HERE, '.stage');
const FONTS = join(HERE, '..', 'src', 'ui', 'fonts');
const ICON = join(HERE, '..', 'icons', 'icon128.png');
const ICON48 = join(HERE, '..', 'icons', 'icon48.png');

/**
 * Every capture a frame below embeds. Checked before OUT is touched, because
 * OUT holds the committed listing images and `store:compose` is a script of
 * its own: run alone on a clean checkout it would otherwise delete all five,
 * then compose frames whose `<img>` sources do not exist. A missing image
 * subresource fails nothing in a page load, so that run would log success and
 * exit 0, having silently replaced the screenshots with art-less ones.
 */
const REQUIRED = [
  'popup-live.png',
  'popup-live-dark.png',
  'onboarding.png',
  'options.png',
  'popup-swept.png',
];

const missing = REQUIRED.filter((name) => !existsSync(join(RAW, name)));
if (missing.length > 0) {
  throw new Error(
    `store/.raw is missing ${missing.join(', ')} — run \`bun store/capture.mjs\` first.`,
  );
}

/*
 * Frames are rendered into STAGE and only moved over OUT once every one of
 * them has succeeded, so no failure part-way through can leave the committed
 * listing images deleted or half-replaced. The check above cannot cover a
 * capture that exists but will not decode, and that is exactly a failure that
 * happens after the first frame is already written.
 */
resetDir(STAGE);

/**
 * Copied out of src/ui/theme.css by hand — nothing here reads that file, so a
 * colour changed there would leave the committed screenshots on the old
 * palette. tests/palette.test.ts fails when these drift: re-copy the values
 * and re-run both scripts.
 */
const PALETTE = {
  bg: '#f4f2ee', border: '#e0ddd4',
  fg: '#171613', fg3: '#79756a',
  accent: '#c2410c', emberSoft: '#ffe3d0',
};

/**
 * On-image copy per listing language. Keys mirror FRAMES names; every locale
 * must caption every frame. The Ukrainian lines reuse the shipped UI's own
 * vocabulary (`закриття`, `закладки`, `День завершено` — _locales/uk) and the
 * manifest summary's voice ("коли ви скажете") rather than translating the
 * English captions word for word.
 */
const CAPTIONS = {
  en: {
    '01-popup-live': {
      headline: 'Every tab closes<br>at your cutoff.',
      sub: 'An open tab is an unfinished decision — something you meant to read, and didn\'t. The popup shows what\'s at stake and how long you have.',
    },
    '02-onboarding': {
      headline: 'Nothing closes until<br>you accept.',
      sub: 'Until then the extension does nothing at all.',
    },
    '03-options': {
      headline: 'Flexible setup.',
      sub: 'A deadline is what lets the mind let go — and it works because it cannot be negotiated. These settings choose when, never whether.',
    },
    '04-popup-swept': {
      headline: 'Day ended.',
      sub: 'What mattered is in your bookmarks. Everything else was never going to be read.',
    },
    '05-theme': {
      headline: 'Follows your<br>system theme.',
      sub: 'Light and dark are the same UI. There is deliberately no theme setting to manage.',
    },
  },
  uk: {
    '01-popup-live': {
      headline: 'Всі вкладки закриються,<br>коли ви скажете.',
      sub: 'Відкрита вкладка — незавершене рішення: щось, що ви збиралися прочитати, та так і не прочитали. Розширення показує, що на кону та скільки часу лишилося.',
    },
    '02-onboarding': {
      headline: 'Активується тільки<br>після вашої згоди.',
      sub: 'Розклад не запуститься, доки ви не приймете умови.',
      // The uk onboarding card is taller than the en one (its terms run
      // longer), so at the default 525px it climbs into the caption.
      width: 460,
    },
    '03-options': {
      headline: 'Гнучкі налаштування.',
      sub: 'Дедлайн дає голові відпустити зайве — і працює саме тому, що з ним не домовишся. Тут ви обираєте, коли це станеться, а не чи станеться взагалі.',
    },
    '04-popup-swept': {
      headline: 'День завершено.',
      sub: 'Важливе — у ваших закладках. Решту ви однаково не прочитали б.',
    },
    '05-theme': {
      headline: 'Підлаштовується під<br>тему системи.',
      sub: 'Світла й темна — той самий інтерфейс. Окремого налаштування теми немає — і це навмисно.',
    },
  },
};

if (!CAPTIONS[LOCALE]) {
  throw new Error(`no captions for SHOT_LOCALE=${LOCALE} — add a set to CAPTIONS in compose.mjs`);
}
const C = CAPTIONS[LOCALE];

/**
 * @type {{name:string, headline:string, sub:string, body:string, artStyle?:string}[]}
 *
 * Poster layout: brand lockup, centered headline and caption, capture anchored
 * to (and bleeding off) the bottom edge. Widths are tuned per raw aspect so
 * the art's top edge clears the copy (~340px); the options page is taller than
 * wide, so it pins to the top of the art zone and crops at the bottom instead.
 */
const FRAMES = [
  {
    name: '01-popup-live',
    ...C['01-popup-live'],
    body: `<img class="shot" style="width:710px" src="${RAW}/popup-live.png">`,
  },
  {
    name: '02-onboarding',
    ...C['02-onboarding'],
    body: `<img class="shot" style="width:${C['02-onboarding'].width ?? 525}px" src="${RAW}/onboarding.png">`,
  },
  {
    name: '03-options',
    ...C['03-options'],
    body: `<img class="shot" style="width:620px" src="${RAW}/options.png">`,
    artStyle: 'top:340px;bottom:auto;align-items:flex-start',
  },
  {
    name: '04-popup-swept',
    ...C['04-popup-swept'],
    body: `<img class="shot" style="width:650px" src="${RAW}/popup-swept.png">`,
  },
  {
    name: '05-theme',
    ...C['05-theme'],
    body:
      `<div class="pair">` +
      `<img class="shot" style="width:600px" src="${RAW}/popup-live.png">` +
      `<img class="shot" style="width:600px" src="${RAW}/popup-live-dark.png">` +
      `</div>`,
  },
];

const css = `
@font-face { font-family: 'Geist'; src: url('${FONTS}/Geist-Variable.woff2') format('woff2');
  font-weight: 100 900; font-display: block; }
@font-face { font-family: 'JetBrains Mono'; src: url('${FONTS}/JetBrainsMono-Regular.woff2') format('woff2');
  font-weight: 400; font-display: block; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1280px; height: 800px; overflow: hidden; }
body {
  font-family: 'Geist', system-ui, sans-serif;
  background: ${PALETTE.bg};
  color: ${PALETTE.fg};
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding-top: 64px;
}
/* A soft ember bloom behind the art so the canvas is not a flat rectangle. */
body::before {
  content: ''; position: fixed; inset: auto -20% -45% -20%;
  height: 700px; border-radius: 50%;
  background: radial-gradient(ellipse, ${PALETTE.emberSoft} 0%, rgba(255,227,208,0) 65%);
  z-index: 0;
}
.brand { display: flex; align-items: center; justify-content: center; gap: 9px;
  margin-bottom: 26px; position: relative; z-index: 1; }
.brand img { width: 28px; height: 28px; display: block; }
.brand span { font-size: 18px; font-weight: 500; letter-spacing: -.01em; color: ${PALETTE.fg}; }
h1 { font-size: 50px; line-height: 1.06; letter-spacing: -.028em; font-weight: 500;
  position: relative; z-index: 1; }
p { margin-top: 20px; font-size: 18px; line-height: 1.5; color: ${PALETTE.fg3};
  max-width: 52ch; margin-left: auto; margin-right: auto; position: relative; z-index: 1; }
.art { position: absolute; left: 0; right: 0; bottom: -3px; display: flex;
  justify-content: center; align-items: flex-end; z-index: 1; }
.shot { display: block; border-radius: 12px 12px 0 0; border: 1px solid ${PALETTE.border};
  border-bottom: none; box-shadow: 0 -18px 50px -20px rgba(23,22,19,.30); }
.pair { display: flex; gap: 26px; align-items: flex-end; }
`;


/**
 * The Chrome small promo tile. No capture in it: at 440x280 a popup would be
 * illegible, and the tile is shown next to the listing's own screenshots.
 * Chrome cannot localize this asset, so it carries no more copy than the
 * manifest description already does in every locale.
 */
const TILE = {
  name: 'small-tile-440x280',
  width: 440,
  height: 280,
  html: `<div class="tile">
  <img class="icon" src="${ICON}">
  <div class="wordmark">zero-tabbox</div>
  <div class="tagline">Every tab closes<br>at your cutoff.</div>
</div>`,
};

const tileCss = `
html, body { width: ${TILE.width}px; height: ${TILE.height}px; padding: 0; display: block; }
body { display: block; padding: 0; text-align: left; }
body::before { width: 420px; height: 420px; inset: -40% -18% auto auto;
  background: radial-gradient(circle, ${PALETTE.emberSoft} 0%, rgba(255,227,208,0) 62%); }
.tile { position: relative; z-index: 1; height: 100%; padding: 36px 40px;
  display: flex; flex-direction: column; justify-content: flex-end; }
.icon { width: 56px; height: 56px; position: absolute; top: 36px; left: 40px; }
.wordmark { font-family: 'JetBrains Mono', monospace; font-size: 15px; letter-spacing: .02em;
  color: ${PALETTE.fg3}; margin-bottom: 8px; }
.tagline { font-size: 34px; line-height: 1.06; letter-spacing: -.028em; font-weight: 500; }
`;

const browser = await chromium.launch({
  executablePath,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

for (const f of FRAMES) {
  const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body>
  <div class="brand"><img src="${ICON48}"><span>zero-tabbox</span></div>
  <h1>${f.headline}</h1><p>${f.sub}</p>
  <div class="art"${f.artStyle ? ` style="${f.artStyle}"` : ''}>${f.body}</div>
</body>`;
  const file = join(HERE, '.frame.html');
  writeFileSync(file, html);
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // The existence check above cannot see a capture that is present but not
  // decodable, and a broken `<img>` still renders a frame the script would
  // happily commit. Ask the document instead of the filesystem.
  const undecoded = await page.evaluate(() =>
    [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src),
  );
  if (undecoded.length > 0) {
    throw new Error(`${f.name}: capture(s) did not decode — ${undecoded.join(', ')}`);
  }

  await page.screenshot({ path: join(STAGE, `${f.name}.png`) });
  console.log('composed', f.name);
}
// The tile exists once, in the default language — see the LOCALE comment.
if (LOCALE === 'en') {
  const html = `<!doctype html><meta charset="utf-8"><style>${css}${tileCss}</style>
<body>${TILE.html}</body>`;
  const file = join(HERE, '.frame.html');
  writeFileSync(file, html);
  await page.setViewportSize({ width: TILE.width, height: TILE.height });
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const undecoded = await page.evaluate(() =>
    [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src),
  );
  if (undecoded.length > 0) throw new Error(`${TILE.name}: icon did not decode — ${undecoded.join(', ')}`);
  await page.screenshot({ path: join(STAGE, `${TILE.name}.png`) });
  console.log('composed', TILE.name);
}

await browser.close();
unlinkSync(join(HERE, '.frame.html'));

// Every frame rendered: now, and only now, replace the committed sets.
resetDir(OUT);
if (LOCALE === 'en') resetDir(PROMO);
for (const name of readdirSync(STAGE)) {
  const dest = name === `${TILE.name}.png` ? PROMO : OUT;
  renameSync(join(STAGE, name), join(dest, name));
}
removeDir(STAGE);
console.log(`composed to ${OUT}${LOCALE === 'en' ? ' and store/promo' : ''}`);
