// Date helpers, copied from core/time.js and core/forecast.js (keep them in step). The phone app keeps its own
// typed copy instead of importing ../core, so Metro and EAS Build only need the mobile/ folder.
// Dates are wall-clock strings 'YYYY-MM-DD' and times 'HH:MM', in the restaurant's time zone.

export const pad = (n: number) => String(n).padStart(2, '0');

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtDate(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

/** 0 = Sunday */
export const dow = (s: string) => parseDate(s).getUTCDay();

export const daysBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);

export function weekStart(s: string, startDow = 1): string {
  return addDays(s, -((dow(s) - startDow + 7) % 7));
}

export const range = (start: string, count: number) => Array.from({ length: count }, (_, i) => addDays(start, i));

export function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** The phone's local date (the server's `today` is preferred: it is in the restaurant's time zone). */
export function todayStr(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function fromMin(m: number): string {
  m = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Absolute minutes since 2000-01-01 for a shift's start and end (an end at or before the start is the next day). */
export function shiftSpan(shift: { date: string; start: string; end?: string | null }): [number, number] {
  const base = daysBetween('2000-01-01', shift.date) * 1440;
  const s = toMin(shift.start);
  let e = shift.end ? toMin(shift.end) : s + 7 * 60;
  if (e <= s) e += 1440;
  return [base + s, base + e];
}

/**
 * "Until close" shifts with an estimated end (copied from core/forecast.js effectiveShift): the shorter of
 * closing time and the restaurant's cap (openEndHours), at least 3 hours.
 */
export function effectiveShift<S extends { date: string; start: string; end?: string | null }>(
  shift: S, settings: { hours?: Record<string, { close?: string }>; openEndHours?: number },
): S & { estimatedEnd?: boolean } {
  if (shift.end) return shift;
  const h = settings.hours?.[String(dow(shift.date))];
  const startM = toMin(shift.start);
  const cap = (settings.openEndHours || 7) * 60;
  let dur = cap;
  if (h?.close) {
    const c = toMin(h.close);
    dur = Math.min(c > startM ? c - startM : c + 1440 - startM, cap);
  }
  dur = Math.max(dur, 180);
  return { ...shift, end: fromMin(startM + dur), estimatedEnd: true };
}

/** Now on the same scale as shiftSpan: the restaurant's date and the phone's clock. */
export function absNow(today: string, now = new Date()): number {
  return daysBetween('2000-01-01', today) * 1440 + now.getHours() * 60 + now.getMinutes();
}

/** First day of the month and the days to show in a month grid (whole weeks). */
export function monthGrid(month: string, startDow = 0): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const start = weekStart(first, startDow);
  const next = addDays(first, 32).slice(0, 7) + '-01';
  const end = addDays(weekStart(addDays(next, -1), startDow), 6);
  return range(start, daysBetween(start, end) + 1);
}
