// Floor plans: the data model, its validation and migration, geometry, numbering, CSV and grid layout.
// Pure functions, no I/O: the service (core/service.js venue.*), the importer (core/floor-import.js), the web
// editor (web/src/pages/FloorPlan.jsx) and the tests all use these, so the rules live in one place.
//
// A room's plan (rooms[].plan), in abstract units (default 1000 × 700, 10 units ≈ 1 ft is a fair reading):
//   { width, height, items: [Item], version?: 2, zones?: [Zone] }
//   Item: { id, type, x, y, w, h, r, label, seats, zone?, toastGuid? }
//     x, y   top-left of the unrotated box; r rotation in degrees around its center (0–359)
//     label  the table number or name ("12", "T12", "B3") or a fixture's text
//     seats  for seated types only (tables, booths, high-tops, bars: a bar's seats are its stools)
//     zone   a Zone id: the table's usual server section, colored in the editor and on exports
//     toastGuid  the Toast table this one is (Venue → Import → From Toast), so a re-import updates it
//   Zone: { id, name, color }: a server section drawn on the layout ("Section 1", "Patio A")
//
// Version 1 plans (before zones, high-tops, dividers, kitchen and restroom fixtures) have no `version` and are
// valid version 2 plans as they are: every new field is optional. migratePlan() still tidies old data once
// (numbers stored as text, duplicate ids, missing rotation) and stamps version 2 (migrateFloorPlans, at startup).

/** The item types of version 1, in their original order. venue.get's `itemTypes` lists these (see core/service.js). */
export const LEGACY_TYPES = ['table-round', 'table-square', 'table-rect', 'booth', 'bar', 'stage', 'dancefloor', 'dj', 'host', 'wall', 'door', 'plant', 'label'];
/** Every item type. */
export const ITEM_TYPES = [...LEGACY_TYPES, 'table-hightop', 'divider', 'kitchen', 'restroom'];
/** Items people sit at: what server sections are made of. */
export const SEATED = new Set(['table-round', 'table-square', 'table-rect', 'booth', 'bar', 'table-hightop']);
/** Tables (numbered T1, T2…; bars and booths have their own prefixes). */
export const TABLE_TYPES = new Set(['table-round', 'table-square', 'table-rect', 'table-hightop']);
/** Walls and things that aren't for sitting: used by the overlap check (a table on a wall is a mistake). */
export const SOLID = new Set(['wall', 'divider', 'host', 'kitchen', 'restroom', 'stage', 'dj', 'bar']);

export const PLAN_VERSION = 2;
export const MAX_ITEMS = 500;
export const MAX_ZONES = 30;
export const DEFAULT_W = 1000;
export const DEFAULT_H = 700;

/** Size, seats and label prefix a new item of a type gets. */
export const TYPE_DEFAULTS = {
  'table-round': { w: 80, h: 80, seats: 4, prefix: 'T' },
  'table-square': { w: 70, h: 70, seats: 4, prefix: 'T' },
  'table-rect': { w: 140, h: 60, seats: 6, prefix: 'T' },
  'table-hightop': { w: 60, h: 60, seats: 2, prefix: 'HT' },
  booth: { w: 140, h: 70, seats: 4, prefix: 'B' },
  bar: { w: 300, h: 50, seats: 8 },
  stage: { w: 260, h: 120 },
  dancefloor: { w: 220, h: 220 },
  dj: { w: 90, h: 60 },
  host: { w: 80, h: 40 },
  kitchen: { w: 120, h: 50 },
  restroom: { w: 80, h: 60 },
  wall: { w: 200, h: 10 },
  divider: { w: 160, h: 6 },
  door: { w: 60, h: 60 },
  plant: { w: 40, h: 40 },
  label: { w: 160, h: 40 },
};

/**
 * The editor's palette, Toast-style: table shapes with a seat count, the bar, the room, and fixtures.
 * name: a web catalog key (web/src/i18n/en-floor.js floor.preset.*); label: the catalog key of a fixture's default text.
 */
