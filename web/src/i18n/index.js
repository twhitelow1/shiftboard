// The web app in English and Spanish.
//
//   t('schedule.publish')                    → 'Publish week' · 'Publicar semana'
//   t('schedule.shiftCount', { count: 3 })   → plural forms { one, other } chosen by count
//   t('team.isAlready', { name: <b>…</b> })  → a React element when a value is JSX
//
// The words are in en.js and es.js (same keys; test/i18n.test.js checks). Spanish: neutral Latin
// American, "tú" (docs/i18n/GLOSSARY.md). Restaurant data (names, positions, areas, notes) is never
// translated. The server writes its own text (notifications, warnings, errors) in each person's
// language: core/messages.js and core/errors.js.
//
// Which language: signed in, the person's own choice (me.language); else the restaurant's default
// (Settings → Language); else the browser's. Signed out: the choice saved on this device, else the
// restaurant's default, else the browser's. main.jsx works it out and keeps it in I18nCtx; components
// read it with useT(). Plain helpers below (t, prettyDate, fmtTime…) use the current language too, for
// code outside components; a component that calls useT() re-renders when the language changes.
import { createContext, createElement, Fragment, useContext, useMemo } from 'react';
import en from './en.js';
import es from './es.js';
import { prettyDate as corePrettyDate, fmtTime as coreFmtTime, formatDate, dayName, monthName } from '../../../core/time.js';
import { pluralForm, formatNumber, formatMoney, formatStamp, isLang } from '../../../core/i18n.js';
import { translateError as coreTranslateError } from '../../../core/errors.js';

export const CATALOGS = { en, es };
export const LANGS = ['en', 'es'];
/** Each language's name, written in that language (for the switch). */
export const LANGUAGE_NAMES = { en: 'English', es: 'Español' };
export { isLang };

let current = 'en';
export const getLang = () => current;
/** Set the language the plain helpers use (main.jsx does this when it changes). */
export function setCurrentLang(lang) {
  current = isLang(lang) ? lang : 'en';
  try { document.documentElement.lang = current; } catch { /* no document (tests) */ }
}

const lookup = (lang, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), CATALOGS[lang]);
export const hasKey = (key) => lookup('en', key) !== undefined;

function fillText(str, params) {
  if (!params || !str.includes('{')) return str;
  const parts = str.split(/\{(\w+)\}/);
  let rich = false;
  for (let i = 1; i < parts.length; i += 2) {
    const k = parts[i];
    if (!(k in params)) { parts[i] = `{${k}}`; continue; }
    const v = params[k];
    if (v != null && typeof v === 'object') { rich = true; parts[i] = v; } else parts[i] = v == null ? '' : String(v);
  }
  return rich ? createElement(Fragment, null, ...parts.filter((p) => p !== '')) : parts.join('');
}
// Simple markup in a string, for words that are bold in a sentence: '<b>{name}</b> wants to trade'.
const TAGS = /<(b|strong|i|em|code|u)>([\s\S]*?)<\/\1>/g;
function fill(str, params) {
  if (!str.includes('</')) return fillText(str, params);
  const out = [];
  let last = 0;
  for (const m of str.matchAll(TAGS)) {
    if (m.index > last) out.push(fillText(str.slice(last, m.index), params));
    out.push(createElement(m[1], null, fillText(m[2], params)));
    last = m.index + m[0].length;
  }
  if (!out.length) return fillText(str, params);
  if (last < str.length) out.push(fillText(str.slice(last), params));
  return createElement(Fragment, null, ...out);
}
/** A catalog string with its markup taken out ('<b>{name}</b> wants…' → '{name} wants…'), for plain-text places. */
export const plainOf = (s) => String(s).replace(/<\/?(b|strong|i|em|code|u)>/g, '');

/** A string from the catalog in a language (English if the key is missing in it), filled in. */
export function translate(lang, key, params) {
  let v = lookup(lang, key);
  if (v === undefined) v = lookup('en', key);
  if (v === undefined) {
    if (import.meta.env?.DEV) console.warn(`i18n: missing key ${key}`);
    return key;
  }
  if (v && typeof v === 'object') v = v[pluralForm(lang, params?.count ?? 0)] ?? v.other;
  return typeof v === 'string' ? fill(v, params) : key;
}

