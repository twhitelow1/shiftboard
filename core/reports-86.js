// Reports → 86 List (managers and up): the ingredients and supplies the restaurant is missing now, what ran out and
// how often over a date range or a season, and this season against the same season last year.
//
// Each tab is one RPC that does the work on the server and sends back a small answer (the browser never gets the
// raw log): reports.eightySix.missing.get, reports.eightySix.history.get, reports.eightySix.trends.get. They're
// spread into the 86 List's API (core/eighty-six.js), which hands over its helpers (the lists, item views, the
// nightly reset). The plan needs both `reports` and `eightySix` (server/platform/plans.js); people need
// canSeeReports (core/reports.js). Managers see every list here, hidden ones too.
//
// The pure parts (grouping, durations, the shopping list, CSV, the history numbers) are exported for the web page
// (it builds the shopping list and the CSV files in the reader's language) and for the tests.
//
// An "episode" is one time an item was on a list: from the report until Back in stock (eightySixLog), or still on it
// (eightySixItems). It counts as out when it ran out at some point (outAt), else as low (ran low and was restocked in
// time). Time out is from outAt until it came back; nightly resets and removed lists don't count toward it.
import { todayStr, addDays, daysBetween, dow } from './time.js';
import { seasonOf, seasonById, seasonsBetween } from './seasons.js';
import { canSeeReports } from './reports.js';

export const REPEAT_MIN = 3; // "out 6 times this season" lists items out at least this often
export const MAX_MISSING = 1000;
export const MAX_ITEMS = 500;
const MAX_SPAN_DAYS = 731;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The report's own words in each language (the shopping list and the CSV files). Item names stay as typed. */
export const TEXT = {
  en: {
    out: 'OUT', low: 'LOW', left: (n) => `${n} left`, noCategory: 'No category',
    title: (date, place) => `${place ? `${place}: what` : 'What'} we need${date ? ` · ${date}` : ''}`,
    nothing: 'Nothing is out or running low.',
    statusOut: '86’d (out)', statusLow: 'Running low', yes: 'yes', no: 'no',
    missingCols: ['Status', 'Item', 'Category', 'List', 'Left', 'Missing since', 'Hours missing', 'Reported by', 'Note', 'Photos'],
    historyCols: ['Item', 'Category', 'Lists', 'Times out', 'Times low', 'Total hours out', 'Average hours out', 'Out now', 'Last time'],
  },
  es: {
    out: 'AGOTADO', low: 'QUEDA POCO', left: (n) => (n === 1 ? 'queda 1' : `quedan ${n}`), noCategory: 'Sin categoría',
    title: (date, place) => `${place ? `${place}: lo que` : 'Lo que'} necesitamos${date ? ` · ${date}` : ''}`,
    nothing: 'No se ha acabado nada.',
    statusOut: 'Se acabó (86)', statusLow: 'Queda poco', yes: 'sí', no: 'no',
    missingCols: ['Estado', 'Artículo', 'Categoría', 'Lista', 'Quedan', 'Falta desde', 'Horas faltando', 'Lo reportó', 'Nota', 'Fotos'],
    historyCols: ['Artículo', 'Categoría', 'Listas', 'Veces agotado', 'Veces que quedó poco', 'Horas agotado en total', 'Horas agotado en promedio', 'Agotado ahora', 'Última vez'],
  },
};
const T = (lang) => TEXT[lang] || TEXT.en;

// ---------- small helpers ----------
const letters = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
/** Whole minutes from a to b (never negative). */
export const minutesBetween = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : 0);
/** When an item on a list now went out (or low): the start of "how long it's been missing". */
export const sinceOf = (it) => (it.status === 'out' ? it.outAt || it.reportedAt : it.lowAt || it.reportedAt) || it.updatedAt || null;
const catName = (cats, id, lang) => { const c = cats.find((x) => x.id === id); return c ? (lang === 'es' ? c.nameEs || c.name : c.name) : ''; };
const listLabel = (l, lang) => (lang === 'es' && l?.nameEs ? l.nameEs : l?.name || '');
const byName = (lang) => (a, b) => String(a.name).localeCompare(String(b.name), lang === 'es' ? 'es' : 'en', { sensitivity: 'base' });

/**
 * What's missing now, in groups: by category (the restaurant's order, then "No category") or by list (the lists'
 * order). In each group 86'd first, then running low; the longest missing first. Items need { listId, status,
 * category, since }. Returns [{ id, label, out, low, items }].
 */
