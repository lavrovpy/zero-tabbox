/**
 * Composites store/.raw/*.png onto the 1280x800 canvases both stores want
 * (store/README.md). Run `capture.mjs` first.
 *
 * This step only frames what capture.mjs produced. store/README.md — "What is
 * real in these images" is the claim it must not break.
 */
import { chromium } from 'playwright';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, executablePath, resetDir } from './shared.mjs';

const RAW = join(HERE, '.raw');
const OUT = join(HERE, 'screenshots');
const FONTS = join(HERE, '..', 'src', 'ui', 'fonts');

resetDir(OUT);

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

/** @type {{name:string, headline:string, sub:string, body:string}[]} */
const FRAMES = [
  {
    name: '01-popup-live',
    headline: 'Every tab closes<br>at your cutoff.',
    sub: 'One glance tells you how many tabs are at risk and how long you have left to bookmark them.',
    body: `<img class="shot popup" src="${RAW}/popup-live.png">`,
  },
  {
    name: '02-onboarding',
    headline: 'Nothing closes until<br>you accept.',
    sub: 'Nothing is scheduled until you accept. No sweep runs before that.',
    body: `<img class="shot wide" src="${RAW}/onboarding.png">`,
  },
  {
    name: '03-options',
    headline: 'Up to four cutoffs<br>a day.',
    sub: 'A countdown, one notification, keep-pinned, bookmark-first and the interface language. No pause, no snooze, no restore.',
    body: `<img class="shot tall" src="${RAW}/options.png">`,
  },
  {
    name: '04-popup-swept',
    headline: 'Day ended.',
    sub: 'Nothing was saved. One clean window is left, holding a single new tab.',
    body: `<img class="shot popup" src="${RAW}/popup-swept.png">`,
  },
  {
    name: '05-theme',
    headline: 'Follows your<br>system theme.',
    sub: 'Light and dark are the same UI. There is deliberately no theme setting to manage.',
    body:
      `<div class="pair">` +
      `<img class="shot popup sm" src="${RAW}/popup-live.png">` +
      `<img class="shot popup sm" src="${RAW}/popup-live-dark.png">` +
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
  display: flex; align-items: center; gap: 72px;
  padding: 0 76px;
}
/* A soft ember bloom so the canvas is not a flat rectangle. */
body::before {
  content: ''; position: fixed; inset: -30% -10% auto auto;
  width: 900px; height: 900px; border-radius: 50%;
  background: radial-gradient(circle, ${PALETTE.emberSoft} 0%, rgba(255,227,208,0) 62%);
  z-index: 0;
}
.copy, .art { position: relative; z-index: 1; }
.copy { flex: 0 0 408px; }
h1 { font-size: 46px; line-height: 1.06; letter-spacing: -.028em; font-weight: 500; }
p { margin-top: 20px; font-size: 18px; line-height: 1.5; color: ${PALETTE.fg3}; max-width: 27ch; }
.rule { width: 52px; height: 3px; background: ${PALETTE.accent}; border-radius: 2px; margin-bottom: 28px; }
.art { flex: 1; display: flex; justify-content: center; align-items: center; }
.shot { display: block; border-radius: 10px; border: 1px solid ${PALETTE.border};
  box-shadow: 0 24px 60px -18px rgba(23,22,19,.30), 0 6px 14px rgba(23,22,19,.06); }
.popup { width: 470px; }
.popup.sm { width: 288px; }
.pair { display: flex; gap: 22px; align-items: flex-start; }
.wide { width: 604px; }
.tall { width: 596px; }
`;

const browser = await chromium.launch({
  executablePath,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

for (const f of FRAMES) {
  const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body>
  <div class="copy"><div class="rule"></div><h1>${f.headline}</h1><p>${f.sub}</p></div>
  <div class="art">${f.body}</div>
</body>`;
  const file = join(HERE, '.frame.html');
  writeFileSync(file, html);
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${f.name}.png`) });
  console.log('composed', f.name);
}
await browser.close();
unlinkSync(join(HERE, '.frame.html'));
console.log('composed to store/screenshots');
