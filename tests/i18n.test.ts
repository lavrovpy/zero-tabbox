/**
 * Structural tests for the translation catalogs and the locale resolver
 * (design.md D14, `src/i18n.ts`).
 *
 * These are guards, not examples. Nothing here asserts that a particular
 * Ukrainian sentence is good — no test can — but a key forgotten in `uk`, a
 * missing plural form, a dropped `$COUNT$` and a renamed key can all be caught
 * mechanically, and each is otherwise invisible until a user sees it.
 *
 * The catalogs are imported the way `src/i18n.ts` imports them, so these tests
 * read exactly the bytes the bundle would carry.
 */
import { describe, expect, it } from 'bun:test';

import { localeTag, resolveLocale } from '../src/i18n';
import type { Locale } from '../src/types';
import enMessages from '../_locales/en/messages.json';
import ukMessages from '../_locales/uk/messages.json';

/**
 * Spelled out rather than inferred: the JSON import gives each entry its own
 * type, which makes `placeholders` unreadable on the entries that lack it.
 */
interface CatalogEntry {
  readonly message: string;
  readonly placeholders?: Readonly<Record<string, { readonly content: string }>>;
}
type Catalog = Readonly<Record<string, CatalogEntry | undefined>>;

const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: enMessages as unknown as Catalog,
  uk: ukMessages as unknown as Catalog,
};

const LOCALES = Object.keys(CATALOGS) as Locale[];

/**
 * Every CLDR plural category, in the order `Intl` names them.
 *
 * A key is treated as a member of a plural group only if it ends in `_` plus
 * one of these. That is deliberately narrower than "has an underscore":
 * `optionsNoticeOptionOffAriaLabel` must stay a singleton.
 */
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_SUFFIX = new RegExp(`^(.+)_(${PLURAL_FORMS.join('|')})$`);

function splitPluralKey(key: string): { group: string; form: string } | undefined {
  const match = PLURAL_SUFFIX.exec(key);
  if (!match?.[1] || !match[2]) return undefined;
  return { group: match[1], form: match[2] };
}

function pluralGroups(catalog: Catalog): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const key of Object.keys(catalog)) {
    const split = splitPluralKey(key);
    if (!split) continue;
    const forms = groups.get(split.group) ?? new Set<string>();
    forms.add(split.form);
    groups.set(split.group, forms);
  }
  return groups;
}

function singletons(catalog: Catalog): Set<string> {
  return new Set(Object.keys(catalog).filter((key) => !splitPluralKey(key)));
}

function tokensIn(message: string): Set<string> {
  return new Set([...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1]!.toUpperCase()));
}

describe('key parity between the catalogs', () => {
  /**
   * NOT a set comparison of raw keys: `uk` legitimately carries more keys than
   * `en`, because Ukrainian needs a third form (`few`) in every plural group.
   * Comparing singletons key by key and plural groups by GROUP NAME keeps the
   * check strict without failing on real grammar; the forms inside each group
   * are the next describe's job.
   */
  it('defines the same singleton keys in every locale', () => {
    const reference = singletons(CATALOGS.en);
    for (const locale of LOCALES) {
      expect(singletons(CATALOGS[locale]), locale).toEqual(reference);
    }
  });

  it('defines the same plural GROUPS in every locale', () => {
    const reference = new Set(pluralGroups(CATALOGS.en).keys());
    for (const locale of LOCALES) {
      expect(new Set(pluralGroups(CATALOGS[locale]).keys()), locale).toEqual(reference);
    }
    // Guards the guard: if this ever hits 0, the split above stopped
    // recognising plural keys and the singleton test became vacuously narrow.
    expect(reference.size).toBeGreaterThan(0);
  });
});

describe('plural completeness', () => {
  /**
   * 0..200 is well past the point where the pattern repeats (Ukrainian's rule
   * turns on the last two digits) and covers the cases a hand-written list gets
   * wrong: for `uk`, 0 → many, 21 → one, 22 → few.
   *
   * The "no more" half of the comparison matters as much as "no fewer": a
   * `_other` sitting in the Ukrainian catalog would be dead weight that `t()`
   * reaches only for a non-integer count, i.e. never, and would quietly rot.
   */
  const requiredForms = (locale: Locale): Set<string> =>
    new Set(
      Array.from({ length: 201 }, (_, n) => new Intl.PluralRules(localeTag(locale)).select(n)),
    );

  for (const locale of LOCALES) {
    it(`${locale} defines exactly the forms Intl.PluralRules selects`, () => {
      const required = requiredForms(locale);
      expect(required.size).toBeGreaterThan(0);
      for (const [group, forms] of pluralGroups(CATALOGS[locale])) {
        expect(forms, `${locale}: ${group}`).toEqual(required);
      }
    });
  }

  it('agrees with the documented facts about uk and en', () => {
    // Not a substitute for the computed check above — a canary for the day a
    // runtime's CLDR data changes under us, which would silently relax it.
    expect(requiredForms('uk')).toEqual(new Set(['one', 'few', 'many']));
    expect(requiredForms('en')).toEqual(new Set(['one', 'other']));
  });
});

