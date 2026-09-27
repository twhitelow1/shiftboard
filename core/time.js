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

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'p' : 'a';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${pad(m)}${suffix}` : `${hh}${suffix}`;
}

export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function prettyDate(s, opts = {}) {
  const d = parseDate(s);
  const base = `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
  return opts.dow === false ? base : `${DOW_SHORT[d.getUTCDay()]}, ${base}`;
}

export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
