// Who's on the schedule for a day, sorted the way the reader picks: by room (each room's banner, then its
// positions, in Settings → Rooms & positions order), by position (job type) across rooms, by start time, or
// by name. Copied from core/day-list.js (keep them in step; test/day-list.test.js runs the same cases on
// both). Shifts in hidden or unlisted sections never show; open shifts show in every order.
// Self-contained (only type imports) so the tests can load it without the app.
import type { JobCode, Layout, Person, Shift } from './types';

export type DaySort = 'room' | 'position' | 'time' | 'name';
export const DAY_SORTS: DaySort[] = ['room', 'position', 'time', 'name'];
/** A saved or asked-for order, or the fallback when it isn't one. */
export const daySort = (v: unknown, fallback: DaySort = 'room'): DaySort => (DAY_SORTS.includes(v as DaySort) ? (v as DaySort) : fallback);

const key = (s?: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanArea = (s?: string) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const sameArea = (a?: string, b?: string) => !!key(a) && key(a) === key(b);

/** The room and position a shift shows under, from the layout, or null (hidden or unlisted). */
export function placeOf(shift: Shift, job: JobCode | undefined, layout: Layout | undefined): { ri: number; room: string } | null {
  if (!job) return null;
  const rooms = layout?.rooms || [];
  const name = cleanArea(shift.area) || cleanArea(job.department) || '';
  const ri = name ? rooms.findIndex((r) => sameArea(r.room, name)) : -1;
  if (ri < 0) return null;
  const pos = rooms[ri].positions.find((p) => p.jobCodeId === job.id);
  return pos && !pos.hidden ? { ri, room: rooms[ri].room } : null;
}

/** Compares names in the reader's language: accents and ñ sort the way they read them, case doesn't matter. */
export function nameCompare(lang = 'en') {
  let c: Intl.Collator;
  try { c = new Intl.Collator(lang, { sensitivity: 'base', numeric: true }); } catch { c = new Intl.Collator('en', { sensitivity: 'base', numeric: true }); }
  return (a?: string | null, b?: string | null) => c.compare(String(a ?? ''), String(b ?? ''));
}

export interface DayItem { shift: Shift; job: JobCode; person: Person | null; room: string; open: boolean }
export interface DayGroup { key: string; room: string | null; roomCount: number; job: JobCode | null; count: number; items: DayItem[] }

/**
 * One day's list, grouped and sorted (see core/day-list.js dayList). In room order each group is a
 * position in a room (room: its banner, roomCount: that room's shifts); in position order a position;
 * time and name order give one group (key 'all').
 */
export function dayList({ shifts = [], jobs = {}, people = {}, layout, mode = 'room', lang = 'en', meId = '', mine = false, room = '', keepUnplaced = false }: {
  shifts?: Shift[]; jobs?: Record<string, JobCode>; people?: Record<string, Person>; layout?: Layout; mode?: DaySort | string;
  lang?: string; meId?: string; mine?: boolean; room?: string;
  /** Who's actually on the floor: keep shifts in hidden or unlisted sections too (after the layout's rooms). */
  keepUnplaced?: boolean;
}): { mode: DaySort; count: number; groups: DayGroup[] } {
  const sort = daySort(mode);
  const byName = nameCompare(lang);
  type Placed = DayItem & { ri: number };
  const items: Placed[] = [];
  for (const shift of shifts) {
    const job = jobs[shift.jobCodeId];
    const place = placeOf(shift, job, layout)
      || (job && keepUnplaced ? { ri: 1e6, room: cleanArea(shift.area) || cleanArea(job.department) || '' } : null);
    if (!job || !place) continue;
    if (room && !sameArea(place.room, room)) continue;
    if (mine && (!shift.userId || shift.userId !== meId)) continue;
    const person = shift.userId ? people[shift.userId] || null : null;
    if (shift.userId && !person) continue;
    items.push({ shift, job, person, room: place.room, ri: place.ri, open: !shift.userId });
  }
  const when = (x: Placed) => `${x.shift.date || ''} ${x.shift.start || ''}`;
  const byTime = (a: Placed, b: Placed) => when(a).localeCompare(when(b)) || Number(a.open) - Number(b.open) || byName(a.person?.name, b.person?.name);
  const out = (x: Placed): DayItem => ({ shift: x.shift, job: x.job, person: x.person, room: x.room, open: x.open });
  const jobOrder = (a: JobCode, b: JobCode) => (a.order ?? 1e9) - (b.order ?? 1e9) || byName(a.name, b.name);

  let groups: DayGroup[] = [];
  if (sort === 'room') {
    const map = new Map<string, Placed[]>();
    for (const x of items) {
      const k = `${x.ri}|${x.job.id}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(x);
    }
    (layout?.rooms || []).forEach((r, ri) => {
      for (const p of r.positions) {
        const list = map.get(`${ri}|${p.jobCodeId}`);
        if (!list?.length) continue;
        groups.push({ key: `${r.room}|${p.jobCodeId}`, room: r.room, roomCount: 0, job: list[0].job, count: list.length, items: list.sort(byTime).map(out) });
      }
    });
    // Kept unplaced shifts (keepUnplaced): after the layout's rooms, by room name then position.
    const extra = [...map.entries()].filter(([k]) => k.startsWith('1000000|'));
    const byRoom = new Map<string, Placed[]>();
    for (const [, list] of extra) for (const x of list) { const k = `${x.room}|${x.job.id}`; if (!byRoom.has(k)) byRoom.set(k, []); byRoom.get(k)!.push(x); }
    [...byRoom.values()].sort((a, b) => byName(a[0].room, b[0].room) || jobOrder(a[0].job, b[0].job))
      .forEach((list) => groups.push({ key: `x|${list[0].room}|${list[0].job.id}`, room: list[0].room || null, roomCount: 0, job: list[0].job, count: list.length, items: list.sort(byTime).map(out) }));
    for (const g of groups) g.roomCount = groups.filter((x) => x.room === g.room).reduce((n, x) => n + x.count, 0);
  } else if (sort === 'position') {
    const map = new Map<string, Placed[]>();
    for (const x of items) {
      if (!map.has(x.job.id)) map.set(x.job.id, []);
      map.get(x.job.id)!.push(x);
    }
    groups = [...map.values()].sort((a, b) => jobOrder(a[0].job, b[0].job))
      .map((list) => ({ key: `pos|${list[0].job.id}`, room: null, roomCount: 0, job: list[0].job, count: list.length, items: list.sort(byTime).map(out) }));
  } else if (items.length) {
    const list = sort === 'time' ? items.sort(byTime)
      // By name; open shifts (no name) after everyone, by time.
      : items.sort((a, b) => Number(a.open) - Number(b.open) || (a.open ? 0 : byName(a.person!.name, b.person!.name)) || byTime(a, b));
    groups = [{ key: 'all', room: null, roomCount: 0, job: null, count: list.length, items: list.map(out) }];
  }
  return { mode: sort, count: items.length, groups };
}
