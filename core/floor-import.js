// Importing a floor plan: from Toast (tables, service areas, revenue centers), from a picture or PDF read by the
// AI, or from a CSV. Pure functions: the routes (server/venue-import-routes.js) fetch from Toast or call the AI,
// and the service (core/service.js venue.importPreview / venue.importApply) previews and applies.
//
// Every source becomes the same "incoming" shape first:
//   { source: 'toast' | 'image' | 'csv', rooms: [IncomingRoom] }
//   IncomingRoom: { key, name, roomId?, toast?: { serviceAreaGuid, revenueCenterGuid, revenueCenterName }, width?, height?,
//                   zones?: [{ name, color? }], items: [IncomingItem] }
//   IncomingItem: { key, type (null: keep the table's shape; a new one is a 4-top), label, seats (null: keep), zone (a name),
//                   x, y, w, h, r (null when the source has no positions), toastGuid }
//
// Then planImport() matches it against the restaurant's rooms, in this order, and never makes a duplicate on its own:
//   1. the same Toast GUID anywhere in the venue → update that table (wherever the manager put it)
//   2. the same table number in the same room (labelKey: "T12" = "Table 12" = "12") → update it
//      - several tables with that number there, the number twice in the import, or a table already linked to another
//        Toast table → "ambiguous": the manager decides (skip, update one of them, or add a new one); skip by default
//   3. a wall, label or fixture with the same text, or on the same spot → unchanged
//   4. otherwise → a new item (placed where the source says, else on a grid, grouped by section)
// An update keeps the table's position, size and rotation unless positions: 'replace' and the source has some.
// Toast gives no shapes or seats, so those are kept too. Nothing is ever deleted: tables that are in ShiftBoard but
// not in Toast are listed as `missing`.
import {
  SEATED, TYPE_DEFAULTS, ZONE_COLORS, ITEM_TYPES, cleanPlan, emptyPlan, labelKey, sizeFor, typeForSeats, gridSpots,
  itemBounds, planWarnings, shapeFromWord, DEFAULT_W, DEFAULT_H, MAX_ITEMS,
} from './floor-plan.js';

const num = (v) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const randomId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
export const SOURCES = ['toast', 'image', 'csv'];
export const MAX_ROOMS = 40;

// ---------- sources → incoming ----------

/**
 * Toast's configuration (server/toast.js floorConfig) → incoming.
 * mode 'rooms': each service area is a room. mode 'zones': every table goes in one room (roomId, or a new room
 * named roomName), each service area a section of it. Entries without a GUID or name are skipped (Toast's API
 * has been seen to return some).
 */
export function incomingFromToast(data, { mode = 'rooms', roomId = null, roomName = '', otherName = 'Other tables' } = {}) {
  const rcs = new Map((data?.revenueCenters || []).filter((r) => r?.guid).map((r) => [r.guid, text(r.name, 60)]));
  const areas = (data?.serviceAreas || []).filter((a) => a?.guid && text(a.name, 60) && a.serviceAreaType !== 'OFF_PREMISES')
    .map((a) => ({ guid: a.guid, name: text(a.name, 60), rc: a.revenueCenter?.guid || null }));
  const byGuid = new Map(areas.map((a) => [a.guid, a]));
  const tables = (data?.tables || []).filter((t) => t?.guid && text(t.name, 40))
    .map((t) => ({ guid: String(t.guid), name: text(t.name, 40), area: byGuid.get(t.serviceArea?.guid) || null, rc: t.revenueCenter?.guid || null }));
  const item = (t, zone = '') => ({ key: `t:${t.guid}`, type: null, label: t.name, seats: null, zone, x: null, y: null, w: null, h: null, r: null, toastGuid: t.guid });
  const byNumber = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });
  if (mode === 'zones') {
    // Areas in Toast's order, tables without one last.
    const rank = (t) => (t.area ? areas.indexOf(t.area) : areas.length);
    const sorted = tables.sort((a, b) => rank(a) - rank(b) || byNumber(a, b));
    const zones = [...new Set(sorted.map((t) => t.area?.name || otherName))].map((name) => ({ name }));
    return {
      source: 'toast',
      rooms: [{ key: 'room', name: text(roomName, 60), roomId: roomId || null, zones, items: sorted.map((t) => item(t, t.area?.name || otherName)) }],
    };
  }
  const rooms = areas.map((a) => ({
    key: `sa:${a.guid}`, name: a.name, toast: { serviceAreaGuid: a.guid, revenueCenterGuid: a.rc, revenueCenterName: rcs.get(a.rc) || '' },
    items: tables.filter((t) => t.area === a).sort(byNumber).map((t) => item(t)),
  }));
  const loose = tables.filter((t) => !t.area).sort(byNumber);
  if (loose.length) rooms.push({ key: 'sa:none', name: otherName, items: loose.map((t) => item(t)) });
  return { source: 'toast', rooms: rooms.filter((r) => r.items.length) };
}

