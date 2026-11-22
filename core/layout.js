// The schedule's layout ("Rooms & positions" in Settings): an ordered list of rooms, which are the
// colored banners on the sheet (Restaurant, Rabbit Hole, Moon Rabbit…), each with an ordered list of
// the positions worked there. One document, collection 'layout', id 'layout':
//   { id, rev, rooms: [{ room, positions: [{ jobCodeId, label?, hidden? }] }] }
//  - room    a name from settings.areas. The layout keeps settings.areas in step: same names, same order.
//  - label   the section's name on the sheet ("Bar", "Cocktail"); none means the position's own name.
//  - hidden  never shown on the schedule (Sheet, grid, day view, print) and never offered when scheduling.
//
// A shift sits in the section (its room, its position): the room is the shift's area, else its
// position's department. A person is listed in a section when they hold the position in that room (a
// job code entry whose areas list the room or, with no areas, whose position's department is the room)
// or have a shift there that week.
//
// The first time it's needed, the layout is made from what the schedule showed before it existed: the
// sections built from shifts and people, in the order settings.sectionOrder and the positions gave
// them, with the imported sheet's labels. Nothing on the schedule moves until a manager changes it.
import { uid } from './store.js';
import { cleanArea, sameArea, findArea, scheduleAreas, uniqueAreas, bannerColor } from './areas.js';
import { offSchedule } from './roles.js';
import { weekStart } from './time.js';

export const LAYOUT_COL = 'layout';
export const LAYOUT_ID = 'layout';
const MAX_ROOMS = 100;
const MAX_POSITIONS = 200;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** Two room names for the same place; two empty names match too (a shift with no area and no department). */
const sameRoom = (a, b) => (cleanArea(a) || cleanArea(b) ? sameArea(a, b) : true);

/** The room a shift sits under: its area, else its position's department ('' when it has neither). */
export const roomOfShift = (shift, job) => cleanArea(shift?.area) || cleanArea(job?.department) || '';

/** The rooms a job code entry (user.jobCodes[i]) puts its person in: its areas, else the position's department. */
export const entryRooms = (entry, job) => (entry?.areas?.length ? uniqueAreas(entry.areas) : cleanArea(job?.department) ? [cleanArea(job.department)] : []);

/** Does this job code entry put its person in `room`? */
export function entryInRoom(entry, job, room) {
  if (!entry || !job || entry.jobCodeId !== job.id || !cleanArea(room)) return false;
  return entryRooms(entry, job).some((a) => sameArea(a, room));
}

/** Does this person hold the position in this room? */
export const holdsIn = (person, job, room) => (person?.jobCodes || []).some((e) => entryInRoom(e, job, room));

/** A room of the layout, by name. */
export const findRoom = (layout, name) => (layout?.rooms || []).find((r) => sameArea(r.room, name)) || null;
/** A room's entry for a position, or null. */
export const findPosition = (layout, room, jobCodeId) => findRoom(layout, room)?.positions.find((p) => p.jobCodeId === jobCodeId) || null;

/** The rooms that list a position: [{ room, hidden }], in layout order. */
export function roomsForPosition(layout, jobCodeId) {
  const out = [];
  for (const r of layout?.rooms || []) {
    const p = r.positions.find((x) => x.jobCodeId === jobCodeId);
    if (p) out.push({ room: r.room, hidden: !!p.hidden });
  }
  return out;
}

/** Where a position is usually worked: its department's room when that room shows it, else the first room that does ('' if none). */
export function homeRoom(layout, job) {
  if (!job) return '';
  const shown = roomsForPosition(layout, job.id).filter((r) => !r.hidden);
  return (shown.find((r) => sameArea(r.room, job.department)) || shown[0])?.room || '';
}

/** The layout people other than managers get: hidden positions left out. */
export function visibleLayout(layout) {
  return { rev: layout?.rev || 0, rooms: (layout?.rooms || []).map((r) => ({ room: r.room, positions: r.positions.filter((p) => !p.hidden) })) };
}

/** Give someone a position in a room (adding the position if they don't have it). Returns the new list. */
export function addRoom(jobCodes, job, room, rate = null) {
  const list = (jobCodes || []).map((e) => ({ ...e }));
  const name = cleanArea(room);
  const i = list.findIndex((e) => e.jobCodeId === job.id);
  if (i < 0) {
    list.push({ jobCodeId: job.id, rate, primary: !list.length, ...(name ? { areas: [name] } : {}) });
    return list;
  }
  if (!name || entryInRoom(list[i], job, name)) return list;
  // With no areas they work it in the department's room; keep that and add this one.
  list[i] = { ...list[i], areas: uniqueAreas([...entryRooms(list[i], job), name]) };
  return list;
}

