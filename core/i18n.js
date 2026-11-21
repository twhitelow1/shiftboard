// Languages: English and Spanish (neutral Latin American, "tú"). Shared by the server, the in-browser
// demo and the web app. The words ShiftBoard writes on the server (notifications, emails, texts, errors)
// are in core/messages.js and core/errors.js; the web app's own words are in web/src/i18n/.
//
// Whose language?
//   a person:        their own choice (user.language, saved from the language switch or My Shifts)
//   else:            the restaurant's default (Settings → General → Language: 'en' or 'es')
//   else:            English on the server; the phone's or browser's language in the apps
// Restaurant data (people's names, positions, areas, notes a manager typed) is never translated.
import { LOCALES, prettyDate, fmtTime, formatDate } from './time.js';

export const LANGS = ['en', 'es'];
export const isLang = (v) => v === 'en' || v === 'es';
export { LOCALES };

/** The language ShiftBoard writes to this person in (server side): theirs, the restaurant's, or English. */
export function langOf(user, settings) {
  if (isLang(user?.language)) return user.language;
  if (isLang(settings?.language)) return settings.language;
  return 'en';
}

/** 'Hi {name}' + { name: 'Ana' } → 'Hi Ana'. Unknown placeholders stay as they are. */
export const interpolate = (s, params) => (params ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in params && params[k] != null ? String(params[k]) : m)) : String(s));

/** 'one' or 'other' for a count (English and Spanish both use 'one' for exactly 1). */
export function pluralForm(lang, n) {
  try {
    const f = new Intl.PluralRules(LOCALES[lang] || LOCALES.en).select(Number(n));
    return f === 'one' ? 'one' : 'other';
  } catch {
    return Number(n) === 1 ? 'one' : 'other';
  }
}
/** Pick the form of { one, other } for a count. */
export const plural = (lang, forms, n) => (forms && typeof forms === 'object' ? forms[pluralForm(lang, n)] ?? forms.other : forms);

const numCache = new Map();
function numberFormat(lang, opts) {
  const k = `${lang}|${JSON.stringify(opts)}`;
  if (!numCache.has(k)) {
    let f = null;
    try { f = new Intl.NumberFormat(LOCALES[lang] || LOCALES.en, opts); } catch { /* plain String below */ }
    numCache.set(k, f);
  }
  return numCache.get(k);
}
/** 1234.5 → '1,234.5' (en and es-US both group with commas and use a decimal point). */
export function formatNumber(lang, n, opts = { maximumFractionDigits: 1 }) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const f = numberFormat(lang, opts);
  return f ? f.format(Number(n)) : String(n);
}
/** Whole dollars: 1234.4 → '$1,234' (the same in both languages for US restaurants). */
export const formatMoney = (lang, n) => (n == null ? '—' : `$${formatNumber(lang, Math.round(n), { maximumFractionDigits: 0 })}`);

const stampCache = new Map();
/** An ISO time as a short date and time: 'Dec 24, 4:30 PM' · '24 dic, 4:30 p.m.' */
export function formatStamp(lang, iso, opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) {
  if (!iso) return '';
  const k = `${lang}|${JSON.stringify(opts)}`;
  try {
    if (!stampCache.has(k)) stampCache.set(k, new Intl.DateTimeFormat(LOCALES[lang] || LOCALES.en, opts));
    return stampCache.get(k).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 16).replace('T', ' ');
  }
}

/** Dates and times in a language, for code that writes text for someone (see core/messages.js). */
export const dates = (lang) => ({
  day: (s) => prettyDate(s, { lang }), // Thu, Dec 24 · jue, 24 de dic
  dayMonth: (s) => prettyDate(s, { lang, dow: false }), // Dec 24 · 24 dic
  long: (s) => formatDate(s, 'long', lang),
  time: (t) => fmtTime(t, lang), // 4p · 4 pm
});

/**
 * Text that differs by language, for notify() and anything else written for one person:
 *   'plain text'               the same for everyone (rare: restaurant data only)
 *   (lang) => text             a function of the language
 *   { en: '…', es: '…' }       both versions
 * Returns the text in `lang`.
 */
export function render(spec, lang = 'en') {
  if (typeof spec === 'function') return String(spec(lang) ?? '');
  if (spec && typeof spec === 'object') return String(spec[lang] ?? spec.en ?? '');
  return String(spec ?? '');
}
/** Every language's version of a spec ({ en, es }), or null when it's one plain text. */
export function renderAll(spec) {
  if (typeof spec !== 'function' && !(spec && typeof spec === 'object')) return null;
  return Object.fromEntries(LANGS.map((l) => [l, render(spec, l)]));
}
