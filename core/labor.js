// Labor review: what was scheduled vs. what was worked (time clock entries), for one week.
// Pure function over plain data, so the server, the in-browser demo and the tests share it.
import { addDays, daysBetween, dow, range, shiftSpan, toMin } from './time.js';
import { effectiveShift, hoursOf } from './forecast.js';

export const OT_MULTIPLIER = 1.5; // Toast doesn't report the overtime rate; the usual 1.5× is assumed
const SLACK_MIN = 90; // a clock-in this close to a shift still counts as working it

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (cost, sales) => (sales > 0 ? r1((cost / sales) * 100) : null);

/** Absolute minutes for a local 'YYYY-MM-DDTHH:MM' stamp (same scale as shiftSpan). */
function stampMin(stamp) {
  if (!stamp) return null;
  const [d, t] = stamp.split('T');
  return daysBetween('2000-01-01', d) * 1440 + toMin(t || '00:00');
}

/** A time entry's span in absolute minutes; an entry with no clock-out runs for its paid hours. */
function entrySpan(e) {
  const a = stampMin(e.inLocal);
  if (a == null) return null;
  const b = stampMin(e.outLocal) ?? a + Math.round(((e.regularHours || 0) + (e.overtimeHours || 0)) * 60);
  return [a, Math.max(b, a)];
}

export const entryHours = (e) => (Number(e.regularHours) || 0) + (Number(e.overtimeHours) || 0);

/**
 * @param {object} p
 * @param {string} p.weekStart  YYYY-MM-DD
 * @param {object[]} p.shifts   shifts in the week (only published shifts with a person count as scheduled)
 * @param {object[]} p.entries  timeEntries in the week
 * @param {object[]} p.sales    sales docs in the week
 * @param {object[]} p.users
 * @param {object[]} p.jobCodes
 * @param {object} p.settings
 */
