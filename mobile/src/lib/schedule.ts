// Schedule helpers shared by the screens. The grouping follows the website's day view
// (web/src/pages/Schedule.jsx): a room's banner (Restaurant, Rabbit Hole…), then each position
// worked there, in the order of Settings → Rooms & positions (core/layout.js). Area matching is
// copied from core/areas.js. Each banner has its room's color (Settings → Rooms & positions), like the
// website's schedule sheet (web/src/pages/ScheduleSheet.jsx, core/areas.js bannerColor).
import { bannerColor, textOn } from './theme';
import type { JobCode, Layout, Person, Settings, Shift } from './types';

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
  /** The banner's fill: the room's color, else a steady one by its place. */
  bannerColor: string;
  /** Black or white, whichever reads on the banner's fill. */
  bannerText: string;
  job: JobCode;
  shifts: Shift[];
}

const fill = (color: string) => ({ bannerColor: color, bannerText: textOn(color) });

/**
 * One day's shifts grouped like the web day view: room banner, then position, by start time. With the
 * server's layout, rooms and positions come in its order and shifts in hidden or unlisted sections
 * don't show (core/layout.js buildSections); older servers send none, and the old grouping applies.
 */
export function daySections(shifts: Shift[], jobs: Record<string, JobCode>, settings: Settings, layout?: Layout): DaySection[] {
  if (layout) {
    const out: DaySection[] = [];
    const placed = new Map<string, Shift[]>();
    for (const s of shifts) {
      const job = jobs[s.jobCodeId];
      if (!job) continue;
      const room = cleanArea(s.area) || cleanArea(job.department);
      const ri = room ? layout.rooms.findIndex((r) => sameArea(r.room, room)) : -1;
      const pos = ri >= 0 ? layout.rooms[ri].positions.find((p) => p.jobCodeId === job.id) : undefined;
      if (!pos || pos.hidden) continue;
      const k = `${ri}|${job.id}`;
      placed.set(k, [...(placed.get(k) || []), s]);
    }
    layout.rooms.forEach((r, ri) => {
      for (const p of r.positions) {
        const list = placed.get(`${ri}|${p.jobCodeId}`);
        if (!list?.length || p.hidden) continue;
        out.push({ key: `${r.room.toLowerCase()}|${p.jobCodeId}`, banner: r.room, ...fill(bannerColor(settings, r.room, ri)), job: jobs[p.jobCodeId], shifts: list.sort((x, y) => x.start.localeCompare(y.start)) });
      }
    });
    return out;
  }
  const areas = scheduleAreas(settings);
  const groups = new Map<string, DaySection & { isArea: boolean }>();
  for (const s of shifts) {
    const job = jobs[s.jobCodeId];
    if (!job) continue;
    const raw = s.area || job.department || '';
    const banner = findArea(raw, areas) || raw;
    const k = `${banner.toLowerCase()}|${job.id}`;
    if (!groups.has(k)) groups.set(k, { key: k, banner, ...fill(''), job, shifts: [], isArea: !!findArea(banner, areas) });
    groups.get(k)!.shifts.push(s);
  }
  // Department banners first (in job order), then areas in the schedule's area order.
  const firstJob: Record<string, number> = {};
  for (const g of groups.values()) firstJob[g.banner] = Math.min(firstJob[g.banner] ?? 1e9, g.job.order ?? 1e9);
  const rank = (g: { isArea: boolean; banner: string }) => (g.isArea ? 1e6 + areas.findIndex((a) => sameArea(a, g.banner)) : firstJob[g.banner]);
  const order: string[] = [];
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b) || a.banner.localeCompare(b.banner) || (a.job.order ?? 0) - (b.job.order ?? 0) || a.job.name.localeCompare(b.job.name))
    .map(({ isArea, ...g }) => {
      if (!order.some((x) => sameArea(x, g.banner))) order.push(g.banner);
      const i = order.findIndex((x) => sameArea(x, g.banner));
      return { ...g, ...fill(bannerColor(settings, g.banner, i)), shifts: g.shifts.sort((x, y) => x.start.localeCompare(y.start)) };
    });
}

export const byStart = (a: Shift, b: Shift) => (a.date + a.start).localeCompare(b.date + b.start);

/** Can this person trade or give away this shift now (theirs, posted, ahead, nothing pending)? */
export const canTrade = (s: Shift, meId: string, today: string) => s.userId === meId && !!s.published && s.date >= today && !s.pending;

/** Is this person set up for the shift's position? */
export const qualified = (p: Person | undefined, jobCodeId: string) => !!p?.jobCodes?.some((j) => j.jobCodeId === jobCodeId);
