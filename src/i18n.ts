/**
 * The UI translation layer (design.md D14).
 *
 * zero-tabbox is localized under TWO regimes on purpose, and the split is the
 * one thing to understand before editing this file:
 *
 *  1. The **manifest** follows the BROWSER's UI language: the browser
 *     substitutes `manifest.base.json`'s `__MSG_*` names from
 *     `_locales/<lang>/messages.json` before we ever run. We have no say in it.
 *  2. The **UI** follows the `locale` SETTING, resolved here. It has to:
 *     `chrome.i18n.getMessage()` reads the browser UI language and cannot be
 *     overridden per call, so a user who wants Ukrainian strings in an English
 *     browser could not be served by it at all.
 *
 * So an English browser with the setting on Ukrainian still shows an English
 * description on chrome://extensions. That is platform-inherent and not a bug
 * to fix: do not "unify" the two regimes by routing UI strings through
 * `chrome.i18n`, which silently deletes the setting. The one part of it we do
 * use is {@link browserUiLanguage}.
 *
 * Catalogs are imported, not fetched, so a page can never paint before it has
 * strings.
 */
import { api } from './platform';
import { getSettings } from './storage';
import type { Locale, LocaleSetting } from './types';
import enMessages from '../_locales/en/messages.json';
import ukMessages from '../_locales/uk/messages.json';

export type { Locale, LocaleSetting } from './types';

/**
 * One entry of a WebExtension `messages.json`. The format's `placeholders` and
 * `description` are absent by design (design.md D14); substitution is ours,
 * see {@link substitute}.
 */
interface CatalogEntry {
  readonly message?: string;
}

/** A parsed `messages.json`, keyed by message name. */
type Catalog = Readonly<Record<string, CatalogEntry | undefined>>;

/** `en` is the fallback for every lookup, and so also the manifest's `default_locale`. */
const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: enMessages as Catalog,
  uk: ukMessages as Catalog,
};

/**
 * The locale every lookup resolves against until {@link initI18n} has run.
 *
 * Module-scope state is forbidden in the background (`src/background.ts`);
 * allowed here for the same reason as `persistAcrossSessionsSupported` in
 * `platform.ts` — a torn-down context that wakes with `'en'` re-reads the
 * setting on the next `initI18n()`, so the worst case is one English string,
 * never a wrong sweep.
 */
let active: Locale = 'en';

/** Keys already warned about, so one missing string cannot flood the console. */
const warned = new Set<string>();

/**
 * The browser's own UI language, e.g. `en-GB`, `uk`, `uk-UA`.
 *
 * Guarded because `api.i18n` is absent in a bare unit-test environment and can
 * throw outside an extension context.
 */
function browserUiLanguage(): string {
  try {
    return api.i18n?.getUILanguage() ?? '';
  } catch {
    return '';
  }
}

/**
 * Resolves the `locale` setting to the locale the UI will actually render in.
 *
 * `'auto'` is a prefix test, not equality: the browser reports `uk` on some
 * builds and `uk-UA` on others, so matching the exact tag would leave half of
 * Ukrainian users on English.
 *
 * @param setting the stored setting
 * @param uiLanguage the browser UI language; defaults to the platform lookup.
 *   Injectable so the `'auto'` branch is unit-testable without a browser.
 * @returns the locale to render in — always one we have a catalog for
 */
export function resolveLocale(setting: LocaleSetting, uiLanguage = browserUiLanguage()): Locale {
  if (setting === 'en' || setting === 'uk') return setting;
  return uiLanguage.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}

/** The locale the UI is currently rendering in. `'en'` before {@link initI18n}. */
export function activeLocale(): Locale {
  return active;
}

/**
 * The BCP-47 tag for `Intl` and `toLocaleString`. Identity today, but every
 * formatting call site goes through it, so a locale id that is not a valid tag
 * has one place to be mapped.
 */
export function localeTag(locale: Locale): string {
  return locale;
}

/**
 * The plural-form keys to try, in order, for a given count.
 *
 * The candidates after `${key}_${form}` are not slack: they cover a non-integer
 * count (`uk` answers `other`, which its catalog has no reason to carry) and the
 * fallback into the English catalog, which has no `few`/`many` at all (D14).
 */
function pluralCandidates(key: string, count: number, locale: Locale): string[] {
  let form = 'other';
  try {
    form = new Intl.PluralRules(localeTag(locale)).select(count);
  } catch {
    // A locale Intl does not know is not a reason to render nothing.
  }
  return [`${key}_${form}`, `${key}_other`, `${key}_many`, key];
}

/**
 * Substitutes `$TOKEN$` placeholders from `params`.
 *
 * The catalogs write `$COUNT$` (the WebExtension convention is upper-case)
 * while callers pass `{count}`, so the match is case-insensitive. An unknown
 * token is left verbatim rather than blanked: a visible `$FOO$` in the UI is a
 * bug report, an empty string is a mystery.
 */
