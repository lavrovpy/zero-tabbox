/**
 * Packages the built extensions into distributable zips (tasks.md 7.4).
 *
 *   node scripts/package.mjs [--browser=chrome] [--browser=firefox]
 *
 * Produces `artifacts/zero-tabbox-<browser>-<version>.zip`, zipped from *inside*
 * `dist/<browser>` so `manifest.json` sits at the archive root — both stores and
 * both "load unpacked" flows reject an archive with a wrapper directory.
 *
 * The Chrome zip is the upload/self-host artifact as-is. The Firefox zip is the
 * unsigned source for AMO; a signed `.xpi` comes back from `web-ext sign`
 * (see README, "Firefox"), which is why nothing here renames the extension.
 *
 * Requires a `zip` binary (present on macOS and most Linux images).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, 'artifacts');

const BROWSERS = ['chrome', 'firefox'];

/** Files that must never reach an archive, whatever the platform leaves behind. */
const EXCLUDES = ['*.DS_Store', '__MACOSX/*', '*.map'];

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const requested = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith('--browser='))
  .map((arg) => arg.slice('--browser='.length));
const unknown = requested.filter((browser) => !BROWSERS.includes(browser));
if (unknown.length > 0) {
  throw new Error(`Unknown --browser value(s): ${unknown.join(', ')}`);
}
const browsers = requested.length > 0 ? requested : BROWSERS;

mkdirSync(ARTIFACTS, { recursive: true });

for (const browser of browsers) {
  const source = join(DIST, browser);
  if (!existsSync(join(source, 'manifest.json'))) {
    throw new Error(`dist/${browser} is missing or unbuilt — run \`npm run build\` first.`);
  }

  const zipPath = join(ARTIFACTS, `zero-tabbox-${browser}-${version}.zip`);
  // Rebuild rather than update: `zip` adds to an existing archive, which would
  // keep files that a later build deleted.
  rmSync(zipPath, { force: true });

  execFileSync('zip', ['-r', '-q', '-X', zipPath, '.', '-x', ...EXCLUDES], {
    cwd: source,
    stdio: 'inherit',
  });
  console.log(`packaged ${zipPath.slice(ROOT.length + 1)}`);
}
