/**
 * Asserts `store/compose.mjs`'s PALETTE still matches the tokens it was copied
 * from (design.md D10, "tokens are the only source of color").
 *
 * The screenshots are composited against hand-copied hex values, so a colour
 * changed in `theme.css` would otherwise leave the committed listing images on
 * the old palette with nothing to notice. This is that notice.
 *
 * Both files are read as text. `compose.mjs` imports Playwright at top level,
 * and Playwright is deliberately not a devDependency (store/README.md), so
 * importing it here would break `bun run test` on a clean checkout.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Which token each PALETTE key mirrors. `bg` takes the subtle tone, not `--color-bg`. */
const MIRRORS: Record<string, string> = {
  bg: '--color-bg-subtle',
  border: '--color-border',
  fg: '--color-fg',
  fg3: '--color-fg-3',
  accent: '--color-accent',
  emberSoft: '--color-accent-soft',
};

/** The light-mode `:root` block only — the captures pin `colorScheme: 'light'`. */
function lightTokens(css: string): Map<string, string> {
  // Comments first: theme.css's contrast notes name tokens in prose, and a
  // `--x:` inside one runs on to the next real `;` and swallows a declaration.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = stripped.slice(stripped.indexOf(':root'), stripped.indexOf('@media'));
  const tokens = new Map<string, string>();
  for (const match of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim());
  }
  return tokens;
}

/** Follows `var(--x)` indirection to the ramp; most semantic tokens are aliases. */
function resolve(tokens: Map<string, string>, name: string): string {
  const seen = new Set<string>();
  let value = tokens.get(name);
  while (value !== undefined) {
    const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (alias === undefined) return value;
    if (seen.has(alias)) throw new Error(`${name} resolves in a cycle`);
    seen.add(alias);
    value = tokens.get(alias);
  }
  throw new Error(`${name} is not declared on :root`);
}

function palette(js: string): Record<string, string> {
  const body = js.match(/const PALETTE = \{([^}]+)\}/)?.[1];
  if (body === undefined) throw new Error('PALETTE literal not found in store/compose.mjs');
  const entries: [string, string][] = [];
  for (const match of body.matchAll(/(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g)) {
    const [, key, hex] = match;
    if (key !== undefined && hex !== undefined) entries.push([key, hex]);
  }
  return Object.fromEntries(entries);
}

describe('store/compose.mjs PALETTE', () => {
  const tokens = lightTokens(readFileSync(join(ROOT, 'src/ui/theme.css'), 'utf8'));
  const copied = palette(readFileSync(join(ROOT, 'store/compose.mjs'), 'utf8'));

  it('mirrors every token it claims to, and no key has been added unmapped', () => {
    expect(Object.keys(copied).sort()).toEqual(Object.keys(MIRRORS).sort());
  });

  for (const [key, token] of Object.entries(MIRRORS)) {
    it(`${key} still equals ${token}`, () => {
      expect(copied[key]?.toLowerCase()).toBe(resolve(tokens, token).toLowerCase());
    });
  }
});