export function laborReview({ weekStart, shifts = [], entries = [], sales = [], users = [], jobCodes = [], settings = {} }) {
  const days = range(weekStart, 7);
  const end = addDays(weekStart, 6);
  const otAfter = Number(settings.overtimeHours) || 40;
  const userById = new Map(users.map((u) => [u.id, u]));
  const jobById = new Map(jobCodes.map((j) => [j.id, j]));
  const salesBy = new Map(sales.map((s) => [s.date, s]));
  const rateOf = (userId, jobCodeId) => {
    const own = userById.get(userId)?.jobCodes?.find((j) => j.jobCodeId === jobCodeId)?.rate;
    return Number(own ?? jobById.get(jobCodeId)?.defaultRate ?? 0) || 0;
  };
  const nameOf = (userId) => userById.get(userId)?.name || 'Unknown';

  // ----- scheduled: published shifts with someone on them; overtime past the weekly limit
  const inWeek = (d) => d >= weekStart && d <= end;
  const sched = shifts.filter((s) => inWeek(s.date) && s.published && s.userId)
    .map((s) => {
      const eff = effectiveShift(s, settings);
      return { ...s, hours: hoursOf(s, settings), span: shiftSpan(eff), end: eff.end, estimatedEnd: !!eff.estimatedEnd, rate: rateOf(s.userId, s.jobCodeId) };
    })
    .sort((a, b) => a.span[0] - b.span[0]);
  const weekHours = new Map();
  for (const s of sched) {
    const before = weekHours.get(s.userId) || 0;
    s.ot = Math.max(0, Math.min(s.hours, before + s.hours - otAfter));
    s.cost = s.rate * (s.hours + (OT_MULTIPLIER - 1) * s.ot);
    weekHours.set(s.userId, before + s.hours);
  }
  const openShifts = shifts.filter((s) => inWeek(s.date) && s.published && !s.userId).length;

  // ----- actual: time clock entries, paid at their Toast wage (else the ShiftBoard rate)
  const actual = entries.filter((e) => inWeek(e.date)).map((e) => {
    const wage = e.hourlyWage != null ? Number(e.hourlyWage) : rateOf(e.userId, e.jobCodeId);
    const reg = Number(e.regularHours) || 0, ot = Number(e.overtimeHours) || 0;
    return { ...e, hours: reg + ot, ot, wage, cost: wage * (reg + OT_MULTIPLIER * ot), span: entrySpan(e) };
  });
  const clockDays = new Set(actual.map((e) => e.date)); // days we have time clock data for

  // ----- shifts worked vs. clock-ins: same person, same day, times overlap (with some slack)
  const near = (s, e) => e.span && s.span[0] - SLACK_MIN < e.span[1] && e.span[0] < s.span[1] + SLACK_MIN;
  const noShift = [];
  const noClockIn = [];
  for (const e of actual) {
    if (!e.userId) continue;
    if (!sched.some((s) => s.userId === e.userId && s.date === e.date && near(s, e))) noShift.push(e);
  }
  for (const s of sched) {
    if (!clockDays.has(s.date)) continue; // no time clock data for that day (yet)
    if (!actual.some((e) => e.userId === s.userId && e.date === s.date && near(s, e))) noClockIn.push(s);
  }

  // ----- by day
  const dayRows = days.map((date) => {
    const ss = sched.filter((s) => s.date === date);
    const es = actual.filter((e) => e.date === date);
    const sale = salesBy.get(date);
    const salesAmt = Number(sale?.sales) || 0;
    const row = {
      date, dow: dow(date), closed: (settings.closedDays || []).includes(dow(date)),
      sales: sale ? salesAmt : null, covers: sale ? Number(sale.covers) || 0 : null, salesSource: sale?.source || (sale ? 'manual' : null),
      sched: { hours: r1(ss.reduce((t, s) => t + s.hours, 0)), cost: r2(ss.reduce((t, s) => t + s.cost, 0)), ot: r1(ss.reduce((t, s) => t + s.ot, 0)), shifts: ss.length },
      actual: { hours: r1(es.reduce((t, e) => t + e.hours, 0)), cost: r2(es.reduce((t, e) => t + e.cost, 0)), ot: r1(es.reduce((t, e) => t + e.ot, 0)), entries: es.length },
      hasClock: clockDays.has(date),
    };
    row.schedPct = ss.length ? pct(row.sched.cost, salesAmt) : null;
    row.actualPct = row.hasClock ? pct(row.actual.cost, salesAmt) : null;
    return row;
  });

  // ----- by person (unmatched Toast employees get their own rows)
  const people = new Map();
  const personRow = (key, init) => {
    if (!people.has(key)) people.set(key, { key, ...init, jobs: new Set(), sched: { hours: 0, cost: 0, ot: 0, shifts: 0 }, actual: { hours: 0, cost: 0, ot: 0, entries: 0, tips: 0 } });
    return people.get(key);
  };
  for (const s of sched) {
    const p = personRow(s.userId, { userId: s.userId, name: nameOf(s.userId), matched: true });
    p.jobs.add(s.jobCodeId);
    p.sched.hours += s.hours; p.sched.cost += s.cost; p.sched.ot += s.ot; p.sched.shifts++;
  }
  for (const e of actual) {
    const p = e.userId
      ? personRow(e.userId, { userId: e.userId, name: nameOf(e.userId), matched: true })
      : personRow(`toast:${e.toastEmployeeId}`, { userId: null, name: e.toastEmployeeName || 'Toast employee', matched: false });
    if (e.jobCodeId) p.jobs.add(e.jobCodeId);
    p.actual.hours += e.hours; p.actual.cost += e.cost; p.actual.ot += e.ot; p.actual.entries++;
    p.actual.tips += (Number(e.declaredCashTips) || 0) + (Number(e.nonCashTips) || 0);
  }
  const roundPart = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'cost' || k === 'tips' ? r2(v) : k === 'shifts' || k === 'entries' ? v : r1(v)]));
  const peopleRows = [...people.values()].map((p) => ({
    ...p, jobs: [...p.jobs], sched: roundPart(p.sched), actual: roundPart(p.actual), diffHours: r1(p.actual.hours - p.sched.hours),
  })).sort((a, b) => b.actual.cost - a.actual.cost || b.sched.cost - a.sched.cost || a.name.localeCompare(b.name));

  // ----- by position (job code; Toast jobs not matched yet are grouped by their Toast title)
  const positions = new Map();
  const posRow = (key, init) => {
    if (!positions.has(key)) positions.set(key, { key, ...init, sched: { hours: 0, cost: 0, ot: 0, shifts: 0 }, actual: { hours: 0, cost: 0, ot: 0, entries: 0, tips: 0 } });
    return positions.get(key);
  };
  const jobInit = (id) => ({ jobCodeId: id, name: jobById.get(id)?.name || 'Unknown position', color: jobById.get(id)?.color || '', order: jobById.get(id)?.order ?? 999 });
  for (const s of sched) {
    const p = posRow(s.jobCodeId, jobInit(s.jobCodeId));
    p.sched.hours += s.hours; p.sched.cost += s.cost; p.sched.ot += s.ot; p.sched.shifts++;
  }
  for (const e of actual) {
    const p = e.jobCodeId ? posRow(e.jobCodeId, jobInit(e.jobCodeId))
      : posRow(`toast:${e.toastJobId || 'none'}`, { jobCodeId: null, name: e.toastJobTitle || 'No job', color: '', order: 1000, matched: false });
    p.actual.hours += e.hours; p.actual.cost += e.cost; p.actual.ot += e.ot; p.actual.entries++;
    p.actual.tips += (Number(e.declaredCashTips) || 0) + (Number(e.nonCashTips) || 0);
  }
  const positionRows = [...positions.values()].map((p) => ({ ...p, sched: roundPart(p.sched), actual: roundPart(p.actual), diffHours: r1(p.actual.hours - p.sched.hours) }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // ----- totals
  const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
  const weekSales = sum(dayRows, (d) => d.sales || 0);
  const clockSales = sum(dayRows.filter((d) => d.hasClock), (d) => d.sales || 0);
  const totals = {
    sales: r2(weekSales),
    covers: sum(dayRows, (d) => d.covers || 0),
    sched: { hours: r1(sum(sched, (s) => s.hours)), cost: r2(sum(sched, (s) => s.cost)), ot: r1(sum(sched, (s) => s.ot)), shifts: sched.length },
    actual: { hours: r1(sum(actual, (e) => e.hours)), cost: r2(sum(actual, (e) => e.cost)), ot: r1(sum(actual, (e) => e.ot)), entries: actual.length,
      tips: r2(sum(actual, (e) => (Number(e.declaredCashTips) || 0) + (Number(e.nonCashTips) || 0))) },
  };
  totals.schedPct = pct(totals.sched.cost, weekSales);
  // Actual labor % only over the days that have time clock data, so a half-synced week isn't flattering.
  totals.actualPct = clockDays.size ? pct(totals.actual.cost, clockSales) : null;

  const brief = (e) => ({ id: e.id, date: e.date, userId: e.userId, name: e.userId ? nameOf(e.userId) : e.toastEmployeeName, jobCodeId: e.jobCodeId, job: e.jobCodeId ? jobById.get(e.jobCodeId)?.name : e.toastJobTitle, inLocal: e.inLocal, outLocal: e.outLocal, hours: r2(e.hours) });
  return {
    weekStart,
    targetLaborPct: settings.targetLaborPct ?? null,
    otAfter,
    days: dayRows,
    totals,
    people: peopleRows,
    positions: positionRows,
    overtime: peopleRows.filter((p) => p.sched.ot > 0 || p.actual.ot > 0).map((p) => ({ key: p.key, userId: p.userId, name: p.name, schedOt: p.sched.ot, actualOt: p.actual.ot, actualHours: p.actual.hours, schedHours: p.sched.hours })),
    noShift: noShift.map(brief).sort((a, b) => (a.date + (a.inLocal || '')).localeCompare(b.date + (b.inLocal || ''))),
    noClockIn: noClockIn.map((s) => ({ id: s.id, date: s.date, userId: s.userId, name: nameOf(s.userId), jobCodeId: s.jobCodeId, job: jobById.get(s.jobCodeId)?.name, start: s.start, end: s.end, estimatedEnd: s.estimatedEnd }))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)),
    noClockOut: actual.filter((e) => !e.outLocal || e.autoClockedOut).map(brief),
    unmatched: { entries: actual.filter((e) => !e.userId).length, hours: r1(sum(actual.filter((e) => !e.userId), (e) => e.hours)) },
    openShifts,
    clockDays: [...clockDays].sort(),
  };
}
