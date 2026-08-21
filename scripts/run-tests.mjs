/**
 * Runs `bun test` once per test file, in its own process.
 *
 * `bun test` loads every test file into ONE runtime, and `mock.module` patches
 * the shared module registry with live bindings — so sweep.test.ts mocking
 * `../src/badge` would silently replace the real implementation badge.test.ts
 * is exercising, and the suite's result would depend on file load order.
 * Per-file processes restore the per-file module graph vitest gave us.
 *
 * Usage: bun scripts/run-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Same net as the old vitest config: unit tests in src/ and tests/ only.
const files = [...new Bun.Glob('{src,tests}/**/*.{test,spec}.ts').scanSync(ROOT)].sort();
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const { status } = spawnSync('bun', ['test', file], { cwd: ROOT, stdio: 'inherit' });
  if (status !== 0) failed.push(file);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${files.length} test files failed:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nall ${files.length} test files passed`);
