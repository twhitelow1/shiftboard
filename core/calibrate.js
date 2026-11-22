// Staffing from your actual hours: what the clock says each position really takes, per cover (or per
// $100 of sales), by weekday and daypart, learned from the last 4–8 weeks of clock-ins against the
// schedule. Shown next to the rule-based staffing in Forecast & Labor; it never changes the forecast.
//
//   "Fridays you schedule 52 server hours and actually use 47 for ~310 covers; suggested 48."
//
// Pure functions over plain data (the server, the demo and the tests share them). The entries come
// already picked by clock-in source (core/clock.js), so ADP and Toast never both count.
import { addDays, daysBetween, dow, range, shiftSpan, toMin, weekStart as weekStartOf, todayStr } from './time.js';
import { effectiveShift, hoursOf } from './forecast.js';
import { clockEntries } from './clock.js';

export const DEFAULT_WEEKS = 6;
export const clampWeeks = (w) => Math.min(8, Math.max(4, Math.round(Number(w) || DEFAULT_WEEKS)));
export const ALL = 'all'; // the whole day, every daypart
const MIN_SAME_DAY = 2; // same-weekday days for a sure baseline (one day is used, and marked as thin)

const r1 = (n) => Math.round(n * 10) / 10;
const entryHours = (e) => (Number(e.regularHours) || 0) + (Number(e.overtimeHours) || 0);

/** Absolute minutes for a local 'YYYY-MM-DDTHH:MM' (same scale as shiftSpan). */
function stampMin(stamp) {
  if (!stamp) return null;
  const [d, t] = stamp.split('T');
  return daysBetween('2000-01-01', d) * 1440 + toMin(t || '00:00');
}
function entrySpan(e) {
  const a = stampMin(e.inLocal);
  if (a == null) return null;
  const b = stampMin(e.outLocal) ?? a + Math.round(entryHours(e) * 60);
  return b > a ? [a, b] : null;
}

/** The dayparts of a date as absolute minute windows (a daypart ending at or before it starts runs past midnight). */
export function daypartWindows(date, dayparts = []) {
  const base = daysBetween('2000-01-01', date) * 1440;
  return dayparts.filter((d) => d?.name && d.start && d.end).map((d) => {
    const a = base + toMin(d.start);
    let b = base + toMin(d.end);
    if (b <= a) b += 1440;
    return { name: d.name, a, b, share: Number(d.share) || 0 };
  });
}

/**
 * Split some hours worked over [a, b] across dayparts by overlap. Time outside every daypart (prep
 * before lunch, closing after dinner) goes to the nearest daypart. No times: by the dayparts' shares.
 * @returns { [daypart]: hours }, adding up to `hours`
 */
export function splitByDaypart(span, hours, windows) {
  const out = Object.fromEntries(windows.map((w) => [w.name, 0]));
  if (!windows.length || !(hours > 0)) return out;
  if (!span) {
    const total = windows.reduce((t, w) => t + w.share, 0);
    for (const w of windows) out[w.name] = hours * (total > 0 ? w.share / total : 1 / windows.length);
    return out;
  }
  const [a, b] = span;
  const nearest = (x, y) => windows.reduce((best, w) => {
    const gap = y <= w.a ? w.a - y : x >= w.b ? x - w.b : 0;
    return gap < best.gap ? { gap, name: w.name } : best;
  }, { gap: Infinity, name: windows[0].name }).name;
  // Walk the span minute boundaries: each piece goes to the daypart it's in, else the nearest one.
  const cuts = [...new Set([a, b, ...windows.flatMap((w) => [w.a, w.b]).filter((x) => x > a && x < b)])].sort((x, y) => x - y);
  for (let i = 0; i < cuts.length - 1; i++) {
    const [x, y] = [cuts[i], cuts[i + 1]];
    const inside = windows.find((w) => w.a <= x && y <= w.b);
    out[inside ? inside.name : nearest(x, y)] += y - x;
  }
  const len = b - a;
  for (const k of Object.keys(out)) out[k] = (out[k] / len) * hours;
  return out;
}