/** CSV rows (core/floor-plan.js readPlanCsv) → incoming. Rows without a room go to roomId / roomName. */
export function incomingFromCsv(rows, { roomId = null, roomName = '' } = {}) {
  const rooms = new Map();
  for (const r of rows || []) {
    const name = r.room || '';
    const key = name ? `n:${norm(name)}` : 'room';
    if (!rooms.has(key)) rooms.set(key, { key, name: name || text(roomName, 60), roomId: name ? null : roomId, zones: [], items: [] });
    const room = rooms.get(key);
    if (r.zone && !room.zones.some((z) => norm(z.name) === norm(r.zone))) room.zones.push({ name: r.zone });
    const placed = r.x != null && r.y != null;
    room.items.push({
      key: `l:${r.line}`, type: r.type || null, label: r.label, seats: r.seats, zone: r.zone || '',
      x: placed ? r.x : null, y: placed ? r.y : null, w: r.w, h: r.h, r: r.r, toastGuid: r.toastGuid || '',
    });
  }
  return { source: 'csv', rooms: [...rooms.values()] };
}

// ---------- the AI's reading of a picture ----------
const AI_KINDS = {
  table: null, booth: 'booth', 'high-top': 'table-hightop', hightop: 'table-hightop', bar: 'bar', wall: 'wall', divider: 'divider',
  door: 'door', entrance: 'door', label: 'label', text: 'label', host: 'host', 'host-stand': 'host', kitchen: 'kitchen', restroom: 'restroom',
  bathroom: 'restroom', plant: 'plant', stage: 'stage', dancefloor: 'dancefloor', 'dance-floor': 'dancefloor', dj: 'dj',
};
/** The schema the AI is asked to answer in (server/venue-import-routes.js puts it in the prompt). */
export const AI_SCHEMA = {
  room: '{ "x", "y", "w", "h" } the room\'s outer walls, or null if the picture shows no walls',
  items: '[{ "kind": "table" | "booth" | "high-top" | "bar" | "wall" | "divider" | "door" | "host" | "kitchen" | "restroom" | "label" | "plant" | "stage" | "dancefloor" | "dj", "shape": "round" | "square" | "rectangle" (tables only), "label": the number or text written on it, or "", "seats": number of chairs or stools you can count, or null, "x", "y", "w", "h": its box, "rotation": 0 | 45 | 90 | 135 }]',
  notes: 'one short sentence about anything you could not read, or ""',
};

/** The first JSON object in a reply (it may come in a ```json fence or with words around it). */
export function jsonIn(reply) {
  const s = String(reply ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, s].filter(Boolean)) {
    const a = candidate.indexOf('{'), b = candidate.lastIndexOf('}');
    if (a < 0 || b <= a) continue;
    try { return JSON.parse(candidate.slice(a, b + 1)); } catch { /* try the next */ }
  }
  return null;
}

