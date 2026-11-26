// Dates for the tools, in the restaurant's time zone (the process runs in it: server/tz.js). Tools take
// YYYY-MM-DD, and also the words people say: "today", "tomorrow", "friday" / "this friday" (the next one,
// today included), "next friday" (the one after that), in English or Spanish ("hoy", "mañana", "viernes").
import { addDays, dow, weekStart, todayStr } from '../../core/time.js';
import { AppError } from '../../core/service.js';

const DAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const plain = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

export const DATE_HELP = 'YYYY-MM-DD, or "today", "tomorrow", "yesterday", or a weekday like "friday" (the next one, today included) or "next friday"';

/** The restaurant's today (YYYY-MM-DD). */
export const todayOf = (nowMs = Date.now()) => todayStr(new Date(nowMs));

/** A date from what someone typed; throws a 400 the person can act on. */
export function resolveDate(input, today) {
  const s = plain(input);
  if (!s || s === 'today' || s === 'hoy' || s === 'tonight' || s === 'esta noche') return today;
  if (ISO.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) return s;
  }
  if (s === 'tomorrow' || s === 'manana') return addDays(today, 1);
  if (s === 'yesterday' || s === 'ayer') return addDays(today, -1);
  if (s === 'day after tomorrow' || s === 'pasado manana') return addDays(today, 2);
  const m = /^(this |next |este |el proximo |proximo |el )?([a-z]+)( que viene| proximo)?$/.exec(s);
  if (m && m[2] in DAYS) {
    const ahead = (DAYS[m[2]] - dow(today) + 7) % 7;
    const next = /next|proximo|que viene/.test(`${m[1] || ''}${m[3] || ''}`);
    return addDays(today, ahead + (next ? 7 : 0));
  }
  throw new AppError(400, `Use a date like ${today}, “today”, “tomorrow” or a weekday`);
}

/** A week's first day for a date or "this week" / "next week" / "last week". */
export function resolveWeek(input, today, startDow = 1) {
  const s = plain(input);
  if (!s || s === 'this week' || s === 'esta semana') return weekStart(today, startDow);
  if (s === 'next week' || s === 'la proxima semana' || s === 'proxima semana' || s === 'la semana que viene') return addDays(weekStart(today, startDow), 7);
  if (s === 'last week' || s === 'la semana pasada' || s === 'semana pasada') return addDays(weekStart(today, startDow), -7);
  return weekStart(resolveDate(s, today), startDow);
}

/** { from, to } from optional from/to (defaults: today, and `days` days after from), at most `max` days. */
export function resolveRange({ from, to } = {}, today, { days = 14, max = 62 } = {}) {
  const a = from ? resolveDate(from, today) : today;
  let b = to ? resolveDate(to, today) : addDays(a, days - 1);
  if (b < a) throw new AppError(400, 'The end date is before the start date');
  if (addDays(a, max - 1) < b) b = addDays(a, max - 1);
  return { from: a, to: b };
}