/**
 * The line through a position's days: hours = fixed + perUnit × covers (or × $100 of sales).
 * Least squares when there are enough days and covers vary; a position that doesn't grow with
 * covers (a manager, a host) comes out fixed, one that does comes out per cover. Too few days, or
 * covers that barely vary: hours per cover, through zero.
 * @param {{ x: number, y: number }[]} pts
 * @returns {{ fixed: number, perUnit: number, fit: 'line' | 'ratio' | 'flat' } | null}
 */
export function fitHours(pts) {
  const n = pts.length;
  if (!n) return null;
  const sx = pts.reduce((t, p) => t + p.x, 0), sy = pts.reduce((t, p) => t + p.y, 0);
  const mx = sx / n, my = sy / n;
  const vx = pts.reduce((t, p) => t + (p.x - mx) ** 2, 0);
  if (n >= MIN_FIT && mx > 0 && Math.sqrt(vx / n) > 0.1 * mx) {
    const b = pts.reduce((t, p) => t + (p.x - mx) * (p.y - my), 0) / vx;
    const a = my - b * mx;
    // A slope that moves the hours by less than a tenth across the whole range of covers is noise: flat.
    const span = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    if (b <= 0 || b * span < 0.1 * my) return { fixed: my, perUnit: 0, fit: 'flat' };
    if (a < 0) return { fixed: 0, perUnit: sy / sx, fit: 'ratio' };
    return { fixed: a, perUnit: b, fit: 'line' };
  }
  return sx > 0 ? { fixed: 0, perUnit: sy / sx, fit: 'ratio' } : { fixed: my, perUnit: 0, fit: 'flat' };
}
const MIN_FIT = 6; // days needed before fitting a fixed part
const predict = (m, x) => m.fixed + m.perUnit * x;

/**
 * @param {object} p
 * @param {string} p.weekStart     the week being planned
 * @param {object[]} p.forecast    that week's days: { date, covers, sales, closed } (restaurant covers, without event guests)
 * @param {object[]} p.shifts      the history window and the planned week
 * @param {object[]} p.entries     clock-ins in the history window (already picked by source)
 * @param {object[]} p.sales       sales docs in the history window
 * @param {object[]} p.jobCodes
 * @param {object[]} [p.users]
 * @param {object} p.settings      dayparts, closedDays, overtimeHours, openEndHours, hours
 * @param {number} [p.weeks]       4–8
 * Event (BEO) shifts, and clock-ins that cover one, are left out on both sides: the BEO staffs events,
 * and the forecast's restaurant covers don't include their guests.
 */