describe('placeholder parity', () => {
  it('declares every $TOKEN$ used in a message', () => {
    // `t()` substitutes tokens itself and never reads `placeholders` (see
    // src/i18n.ts), but the blocks must still be right: they are what makes the
    // catalogs standard-compliant, and what addons-linter checks.
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(CATALOGS[locale])) {
        if (!entry) continue;
        const tokens = tokensIn(entry.message);
        const declared = new Set(
          Object.keys(entry.placeholders ?? {}).map((name) => name.toUpperCase()),
        );
        expect(declared, `${locale}: ${key}`).toEqual(tokens);
      }
    }
  });

  it('uses the same tokens in every locale, except inside plural groups', () => {
    /**
     * The exception for plural groups is real and must NOT be "fixed" by
     * flattening it. Inside a group the forms do not line up one-to-one across
     * languages: English `one` fires only at 1 and can safely say "Bookmark the
     * tab", but Ukrainian's `one` also fires at 21, 31, 101… so
     * `popupBookmarkAll_one` has to show the count. Requiring token equality
     * there would force either an English "Bookmark 1 tab" or a Ukrainian form
     * that reads "21" as "1".
     *
     * The test below re-tightens the plural case, so this is not a hole.
     */
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const [key, entry] of Object.entries(CATALOGS[locale])) {
        const reference = CATALOGS.en[key];
        if (!entry || !reference) continue; // parity is guard 1's job
        if (splitPluralKey(key)) continue;
        expect(tokensIn(entry.message), `${locale}: ${key}`).toEqual(tokensIn(reference.message));
      }
    }
  });

  it('lets a plural form omit the count only when that form means exactly one number', () => {
    /**
     * Skipping plural groups wholesale would also excuse the bug the exemption
     * above is meant to allow for: a Ukrainian `_many` that dropped `$COUNT$`
     * and rendered "закрито вкладок" with no number at all. What separates the
     * two cases is not the language, it is how many integers the form covers —
     * derived from `Intl.PluralRules`, not from a list of locales, so it holds
     * for whatever is added next.
     *
     * Also the only check that catches an invented token inside a plural group:
     * a form may drop a token, never introduce one the group does not have.
     */
    for (const locale of LOCALES) {
      // How many integers each form covers — 1 means "this form names one number".
      const reach = new Map<string, number>();
      const rules = new Intl.PluralRules(localeTag(locale));
      for (let n = 0; n <= 200; n++) {
        const form = rules.select(n);
        reach.set(form, (reach.get(form) ?? 0) + 1);
      }

      for (const [key, entry] of Object.entries(CATALOGS[locale])) {
        const split = entry ? splitPluralKey(key) : undefined;
        if (!entry || !split) continue;

        // The group's vocabulary, taken from English: the tokens the copy is
        // about, independent of which forms this locale happens to have.
        const vocabulary = new Set(
          Object.entries(CATALOGS.en)
            .filter(([other]) => splitPluralKey(other)?.group === split.group)
            .flatMap(([, other]) => [...tokensIn(other?.message ?? '')]),
        );
        const used = tokensIn(entry.message);
        const where = `${locale}: ${key}`;

        for (const token of used) {
          expect(vocabulary.has(token), `${where} uses an unknown $${token}$`).toBe(true);
        }
        if ((reach.get(split.form) ?? 0) > 1) {
          expect(used, `${where} covers many numbers and must show them`).toEqual(vocabulary);
        }
      }
    }
  });

  it('documents the one asymmetry that exists today', () => {
    // If this fails because the Ukrainian copy changed, update the reasoning
    // above; do not delete the test.
    expect(tokensIn(CATALOGS.en.popupBookmarkAll_one!.message)).toEqual(new Set());
    expect(tokensIn(CATALOGS.uk.popupBookmarkAll_one!.message)).toEqual(new Set(['COUNT']));
  });
});