export function groupMissing(items, { by = 'category', categories = [], lists = [], lang = 'en' } = {}) {
  const known = new Set(categories.map((c) => c.id));
  const gid = (it) => (by === 'list' ? it.listId : known.has(it.category) ? it.category : '');
  const order = by === 'list' ? lists.map((l) => l.id) : [...categories.map((c) => c.id), ''];
  const groups = new Map();
  for (const it of items) {
    const id = gid(it);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(it);
  }
  const urgency = (a, b) => (a.status === b.status ? 0 : a.status === 'out' ? -1 : 1) || String(a.since || '').localeCompare(String(b.since || ''));
  const label = (id) => (by === 'list' ? listLabel(lists.find((l) => l.id === id), lang) : id ? catName(categories, id, lang) : T(lang).noCategory);
  const ids = [...order.filter((id) => groups.has(id)), ...[...groups.keys()].filter((id) => !order.includes(id))];
  return ids.map((id) => {
    const list = groups.get(id).sort(urgency);
    return { id, label: label(id), out: list.filter((i) => i.status === 'out').length, low: list.filter((i) => i.status === 'low').length, items: list };
  });
}

/**
 * The shopping list: what to order, by category, ready to paste in a text to the vendor or print.
 *   What we need · Thu, Nov 26
 *
 *   PRODUCE
 *   OUT: limes, mint · LOW: lemons (2 left)
 * The same item on two lists is one line: out if it's out on either, else the smallest count left.
 */
export function shoppingList(items, { categories = [], lang = 'en', date = '', place = '' } = {}) {
  const W = T(lang);
  const merged = new Map();
  for (const it of items) {
    const k = letters(it.name);
    if (!k) continue;
    const m = merged.get(k);
    if (!m) { merged.set(k, { name: it.name, category: it.category || '', status: it.status, count: it.status === 'low' ? it.count ?? null : null, listId: it.listId }); continue; }
    if (it.status === 'out') { m.status = 'out'; m.count = null; } else if (m.status === 'low' && it.count != null) m.count = m.count == null ? it.count : Math.min(m.count, it.count);
    if (!m.category && it.category) m.category = it.category;
  }
  const lines = [W.title(date, place)];
  if (!merged.size) return [...lines, '', W.nothing].join('\n');
  for (const g of groupMissing([...merged.values()], { by: 'category', categories, lang })) {
    const outs = g.items.filter((i) => i.status === 'out').sort(byName(lang)).map((i) => i.name);
    const lows = g.items.filter((i) => i.status === 'low').sort(byName(lang)).map((i) => (i.count != null ? `${i.name} (${W.left(i.count)})` : i.name));
    lines.push('', g.label.toLocaleUpperCase(lang), [outs.length ? `${W.out}: ${outs.join(', ')}` : '', lows.length ? `${W.low}: ${lows.join(', ')}` : ''].filter(Boolean).join(' · '));
  }
  return lines.join('\n');
}

// ---------- CSV ----------
/** One CSV cell: quoted; a leading = + - @ is neutralised so a spreadsheet never runs typed text as a formula. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
/** Rows → CSV text, with a byte-order mark so spreadsheet apps read accents (Spanish) right. */
export const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const hours = (min) => (min == null ? '' : (Math.round((min / 60) * 10) / 10).toFixed(1));

/** Missing now as CSV: one row per item on a list. `stampOf(iso)` formats a time (the page passes its own). */
export function missingCsv(items, { categories = [], lists = [], lang = 'en', now = new Date().toISOString(), stampOf = (iso) => iso || '' } = {}) {
  const W = T(lang);
  const rows = [W.missingCols];
  for (const it of items) {
    const list = lists.find((l) => l.id === it.listId);
    rows.push([
      it.status === 'out' ? W.statusOut : W.statusLow, it.name, it.category ? catName(categories, it.category, lang) : '', list ? listLabel(list, lang) : it.listName || '',
      it.status === 'low' && it.count != null ? it.count : '', stampOf(it.since), hours(minutesBetween(it.since, now)),
      it.reportedBy?.name || '', it.note || '', (it.photos || []).length || '',
    ]);
  }
  return toCsv(rows);
}