export const PRESETS = [
  { id: 'square-2', group: 'tables', type: 'table-square', w: 60, h: 60, seats: 2 },
  { id: 'square-4', group: 'tables', type: 'table-square', w: 70, h: 70, seats: 4 },
  { id: 'rect-6', group: 'tables', type: 'table-rect', w: 140, h: 60, seats: 6 },
  { id: 'rect-8', group: 'tables', type: 'table-rect', w: 180, h: 70, seats: 8 },
  { id: 'round-2', group: 'tables', type: 'table-round', w: 60, h: 60, seats: 2 },
  { id: 'round-4', group: 'tables', type: 'table-round', w: 80, h: 80, seats: 4 },
  { id: 'round-6', group: 'tables', type: 'table-round', w: 100, h: 100, seats: 6 },
  { id: 'round-8', group: 'tables', type: 'table-round', w: 120, h: 120, seats: 8 },
  { id: 'booth-4', group: 'tables', type: 'booth', w: 140, h: 70, seats: 4 },
  { id: 'booth-6', group: 'tables', type: 'booth', w: 180, h: 80, seats: 6 },
  { id: 'hightop-2', group: 'tables', type: 'table-hightop', w: 60, h: 60, seats: 2 },
  { id: 'hightop-4', group: 'tables', type: 'table-hightop', w: 80, h: 80, seats: 4 },
  { id: 'bar-6', group: 'bar', type: 'bar', w: 240, h: 50, seats: 6, label: 'floor.default.bar' },
  { id: 'bar-10', group: 'bar', type: 'bar', w: 380, h: 50, seats: 10, label: 'floor.default.bar' },
  { id: 'bar-counter', group: 'bar', type: 'bar', w: 300, h: 50, seats: 0, label: 'floor.default.bar' },
  { id: 'wall', group: 'room', type: 'wall', w: 200, h: 10 },
  { id: 'divider', group: 'room', type: 'divider', w: 160, h: 6 },
  { id: 'door', group: 'room', type: 'door', w: 60, h: 60 },
  { id: 'label', group: 'room', type: 'label', w: 160, h: 40, label: 'floor.default.label' },
  { id: 'plant', group: 'room', type: 'plant', w: 40, h: 40 },
  { id: 'host', group: 'fixtures', type: 'host', w: 80, h: 40, label: 'floor.default.host' },
  { id: 'kitchen', group: 'fixtures', type: 'kitchen', w: 120, h: 50, label: 'floor.default.kitchen' },
  { id: 'restroom', group: 'fixtures', type: 'restroom', w: 80, h: 60, label: 'floor.default.restroom' },
  { id: 'stage', group: 'fixtures', type: 'stage', w: 260, h: 120, label: 'floor.default.stage' },
  { id: 'dancefloor', group: 'fixtures', type: 'dancefloor', w: 220, h: 220, label: 'floor.default.danceFloor' },
  { id: 'dj', group: 'fixtures', type: 'dj', w: 90, h: 60, label: 'floor.default.dj' },
];
export const PRESET_GROUPS = ['tables', 'bar', 'room', 'fixtures'];

/** Section colors, in the order new sections get them (readable on light and dark floors). */
export const ZONE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#7c3aed', '#ea580c'];

const num = (v, d) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const COLOR = /^#[0-9a-f]{6}$/i;
const GUID = /^[A-Za-z0-9-]{1,64}$/;
const randomId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
export const emptyPlan = () => ({ width: DEFAULT_W, height: DEFAULT_H, items: [] });
export const normRotation = (r) => ((Math.round(num(r, 0)) % 360) + 360) % 360;

/** A plan's server sections, cleaned: unique ids, names, colors. */
export function cleanZones(raw, { uid = randomId } = {}) {
  const out = [];
  const ids = new Set();
  for (const z of Array.isArray(raw) ? raw.slice(0, MAX_ZONES) : []) {
    const name = text(z?.name, 30);
    if (!name) continue;
    let id = text(z.id, 40);
    if (!id || ids.has(id)) id = uid('zone');
    ids.add(id);
    out.push({ id, name, color: COLOR.test(z.color || '') ? z.color.toLowerCase() : ZONE_COLORS[out.length % ZONE_COLORS.length] });
  }
  return out;
}

