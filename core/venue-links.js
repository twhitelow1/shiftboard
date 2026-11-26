// Links between the venue and the schedule. Plugged into core/service.js (see venueLinks below).
//
// 1. Event rooms. An event picks its room from the venue's rooms: `roomId` is the link and `room`
//    keeps the name for display, old data and the schedule importer. Events saved before rooms
//    existed (name only) link to the room with the same name, ignoring case, whenever they're read
//    or saved. "Full Buyout" and other free text stay as a name with no room.
//
// 2. Server sections: which room each shift works, and which of that room's tables (a "section").
//    One document per room and date in the `sections` collection, id `<roomId>|<date>`:
//      { id, roomId, date, entries: [{ shiftId, tableIds: [...] }], updatedAt, updatedBy }
//    An entry belongs to a shift, not a person, so a traded shift takes its section with it. A shift
//    works in one room per day, and a table is in at most one section per room and date. An entry
//    with no tables means "working this room". Entries for deleted or moved shifts and tables no longer
//    on the plan are skipped when read and dropped on the next write, so other code never has to
//    clean up after them.
import { SEATED } from './floor-plan.js'; // what a section is made of

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62; // sections.list range
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const docId = (roomId, date) => `${roomId}|${date}`;
const byLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'en', { numeric: true }); // T2 before T10
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Tables (and booths, bars) on a room's plan, by item id. */
export function sectionTables(room) {
  return new Map((room?.plan?.items || []).filter((i) => SEATED.has(i.type)).map((i) => [i.id, i]));
}

/** The room an event is in: its linked room, else a room with the same name (ignoring case). */
export function eventRoom(event, rooms) {
  if (!event) return null;
  if (event.roomId) {
    const r = rooms.find((x) => x.id === event.roomId);
    if (r) return r;
  }
  const name = norm(event.room);
  return (name && rooms.find((r) => norm(r.name) === name)) || null;
}

/**
 * Adds the sections.* methods to `api` and wraps the events.* and venue.* methods that need to know
 * about room links. Called once from createService with its store and permission helpers.
 */
