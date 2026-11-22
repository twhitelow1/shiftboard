// English and Spanish. The app follows the phone's language (expo-localization) until the
// person picks one with the language button (top right of every screen) or More → Language.
// The choice is saved on the phone, and on the server (account.preferences) once signed in.
import { getLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { APP_NAME } from '@/brand';
import { getItem, setItem } from '@/lib/storage';
import { parseDate } from '@/lib/time';
import en from './en';
import es from './es';

export type Lang = 'en' | 'es';
export const LANGS: Lang[] = ['en', 'es'];

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof en>;
type Plural = { one: string; other: string };

// 'a.b.c' keys for strings, and separately for { one, other } plurals.
type Keys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends Plural ? never : Keys<T[K], `${P}${K}.`>;
}[keyof T & string];
type PluralKeys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? never : T[K] extends Plural ? `${P}${K}` : PluralKeys<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MsgKey = Keys<Messages>;
export type PluralKey = PluralKeys<Messages>;

const CATALOGS: Record<Lang, Messages> = { en, es };
/** Intl locales for dates and numbers: US English, and US Spanish formats (12-hour clock). */
const INTL: Record<Lang, string[]> = { en: ['en-US'], es: ['es-US', 'es-419', 'es'] };

export function phoneLanguage(): Lang {
  try {
    return getLocales()[0]?.languageCode === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

const lookup = (lang: Lang, key: string): unknown => key.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), CATALOGS[lang]);
/** Fills {name} placeholders; {app} is always the app's name (mobile/brand.js). */
const fill = (s: string, params?: Record<string, string | number>) => {
  const all: Record<string, string | number> = { app: APP_NAME, ...params };
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
};

export function translate(lang: Lang, key: MsgKey, params?: Record<string, string | number>): string {
  const v = lookup(lang, key) ?? lookup('en', key);
  return typeof v === 'string' ? fill(v, params) : key;
}

/** Plurals: "1 shift" / "3 shifts", "1 turno" / "3 turnos". English and Spanish both use one for exactly 1. */
export function translatePlural(lang: Lang, key: PluralKey, count: number, params?: Record<string, string | number>): string {
  const v = (lookup(lang, key) ?? lookup('en', key)) as Plural | undefined;
  if (!v) return key;
  return fill(count === 1 ? v.one : v.other, { count: formatNumber(lang, count), ...params });
}

export function formatNumber(lang: Lang, n: number): string {
  try {
    return new Intl.NumberFormat(INTL[lang], { maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(Math.round(n * 10) / 10);
  }
}

export type DateStyle = 'short' | 'long' | 'dayMonth' | 'weekday' | 'weekdayLong' | 'monthYear' | 'day';
const DATE_OPTS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { weekday: 'short', month: 'short', day: 'numeric' }, // Thu, Dec 24 · jue, 24 de dic
  long: { weekday: 'long', month: 'long', day: 'numeric' }, // Thursday, December 24 · jueves, 24 de diciembre
  dayMonth: { month: 'short', day: 'numeric' }, // Dec 24 · 24 dic
  weekday: { weekday: 'short' }, // Thu · jue
  weekdayLong: { weekday: 'long' },
  monthYear: { month: 'long', year: 'numeric' }, // December 2026 · diciembre de 2026
  day: { day: 'numeric' },
};
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** A 'YYYY-MM-DD' date in the person's language. Dates are calendar days, so they're formatted in UTC. */
export function formatDate(lang: Lang, date: string, style: DateStyle = 'short'): string {
  const k = `${lang}|${style}`;
  try {
    let f = fmtCache.get(k);
    if (!f) fmtCache.set(k, (f = new Intl.DateTimeFormat(INTL[lang], { ...DATE_OPTS[style], timeZone: 'UTC' })));
    return f.format(parseDate(date));
  } catch {
    return date;
  }
}

/** A time of day the way schedules write it: 4p, 4:30p (English) · 4 pm, 4:30 pm (Spanish). */
export function formatTime(lang: Lang, t: string | null | undefined): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m ? `:${String(m).padStart(2, '0')}` : '';
  return lang === 'es' ? `${hh}${mm} ${h >= 12 ? 'pm' : 'am'}` : `${hh}${mm}${h >= 12 ? 'p' : 'a'}`;
}

/** An ISO timestamp as a short date and time, for notifications and requests. */
export function formatStamp(lang: Lang, iso: string): string {
  try {
    return new Intl.DateTimeFormat(INTL[lang], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

interface I18n {
  lang: Lang;
  /** The saved choice, or null when following the phone. */
  chosen: Lang | null;
  /** Pick a language (null = follow the phone). sync: false when the value came from the server. */
  setLang: (lang: Lang | null, opts?: { sync?: boolean }) => void;
  /** Counts the person's own changes, so the server copy is only updated when they pick one. */
  changes: number;
  t: (key: MsgKey, params?: Record<string, string | number>) => string;
  tn: (key: PluralKey, count: number, params?: Record<string, string | number>) => string;
  date: (date: string, style?: DateStyle) => string;
  time: (t: string | null | undefined) => string;
  num: (n: number) => string;
  stamp: (iso: string) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Lang | null>(null);
  const [changes, setChanges] = useState(0);
  const [phone] = useState<Lang>(phoneLanguage);
  useEffect(() => {
    getItem('language').then((v) => { if (v === 'en' || v === 'es') setChosen(v); });
  }, []);
  const setLang = useCallback((l: Lang | null, { sync = true }: { sync?: boolean } = {}) => {
    setChosen(l);
    setItem('language', l).catch(() => {});
    if (sync) setChanges((n) => n + 1);
  }, []);
  const lang = chosen || phone;
  const value = useMemo<I18n>(() => ({
    lang, chosen, setLang, changes,
    t: (key, params) => translate(lang, key, params),
    tn: (key, count, params) => translatePlural(lang, key, count, params),
    date: (d, style) => formatDate(lang, d, style),
    time: (t) => formatTime(lang, t),
    num: (n) => formatNumber(lang, n),
    stamp: (iso) => formatStamp(lang, iso),
  }), [lang, chosen, setLang, changes]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