/**
 * A plan as it's saved: sizes clamped, items kept inside the room, ids unique, rotation 0–359, labels and seats
 * capped. fail(status, message) is called for what can't be fixed (an unknown type, too many items); without it,
 * those items are dropped instead (migratePlan). Optional fields are only written when set, so a version 1
 * plan saved again looks the same apart from `version`.
 */
export function cleanPlan(p, { fail = null, uid = randomId } = {}) {
  const width = clamp(Math.round(num(p?.width, DEFAULT_W)), 200, 5000);
  const height = clamp(Math.round(num(p?.height, DEFAULT_H)), 200, 5000);
  let raw = Array.isArray(p?.items) ? p.items : [];
  if (raw.length > MAX_ITEMS) {
    if (fail) fail(400, `A floor plan can have at most ${MAX_ITEMS} items`);
    raw = raw.slice(0, MAX_ITEMS);
  }
  const zones = cleanZones(p?.zones, { uid });
  const zoneIds = new Set(zones.map((z) => z.id));
  const ids = new Set();
  const items = [];
  for (const i of raw) {
    if (!ITEM_TYPES.includes(i?.type)) {
      if (fail) fail(400, `Unknown floor plan item "${text(i?.type, 30)}"`);
      continue;
    }
    const w = clamp(Math.round(num(i.w, 60)), 4, width);
    const h = clamp(Math.round(num(i.h, 60)), 4, height);
    let id = text(i.id, 40);
    if (!id || ids.has(id)) id = uid('itm');
    ids.add(id);
    const item = {
      id, type: i.type, w, h,
      x: clamp(Math.round(num(i.x, 0)), 0, width - w),
      y: clamp(Math.round(num(i.y, 0)), 0, height - h),
      r: normRotation(i.r),
      label: text(i.label, 40),
      seats: SEATED.has(i.type) ? clamp(Math.round(num(i.seats, 0)), 0, 40) : 0,
    };
    if (i.zone && zoneIds.has(String(i.zone)) && SEATED.has(i.type)) item.zone = String(i.zone);
    if (i.toastGuid && GUID.test(String(i.toastGuid))) item.toastGuid = String(i.toastGuid);
    items.push(item);
  }
  return { width, height, items, version: PLAN_VERSION, ...(zones.length ? { zones } : {}) };
}

/**
 * A saved plan brought up to the current version without failing: whatever can't be read is dropped.
 * Returns { plan, changed }. Idempotent: a current plan comes back unchanged.
 */
export function migratePlan(p, { uid = randomId } = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { plan: { ...emptyPlan(), version: PLAN_VERSION }, changed: true };
  const plan = cleanPlan(p, { uid });
  return { plan, changed: JSON.stringify(plan) !== JSON.stringify(p) };
}

export const FLOOR_PLAN_MIGRATION = 'floor-plan-v2';
/** Once per restaurant (server/app.js startup): every room's plan to version 2. The marker records how many changed. */
export function migrateFloorPlans(store, { at = new Date().toISOString(), uid = randomId } = {}) {
  if (store.get('migrations', FLOOR_PLAN_MIGRATION)) return null;
  let changed = 0;
  for (const room of store.list('rooms')) {
    const m = migratePlan(room.plan, { uid });
    if (m.changed) { store.update('rooms', room.id, { plan: m.plan }); changed++; }
  }
  store.insert('migrations', { id: FLOOR_PLAN_MIGRATION, at, rooms: changed });
  return changed;
}

