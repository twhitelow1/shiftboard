// Schedule helpers shared by the screens. The grouping follows the website's day view
// (web/src/pages/Schedule.jsx): an area banner (Restaurant, Rabbit Hole…), then each position
// worked there. Area matching is copied from core/areas.js.
import type { JobCode, Person, Settings, Shift } from './types';

const BOOKING_ONLY = /full buyout/i;
const key = (s?: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const cleanArea = (s?: string) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
export const sameArea = (a?: string, b?: string) => !!key(a) && key(a) === key(b);

/** The schedule's areas in display order (settings.areas, then rooms not already listed). */
export function scheduleAreas(settings: Settings): string[] {
  const out: string[] = [];
  for (const a of [...(settings.areas || []), ...(settings.rooms || []).filter((r) => !BOOKING_ONLY.test(r))]) {
    const name = cleanArea(a);
    if (name && !out.some((x) => sameArea(x, name))) out.push(name);
  }
  return out;
}
export const findArea = (name: string, areas: string[]) => areas.find((a) => sameArea(a, name)) || null;

export interface DaySection {
  key: string;
  banner: string;
  job: JobCode;
  shifts: Shift[];
}

/** One day's shifts grouped like the web day view: area banner, then position, by start time. */
export function daySections(shifts: Shift[], jobs: Record<string, JobCode>, settings: Settings): DaySection[] {
  const areas = scheduleAreas(settings);
  const groups = new Map<string, DaySection & { isArea: boolean }>();
  for (const s of shifts) {
    const job = jobs[s.jobCodeId];
    if (!job) continue;
    const raw = s.area || job.department || '';
    const banner = findArea(raw, areas) || raw;
    const k = `${banner.toLowerCase()}|${job.id}`;
    if (!groups.has(k)) groups.set(k, { key: k, banner, job, shifts: [], isArea: !!findArea(banner, areas) });
    groups.get(k)!.shifts.push(s);
  }
  // Department banners first (in job order), then areas in the schedule's area order.
  const firstJob: Record<string, number> = {};
  for (const g of groups.values()) firstJob[g.banner] = Math.min(firstJob[g.banner] ?? 1e9, g.job.order ?? 1e9);
  const rank = (g: { isArea: boolean; banner: string }) => (g.isArea ? 1e6 + areas.findIndex((a) => sameArea(a, g.banner)) : firstJob[g.banner]);
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b) || a.banner.localeCompare(b.banner) || (a.job.order ?? 0) - (b.job.order ?? 0) || a.job.name.localeCompare(b.job.name))
    .map(({ isArea, ...g }) => ({ ...g, shifts: g.shifts.sort((x, y) => x.start.localeCompare(y.start)) }));
}

export const byStart = (a: Shift, b: Shift) => (a.date + a.start).localeCompare(b.date + b.start);

/** Can this person trade or give away this shift now (theirs, posted, ahead, nothing pending)? */
export const canTrade = (s: Shift, meId: string, today: string) => s.userId === meId && !!s.published && s.date >= today && !s.pending;

/** Is this person set up for the shift's position? */
export const qualified = (p: Person | undefined, jobCodeId: string) => !!p?.jobCodes?.some((j) => j.jobCodeId === jobCodeId);