function substitute(message: string, params: Record<string, string | number>): string {
  const byLowerName = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    byLowerName.set(name.toLowerCase(), String(value));
  }
  return message.replace(/\$([A-Za-z0-9_]+)\$/g, (token, name: string) => {
    return byLowerName.get(name.toLowerCase()) ?? token;
  });
}

/** First candidate key that exists in `catalog` with a non-empty message. */
function lookupIn(catalog: Catalog, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const message = catalog[candidate]?.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return undefined;
}

/**
 * Translates `key` against the active locale.
 *
 * Passing a numeric `count` switches the lookup to plural mode: the form comes
 * from `Intl.PluralRules` and the key looked up is `` `${key}_${form}` ``. The
 * same `count` is then also available as a `$COUNT$` placeholder, so a caller
 * never passes the number twice.
 *
 * Never throws and never returns empty: a translation gap must degrade to an
 * odd-looking string, never to a blank UI. Callers can therefore use `t()`
 * unconditionally, without a null check per string.
 *
 * @param key a `messages.json` name, or the stem of a plural group
 * @param params placeholder values; a numeric `count` also selects the form
 * @returns the translated string with placeholders substituted
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const count = params?.count;
  const candidates = typeof count === 'number' ? pluralCandidates(key, count, active) : [key];

  let message = lookupIn(CATALOGS[active], candidates);
  if (message === undefined && active !== 'en') {
    message = lookupIn(CATALOGS.en, candidates);
  }
  if (message === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[zero-tabbox] missing translation for "${key}" (${active})`);
    }
    // Recognisable in a screenshot, and never empty.
    message = key;
  }
  return params ? substitute(message, params) : message;
}

/**
 * Resolves the locale from settings and makes it the active one.
 *
 * Never rejects. A storage failure resolves to `'auto'` — the same answer a
 * fresh install gives — because a page that cannot read its settings must still
 * render text.
 *
 * Also stamps `<html lang>` so the browser hyphenates, spell-checks and speaks
 * the page in the right language. Guarded on `document` because `t()` is used
 * from the background too (the pre-cutoff notification in `badge.ts`), where
 * there is no DOM.
 *
 * @returns the locale now active
 */
export async function initI18n(): Promise<Locale> {
  let setting: LocaleSetting = 'auto';
  try {
    setting = (await getSettings()).locale;
  } catch {
    // Fall through to 'auto'.
  }
  active = resolveLocale(setting);
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = localeTag(active);
    }
  } catch {
    // Nothing to stamp without a DOM.
  }
  return active;
}

/**
 * Applies the active locale to the current document.
 *
 * The markup keeps its English text as the visible default and annotates it:
 *
 *  - `data-i18n="key"` — replaces the element's `textContent`.
 *  - `data-i18n-attr="aria-label:key;title:key"` — sets each named attribute.
 *  - `data-i18n-title="key"` on `<html>` — sets `document.title`. It lives on
 *    the root element, not on `<title>`, because a `data-*` attribute inside
 *    `<head>` is invisible to the usual `querySelectorAll` sweep and easy to
 *    lose in an edit.
 *
 * Only static strings are annotated. Anything the page recomputes (counts,
 * times, error messages) is set from TS with `t()` instead, because the DOM
 * walk runs once.
 *
 * Clearing `data-i18n-pending` from `<html>` is what un-hides the body
 * (`[data-i18n-pending] body` in `src/ui/theme.css`).
 */
export function localizePage(): void {
  const root = document.documentElement;

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (node.dataset.i18nAttr ?? '').split(';')) {
      const [name, key] = pair.split(':', 2);
      const attribute = name?.trim();
      const messageKey = key?.trim();
      if (attribute && messageKey) node.setAttribute(attribute, t(messageKey));
    }
  }

  const titleKey = root.dataset.i18nTitle;
  if (titleKey) document.title = t(titleKey);

  root.removeAttribute('data-i18n-pending');
}

/**
 * The single call each page makes, before it renders anything of its own.
 *
 * Safety-critical in one way: `data-i18n-pending` hides the body until this
 * resolves, so anything that throws before the attribute is cleared leaves the
 * page permanently blank. Hence the `finally` — a failure reveals the
 * untranslated English markup, which is a bad day, not a broken extension.
 *
 * @returns the locale now active, for callers that go on to format numbers
 */
export async function localize(): Promise<Locale> {
  try {
    await initI18n();
    localizePage();
  } catch (error) {
    console.warn('[zero-tabbox] localize failed; leaving the English markup', error);
  } finally {
    try {
      document.documentElement.removeAttribute('data-i18n-pending');
    } catch {
      // The page is already as visible as we can make it.
    }
  }
  return active;
}
