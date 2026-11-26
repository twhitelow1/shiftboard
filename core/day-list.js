// Who's on the schedule for a day, sorted the way the reader picks (the day lists: the website's day
// view, the phone app's schedule day and "Today on the floor"):
//   room      each room's banner, then its positions, in Settings → Rooms & positions order (the default,
//             and how the day view has always looked)
//   position  one group per position (job type) across every room, in the positions' order; each line
//             says which room
//   time      one list by start time, then name; each line says position · room
//   name      one list A–Z by the name people go by (in the reader's language); each line says
//             position · room · time
// A shift shows where the schedule shows it (core/layout.js buildSections): in a room of the layout,
// under a position that isn't hidden there. Shifts in hidden or unlisted sections never show, in any
// order. Open shifts show in every order: in their section or position, and by time in the single lists
// (after anyone starting at the same time). mobile/src/lib/dayList.ts is a copy for the phone app (keep
// them in step; test/day-list.test.js runs the same cases on both).
import { cleanArea, sameArea } from './areas.js';

export const DAY_SORTS = ['room', 'position', 'time', 'name'];
/** A saved or asked-for order, or the fallback when it isn't one. */
export const daySort = (v, fallback = 'room') => (DAY_SORTS.includes(v) ? v : fallback);

/** The room and position a shift shows under, from the layout: { ri, room } or null (hidden or unlisted). */
export function placeOf(shift, job, layout) {
  if (!job) return null;
  const rooms = layout?.rooms || [];
  const name = cleanArea(shift?.area) || cleanArea(job.department) || '';
  const ri = name ? rooms.findIndex((r) => sameArea(r.room, name)) : -1;
  if (ri < 0) return null;
  const pos = rooms[ri].positions.find((p) => p.jobCodeId === job.id);
  return pos && !pos.hidden ? { ri, room: rooms[ri].room } : null;
}

/** Compares names in the reader's language: accents and ñ sort the way they read them, case doesn't matter. */
export function nameCompare(lang = 'en') {
  let c;
  try { c = new Intl.Collator(lang, { sensitivity: 'base', numeric: true }); } catch { c = new Intl.Collator('en', { sensitivity: 'base', numeric: true }); }
  return (a, b) => c.compare(String(a ?? ''), String(b ?? ''));
}

/**
 * One day's list, grouped and sorted.
 *   shifts   the day's shifts (a phone may pass last night's too: time order uses date + start)
 *   jobs     { id: jobCode }
 *   people   { id: person } (a shift for someone not in it doesn't show, like the schedule's rows)
 *   layout   { rooms } (staff get it without hidden positions)
 *   mode     room | position | time | name
 *   lang     the reader's language, for name order
 *   meId, mine   "Just me": only the reader's shifts (no open shifts)
 *   room     only this room ('' = every room)
 * Returns { mode, count, groups: [{ key, room, roomCount, job, count, items }] }. In room order each
 * group is a position in a room (room: its banner, roomCount: that room's shifts); in position order a
 * position (room: null); time and name order give one group (key 'all', job: null). Each item is
 * { shift, job, person, room, open }.
 */
export function dayList({ shifts = [], jobs = {}, people = {}, layout, mode = 'room', lang = 'en', meId = '', mine = false, room = '' }) {
  const sort = daySort(mode);
  const byName = nameCompare(lang);
  const items = [];
  for (const shift of shifts) {
    const job = jobs[shift.jobCodeId];
    const place = placeOf(shift, job, layout);
    if (!place) continue;
    if (room && !sameArea(place.room, room)) continue;
    if (mine && (!shift.userId || shift.userId !== meId)) continue;
    const person = shift.userId ? people[shift.userId] || null : null;
    if (shift.userId && !person) continue;
    items.push({ shift, job, person, room: place.room, ri: place.ri, open: !shift.userId });
  }
  const when = (x) => `${x.shift.date || ''} ${x.shift.start || ''}`;
  const byTime = (a, b) => when(a).localeCompare(when(b)) || a.open - b.open || byName(a.person?.name, b.person?.name);
  const out = (x) => ({ shift: x.shift, job: x.job, person: x.person, room: x.room, open: x.open });
  const jobOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || byName(a.name, b.name);

  let groups = [];
  if (sort === 'room') {
    const map = new Map();
    const rooms = layout?.rooms || [];
    for (const x of items) {
      const k = `${x.ri}|${x.job.id}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(x);
    }
    rooms.forEach((r, ri) => {
      for (const p of r.positions) {
        const list = map.get(`${ri}|${p.jobCodeId}`);
        if (!list?.length) continue;
        groups.push({ key: `${r.room}|${p.jobCodeId}`, room: r.room, roomCount: 0, job: list[0].job, count: list.length, items: list.sort(byTime).map(out) });
      }
    });
    for (const g of groups) g.roomCount = groups.filter((x) => x.room === g.room).reduce((n, x) => n + x.count, 0);
  } else if (sort === 'position') {
    const map = new Map();
    for (const x of items) {
      if (!map.has(x.job.id)) map.set(x.job.id, []);
      map.get(x.job.id).push(x);
    }
    groups = [...map.values()].sort((a, b) => jobOrder(a[0].job, b[0].job))
      .map((list) => ({ key: `pos|${list[0].job.id}`, room: null, roomCount: 0, job: list[0].job, count: list.length, items: list.sort(byTime).map(out) }));
  } else if (items.length) {
    const list = sort === 'time' ? items.sort(byTime)
      // By name; open shifts (no name) after everyone, by time.
      : items.sort((a, b) => a.open - b.open || (a.open ? 0 : byName(a.person.name, b.person.name)) || byTime(a, b));
    groups = [{ key: 'all', room: null, roomCount: 0, job: null, count: list.length, items: list.map(out) }];
  }
  return { mode: sort, count: items.length, groups };
}

/**
 * The week grid "by position": the schedule's sections (buildSections, already filtered) merged per
 * position across rooms, in the positions' order. A person who works it in two rooms is one row with
 * both rooms' shifts; `area` is where a new shift on their row goes (the first room they're listed in).
 * Each section keeps `rooms`, the rooms it came from, and `roomOf` (shift id → room) for the cells.
 */
export function positionSections(sections = [], lang = 'en') {
  const byName = nameCompare(lang);
  const map = new Map();
  for (const sec of sections) {
    if (!sec.job) continue;
    let g = map.get(sec.job.id);
    if (!g) map.set(sec.job.id, (g = { key: `pos|${sec.job.id}`, job: sec.job, label: sec.job.name, banner: '', area: sec.area, room: sec.room, rooms: [], rows: [], open: [], roomOf: {} }));
    if (!g.rooms.some((r) => sameArea(r, sec.room))) g.rooms.push(sec.room);
    for (const row of sec.rows) {
      let r = g.rows.find((x) => x.user.id === row.user.id);
      if (!r) g.rows.push((r = { user: row.user, shifts: [], area: sec.area }));
      r.shifts = [...r.shifts, ...row.shifts];
      for (const s of row.shifts) g.roomOf[s.id] = sec.room;
    }
    g.open = [...g.open, ...sec.open];
    for (const s of sec.open) g.roomOf[s.id] = sec.room;
  }
  return [...map.values()].sort((a, b) => (a.job.order ?? 1e9) - (b.job.order ?? 1e9) || byName(a.job.name, b.job.name));
}
