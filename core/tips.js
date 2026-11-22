// Tip pooling: pools, daily tip entries, the split, the week report, and locking a week.
//
// The math at the top is pure (no store) so the server, the in-browser demo, the settings
// screen's live example and the tests all use the same code. The RPC methods at the bottom
// are mounted into core/service.js with tipMethods(ctx).
//
// Money is integer cents everywhere. Hours are whole minutes and points are thousandths,
// so every share is exact integer math and the leftover cents are handed out by rule.
import { addDays, weekStart, range, prettyDate, todayStr, parseDate, MONTHS } from './time.js';
import { hoursOf } from './forecast.js';
import { sameArea, uniqueAreas } from './areas.js';
import { ROLE_IDS, roleOf, roleLabel, roleLabelPlural } from './roles.js';
import { msg } from './messages.js';
import { uid } from './store.js';
import { clockEntries } from './clock.js';

// ---------- options ----------
// Each option has its Spanish words in `es`; tipOption(o, lang) picks them.
export const TIP_METHODS = [
  { id: 'hours_points', label: 'Hours × points', help: 'Hours worked times the position’s points. More hours and higher-point positions get more.',
    es: { label: 'Horas × puntos', help: 'Las horas trabajadas por los puntos del puesto. Más horas y puestos con más puntos reciben más.' } },
  { id: 'points_shift', label: 'Points per shift', help: 'Each shift worked earns its position’s points, however long it was.',
    es: { label: 'Puntos por turno', help: 'Cada turno trabajado gana los puntos de su puesto, sin importar cuánto duró.' } },
  { id: 'equal', label: 'Equal split', help: 'Everyone who worked gets the same amount.',
    es: { label: 'Partes iguales', help: 'Todos los que trabajaron reciben lo mismo.' } },
];
export const TIP_PERIODS = [
  { id: 'day', label: 'Per day', help: 'Each day’s tips are split among the people who worked that day.',
    es: { label: 'Por día', help: 'Las propinas de cada día se reparten entre quienes trabajaron ese día.' } },
  { id: 'week', label: 'Per week', help: 'The week’s tips are added up and split among everyone who worked that week.',
    es: { label: 'Por semana', help: 'Las propinas de la semana se suman y se reparten entre todos los que trabajaron esa semana.' } },
];
/** An option's label and help in a language. */
export const tipOption = (o, lang = 'en') => (lang === 'es' && o?.es ? { ...o, ...o.es } : o);
export const TIP_SOURCES = { all: 'card and cash tips', card: 'card tips', cash: 'cash tips' };
const TIP_SOURCES_ES = { all: 'las propinas con tarjeta y en efectivo', card: 'las propinas con tarjeta', cash: 'las propinas en efectivo' };
/** Roles left out of a new pool: manager level and up (FLSA). Supervisors are a choice. */
export const MANAGER_ROLES = ['super_admin', 'admin', 'manager'];
/** Starting points for common positions, matched by name when a pool is created. */
export const SUGGESTED_POINTS = [[/^servers?$/i, 1], [/^bartenders?$/i, 1], [/^bussers?$/i, 0.5], [/^food ?runners?$/i, 0.6], [/^bar ?backs?$/i, 0.5]];
const MAX_CENTS = 100000000; // $1,000,000: a typo guard, not a business rule

export const DEFAULT_CONTRIBUTIONS = () => [{ id: 'c_tips', type: 'tips', source: 'all', percent: 100 }];

/** A pool with every field filled in (older or partial documents get the defaults). */
export function normalizePool(p = {}) {
  return {
    id: p.id, name: p.name || 'Tip pool', order: Number(p.order) || 0, archived: !!p.archived,
    areas: uniqueAreas(Array.isArray(p.areas) ? p.areas : []),
    period: p.period === 'week' ? 'week' : 'day',
    method: TIP_METHODS.some((m) => m.id === p.method) ? p.method : 'hours_points',
    jobs: (p.jobs || []).map((j) => ({ jobCodeId: j.jobCodeId, points: Number(j.points) || 0 })),
    contributions: p.contributions?.length ? p.contributions : DEFAULT_CONTRIBUTIONS(),
    excludeRoles: Array.isArray(p.excludeRoles) ? p.excludeRoles.filter((r) => ROLE_IDS.includes(r)) : [...MANAGER_ROLES],
    events: p.events !== false,
    showEstimates: p.showEstimates !== false,
  };
}

// ---------- money, hours and points ----------
const MILLI = 1000;
export const milli = (points) => Math.round((Number(points) || 0) * MILLI);
const basisPoints = (percent) => Math.round((Number(percent) || 0) * 100);
/** `percent`% of `cents`, rounded to the nearest cent (half up). */
export const percentOf = (cents, percent) => Math.floor((Math.max(0, cents) * basisPoints(percent) + 5000) / 10000);
/** Toast reports tips in dollars (like its API). One place to change if that ever differs. */
export const toastCents = (v) => Math.round((Number(v) || 0) * 100);