/**
 * The AI's answer (coordinates 0–1000 across the picture's width and height) → { width, height, items, notes } in
 * plan units: the plan is 1000 wide (the room's walls when it found them, else the whole picture) and as deep as
 * the picture's shape says. Anything it couldn't place sensibly is dropped. null when there's no JSON.
 */
export function readAiPlan(reply, { imageWidth = 1000, imageHeight = 700 } = {}) {
  const data = typeof reply === 'object' && reply ? reply : jsonIn(reply);
  if (!data || !Array.isArray(data.items)) return null;
  const aspect = clamp((Number(imageHeight) || 700) / (Number(imageWidth) || 1000), 0.2, 5);
  const box = data.room && [data.room.x, data.room.y, data.room.w, data.room.h].every((v) => num(v) != null) && data.room.w > 50 && data.room.h > 50
    ? { x: clamp(num(data.room.x), 0, 1000), y: clamp(num(data.room.y), 0, 1000), w: clamp(num(data.room.w), 50, 1000), h: clamp(num(data.room.h), 50, 1000) }
    : { x: 0, y: 0, w: 1000, h: 1000 };
  const width = DEFAULT_W;
  const sx = width / box.w; // plan units per AI unit, across
  const sy = (width * aspect * (box.h / box.w)) / box.h; // the picture's own proportions down
  const height = clamp(Math.round(box.h * sy), 200, 5000);
  const items = [];
  for (const raw of data.items.slice(0, MAX_ITEMS)) {
    const kind = String(raw?.kind || '').toLowerCase().replace(/[\s_]+/g, '-');
    if (!(kind in AI_KINDS)) continue;
    let type = AI_KINDS[kind];
    const seats = num(raw.seats);
    if (kind === 'table') type = shapeFromWord(raw.shape) || typeForSeats(seats);
    if (!ITEM_TYPES.includes(type)) continue;
    const x = num(raw.x), y = num(raw.y), w = num(raw.w), h = num(raw.h);
    if ([x, y, w, h].some((v) => v == null) || w <= 0 || h <= 0) continue;
    let px = Math.round((x - box.x) * sx), py = Math.round((y - box.y) * sy);
    let pw = Math.max(4, Math.round(w * sx)), ph = Math.max(4, Math.round(h * sy));
    if (type === 'wall' || type === 'divider') { // a line, however the AI drew its box
      if (pw >= ph) ph = type === 'wall' ? 10 : 6; else pw = type === 'wall' ? 10 : 6;
    }
    if (px + pw < 0 || py + ph < 0 || px > width || py > height) continue; // outside the room
    px = clamp(px, 0, width - Math.min(pw, width)); py = clamp(py, 0, height - Math.min(ph, height));
    const rot = num(raw.rotation) || 0;
    items.push({
      type, label: text(raw.label, 40), seats: SEATED.has(type) ? (seats == null ? null : clamp(Math.round(seats), 0, 40)) : 0,
      x: px, y: py, w: Math.min(pw, width), h: Math.min(ph, height), r: ((Math.round(rot / 45) * 45) % 360 + 360) % 360,
    });
  }
  return { width, height, items, notes: text(data.notes, 300) };
}

/** A picture's reading (readAiPlan, possibly adjusted by the manager in the preview) → incoming, for one room. */
export function incomingFromImage(read, { roomId = null, roomName = '' } = {}) {
  const items = (read?.items || []).map((i, k) => ({
    key: `a:${k}`, type: ITEM_TYPES.includes(i.type) ? i.type : null, label: text(i.label, 40),
    seats: i.seats == null ? null : num(i.seats), zone: text(i.zone, 30),
    x: num(i.x), y: num(i.y), w: num(i.w), h: num(i.h), r: num(i.r), toastGuid: '',
  })).filter((i) => i.type);
  return { source: 'image', rooms: [{ key: 'room', name: text(roomName, 60), roomId: roomId || null, width: num(read?.width), height: num(read?.height), items }] };
}

