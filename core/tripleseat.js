// Tripleseat → Events & BEOs. Pure functions that read Tripleseat's events and the logic that writes
// them into ShiftBoard's `events`, plus the tripleseat.* RPC methods (Settings → Integrations →
// Tripleseat). The HTTP client is server/tripleseat.js; server/tripleseat-sync.js fetches pages and
// runs applyBatch() inside a database write. Plugged into core/service.js like venue-links.js.
//
// Collections written here:
//   events             a synced event is `evt_ts_<Tripleseat id>` with source: 'tripleseat', externalId,
//                      and a `tripleseat` block (status, rooms, owner, link, what it owns, review flags)
//   tripleseatRooms    Tripleseat's rooms and which venue room (roomId) each one is
//   tripleseatSkipped  events a manager deleted here: the sync doesn't bring them back
//   integrations       'tripleseat': rules, last sync, webhook link token, the run in progress
//
// Who owns what. Tripleseat owns the booking: name, date, start, end, guests, status, room, and the
// event type, menu, drinks and notes when Tripleseat has them. ShiftBoard owns staffing lines, who
// works it, the captain, comments, floor-plan sections and every other BEO field. A manager can edit a
// Tripleseat field here, but the next sync puts Tripleseat's value back (the BEO screen says so).
// Contacts, accounts and money are never read: client details stay in Tripleseat.
import { localStamp } from './toast.js';
import { eventRoom } from './venue-links.js';
import { addDays, todayStr, fmtTime } from './time.js';
import { canManageEvents, canChangeSettings } from './roles.js';

export const SOURCE = 'tripleseat';
export const INTEGRATION_ID = 'tripleseat';
export const WINDOW_BACK = 7; // days: the sync looks at events from a week ago…
export const WINDOW_AHEAD = 120; // …through four months out
/** ShiftBoard's id for a Tripleseat event: the same event always lands on the same document. */
export const eventDocId = (tsId) => `evt_ts_${String(tsId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
const roomDocId = (tsRoomId) => `tsr_${String(tsRoomId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;

/**
 * What happens to each Tripleseat status. Definite is always imported as confirmed.
 *   tentative: 'import' (as tentative: only the events team and managers see it) | 'skip'
 *   prospect:  'skip' | 'tentative'
 *   closed:    'completed' (an event that happened stays, marked completed) | 'skip'
 *   lost:      'cancel' (kept, marked cancelled) | 'remove' (deleted when nobody is staffed on it)
 * 'skip' means not imported, and taken off again if it was (never when people are staffed on it).
 */
export const DEFAULT_RULES = { tentative: 'import', prospect: 'skip', closed: 'completed', lost: 'cancel' };
export const RULE_OPTIONS = { tentative: ['import', 'skip'], prospect: ['skip', 'tentative'], closed: ['completed', 'skip'], lost: ['cancel', 'remove'] };
export const cleanRules = (r = {}) => Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, d]) => [k, RULE_OPTIONS[k].includes(r?.[k]) ? r[k] : d]));

/** A Tripleseat status → 'confirmed' | 'tentative' | 'completed' | 'skip' | 'cancel'. */
export function mapStatus(status, rules = DEFAULT_RULES) {
  const r = cleanRules(rules);
  switch (String(status || '').trim().toLowerCase()) {
    case 'definite': return 'confirmed';
    case 'tentative': return r.tentative === 'import' ? 'tentative' : 'skip';
    case 'prospect': return r.prospect === 'tentative' ? 'tentative' : 'skip';
    case 'closed': return r.closed === 'completed' ? 'completed' : 'skip';
    case 'lost': return 'cancel';
    default: return 'skip'; // a status Tripleseat adds later: leave it alone until we know what it means
  }
}

// ---------------------------------------------------------------- reading Tripleseat's answers

const text = (v, max = 200) => (v == null || typeof v === 'object' ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const nameOf = (v) => {
  if (!v) return '';
  if (typeof v !== 'object') return text(v, 80);
  return text(v.name, 80) || [text(v.first_name, 40), text(v.last_name, 40)].filter(Boolean).join(' ');
};

/** 'HH:MM' from '6:30 PM', '6:30pm', '18:30', '18:30:00'; '' when it can't be read. */
export function parseTime(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([AaPp])?\.?\s*[Mm]?\.?$/);
  if (!m || (m[2] == null && !m[3])) return '';
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) { if (h < 1 || h > 12) return ''; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  if (h > 23 || min > 59) return '';
  return `${pad(h)}:${pad(min)}`;
}

