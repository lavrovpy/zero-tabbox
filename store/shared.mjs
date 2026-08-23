/**
 * Setup shared by capture.mjs and compose.mjs, so the paths under store/ and
 * the CHROMIUM_PATH escape hatch mean the same thing in both.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));

/** A Chromium already on the machine — see capture.mjs's header. */
export const executablePath = process.env.CHROMIUM_PATH || undefined;

/** Empties `dir`, so a run never mixes with the previous run's output. */
export function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}
