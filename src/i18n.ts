/**
 * The UI translation layer (design.md D14).
 *
 * zero-tabbox is localized under TWO regimes on purpose, and the split is the
 * one thing to understand before editing this file:
 *
 *  1. The **manifest** follows the BROWSER's UI language. `manifest.base.json`
 *     carries `__MSG_extDescription__` / `__MSG_commandEndDayNow__` and
 *     `"default_locale": "en"`, and the browser substitutes them from
 *     `_locales/<lang>/messages.json` before we ever run. We have no say in it.
 *  2. The **UI** follows the `locale` SETTING, resolved here. It has to: the
 *     platform's own `chrome.i18n.getMessage()` reads the browser UI language
 *     and cannot be overridden per call, so a user who wants Ukrainian strings
 *     in an English browser could not be served by it at all.
 *
 * The visible consequence — an English browser with the setting on Ukrainian
 * still shows an English description on chrome://extensions — is inherent to
 * the platform, is recorded in design.md D14, and is NOT a bug to fix. Do not
 * "unify" the two regimes by routing UI strings through `chrome.i18n`; that
 * silently deletes the setting.
 *
 * The one part of `chrome.i18n` we do use is {@link browserUiLanguage} —
 * reading the browser's language is exactly what `i18n.getUILanguage()` is for.
 *
 * Catalogs are imported, not fetched: Bun inlines the JSON at build time, so a
 * page never has a moment where it has painted but has no strings, and there is
 * no network/`runtime.getURL` failure mode to handle.
 */
import { api } from './platform';
import { getSettings } from './storage';
import type { Locale, LocaleSetting } from './types';
import enMessages from '../_locales/en/messages.json';
import ukMessages from '../_locales/uk/messages.json';

/**
 * `Locale` and `LocaleSetting` are DEFINED in `types.ts`, not here, and only
 * re-exported for callers who think of them as i18n concepts. The direction
 * matters: this module imports `getSettings` from `storage.ts` at runtime and
 * `storage.ts` imports `types.ts`, so defining the types here and importing
 * them into `types.ts` would close a module cycle. `types.ts` depends on
 * nothing, which is what keeps it the single source of truth for stored shapes.
 */
export type { Locale, LocaleSetting } from './types';

/**
 * One entry of a WebExtension `messages.json`. `placeholders` exists in the
 * files so the catalogs stay standard-compliant and pass addons-linter, but
 * nothing here reads it: substitution is ours, see {@link substitute}.
 *
 * The optional `description` the format allows is deliberately absent from
 * both catalogs. It is translator context, and the catalogs are inlined into
 * all four bundles — carrying it cost ~61 KB of prose per bundle that the
 * service worker re-parsed on every alarm wake. The context lives in the key
 * names instead (design.md D14).
 */
interface CatalogEntry {
  readonly message?: string;
}

/** A parsed `messages.json`, keyed by message name. */
type Catalog = Readonly<Record<string, CatalogEntry | undefined>>;

/**
 * The bundled catalogs. `en` doubles as the fallback for every lookup, which is
 * why it is also the manifest's `default_locale`.
 */
const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: enMessages as Catalog,
  uk: ukMessages as Catalog,
};

/**
 * The locale every lookup resolves against until {@link initI18n} has run.
 *
 * Module-scope state is forbidden in the background (see the rules at the top
 * of `src/background.ts`) and rationed elsewhere. This one is allowed for the
 * same reason as `persistAcrossSessionsSupported` in `platform.ts`: it is
 * derived, it is cheap to recompute, and nothing's correctness depends on it
 * surviving. A torn-down background context that wakes with `'en'` still shows
 * the right notification the moment `initI18n()` re-reads the setting; the
 * worst case is one English string, never a wrong sweep.
 */
let active: Locale = 'en';

/** Keys already warned about, so one missing string cannot flood the console. */
const warned = new Set<string>();

/**
 * The browser's own UI language, e.g. `en-GB`, `uk`, `uk-UA`.
 *
 * Guarded: `api.i18n` is absent in a bare unit-test environment and can throw
 * outside an extension context. A failure here means "we could not ask", which
 * for {@link resolveLocale} is the same as "not Ukrainian".
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
 * `'auto'` means "follow the browser", which is a prefix test, not equality:
 * the real values are `uk` on some builds and `uk-UA` on others, and matching
 * only the exact tag would leave half of Ukrainian users on English.
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
 * The BCP-47 tag for `Intl` and `toLocaleString`.
 *
 * A seam, not a formality: our locale ids happen to be valid tags today, so
 * this is the identity function, but a future `pt-BR` would not be — and every
 * number- and date-formatting call site already goes through here.
 */
export function localeTag(locale: Locale): string {
  return locale;
}

/**
 * The plural-form keys to try, in order, for a given count.
 *
 * Plural groups are underscore-suffixed sibling keys (`foo_one`, `foo_few`,
 * `foo_many`, `foo_other`) because `messages.json` names are restricted to
 * `A-Za-z0-9_@` — a dot would be rejected by the browser and by addons-linter.
 *
 * `Intl.PluralRules` picks the form. Over integers `uk` produces exactly
 * `one`/`few`/`many` (0 → many, 21 → one, 22 → few) and `en` exactly
 * `one`/`other`, so the selected key normally exists. The extra candidates
 * cover the cases where it does not: a non-integer count (`uk` then answers
 * `other`, which the Ukrainian catalog has no reason to carry), and the
 * fallback into the English catalog, which has no `few`/`many` at all.
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
 * Never throws and never returns empty. A key missing from the active catalog
 * falls back to English, then to the key itself, and warns once — a translation
 * gap must degrade to an odd-looking string, never to a blank UI. Callers can
 * therefore use `t()` unconditionally, without a null check per string.
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
    // The key itself: recognisable in a screenshot, and never empty.
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
    // getSettings is already total; this is belt and braces for the one call
    // that must not be able to reject.
  }
  active = resolveLocale(setting);
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = localeTag(active);
    }
  } catch {
    // Nothing about a missing DOM should stop the background translating.
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
 * Finally clears `data-i18n-pending` from `<html>`, which is what un-hides the
 * body (see `[data-i18n-pending] body` in `src/ui/theme.css`).
 */
export function localizePage(): void {
  const root = document.documentElement;

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    // "aria-label:key;title:key" — pairs separated by ';', name and key by ':'.
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
 * `data-i18n-pending` hides the body until this resolves, so nobody sees the
 * English markup flash to Ukrainian. That makes this function safety-critical
 * in one specific way: if it could throw before clearing the attribute, the
 * page would stay permanently blank. Hence the `finally` — a failure reveals
 * the untranslated English markup, which is a bad day, not a broken extension.
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
      // Truly nothing left to do; the page is already as visible as we can make it.
    }
  }
  return active;
}