/** The history's items as CSV: how often each one ran out or low, and for how long. */
export function historyCsv(stats, { categories = [], lists = [], lang = 'en', stampOf = (iso) => iso || '' } = {}) {
  const W = T(lang);
  const rows = [W.historyCols];
  for (const it of stats.items || []) {
    rows.push([
      it.name, it.category ? catName(categories, it.category, lang) : '', it.lists.map((id) => listLabel(lists.find((l) => l.id === id), lang)).filter(Boolean).join(', '),
      it.outs, it.lows, it.backs ? hours(it.outMinutes) : '', it.backs ? hours(it.avgOutMinutes) : '', it.stillOut ? W.yes : W.no, stampOf(it.lastAt),
    ]);
  }
  return toCsv(rows);
}

// ---------- history numbers ----------
/** One time an item was on a list: when it started (it ran out, else it was reported), what it was, time out. */
export function episodeOf(r) {
  const out = !!r.outAt;
  const at = (out ? r.outAt : r.reportedAt) || r.reportedAt || r.updatedAt || '';
  const back = !r.active && r.clearedHow === 'back' && !!r.clearedAt;
  return {
    at, day: at ? todayStr(new Date(at)) : '', kind: out ? 'out' : 'low',
    outMinutes: out && back ? minutesBetween(r.outAt, r.clearedAt) : null,
    stillOut: !!r.active && r.status === 'out', stillLow: !!r.active && r.status === 'low',
  };
}

/**
 * The numbers for one date range (YYYY-MM-DD, both days included, the restaurant's time): totals, each item (most
 * often first), by list, by category, by day of the week, repeat offenders and who reports most.
 * rows: items on lists now ({ ...item, active: true }) and the log. keyOf(name) groups an item's reports (its name,
 * whatever list or spelling case); categoryOf(r) is its category; nameOf(userId) a person's name.
 */
export function eightySixStats(rows, { from, to, keyOf = (n) => letters(n), categoryOf = (r) => r.category || '', nameOf = () => '', limit = MAX_ITEMS } = {}) {
  const totals = { reports: 0, outs: 0, lows: 0, items: 0, backs: 0, outMinutes: 0, avgOutMinutes: null, stillOut: 0, stillLow: 0 };
  const items = new Map();
  const byList = new Map();
  const byCategory = new Map();
  const byWeekday = Array.from({ length: 7 }, (_, d) => ({ dow: d, outs: 0, lows: 0 }));
  const reporters = new Map();
  for (const r of rows) {
    const e = episodeOf(r);
    if (!e.day || e.day < from || e.day > to) continue;
    const k = keyOf(r.name);
    if (!k) continue;
    const isOut = e.kind === 'out';
    const cat = categoryOf(r) || '';
    totals.reports++;
    totals[isOut ? 'outs' : 'lows']++;
    if (e.outMinutes != null) { totals.backs++; totals.outMinutes += e.outMinutes; }
    if (e.stillOut) totals.stillOut++;
    if (e.stillLow) totals.stillLow++;
    const it = items.get(k) || { key: k, name: r.name, category: '', lists: [], outs: 0, lows: 0, outMinutes: 0, backs: 0, avgOutMinutes: null, lastAt: '', stillOut: false };
    it[isOut ? 'outs' : 'lows']++;
    if (e.outMinutes != null) { it.backs++; it.outMinutes += e.outMinutes; }
    if (e.stillOut) it.stillOut = true;
    if (!it.lists.includes(r.listId)) it.lists.push(r.listId);
    if (e.at >= it.lastAt) { it.lastAt = e.at; it.name = r.name; if (cat) it.category = cat; } else if (!it.category && cat) it.category = cat;
    items.set(k, it);
    const l = byList.get(r.listId) || { listId: r.listId, listName: r.listName || '', outs: 0, lows: 0, outMinutes: 0, backs: 0 };
    l[isOut ? 'outs' : 'lows']++;
    if (e.outMinutes != null) { l.backs++; l.outMinutes += e.outMinutes; }
    byList.set(r.listId, l);
    const c = byCategory.get(cat) || { category: cat, outs: 0, lows: 0 };
    c[isOut ? 'outs' : 'lows']++;
    byCategory.set(cat, c);
    byWeekday[dow(e.day)][isOut ? 'outs' : 'lows']++;
    if (r.reportedBy) {
      const p = reporters.get(r.reportedBy) || { id: r.reportedBy, name: nameOf(r.reportedBy), reports: 0, outs: 0, lows: 0 };
      p.reports++;
      p[isOut ? 'outs' : 'lows']++;
      reporters.set(r.reportedBy, p);
    }
  }
  totals.items = items.size;
  totals.avgOutMinutes = totals.backs ? Math.round(totals.outMinutes / totals.backs) : null;
  const all = [...items.values()].map((it) => ({ ...it, avgOutMinutes: it.backs ? Math.round(it.outMinutes / it.backs) : null }))
    .sort((a, b) => (b.outs + b.lows) - (a.outs + a.lows) || b.outs - a.outs || b.lastAt.localeCompare(a.lastAt));
  const most = (a, b) => (b.outs + b.lows) - (a.outs + a.lows) || b.outs - a.outs;
  return {
    totals,
    items: all.slice(0, limit),
    truncated: all.length > limit,
    byList: [...byList.values()].sort(most),
    byCategory: [...byCategory.values()].sort(most),
    byWeekday,
    repeat: all.filter((x) => x.outs >= REPEAT_MIN).sort((a, b) => b.outs - a.outs || b.lastAt.localeCompare(a.lastAt)).slice(0, 10)
      .map(({ key, name, category, outs, lows, lists }) => ({ key, name, category, outs, lows, lists })),
    reporters: [...reporters.values()].sort((a, b) => b.reports - a.reports || b.outs - a.outs).slice(0, 10),
  };
}