export function calibrate({ weekStart, forecast = [], shifts = [], entries = [], sales = [], jobCodes = [], users = [], settings = {}, weeks = DEFAULT_WEEKS }) {
  weeks = clampWeeks(weeks);
  const from = addDays(weekStart, -7 * weeks);
  const to = addDays(weekStart, -1);
  const weekEnd = addDays(weekStart, 6);
  const dayparts = (settings.dayparts || []).filter((d) => d?.name);
  const closed = new Set(settings.closedDays || []);
  const otAfter = Number(settings.overtimeHours) || 40;
  const inHistory = (d) => d >= from && d <= to;
  const jobName = new Map(jobCodes.map((j) => [j.id, j.name]));

  const pastShifts = shifts.filter((s) => inHistory(s.date) && s.published && s.userId && s.jobCodeId);
  const eventSpans = pastShifts.filter((s) => s.eventId).map((s) => ({ userId: s.userId, date: s.date, span: shiftSpan(effectiveShift(s, settings)) }));
  const onEvent = (e) => {
    const span = entrySpan(e);
    return !!span && eventSpans.some((x) => x.userId === e.userId && x.date === e.date && x.span[0] < span[1] && span[0] < x.span[1]);
  };
  const hourEntries = entries.filter((e) => !e.tipsOnly && inHistory(e.date) && entryHours(e) > 0);
  const restaurantEntries = hourEntries.filter((e) => !onEvent(e));
  const clockDays = new Set(hourEntries.map((e) => e.date));
  const salesBy = new Map(sales.map((s) => [s.date, s]));

  // ----- the sample days: clock data and some business, the restaurant open
  const samples = [...clockDays].filter((d) => !closed.has(dow(d))).map((date) => {
    const s = salesBy.get(date);
    return { date, dow: dow(date), covers: Number(s?.covers) || 0, sales: Number(s?.sales) || 0 };
  }).filter((d) => d.covers > 0 || d.sales > 0).sort((a, b) => a.date.localeCompare(b.date));
  const sampleSet = new Set(samples.map((d) => d.date));
  // Covers when the history has them, else $100s of sales.
  const unit = samples.some((d) => d.covers > 0) ? 'covers' : 'sales';
  const xOf = (d) => (unit === 'covers' ? d.covers : d.sales / 100);

  // Hours per sample day, position and daypart: scheduled and actual.
  const keys = [ALL, ...dayparts.map((d) => d.name)];
  const blank = () => Object.fromEntries(keys.map((k) => [k, 0]));
  const perDay = new Map(); // date -> Map(job -> { sched, actual })
  const cell = (date, job) => {
    if (!perDay.has(date)) perDay.set(date, new Map());
    const m = perDay.get(date);
    if (!m.has(job)) m.set(job, { sched: blank(), actual: blank() });
    return m.get(job);
  };
  const addHours = (bucket, span, hours, date) => {
    bucket[ALL] += hours;
    const split = splitByDaypart(span, hours, daypartWindows(date, dayparts));
    for (const [k, v] of Object.entries(split)) bucket[k] += v;
  };
  const jobs = new Set();
  let unassigned = 0;
  for (const s of pastShifts) {
    if (!sampleSet.has(s.date) || s.eventId) continue;
    jobs.add(s.jobCodeId);
    addHours(cell(s.date, s.jobCodeId).sched, shiftSpan(effectiveShift(s, settings)), hoursOf(s, settings), s.date);
  }
  for (const e of restaurantEntries) {
    if (!sampleSet.has(e.date)) continue;
    if (!e.jobCodeId) { unassigned += entryHours(e); continue; }
    jobs.add(e.jobCodeId);
    addHours(cell(e.date, e.jobCodeId).actual, entrySpan(e), entryHours(e), e.date);
  }

  // ----- learn, per position and daypart: a line through every sample day (a day a position wasn't
  // needed is 0 hours) gives what each extra cover costs in hours; each weekday's own average is the
  // baseline it's added to ("Fridays use 47 server hours for ~310 covers; each cover ~0.15 h more").
  const models = new Map();
  for (const job of jobs) {
    for (const k of keys) {
      const pts = samples.map((d) => {
        const c = perDay.get(d.date)?.get(job);
        return { d, x: xOf(d), y: c?.actual[k] || 0, sched: c?.sched[k] || 0 };
      });
      const model = fitHours(pts);
      if (!model) continue;
      const byDow = new Map();
      for (const p of pts) {
        const w = byDow.get(p.d.dow) || { days: 0, sched: 0, actual: 0, covers: 0, sales: 0, x: 0 };
        w.days++; w.sched += p.sched; w.actual += p.y; w.covers += p.d.covers; w.sales += p.d.sales; w.x += p.x;
        byDow.set(p.d.dow, w);
      }
      models.set(`${job}|${k}`, { model, byDow, days: pts.length });
    }
  }
  const learned = (job, dw, k) => {
    const m = models.get(`${job}|${k}`);
    if (!m) return null;
    const w = m.byDow.get(dw);
    if (w?.days) {
      // The weekday's own hours, plus the per-cover rate for the covers above (or below) its usual.
      const at = (x) => Math.max(0, w.actual / w.days + m.model.perUnit * (x - w.x / w.days));
      return { ...m, at, history: w, basis: w.days >= MIN_SAME_DAY ? 'weekday' : 'oneDay' };
    }
    const all = [...m.byDow.values()].reduce((t, x) => ({ days: t.days + x.days, sched: t.sched + x.sched, actual: t.actual + x.actual, covers: t.covers + x.covers, sales: t.sales + x.sales }), { days: 0, sched: 0, actual: 0, covers: 0, sales: 0 });
    return { ...m, at: (x) => Math.max(0, predict(m.model, x)), history: all, basis: 'allDays' };
  };

  // ----- recommend for the planned week (restaurant covers and shifts; events are the BEO's)
  const weekShifts = shifts.filter((s) => s.date >= weekStart && s.date <= weekEnd && s.jobCodeId && !s.eventId);
  const days = range(weekStart, 7).map((date) => {
    const f = forecast.find((x) => x.date === date) || {};
    const isClosed = !!f.closed || closed.has(dow(date));
    const covers = Number(f.covers) || 0;
    const salesF = Number(f.sales) || 0;
    const x = unit === 'covers' ? covers : salesF / 100;
    const planned = new Map();
    for (const s of weekShifts.filter((y) => y.date === date)) {
      const b = planned.get(s.jobCodeId) || blank();
      addHours(b, shiftSpan(effectiveShift(s, settings)), hoursOf(s, settings), date);
      planned.set(s.jobCodeId, b);
    }
    const rows = [];
    if (!isClosed) {
      for (const job of new Set([...jobs, ...planned.keys()])) {
        for (const k of keys) {
          const l = learned(job, dow(date), k);
          const scheduled = r1(planned.get(job)?.[k] || 0);
          const suggested = l && x > 0 ? Math.round(l.at(x)) : null;
          if (!scheduled && !suggested) continue; // a position that doesn't work this daypart
          const h = l?.history;
          rows.push({
            jobCodeId: job, daypart: k, scheduled, suggested, diff: suggested == null ? null : r1(scheduled - suggested),
            unit, fixed: l ? r1(l.model.fixed) : null, perUnit: l ? Math.round(l.model.perUnit * 1000) / 1000 : null, fit: l?.model.fit || null,
            basis: l?.basis || null,
            history: h?.days ? { days: h.days, sched: r1(h.sched / h.days), actual: r1(h.actual / h.days), covers: Math.round(h.covers / h.days), sales: Math.round(h.sales / h.days) } : null,
          });
        }
      }
    }
    return { date, dow: dow(date), closed: isClosed, covers, sales: salesF, rows };
  });

  // The biggest gaps, whole days: "Fridays you schedule 52 server hours and actually use 47…"
  const highlights = days.flatMap((d) => d.rows.filter((r) => r.daypart === ALL && r.suggested != null && r.scheduled > 0 && r.history
    && Math.abs(r.diff) >= Math.max(2, r.suggested * 0.1)).map((r) => ({ date: d.date, dow: d.dow, covers: d.covers, ...r })))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 5);

  // ----- trends: over- and under-scheduling by weekday and by position, over the history
  const byDowMap = new Map();
  for (const d of samples) {
    const x = byDowMap.get(d.dow) || { dow: d.dow, days: 0, sched: 0, actual: 0, covers: 0 };
    x.days++; x.covers += d.covers;
    for (const c of perDay.get(d.date)?.values() || []) { x.sched += c.sched[ALL]; x.actual += c.actual[ALL]; }
    byDowMap.set(d.dow, x);
  }
  const trend = (x) => ({ ...x, sched: r1(x.sched / x.days), actual: r1(x.actual / x.days), covers: x.covers != null ? Math.round(x.covers / x.days) : undefined,
    diff: r1((x.sched - x.actual) / x.days), pct: x.actual > 0 ? r1(((x.sched - x.actual) / x.actual) * 100) : null });
  const weekOrder = (d) => (d - (Number(settings.weekStartDow) || 0) + 7) % 7;
  const byDow = [...byDowMap.values()].sort((a, b) => weekOrder(a.dow) - weekOrder(b.dow)).map(trend);
  const byPosition = [...jobs].map((job) => {
    const m = models.get(`${job}|${ALL}`);
    if (!m) return null;
    const x = [...m.byDow.values()].reduce((t, w) => ({ days: t.days + w.days, sched: t.sched + w.sched, actual: t.actual + w.actual }), { days: 0, sched: 0, actual: 0 });
    return { jobCodeId: job, name: jobName.get(job) || '', ...trend({ ...x, covers: null }), fixed: r1(m.model.fixed), perUnit: Math.round(m.model.perUnit * 1000) / 1000, fit: m.model.fit };
  }).filter(Boolean).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    weekStart, weeks, from, to, dayparts: dayparts.map((d) => d.name),
    sampleDays: samples.length, clockWeeks: new Set(samples.map((d) => weekStartOf(d.date, Number(settings.weekStartDow) || 0))).size,
    unit, jobs: [...jobs], days, highlights, byDow, byPosition,
    overtime: overtimeRisk({ weekStart, shifts, entries: hourEntries, users, settings, otAfter, from, to }),
    unassignedHours: r1(unassigned),
  };
}