/** Take a room off someone's position (dropping the position when that was its only room). Returns the new list. */
export function dropRoom(jobCodes, job, room) {
  const list = jobCodes || [];
  const i = list.findIndex((e) => e.jobCodeId === job.id);
  if (i < 0 || !entryInRoom(list[i], job, room)) return list;
  const keep = entryRooms(list[i], job).filter((a) => !sameArea(a, room));
  if (keep.length) return list.map((e, k) => (k === i ? { ...e, areas: keep } : e));
  const out = list.filter((_, k) => k !== i);
  if (list[i].primary && out.length && !out.some((e) => e.primary)) out[0] = { ...out[0], primary: true };
  return out;
}

/**
 * The layout the schedule showed before there was one: every section (banner + position) found in
 * the shifts, in people's positions, and (for positions nobody has yet) under each position's
 * department, in the order the schedule drew them: department banners first (by their positions'
 * order), then areas in the schedule's area order; inside a banner, settings.sectionOrder, then the
 * positions' own order. Labels come from the imported sheet (rosters). Areas with no sections yet
 * are kept as empty rooms, so every area is a room.
 */
export function seedLayout({ settings = {}, jobCodes = [], users = [], shifts = [], rosters = [] }) {
  const areaList = scheduleAreas(settings);
  const jobs = new Map(jobCodes.map((j) => [j.id, j]));
  const groups = new Map();
  const add = (banner, job) => {
    const name = findArea(banner, areaList) || cleanArea(banner);
    if (!name) return;
    const room = [...groups.values()].find((g) => sameArea(g.banner, name))?.banner || name;
    const k = `${room.toLowerCase()}|${job.id}`;
    if (!groups.has(k)) groups.set(k, { banner: room, isArea: !!findArea(room, areaList), job });
  };
  for (const sh of shifts) {
    const j = jobs.get(sh.jobCodeId);
    if (j) add(sh.area || j.department || '', j);
  }
  for (const u of users) {
    if (u.active === false || offSchedule(u)) continue;
    for (const e of u.jobCodes || []) {
      const j = jobs.get(e.jobCodeId);
      if (!j || j.archived) continue;
      for (const b of e.areas?.length ? e.areas : [j.department || '']) add(b, j);
    }
  }
  const placed = new Set([...groups.values()].map((g) => g.job.id));
  for (const j of jobCodes) if (!j.archived && !placed.has(j.id)) add(j.department || '', j);

  const firstJob = {};
  for (const g of groups.values()) firstJob[g.banner] = Math.min(firstJob[g.banner] ?? 1e9, g.job.order ?? 1e9);
  const areaRank = (name) => 1e6 + areaList.findIndex((a) => sameArea(a, name));
  const rank = (g) => (g.isArea ? areaRank(g.banner) : firstJob[g.banner]);
  const order = settings.sectionOrder || {};
  const placeIn = (g) => { const i = (order[g.banner.toLowerCase()] || []).indexOf(g.job.id); return i < 0 ? 1e6 : i; };
  const byJob = (a, b) => (a.job.order ?? 0) - (b.job.order ?? 0) || a.job.name.localeCompare(b.job.name);
  const sorted = [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.banner.localeCompare(b.banner) || placeIn(a) - placeIn(b) || byJob(a, b));

  const rooms = [];
  for (const g of sorted) {
    let r = rooms.find((x) => sameArea(x.room, g.banner));
    if (!r) rooms.push((r = { room: g.banner, rank: rank(g), positions: [] }));
    const area = g.isArea ? g.banner : '';
    const roster = rosters.find((x) => x.jobCodeId === g.job.id && (x.area ? sameArea(x.area, area) : !area));
    const label = text(roster?.label, 60);
    r.positions.push({ jobCodeId: g.job.id, ...(label ? { label } : {}) });
  }
  // Areas with nothing in them yet stay rooms, in the schedule's area order.
  for (const a of uniqueAreas(settings.areas || [])) {
    if (!rooms.some((r) => sameArea(r.room, a))) rooms.push({ room: a, rank: areaRank(a), positions: [] });
  }
  return rooms.sort((a, b) => a.rank - b.rank || a.room.localeCompare(b.room)).map(({ room, positions }) => ({ room, positions }));
}

