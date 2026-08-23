/**
 * Composites store/.raw/*.png onto the 1280x800 canvases both stores want
 * (store/README.md). Run `capture.mjs` first.
 *
 * The UI inside every frame is the untouched 3x capture from capture.mjs. This
 * step only adds a backdrop in the extension's own palette and a caption — no
 * browser chrome is imitated and no UI is redrawn.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, '.raw');
const OUT = join(HERE, 'screenshots');
const FONTS = join(HERE, '..', 'src', 'ui', 'fonts');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const T = {
  bg: '#f4f2ee', surface: '#ffffff', border: '#e0ddd4',
  fg: '#171613', fg2: '#3b3934', fg3: '#79756a',
  accent: '#c2410c', emberSoft: '#ffe3d0',
  bgDark: '#0e0d0b', fgDark: '#faf9f7', fg2Dark: '#c9c4b8', borderDark: '#2b2926',
};

/** @type {{name:string, dark?:boolean, headline:string, sub:string, body:string}[]} */
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
  background: ${T.bg};
  color: ${T.fg};
  display: flex; align-items: center; gap: 72px;
  padding: 0 76px;
}
/* A soft ember bloom so the canvas is not a flat rectangle. */
body::before {
  content: ''; position: fixed; inset: -30% -10% auto auto;
  width: 900px; height: 900px; border-radius: 50%;
  background: radial-gradient(circle, ${T.emberSoft} 0%, rgba(255,227,208,0) 62%);
  opacity: 1; z-index: 0;
}
.copy, .art { position: relative; z-index: 1; }
.copy { flex: 0 0 408px; }
h1 { font-size: 46px; line-height: 1.06; letter-spacing: -.028em; font-weight: 500; }
p { margin-top: 20px; font-size: 18px; line-height: 1.5; color: ${T.fg3}; max-width: 27ch; }
.rule { width: 52px; height: 3px; background: ${T.accent}; border-radius: 2px; margin-bottom: 28px; }
.art { flex: 1; display: flex; justify-content: center; align-items: center; }
.shot { display: block; border-radius: 10px; border: 1px solid ${T.border};
  box-shadow: 0 24px 60px -18px rgba(23,22,19,.30), 0 6px 14px rgba(23,22,19,.06); }
.popup { width: 470px; }
.popup.sm { width: 288px; }
.pair { display: flex; gap: 22px; align-items: flex-start; }
.wide { width: 604px; }
.tall { width: 596px; }

body.dark { background: ${T.bgDark}; color: ${T.fgDark}; }
body.dark p { color: ${T.fg2Dark}; }
body.dark .shot { border-color: ${T.borderDark}; box-shadow: 0 24px 60px -18px rgba(0,0,0,.7); }
body.dark::before { opacity: .16; }
`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

for (const f of FRAMES) {
  const cls = f.dark ? 'dark' : '';
  const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body class="${cls}">
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
