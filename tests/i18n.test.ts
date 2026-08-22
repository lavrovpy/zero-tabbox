/**
 * Structural tests for the translation catalogs and the locale resolver
 * (design.md D14, `src/i18n.ts`).
 *
 * These are guards, not examples. Nothing here asserts that a particular
 * Ukrainian sentence is good — no test can — but four things about the
 * catalogs CAN be checked mechanically, and each of them is a mistake that is
 * otherwise invisible until a user sees it:
 *
 *  1. Key parity — a string added to `en` and forgotten in `uk`.
 *  2. Plural completeness — a Ukrainian group missing its `few` or `many`,
 *     which `t()` would paper over by falling back to English mid-sentence.
 *  3. Placeholder parity — a `$COUNT$` dropped in translation, so the number
 *     silently vanishes from the rendered string.
 *  4. No orphans, no dangling references — the one that earns its keep. It ties
 *     the catalogs to the code that uses them, so an English copy edit that
 *     renames a key fails the build here instead of shipping a UI that is half
 *     Ukrainian and half untranslated.
 *
 * The catalogs are imported the same way `src/i18n.ts` imports them (Bun inlines
 * the JSON), so these tests read exactly the bytes the bundle would carry.
 */
import { describe, expect, it } from 'bun:test';

import { localeTag, resolveLocale } from '../src/i18n';
import type { Locale } from '../src/types';
import enMessages from '../_locales/en/messages.json';
import ukMessages from '../_locales/uk/messages.json';

/**
 * The catalog shape, spelled out rather than inferred. TypeScript infers a
 * distinct object type per entry from the imported JSON, and entries without a
 * `placeholders` block would then make `entry.placeholders` a type error.
 */
interface CatalogEntry {
  readonly message: string;
  readonly description?: string;
  readonly placeholders?: Readonly<Record<string, { readonly content: string }>>;
}
type Catalog = Readonly<Record<string, CatalogEntry | undefined>>;

const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: enMessages as unknown as Catalog,
  uk: ukMessages as unknown as Catalog,
};

/** The locales under test, derived so adding a third catalog extends the suite. */
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

/** `foo_one` → `{ group: 'foo', form: 'one' }`; a singleton → `undefined`. */
function splitPluralKey(key: string): { group: string; form: string } | undefined {
  const match = PLURAL_SUFFIX.exec(key);
  if (!match?.[1] || !match[2]) return undefined;
  return { group: match[1], form: match[2] };
}

/** The plural groups of a catalog: group name → the forms it defines. */
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

/** The keys of a catalog that are NOT part of a plural group. */
function singletons(catalog: Catalog): Set<string> {
  return new Set(Object.keys(catalog).filter((key) => !splitPluralKey(key)));
}

/** The `$TOKEN$` names in a message, upper-cased for comparison. */
function tokensIn(message: string): Set<string> {
  return new Set([...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1]!.toUpperCase()));
}