/** The range a history request asks for: a season, the last N days, two dates, or (nothing) the current season. */
export function rangeOf({ season, days, from, to } = {}, today, settings, fail = (s, m) => { throw new Error(m); }) {
  if (season) {
    const s = seasonById(season, settings);
    if (!s) fail(400, 'Pick a season');
    return { kind: 'season', seasonId: s.id, from: s.start, to: s.end };
  }
  if (days != null && days !== '') {
    const n = Math.round(Number(days));
    if (!(n >= 1 && n <= 366)) fail(400, 'Pick a start and end date');
    return { kind: 'days', days: n, from: addDays(today, -(n - 1)), to: today };
  }
  if (from || to) {
    if (!DATE.test(String(from || '')) || !DATE.test(String(to || ''))) fail(400, 'Pick a start and end date');
    const [a, b] = from <= to ? [from, to] : [to, from];
    if (daysBetween(a, b) > MAX_SPAN_DAYS) fail(400, 'Pick up to two years at a time');
    return { kind: 'dates', from: a, to: b };
  }
  const s = seasonOf(today, settings);
  return { kind: 'season', seasonId: s.id, from: s.start, to: s.end };
}

// ---------- the API ----------
export function eightySixReportsApi({ store, now, settings, fail, ready, lists, categories, itemView, menuItems, nameOf, remembered }) {
  const nowIso = () => now().toISOString();
  const today = () => todayStr(now());
  /** Managers and up (core/reports.js), signed in. Returns the person as saved. */
  function need(actor) {
    if (!actor) fail(401, 'Please sign in');
    const u = store.get('users', actor.id) || actor;
    if (!canSeeReports(u)) fail(403, 'Managers only');
    return u;
  }
  const hidden = (l) => !!l.viewers && !l.viewers.all;
  const listOut = (l) => ({ id: l.id, name: l.name, nameEs: l.nameEs || '', kind: l.kind, area: l.area || '', hidden: hidden(l) });
  const cats = () => categories().map(({ id, name, nameEs }) => ({ id, name, nameEs }));
  const catOf = (r) => r.category || remembered(r.name)?.category || '';
  /** Every report there is (on a list now, or in the log), for one list or all. */
  const allRows = (listId) => [
    ...store.list('eightySixItems', (x) => !listId || x.listId === listId).map((r) => ({ ...r, active: true })),
    ...store.list('eightySixLog', (x) => !listId || x.listId === listId).map((r) => ({ ...r, active: false })),
  ];
  /** Seasons from the first report until today, newest first: the season picker. */
  function seasonsFor(rows) {
    const t = today();
    let first = t;
    for (const r of rows) { const d = episodeOf(r).day; if (d && d < first) first = d; }
    return seasonsBetween(first, t, settings()).map(({ id, key, startYear, start, end }) => ({ id, key, startYear, start, end }));
  }
  const statsFor = (rows, from, to, limit) => eightySixStats(rows, { from, to, categoryOf: catOf, nameOf, limit });

  return {
    // Tab 1, Missing now: everything out or low on every list (hidden lists too), with how long, who and photos.
    'reports.eightySix.missing.get': (actor, { listId = '' } = {}) => {
      const u = need(actor);
      ready();
      const all = lists();
      const at = nowIso();
      const menu = menuItems();
      const byId = Object.fromEntries(all.map((l) => [l.id, l]));
      const items = store.list('eightySixItems', (x) => !!byId[x.listId] && (!listId || x.listId === listId));
      const rows = items.map((it) => {
        const l = byId[it.listId];
        const since = sinceOf(it);
        return { ...itemView(it, menu, u), category: catOf(it), listName: l.name, listNameEs: l.nameEs || '', listKind: l.kind, since, minutes: minutesBetween(since, at) };
      }).sort((a, b) => (a.status === b.status ? 0 : a.status === 'out' ? -1 : 1) || String(a.since).localeCompare(String(b.since)));
      return {
        now: at,
        lists: all.map((l) => ({ ...listOut(l), out: items.filter((i) => i.listId === l.id && i.status === 'out').length, low: items.filter((i) => i.listId === l.id && i.status === 'low').length })),
        categories: cats(),
        items: rows.slice(0, MAX_MISSING),
        truncated: rows.length > MAX_MISSING,
        totals: { out: rows.filter((r) => r.status === 'out').length, low: rows.filter((r) => r.status === 'low').length },
      };
    },

    // Tab 2, History: a season, the last N days or two dates (default: this season). Optionally one list.
    'reports.eightySix.history.get': (actor, args = {}) => {
      need(actor);
      ready();
      const range = rangeOf(args, today(), settings(), fail);
      const listId = args.listId && store.get('eightySixLists', args.listId) ? args.listId : '';
      const rows = allRows(listId);
      const stats = statsFor(rows, range.from, range.to);
      const known = Object.fromEntries(lists().map((l) => [l.id, l]));
      return {
        range, today: today(), listId,
        seasons: seasonsFor(rows),
        lists: lists().map(listOut),
        categories: cats(),
        ...stats,
        byList: stats.byList.map((l) => ({ ...l, name: known[l.listId]?.name || l.listName, nameEs: known[l.listId]?.nameEs || '' })),
      };
    },

    // Tab 3, Trends: a season against the same season a year before, the same number of days in (so a season
    // that's still going is compared fairly), plus last year's whole season.
    'reports.eightySix.trends.get': (actor, { season = '' } = {}) => {
      need(actor);
      ready();
      const st = settings();
      const t = today();
      const cur = season ? seasonById(season, st) : seasonOf(t, st);
      if (!cur) fail(400, 'Pick a season');
      const prev = seasonById(`${cur.key}-${cur.startYear - 1}`, st);
      const curTo = cur.end < t ? cur.end : t < cur.start ? cur.start : t;
      const span = daysBetween(cur.start, curTo);
      const prevTo = addDays(prev.start, span) < prev.end ? addDays(prev.start, span) : prev.end;
      const rows = allRows('');
      const a = statsFor(rows, cur.start, curTo, Infinity);
      const b = statsFor(rows, prev.start, prevTo, Infinity);
      const whole = statsFor(rows, prev.start, prev.end, 0);
      const merged = new Map();
      for (const [side, s] of [['now', a], ['then', b]]) {
        for (const it of s.items) {
          const m = merged.get(it.key) || { key: it.key, name: it.name, category: it.category, nowOuts: 0, nowLows: 0, thenOuts: 0, thenLows: 0 };
          m[`${side}Outs`] = it.outs;
          m[`${side}Lows`] = it.lows;
          if (side === 'now' || !m.category) { m.name = side === 'now' ? it.name : m.name; m.category = m.category || it.category; }
          merged.set(it.key, m);
        }
      }
      const items = [...merged.values()].map((m) => ({ ...m, change: (m.nowOuts + m.nowLows) - (m.thenOuts + m.thenLows) }))
        .sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || (y.nowOuts + y.nowLows) - (x.nowOuts + x.nowLows) || x.name.localeCompare(y.name));
      const catMap = new Map();
      for (const [side, s] of [['now', a], ['then', b]]) for (const c of s.byCategory) {
        const m = catMap.get(c.category) || { category: c.category, now: 0, then: 0 };
        m[side] = c.outs + c.lows;
        catMap.set(c.category, m);
      }
      const pick = ({ id, key, startYear, start, end }) => ({ id, key, startYear, start, end });
      return {
        season: { ...pick(cur), to: curTo }, last: { ...pick(prev), to: prevTo }, partial: curTo < cur.end,
        totals: { now: a.totals, then: b.totals, lastWhole: whole.totals },
        items: items.slice(0, 25),
        newThisYear: items.filter((m) => !m.thenOuts && !m.thenLows).length,
        byCategory: [...catMap.values()].sort((x, y) => y.now + y.then - (x.now + x.then)),
        seasons: seasonsFor(rows),
        categories: cats(),
      };
    },
  };
}
