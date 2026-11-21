// Date helpers, copied from core/time.js (keep them in step). The phone app keeps its own
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

/** First day of the month and the days to show in a month grid (whole weeks). */
export function monthGrid(month: string, startDow = 0): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const start = weekStart(first, startDow);
  const next = addDays(first, 32).slice(0, 7) + '-01';
  const end = addDays(weekStart(addDays(next, -1), startDow), 6);
  return range(start, daysBetween(start, end) + 1);
}