/** t(key, params) in the current language. */
export const t = (key, params) => translate(current, key, params);
/** The same as t, for code where a variable named `t` is in scope. */
export const tx = t;

// ---------- dates, times and numbers in the current language ----------
/** 'Thu, Dec 24' · 'jue, 24 de dic' ({ dow: false }: 'Dec 24' · '24 dic'). */
export const prettyDate = (s, opts = {}) => corePrettyDate(s, { ...opts, lang: current });
/** '4p' · '4 pm'. */
export const fmtTime = (time) => coreFmtTime(time, current);
/** A 'YYYY-MM-DD' date in a style: short, long, full, dayMonth, dayMonthYear, weekday, weekdayLong, month, monthYear. */
export const dateText = (s, style = 'short') => formatDate(s, style, current);
/** Day names (0 = Sunday): 'Sun' · 'dom', 'Sunday' · 'domingo'. */
export const dowShort = (i) => dayName(i, 'short', current);
export const dowLong = (i) => dayName(i, 'long', current);
/** Month names (0 = January): 'January' · 'enero', 'Jan' · 'ene'. */
export const monthLong = (i) => monthName(i, 'long', current);
export const monthShort = (i) => monthName(i, 'short', current);
/** 1234.5 → '1,234.5'. */
export const num = (n, opts) => formatNumber(current, n, opts);
/** Whole dollars: '$1,234'. */
export const moneyText = (n) => formatMoney(current, n);
/** An ISO time: 'Dec 24, 4:30 PM' · '24 dic, 4:30 p.m.' */
export const stamp = (iso, opts) => formatStamp(current, iso, opts);
/** An ISO time's day only: 'Dec 24' · '24 dic'. */
export const stampDay = (iso) => formatStamp(current, iso, { month: 'short', day: 'numeric' });
/** An error message from the server or the demo, in the current language (the server already translates its own). */
export const translateError = (message) => coreTranslateError(message, current);

// ---------- the language, as React state ----------
export const I18nCtx = createContext({ lang: 'en', setLang: () => {}, choice: '' });
/** { lang, setLang(lang | ''), choice }: choice is the person's own pick ('' = not chosen). */
export const useI18n = () => useContext(I18nCtx);

function makeT(lang) {
  const f = (key, params) => translate(lang, key, params);
  f.lang = lang;
  return f;
}
/** t for this component, in the current language; the component re-renders when the language changes. */
export function useT() {
  const { lang } = useContext(I18nCtx);
  return useMemo(() => makeT(lang), [lang]);
}

// ---------- where the choice is kept on this device ----------
const KEY = 'sb_lang';
const UNSAVED = 'sb_lang_unsaved'; // picked while signed out, not yet saved to the account
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
/** The language saved on this device ('' if none). */
export const deviceLang = () => (isLang(read(KEY)) ? read(KEY) : '');
/** Remember a language on this device. unsaved: picked while signed out (saved to the account at sign-in). */
export function saveDeviceLang(lang, { unsaved = false } = {}) {
  write(KEY, isLang(lang) ? lang : null);
  write(UNSAVED, unsaved && isLang(lang) ? String(Date.now()) : null);
}
/** A choice made while signed out in the last 30 minutes, to save to the account that signs in. */
export function unsavedDeviceLang() {
  const at = Number(read(UNSAVED));
  return at && Date.now() - at < 30 * 60 * 1000 ? deviceLang() : '';
}
export const clearUnsaved = () => write(UNSAVED, null);
/** The browser's first language: Spanish for es, es-MX, es-US…, else English. */
export function browserLang() {
  try {
    const first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^es\b/i.test(first) ? 'es' : 'en';
  } catch {
    return 'en';
  }
}
/**
 * The language to show. Signed in (me): their choice, else the restaurant's default, else the browser's.
 * Signed out: this device's choice, else the restaurant's default (from /api/config), else the browser's.
 */
export function resolveLang({ me, settings, configLanguage } = {}) {
  if (me) return isLang(me.language) ? me.language : isLang(settings?.language) ? settings.language : browserLang();
  return deviceLang() || (isLang(configLanguage) ? configLanguage : '') || browserLang();
}