/** An incoming payload from the browser, cleaned (sizes capped, unknown types dropped). Throws via fail. */
export function cleanIncoming(raw, fail) {
  const source = SOURCES.includes(raw?.source) ? raw.source : fail(400, 'Pick what to import');
  const rooms = Array.isArray(raw?.rooms) ? raw.rooms : [];
  if (!rooms.length) fail(400, 'There’s nothing to import');
  if (rooms.length > MAX_ROOMS) fail(400, `Import at most ${MAX_ROOMS} rooms at a time`);
  return {
    source,
    rooms: rooms.map((r, k) => {
      const items = Array.isArray(r?.items) ? r.items : [];
      if (items.length > MAX_ITEMS) fail(400, `A floor plan can have at most ${MAX_ITEMS} items`);
      return {
        key: text(r?.key, 80) || `r${k}`, name: text(r?.name, 60), roomId: r?.roomId ? text(r.roomId, 60) : null,
        toast: r?.toast?.serviceAreaGuid ? { serviceAreaGuid: text(r.toast.serviceAreaGuid, 64), revenueCenterGuid: text(r.toast.revenueCenterGuid, 64) || null, revenueCenterName: text(r.toast.revenueCenterName, 60) } : null,
        width: num(r?.width), height: num(r?.height),
        zones: (Array.isArray(r?.zones) ? r.zones : []).slice(0, 30).map((z) => ({ name: text(z?.name, 30), color: /^#[0-9a-f]{6}$/i.test(z?.color || '') ? z.color : null })).filter((z) => z.name),
        items: items.map((i, n) => ({
          key: text(i?.key, 80) || `i${n}`,
          type: ITEM_TYPES.includes(i?.type) ? i.type : null,
          label: text(i?.label, 40), seats: num(i?.seats) == null ? null : clamp(Math.round(num(i.seats)), 0, 40), zone: text(i?.zone, 30),
          x: num(i?.x), y: num(i?.y), w: num(i?.w), h: num(i?.h), r: num(i?.r),
          toastGuid: /^[A-Za-z0-9-]{1,64}$/.test(String(i?.toastGuid || '')) ? String(i.toastGuid) : '',
        })).filter((i) => i.type || i.label || i.toastGuid),
      };
    }),
  };
}

// ---------- matching, preview and apply ----------

/**
 * What an import would do. rooms: the venue's rooms (store.list('rooms')). decisions: { 'roomKey|itemKey':
 * 'skip' | 'create' | 'update:<itemId>' } for ambiguous items. positions: 'keep' (default) or 'replace'.
 * Returns { source, rooms: [{ key, roomId, name, create, toast, plan, items: [action], missing }], counts, warnings }
 * where plan is the room's plan after the import and each action is
 * { key, action: 'create' | 'update' | 'same' | 'ambiguous' | 'skip', reason?, itemId?, candidates?, label, type, seats, changes }.
 */
export function planImport(venueRooms, incoming, { decisions = {}, positions = 'keep', uid = randomId } = {}) {
  const all = venueRooms || [];
  const counts = { create: 0, update: 0, same: 0, ambiguous: 0, skip: 0, rooms: 0, newRooms: 0 };
  const warnings = [];
  // Toast GUID → { room, item } across the venue (rule 1).
  const byGuid = new Map();
  for (const room of all) for (const it of room.plan?.items || []) if (it.toastGuid) byGuid.set(it.toastGuid, { roomId: room.id, id: it.id });
  const plans = new Map(all.map((r) => [r.id, structuredClone(r.plan || emptyPlan())])); // rooms changed by this import
  const touched = new Map(); // roomId → { name, create, toast, … }
  const claimed = new Set(); // item ids an import row already took
  const allGuids = new Set(incoming.rooms.flatMap((r) => r.items.map((i) => i.toastGuid).filter(Boolean)));
  const out = [];

  for (const inRoom of incoming.rooms) {
    // The room: picked, else linked to the Toast service area, else the same name, else a new one.
    let room = (inRoom.roomId && all.find((r) => r.id === inRoom.roomId))
      || (inRoom.toast?.serviceAreaGuid && all.find((r) => r.toast?.serviceAreaGuid === inRoom.toast.serviceAreaGuid))
      || (inRoom.name && all.find((r) => norm(r.name) === norm(inRoom.name))) || null;
    const create = !room;
    const roomId = room?.id || uid('room');
    if (create && !inRoom.name) {
      out.push({ key: inRoom.key, roomId: null, name: '', create: true, error: 'noRoomName', items: [], missing: [], plan: null });
      continue;
    }
    if (create) {
      const fresh = emptyPlan();
      if (inRoom.width) fresh.width = clamp(Math.round(inRoom.width), 200, 5000);
      if (inRoom.height) fresh.height = clamp(Math.round(inRoom.height), 200, 5000);
      plans.set(roomId, fresh);
      counts.newRooms++;
    }
    const plan = plans.get(roomId);
    if (!create && inRoom.height && positions === 'replace') plan.height = clamp(Math.max(plan.height, Math.round(inRoom.height)), 200, 5000);
    plan.zones = plan.zones || [];
    const zoneId = (name) => {
      if (!name) return '';
      let z = plan.zones.find((x) => norm(x.name) === norm(name));
      if (!z) {
        const given = inRoom.zones?.find((x) => norm(x.name) === norm(name))?.color;
        z = { id: uid('zone'), name: text(name, 30), color: given || ZONE_COLORS[plan.zones.length % ZONE_COLORS.length] };
        plan.zones.push(z);
      }
      return z.id;
    };
    const seenKeys = new Map(); // label key → first incoming item key (rule 2, repeated in the import)
    const actions = [];
    const toPlace = [];

    for (const inc of inRoom.items) {
      const type = inc.type;
      const seatedLike = !type || SEATED.has(type);
      const key = `${inRoom.key}|${inc.key}`;
      const base = { key: inc.key, label: inc.label, type: type || 'table-square', seats: inc.seats, zone: inc.zone || '' };
      const decided = decisions[key];
      let action = null;

      // 1. Toast GUID anywhere in the venue.
      const linked = inc.toastGuid && byGuid.get(inc.toastGuid);
      if (linked && !claimed.has(linked.id)) {
        action = { ...base, action: 'update', itemId: linked.id, roomId: linked.roomId };
      } else if (seatedLike && inc.label) {
        // 2. The same number in the same room.
        const lk = labelKey(inc.label);
        const same = (plan.items || []).filter((i) => SEATED.has(i.type) && labelKey(i.label) === lk && !claimed.has(i.id));
        const otherLink = (i) => inc.toastGuid && i.toastGuid && i.toastGuid !== inc.toastGuid;
        if (seenKeys.has(lk)) action = { ...base, action: 'ambiguous', reason: 'repeated', candidates: same.map(pick) };
        else if (same.length > 1) action = { ...base, action: 'ambiguous', reason: 'several', candidates: same.map(pick) };
        else if (same.length === 1 && otherLink(same[0])) action = { ...base, action: 'ambiguous', reason: 'linkedElsewhere', candidates: same.map(pick) };
        else if (same.length === 1) action = { ...base, action: 'update', itemId: same[0].id, roomId };
        else if (!create && (plan.items || []).some((i) => !SEATED.has(i.type) && labelKey(i.label) === lk)) {
          action = { ...base, action: 'ambiguous', reason: 'labelTaken', candidates: [] };
        }
        seenKeys.set(lk, inc.key);
      } else if (!seatedLike) {
        // 3. Walls, labels and fixtures: the same text, or the same spot.
        const match = (plan.items || []).find((i) => i.type === type && !claimed.has(i.id) && (inc.label
          ? labelKey(i.label) === labelKey(inc.label)
          : inc.x != null && overlapShare(i, { x: inc.x, y: inc.y, w: inc.w || 10, h: inc.h || 10, r: inc.r || 0 }) > 0.3));
        if (match) action = { ...base, action: 'same', itemId: match.id, roomId };
      }
      if (!action) action = { ...base, action: 'create', roomId };

      // The manager's decision on an ambiguous one (skip unless they said otherwise).
      if (action.action === 'ambiguous') {
        const pickId = String(decided || '').startsWith('update:') ? decided.slice(7) : null;
        if (pickId && action.candidates.some((c) => c.id === pickId)) action = { ...action, decided: 'update', itemId: pickId, roomId };
        else if (decided === 'create') action = { ...action, decided: 'create' };
        else action = { ...action, decided: 'skip' };
      }

      // Carry it out on the plan copies.
      const doing = action.action === 'ambiguous' ? action.decided : action.action;
      if (doing === 'update' || doing === 'same') {
        const p = plans.get(action.roomId);
        const it = p.items.find((i) => i.id === action.itemId);
        claimed.add(action.itemId);
        const changes = {};
        if (inc.label && labelKey(inc.label) !== labelKey(it.label)) changes.label = inc.label;
        if (inc.toastGuid && it.toastGuid !== inc.toastGuid) changes.toastGuid = inc.toastGuid;
        if (SEATED.has(it.type)) {
          if (type && type !== it.type) Object.assign(changes, { type, ...(inc.w && inc.h ? {} : sizeFor(type, inc.seats ?? it.seats)) });
          if (inc.seats != null && inc.seats !== it.seats) changes.seats = inc.seats;
          if (inc.zone) {
            const target = action.roomId === roomId ? zoneId(inc.zone) : zoneIn(p, inc.zone, uid);
            if (target !== it.zone) changes.zone = target;
          }
        }
        if (positions === 'replace' && inc.x != null && inc.y != null) {
          for (const k of ['x', 'y', 'w', 'h', 'r']) if (inc[k] != null && Math.round(inc[k]) !== it[k]) changes[k] = Math.round(inc[k]);
        }
        const real = doing === 'update' && Object.keys(changes).length;
        if (real) Object.assign(it, changes);
        if (action.roomId !== roomId) touched.set(action.roomId, touched.get(action.roomId) || {});
        action = { ...action, action: action.action === 'ambiguous' ? 'ambiguous' : real ? 'update' : 'same', label: it.label, type: it.type, seats: it.seats, changes: real ? changes : {} };
      } else if (doing === 'create') {
        const t = type || typeForSeats(inc.seats ?? 4);
        const seats = SEATED.has(t) ? (inc.seats ?? TYPE_DEFAULTS[t]?.seats ?? 0) : 0;
        const size = inc.w && inc.h ? { w: Math.round(inc.w), h: Math.round(inc.h) } : sizeFor(t, seats);
        const it = { id: uid('itm'), type: t, ...size, x: 0, y: 0, r: inc.r ? Math.round(inc.r) : 0, label: inc.label || '', seats };
        if (inc.zone && SEATED.has(t)) it.zone = zoneId(inc.zone);
        if (inc.toastGuid) it.toastGuid = inc.toastGuid;
        if (inc.x != null && inc.y != null) { it.x = Math.round(inc.x); it.y = Math.round(inc.y); } else toPlace.push({ it, zone: inc.zone || '' });
        plan.items.push(it);
        claimed.add(it.id);
        if (inc.toastGuid) byGuid.set(inc.toastGuid, { roomId, id: it.id });
        action = { ...action, itemId: it.id, type: t, seats, changes: {} };
      }
      // What actually happens to it: create, update, same (nothing to change) or skip.
      let outcome = action.action === 'ambiguous' ? action.decided : action.action;
      if (outcome === 'update' && !Object.keys(action.changes || {}).length) outcome = 'same';
      counts[outcome]++;
      if (action.action === 'ambiguous') counts.ambiguous++;
      actions.push({ ...action, outcome });
    }

    // New items without positions: on a grid, a block per section, below what's there.
    if (toPlace.length) {
      const groups = [...new Set(toPlace.map((p) => p.zone))];
      const waiting = new Set(toPlace.map((p) => p.it));
      let startY = null;
      for (const g of groups) {
        const list = toPlace.filter((p) => p.zone === g);
        const cell = { w: Math.min(200, Math.max(...list.map((p) => p.it.w))), h: Math.min(200, Math.max(...list.map((p) => p.it.h))) };
        const placed = gridSpots(plan.items.filter((i) => !waiting.has(i)), list.length, { width: plan.width, height: plan.height, cell, gap: 40, startY: startY ?? 40 });
        for (const p of list) waiting.delete(p.it);
        list.forEach((p, k) => { const s = placed.spots[k]; p.it.x = s.x + Math.round((cell.w - p.it.w) / 2); p.it.y = s.y + Math.round((cell.h - p.it.h) / 2); });
        plan.height = placed.height;
        startY = Math.max(...list.map((p) => p.it.y + p.it.h)) + 60;
      }
    }

    // A new room with nothing placed by the source is as deep as its tables need (Toast, a CSV without positions).
    if (create && !inRoom.height && plan.items.length) {
      const bottom = Math.max(...plan.items.map((i) => itemBounds(i).y + itemBounds(i).h));
      plan.height = clamp(Math.ceil((bottom + 60) / 50) * 50, 300, 5000);
    }

    // Toast tables that are here but not in Toast any more: listed, never deleted.
    const missing = incoming.source === 'toast' ? (plan.items || []).filter((i) => i.toastGuid && !allGuids.has(i.toastGuid)).map(pick) : [];
    if (!plan.zones.length) delete plan.zones;
    touched.set(roomId, { ...(touched.get(roomId) || {}), key: inRoom.key, name: room?.name || inRoom.name, create, toast: inRoom.toast || null });
    out.push({ key: inRoom.key, roomId, name: room?.name || inRoom.name, create, toast: inRoom.toast || null, items: actions, missing });
    counts.rooms++;
  }

  // The plans after the import, cleaned like a save (so the preview draws exactly what Apply writes).
  const after = new Map();
  for (const [roomId] of touched) {
    const clean = cleanPlan(plans.get(roomId), { uid });
    after.set(roomId, clean);
    for (const w of planWarnings(clean)) if (w.kind === 'overlap') warnings.push({ roomId, ...w });
  }
  for (const r of out) r.plan = r.roomId ? after.get(r.roomId) || null : null;
  const extra = [...touched.keys()].filter((id) => !out.some((r) => r.roomId === id)).map((id) => ({ roomId: id, plan: after.get(id) }));
  return { source: incoming.source, rooms: out, also: extra, counts, warnings };
}

const pick = (i) => ({ id: i.id, label: i.label, type: i.type, seats: i.seats, toastGuid: i.toastGuid || null });

/** How much of b lies on a (0–1), by their boxes on the floor. */
function overlapShare(a, b) {
  const A = itemBounds(a), B = itemBounds(b);
  const w = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
  const h = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
  return (w * h) / Math.max(1, Math.min(A.w * A.h, B.w * B.h));
}

/** A section id on another room's plan (made when missing). */
function zoneIn(plan, name, uid) {
  plan.zones = plan.zones || [];
  let z = plan.zones.find((x) => norm(x.name) === norm(name));
  if (!z) { z = { id: uid('zone'), name: text(name, 30), color: ZONE_COLORS[plan.zones.length % ZONE_COLORS.length] }; plan.zones.push(z); }
  return z.id;
}