/**
 * Who's likely to go over the weekly overtime limit this week: their scheduled hours times how
 * much longer than scheduled they've actually worked lately (their own ratio, 0.75–1.5×).
 * @returns [{ userId, name, scheduled, ratio, projected, level: 'over' | 'close', otWeeks }]
 */
export function overtimeRisk({ weekStart, shifts, entries, users = [], settings = {}, otAfter = 40, from, to }) {
  const weekEnd = addDays(weekStart, 6);
  const name = new Map(users.map((u) => [u.id, u.name]));
  const clockDays = new Set(entries.map((e) => e.date));
  const sched = new Map(), hist = new Map();
  for (const s of shifts) {
    if (!s.userId) continue;
    const h = hoursOf(s, settings);
    if (s.date >= weekStart && s.date <= weekEnd) sched.set(s.userId, (sched.get(s.userId) || 0) + h);
    else if (s.date >= from && s.date <= to && s.published && clockDays.has(s.date)) {
      const x = hist.get(s.userId) || { sched: 0, actual: 0, weeks: new Map() };
      x.sched += h;
      hist.set(s.userId, x);
    }
  }
  for (const e of entries) {
    if (!e.userId) continue;
    const x = hist.get(e.userId) || { sched: 0, actual: 0, weeks: new Map() };
    x.actual += entryHours(e);
    const wk = weekStartOf(e.date, Number(settings.weekStartDow) || 0);
    x.weeks.set(wk, (x.weeks.get(wk) || 0) + entryHours(e));
    hist.set(e.userId, x);
  }
  const out = [];
  for (const [userId, scheduled] of sched) {
    const h = hist.get(userId);
    const ratio = h && h.sched >= 8 && h.actual > 0 ? Math.min(1.5, Math.max(0.75, h.actual / h.sched)) : 1;
    const projected = scheduled * ratio;
    const otWeeks = h ? [...h.weeks.values()].filter((x) => x > otAfter).length : 0;
    const level = projected > otAfter ? 'over' : projected > otAfter - 4 || (otWeeks && scheduled > otAfter - 8) ? 'close' : null;
    if (level) out.push({ userId, name: name.get(userId) || '', scheduled: r1(scheduled), ratio: Math.round(ratio * 100) / 100, projected: r1(projected), level, otWeeks });
  }
  return out.sort((a, b) => b.projected - a.projected);
}