describe('no orphans, no dangling references', () => {
  const ROOT = `${import.meta.dir}/..`;

  /**
   * Documentation must not masquerade as a reference: `src/i18n.ts` spells the
   * annotation syntax out in its JSDoc as `data-i18n-attr="aria-label:key"`,
   * so without this the scan would look for a catalog key literally named
   * `key`.
   *
   * Line comments are only stripped when the `//` starts a line or follows
   * whitespace, so a `https://` inside a string survives intact.
   */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  }

  /**
   * Every catalog key the shipped code asks for, mapped to where it was found,
   * so a failure names the file rather than just the key.
   *
   * `__MSG_key__` in the manifest counts as a reference even though nothing
   * here reads it: the BROWSER substitutes it against `_locales` before we run.
   */
  async function collectReferences(): Promise<Map<string, string[]>> {
    const files = [
      ...new Bun.Glob('src/**/*.ts').scanSync(ROOT),
      ...new Bun.Glob('src/ui/*.html').scanSync(ROOT),
      'src/manifest.base.json',
    ].sort();
    // Globbed rather than listed, so a new page or module is covered the moment
    // it exists; the floor catches a glob that has stopped matching.
    expect(files.length).toBeGreaterThan(5);

    const references = new Map<string, string[]>();
    const note = (key: string, file: string): void => {
      references.set(key, [...(references.get(key) ?? []), file]);
    };

    for (const file of files) {
      const source = stripComments(await Bun.file(`${ROOT}/${file}`).text());
      for (const m of source.matchAll(/\bt\(\s*['"`]([A-Za-z0-9_@]+)['"`]/g)) note(m[1]!, file);
      for (const m of source.matchAll(/data-i18n(?:-title)?="([A-Za-z0-9_@]+)"/g)) note(m[1]!, file);
      for (const m of source.matchAll(/data-i18n-attr="([^"]*)"/g)) {
        // "aria-label:key;title:key" — the same split localizePage() does.
        for (const pair of m[1]!.split(';')) {
          const key = pair.split(':', 2)[1]?.trim();
          if (key) note(key, file);
        }
      }
      for (const m of source.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) note(m[1]!, file);
    }
    return references;
  }

  it('resolves every referenced key against the English catalog', async () => {
    const references = await collectReferences();
    expect(references.size).toBeGreaterThan(20);

    const groups = pluralGroups(CATALOGS.en);
    for (const [key, files] of references) {
      // A plural reference is the STEM: `t('popupSweptUnit', {count})` resolves
      // through `popupSweptUnit_one` and friends, never through a bare key.
      const resolves = CATALOGS.en[key] !== undefined || groups.has(key);
      expect(resolves, `${key} (referenced by ${files.join(', ')})`).toBe(true);
    }
  });

  it('leaves no catalog key unreferenced', async () => {
    const references = await collectReferences();

    // Expanded so that a plural stem vouches for all of its forms.
    const reached = new Set<string>();
    const groups = pluralGroups(CATALOGS.en);
    for (const key of references.keys()) {
      const forms = groups.get(key);
      if (forms) for (const form of forms) reached.add(`${key}_${form}`);
      else reached.add(key);
    }

    // English only: guard 1 already binds every other catalog to this one, so
    // an orphan anywhere is an orphan here.
    expect(Object.keys(CATALOGS.en).filter((key) => !reached.has(key))).toEqual([]);
  });
});

describe('resolveLocale', () => {
  // The browser language is injected, so none of this needs an extension context.
  it("follows the browser under 'auto', matching on prefix and case-insensitively", () => {
    expect(resolveLocale('auto', 'uk')).toBe('uk');
    expect(resolveLocale('auto', 'uk-UA')).toBe('uk');
    expect(resolveLocale('auto', 'UK')).toBe('uk');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
  });

  it('falls back to English when the browser language is unknown or unreadable', () => {
    // '' is exactly what browserUiLanguage() returns outside an extension
    // context, which is where these tests run. "Could not ask" must mean
    // English, never a blank UI and never a guess at Ukrainian.
    expect(resolveLocale('auto', '')).toBe('en');
    expect(resolveLocale('auto', 'de-DE')).toBe('en');
    // Omitting the argument takes the default-parameter path into the platform
    // lookup, which under `bun test` lands on ''.
    expect(resolveLocale('auto')).toBe('en');
    expect(resolveLocale('auto', undefined)).toBe('en');
  });

  it('honours an explicit locale over the browser', () => {
    expect(resolveLocale('uk', 'en-US')).toBe('uk');
    expect(resolveLocale('en', 'uk-UA')).toBe('en');
    expect(resolveLocale('uk', '')).toBe('uk');
    expect(resolveLocale('en', 'uk')).toBe('en');
  });

  it('only ever returns a locale we have a catalog for', () => {
    for (const uiLanguage of ['uk', 'en', 'de-DE', 'ukrainian', 'zz', '']) {
      expect(CATALOGS[resolveLocale('auto', uiLanguage)]).toBeDefined();
    }
  });
});