// ---------- geometry ----------
/** The four corners of an item, rotated around its center. */
export function corners(it) {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const a = ((Number(it.r) || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const dx = (sx * it.w) / 2, dy = (sy * it.h) / 2;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
}

/** The box an item covers on the floor, rotation included: { x, y, w, h }. */
export function itemBounds(it) {
  const pts = corners(it);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The box around several items (null for none). */
export function boundsOf(items) {
  if (!items?.length) return null;
  const bs = items.map(itemBounds);
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

/** Do two rotated rectangles overlap by more than `slack` units? (Separating axis test; touching doesn't count.) */
export function itemsOverlap(a, b, slack = 1) {
  const pa = corners(a), pb = corners(b);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < 2; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
      const nx = y2 - y1, ny = x1 - x2;
      const len = Math.hypot(nx, ny) || 1;
      const proj = (pts) => pts.map(([x, y]) => (x * nx + y * ny) / len);
      const A = proj(pa), B = proj(pb);
      if (Math.max(...A) - slack <= Math.min(...B) || Math.max(...B) - slack <= Math.min(...A)) return false;
    }
  }
  return true;
}

/**
 * What looks wrong on a plan: seated items on top of each other or of a wall or fixture, and items poking out of
 * the room. [{ kind: 'overlap', ids: [a, b] } | { kind: 'outside', ids: [a] }].
 */
export function planWarnings(plan) {
  const items = plan?.items || [];
  const W = plan?.width || DEFAULT_W, H = plan?.height || DEFAULT_H;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (!SEATED.has(a.type)) continue;
    for (let j = 0; j < items.length; j++) {
      const b = items[j];
      if (j === i || (SEATED.has(b.type) && j < i)) continue;
      if (!SEATED.has(b.type) && !SOLID.has(b.type)) continue;
      if (itemsOverlap(a, b)) out.push({ kind: 'overlap', ids: [a.id, b.id] });
    }
  }
  for (const it of items) {
    const b = itemBounds(it);
    if (b.x < -1 || b.y < -1 || b.x + b.w > W + 1 || b.y + b.h > H + 1) out.push({ kind: 'outside', ids: [it.id] });
  }
  return out;
}

// ---------- table numbers ----------
/**
 * The key two table names are compared by: case, spaces, a leading "Table"/"Mesa"/"#" and a lone "T" before a
 * number don't count, so "T12", "Table 12", "mesa 12", "#12" and "12" are one table, while "B1" (a booth) stays B1.
 */
export function labelKey(label) {
  let s = String(label ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');
  s = s.replace(/^(table|tbl|mesa|tab)\.?/, '').replace(/^(no\.?|number|num|#)/, '').replace(/^#/, '');
  if (/^t\d+[a-z]?$/.test(s)) s = s.slice(1);
  return s;
}

/** The next free number with a prefix: T1, T2 → "T3" (numbers anywhere after the prefix). */
export function nextLabel(items, prefix = 'T') {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`, 'i');
  const max = (items || []).reduce((m, i) => Math.max(m, Number(String(i.label || '').match(re)?.[1] || 0)), 0);
  return `${prefix}${max + 1}`;
}

/** The label a new item of this type gets on this plan (tables numbered, fixtures their default text). */
export function defaultLabel(items, type, fixtureText = '') {
  const prefix = TYPE_DEFAULTS[type]?.prefix;
  return prefix ? nextLabel(items, prefix) : fixtureText;
}

/**
 * New numbers for some items, in reading order (rows top to bottom, then left to right): { [id]: label }.
 * prefix '' numbers plainly (1, 2, 3, the way Toast shows tables); start is the first number.
 */
export function renumber(items, ids, { prefix = 'T', start = 1, rowTolerance = 40 } = {}) {
  const pick = (items || []).filter((i) => ids.includes(i.id)).map((i) => ({ i, c: [i.x + i.w / 2, i.y + i.h / 2] }));
  pick.sort((a, b) => a.c[1] - b.c[1]);
  const rows = [];
  for (const p of pick) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(p.c[1] - row.y) <= rowTolerance) row.list.push(p); else rows.push({ y: p.c[1], list: [p] });
  }
  const out = {};
  let n = Math.max(0, Math.round(num(start, 1)));
  for (const row of rows) for (const p of row.list.sort((a, b) => a.c[0] - b.c[0])) out[p.i.id] = `${prefix}${n++}`;
  return out;
}

/** Table, seat and bar-seat counts for a plan. */
export function planCounts(plan) {
  const items = plan?.items || [];
  return {
    tables: items.filter((i) => TABLE_TYPES.has(i.type) || i.type === 'booth').length,
    seats: items.reduce((t, i) => t + (SEATED.has(i.type) ? Number(i.seats) || 0 : 0), 0),
    barSeats: items.filter((i) => i.type === 'bar').reduce((t, i) => t + (Number(i.seats) || 0), 0),
  };
}

// ---------- shapes from words (CSV, the AI, Toast) ----------
const SHAPE_WORDS = [
  [/high\s*-?\s*top|hightop|periquera|alta/i, 'table-hightop'],
  [/booth|banquette|gabinete|reservado/i, 'booth'],
  [/bar|barra|counter/i, 'bar'],
  [/round|circle|circular|oval|redond/i, 'table-round'],
  [/square|cuadrad/i, 'table-square'],
  [/rect|long|banquet|larga|rectangular/i, 'table-rect'],
];
/** A table type from a word ("round", "high-top", "booth"…) or a type name; null when it isn't one. */
export function shapeFromWord(word) {
  const s = String(word ?? '').trim();
  if (!s) return null;
  if (ITEM_TYPES.includes(s)) return s;
  for (const [re, type] of SHAPE_WORDS) if (re.test(s)) return type;
  return null;
}

/** The size a table of a type and seat count is drawn at (the palette's presets, else the type's default). */
export function sizeFor(type, seats) {
  const n = Math.round(num(seats, TYPE_DEFAULTS[type]?.seats || 0));
  const same = PRESETS.filter((p) => p.type === type && p.seats > 0);
  if (type === 'bar') return { w: clamp(n * 40, 120, 800), h: 50 };
  if (same.length) {
    const best = same.reduce((a, b) => (Math.abs(b.seats - n) < Math.abs(a.seats - n) ? b : a));
    if (best.seats >= n || type === 'booth' || type === 'table-hightop') return { w: best.w, h: best.h };
    const grow = 1 + (n - best.seats) * 0.12; // longer rectangles, bigger rounds for big parties
    return type === 'table-round' ? { w: Math.round(best.w * grow), h: Math.round(best.h * grow) } : { w: Math.round(best.w * grow), h: best.h };
  }
  const d = TYPE_DEFAULTS[type] || { w: 60, h: 60 };
  return { w: d.w, h: d.h };
}

/** A table type for a seat count when nothing says the shape: 2–4 square, 5+ long. */
export const typeForSeats = (seats) => (Number(seats) > 4 ? 'table-rect' : 'table-square');

// ---------- grid layout (Toast gives no positions) ----------
/**
 * Spots for `count` new items on a plan, left to right and top to bottom on a grid, skipping anything already
 * there. Returns { spots: [{ x, y }], height } (height grows when the room is too small).
 */
export function gridSpots(occupied, count, { width = DEFAULT_W, height = DEFAULT_H, cell = { w: 80, h: 80 }, gap = 40, margin = 40, startY = margin } = {}) {
  const taken = (occupied || []).map(itemBounds);
  const stepX = cell.w + gap, stepY = cell.h + gap;
  const cols = Math.max(1, Math.floor((width - 2 * margin + gap) / stepX));
  const spots = [];
  const free = (x, y) => !taken.some((b) => x < b.x + b.w + gap / 2 && x + cell.w + gap / 2 > b.x && y < b.y + b.h + gap / 2 && y + cell.h + gap / 2 > b.y);
  for (let k = 0; spots.length < count && k < count * 50 + 200; k++) {
    const x = margin + (k % cols) * stepX, y = startY + Math.floor(k / cols) * stepY;
    if (!free(x, y)) continue;
    spots.push({ x, y });
    taken.push({ x, y, w: cell.w, h: cell.h });
  }
  const bottom = spots.reduce((m, s) => Math.max(m, s.y + cell.h + margin), 0);
  return { spots, height: clamp(Math.max(height, Math.ceil(bottom / 50) * 50), 200, 5000) };
}

// ---------- CSV ----------
export const CSV_COLUMNS = ['Room', 'Table', 'Seats', 'Shape', 'Section', 'X', 'Y', 'Width', 'Depth', 'Rotation', 'Toast GUID'];
const SHAPE_NAMES = {
  'table-round': 'round', 'table-square': 'square', 'table-rect': 'rectangle', 'table-hightop': 'high-top', booth: 'booth', bar: 'bar',
};
/** Tables in number order: T2 before T10, then B1… (natural order, the way a table list reads). */
export const byLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'en', { numeric: true, sensitivity: 'base' });

/** The CSV word for a type (the importer reads it back). */
export const shapeName = (type) => SHAPE_NAMES[type] || type;

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet never runs typed text as a formula
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Every seated item of some rooms as CSV (one row each, rooms in order, tables by number): the columns the importer reads, so it
 * round-trips. rooms: [{ name, plan }]. With a BOM so spreadsheet apps read accents right.
 */
export function planCsv(rooms) {
  const rows = [CSV_COLUMNS];
  for (const room of rooms || []) {
    const zones = new Map((room.plan?.zones || []).map((z) => [z.id, z.name]));
    const seated = (room.plan?.items || []).filter((i) => SEATED.has(i.type)).sort(byLabel);
    for (const i of seated) {
      rows.push([room.name, i.label, i.seats, shapeName(i.type), zones.get(i.zone) || '', i.x, i.y, i.w, i.h, i.r || 0, i.toastGuid || '']);
    }
  }
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const COLUMN_WORDS = {
  room: ['room', 'area', 'service area', 'dining area', 'location', 'floor', 'salon', 'salón', 'area de servicio', 'área', 'área de servicio', 'zona'],
  label: ['table', 'table name', 'table number', 'table no', 'name', 'number', 'mesa', 'numero', 'número', 'nombre', 'numero de mesa', 'número de mesa'],
  seats: ['seats', 'seat count', 'covers', 'capacity', 'guests', 'pax', 'chairs', 'asientos', 'sillas', 'capacidad', 'lugares', 'personas'],
  shape: ['shape', 'type', 'table type', 'kind', 'forma', 'tipo'],
  zone: ['section', 'server section', 'zone', 'station', 'seccion', 'sección', 'estacion', 'estación'],
  x: ['x', 'left', 'pos x'],
  y: ['y', 'top', 'pos y'],
  w: ['width', 'w', 'ancho'],
  h: ['depth', 'height', 'h', 'length', 'alto', 'fondo', 'largo'],
  r: ['rotation', 'r', 'angle', 'rotacion', 'rotación', 'angulo', 'ángulo'],
  toastGuid: ['toast guid', 'guid', 'toast id'],
};
const headerWord = (h) => String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[_#.]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Which column is which: { room: 0, label: 1, … } (-1 when absent). */
export function csvColumns(header) {
  const words = (header || []).map(headerWord);
  const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out = {};
  for (const [field, names] of Object.entries(COLUMN_WORDS)) {
    out[field] = words.findIndex((w) => names.some((n) => plain(n) === plain(w)));
  }
  return out;
}

/**
 * Rows of a floor plan CSV → { rows: [{ line, room, label, seats, type, zone, x, y, w, h, r, toastGuid }], errors: [{ line, error }] }.
 * parse: a CSV parser (core/adp-csv.js parseCsv). Only the table name is required; numbers are null when blank.
 */
export function readPlanCsv(src, parse) {
  const all = parse(src).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!all.length) return { rows: [], errors: [{ line: 0, error: 'empty' }], columns: null };
  const columns = csvColumns(all[0]);
  if (columns.label < 0) return { rows: [], errors: [{ line: 1, error: 'noTableColumn' }], columns };
  const rows = [];
  const errors = [];
  const cell = (r, f) => (columns[f] >= 0 ? String(r[columns[f]] ?? '').trim() : '');
  const number = (r, f) => { const v = cell(r, f).replace(/^'/, ''); return v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };
  all.slice(1).forEach((r, k) => {
    const line = k + 2;
    const label = text(cell(r, 'label'), 40);
    if (!label) { errors.push({ line, error: 'noTable' }); return; }
    const shape = cell(r, 'shape');
    const type = shape ? shapeFromWord(shape) : null;
    if (shape && !type) errors.push({ line, error: 'unknownShape', value: shape.slice(0, 30) });
    const seats = number(r, 'seats');
    rows.push({
      line, label, room: text(cell(r, 'room'), 60), seats: seats == null ? null : clamp(Math.round(seats), 0, 40),
      type: type && SEATED.has(type) ? type : null, zone: text(cell(r, 'zone'), 30),
      x: number(r, 'x'), y: number(r, 'y'), w: number(r, 'w'), h: number(r, 'h'), r: number(r, 'r'),
      toastGuid: GUID.test(cell(r, 'toastGuid')) ? cell(r, 'toastGuid') : '',
    });
  });
  return { rows, errors, columns };
}