describe('key parity between the catalogs', () => {
  /**
   * NOT a set comparison of raw keys: `uk` legitimately carries 8 keys more
   * than `en`, because Ukrainian needs a third form (`few`) in every plural
   * group. Comparing the two halves separately — singletons key by key, plural
   * groups by GROUP NAME — is what makes the check strict where it can be and
   * silent where the difference is real grammar. Guard 2 then checks that each
   * group carries the right forms for its own locale.
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
   * The required forms are computed, never hardcoded: whichever categories
   * `Intl.PluralRules` actually produces over the integers are exactly the keys
   * the catalog must define — no more, no fewer.
   *
   * 0..200 is well past the point where the pattern repeats (Ukrainian's rule
   * turns on the last two digits) and covers the cases a hand-written list gets
   * wrong: for `uk`, 0 → many, 21 → one, 22 → few. It yields `{one, few, many}`
   * for `uk` and `{one, other}` for `en` on its own, so a third locale needs no
   * edit here.
   *
   * The "no more" half matters as much as "no fewer": a `_other` sitting in the
   * Ukrainian catalog would be dead weight that `t()` reaches only for a
   * non-integer count, i.e. never, and would quietly rot.
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
     * The general rule is equality: a translation that drops a `$COUNT$` loses
     * the number, and one that invents a token renders a literal `$FOO$`.
     *
     * The exception is real and must NOT be "fixed" by flattening it. Inside a
     * plural group the forms do not line up one-to-one across languages:
     * English `one` fires only at 1 and can safely say "Bookmark the tab", but
     * Ukrainian's `one` also fires at 21, 31, 101… so `popupBookmarkAll_one`
     * has to show the count. Requiring token equality there would force either
     * an English "Bookmark 1 tab" or a Ukrainian form that reads "21" as "1".
     *
     * So: singletons must match exactly; a plural form may carry a token the
     * other locale's same-named form omits. Every token still has to be
     * declared — that is the test above, and it applies to both locales — and
     * the test below re-tightens the plural case along the axis that actually
     * matters, so the exemption here is not a hole.
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
     * The sharp version of the exemption above, and the reason it is safe.
     *
     * Skipping plural groups wholesale would also excuse the bug it is meant to
     * allow for: a Ukrainian `_many` that dropped `$COUNT$` and rendered
     * "закрито вкладок" with no number at all. What separates the two cases is
     * not the language, it is how many integers the form covers.
     *
     * English `one` is selected by exactly one integer — 1 — so "Bookmark the
     * tab" is unambiguous and needs no number. Every Ukrainian form (and
     * English `other`) is selected by many integers, so it MUST show the count.
     * Derived from `Intl.PluralRules`, not from a list of locales, so it holds
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
    // Pinned so the reasoning above stays attached to something real. If this
    // fails because the Ukrainian copy changed, update the comment, do not
    // delete the test.
    expect(tokensIn(CATALOGS.en.popupBookmarkAll_one!.message)).toEqual(new Set());
    expect(tokensIn(CATALOGS.uk.popupBookmarkAll_one!.message)).toEqual(new Set(['COUNT']));
  });
});

describe('no orphans, no dangling references', () => {
  const ROOT = `${import.meta.dir}/..`;

  /**
   * Strips comments so documentation cannot masquerade as a reference.
   *
   * This is not pedantry: `src/i18n.ts` spells out the annotation syntax in its
   * JSDoc as `data-i18n-attr="aria-label:key;title:key"`, and `options.html`
   * repeats it in an HTML comment. Without this the scan would look for a
   * catalog key literally named `key`.
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
   * Every catalog key the shipped code asks for, mapped to where it was found
   * (so a failure names the file rather than just the key).
   *
   * The five reference forms, matching what `src/i18n.ts` and the browser read:
   * `t('key')` from TypeScript, `data-i18n` / `data-i18n-attr` /
   * `data-i18n-title` from the HTML, and `__MSG_key__` from the manifest, which
   * the BROWSER substitutes against `_locales` before we ever run.
   */
  async function collectReferences(): Promise<Map<string, string[]>> {
    const files = [
      ...new Bun.Glob('src/**/*.ts').scanSync(ROOT),
      ...new Bun.Glob('src/ui/*.html').scanSync(ROOT),
      'src/manifest.base.json',
    ].sort();
    // Same discovery style as scripts/run-tests.mjs; a new page or module is
    // covered the moment it exists, with nothing to remember to add here.
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

    // Expand each reference to the concrete keys it can reach, so a plural stem
    // vouches for all of its forms.
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
  // The browser language is injected, so none of this needs an extension
  // context — which is the whole reason resolveLocale takes it as a parameter.
  it("follows the browser under 'auto', matching on prefix and case-insensitively", () => {
    expect(resolveLocale('auto', 'uk')).toBe('uk');
    expect(resolveLocale('auto', 'uk-UA')).toBe('uk');
    expect(resolveLocale('auto', 'UK')).toBe('uk');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
  });

  it('falls back to English when the browser language is unknown or unreadable', () => {
    // '' is exactly what browserUiLanguage() returns outside an extension
    // context, which is where these tests run: no `chrome` global, so the
    // guarded `api.i18n` lookup throws and is swallowed. "Could not ask" must
    // mean English, never a blank UI and never a guess at Ukrainian.
    expect(resolveLocale('auto', '')).toBe('en');
    expect(resolveLocale('auto', 'de-DE')).toBe('en');
    // Omitting the argument takes the default-parameter path into that same
    // platform lookup; under `bun test` it lands on '' and so on English.
    expect(resolveLocale('auto')).toBe('en');
    expect(resolveLocale('auto', undefined)).toBe('en');
  });

  it('honours an explicit locale over the browser', () => {
    // The point of the setting (design.md D14): Ukrainian strings in an English
    // browser, and English strings in a Ukrainian one.
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