/**
 * Check and clean a layout sent by a manager: [{ room, color?, positions: [{ jobCodeId, label?, hidden? }] }].
 * Room names are cleaned and must be unique; positions must exist (a repeat in one room is dropped).
 * Returns { rooms, colors } (colors: { room: '#rrggbb' } for the rooms that sent one).
 */
export function cleanLayout(raw, { jobExists, fail }) {
  if (!Array.isArray(raw) || raw.length > MAX_ROOMS) fail(400, 'Send the rooms and their positions');
  const rooms = [], colors = {};
  for (const r of raw) {
    const room = cleanArea(r?.room);
    if (!room) fail(400, 'Every room needs a name');
    if (rooms.some((x) => sameArea(x.room, room))) fail(400, `There’s already a room called ${room}`);
    const list = Array.isArray(r.positions) ? r.positions : [];
    if (list.length > MAX_POSITIONS) fail(400, 'Send the rooms and their positions');
    const positions = [];
    for (const p of list) {
      if (!p || typeof p.jobCodeId !== 'string' || !jobExists(p.jobCodeId)) fail(400, 'That position doesn’t exist');
      if (positions.some((x) => x.jobCodeId === p.jobCodeId)) continue;
      const label = text(p.label, 60);
      positions.push({ jobCodeId: p.jobCodeId, ...(label ? { label } : {}), ...(p.hidden ? { hidden: true } : {}) });
    }
    if (/^#[0-9a-f]{6}$/i.test(String(r.color || ''))) colors[room] = String(r.color).toLowerCase();
    rooms.push({ room, positions });
  }
  return { rooms, colors };
}

/**
 * The sheet's own layout for a section (its name order): the roster kept under the room. A room that
 * isn't an area yet (a department's banner, until the layout is first saved) also finds the one kept
 * under no area, where those banners' names were kept before.
 */
function rosterFor(rosters, job, room, isArea) {
  return rosters.find((r) => r.jobCodeId === job.id && r.area && sameArea(r.area, room))
    || (!isArea && rosters.find((r) => r.jobCodeId === job.id && !r.area && sameArea(job.department, room))) || null;
}

/**
 * The area a shift in this room is saved with: the room, except a department's room that isn't an
 * area yet (until the layout is first saved), where it's no area, as the schedule has always done.
 */
export function areaForRoom(room, job, settings = {}) {
  const name = cleanArea(room);
  if (!name) return '';
  return !findArea(name, scheduleAreas(settings)) && sameArea(name, job?.department) ? '' : name;
}

/**
 * The schedule's sections for one week, from the layout: each room's shown positions, in layout
 * order. A section's rows are the people who hold the position in that room, plus anyone with a
 * shift there that week, in the sheet's name order (rosters), then their own order, then by name.
 * An archived position shows only in a week it has shifts.
 *   layout     { rooms } (staff get it without hidden positions)
 *   jobs       { id: jobCode }
 *   employees  everyone the viewer can see (bootstrap), active or not
 *   shifts     the week's shifts
 *   settings   for which rooms are areas (a section's `area` is '' for a room that isn't one yet)
 * Returns { sections, stray }: stray lists the shifts in hidden or unlisted sections
 * ([{ room, jobCodeId, hidden, shifts }]), which never show on the schedule.
 */
export function buildSections({ layout, jobs = {}, employees = [], shifts = [], rosters = [], settings = {} }) {
  const rooms = layout?.rooms || [];
  const areaList = scheduleAreas(settings);
  const onSchedule = employees.filter((e) => e.active !== false && !offSchedule(e));
  const people = new Map(employees.map((e) => [e.id, e]));
  const placed = new Map();
  const stray = new Map();
  for (const sh of shifts) {
    const job = jobs[sh.jobCodeId];
    if (!job) continue;
    const room = roomOfShift(sh, job);
    const ri = room ? rooms.findIndex((r) => sameArea(r.room, room)) : -1;
    const pos = ri >= 0 ? rooms[ri].positions.find((p) => p.jobCodeId === job.id) : null;
    if (pos && !pos.hidden) {
      const k = `${ri}|${job.id}`;
      if (!placed.has(k)) placed.set(k, []);
      placed.get(k).push(sh);
      continue;
    }
    const name = ri >= 0 ? rooms[ri].room : room;
    const k = `${name.toLowerCase()}|${job.id}`;
    if (!stray.has(k)) stray.set(k, { room: name, jobCodeId: job.id, hidden: !!pos?.hidden, shifts: [] });
    stray.get(k).shifts.push(sh);
  }
  const sections = [];
  rooms.forEach((r, ri) => {
    for (const p of r.positions) {
      const job = jobs[p.jobCodeId];
      if (!job || p.hidden) continue;
      const list = placed.get(`${ri}|${job.id}`) || [];
      if (job.archived && !list.length) continue;
      const ids = new Set();
      if (!job.archived) for (const e of onSchedule) if (holdsIn(e, job, r.room)) ids.add(e.id);
      for (const sh of list) if (sh.userId) ids.add(sh.userId);
      const isArea = !!findArea(r.room, areaList);
      const roster = rosterFor(rosters, job, r.room, isArea);
      const at = (id) => { const i = roster?.userIds?.indexOf(id) ?? -1; return i < 0 ? 1e9 : i; };
      const rows = [...ids].map((id) => people.get(id)).filter(Boolean).map((u) => ({ user: u, shifts: list.filter((x) => x.userId === u.id) }));
      rows.sort((a, b) => at(a.user.id) - at(b.user.id) || (a.user.order ?? 1e9) - (b.user.order ?? 1e9) || a.user.name.localeCompare(b.user.name));
      // area: what a new shift here is saved with (areaForRoom); sheetBanner: a department banner as the sheet wrote it.
      const area = !isArea && sameArea(r.room, job.department) ? '' : r.room;
      sections.push({ key: `${r.room}|${job.id}`, job, banner: r.room, area, room: r.room, roomIndex: ri, label: job.name, rows,
        open: list.filter((x) => !x.userId), sheetLabel: p.label || null, sheetBanner: roster?.banner || '' });
    }
  });
  return { sections, stray: [...stray.values()] };
}

/**
 * What the shift editor offers: rooms first (those with a shown position), then that room's shown
 * positions, then people: the ones who hold the position in that room (holders), and everyone else
 * (others, behind "Show everyone": picking one of them gives them the position).
 */
export function shiftChoices({ layout, jobs = {}, employees = [], room = '', jobCodeId = '' }) {
  const rooms = [];
  for (const r of layout?.rooms || []) {
    const positions = r.positions.filter((p) => !p.hidden && jobs[p.jobCodeId] && !jobs[p.jobCodeId].archived).map((p) => jobs[p.jobCodeId]);
    if (positions.length) rooms.push({ room: r.room, positions });
  }
  const positions = rooms.find((r) => sameArea(r.room, room))?.positions || [];
  const job = jobs[jobCodeId];
  const byName = (a, b) => a.name.localeCompare(b.name);
  const active = employees.filter((e) => e.active !== false && !offSchedule(e));
  const holders = job && cleanArea(room) ? active.filter((e) => holdsIn(e, job, room)).sort(byName) : [];
  const others = active.filter((e) => !holders.includes(e)).sort(byName);
  return { rooms, positions, holders, others };
}

/**
 * The layout on the server: read (made and saved the first time), written (settings.areas follows),
 * kept in step when positions merge or go away, and the manager API (layout.*).
 *   putSettings(patch)  writes settings
 */
export function layoutService({ store, settings, putSettings, fail, needMgr, now, today }) {
  const stamp = () => now().toISOString();
  const jobsById = () => Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  const jobOf = (id) => {
    const j = typeof id === 'string' ? store.get('jobCodes', id) : null;
    if (!j) fail(404, 'That position doesn’t exist');
    return j;
  };

  /** settings.areas follows the rooms (names and order); a department that just became a room keeps its sheet names. */
  function syncAreas(rooms) {
    const st = settings();
    const before = scheduleAreas(st);
    const names = rooms.map((r) => r.room);
    const cur = st.areas || [];
    if (cur.length !== names.length || names.some((n, i) => cur[i] !== n)) putSettings({ areas: names });
    // A banner that was a department (no area) kept its names' order under no area; it's a room now.
    const jobs = jobsById();
    for (const r of store.list('rosters', (x) => !x.area)) {
      const job = jobs[r.jobCodeId];
      const room = job && names.find((n) => sameArea(n, job.department));
      if (!room || findArea(room, before)) continue;
      const id = `${room.toLowerCase()}|${job.id}`;
      if (store.get('rosters', id)) continue;
      store.insert('rosters', { ...r, id, area: room });
      store.remove('rosters', r.id);
    }
  }

  /**
   * The layout: the saved one, or until something changes it, the one the schedule has always shown
   * (seedLayout, worked out from the data each time and saved by the first change). Reading never writes.
   */
  function current() {
    const doc = store.get(LAYOUT_COL, LAYOUT_ID);
    if (doc) return doc;
    // Each (area, position) once, without copying every shift.
    const pairs = new Map();
    store.list('shifts', (s) => { const k = `${s.area || ''}|${s.jobCodeId}`; if (!pairs.has(k)) pairs.set(k, { area: s.area || '', jobCodeId: s.jobCodeId }); return false; });
    const rooms = seedLayout({ settings: settings(), jobCodes: store.list('jobCodes'), users: store.list('users'), shifts: [...pairs.values()], rosters: store.list('rosters') });
    return { id: LAYOUT_ID, rev: 0, rooms, seeded: true };
  }

  function write(rooms, actor) {
    const at = stamp();
    const doc = store.get(LAYOUT_COL, LAYOUT_ID)
      ? store.update(LAYOUT_COL, LAYOUT_ID, { rooms, rev: (store.get(LAYOUT_COL, LAYOUT_ID).rev || 0) + 1, updatedAt: at, updatedBy: actor?.id || null })
      : store.insert(LAYOUT_COL, { id: LAYOUT_ID, rev: 1, rooms, seededAt: at, updatedAt: at, updatedBy: actor?.id || null });
    syncAreas(rooms);
    return doc;
  }

  /** Change the rooms with fn(rooms) (a copy); saved only when something changed. */
  function change(fn, actor) {
    const cur = current();
    const rooms = clone(cur.rooms);
    fn(rooms);
    return JSON.stringify(rooms) === JSON.stringify(cur.rooms) ? cur : write(rooms, actor);
  }

  /**
   * Make sure each (room, position) pair is in the layout: a new pair goes at the end of its room,
   * shown, and a new room at the end. A label, when given, becomes the section's name on the sheet.
   * Hidden pairs stay hidden.
   */
  function ensurePairs(pairs, actor) {
    const jobs = jobsById();
    return change((rooms) => {
      for (const p of pairs) {
        const name = cleanArea(p.room);
        if (!name || !jobs[p.jobCodeId]) continue;
        let r = rooms.find((x) => sameArea(x.room, name));
        if (!r) rooms.push((r = { room: name, positions: [] }));
        let pos = r.positions.find((x) => x.jobCodeId === p.jobCodeId);
        if (!pos) r.positions.push((pos = { jobCodeId: p.jobCodeId }));
        const label = text(p.label, 60);
        if (label) pos.label = label;
      }
    }, actor);
  }

  /** Put `intoId` where `fromId` was in every room (merging job codes); a room that has both keeps the first. */
  function replaceJob(fromId, intoId, { room = null } = {}) {
    return change((rooms) => {
      for (const r of rooms) {
        if (room != null && !sameArea(r.room, room)) continue;
        const i = r.positions.findIndex((p) => p.jobCodeId === fromId);
        if (i < 0) continue;
        if (r.positions.some((p) => p.jobCodeId === intoId)) r.positions.splice(i, 1);
        else r.positions[i] = { jobCodeId: intoId };
      }
    });
  }

  /** A position that no longer exists comes off every room. */
  const dropJob = (id) => change((rooms) => { for (const r of rooms) r.positions = r.positions.filter((p) => p.jobCodeId !== id); });

  /** The order of a room's positions: these first, in this order, then the rest as they were. */
  const reorder = (room, jobCodeIds) => change((rooms) => {
    const r = rooms.find((x) => sameArea(x.room, room));
    if (!r) return;
    const first = jobCodeIds.map((id) => r.positions.find((p) => p.jobCodeId === id)).filter(Boolean);
    r.positions = [...new Set([...first, ...r.positions])];
  });

  /** A section's name on the sheet ('' = the position's name). */
  const setLabel = (room, jobCodeId, label) => change((rooms) => {
    const p = rooms.find((x) => sameArea(x.room, room))?.positions.find((x) => x.jobCodeId === jobCodeId);
    if (!p) return;
    const t = text(label, 60);
    if (t) p.label = t; else delete p.label;
  });

  /**
   * Move a section (a position in a room) to another one. people: everyone who holds it there moves
   * too (keeping their pay rate) and the sheet's names follow; otherwise only the people with moved
   * shifts get the new position. Shifts from `start` (through `end`, if given) move.
   */
  function moveSection({ room, job, toRoom, toJob, start = '', end = '', people = false, toArea = toRoom }) {
    let movedPeople = 0, movedShifts = 0;
    if (people) {
      for (const u of store.list('users', (x) => holdsIn(x, job, room))) {
        const rate = (u.jobCodes || []).find((e) => e.jobCodeId === job.id)?.rate ?? null;
        const had = (u.jobCodes || []).some((e) => e.jobCodeId === toJob.id);
        let list = dropRoom(u.jobCodes, job, room);
        list = addRoom(list, toJob, toRoom, had ? null : rate);
        store.update('users', u.id, { jobCodes: list });
        movedPeople++;
      }
      const old = store.list('rosters', (r) => r.jobCodeId === job.id && sameRoom(r.area || job.department, room));
      if (old.length) {
        const id = `${toRoom.toLowerCase()}|${toJob.id}`;
        const into = store.get('rosters', id);
        const userIds = [...new Set([...(into?.userIds || []), ...old.flatMap((r) => r.userIds || [])])];
        if (into) store.update('rosters', id, { userIds });
        else store.insert('rosters', { id, area: toRoom, jobCodeId: toJob.id, label: null, banner: '', userIds, updatedAt: stamp() });
        for (const r of old) if (r.id !== id) store.remove('rosters', r.id);
      }
    }
    const shifts = store.list('shifts', (s) => s.jobCodeId === job.id && sameRoom(roomOfShift(s, job), room) && s.date >= start && (!end || s.date <= end));
    const workers = new Set();
    for (const s of shifts) {
      store.update('shifts', s.id, { jobCodeId: toJob.id, area: toArea });
      if (s.userId) workers.add(s.userId);
      movedShifts++;
    }
    // They work there now, so they're listed there.
    for (const id of workers) {
      const u = store.get('users', id);
      if (u && !holdsIn(u, toJob, toRoom)) store.update('users', u.id, { jobCodes: addRoom(u.jobCodes, toJob, toRoom) });
    }
    return { people: movedPeople, shifts: movedShifts };
  }

  /** An existing position by id, or a new one by name (an existing one with the same name is reused). */
  function positionFor({ jobCodeId, newPosition }, room) {
    const name = text(newPosition?.name, 60);
    if (!name) return jobOf(jobCodeId);
    const same = store.list('jobCodes', (j) => !j.archived && j.name.trim().toLowerCase() === name.toLowerCase())[0];
    if (same) return same;
    const all = store.list('jobCodes');
    const words = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    const short = ((words.length > 1 ? words.map((w) => w[0]).join('') : name.replace(/[^A-Za-z0-9]/g, '')).slice(0, 4) || 'POS').toUpperCase();
    const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#e11d48', '#475569', '#ca8a04', '#0f766e', '#a855f7'];
    const order = Math.max(0, ...all.map((j) => Number(j.order) || 0)) + 1;
    return store.insert('jobCodes', { id: uid('job'), name, short, department: room || 'Restaurant', color: PALETTE[order % PALETTE.length], defaultRate: 0, order,
      eventRole: false, archived: false, defaultRole: 'employee' });
  }

  /** What managers get: every room with its color and positions, each with how many people work it there and its shifts from this week on. */
  function view() {
    const doc = current();
    const st = settings();
    const jobs = jobsById();
    const since = weekStart(today(), st.weekStartDow ?? 1);
    const team = store.list('users', (u) => u.active !== false && !offSchedule(u));
    const counts = new Map();
    for (const s of store.list('shifts', (x) => x.date >= since)) {
      const job = jobs[s.jobCodeId];
      if (!job) continue;
      const k = `${roomOfShift(s, job).toLowerCase().replace(/[^a-z0-9]/g, '')}|${job.id}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const rooms = doc.rooms.map((r, i) => ({
      room: r.room,
      color: bannerColor(st, r.room, i),
      positions: r.positions.map((p) => {
        const job = jobs[p.jobCodeId];
        return { jobCodeId: p.jobCodeId, label: p.label || '', hidden: !!p.hidden,
          people: job ? team.filter((u) => holdsIn(u, job, r.room)).length : 0,
          shifts: job ? counts.get(`${r.room.toLowerCase().replace(/[^a-z0-9]/g, '')}|${job.id}`) || 0 : 0 };
      }),
    }));
    return { rev: doc.rev || 0, saved: !doc.seeded, since, rooms };
  }

  const roomIn = (doc, name) => {
    const r = findRoom(doc, name);
    if (!r) fail(404, 'That room isn’t on the schedule');
    return r;
  };

  const api = {
    /** The rooms and their positions, with counts (managers). */
    'layout.get': (actor) => {
      needMgr(actor);
      return view();
    },

    /**
     * Save the whole layout: rooms in order (added, reordered or removed), each with its positions in
     * order, their names on the sheet, hidden or not, and the room's banner color. Renaming a room is
     * layout.renameRoom, so its shifts and people follow. rev, when sent, must be the one last read.
     */
    'layout.save': (actor, { rooms, rev } = {}) => {
      needMgr(actor);
      const cur = current();
      if (rev != null && Number(rev) !== (cur.rev || 0)) fail(409, 'Someone else just changed the rooms. Look again and retry.');
      const clean = cleanLayout(rooms, { jobExists: (id) => !!store.get('jobCodes', id), fail });
      if (Object.keys(clean.colors).length) {
        const colors = Object.fromEntries(Object.entries(settings().areaColors || {}).filter(([k]) => !Object.keys(clean.colors).some((n) => sameArea(n, k))));
        putSettings({ areaColors: { ...colors, ...clean.colors } });
      }
      // The first save keeps the layout even when nothing changed: it's the manager's now.
      if (cur.seeded || JSON.stringify(clean.rooms) !== JSON.stringify(cur.rooms)) write(clean.rooms, actor);
      return view();
    },

    /** Rename a room everywhere: the layout, settings, shifts, people, positions' departments, the sheet's names, tip pools and 86 lists. */
    'layout.renameRoom': (actor, { from, to } = {}) => {
      needMgr(actor);
      const cur = current();
      const r = roomIn(cur, from);
      const name = cleanArea(to);
      if (!name) fail(400, 'Every room needs a name');
      if (cur.rooms.some((x) => x !== r && sameArea(x.room, name))) fail(400, `There’s already a room called ${name}`);
      const old = r.room;
      if (old === name) return view();
      const swap = (a) => (sameArea(a, old) ? name : a);
      for (const s of store.list('shifts', (x) => sameArea(x.area, old))) store.update('shifts', s.id, { area: name });
      for (const u of store.list('users', (x) => (x.jobCodes || []).some((e) => (e.areas || []).some((a) => sameArea(a, old))))) {
        store.update('users', u.id, { jobCodes: u.jobCodes.map((e) => (e.areas?.length ? { ...e, areas: uniqueAreas(e.areas.map(swap)) } : e)) });
      }
      for (const j of store.list('jobCodes', (x) => sameArea(x.department, old))) store.update('jobCodes', j.id, { department: name });
      for (const x of store.list('rosters', (y) => y.area && sameArea(y.area, old))) {
        const id = `${name.toLowerCase()}|${x.jobCodeId}`;
        if (id === x.id) { store.update('rosters', x.id, { area: name }); continue; }
        const into = store.get('rosters', id);
        if (into) store.update('rosters', id, { userIds: [...new Set([...(into.userIds || []), ...(x.userIds || [])])] });
        else store.insert('rosters', { ...x, id, area: name });
        store.remove('rosters', x.id);
      }
      for (const p of store.list('tipPools', (x) => (x.areas || []).some((a) => sameArea(a, old)))) store.update('tipPools', p.id, { areas: uniqueAreas(p.areas.map(swap)) });
      for (const l of store.list('eightySixLists', (x) => sameArea(x.area, old))) store.update('eightySixLists', l.id, { area: name });
      for (const it of store.list('eightySixItems', (x) => sameArea(x.area, old))) store.update('eightySixItems', it.id, { area: name });
      const st = settings();
      const rekey = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [sameArea(k, old) ? name : k, v]));
      const order = Object.fromEntries(Object.entries(st.sectionOrder || {}).map(([k, v]) => [sameArea(k, old) ? name.toLowerCase() : k, v]));
      putSettings({ areaColors: rekey(st.areaColors), sectionOrder: order, departments: uniqueAreas((st.departments || []).map(swap)) });
      const rooms = clone(cur.rooms).map((x) => (sameArea(x.room, old) ? { ...x, room: name } : x));
      write(rooms, actor);
      return view();
    },

    /** Add a position to a room: an existing one, or a new one created here (newPosition: { name }). Shown, at the end. */
    'layout.addPosition': (actor, { room, jobCodeId, newPosition } = {}) => {
      needMgr(actor);
      const r = roomIn(current(), room);
      const job = positionFor({ jobCodeId, newPosition }, r.room);
      if (job.archived) fail(400, 'That position is archived');
      change((rooms) => {
        const x = rooms.find((y) => sameArea(y.room, r.room));
        const p = x.positions.find((y) => y.jobCodeId === job.id);
        if (p) delete p.hidden; else x.positions.push({ jobCodeId: job.id });
      }, actor);
      return { ...view(), jobCodeId: job.id };
    },

    /** Hide a section: it stays in the room's list but never shows on the schedule or when scheduling. */
    'layout.hide': (actor, { room, jobCodeId } = {}) => {
      needMgr(actor);
      const r = roomIn(current(), room);
      if (!r.positions.some((p) => p.jobCodeId === jobCodeId)) fail(404, 'That position isn’t in this room');
      change((rooms) => { rooms.find((x) => sameArea(x.room, r.room)).positions.find((p) => p.jobCodeId === jobCodeId).hidden = true; }, actor);
      return view();
    },

    /** Show a section again. One that isn't in the layout (shifts landed there) is added, shown, at the end of its room. */
    'layout.unhide': (actor, { room, jobCodeId } = {}) => {
      needMgr(actor);
      const job = jobOf(jobCodeId);
      const name = cleanArea(room);
      if (!name) fail(400, 'Pick a room');
      ensurePairs([{ room: name, jobCodeId: job.id }], actor);
      change((rooms) => { delete rooms.find((x) => sameArea(x.room, name)).positions.find((p) => p.jobCodeId === job.id).hidden; }, actor);
      return view();
    },

    /**
     * Take a position off a room. mode 'keep': its people keep it and its shifts stay, but the section
     * no longer shows (it's unlisted). mode 'move': everyone who works it there, and its shifts from
     * `from` on (default: this week), move to another position (to: { room, jobCodeId } or
     * { room, newPosition: { name } }), which shows on the schedule.
     */
    'layout.removePosition': (actor, { room, jobCodeId, mode = 'keep', to = {}, from } = {}) => {
      needMgr(actor);
      const cur = current();
      const r = roomIn(cur, room);
      const job = jobOf(jobCodeId);
      if (!r.positions.some((p) => p.jobCodeId === job.id)) fail(404, 'That position isn’t in this room');
      let moved = { people: 0, shifts: 0 };
      let target = null;
      if (mode === 'move') {
        const toRoom = findRoom(cur, to.room)?.room || cleanArea(to.room) || r.room;
        const toJob = positionFor(to, toRoom);
        if (toJob.archived) fail(400, 'That position is archived');
        if (toJob.id === job.id && sameArea(toRoom, r.room)) fail(400, 'Pick a different position to move them to');
        const start = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : weekStart(today(), settings().weekStartDow ?? 1);
        moved = moveSection({ room: r.room, job, toRoom, toJob, start, people: true });
        target = { room: toRoom, jobCodeId: toJob.id };
      } else if (mode !== 'keep') fail(400, 'Pick what happens to its people and shifts');
      change((rooms) => {
        const x = rooms.find((y) => sameArea(y.room, r.room));
        x.positions = x.positions.filter((p) => p.jobCodeId !== job.id);
        if (target) {
          let t = rooms.find((y) => sameArea(y.room, target.room));
          if (!t) rooms.push((t = { room: target.room, positions: [] }));
          const p = t.positions.find((y) => y.jobCodeId === target.jobCodeId);
          if (p) delete p.hidden; else t.positions.push({ jobCodeId: target.jobCodeId });
        }
      }, actor);
      return { ...view(), moved };
    },

    /**
     * Move the shifts of one hidden or unlisted section, between two dates, to a section that shows
     * (the schedule's "shifts in hidden or unlisted sections" notice). The people on them get that position.
     */
    'layout.moveShifts': (actor, { room = '', jobCodeId, start, end, to = {} } = {}) => {
      needMgr(actor);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) fail(400, 'Pick a week');
      const job = jobOf(jobCodeId);
      const cur = current();
      const toJob = jobOf(to.jobCodeId);
      const p = findPosition(cur, to.room, toJob.id);
      if (!p || p.hidden || toJob.archived) fail(400, 'Pick a position that shows on the schedule');
      const toRoom = findRoom(cur, to.room).room;
      if (toJob.id === job.id && sameArea(toRoom, room)) fail(400, 'Pick a different position to move them to');
      const moved = moveSection({ room, job, toRoom, toJob, start, end, toArea: areaForRoom(toRoom, toJob, settings()) });
      return { moved: moved.shifts };
    },
  };

  return {
    api, current, view, write, change, ensurePairs, replaceJob, dropJob, reorder, setLabel,
    /** The layout for this viewer: everything for managers, without hidden positions for everyone else. */
    forViewer: (isManager) => {
      const doc = current();
      return isManager ? { rev: doc.rev || 0, rooms: doc.rooms } : visibleLayout(doc);
    },
    /** Where a position is usually worked (see homeRoom). */
    homeRoom: (job) => homeRoom(current(), job),
  };
}