/**
 * A Tripleseat date or date-time as the venue's wall clock: { date: 'YYYY-MM-DD', time: 'HH:MM'|'' } or null.
 * Takes '10/08/2026 06:30 PM' (Tripleseat's format), '2026-10-08T18:30:00' (local), and ISO times with
 * an offset or Z, which are moved into `timeZone`.
 */
export function parseWhen(v, timeZone) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const local = localStamp(s.replace(' ', 'T'), timeZone);
    return local ? { date: local.slice(0, 10), time: local.slice(11, 16) } : null;
  }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/);
  if (m) return validDate(`${m[1]}-${m[2]}-${m[3]}`) ? { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? parseTime(m[4]) : '' } : null;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.+))?$/);
  if (m) {
    const date = `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
    return validDate(date) ? { date, time: m[4] ? parseTime(m[4]) : '' } : null;
  }
  return null;
}
function validDate(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** The rooms (areas) on a Tripleseat event: [{ id, name }]. */
export function eventRooms(r) {
  const out = [];
  const add = (x) => {
    if (x == null) return;
    const id = typeof x === 'object' ? (x.id ?? x.room_id ?? null) : null;
    const name = typeof x === 'object' ? nameOf(x) : text(x, 80);
    if (!name && id == null) return;
    if (out.some((o) => (id != null && o.id === String(id)) || (!id && name && norm(o.name) === norm(name)))) return;
    out.push({ id: id == null ? null : String(id), name });
  };
  for (const k of ['rooms', 'areas', 'event_rooms']) if (Array.isArray(r?.[k])) r[k].forEach((x) => add(x?.room && typeof x.room === 'object' ? x.room : x));
  if (r?.room) add(r.room);
  if (!out.length && Array.isArray(r?.room_ids)) r.room_ids.forEach((id, i) => add({ id, name: Array.isArray(r.room_names) ? r.room_names[i] : '' }));
  return out;
}

/** An https link to the event in Tripleseat, when the API gives one (never anything else). */
function eventUrl(r) {
  for (const k of ['url', 'event_url', 'html_url', 'web_url', 'link', 'permalink']) {
    const v = typeof r?.[k] === 'string' ? r[k].trim() : '';
    try { if (v && new URL(v).protocol === 'https:') return v.slice(0, 500); } catch { /* not a URL */ }
  }
  return null;
}

/**
 * One Tripleseat event, read into plain fields. Never reads contacts, accounts or money.
 * Returns null without an id.
 */
export function readEvent(raw, { timeZone } = {}) {
  const r = raw?.event && typeof raw.event === 'object' ? raw.event : raw;
  if (!r || typeof r !== 'object' || r.id == null || r.id === '') return null;
  const day = parseWhen(r.event_date ?? r.date, timeZone);
  const timeOf = (v) => (/^\d/.test(String(v ?? '')) && !/[/-]/.test(String(v)) ? { date: day?.date || '', time: parseTime(v) } : parseWhen(v, timeZone));
  const start = parseWhen(r.event_start ?? r.start_at ?? r.start, timeZone) || timeOf(r.start_time);
  const end = parseWhen(r.event_end ?? r.end_at ?? r.end, timeZone) || timeOf(r.end_time);
  const location = r.location && typeof r.location === 'object' ? r.location : {};
  const owner = nameOf(r.owner || r.owned_by || r.event_owner || r.sales_manager || r.user) || text(r.owner_name, 80);
  const type = r.event_type && typeof r.event_type === 'object' ? nameOf(r.event_type) : text(r.event_type ?? r.event_type_name ?? r.type, 60);
  return {
    id: String(r.id),
    name: text(r.name ?? r.title, 120),
    status: text(r.status ?? r.event_status, 30).toLowerCase(),
    date: start?.date || day?.date || '',
    start: start?.time || '',
    end: end?.time || '',
    guestCount: Math.max(0, Math.round(num(r.guest_count ?? r.guests ?? r.attendee_count) ?? 0)),
    guaranteed: num(r.guaranteed_guest_count ?? r.guaranteed_count ?? r.guaranteed),
    type,
    rooms: eventRooms(r),
    locationId: r.location_id != null ? String(r.location_id) : location.id != null ? String(location.id) : '',
    locationName: nameOf(location) || text(r.location_name, 80),
    bookingId: r.booking_id != null ? String(r.booking_id) : r.booking?.id != null ? String(r.booking.id) : '',
    owner,
    url: eventUrl(r),
    notes: text(r.event_notes ?? r.notes ?? r.description, 2000),
    updatedAt: text(r.updated_at, 40),
  };
}

const DRINKS = /\b(bev|beverage|bar|drinks?|cocktails?|wines?|beers?|liquor|spirits|champagne|bubbles|bebidas?)\b/i;

/** Menu items by id from GET /v1/menus (any nesting of menus → categories → items): { id: { name, category } }. */
export function menuItemIndex(menus) {
  const out = {};
  const walk = (node, category, depth) => {
    if (!node || typeof node !== 'object' || depth > 5) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, category, depth + 1)); return; }
    const items = node.menu_items || node.items;
    const cats = node.categories || node.menu_categories || node.sections;
    if (node.id != null && !items && !cats && (node.name || node.title)) {
      out[String(node.id)] = { name: text(node.name ?? node.title, 120), category: text(node.category?.name ?? node.category_name ?? node.category, 60) || category };
      return;
    }
    const here = items || cats ? text(node.name ?? node.title, 60) : '';
    if (cats) walk(cats, here || category, depth + 1);
    if (items) walk(items, here || category, depth + 1);
  };
  walk(menus, '', 0);
  return out;
}

/**
 * GET /v1/events/{id}/menu_item_selections → { food: [{ course, item, notes }], drinks: [{ item }] }.
 * Names come from the selection, else from the menu index. Lines without a name are left out.
 * Beverage categories (Bar, Wine, Cocktails…) go to the drinks.
 */
export function menuLines(selections, index = {}) {
  const rows = (Array.isArray(selections) ? selections : []).filter((s) => s && typeof s === 'object');
  const byId = new Map(rows.map((s) => [String(s.id), s]));
  const info = (s) => index[String(s.menu_item_id ?? s.menu_item?.id ?? '')] || {};
  const nameFor = (s) => text(s.name ?? s.menu_item_name ?? s.menu_item?.name ?? info(s).name, 120);
  const food = [], drinks = [];
  for (const s of rows) {
    const name = nameFor(s);
    if (!name) continue;
    const parent = s.parent_id != null ? byId.get(String(s.parent_id)) : null;
    const category = text(s.category ?? s.category_name ?? s.menu_item?.category?.name ?? s.menu_item?.category_name, 60) || info(s).category || (parent ? nameFor(parent) : '');
    const qty = num(s.quantity);
    const item = qty && qty > 1 ? `${name} × ${qty}` : name;
    if (DRINKS.test(category)) drinks.push({ item });
    else food.push({ course: category, item, notes: text(s.notes ?? s.special_instructions, 200) });
  }
  return { food: food.slice(0, 80), drinks: drinks.slice(0, 40) };
}

// ---------------------------------------------------------------- integration record

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID)
    ? store.update('integrations', INTEGRATION_ID, patch)
    : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}
export const rulesOf = (store) => cleanRules(integration(store).rules);

/** Fields Tripleseat always sets, and ones it owns only when it has a value (otherwise the manager's). */
const ALWAYS = ['name', 'date', 'start', 'end', 'guestCount', 'status', 'room'];
const STAFF_SEES = ['date', 'start', 'end', 'guestCount', 'room'];

/**
 * The Tripleseat logic, bound to one store. Plugged into core/service.js with its helpers:
 *   tripleseatLinks({ store, api, fail, needAuth, needMgr, needEvents, needAdmin, notify, say, day, now, cancelRequestsForShift })
 * Adds the tripleseat.* methods to `api`, wraps events.list / events.get / events.delete, and returns
 * { applyBatch, applyDeleted, syncRooms } for the server's sync.
 */
export function tripleseatLinks({ store, api, fail, needAuth, needMgr, needEvents, needAdmin, notify, say, day, now, cancelRequestsForShift }) {
  const at = () => now().toISOString();
  const venueRooms = () => store.list('rooms');
  const active = (u) => u.active !== false;
  const eventsTeam = () => store.list('users').filter((u) => active(u) && canManageEvents(u)).map((u) => u.id); // managers and the events team
  const shiftsOf = (id) => store.list('shifts', (s) => s.eventId === id);
  const staffedOn = (id) => [...new Set(shiftsOf(id).filter((s) => s.userId && s.published).map((s) => s.userId))];

  // ----- rooms -----
  /** Find or add the mapping record for a Tripleseat room; name matches pick a venue room. */
  function roomRecord(r, { locationId = '', locationName = '', touch = false } = {}) {
    const byName = store.list('tripleseatRooms', (x) => !x.tsId && norm(x.name) === norm(r.name))[0];
    const id = r.id ? roomDocId(r.id) : byName?.id || roomDocId(`n_${norm(r.name).replace(/ /g, '_')}`);
    const cur = store.get('tripleseatRooms', id);
    const match = venueRooms().find((v) => norm(v.name) === norm(r.name));
    if (!cur) {
      return store.insert('tripleseatRooms', { id, tsId: r.id || null, name: r.name || '', locationId, locationName, roomId: match?.id || null, matchedBy: match ? 'name' : null, seenAt: at() });
    }
    const patch = {};
    if (r.name && r.name !== cur.name) patch.name = r.name;
    if (locationId && locationId !== cur.locationId) Object.assign(patch, { locationId, locationName });
    // A name match fills an empty or stale automatic match; a match made by hand stays.
    const gone = cur.roomId && !store.get('rooms', cur.roomId);
    if (cur.matchedBy !== 'manual' && (!cur.roomId || gone) && match) Object.assign(patch, { roomId: match.id, matchedBy: 'name' });
    else if (gone && cur.matchedBy !== 'manual') Object.assign(patch, { roomId: null, matchedBy: null });
    if (touch) patch.seenAt = at();
    return Object.keys(patch).length ? store.update('tripleseatRooms', id, patch) : cur;
  }

  /** The event's room: one venue room (roomId) when every Tripleseat room is it, else the names as text. */
  function resolveRoom(rooms, ev = {}) {
    if (!rooms.length) return { roomId: null, room: '' };
    const recs = rooms.map((r) => roomRecord(r, ev));
    const picked = recs.map((rec) => (rec.roomId ? store.get('rooms', rec.roomId) : null));
    const ids = [...new Set(picked.filter(Boolean).map((v) => v.id))];
    if (ids.length === 1 && picked.every(Boolean)) return { roomId: ids[0], room: picked[0].name };
    const names = [...new Set(recs.map((rec, i) => picked[i]?.name || rec.name).filter(Boolean))];
    return { roomId: null, room: names.join(' & ').slice(0, 120) };
  }

  /** Tripleseat's locations and their rooms (from GET /locations, or /rooms): mapping records, auto-matched by name. */
  function syncRooms({ locations = [], rooms = [] } = {}) {
    const seen = [];
    const list = [];
    for (const l of Array.isArray(locations) ? locations : []) {
      const loc = { locationId: l?.id != null ? String(l.id) : '', locationName: nameOf(l) };
      for (const r of eventRooms(l)) list.push([r, loc]);
    }
    for (const r of Array.isArray(rooms) ? rooms : []) {
      const lid = r?.location_id != null ? String(r.location_id) : '';
      list.push([{ id: r?.id != null ? String(r.id) : null, name: nameOf(r) }, { locationId: lid, locationName: (locations || []).find((l) => String(l?.id) === lid)?.name || '' }]);
    }
    for (const [r, loc] of list) if (r.name || r.id) seen.push(roomRecord(r, { ...loc, touch: true }).id);
    const all = store.list('tripleseatRooms');
    return { rooms: all.length, matched: all.filter((r) => r.roomId).length, seen: seen.length };
  }

  // ----- events -----
  /** Take an event off: 'remove' deletes it (only when nobody is staffed), else it's marked cancelled. */
  function retire(cur, mode, reason, meta = {}) {
    const shifts = shiftsOf(cur.id);
    const staffed = shifts.filter((s) => s.userId);
    const open = shifts.filter((s) => !s.userId);
    for (const s of open) { cancelRequestsForShift(s.id, 'reasonEventRemoved'); store.remove('shifts', s.id); }
    if (mode === 'remove' && !staffed.length) {
      store.remove('events', cur.id);
      return { action: 'removed', id: cur.id, openShifts: open.length };
    }
    const review = staffed.length ? [...(cur.tripleseat?.review || []).filter((r) => r.code !== reason), { code: reason, staffed: staffed.length, at: at() }] : (cur.tripleseat?.review || []);
    if (cur.status === 'cancelled' && !open.length && JSON.stringify(review) === JSON.stringify(cur.tripleseat?.review || []) && cur.tripleseat?.status === meta.status) {
      return { action: 'same', id: cur.id };
    }
    store.update('events', cur.id, { status: 'cancelled', tripleseat: { ...cur.tripleseat, ...meta, review, syncedAt: at() } });
    if (staffed.length && !(cur.tripleseat?.review || []).some((r) => r.code === reason)) {
      notify(eventsTeam(), say('tsCancelledStaffed', cur.name, day(cur.date), staffed.length), `#/events/${cur.id}`);
    }
    return { action: staffed.length ? 'flagged' : 'cancelled', id: cur.id, openShifts: open.length, staffed: staffed.length };
  }

  /** A Tripleseat event Tripleseat no longer has (404, or a delete webhook): like Lost. */
  function applyDeleted(tsId, { rules } = {}) {
    const cur = store.get('events', eventDocId(tsId));
    if (!cur || cur.source !== SOURCE) return { action: 'skipped', id: eventDocId(tsId) };
    return retire(cur, cleanRules(rules).lost === 'remove' ? 'remove' : 'cancel', 'deleted', { status: 'deleted' });
  }

  /**
   * One Tripleseat event into ShiftBoard. ctx: { rules, timeZone, locationId, menu: { food, drinks }|null,
   * initial (the first sync: no "new event" notifications) }. Returns { action, id, changes }.
   *   added | updated | same | cancelled | removed | flagged | skipped | ignored (a manager deleted it here)
   */
  function applyEvent(raw, ctx = {}) {
    const ev = readEvent(raw, ctx);
    if (!ev) return { action: 'invalid' };
    const id = eventDocId(ev.id);
    const rules = cleanRules(ctx.rules);
    if (store.get('tripleseatSkipped', id)) return { action: 'ignored', id };
    const cur = store.get('events', id);
    if (cur && cur.source !== SOURCE) return { action: 'ignored', id }; // never touch an event that isn't Tripleseat's
    const elsewhere = ctx.locationId && ev.locationId && ev.locationId !== String(ctx.locationId);
    const outcome = !ev.date || elsewhere ? 'skip' : mapStatus(ev.status, rules);
    const meta = {
      id: ev.id, status: ev.status, bookingId: ev.bookingId, locationId: ev.locationId, locationName: ev.locationName,
      rooms: ev.rooms, owner: ev.owner, url: ev.url, updatedAt: ev.updatedAt,
      ...(ctx.menu && ctx.menuFor ? { menuFor: ctx.menuFor } : {}), // the version whose menu was read
    };
    if (outcome === 'skip' || outcome === 'cancel') {
      if (!cur) return { action: 'skipped', id };
      const mode = outcome === 'skip' || rules.lost === 'remove' ? 'remove' : 'cancel';
      return retire(cur, mode, outcome === 'cancel' ? 'lost' : 'status', { ...meta, status: ev.status });
    }

    const { roomId, room } = resolveRoom(ev.rooms, ev);
    const next = { name: ev.name || cur?.name || `Tripleseat ${ev.id}`, date: ev.date, start: ev.start, end: ev.end, guestCount: ev.guestCount, status: outcome, room, roomId };
    const owns = [...ALWAYS];
    if (ev.guaranteed != null && ev.guaranteed > 0) { next.guaranteed = ev.guaranteed; owns.push('guaranteed'); }
    if (ev.type) { next.type = ev.type; owns.push('type'); }
    if (ev.notes) { next.tsNotes = ev.notes; owns.push('tsNotes'); }
    const menu = ctx.menu || null;
    if (menu?.food?.length) { next.menu = menu.food; owns.push('menu'); }
    const drinks = menu?.drinks?.length ? menu.drinks.map((d) => d.item).join(' · ').slice(0, 500) : null;
    if (drinks) owns.push('beverage');
    // A field Tripleseat stopped giving goes back to being the manager's, with the value it had. When the
    // menu wasn't read this time (unchanged event, or menus unavailable), the menu keeps its owner.
    const ownsNow = [...new Set([...owns, ...(menu ? [] : (cur?.tripleseat?.owns || []).filter((f) => f === 'menu' || f === 'beverage'))])];

    if (!cur) {
      const doc = {
        id, source: SOURCE, externalId: ev.id, ...next,
        guaranteed: next.guaranteed ?? '', type: next.type || '', serviceStyle: 'plated', client: '', captainId: null,
        menu: next.menu || [], beverage: { package: drinks || '', bar: '', notes: '' }, specialDrinks: [], staffing: [], timeline: [],
        setupNotes: '', dietaryNotes: '', avNotes: '', attire: '', notes: '', tsNotes: next.tsNotes || '',
        createdAt: at(), createdBy: SOURCE, tripleseat: { ...meta, owns: ownsNow, review: [], syncedAt: at() },
      };
      store.insert('events', doc);
      if (!ctx.initial) notify(eventsTeam(), say('newEvent', doc.name, day(doc.date), doc.guestCount), `#/events/${id}`);
      return { action: 'added', id };
    }

    const patch = {};
    const changes = [];
    for (const [k, v] of Object.entries(next)) {
      const was = cur[k] ?? (k === 'roomId' ? null : '');
      if (JSON.stringify(was) !== JSON.stringify(v)) { patch[k] = v; changes.push(k); }
    }
    if (drinks != null && (cur.beverage?.package || '') !== drinks) { patch.beverage = { ...(cur.beverage || {}), package: drinks }; changes.push('beverage'); }

    // The event moved to another day: open shifts go with it; shifts people already have are flagged.
    let review = cur.tripleseat?.review || [];
    if (patch.date) {
      const old = shiftsOf(id).filter((s) => s.date === cur.date);
      for (const s of old.filter((x) => !x.userId)) store.update('shifts', s.id, { date: patch.date });
      const staffed = old.filter((x) => x.userId);
      if (staffed.length) {
        review = [...review.filter((r) => r.code !== 'moved'), { code: 'moved', from: cur.date, to: patch.date, staffed: staffed.length, at: at() }];
        notify(eventsTeam(), say('tsMovedStaffed', next.name, day(patch.date), staffed.length), `#/events/${id}`);
      }
    }
    // Back from cancelled: the cancellation flag no longer applies.
    if (cur.status === 'cancelled' && next.status !== 'cancelled') review = review.filter((r) => !['lost', 'deleted', 'status'].includes(r.code));

    const metaChanged = JSON.stringify({ ...cur.tripleseat, syncedAt: 0 }) !== JSON.stringify({ ...cur.tripleseat, ...meta, owns: ownsNow, review, syncedAt: 0 });
    if (!changes.length && !metaChanged) return { action: 'same', id };
    store.update('events', id, { ...patch, tripleseat: { ...cur.tripleseat, ...meta, owns: ownsNow, review, syncedAt: at() } });

    // People staffed on it hear about what matters to them, in their own language.
    const seen = STAFF_SEES.filter((f) => changes.includes(f) || (f === 'room' && changes.includes('roomId')));
    if (seen.length && cur.status !== 'tentative') {
      const after = { ...cur, ...patch };
      const what = (lang) => {
        const parts = [];
        const m = (key, ...a) => say(key, ...a)(lang);
        if (seen.includes('date')) parts.push(m('tsWhatDate', day(after.date)(lang)));
        if (seen.includes('start') || seen.includes('end')) parts.push(m('tsWhatTime', `${fmtTime(after.start, lang)}${after.end ? `–${fmtTime(after.end, lang)}` : ''}`));
        if (seen.includes('guestCount')) parts.push(m('tsWhatGuests', after.guestCount));
        if (seen.includes('room')) parts.push(m('tsWhatRoom', after.room || '—'));
        return parts.join('; ');
      };
      notify([...staffedOn(id), cur.captainId], say('tsBeoChanged', after.name, day(after.date), what), `#/events/${id}`);
    }
    return { action: changes.length ? 'updated' : 'same', id, changes };
  }

  /** Several events in one write. items: [{ raw, menu }]. Returns { results, counts }. */
  function applyBatch(items, ctx = {}) {
    const counts = {};
    const results = (items || []).map(({ raw, menu, menuFor, deleted }) => {
      const r = deleted ? applyDeleted(deleted, ctx) : applyEvent(raw, { ...ctx, menu, menuFor });
      counts[r.action] = (counts[r.action] || 0) + 1;
      return r;
    });
    return { results, counts };
  }

  // ----- what the app shows -----
  const tsView = (e, actor) => {
    if (e?.source !== SOURCE) return null;
    const t = e.tripleseat || {};
    const team = canManageEvents(actor);
    return {
      owner: t.owner || '', status: t.status || '', syncedAt: t.syncedAt || null, owns: t.owns || ALWAYS,
      ...(team ? { url: t.url || null, review: t.review || [] } : {}),
    };
  };
  const wrap = (name, fn) => {
    const orig = api[name];
    api[name] = (actor, args) => fn(orig, actor, args || {});
  };
  wrap('events.list', (orig, actor, a) => orig(actor, a).map((e) => {
    const doc = store.get('events', e.id);
    if (doc?.source !== SOURCE) return e;
    return { ...e, source: SOURCE, review: canManageEvents(actor) ? (doc.tripleseat?.review || []).length : 0 };
  }));
  wrap('events.get', (orig, actor, a) => {
    const v = orig(actor, a);
    const t = tsView(v, actor);
    if (!t) return v;
    const { tripleseat, ...rest } = v;
    return { ...rest, tripleseat: t };
  });
  // Deleting a Tripleseat event here: the sync leaves it alone afterwards (Settings can bring it back).
  wrap('events.delete', (orig, actor, a) => {
    const cur = store.get('events', a.id);
    const out = orig(actor, a);
    if (cur?.source === SOURCE) {
      const doc = { id: cur.id, tsId: cur.externalId, name: cur.name, date: cur.date, at: at(), by: actor.id };
      if (store.get('tripleseatSkipped', cur.id)) store.update('tripleseatSkipped', cur.id, doc); else store.insert('tripleseatSkipped', doc);
    }
    return out;
  });

  const newToken = () => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  Object.assign(api, {
    // Settings → Integrations → Tripleseat: what's been synced, rooms, rules. Managers.
    'tripleseat.get': (actor) => {
      needMgr(actor);
      const i = integration(store);
      const today = todayStr(now());
      const events = store.list('events', (e) => e.source === SOURCE);
      const count = new Map();
      for (const e of events) for (const r of e.tripleseat?.rooms || []) {
        const k = r.id ? roomDocId(r.id) : null;
        if (k) count.set(k, (count.get(k) || 0) + 1);
      }
      const rooms = store.list('tripleseatRooms').map((r) => ({
        id: r.id, name: r.name, locationName: r.locationName || '', roomId: r.roomId || null, matchedBy: r.matchedBy || null, events: count.get(r.id) || 0,
      })).sort((a, b) => a.locationName.localeCompare(b.locationName) || a.name.localeCompare(b.name));
      return {
        rules: cleanRules(i.rules), ruleOptions: RULE_OPTIONS,
        site: i.site || null, location: i.location || null, locations: i.locations || [],
        lastSync: i.lastSync || null, lastCron: i.lastCron || null, lastWebhook: i.lastWebhook || null,
        window: { back: WINDOW_BACK, ahead: WINDOW_AHEAD },
        rooms,
        totals: {
          events: events.length,
          upcoming: events.filter((e) => e.date >= today && e.status !== 'cancelled').length,
          needStaffing: events.filter((e) => e.date >= today && ['confirmed', 'tentative'].includes(e.status) && !(e.staffing || []).length).length,
        },
        review: events.filter((e) => (e.tripleseat?.review || []).length).map((e) => ({ id: e.id, name: e.name, date: e.date, codes: e.tripleseat.review.map((r) => r.code) })),
        skipped: store.list('tripleseatSkipped').sort((a, b) => String(a.date).localeCompare(String(b.date))).map(({ id, name, date }) => ({ id, name, date })),
        // The webhook link's secret part, for admins only (it's what lets Tripleseat nudge a sync).
        ...(canChangeSettings(actor) ? { webhookToken: i.webhookToken || null } : {}),
      };
    },
    /** Match Tripleseat rooms to venue rooms by hand. roomId null = keep Tripleseat's name as text. */
    'tripleseat.saveRooms': (actor, { rooms = [] } = {}) => {
      needMgr(actor);
      const changed = new Set();
      for (const m of Array.isArray(rooms) ? rooms : []) {
        const cur = store.get('tripleseatRooms', String(m?.id || ''));
        if (!cur) fail(404, 'That Tripleseat room is gone. Sync again.');
        const roomId = m.roomId || null;
        if (roomId && !store.get('rooms', roomId)) fail(404, 'Room not found');
        store.update('tripleseatRooms', cur.id, { roomId, matchedBy: 'manual' });
        changed.add(cur.id);
      }
      // Events in those rooms follow the new match now, not at the next sync.
      let events = 0;
      for (const e of store.list('events', (x) => x.source === SOURCE && (x.tripleseat?.rooms || []).some((r) => r.id && changed.has(roomDocId(r.id))))) {
        const { roomId, room } = resolveRoom(e.tripleseat.rooms);
        if (roomId !== (e.roomId || null) || room !== e.room) { store.update('events', e.id, { roomId, room }); events++; }
      }
      return { saved: changed.size, events };
    },
    /** What happens to each Tripleseat status (see DEFAULT_RULES). Admins. Applies from the next sync. */
    'tripleseat.saveRules': (actor, { rules } = {}) => {
      needAdmin(actor);
      if (!rules || typeof rules !== 'object') fail(400, 'Pick what happens to each status');
      for (const [k, v] of Object.entries(rules)) if (!RULE_OPTIONS[k]?.includes(v)) fail(400, 'Pick what happens to each status');
      const next = cleanRules({ ...rulesOf(store), ...rules });
      saveIntegration(store, { rules: next });
      return { rules: next };
    },
    /** The events team saw a flag ("cancelled in Tripleseat but people are on it"). */
    'tripleseat.clearReview': (actor, { id } = {}) => {
      needEvents(actor);
      const e = store.get('events', String(id || ''));
      if (!e || e.source !== SOURCE) fail(404, 'Event not found');
      store.update('events', e.id, { tripleseat: { ...e.tripleseat, review: [] } });
      return { ok: true };
    },
    /** Let the sync bring back events a manager deleted here (one, or all with no id). Admins. */
    'tripleseat.restoreSkipped': (actor, { id } = {}) => {
      needAdmin(actor);
      const list = id ? [store.get('tripleseatSkipped', String(id))].filter(Boolean) : store.list('tripleseatSkipped');
      for (const s of list) store.remove('tripleseatSkipped', s.id);
      return { restored: list.length };
    },
    /** The webhook link's token (made the first time). renew: a new one; the old link stops working. Admins. */
    'tripleseat.webhookLink': (actor, { renew = false } = {}) => {
      needAdmin(actor);
      const i = integration(store);
      if (i.webhookToken && !renew) return { token: i.webhookToken };
      const token = newToken();
      saveIntegration(store, { webhookToken: token });
      return { token };
    },
  });

  return { applyEvent, applyBatch, applyDeleted, syncRooms, readEvent };
}

/** The sync's date window around today: a week back through four months ahead. */
export function syncWindow(today = todayStr()) {
  return { from: addDays(today, -WINDOW_BACK), to: addDays(today, WINDOW_AHEAD) };
}