/**
 * RPC: Forecast & Labor → "From your actual hours". `forecastWeek(ws)` is the existing forecast
 * (core/service.js), read as it is: its numbers are never changed here.
 */
export function calibrationMethods({ store, settings, needMgr, forecastWeek, now = () => new Date() }) {
  return {
    'calibration.week': (actor, { weekStart: ws, weeks } = {}) => {
      needMgr(actor);
      const st = settings();
      const start = /^\d{4}-\d{2}-\d{2}$/.test(ws || '') ? weekStartOf(ws, st.weekStartDow) : weekStartOf(todayStr(now()), st.weekStartDow);
      const w = clampWeeks(weeks ?? st.calibrationWeeks);
      const from = addDays(start, -7 * w);
      const end = addDays(start, 6);
      const inRange = (x) => x.date >= from && x.date <= end;
      const picked = clockEntries(store, st, (t) => t.date >= from && t.date < start);
      const f = forecastWeek(start);
      const result = calibrate({
        weekStart: start, weeks: w, settings: st,
        forecast: f.days,
        shifts: store.list('shifts', inRange),
        entries: picked.entries,
        sales: store.list('sales', (s) => s.date >= from && s.date < start),
        jobCodes: store.list('jobCodes'),
        users: store.list('users').map(({ id, name }) => ({ id, name })),
      });
      return { ...result, source: picked.source, setting: picked.setting };
    },
  };
}
