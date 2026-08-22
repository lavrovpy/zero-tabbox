/**
 * Build script for zero-tabbox.
 *
 *   bun ./build.mjs --browser=chrome --browser=firefox [--watch]
 *
 * For each requested browser it:
 *   1. bundles the four TypeScript entry points with Bun.build into dist/<browser>/,
 *   2. copies the static assets (ui/*.html, ui/*.css, ui/fonts/*, icons/*,
 *      _locales/*),
 *   3. writes dist/<browser>/manifest.json from src/manifest.base.json plus the
 *      per-browser overlay below (design.md D1).
 *
 * Output layout (identical for both browsers apart from the manifest):
 *   dist/<browser>/background.js
 *   dist/<browser>/ui/{popup,options,onboarding}.{html,js}
 *   dist/<browser>/ui/theme.css
 *   dist/<browser>/ui/fonts/*.woff2
 *   dist/<browser>/icons/icon{16,32,48,128}.png
 *   dist/<browser>/_locales/{en,uk}/messages.json
 *   dist/<browser>/manifest.json
 */
import { cpSync, mkdirSync, readFileSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs';
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
 *
 * Unlike esbuild, Bun.build cannot lower syntax to a browser-version target —
 * these floors only feed the manifests now. That is safe because tsconfig
 * targets ES2022 and both floors (Chrome 120, Firefox 140) support all of
 * ES2022 natively, so the bundles ship the syntax the sources are written in.
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

/**
 * Bundle entry points. With `root: SRC`, Bun.build mirrors each entry's path
 * under dist/<browser>/ — src/ui/popup.ts lands at ui/popup.js, matching the
 * layout the .html files and the manifests expect.
 */
const ENTRY_POINTS = [
  join(SRC, 'background.ts'),
  join(SRC, 'ui', 'popup.ts'),
  join(SRC, 'ui', 'options.ts'),
  join(SRC, 'ui', 'onboarding.ts'),
];

/** Static files copied verbatim, as [source, destination-relative-to-dist]. */
const STATIC_ASSETS = [
  [join(SRC, 'ui', 'popup.html'), 'ui/popup.html'],
  [join(SRC, 'ui', 'options.html'), 'ui/options.html'],
  [join(SRC, 'ui', 'onboarding.html'), 'ui/onboarding.html'],
  [join(SRC, 'ui', 'theme.css'), 'ui/theme.css'],
  // The design system's faces (Geist, JetBrains Mono) ship with the extension:
  // extension pages may not fetch remote assets, and the no-network guarantee
  // (tab-sweep.spec) would forbid it anyway.
  [join(SRC, 'ui', 'fonts'), 'ui/fonts'],
  [join(ROOT, 'icons'), 'icons'],
  // The message catalogs ship as files because the MANIFEST needs them: the
  // browser resolves the `__MSG_extDescription__` / `__MSG_commandEndDayNow__`
  // placeholders out of dist/<browser>/_locales/<lang>/messages.json against
  // `default_locale`, and addons-linter fails an AMO submission whose manifest
  // references messages it cannot find on disk.
  //
  // This looks redundant next to the UI, which never reads these copies — the
  // UI modules `import` the very same _locales/*/messages.json and Bun inlines
  // them into the bundles at build time (design.md D14; a runtime fetch would
  // paint the wrong language first). It is not redundant: one source of truth,
  // two delivery paths, because the two consumers resolve messages differently
  // — the manifest follows the BROWSER UI language, the UI follows the user's
  // own locale setting. Deleting either path breaks one of them silently.
  [join(ROOT, '_locales'), '_locales'],
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

async function bundle(browser) {
  const result = await Bun.build({
    entrypoints: ENTRY_POINTS,
    root: SRC,
    outdir: join(DIST, browser),
    // IIFE keeps the Firefox event page on a classic script and lets the Chrome
    // service worker skip `"type": "module"` — one output shape for both.
    format: 'iife',
    target: 'browser',
    // No build-time browser define on purpose: platform.ts detects the browser
    // at runtime so the same code path is exercised under `bun test`.
    minify: false,
    sourcemap: 'none',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `bundle failed for ${browser}`);
  }
  // esbuild's `logLevel: 'info'` printed diagnostics from successful builds too.
  // Bun.build only returns them, so print them or a warning vanishes silently.
  for (const log of result.logs) console.warn(String(log));
}

/**
 * `clean: false` leaves the existing dist/<browser> directory in place.
 * Watch mode needs that: a browser with the extension loaded unpacked from
 * that directory unloads it the moment the directory is unlinked, so cleaning
 * on every rebuild would drop the extension being developed. Outputs are
 * overwritten in place instead — the only thing that can then survive is the
 * output of a file that was renamed in src/, which the next one-shot
 * `bun run build` (clean: true) clears.
 */
async function buildOnce(browser, { clean = true } = {}) {
  if (clean) rmSync(join(DIST, browser), { recursive: true, force: true });
  mkdirSync(join(DIST, browser), { recursive: true });
  await bundle(browser);
  copyStatic(browser);
  writeManifest(browser);
  console.log(`built dist/${browser}`);
}

/**
 * Bun.build has no incremental watch API (esbuild's context/rebuild), so watch
 * mode re-runs the full build on every change. A full build is well under a
 * second, and rebuilding everything — bundles, static assets and the manifest —
 * on every event is what keeps `bun run watch` correct when an .html/.css file
 * changes.
 */
function watch(browsers) {
  let timer;
  let building = false;
  let dirty = false;

  const rebuild = async () => {
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    try {
      for (const browser of browsers) await buildOnce(browser, { clean: false });
    } catch (error) {
      console.error(error);
    }
    building = false;
    if (dirty) {
      dirty = false;
      await rebuild();
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 50);
  };

  // _locales is watched alongside src/: editing a message must rebuild both the
  // copied catalogs and the bundles that inlined them.
  for (const dir of [SRC, join(ROOT, 'icons'), join(ROOT, '_locales')]) {
    fsWatch(dir, { recursive: true }, schedule);
  }
  console.log(`watching ${browsers.map((b) => `dist/${b}`).join(', ')}`);
}

const { browsers, watch: isWatch } = parseArgs(process.argv.slice(2));
for (const browser of browsers) {
  await buildOnce(browser);
}
if (isWatch) {
  watch(browsers);
}