export function fmtCents(c) {
  const n = Math.round(Number(c) || 0);
  const a = Math.abs(n);
  return `${n < 0 ? '−' : ''}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
/** "$1,234.5" → 123450 cents; '' → 0; anything else → null. */
export function toCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!s) return 0;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const trim = (x, max = 2) => String(Number(x.toFixed(max)));
/** 6.5, 7, 6.25 (hours from minutes). */
export const fmtHours = (minutes) => trim(minutes / 60);
/** Points with one or two decimals: 1.0, 0.5, 0.75, 41.2 */
export const fmtPoints = (x) => { const s = trim(x); return s.includes('.') ? s : `${s}.0`; };
export const fmtPct = (x) => `${trim(x, 1)}%`;
export function periodLabel(start, end, lang = 'en') {
  if (start === end) return prettyDate(start, { lang });
  if (lang === 'es') return `${prettyDate(start, { lang, dow: false })} – ${prettyDate(end, { lang, dow: false })}`; // 28 sep – 4 oct
  const a = parseDate(start), b = parseDate(end);
  const m1 = MONTHS[a.getUTCMonth()].slice(0, 3), m2 = MONTHS[b.getUTCMonth()].slice(0, 3);
  return m1 === m2 ? `${m1} ${a.getUTCDate()} – ${b.getUTCDate()}` : `${m1} ${a.getUTCDate()} – ${m2} ${b.getUTCDate()}`;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Split `cents` by each row's `units` (whole numbers). Everyone gets the whole cents of their
 * exact share; the cents left over go one each to the largest remainders (ties: more units,
 * then name, then id). The result always adds up to `cents` exactly and never depends on order.
 */
export function splitCents(cents, rows) {
  const out = new Map(rows.map((r) => [r.key, 0]));
  const total = rows.reduce((t, r) => t + Math.max(0, r.units), 0);
  if (!(cents > 0) || !total) return out;
  const T = BigInt(total), C = BigInt(cents);
  const parts = rows.filter((r) => r.units > 0).map((r) => {
    const n = C * BigInt(r.units);
    return { r, base: Number(n / T), rem: n % T };
  });
  let left = cents - parts.reduce((t, p) => t + p.base, 0);
  parts.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0) || b.r.units - a.r.units
    || cmp(String(a.r.name || ''), String(b.r.name || '')) || cmp(String(a.r.key), String(b.r.key)));
  for (const p of parts) { out.set(p.r.key, p.base + (left > 0 ? 1 : 0)); left--; }
  return out;
}

// ---------- who worked where ----------
/**
 * The pools a shift counts toward. A pool takes shifts of its positions; a pool with areas takes
 * only those areas, and a pool with no areas takes every area no other pool claims for that
 * position. So a separate Rabbit Hole pool and a house pool never count the same shift.
 */
export function poolsForWork(pools, area, jobCodeId, isEvent = false) {
  const withJob = pools.filter((p) => p.jobs.some((j) => j.jobCodeId === jobCodeId));
  const claimed = withJob.filter((p) => p.areas.length && p.areas.some((a) => sameArea(a, area)));
  return (claimed.length ? claimed : withJob.filter((p) => !p.areas.length)).filter((p) => !isEvent || p.events);
}

/**
 * One day's work, per pool, person and position: minutes, shifts, where the hours came from,
 * and the person's Toast tips. Actual hours from clock-ins (timeEntries, already picked by the
 * clock-in source in core/clock.js: ADP, Toast or both) win when the person has any for that day;
 * otherwise the published schedule is used ("until close" shifts estimated). The clock doesn't know
 * the area, so actual time is shared across that day's scheduled shifts in proportion to their
 * scheduled length; time with no scheduled shift goes to pools with no area. Tips-only entries
 * (Toast tips for a shift whose hours came from ADP) add tips to the person's work, never hours.
 */
export function dayWork({ date, pools, shifts = [], timeEntries = [], settings }) {
  const rows = new Map();
  const add = (pool, userId, jobCodeId, v) => {
    const k = `${pool.id}|${userId}|${jobCodeId}`;
    const r = rows.get(k) || { poolId: pool.id, userId, jobCodeId, date, minutes: 0, shifts: 0, card: 0, cash: 0, source: v.source, estimated: false, noPunch: false, unscheduled: false };
    r.minutes += v.minutes || 0; r.shifts += v.shifts || 0; r.card += v.card || 0; r.cash += v.cash || 0;
    if (v.estimated) r.estimated = true;
    if (v.noPunch) r.noPunch = true;
    if (v.unscheduled) r.unscheduled = true;
    rows.set(k, r);
  };
  const worked = shifts.filter((s) => s.date === date && s.userId && s.published);
  const punches = timeEntries.filter((t) => t.date === date && t.userId && !t.tipsOnly);
  const tipPunches = timeEntries.filter((t) => t.date === date && t.userId && t.tipsOnly);
  const synced = punches.length > 0; // the clock has this day, so a missing punch is worth a look
  const people = new Set([...worked.map((s) => s.userId), ...punches.map((t) => t.userId), ...tipPunches.map((t) => t.userId)]);
  const schedMin = (s) => Math.round(hoursOf(s, settings) * 60);

  for (const userId of people) {
    const mine = worked.filter((s) => s.userId === userId);
    const myPunches = punches.filter((t) => t.userId === userId);
    const myTips = tipPunches.filter((t) => t.userId === userId);
    if (!myPunches.length) {
      const tipCard = myTips.reduce((t, x) => t + toastCents(x.nonCashTips), 0);
      const tipCash = myTips.reduce((t, x) => t + toastCents(x.declaredCashTips), 0);
      const total = mine.reduce((t, s) => t + schedMin(s), 0);
      for (const s of mine) {
        const f = total ? schedMin(s) / total : 1 / mine.length;
        for (const pool of poolsForWork(pools, s.area, s.jobCodeId, !!s.eventId)) {
          add(pool, userId, s.jobCodeId, { minutes: schedMin(s), shifts: 1, card: tipCard * f, cash: tipCash * f, source: 'schedule', estimated: !s.end, noPunch: synced });
        }
      }
      const job = myTips.find((t) => t.jobCodeId)?.jobCodeId;
      if (!mine.length && job && (tipCard || tipCash)) for (const pool of poolsForWork(pools, '', job)) add(pool, userId, job, { card: tipCard, cash: tipCash, source: 'toast', unscheduled: true });
      continue;
    }
    const clock = myPunches[0].source === 'adp' ? 'adp' : 'toast'; // one source per person per day (core/clock.js)
    const schedJobs = [...new Set(mine.map((s) => s.jobCodeId))];
    const byJob = new Map();
    for (const t of myPunches) {
      // A punch without a position belongs to the position the person was scheduled for.
      const job = t.jobCodeId || (schedJobs.length === 1 ? schedJobs[0] : null);
      if (!job) continue;
      const a = byJob.get(job) || { minutes: 0, card: 0, cash: 0 };
      a.minutes += ((Number(t.regularHours) || 0) + (Number(t.overtimeHours) || 0)) * 60;
      a.card += toastCents(t.nonCashTips);
      a.cash += toastCents(t.declaredCashTips);
      byJob.set(job, a);
    }
    // Toast's tips for a day whose hours came from ADP: on the same position, else the one worked longest.
    for (const t of myTips) {
      const job = t.jobCodeId && byJob.has(t.jobCodeId) ? t.jobCodeId : [...byJob.entries()].sort((x, y) => y[1].minutes - x[1].minutes)[0]?.[0];
      if (!job) continue;
      byJob.get(job).card += toastCents(t.nonCashTips);
      byJob.get(job).cash += toastCents(t.declaredCashTips);
    }
    for (const [job, a] of byJob) {
      const sched = mine.filter((s) => s.jobCodeId === job);
      const worked1 = a.minutes > 0 ? 1 : 0;
      if (!sched.length) {
        for (const pool of poolsForWork(pools, '', job)) add(pool, userId, job, { ...a, shifts: worked1, source: clock, unscheduled: true });
        continue;
      }
      const mins = sched.map(schedMin);
      const sum = mins.reduce((t, m) => t + m, 0);
      sched.forEach((s, i) => {
        const f = sum ? mins[i] / sum : 1 / sched.length;
        for (const pool of poolsForWork(pools, s.area, job, !!s.eventId)) {
          add(pool, userId, job, { minutes: a.minutes * f, card: a.card * f, cash: a.cash * f, shifts: worked1, source: clock });
        }
      });
    }
  }
  return [...rows.values()].map((r) => ({ ...r, minutes: Math.round(r.minutes), card: Math.round(r.card), cash: Math.round(r.cash) }));
}

// ---------- what goes in ----------
export function contributionLabel(c, jobName = () => '', lang = 'en') {
  const pct = trim(Number(c.percent) || 0);
  if (lang === 'es') {
    if (c.type === 'sales') {
      if (c.label) return `Aporte de ${c.label}: ${pct}% de sus ventas`;
      return c.jobCodeId ? `Aporte de ${jobName(c.jobCodeId)}: ${pct}% de sus ventas` : `Aporte: ${pct}% de las ventas`;
    }
    return `${pct}% de ${TIP_SOURCES_ES[c.source] || TIP_SOURCES_ES.all}`;
  }
  if (c.type === 'sales') {
    const who = c.label || (c.jobCodeId ? `${jobName(c.jobCodeId)}s` : '');
    return `${who ? `${who} tip out ` : 'Tip-out: '}${pct}% of ${c.jobCodeId || c.label ? 'their ' : ''}sales`;
  }
  return `${pct}% of ${TIP_SOURCES[c.source] || TIP_SOURCES.all}`;
}
/** The name of the sales figure a manager types in for a tip-out ("Server sales"). */
export const salesLabel = (c, jobName = () => '', lang = 'en') => (lang === 'es'
  ? (c.jobCodeId ? `Ventas de ${jobName(c.jobCodeId)}` : c.label ? `${c.label}: ventas` : 'Ventas')
  : (c.jobCodeId ? `${jobName(c.jobCodeId)} sales` : c.label ? `${c.label}: sales` : 'Sales'));

/** One day's pool: the tips (typed in, or from Toast) and each contribution, in cents. */
export function dayTotal(pool, entry, toast = { card: 0, cash: 0 }) {
  const useToast = !!entry?.useToast;
  const card = useToast ? toast.card : entry?.card || 0;
  const cash = useToast ? toast.cash : entry?.cash || 0;
  const contributions = pool.contributions.map((c) => {
    const base = c.type === 'sales' ? entry?.sales?.[c.id] || 0 : c.source === 'card' ? card : c.source === 'cash' ? cash : card + cash;
    return { id: c.id, base, cents: percentOf(base, c.percent) };
  });
  return { card, cash, useToast, contributions, total: contributions.reduce((t, c) => t + c.cents, 0) };
}

// ---------- the split ----------
/**
 * Split one period (a day, or a week for weekly pools). `rows` are dayWork rows for this pool;
 * `users` maps id → { name, role }. Adjustments come off the top, then the rest is split by
 * units, so what everyone gets always adds up to the pool.
 */
export function splitPeriod({ pool, rows, totalCents, adjustments = [], users = {} }) {
  const points = new Map(pool.jobs.map((j) => [j.jobCodeId, Number(j.points) || 0]));
  const excludeRoles = new Set(pool.excludeRoles);
  const isOut = (userId) => excludeRoles.has(users[userId]?.role || 'employee');
  const byUser = new Map();
  const person = (userId) => {
    let p = byUser.get(userId);
    if (!p) byUser.set(userId, p = { userId, name: users[userId]?.name || 'Former employee', jobs: [], minutes: 0, shifts: 0, sources: new Set(), estimated: false, noPunch: [], adjustments: [] });
    return p;
  };
  const excluded = new Map();
  for (const r of rows) {
    if (!(r.minutes > 0 || r.shifts > 0)) continue;
    if (isOut(r.userId)) {
      const x = excluded.get(r.userId) || { userId: r.userId, name: users[r.userId]?.name || '', role: users[r.userId]?.role, minutes: 0 };
      x.minutes += r.minutes;
      excluded.set(r.userId, x);
      continue;
    }
    const p = person(r.userId);
    let j = p.jobs.find((x) => x.jobCodeId === r.jobCodeId);
    if (!j) p.jobs.push(j = { jobCodeId: r.jobCodeId, minutes: 0, shifts: 0, points: points.get(r.jobCodeId) ?? 0 });
    j.minutes += r.minutes; j.shifts += r.shifts;
    p.minutes += r.minutes; p.shifts += r.shifts;
    p.sources.add(r.source);
    if (r.estimated) p.estimated = true;
    if (r.noPunch && !p.noPunch.includes(r.date)) p.noPunch.push(r.date);
  }
  const warnings = [];
  let adjTotal = 0;
  for (const a of adjustments) {
    if (isOut(a.userId)) {
      const params = { name: users[a.userId]?.name || '', role: users[a.userId]?.role || 'employee' };
      warnings.push({ code: 'excluded-adjustment', params, text: tipWarningText({ code: 'excluded-adjustment', params }) });
      continue;
    }
    person(a.userId).adjustments.push({ cents: a.cents, note: a.note, date: a.date });
    adjTotal += a.cents;
  }
  const unitsOf = (p) => {
    if (pool.method === 'equal') return p.minutes > 0 || p.shifts > 0 ? 1 : 0;
    if (pool.method === 'points_shift') return p.jobs.reduce((t, j) => t + j.shifts * milli(j.points), 0);
    return p.jobs.reduce((t, j) => t + j.minutes * milli(j.points), 0);
  };
  const toPoints = (u) => (pool.method === 'equal' ? u : pool.method === 'points_shift' ? u / MILLI : u / (60 * MILLI));
  const people = [...byUser.values()].map((p) => ({ ...p, units: unitsOf(p) }));
  const totalUnits = people.reduce((t, p) => t + p.units, 0);
  const toSplit = totalCents - adjTotal;
  const warn = (code, params) => warnings.push({ code, block: true, params, text: tipWarningText({ code, params }) });
  if (toSplit < 0) warn('over', { adjustments: adjTotal, pool: totalCents });
  if (toSplit > 0 && !totalUnits) warn('nobody', { amount: toSplit });
  const shares = splitCents(Math.max(0, toSplit), people.map((p) => ({ key: p.userId, units: p.units, name: p.name })));
  const out = people.map((p) => {
    const split = shares.get(p.userId) || 0;
    const adjustment = p.adjustments.reduce((t, a) => t + a.cents, 0);
    return {
      userId: p.userId, name: p.name,
      jobs: p.jobs.map((j) => ({ ...j, points: j.points })),
      minutes: p.minutes, shifts: p.shifts, units: p.units, points: toPoints(p.units),
      sharePct: totalUnits ? (p.units / totalUnits) * 100 : 0,
      source: p.sources.size > 1 ? 'mixed' : [...p.sources][0] || '',
      estimated: p.estimated, noPunch: p.noPunch.sort(),
      split, adjustment, adjustments: p.adjustments, amount: split + adjustment,
    };
  }).sort((a, b) => b.amount - a.amount || cmp(a.name, b.name));
  return {
    total: totalCents, adjustments: adjTotal, toSplit: Math.max(0, toSplit),
    totalUnits, totalPoints: toPoints(totalUnits),
    workers: out.filter((p) => p.units > 0).length,
    people: out, excluded: [...excluded.values()], warnings,
  };
}

/**
 * The whole week for every pool. Pure: give it the week's shifts, Toast time entries, tip entries
 * and users ({ id: { name, role } }); pools must be normalized and active.
 */
export function buildWeek({ weekStart: ws, pools, shifts = [], timeEntries = [], entries = [], users = {}, settings = {} }) {
  const dates = range(ws, 7);
  const work = new Map(dates.map((date) => [date, dayWork({ date, pools, shifts, timeEntries, settings })]));
  const toastDays = new Set(timeEntries.filter((t) => t.userId && t.source !== 'adp').map((t) => t.date)); // days with Toast's tips
  const people = new Map();
  const report = pools.map((pool) => {
    const days = dates.map((date) => {
      const rows = work.get(date).filter((r) => r.poolId === pool.id);
      const entry = entries.find((e) => e.poolId === pool.id && e.date === date) || null;
      const toast = { card: rows.reduce((t, r) => t + r.card, 0), cash: rows.reduce((t, r) => t + r.cash, 0) };
      return {
        date, rows, toast, toastAvailable: toastDays.has(date), ...dayTotal(pool, entry, toast),
        entry: entry && { card: entry.card || 0, cash: entry.cash || 0, useToast: !!entry.useToast, sales: entry.sales || {}, adjustments: entry.adjustments || [], note: entry.note || '', updatedAt: entry.updatedAt, updatedBy: entry.updatedBy },
      };
    });
    const groups = pool.period === 'week' ? [days] : days.map((d) => [d]);
    const periods = groups.map((g) => ({
      start: g[0].date, end: g[g.length - 1].date, label: periodLabel(g[0].date, g[g.length - 1].date),
      ...splitPeriod({
        pool, users, rows: g.flatMap((d) => d.rows), totalCents: g.reduce((t, d) => t + d.total, 0),
        adjustments: g.flatMap((d) => (d.entry?.adjustments || []).map((a) => ({ ...a, date: d.date }))),
      }),
    }));
    for (const per of periods) {
      for (const p of per.people) {
        const x = people.get(p.userId) || { userId: p.userId, name: p.name, minutes: 0, amount: 0, pools: {} };
        x.minutes += p.minutes; x.amount += p.amount;
        x.pools[pool.id] = (x.pools[pool.id] || 0) + p.amount;
        people.set(p.userId, x);
      }
    }
    return {
      pool,
      days: days.map(({ rows, ...d }) => {
        const workers = new Set(rows.filter((r) => r.minutes > 0 || r.shifts > 0).map((r) => r.userId));
        return { ...d, workers: workers.size, toastHours: rows.some((r) => r.source === 'toast' || r.source === 'adp') };
      }),
      periods, total: periods.reduce((t, p) => t + p.total, 0),
    };
  });
  return {
    weekStart: ws, end: addDays(ws, 6), label: periodLabel(ws, addDays(ws, 6)),
    pools: report, total: report.reduce((t, p) => t + p.total, 0),
    people: [...people.values()].sort((a, b) => b.amount - a.amount || cmp(a.name, b.name)),
  };
}

/** A tip warning ({ code, params }) in words. Older saved reports only have `text` (English). */
export function tipWarningText(w, lang = 'en') {
  const p = w.params;
  if (!p) return w.text || '';
  const es = lang === 'es';
  switch (w.code) {
    case 'excluded-adjustment': return es
      ? `${p.name || 'Alguien'} (${roleLabel(p.role, lang)}) no puede recibir dinero de este fondo, así que su ajuste no cuenta.`
      : `${p.name || 'Someone'} (${roleLabel(p.role)}) can’t get money from this pool, so their adjustment is left out.`;
    case 'over': return es
      ? `Los ajustes (${fmtCents(p.adjustments)}) son más que el fondo (${fmtCents(p.pool)}).`
      : `Adjustments (${fmtCents(p.adjustments)}) are more than the pool (${fmtCents(p.pool)}).`;
    case 'nobody': return es
      ? `Hay ${fmtCents(p.amount)} en propinas, pero nadie de este fondo trabajó.`
      : `${fmtCents(p.amount)} in tips but nobody in this pool worked.`;
    default: return w.text || '';
  }
}

/** Problems that stop a week from being finalized. */
export const blockingProblems = (rep, lang = 'en') => rep.pools.flatMap((p) => p.periods.flatMap((per) =>
  per.warnings.filter((w) => w.block).map((w) => `${p.pool.name}, ${periodLabel(per.start, per.end, lang)}: ${tipWarningText(w, lang)}`)));

// ---------- the formula in words ----------
/** How one person's share was worked out, in plain words ("You worked 6.5 hrs × 1.0 points = …"). */
export function explainShare(pool, period, p, { jobName = () => '', you = true, lang = 'en' } = {}) {
  if (lang === 'es') return explainShareEs(pool, period, p, { jobName, you });
  const lines = [];
  const worked = p.jobs.filter((j) => j.minutes > 0 || j.shifts > 0);
  const named = worked.length > 1;
  const potWords = period.adjustments ? `${fmtCents(period.toSplit)} to split` : `${fmtCents(period.toSplit)} pool`;
  if (p.units > 0) {
    if (pool.method === 'equal') {
      lines.push(`Split equally: ${potWords} ÷ ${period.workers} ${period.workers === 1 ? 'person' : 'people'} = ${fmtCents(p.split)}`);
    } else {
      const parts = worked.map((j) => (pool.method === 'points_shift'
        ? `${j.shifts} ${j.shifts === 1 ? 'shift' : 'shifts'} × ${fmtPoints(j.points)} points`
        : `${fmtHours(j.minutes)} hrs × ${fmtPoints(j.points)} points`) + (named ? ` (${jobName(j.jobCodeId)})` : ''));
      lines.push(`${you ? 'You' : p.name} worked ${parts.join(' + ')} = ${fmtPoints(p.points)} of ${fmtPoints(period.totalPoints)} points × ${potWords} = ${fmtCents(p.split)}`);
    }
  }
  for (const a of p.adjustments) lines.push(`${a.cents < 0 ? '−' : '+'} ${fmtCents(Math.abs(a.cents))} adjustment: ${a.note}`);
  if (period.adjustments && p.units > 0) lines.push(`Adjustments (${fmtCents(period.adjustments)}) come off the top of the ${fmtCents(period.total)} pool before the split.`);
  return lines;
}
function explainShareEs(pool, period, p, { jobName, you }) {
  const lines = [];
  const worked = p.jobs.filter((j) => j.minutes > 0 || j.shifts > 0);
  const named = worked.length > 1;
  const potWords = period.adjustments ? `${fmtCents(period.toSplit)} por repartir` : `un fondo de ${fmtCents(period.toSplit)}`;
  if (p.units > 0) {
    if (pool.method === 'equal') {
      lines.push(`En partes iguales: ${potWords} ÷ ${period.workers} ${period.workers === 1 ? 'persona' : 'personas'} = ${fmtCents(p.split)}`);
    } else {
      const parts = worked.map((j) => (pool.method === 'points_shift'
        ? `${j.shifts} ${j.shifts === 1 ? 'turno' : 'turnos'} × ${fmtPoints(j.points)} puntos`
        : `${fmtHours(j.minutes)} h × ${fmtPoints(j.points)} puntos`) + (named ? ` (${jobName(j.jobCodeId)})` : ''));
      lines.push(`${you ? 'Trabajaste' : `${p.name} trabajó`} ${parts.join(' + ')} = ${fmtPoints(p.points)} de ${fmtPoints(period.totalPoints)} puntos × ${potWords} = ${fmtCents(p.split)}`);
    }
  }
  for (const a of p.adjustments) lines.push(`${a.cents < 0 ? '−' : '+'} ${fmtCents(Math.abs(a.cents))} de ajuste: ${a.note}`);
  if (period.adjustments && p.units > 0) lines.push(`Los ajustes (${fmtCents(period.adjustments)}) se descuentan del fondo de ${fmtCents(period.total)} antes de repartir.`);
  return lines;
}

/** The pool's rules as short plain sentences, for the settings screen and for staff. */
export function describePool(pool, { jobName = () => '', otherPools = [], lang = 'en' } = {}) {
  if (lang === 'es') return describePoolEs(pool, { jobName, otherPools });
  const out = [];
  const what = pool.contributions.map((c) => contributionLabel(c, jobName));
  out.push(`${pool.period === 'week' ? 'Each week' : 'Each day'}, the pool is ${what.join(' + ')}.`);
  const claimedElsewhere = uniqueAreas(otherPools.filter((p) => p.id !== pool.id).flatMap((p) => p.areas));
  out.push(pool.areas.length
    ? `It counts shifts worked in ${pool.areas.join(', ')}.`
    : claimedElsewhere.length ? `It counts shifts in every area except ones with their own pool (${claimedElsewhere.join(', ')}).` : 'It counts shifts in every area.');
  const jobs = pool.jobs.map((j) => (pool.method === 'equal' ? jobName(j.jobCodeId) : `${jobName(j.jobCodeId)} ${fmtPoints(j.points)}`));
  out.push(`Who shares it${pool.method === 'equal' ? '' : ' (points)'}: ${jobs.join(', ')}.`);
  if (pool.method === 'hours_points') out.push('Each person gets points: hours worked × their position’s points. Their share is their points ÷ everyone’s points.');
  if (pool.method === 'points_shift') out.push('Each shift worked earns its position’s points, however long it was. A person’s share is their points ÷ everyone’s points.');
  if (pool.method === 'equal') out.push('Everyone who worked gets the same amount.');
  if (pool.method !== 'equal') out.push('Hours come from clock-ins (ADP or Toast, as set in Settings) when they’re there, otherwise from the schedule (“until close” shifts are estimated).');
  if (!pool.events) out.push('Event (BEO) shifts don’t count.');
  const left = [...ROLE_IDS].reverse().filter((r) => pool.excludeRoles.includes(r)).map((r) => `${roleLabel(r)}s`);
  if (left.length) out.push(`${left.length > 1 ? `${left.slice(0, -1).join(', ')} and ${left.at(-1)}` : left[0]} are left out.`);
  out.push('Adjustments a manager adds come off the top before the split. Amounts are rounded to the cent, and leftover cents go to whoever was closest to the next cent, so the shares add up to the pool exactly.');
  return out;
}
function describePoolEs(pool, { jobName, otherPools }) {
  const out = [];
  const what = pool.contributions.map((c) => contributionLabel(c, jobName, 'es'));
  out.push(`${pool.period === 'week' ? 'Cada semana' : 'Cada día'}, el fondo es ${what.join(' + ')}.`);
  const claimedElsewhere = uniqueAreas(otherPools.filter((p) => p.id !== pool.id).flatMap((p) => p.areas));
  out.push(pool.areas.length
    ? `Cuenta los turnos trabajados en ${pool.areas.join(', ')}.`
    : claimedElsewhere.length ? `Cuenta los turnos de todas las áreas, menos las que tienen su propio fondo (${claimedElsewhere.join(', ')}).` : 'Cuenta los turnos de todas las áreas.');
  const jobs = pool.jobs.map((j) => (pool.method === 'equal' ? jobName(j.jobCodeId) : `${jobName(j.jobCodeId)} ${fmtPoints(j.points)}`));
  out.push(`Quiénes lo comparten${pool.method === 'equal' ? '' : ' (puntos)'}: ${jobs.join(', ')}.`);
  if (pool.method === 'hours_points') out.push('Cada persona recibe puntos: horas trabajadas × los puntos de su puesto. Su parte son sus puntos ÷ los puntos de todos.');
  if (pool.method === 'points_shift') out.push('Cada turno trabajado gana los puntos de su puesto, sin importar cuánto duró. La parte de cada persona son sus puntos ÷ los puntos de todos.');
  if (pool.method === 'equal') out.push('Todos los que trabajaron reciben lo mismo.');
  if (pool.method !== 'equal') out.push('Las horas salen de las checadas (de ADP o de Toast, según Configuración) cuando las hay; si no, del horario (los turnos “hasta el cierre” se estiman).');
  if (!pool.events) out.push('Los turnos de eventos (BEO) no cuentan.');
  const left = [...ROLE_IDS].reverse().filter((r) => pool.excludeRoles.includes(r)).map((r) => roleLabelPlural(r, 'es'));
  if (left.length) out.push(`${left.length > 1 ? `${left.slice(0, -1).join(', ')} y ${left.at(-1)}` : left[0]} quedan fuera.`);
  out.push('Los ajustes que agrega un gerente se descuentan antes de repartir. Las cantidades se redondean al centavo, y los centavos que sobran van a quien estaba más cerca del siguiente centavo, así que las partes suman exactamente el fondo.');
  return out;
}

/** A made-up day for the settings screen: a few people per position and the split of `cents`. */
export function exampleSplit(pool, cents, { jobName = () => '' } = {}) {
  const HOURS = [6.5, 5, 7.25, 4, 6, 5.5];
  const users = {};
  const rows = [];
  pool.jobs.slice(0, 6).forEach((j, i) => {
    const n = i < 2 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const id = `ex_${i}_${k}`;
      users[id] = { name: `${jobName(j.jobCodeId) || 'Staff'} ${String.fromCharCode(65 + k)}`, role: 'employee' };
      const h = HOURS[(i * 2 + k) % HOURS.length];
      rows.push({ poolId: pool.id, userId: id, jobCodeId: j.jobCodeId, date: 'example', minutes: Math.round(h * 60), shifts: 1, source: 'schedule' });
    }
  });
  const period = splitPeriod({ pool, rows, totalCents: Math.max(0, cents || 0), users });
  return { ...period, people: period.people.sort((a, b) => cmp(a.userId, b.userId)) };
}

/** Pools that would count the same shift twice (same position, overlapping areas). */
export function poolOverlaps(pools, jobName = () => '', lang = 'en') {
  const out = [];
  for (let i = 0; i < pools.length; i++) {
    for (let k = i + 1; k < pools.length; k++) {
      const a = pools[i], b = pools[k];
      for (const j of a.jobs) {
        if (!b.jobs.some((x) => x.jobCodeId === j.jobCodeId)) continue;
        const both = !a.areas.length && !b.areas.length;
        const shared = a.areas.filter((x) => b.areas.some((y) => sameArea(x, y)));
        if (both || shared.length) {
          out.push(lang === 'es'
            ? `Los turnos de ${jobName(j.jobCodeId)}${shared.length ? ` en ${shared.join(', ')}` : ''} cuentan en “${a.name}” y también en “${b.name}”.`
            : `${jobName(j.jobCodeId)} shifts${shared.length ? ` in ${shared.join(', ')}` : ''} count in both “${a.name}” and “${b.name}”.`);
        }
      }
    }
  }
  return out;
}

// ---------- RPC methods (mounted in core/service.js) ----------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * ctx: { store, now, settings, fail, needAuth, needMgr, needAdmin, notify }.
 * Read-only names end in .list / .week so server/app.js treats them as reads.
 * Privacy: only tips.week (managers) returns other people's amounts; myTips.week returns the
 * caller's own share, the pool total and the total points, never a coworker's numbers.
 */
export function tipMethods({ store, now, settings, fail, needAuth, needMgr, needAdmin, notify, langOf = () => 'en' }) {
  const today = () => todayStr(now());
  const jobName = (id) => store.get('jobCodes', id)?.name || 'Position';
  const pools = () => store.list('tipPools').filter((p) => !p.archived).map(normalizePool)
    .sort((a, b) => a.order - b.order || cmp(a.name, b.name));
  const usersMap = () => Object.fromEntries(store.list('users').map((u) => [u.id, { name: u.name, role: roleOf(u) }]));
  const weekOf = (date) => weekStart(DATE.test(date || '') ? date : today(), settings().weekStartDow);
  const lockOn = (date) => store.list('tipLocks', (l) => l.start <= date && date <= l.end)[0] || null;
  const lockView = (l) => l && { at: l.lockedAt, by: l.lockedBy, byName: store.get('users', l.lockedBy)?.name || '' };

  function liveWeek(ws, replace = null) {
    const end = addDays(ws, 6);
    let entries = store.list('tipEntries', (e) => e.date >= ws && e.date <= end);
    if (replace) entries = [...entries.filter((e) => e.id !== replace.id), replace];
    return buildWeek({
      weekStart: ws, pools: pools(), users: usersMap(), settings: settings(), entries,
      shifts: store.list('shifts', (s) => s.date >= ws && s.date <= end && s.published && s.userId),
      timeEntries: clockEntries(store, settings(), (t) => t.date >= ws && t.date <= end).entries, // ADP, Toast or both (core/clock.js)
    });
  }
  /** The week as it stands: the saved copy once it's final, otherwise worked out now. */
  function week(ws) {
    const lock = lockOn(ws);
    return lock && lock.start === ws ? { ...lock.report, locked: lockView(lock) } : { ...liveWeek(ws), locked: null };
  }

  function cleanPool(a) {
    const name = text(a.name, 60);
    if (!name) fail(400, 'Give the pool a name');
    const jobs = [];
    for (const j of Array.isArray(a.jobs) ? a.jobs : []) {
      if (!store.get('jobCodes', j?.jobCodeId)) fail(400, 'One of the positions no longer exists');
      if (jobs.some((x) => x.jobCodeId === j.jobCodeId)) continue;
      const points = Math.round(Number(j.points) * 100) / 100;
      if (!(points > 0 && points <= 10)) fail(400, `Points for ${jobName(j.jobCodeId)} must be between 0.01 and 10`);
      jobs.push({ jobCodeId: j.jobCodeId, points });
    }
    if (!jobs.length) fail(400, 'Add at least one position that shares the pool');
    const contributions = [];
    for (const c of a.contributions === undefined ? DEFAULT_CONTRIBUTIONS() : Array.isArray(a.contributions) ? a.contributions : []) {
      const percent = Math.round(Number(c?.percent) * 100) / 100;
      if (!(percent > 0 && percent <= 100)) fail(400, 'Each “what goes in” line needs a percent from 0.01 to 100');
      const id = text(c.id, 40) || uid('tc');
      if (c.type === 'sales') {
        if (c.jobCodeId && !store.get('jobCodes', c.jobCodeId)) fail(400, 'One of the positions no longer exists');
        contributions.push({ id, type: 'sales', percent, jobCodeId: c.jobCodeId || null, label: text(c.label, 40) });
      } else {
        contributions.push({ id, type: 'tips', percent, source: TIP_SOURCES[c.source] ? c.source : 'all' });
      }
    }
    if (!contributions.length) fail(400, 'Choose what goes into the pool');
    return normalizePool({
      name, jobs, contributions, areas: a.areas, period: a.period, method: a.method,
      excludeRoles: Array.isArray(a.excludeRoles) ? a.excludeRoles : MANAGER_ROLES,
      events: a.events, showEstimates: a.showEstimates, order: a.order,
    });
  }

  return {
    // The pools and their rules. Everyone may read them (the rules hold no amounts).
    'tipPools.list': (actor) => {
      needAuth(actor);
      const list = pools();
      return { pools: list, overlaps: poolOverlaps(list, jobName), methods: TIP_METHODS, periods: TIP_PERIODS };
    },
    'tipPools.save': (actor, a = {}) => {
      needAdmin(actor);
      const { id: _drop, archived: _a, ...doc } = cleanPool(a);
      const stamp = { updatedAt: now().toISOString(), updatedBy: actor.id };
      if (a.id) {
        if (!store.get('tipPools', a.id)) fail(404, 'Tip pool not found');
        return normalizePool(store.update('tipPools', a.id, { ...doc, ...stamp }));
      }
      return normalizePool(store.insert('tipPools', { id: uid('tpl'), ...doc, order: doc.order || store.list('tipPools').length, createdAt: stamp.updatedAt, ...stamp }));
    },
    // A pool with tips entered is archived, so nothing already recorded disappears.
    'tipPools.delete': (actor, { id } = {}) => {
      needAdmin(actor);
      if (!store.get('tipPools', id)) fail(404, 'Tip pool not found');
      if (store.list('tipEntries', (e) => e.poolId === id).length) store.update('tipPools', id, { archived: true });
      else store.remove('tipPools', id);
      return { ok: true };
    },

    // One pool, one day: card and cash tips (or Toast's), tip-out sales, and adjustments with notes.
    'tipEntries.save': (actor, a = {}) => {
      needMgr(actor);
      const raw = store.get('tipPools', a.poolId);
      if (!raw || raw.archived) fail(404, 'Tip pool not found');
      const pool = normalizePool(raw);
      if (!DATE.test(a.date || '')) fail(400, 'Pick a day');
      if (lockOn(a.date)) fail(409, 'This week is final. An admin can unlock it.');
      const cents = (v, label) => {
        const n = v === '' || v == null ? 0 : Number(v);
        if (!Number.isInteger(n) || n < 0 || n > MAX_CENTS) fail(400, `${label}: enter an amount of $0 or more`);
        return n;
      };
      const doc = {
        id: `${pool.id}:${a.date}`, poolId: pool.id, date: a.date,
        card: cents(a.card, 'Card tips'), cash: cents(a.cash, 'Cash tips'), useToast: !!a.useToast,
        sales: {}, adjustments: [], note: text(a.note, 300), updatedAt: now().toISOString(), updatedBy: actor.id,
      };
      for (const c of pool.contributions.filter((x) => x.type === 'sales')) doc.sales[c.id] = cents(a.sales?.[c.id], salesLabel(c, jobName));
      const adjustments = Array.isArray(a.adjustments) ? a.adjustments : [];
      if (adjustments.length > 60) fail(400, 'Too many adjustments for one day');
      for (const x of adjustments) {
        const u = store.get('users', x?.userId);
        if (!u) fail(400, 'Pick a person for each adjustment');
        const n = Number(x.cents);
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_CENTS) fail(400, `Enter an amount for ${u.name}’s adjustment`);
        const note = text(x.note, 200);
        if (!note) fail(400, `Add a note to ${u.name}’s adjustment so everyone knows why`);
        if (pool.excludeRoles.includes(roleOf(u))) fail(400, `${u.name} (${roleLabel(u)}) can’t get money from this tip pool`);
        doc.adjustments.push({ userId: u.id, cents: n, note });
      }
      const empty = !doc.card && !doc.cash && !doc.useToast && !doc.adjustments.length && !doc.note && !Object.values(doc.sales).some(Boolean);
      // Check the period still adds up with this change before saving it.
      const rep = liveWeek(weekOf(a.date), empty ? { id: doc.id, poolId: 'none', date: '' } : doc);
      const per = rep.pools.find((p) => p.pool.id === pool.id)?.periods.find((p) => p.start <= a.date && a.date <= p.end);
      const over = per?.warnings.find((w) => w.code === 'over');
      if (over) fail(400, langOf(actor) === 'es' ? `${tipWarningText(over, 'es')} Baja los ajustes o revisa las propinas.` : `${over.text} Lower the adjustments or check the tips.`);
      const existing = store.get('tipEntries', doc.id);
      if (empty) { if (existing) store.remove('tipEntries', doc.id); return { ...doc, removed: true }; }
      return existing ? store.update('tipEntries', doc.id, doc) : store.insert('tipEntries', doc);
    },

    // Managers: every pool, every day and person, with amounts. Final weeks come from the saved copy.
    'tips.week': (actor, { weekStart: w } = {}) => {
      needMgr(actor);
      return week(weekOf(w));
    },

    // Lock the week: the numbers are saved as they are and each person is told their share.
    'tips.finalize': (actor, { weekStart: w } = {}) => {
      needMgr(actor);
      const ws = weekOf(w);
      if (lockOn(ws) || lockOn(addDays(ws, 6))) fail(409, 'This week is already final');
      const rep = liveWeek(ws);
      if (!rep.total && !rep.people.length) fail(400, 'No tips entered for this week yet');
      const lang = langOf(actor);
      const problems = blockingProblems(rep, lang);
      if (problems.length) {
        fail(400, lang === 'es'
          ? `Primero corrige esto: ${problems[0]}${problems.length > 1 ? ` (y ${problems.length - 1} más)` : ''}`
          : `Fix this first: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
      }
      const lock = store.insert('tipLocks', { id: `week:${ws}`, start: ws, end: addDays(ws, 6), lockedAt: now().toISOString(), lockedBy: actor.id, report: rep });
      for (const p of rep.people) notify([p.userId], (l) => msg(l).tipsFinal(periodLabel(ws, rep.end, l), fmtCents(p.amount)), `#/tips/${ws}`);
      return { ...rep, locked: lockView(lock) };
    },
    'tips.unlock': (actor, { weekStart: w } = {}) => {
      needAdmin(actor);
      const ws = weekOf(w);
      const lock = lockOn(ws);
      if (!lock) fail(404, 'This week isn’t final');
      store.remove('tipLocks', lock.id);
      for (const p of lock.report.people) notify([p.userId], (l) => msg(l).tipsReopened(periodLabel(lock.start, lock.end, l)), `#/tips/${lock.start}`);
      return { ok: true };
    },

    // Anyone: their own share only, with how it was worked out. Never a coworker's amount.
    'myTips.week': (actor, { weekStart: w } = {}) => {
      needAuth(actor);
      const lang = langOf(actor);
      const ws = weekOf(w);
      const rep = week(ws);
      const items = [];
      const waiting = [];
      for (const pr of rep.pools) {
        const pool = pr.pool;
        if (!rep.locked && !pool.showEstimates) {
          if (pr.periods.some((per) => per.people.some((p) => p.userId === actor.id))) waiting.push(pool.name);
          continue;
        }
        for (const per of pr.periods) {
          const me = per.people.find((p) => p.userId === actor.id);
          if (!me) continue;
          items.push({
            poolId: pool.id, poolName: pool.name, method: pool.method, period: pool.period,
            start: per.start, end: per.end, label: periodLabel(per.start, per.end, lang),
            poolTotal: per.total, toSplit: per.toSplit, totalPoints: per.totalPoints, workers: per.workers,
            me: {
              minutes: me.minutes, shifts: me.shifts, points: me.points, sharePct: me.sharePct, jobs: me.jobs,
              source: me.source, estimated: me.estimated, split: me.split, adjustment: me.adjustment,
              adjustments: me.adjustments, amount: me.amount,
            },
            lines: explainShare(pool, per, me, { jobName, lang }),
          });
        }
      }
      const otherPools = rep.pools.map((p) => p.pool);
      return {
        weekStart: rep.weekStart, end: rep.end, label: periodLabel(rep.weekStart, rep.end, lang), final: !!rep.locked, finalAt: rep.locked?.at || null,
        total: items.reduce((t, i) => t + i.me.amount, 0), items, waiting,
        pools: otherPools.map((p) => ({ id: p.id, name: p.name, rules: describePool(p, { jobName, otherPools, lang }) })),
      };
    },
  };
}

