// SAMPLE time clock data for the demo, so Forecast & Labor → Labor review has something to show.
// The two weeks before the posted week get a copy of its schedule, and "Toast" clock-ins that
// mostly follow it: a few people run long (overtime), a few call out, a few pick up unscheduled.
// Everything is made up; nothing here comes from a real Toast account.
import { addDays, daysBetween, fromMin, toMin } from './time.js';
import { effectiveShift } from './forecast.js';

const TIPS_PER_HOUR = { job_srv: 22, job_bar: 20, job_coc: 16, job_fr: 8, job_bus: 7, job_bbk: 6 };

function prng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

/** @param store a MemoryStore with the demo seed loaded. @param week the posted week (Monday). @param today demo "today": nothing on or after it. */
export function seedLaborDemo(store, { week, today = addDays(week, -1) }) {
  const rand = prng(7);
  const st = store.get('settings', 'settings') || {};
  const users = new Map(store.list('users').map((u) => [u.id, u]));
  const jobs = new Map(store.list('jobCodes').map((j) => [j.id, j]));
  const rate = (userId, jobCodeId) => Number(users.get(userId)?.jobCodes?.find((j) => j.jobCodeId === jobCodeId)?.rate ?? jobs.get(jobCodeId)?.defaultRate ?? 0);
  const posted = store.list('shifts', (s) => s.userId && s.published && s.date >= week && s.date <= addDays(week, 6))
    .sort((a, b) => (a.date + a.start + a.userId).localeCompare(b.date + b.start + b.userId));
  const at = `${addDays(today, -1)}T12:00:00.000Z`;
  const iso = (date, min) => new Date(`${addDays(date, Math.floor(min / 1440))}T${fromMin(min)}:00-06:00`).toISOString(); // Denver, summer time
  const local = (date, min) => `${addDays(date, Math.floor(min / 1440))}T${fromMin(min)}`;
  let n = 0;

  for (const back of [2, 1]) {
    const weekHours = new Map();
    const entry = (userId, jobCodeId, date, inMin, outMin, extra = {}) => {
      const breakMin = outMin - inMin > 6 * 60 ? 30 : 0;
      const hours = Math.max(0, (outMin - inMin - breakMin) / 60);
      const before = weekHours.get(userId) || 0;
      const ot = Math.max(0, Math.min(hours, before + hours - (st.overtimeHours || 40)));
      weekHours.set(userId, before + hours);
      const tips = (TIPS_PER_HOUR[jobCodeId] || 0) * hours * (0.8 + rand() * 0.4);
      const u = users.get(userId), j = jobs.get(jobCodeId);
      store.insert('timeEntries', {
        id: `toast_demo-${++n}`, source: 'toast', externalId: `demo-${n}`, demo: true, date,
        userId, toastEmployeeId: `demo-emp-${userId}`, toastEmployeeName: u?.name || '',
        jobCodeId, toastJobId: `demo-job-${jobCodeId}`, toastJobTitle: j?.name || '',
        inAt: iso(date, inMin), outAt: iso(date, outMin), inLocal: local(date, inMin), outLocal: local(date, outMin),
        regularHours: Math.round((hours - ot) * 100) / 100, overtimeHours: Math.round(ot * 100) / 100,
        hourlyWage: rate(userId, jobCodeId), declaredCashTips: Math.round(tips * 0.12 * 100) / 100, nonCashTips: Math.round(tips * 0.88 * 100) / 100,
        cashGratuityServiceCharges: 0, nonCashGratuityServiceCharges: 0, tipsWithheld: 0, breakMinutes: breakMin, autoClockedOut: false,
        modifiedAt: at, syncedAt: at, ...extra,
      });
    };

    for (const [i, s] of posted.entries()) {
      const date = addDays(s.date, -7 * back);
      if (date >= today) continue;
      const shift = { id: `shf_demo_${back}_${i}`, date, start: s.start, end: s.end, jobCodeId: s.jobCodeId, area: s.area || '', userId: s.userId,
        tag: '', notes: '', breakMin: 0, eventId: null, staffingLineId: null, published: true, createdAt: at };
      store.insert('shifts', shift);
      if (rand() < 0.035) continue; // called out
      const eff = effectiveShift(shift, st);
      const start = toMin(shift.start);
      let end = toMin(eff.end);
      if (end <= start) end += 1440;
      const late = users.get(s.userId)?.name === 'Chef Lucas' ? 120 : 0; // the kitchen runs long: overtime
      entry(s.userId, s.jobCodeId, date, start + Math.round(rand() * 20 - 8), end + late + Math.round(rand() * 60 - 20));
    }
    // A few people who picked up a night without being on the schedule.
    const extras = [['usr_manny', 'job_srv', 4], ['usr_payton', 'job_coc', 5], ['usr_jorge', 'job_door', 5]];
    for (const [userId, jobCodeId, offset] of extras) {
      const date = addDays(week, offset - 7 * back);
      if (date >= today || !users.has(userId)) continue;
      entry(userId, jobCodeId, date, toMin('17:00') + Math.round(rand() * 30), toMin('23:00') + Math.round(rand() * 45));
    }
  }
  // One forgotten clock-out that Toast closed automatically.
  const last = store.list('timeEntries', (t) => t.demo && t.userId === 'usr_wilder').sort((a, b) => b.date.localeCompare(a.date))[0];
  if (last) store.update('timeEntries', last.id, { autoClockedOut: true });
  return { entries: n, days: daysBetween(addDays(week, -14), today) };
}
