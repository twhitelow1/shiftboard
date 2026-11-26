// Seasons for reports (trades and pickups, positive impact…): a restaurant's year split into named seasons,
// by default Winter (November–April) and Summer (May–October). Settings can change the months
// (settings.seasons: [{ key, startMonth, endMonth }], months 1–12, each season from the 1st of startMonth
// through the last day of endMonth; together they cover the year). A season that crosses New Year is named by
// both years ("Winter 2025–26") and keyed by the year it starts in ("winter-2025").

export const DEFAULT_SEASONS = [
  { key: 'winter', startMonth: 11, endMonth: 4 },
  { key: 'summer', startMonth: 5, endMonth: 10 },
];
const NAMES = { winter: { en: 'Winter', es: 'Invierno' }, summer: { en: 'Summer', es: 'Verano' },
  spring: { en: 'Spring', es: 'Primavera' }, fall: { en: 'Fall', es: 'Otoño' } };

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1–12
const monthsIn = (s) => { const out = []; for (let m = s.startMonth, i = 0; i < 12; i++) { out.push(m); if (m === s.endMonth) break; m = (m % 12) + 1; } return out; };

/** The restaurant's seasons, checked: every month in exactly one season; otherwise the defaults. */
export function seasonsOf(settings) {
  const list = Array.isArray(settings?.seasons) && settings.seasons.length ? settings.seasons : DEFAULT_SEASONS;
  const clean = list.map((s) => ({ key: String(s.key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''), label: s.label ? String(s.label).trim().slice(0, 40) : '',
    startMonth: Math.trunc(Number(s.startMonth)), endMonth: Math.trunc(Number(s.endMonth)) }));
  const ok = clean.every((s) => s.key && s.startMonth >= 1 && s.startMonth <= 12 && s.endMonth >= 1 && s.endMonth <= 12)
    && new Set(clean.map((s) => s.key)).size === clean.length;
  const counted = ok ? clean.flatMap(monthsIn) : [];
  return ok && counted.length === 12 && new Set(counted).size === 12 ? clean : DEFAULT_SEASONS.map((s) => ({ ...s, label: '' }));
}

/** A season's display name in a language ("Winter", "Invierno", or the restaurant's own label). */
export const seasonName = (s, lang = 'en') => s.label || NAMES[s.key]?.[lang] || NAMES[s.key]?.en || s.key;

/** The season instance a date (YYYY-MM-DD) falls in: { id, key, start, end, label } e.g. winter-2025, 2025-11-01…2026-04-30. */
export function seasonOf(date, settings, lang = 'en') {
  const [y, m] = String(date).split('-').map(Number);
  const s = seasonsOf(settings).find((x) => monthsIn(x).includes(m));
  const crosses = s.startMonth > s.endMonth;
  const startYear = crosses && m <= s.endMonth ? y - 1 : y;
  return instance(s, startYear, lang);
}

function instance(s, startYear, lang) {
  const crosses = s.startMonth > s.endMonth;
  const endYear = crosses ? startYear + 1 : startYear;
  const name = seasonName(s, lang);
  return {
    id: `${s.key}-${startYear}`, key: s.key, startYear,
    start: `${startYear}-${pad(s.startMonth)}-01`,
    end: `${endYear}-${pad(s.endMonth)}-${pad(lastDay(endYear, s.endMonth))}`,
    label: crosses ? `${name} ${startYear}–${String(endYear).slice(2)}` : `${name} ${startYear}`,
  };
}

/** A season instance by id ("summer-2026"), or null. */
export function seasonById(id, settings, lang = 'en') {
  const m = /^([a-z0-9_-]+)-(\d{4})$/.exec(String(id || ''));
  if (!m) return null;
  const s = seasonsOf(settings).find((x) => x.key === m[1]);
  return s ? instance(s, Number(m[2]), lang) : null;
}

/** Season instances overlapping [from, to] (YYYY-MM-DD), newest first: for a season picker. */
export function seasonsBetween(from, to, settings, lang = 'en') {
  const out = [];
  let cur = seasonOf(to, settings, lang);
  for (let i = 0; i < 40 && cur.end >= from; i++) {
    out.push(cur);
    const d = new Date(`${cur.start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cur = seasonOf(d.toISOString().slice(0, 10), settings, lang);
  }
  return out;
}
