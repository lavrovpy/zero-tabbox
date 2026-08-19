/**
 * Build script for zero-tabbox.
 *
 *   node build.mjs --browser=chrome --browser=firefox [--watch]
 *
 * For each requested browser it:
 *   1. bundles the three TypeScript entry points with esbuild into dist/<browser>/,
 *   2. copies the static assets (ui/*.html, ui/*.css, icons/*),
 *   3. writes dist/<browser>/manifest.json from src/manifest.base.json plus the
 *      per-browser overlay below (design.md D1).
 *
 * Output layout (identical for both browsers apart from the manifest):
 *   dist/<browser>/background.js
 *   dist/<browser>/ui/{popup,options}.{html,js}
 *   dist/<browser>/ui/theme.css
 *   dist/<browser>/icons/icon{16,32,48,128}.png
 *   dist/<browser>/manifest.json
 */
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const BROWSERS = ['chrome', 'firefox'];

/**
 * Minimum platform versions, kept in one place because they are load-bearing:
 *  - Chrome 120: 30 s alarm granularity. `alarms.persistAcrossSessions` is
 *    Chrome 150+ and is therefore feature-detected in platform.ts rather than
 *    declared here (passing it on older Chrome or on Firefox throws).
 *  - Firefox 140: built-in data-collection consent UI, which is what makes the
 *    `data_collection_permissions` declaration meaningful at install time.
 * Both floors clear MV3, non-persistent backgrounds and `oklch()` CSS.
 */
const MIN_CHROME = '120';
const MIN_FIREFOX = '140.0';
/**
 * Firefox for Android only gained `data_collection_permissions` in 142, and
 * addons-linter flags the mismatch (KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION)
 * unless the Android floor is stated separately.
 */
const MIN_FIREFOX_ANDROID = '142.0';

/** Stable AMO add-on id. MV3 submissions to AMO require an explicit id. */
const GECKO_ID = 'zero-tabbox@lavrov.dev';

/**
 * Per-browser manifest overlay. Top-level keys REPLACE the base value — in
 * particular `background`, which must never be merged: a Firefox manifest that
 * still carries `service_worker` trips addons-linter
 * (BACKGROUND_SERVICE_WORKER_IGNORED), and a Chrome manifest that carries
 * `scripts` is invalid MV3.
 *
 * @type {Record<string, (base: Record<string, unknown>) => Record<string, unknown>>}
 */
const OVERLAYS = {
  chrome: () => ({
    minimum_chrome_version: MIN_CHROME,
    background: { service_worker: 'background.js' },
  }),
  firefox: (base) => ({
    // Firefox MV3 has no service worker support: event page via `scripts`.
    // `persistent` is implicitly false in MV3 and must not be set to true.
    background: { scripts: ['background.js'] },
    // `sessions` is Firefox-only — it is what lets the sweep clear the
    // recently-closed list (tab-sweep.spec: no recoverable archive).
    permissions: [...base.permissions, 'sessions'],
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: MIN_FIREFOX,
        // "none" must stay alone in `required` (NONE_DATA_COLLECTION_IS_EXCLUSIVE)
        // and `has_previous_consent` must never be added (reserved).
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: MIN_FIREFOX_ANDROID },
    },
  }),
};

/** esbuild entry points, mapped to their output path inside dist/<browser>/. */
const ENTRY_POINTS = [
  { in: join(SRC, 'background.ts'), out: 'background' },
  { in: join(SRC, 'ui', 'popup.ts'), out: 'ui/popup' },
  { in: join(SRC, 'ui', 'options.ts'), out: 'ui/options' },
];

/** Static files copied verbatim, as [source, destination-relative-to-dist]. */
const STATIC_ASSETS = [
  [join(SRC, 'ui', 'popup.html'), 'ui/popup.html'],
  [join(SRC, 'ui', 'options.html'), 'ui/options.html'],
  [join(SRC, 'ui', 'theme.css'), 'ui/theme.css'],
  [join(ROOT, 'icons'), 'icons'],
];

function parseArgs(argv) {
  const browsers = argv
    .filter((arg) => arg.startsWith('--browser='))
    .map((arg) => arg.slice('--browser='.length));
  const unknown = browsers.filter((b) => !BROWSERS.includes(b));
  if (unknown.length > 0) {
    throw new Error(`Unknown --browser value(s): ${unknown.join(', ')}`);
  }
  return {
    browsers: browsers.length > 0 ? browsers : BROWSERS,
    watch: argv.includes('--watch'),
  };
}

function writeManifest(browser) {
  const base = JSON.parse(readFileSync(join(SRC, 'manifest.base.json'), 'utf8'));
  const manifest = { ...base, ...OVERLAYS[browser](base) };
  writeFileSync(
    join(DIST, browser, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function copyStatic(browser) {
  for (const [from, to] of STATIC_ASSETS) {
    const target = join(DIST, browser, to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(from, target, { recursive: true });
  }
}

/** @returns {import('esbuild').BuildOptions} */
function esbuildOptions(browser) {
  return {
    entryPoints: ENTRY_POINTS,
    outdir: join(DIST, browser),
    bundle: true,
    // IIFE keeps the Firefox event page on a classic script and lets the Chrome
    // service worker skip `"type": "module"` — one output shape for both.
    format: 'iife',
    platform: 'browser',
    // No build-time browser define on purpose: platform.ts detects the browser
    // at runtime so the same code path is exercised under vitest.
    target: browser === 'chrome' ? [`chrome${MIN_CHROME}`] : ['firefox140'],
    logLevel: 'info',
    legalComments: 'none',
    minify: false,
    sourcemap: false,
  };
}

async function buildOnce(browser) {
  rmSync(join(DIST, browser), { recursive: true, force: true });
  mkdirSync(join(DIST, browser), { recursive: true });
  await esbuild.build(esbuildOptions(browser));
  copyStatic(browser);
  writeManifest(browser);
  console.log(`built dist/${browser}`);
}

async function watch(browser) {
  mkdirSync(join(DIST, browser), { recursive: true });
  copyStatic(browser);
  writeManifest(browser);
  const ctx = await esbuild.context({
    ...esbuildOptions(browser),
    plugins: [
      {
        name: 'zero-tabbox-static',
        setup(build) {
          build.onEnd(() => {
            // Static assets and the manifest are cheap to redo on every rebuild,
            // which keeps `npm run watch` correct when an .html/.css file changes.
            copyStatic(browser);
            writeManifest(browser);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log(`watching dist/${browser}`);
}

const { browsers, watch: isWatch } = parseArgs(process.argv.slice(2));
for (const browser of browsers) {
  await (isWatch ? watch(browser) : buildOnce(browser));
}
