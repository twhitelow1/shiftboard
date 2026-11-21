// Date/time helpers. All dates are local wall-clock strings: 'YYYY-MM-DD', times 'HH:MM'.
// A shift whose end <= start is treated as ending the next day (overnight / close).

export const pad = (n) => String(n).padStart(2, '0');

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtDate(dt) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

export function dow(s) {
  return parseDate(s).getUTCDay(); // 0 = Sunday
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function weekStart(s, startDow = 1) {
  const diff = (dow(s) - startDow + 7) % 7;
  return addDays(s, -diff);
}

export function range(start, count) {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

export function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function fromMin(m) {
  m = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Absolute minutes since the unix-epoch day of the shift date (for overlap math). */
export function shiftSpan(shift) {
  const base = daysBetween('2000-01-01', shift.date) * 1440;
  const s = toMin(shift.start);
  let e = shift.end ? toMin(shift.end) : s + 7 * 60; // open-ended: nominal 7h

  if (e <= s) e += 1440;
  return [base + s, base + e];
}

export function shiftHours(shift) {
  const [s, e] = shiftSpan(shift);
  return Math.max(0, (e - s - (Number(shift.breakMin) || 0)) / 60);
}

export function overlaps(a, b) {
  const [as, ae] = shiftSpan(a);
  const [bs, be] = shiftSpan(b);
  return as < be && bs < ae;
}

/** '16:00' → '4p', '16:30' → '4:30p' (English, the way schedules write it) · '4 pm', '4:30 pm' (Spanish). */
export function fmtTime(t, lang = 'en') {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  if (lang === 'es') return `${hh}${m ? `:${pad(m)}` : ''} ${h >= 12 ? 'pm' : 'am'}`;
  const suffix = h >= 12 ? 'p' : 'a';
  return m ? `${hh}:${pad(m)}${suffix}` : `${hh}${suffix}`;
}

export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'Thu, Dec 24' (or 'Dec 24' with { dow: false }). With { lang: 'es' }: 'jue, 24 de dic' / '24 dic'. */
export function prettyDate(s, opts = {}) {
  if (opts.lang && opts.lang !== 'en') return formatDate(s, opts.dow === false ? 'dayMonth' : 'short', opts.lang);
  const d = parseDate(s);
  const base = `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
  return opts.dow === false ? base : `${DOW_SHORT[d.getUTCDay()]}, ${base}`;
}

// ---------- dates in a language (Intl), shared by the server, the demo and the web app ----------
/** Intl locales: US English, and US Spanish (12-hour clock, $1,234.50), as the phone app uses. */
export const LOCALES = { en: 'en-US', es: 'es-US' };
const DATE_STYLES = {
  short: { weekday: 'short', month: 'short', day: 'numeric' }, // Thu, Dec 24 · jue, 24 de dic
  long: { weekday: 'long', month: 'long', day: 'numeric' }, // Thursday, December 24 · jueves, 24 de diciembre
  full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
  dayMonth: { month: 'short', day: 'numeric' }, // Dec 24 · 24 dic
  dayMonthYear: { month: 'short', day: 'numeric', year: 'numeric' },
  weekday: { weekday: 'short' }, // Thu · jue
  weekdayLong: { weekday: 'long' }, // Thursday · jueves
  month: { month: 'long' }, // December · diciembre
  monthShort: { month: 'short' }, // Dec · dic
  monthYear: { month: 'long', year: 'numeric' }, // December 2026 · diciembre de 2026
};
const fmtCache = new Map();
/** A 'YYYY-MM-DD' date in a language and style (see DATE_STYLES). Calendar days, so formatted in UTC. */
export function formatDate(s, style = 'short', lang = 'en') {
  const k = `${lang}|${style}`;
  let f = fmtCache.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat(LOCALES[lang] || LOCALES.en, { ...(DATE_STYLES[style] || DATE_STYLES.short), timeZone: 'UTC' }); } catch { f = null; }
    fmtCache.set(k, f);
  }
  return f ? f.format(parseDate(s)) : s;
}
/** Day names in a language: 0 = Sunday. style 'short' (Sun · dom) or 'long' (Sunday · domingo). */
export function dayName(i, style = 'short', lang = 'en') {
  if (lang === 'en') return (style === 'long' ? DOW_LONG : DOW_SHORT)[i];
  return formatDate(fmtDate(new Date(Date.UTC(2023, 0, 1 + i))), style === 'long' ? 'weekdayLong' : 'weekday', lang); // 2023-01-01 was a Sunday
}
/** Month names in a language: 0 = January. style 'long' (January · enero) or 'short' (Jan · ene). */
export function monthName(i, style = 'long', lang = 'en') {
  if (lang === 'en') return style === 'short' ? MONTHS[i].slice(0, 3) : MONTHS[i];
  return formatDate(`2023-${pad(i + 1)}-15`, style === 'short' ? 'monthShort' : 'month', lang);
}

export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