export function venueLinks({ store, api, fail, needAuth, needMgr, needEvents, visibleShift, now }) {
  const rooms = () => store.list('rooms');
  const wrap = (name, fn) => {
    const orig = api[name];
    api[name] = (actor, args) => fn(orig, actor, args || {});
  };
  const withRoom = (e, list) => {
    if (!e) return e;
    const r = eventRoom(e, list);
    return { ...e, roomId: r?.id || null, room: r ? r.name : e.room };
  };

  // ----- events: link by room id -----
  wrap('events.save', (orig, actor, a) => {
    needEvents(actor);
    const touchesRoom = 'roomId' in a || 'room' in a;
    let room = null;
    if (a.roomId) {
      room = store.get('rooms', String(a.roomId));
      if (!room) fail(400, 'That room is gone. Pick another one.');
    } else if (touchesRoom) {
      room = eventRoom({ room: a.room }, rooms());
    }
    const out = orig(actor, room ? { ...a, room: room.name } : a);
    if (!touchesRoom) return withRoom(out, rooms());
    store.update('events', out.id, { roomId: room?.id || null });
    return { ...out, roomId: room?.id || null };
  });
  wrap('events.get', (orig, actor, a) => withRoom(orig(actor, a), rooms()));
  wrap('events.list', (orig, actor, a) => {
    const list = rooms();
    return orig(actor, a).map((e) => {
      const r = eventRoom(store.get('events', e.id), list);
      return { ...e, roomId: r?.id || null, room: r ? r.name : e.room };
    });
  });

  // ----- venue: keep event links and sections in step with rooms -----
  wrap('venue.saveRoom', (orig, actor, a) => {
    const before = a.id ? store.get('rooms', a.id) : null;
    const out = orig(actor, a);
    if (before && out.name !== before.name) {
      // Events in this room follow the new name, including old ones linked only by the old name.
      const others = rooms().filter((r) => r.id !== out.id);
      for (const e of store.list('events', (x) => x.roomId === out.id || ((!x.roomId || !others.some((r) => r.id === x.roomId)) && norm(x.room) === norm(before.name)))) {
        store.update('events', e.id, { roomId: out.id, room: out.name });
      }
    }
    return out;
  });
  wrap('venue.deleteRoom', (orig, actor, a) => {
    const out = orig(actor, a);
    for (const e of store.list('events', (x) => x.roomId === a.id)) store.update('events', e.id, { roomId: null }); // keeps the name
    for (const d of store.list('sections', (x) => x.roomId === a.id)) store.remove('sections', d.id);
    return out;
  });

  // ----- sections -----
  const validDate = (d, what = 'a date') => { if (!DATE.test(d || '')) fail(400, `Pick ${what}`); return d; };

  /** A doc's entries with gone shifts, moved shifts and gone tables dropped. */
  function liveEntries(doc, room) {
    const tables = sectionTables(room);
    const seen = new Set();
    const out = [];
    for (const e of doc?.entries || []) {
      const s = store.get('shifts', e.shiftId);
      if (!s || s.date !== doc.date || seen.has(s.id)) continue;
      seen.add(s.id);
      const ids = [...new Set(e.tableIds || [])].filter((t) => tables.has(t));
      out.push({ shiftId: s.id, tableIds: ids.sort((a, b) => byLabel(tables.get(a), tables.get(b))) });
    }
    return out;
  }

  function write(actor, roomId, date, entries) {
    const id = docId(roomId, date);
    const cur = store.get('sections', id);
    if (!entries.length) { if (cur) store.remove('sections', id); return; }
    const doc = { id, roomId, date, entries, updatedAt: now().toISOString(), updatedBy: actor.id };
    if (cur) store.update('sections', id, doc); else store.insert('sections', doc);
  }

  /** What the actor may see: entries for shifts they can see (staff: published shifts only). */
  function view(actor, { start, end, roomId } = {}) {
    const byId = new Map(rooms().map((r) => [r.id, r]));
    return store.list('sections', (d) => d.date >= start && d.date <= end && (!roomId || d.roomId === roomId))
      .map((doc) => {
        const room = byId.get(doc.roomId);
        if (!room) return null;
        const tables = sectionTables(room);
        const entries = liveEntries(doc, room).map((e) => {
          const s = store.get('shifts', e.shiftId);
          if (!visibleShift(actor, s)) return null;
          return {
            shiftId: s.id, userId: s.userId || null, jobCodeId: s.jobCodeId, start: s.start, end: s.end || null,
            published: !!s.published, eventId: s.eventId || null, tableIds: e.tableIds,
            tables: e.tableIds.map((t) => tables.get(t).label || '?'),
            seats: e.tableIds.reduce((n, t) => n + (Number(tables.get(t).seats) || 0), 0),
          };
        }).filter(Boolean);
        return entries.length ? { id: doc.id, roomId: doc.roomId, roomName: room.name, date: doc.date, entries } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date) || (byId.get(a.roomId).order ?? 0) - (byId.get(b.roomId).order ?? 0));
  }

  Object.assign(api, {
    // Sections for a date range (one room, or all). Everyone signed in can read them; staff see
    // only published shifts, like the schedule.
    'sections.list': (actor, { start, end, roomId } = {}) => {
      needAuth(actor);
      validDate(start);
      const last = end ? validDate(end) : start;
      if (last < start || days(start, last) > MAX_DAYS) fail(400, `Pick at most ${MAX_DAYS} days`);
      return view(actor, { start, end: last, roomId });
    },
    // Put a shift in a room, with these tables. mode 'add' adds the tables to the ones it has.
    // Tables someone else had that day move over. No roomId takes the shift out of every room.
    'sections.assign': (actor, { shiftId, roomId, tableIds, mode = 'set' } = {}) => {
      needMgr(actor);
      const shift = store.get('shifts', shiftId);
      if (!shift) fail(404, 'Shift not found');
      const date = shift.date;
      const room = roomId ? store.get('rooms', roomId) : null;
      if (roomId && !room) fail(404, 'Room not found');
      const ids = [...new Set((Array.isArray(tableIds) ? tableIds : []).map(String))];
      if (ids.length && !room) fail(400, 'Pick a room for these tables');
      if (ids.length > 200) fail(400, 'Too many tables');
      const tables = sectionTables(room);
      for (const t of ids) if (!tables.has(t)) fail(400, `That table isn’t on the ${room.name} floor plan`);

      // A shift works in one room per day.
      for (const d of store.list('sections', (x) => x.date === date && x.roomId !== roomId && (x.entries || []).some((e) => e.shiftId === shift.id))) {
        const r = store.get('rooms', d.roomId);
        write(actor, d.roomId, date, r ? liveEntries(d, r).filter((e) => e.shiftId !== shift.id) : []);
      }
      if (room) {
        const entries = liveEntries(store.get('sections', docId(room.id, date)) || { date }, room);
        const mine = entries.find((e) => e.shiftId === shift.id);
        const next = mode === 'add' ? [...new Set([...(mine?.tableIds || []), ...ids])] : ids;
        const taken = new Set(next);
        const out = entries.map((e) => (e.shiftId === shift.id ? { shiftId: e.shiftId, tableIds: next } : { ...e, tableIds: e.tableIds.filter((t) => !taken.has(t)) }));
        if (!mine) out.push({ shiftId: shift.id, tableIds: next });
        write(actor, room.id, date, out);
      }
      return view(actor, { start: date, end: date });
    },
    // Take tables out of whoever has them (they stay in the room without those tables).
    'sections.clear': (actor, { roomId, date, tableIds } = {}) => {
      needMgr(actor);
      const room = store.get('rooms', roomId);
      if (!room) fail(404, 'Room not found');
      validDate(date);
      const drop = new Set((Array.isArray(tableIds) ? tableIds : []).map(String));
      const doc = store.get('sections', docId(room.id, date));
      if (doc) write(actor, room.id, date, liveEntries(doc, room).map((e) => ({ ...e, tableIds: e.tableIds.filter((t) => !drop.has(t)) })));
      return view(actor, { start: date, end: date });
    },
    // Same sections as another day (e.g. last Friday): each person working both days gets the
    // same room and tables. Days with sections already are left alone unless replace is set.
    'sections.copy': (actor, { fromDate, toDate, roomId, replace = false } = {}) => {
      needMgr(actor);
      validDate(fromDate, 'a day to copy from');
      validDate(toDate, 'a day to copy to');
      if (fromDate === toDate) fail(400, 'Pick a different day');
      const targets = store.list('shifts', (s) => s.date === toDate && s.userId);
      const out = { copied: 0, skipped: 0 };
      for (const doc of store.list('sections', (d) => d.date === fromDate && (!roomId || d.roomId === roomId))) {
        const room = store.get('rooms', doc.roomId);
        if (!room) continue;
        const existing = store.get('sections', docId(room.id, toDate));
        if (existing && liveEntries(existing, room).length && !replace) { out.skipped += doc.entries.length; continue; }
        const used = new Set();
        const entries = [];
        for (const e of liveEntries(doc, room)) {
          const from = store.get('shifts', e.shiftId);
          const pick = from?.userId && (targets.find((s) => !used.has(s.id) && s.userId === from.userId && s.jobCodeId === from.jobCodeId)
            || targets.find((s) => !used.has(s.id) && s.userId === from.userId));
          if (!pick) { out.skipped++; continue; }
          used.add(pick.id);
          entries.push({ shiftId: pick.id, tableIds: e.tableIds });
          out.copied++;
        }
        // Those shifts leave any other room they were in that day.
        for (const d of store.list('sections', (x) => x.date === toDate && x.roomId !== room.id)) {
          const r = store.get('rooms', d.roomId);
          if (r && d.entries.some((x) => used.has(x.shiftId))) write(actor, d.roomId, toDate, liveEntries(d, r).filter((x) => !used.has(x.shiftId)));
        }
        write(actor, room.id, toDate, entries);
      }
      return out;
    },
  });
  return api;
}