// ---------- demo data ----------
/** A small demo: a house pool by the day, a Rabbit Hole pool by the week, and tips for the demo week. */
export function seedDemoTips(store, { week, jobId, userId }) {
  const at = new Date().toISOString();
  const house = store.insert('tipPools', {
    id: 'tpl_house', name: 'House pool', order: 0, areas: [], period: 'day', method: 'hours_points',
    jobs: [['SRV', 1], ['BAR', 1], ['COC', 1], ['FR', 0.6], ['BUS', 0.5], ['BBK', 0.5]].map(([k, points]) => ({ jobCodeId: jobId[k], points })),
    contributions: DEFAULT_CONTRIBUTIONS(), excludeRoles: [...MANAGER_ROLES], events: true, showEstimates: true, createdAt: at,
  });
  const rh = store.insert('tipPools', {
    id: 'tpl_rabbithole', name: 'Rabbit Hole bar', order: 1, areas: ['Rabbit Hole'], period: 'week', method: 'hours_points',
    jobs: [{ jobCodeId: jobId.BAR, points: 1 }, { jobCodeId: jobId.BBK, points: 0.5 }],
    contributions: [{ id: 'c_card', type: 'tips', source: 'card', percent: 100 }], excludeRoles: [...MANAGER_ROLES], events: true, showEstimates: true, createdAt: at,
  });
  // [day offset from Monday, card, cash] in dollars
  const HOUSE = [[1, 1186.4, 214], [2, 642.75, 98], [3, 1408.2, 251.5], [4, 1734.9, 305], [5, 2210.35, 412]];
  const RH = [[1, 388.5], [2, 214.25], [3, 466], [4, 902.8], [5, 611.4]];
  const cents = (d) => Math.round(d * 100);
  for (const [d, card, cash] of HOUSE) {
    const date = addDays(week, d);
    const adjustments = d === 3 ? [{ userId: userId.Miguel, cents: 1500, note: 'Ran the patio alone' }] : [];
    store.insert('tipEntries', { id: `${house.id}:${date}`, poolId: house.id, date, card: cents(card), cash: cents(cash), useToast: false, sales: {}, adjustments, note: '', updatedAt: at, updatedBy: userId.Moe });
  }
  for (const [d, card] of RH) {
    const date = addDays(week, d);
    store.insert('tipEntries', { id: `${rh.id}:${date}`, poolId: rh.id, date, card: cents(card), cash: 0, useToast: false, sales: {}, adjustments: [], note: '', updatedAt: at, updatedBy: userId.Moe });
  }
}
