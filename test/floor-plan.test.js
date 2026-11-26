// Floor plans (core/floor-plan.js) and importing them (core/floor-import.js, server/venue-import-routes.js):
//   - version 1 plans load and migrate to version 2, once, without losing anything; sections still work
//   - geometry: rotated bounds, overlap and outside-the-room warnings, numbering in reading order
//   - CSV: reading English and Spanish headers, shapes from words, export that round-trips
//   - duplicate detection: same Toast GUID, same table number in the same room, ambiguous rows skipped by default
//   - Toast: a fake Toast API over HTTP, idempotent by GUID, manual positions kept, service areas as rooms or sections
//   - a picture: the AI (a fake client) read into a plan; not set up says so and spends nothing
//   - permissions: managers and up import, staff view
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { parseCsv } from '../core/adp-csv.js';
import {
  cleanPlan, migratePlan, migrateFloorPlans, FLOOR_PLAN_MIGRATION, itemBounds, itemsOverlap, planWarnings, renumber, labelKey,
  nextLabel, readPlanCsv, planCsv, sizeFor, gridSpots, planCounts, shapeFromWord, ITEM_TYPES, LEGACY_TYPES, SEATED,
} from '../core/floor-plan.js';
import { incomingFromCsv, incomingFromToast, incomingFromImage, readAiPlan, jsonIn, planImport } from '../core/floor-import.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';
import { fakeAnthropic, text } from './helpers/fake-anthropic.js';
import { _tokenCache } from '../server/toast.js';

// A brand-new restaurant (no real people): one manager, one employee.
function fresh() {
  const store = new MemoryStore();
  store.insert('settings', { id: 'settings', restaurantName: 'Test Bistro', rooms: [] });
  const mgr = store.insert('users', { id: 'usr_m', name: 'Manager One', role: 'manager', email: 'm@test.local', active: true, jobCodes: [], availability: {} });
  const emp = store.insert('users', { id: 'usr_e', name: 'Employee One', role: 'employee', email: 'e@test.local', active: true, jobCodes: [], availability: {} });
  const svc = createService(store, { now: () => new Date('2026-11-20T18:00:00Z') });
  return { store, svc, mgr: (m, a = {}) => svc.call(store.get('users', mgr.id), m, a), emp: (m, a = {}) => svc.call(store.get('users', emp.id), m, a) };
}
const t = (id, type, x, y, label, seats = 4, extra = {}) => ({ id, type, x, y, w: 70, h: 70, r: 0, label, seats, ...extra });

// ---------- the data model and its migration ----------

test('a version 1 plan loads as it is, and migrates to version 2 once without losing anything', () => {
  const v1 = { width: 1000, height: 700, items: [t('itm_1', 'table-square', 100, 100, 'T1'), { id: 'itm_2', type: 'bar', x: '300', y: '40', w: 300, h: 50, label: 'Bar', seats: '8' },
    { id: 'itm_1', type: 'plant', x: 10, y: 10, w: 40, h: 40, label: '', seats: 3 }, { id: 'itm_4', type: 'hot-tub', x: 0, y: 0, w: 10, h: 10 }] };
  const { plan, changed } = migratePlan(v1);
  assert.equal(changed, true);
  assert.equal(plan.version, 2);
  assert.equal(plan.items.length, 3, 'only what can’t be drawn is dropped');
  assert.deepEqual(plan.items[1], { id: 'itm_2', type: 'bar', w: 300, h: 50, x: 300, y: 40, r: 0, label: 'Bar', seats: 8 }, 'text numbers become numbers');
  assert.notEqual(plan.items[2].id, 'itm_1', 'a duplicate id gets a fresh one');
  assert.equal(plan.items[2].seats, 0, 'plants have no seats');
  assert.equal(plan.zones, undefined, 'no sections until someone adds one');
  assert.equal(migratePlan(plan).changed, false, 'idempotent');
  assert.equal(migratePlan(null).plan.items.length, 0);

  // The whole venue, once, with a marker; sections on the old ids keep working.
  const store = new MemoryStore();
  const ids = seedDemo(store, { now: new Date(2026, 8, 27, 12) });
  const before = store.list('rooms').map((r) => r.plan.items.map((i) => i.id).join());
  const sections = store.list('sections').length;
  const n = migrateFloorPlans(store, { at: '2026-11-20T00:00:00Z' });
  assert.equal(n, 5, 'every demo room is stamped version 2');
  assert.deepEqual(store.get('migrations', FLOOR_PLAN_MIGRATION).rooms, 5);
  assert.deepEqual(store.list('rooms').map((r) => r.plan.items.map((i) => i.id).join()), before, 'same items, same ids');
  assert.equal(migrateFloorPlans(store), null, 'runs once');
  const svc = createService(store, { now: () => new Date(2026, 8, 27, 12) });
  const moe = store.get('users', ids.userId.Moe);
  const list = svc.call(moe, 'sections.list', { start: '2026-09-28', end: '2026-10-04' });
  assert.ok(list.length && sections, 'sections on migrated plans still read');
  assert.ok(list.every((d) => d.entries.every((e) => e.tables.every((l) => l !== '?'))));
});

test('new types, sections (zones) and Toast GUIDs are saved; venue.get still lists the version 1 types', () => {
  const { mgr, emp } = fresh();
  const room = mgr('venue.saveRoom', { name: 'Dining' });
  const saved = mgr('venue.savePlan', {
    roomId: room.id,
    plan: {
      zones: [{ id: 'z1', name: 'Section 1', color: '#123456' }, { name: '' }, { id: 'z1', name: 'Section 2', color: 'red' }],
      items: [
        t('a', 'table-hightop', 10, 10, 'HT1', 2, { zone: 'z1', toastGuid: 'abc-123' }),
        { id: 'b', type: 'divider', x: 200, y: 0, w: 160, h: 6, zone: 'z1', toastGuid: 'nope nope' },
        { id: 'c', type: 'kitchen', x: 400, y: 600, w: 120, h: 50, label: 'Kitchen', seats: 4 },
        { id: 'd', type: 'restroom', x: 600, y: 600, w: 80, h: 60, label: 'Restrooms' },
        t('e', 'table-round', 500, 300, 'T2', 4, { zone: 'zone-gone' }),
      ],
    },
  });
  const p = saved.plan;
  assert.equal(p.version, 2);
  assert.deepEqual(p.zones.map((z) => [z.name, z.color]), [['Section 1', '#123456'], ['Section 2', '#16a34a']], 'blank names dropped, bad colors replaced');
  assert.notEqual(p.zones[1].id, 'z1', 'a duplicate zone id gets a fresh one');
  assert.equal(p.items[0].zone, 'z1');
  assert.equal(p.items[0].toastGuid, 'abc-123');
  assert.equal(p.items[1].zone, undefined, 'only tables are in a section');
  assert.equal(p.items[1].toastGuid, undefined, 'a GUID with spaces is not a GUID');
  assert.equal(p.items[2].seats, 0, 'fixtures have no seats');
  assert.equal(p.items[4].zone, undefined, 'a section that isn’t on the plan is dropped');
  const v = emp('venue.get');
  assert.deepEqual(v.itemTypes, LEGACY_TYPES, 'what installed phone apps can draw');
  assert.equal(v.rooms[0].plan.items.length, 5, 'staff see the plan');
  assert.ok(ITEM_TYPES.includes('table-hightop') && SEATED.has('table-hightop') && !SEATED.has('kitchen'));
});

// ---------- geometry and numbering ----------

test('geometry: rotated bounds, overlaps (touching is fine), outside the room, counts', () => {
  const bar = { id: 'b', type: 'bar', x: 100, y: 100, w: 200, h: 50, r: 90 };
  const b = itemBounds(bar);
  assert.deepEqual([Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)], [175, 25, 50, 200], 'turned 90°: tall and thin');
  const d = itemBounds({ x: 0, y: 0, w: 100, h: 100, r: 45 });
  assert.equal(Math.round(d.w), 141, 'a square at 45° is wider');

  const a1 = t('a1', 'table-square', 100, 100, 'T1');
  assert.equal(itemsOverlap(a1, t('x', 'table-square', 170, 100, 'T2')), false, 'side by side, touching');
  assert.equal(itemsOverlap(a1, t('x', 'table-square', 150, 120, 'T2')), true);
  assert.equal(itemsOverlap(a1, { ...t('x', 'table-square', 175, 100, 'T2'), r: 45 }), true, 'a turned table pokes into its neighbour');

  const plan = {
    width: 500, height: 400, items: [
      a1, t('a2', 'table-square', 130, 130, 'T2'), // on top of T1
      { id: 'w', type: 'wall', x: 0, y: 160, w: 500, h: 10, r: 0, label: '' }, // through both
      t('a3', 'table-round', 400, 300, 'T3', 4, { w: 80, h: 80, r: 0 }), // fine
      { id: 'lab', type: 'label', x: 90, y: 90, w: 160, h: 40, r: 0, label: 'Patio' }, // labels never count
      { id: 'long', type: 'table-rect', x: 300, y: 10, w: 300, h: 60, r: 0, label: 'T4', seats: 8 }, // past the right wall
    ],
  };
  const warn = planWarnings(plan);
  const overlaps = warn.filter((w) => w.kind === 'overlap').map((w) => w.ids.join('+')).sort();
  assert.deepEqual(overlaps, ['a1+a2', 'a1+w', 'a2+w']);
  assert.deepEqual(warn.filter((w) => w.kind === 'outside').map((w) => w.ids[0]), ['long']);
  assert.deepEqual(planCounts(plan), { tables: 4, seats: 20, barSeats: 0 });
});

test('numbering: next free number, renumbering in reading order, table names compared loosely', () => {
  assert.equal(nextLabel([{ label: 'T1' }, { label: 'T9' }, { label: 'B2' }, { label: 'Tx' }], 'T'), 'T10');
  assert.equal(nextLabel([], 'HT'), 'HT1');
  const items = [t('c', 'table-square', 400, 105, ''), t('a', 'table-square', 50, 100, ''), t('d', 'table-square', 60, 300, ''), t('b', 'table-square', 220, 90, '')];
  assert.deepEqual(renumber(items, ['a', 'b', 'c', 'd'], { prefix: 'T', start: 10 }), { a: 'T10', b: 'T11', c: 'T12', d: 'T13' }, 'a row (within 40 units) left to right, then the next row');
  assert.deepEqual(renumber(items, ['d', 'a'], { prefix: '' }), { a: '1', d: '2' });
  for (const s of ['T12', 'Table 12', 'mesa 12', '#12', '12', ' t 12 ']) assert.equal(labelKey(s), '12', s);
  assert.notEqual(labelKey('B1'), labelKey('1'), 'a booth number is its own');
  assert.equal(labelKey('Patio 3'), 'patio3');
});

test('sizes and grid spots', () => {
  assert.deepEqual(sizeFor('table-round', 8), { w: 120, h: 120 });
  assert.deepEqual(sizeFor('table-square', 2), { w: 60, h: 60 });
  assert.ok(sizeFor('table-rect', 12).w > 180, 'a 12-top is longer than an 8-top');
  assert.deepEqual(sizeFor('bar', 6), { w: 240, h: 50 });
  const { spots, height } = gridSpots([{ x: 40, y: 40, w: 80, h: 80, r: 0 }], 12, { width: 600, height: 300 });
  assert.equal(spots.length, 12);
  assert.ok(!spots.some((s) => s.x === 40 && s.y === 40), 'skips what’s already there');
  assert.ok(height > 300, 'the room grows when they don’t fit');
  assert.equal(shapeFromWord('High top'), 'table-hightop');
  assert.equal(shapeFromWord('Redonda'), 'table-round');
  assert.equal(shapeFromWord('banquette'), 'booth');
  assert.equal(shapeFromWord('sofa'), null);
});

// ---------- CSV ----------

test('CSV: English or Spanish headers, shapes from words, errors by line', () => {
  const csv = 'Área,Mesa,Asientos,Forma,Sección\nPatio,1,2,redonda,A\nPatio,2,4,,A\n,3,8,rectangular,B\nPatio,,4,,\nPatio,4,4,sofa,\n';
  const { rows, errors } = readPlanCsv(csv, parseCsv);
  assert.deepEqual(rows.map((r) => [r.room, r.label, r.seats, r.type, r.zone]), [
    ['Patio', '1', 2, 'table-round', 'A'], ['Patio', '2', 4, null, 'A'], ['', '3', 8, 'table-rect', 'B'], ['Patio', '4', 4, null, ''],
  ]);
  assert.deepEqual(errors.map((e) => [e.line, e.error]), [[5, 'noTable'], [6, 'unknownShape']]);
  assert.equal(readPlanCsv('Room,Seats\nA,4\n', parseCsv).errors[0].error, 'noTableColumn');
  assert.equal(readPlanCsv('', parseCsv).errors[0].error, 'empty');
});

test('CSV import: creates tables on a grid, a second import changes nothing, and exporting round-trips', () => {
  const { mgr, emp, store } = fresh();
  const dining = mgr('venue.saveRoom', { name: 'Dining' });
  const csv = 'Room,Table,Seats,Shape,Section\nDining,T1,2,square,Window\nDining,T2,4,round,Window\nDining,T3,6,,Back\nPatio,P1,4,high-top,\n';
  const incoming = incomingFromCsv(readPlanCsv(csv, parseCsv).rows, { roomId: dining.id });
  const preview = mgr('venue.importPreview', { incoming });
  assert.deepEqual([preview.counts.create, preview.counts.update, preview.counts.newRooms], [4, 0, 1]);
  assert.equal(store.get('rooms', dining.id).plan.items.length, 0, 'a preview saves nothing');
  assert.throws(() => emp('venue.importPreview', { incoming }), /Managers only/);
  assert.throws(() => emp('venue.importApply', { incoming }), /Managers only/);

  const done = mgr('venue.importApply', { incoming, fileName: 'tables.csv' });
  assert.deepEqual(done.counts.create, 4);
  const plan = store.get('rooms', dining.id).plan;
  assert.deepEqual(plan.items.map((i) => [i.label, i.type, i.seats]), [['T1', 'table-square', 2], ['T2', 'table-round', 4], ['T3', 'table-rect', 6]]);
  assert.deepEqual(plan.zones.map((z) => z.name), ['Window', 'Back']);
  assert.equal(planWarnings(plan).length, 0, 'laid out without overlaps');
  assert.ok(plan.items[2].y > plan.items[0].y, 'each section starts its own block');
  const patio = store.list('rooms').find((r) => r.name === 'Patio');
  assert.equal(patio.plan.items[0].type, 'table-hightop');
  assert.ok(createService(store).settings().rooms.includes('Patio'), 'a new room shows up in the room lists');
  const audit = store.list('auditLog', (a) => a.action === 'venue.imported');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].details.source, audit[0].details.fileName, audit[0].details.created], ['csv', 'tables.csv', 4]);

  // The same file again: nothing new, nothing changed.
  const again = mgr('venue.importApply', { incoming });
  assert.deepEqual([again.counts.create, again.counts.update, again.counts.same], [0, 0, 4]);
  assert.equal(store.get('rooms', dining.id).plan.items.length, 3);

  // Export → import: the same tables, matched one for one.
  const exported = planCsv(store.list('rooms').map((r) => ({ name: r.name, plan: r.plan })));
  assert.ok(exported.startsWith('﻿Room,Table,Seats,Shape,Section,X,Y,Width,Depth,Rotation,Toast GUID\r\n'));
  assert.match(exported, /\r\nDining,T2,4,round,Window,\d+,\d+,80,80,0,\r\n/);
  const back = incomingFromCsv(readPlanCsv(exported, parseCsv).rows, {});
  const round = mgr('venue.importPreview', { incoming: back, positions: 'replace' });
  assert.deepEqual([round.counts.create, round.counts.update, round.counts.same], [0, 0, 4], 'positions and sizes are the same too');
});

test('CSV export: one row per seat-holding item, by table number, never a formula', () => {
  const csv = planCsv([{ name: 'Bar room', plan: { zones: [{ id: 'z', name: 'Rail' }], items: [
    t('2', 'table-round', 300, 100, '=HYPERLINK("x")', 2), t('1', 'table-square', 100, 100, 'T1', 4, { zone: 'z', toastGuid: 'g-1' }),
    { id: 'w', type: 'wall', x: 0, y: 0, w: 100, h: 10, r: 0, label: 'Wall' }, { id: 'b', type: 'bar', x: 0, y: 400, w: 300, h: 50, r: 90, label: 'Bar', seats: 8 },
  ] } }]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4, 'walls aren’t tables');
  assert.equal(lines[1], 'Bar room,"\'=HYPERLINK(""x"")",2,round,,300,100,70,70,0,');
  assert.equal(lines[2], 'Bar room,Bar,8,bar,,0,400,300,50,90,');
  assert.equal(lines[3], 'Bar room,T1,4,square,Rail,100,100,70,70,0,g-1');
});

// ---------- duplicate detection ----------

test('duplicates: same number in the same room updates; several, repeated or linked elsewhere asks; skip by default', () => {
  const rooms = [
    { id: 'r1', name: 'Dining', plan: { width: 1000, height: 700, items: [t('a', 'table-square', 0, 0, 'T1'), t('b', 'table-square', 100, 0, '5'), t('c', 'table-round', 200, 0, 'Table 5'), t('d', 'table-square', 300, 0, 'T7', 4, { toastGuid: 'g-7' })] } },
    { id: 'r2', name: 'Patio', plan: { width: 1000, height: 700, items: [t('p', 'table-square', 0, 0, 'T1')] } },
  ];
  const incoming = { source: 'csv', rooms: [{ key: 'k', name: 'Dining', items: [
    { key: '1', label: 'Table 1', seats: 6, type: null }, // T1 here (not Patio's T1): update seats
    { key: '2', label: 'T5', seats: 2, type: null }, // two 5s here: ambiguous
    { key: '3', label: '9', seats: 4, type: 'table-round' }, // new
    { key: '4', label: '9', seats: 2, type: null }, // 9 twice in the file: ambiguous
    { key: '5', label: '7', seats: 4, type: null, toastGuid: 'g-other' }, // T7 is another Toast table: ambiguous
  ] }] };
  const p = planImport(rooms, incoming, { uid: (x) => `${x}_new` });
  const by = Object.fromEntries(p.rooms[0].items.map((i) => [i.key, i]));
  assert.deepEqual([by[1].action, by[1].itemId, by[1].changes], ['update', 'a', { seats: 6 }]);
  assert.deepEqual([by[2].action, by[2].reason, by[2].candidates.map((c) => c.id), by[2].outcome], ['ambiguous', 'several', ['b', 'c'], 'skip']);
  assert.equal(by[3].action, 'create');
  assert.deepEqual([by[4].action, by[4].reason, by[4].outcome], ['ambiguous', 'repeated', 'skip']);
  assert.deepEqual([by[5].action, by[5].reason], ['ambiguous', 'linkedElsewhere']);
  assert.deepEqual(p.counts, { create: 1, update: 1, same: 0, ambiguous: 3, skip: 3, rooms: 1, newRooms: 0 });
  assert.equal(p.rooms[0].plan.items.length, 5, 'only the new 9 was added');
  assert.equal(rooms[0].plan.items.length, 4, 'the venue’s own data is never changed by planning');

  // The manager decides: update the round 5, add the second 9, relink T7.
  const decided = planImport(rooms, incoming, { decisions: { 'k|2': 'update:c', 'k|4': 'create', 'k|5': 'update:d', 'k|9': 'create' } });
  const d = Object.fromEntries(decided.rooms[0].items.map((i) => [i.key, i]));
  assert.deepEqual([d[2].outcome, d[2].changes], ['update', { seats: 2 }], '“Table 5” is T5 already: its name stays');
  assert.equal(d[4].outcome, 'create');
  assert.deepEqual([d[5].outcome, d[5].changes], ['update', { toastGuid: 'g-other' }]);
  assert.equal(decided.rooms[0].plan.items.filter((i) => labelKey(i.label) === '9').length, 2, 'two 9s only because the manager said so');
  const bad = planImport(rooms, incoming, { decisions: { 'k|2': 'update:p' } }); // Patio's table isn't a candidate
  assert.equal(bad.rooms[0].items[1].outcome, 'skip');
});

// ---------- the AI's reading ----------

test('reading the AI’s answer: fences, kinds and shapes, the room’s walls as the plan, nonsense dropped', () => {
  const answer = '```json\n' + JSON.stringify({
    room: { x: 100, y: 100, w: 800, h: 800 },
    items: [
      { kind: 'table', shape: 'round', label: '12', seats: 4, x: 200, y: 200, w: 80, h: 80, rotation: 0 },
      { kind: 'table', shape: 'rectangle', label: '14', seats: null, x: 400, y: 200, w: 160, h: 80, rotation: 40 },
      { kind: 'bar', label: 'Bar', seats: 10, x: 150, y: 820, w: 600, h: 60 },
      { kind: 'wall', x: 100, y: 100, w: 800, h: 30 },
      { kind: 'restroom', label: 'WC', x: 800, y: 800, w: 80, h: 80 },
      { kind: 'sofa', x: 1, y: 1, w: 1, h: 1 },
      { kind: 'table', shape: 'square', x: 5000, y: 5000, w: 10, h: 10 },
      { kind: 'table', x: 'left' },
    ],
    notes: 'Two tables were hard to read.',
  }) + '\n```';
  const read = readAiPlan(answer, { imageWidth: 1600, imageHeight: 1200 });
  assert.equal(read.width, 1000);
  assert.equal(read.height, 750, 'the picture’s proportions');
  assert.deepEqual(read.items.map((i) => i.type), ['table-round', 'table-rect', 'bar', 'wall', 'restroom']);
  assert.deepEqual([read.items[0].x, read.items[0].y, read.items[0].w], [125, 94, 100], 'inside the room’s walls');
  assert.equal(read.items[1].r, 45, 'rotation in 45° steps');
  assert.equal(read.items[1].seats, null, 'unknown seats stay unknown');
  assert.equal(read.items[3].h, 10, 'a wall is a line');
  assert.equal(read.items[4].seats, 0);
  assert.equal(read.notes, 'Two tables were hard to read.');
  assert.equal(readAiPlan('Sorry, I can’t see a floor plan.'), null);
  assert.deepEqual(jsonIn('Here you go: {"items": []} hope it helps'), { items: [] });
});

// ---------- over HTTP: Toast, the AI, permissions ----------

const TOAST_HOST = 'https://toast.floor.test';
const GUID = '11111111-2222-3333-4444-555555555555';
const TOAST_ENV = { TOAST_CLIENT_ID: 'floor-client', TOAST_CLIENT_SECRET: 'floor-test-secret', TOAST_RESTAURANT_GUID: GUID, TOAST_API_HOST: TOAST_HOST };

/** Toast's configuration API with a restaurant's tables (paged like Toast: Toast-Next-Page-Token). */
function fakeToastConfig() {
  const state = {
    serviceAreas: [
      { guid: 'sa-main', entityType: 'ServiceArea', name: 'Main Dining', revenueCenter: { guid: 'rc-din' }, serviceAreaType: 'ON_PREMISES' },
      { guid: 'sa-bar', entityType: 'ServiceArea', name: 'Bar Area', revenueCenter: { guid: 'rc-bar' }, serviceAreaType: 'ON_PREMISES' },
      { guid: 'sa-togo', entityType: 'ServiceArea', name: 'Takeout', serviceAreaType: 'OFF_PREMISES' },
    ],
    revenueCenters: [{ guid: 'rc-din', name: 'Dining' }, { guid: 'rc-bar', name: 'Bar' }],
    tables: [
      ...Array.from({ length: 6 }, (_, i) => ({ guid: `tb-${i + 1}`, entityType: 'Table', name: String(i + 1), serviceArea: { guid: 'sa-main' }, revenueCenter: { guid: 'rc-din' } })),
      { guid: 'tb-b1', entityType: 'Table', name: 'B1', serviceArea: { guid: 'sa-bar' } },
      { guid: 'tb-b2', entityType: 'Table', name: 'B2', serviceArea: { guid: 'sa-bar' } },
      { guid: null, entityType: 'Table', name: null, serviceArea: null }, // seen from Toast's API: skipped
    ],
  };
  const log = { calls: [] };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    log.calls.push(u.pathname + u.search);
    if (u.pathname === '/authentication/v1/authentication/login') return json(200, { token: { accessToken: 'tok', expiresIn: 86400 } });
    if (init.headers?.Authorization !== 'Bearer tok' || init.headers?.['Toast-Restaurant-External-ID'] !== GUID) return json(401, {});
    if (init.method && init.method !== 'GET') return json(405, { message: 'read only' });
    const paged = (rows) => {
      const page = Number(u.searchParams.get('pageToken') || 0);
      const size = 4;
      return json(200, rows.slice(page * size, page * size + size), (page + 1) * size < rows.length ? { 'Toast-Next-Page-Token': String(page + 1) } : {});
    };
    if (u.pathname === '/config/v2/tables') return paged(state.tables);
    if (u.pathname === '/config/v2/serviceAreas') return paged(state.serviceAreas);
    if (u.pathname === '/config/v2/revenueCenters') return paged(state.revenueCenters);
    return json(404, { message: 'nope' });
  };
  return { state, fetch, log };
}

let A, B, toast, realFetch;
const fake = fakeAnthropic();
before(async () => {
  toast = fakeToastConfig();
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith(TOAST_HOST) ? toast.fetch(url, init) : realFetch(url, init));
  _tokenCache.clear();
  A = await startApp({ env: { ...TOAST_ENV, ANTHROPIC_API_KEY: 'sk-ant-test-floor-placeholder' }, aiClient: fake.factory });
  B = await startApp({ env: {} }); // no Toast, no AI key
});
after(async () => { globalThis.fetch = realFetch; _tokenCache.clear(); await A?.close(); await B?.close(); });

async function browser(app, email) {
  const c = jsonClient(app.base, realFetch);
  const r = await signIn(c.post, email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const get = async (path) => { const res = await realFetch(app.base + path, { headers: { Cookie: c.cookie() } }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const rpc = async (m, args = {}) => c.post(`/api/rpc/${m}`, args);
  return { ...c, get, rpc };
}

test('Toast: imports tables by service area, again and again without duplicates, keeping what the manager drew', async () => {
  const moe = await browser(A, 'moe@demo.shiftboard');
  const staff = await browser(A, 'styves@demo.shiftboard');
  assert.equal((await staff.get('/api/venue/import/status')).status, 403);
  assert.equal((await staff.post('/api/venue/import/toast', {})).status, 403);
  const st = await moe.get('/api/venue/import/status');
  assert.deepEqual(st.body.result, { toast: { available: true }, ai: { available: true } });

  const read = await moe.post('/api/venue/import/toast', {});
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const data = read.body.result.toast;
  assert.equal(data.tables.length, 8, 'every page, entries without a GUID skipped');
  assert.ok(toast.log.calls.some((c) => c.includes('pageToken=1')), 'followed Toast-Next-Page-Token');

  const incoming = incomingFromToast(data, { mode: 'rooms' });
  assert.deepEqual(incoming.rooms.map((r) => r.name), ['Main Dining', 'Bar Area'], 'takeout isn’t a room');
  const first = await moe.rpc('venue.importApply', { incoming });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.result.counts.create, first.body.result.counts.newRooms], [8, 2]);
  await A.db.sync();
  const main = A.db.store.list('rooms').find((r) => r.name === 'Main Dining');
  assert.deepEqual(main.toast, { serviceAreaGuid: 'sa-main', revenueCenterGuid: 'rc-din', revenueCenterName: 'Dining' });
  assert.deepEqual(main.plan.items.map((i) => [i.label, i.toastGuid, i.type, i.seats]).slice(0, 2), [['1', 'tb-1', 'table-square', 4], ['2', 'tb-2', 'table-square', 4]]);
  assert.equal(planWarnings(main.plan).length, 0, 'on a grid, no overlaps');
  assert.equal(main.plan.height, 300, 'a new room is as deep as its tables need');

  // The manager reshapes and moves table 1, and someone renames table 2 in Toast.
  const plan = structuredClone(main.plan);
  Object.assign(plan.items[0], { x: 600, y: 150, type: 'table-round', w: 100, h: 100, seats: 6 });
  assert.equal((await moe.rpc('venue.savePlan', { roomId: main.id, plan })).status, 200);
  toast.state.tables[1].name = '2A';
  toast.state.tables.push({ guid: 'tb-7', entityType: 'Table', name: '7', serviceArea: { guid: 'sa-main' } });
  toast.state.tables = toast.state.tables.filter((x) => x.guid !== 'tb-6');

  const again = incomingFromToast((await moe.post('/api/venue/import/toast', {})).body.result.toast, { mode: 'rooms' });
  const preview = (await moe.rpc('venue.importPreview', { incoming: again })).body.result;
  assert.deepEqual([preview.counts.create, preview.counts.update, preview.counts.same, preview.counts.newRooms], [1, 1, 6, 0]);
  const mainPreview = preview.rooms.find((r) => r.name === 'Main Dining');
  assert.deepEqual(mainPreview.items.find((i) => i.key === 't:tb-2').changes, { label: '2A' });
  assert.deepEqual(mainPreview.missing.map((m) => m.label), ['6'], 'gone from Toast: listed, not deleted');
  await moe.rpc('venue.importApply', { incoming: again });
  await A.db.sync();
  const after = A.db.store.get('rooms', main.id).plan;
  const one = after.items.find((i) => i.toastGuid === 'tb-1');
  assert.deepEqual([one.x, one.y, one.type, one.seats], [600, 150, 'table-round', 6], 'what the manager drew is kept');
  assert.equal(after.items.find((i) => i.toastGuid === 'tb-2').label, '2A');
  assert.ok(after.items.find((i) => i.toastGuid === 'tb-6'), 'never deleted');
  assert.equal(after.items.filter((i) => i.toastGuid).length, 7, 'one new table, no duplicates');
  assert.equal(A.db.store.list('rooms', (r) => r.name === 'Main Dining').length, 1, 'no duplicate rooms either');

  // Service areas as sections of one room: the same tables (by GUID) stay where they are; a new room gets them all.
  const zones = incomingFromToast(data, { mode: 'zones', roomName: 'Whole floor' });
  const zp = (await moe.rpc('venue.importPreview', { incoming: zones })).body.result;
  assert.equal(zp.counts.create, 0, 'linked tables are found wherever they are');
  const audit = A.db.store.list('auditLog', (a) => a.action === 'venue.imported' && a.details.source === 'toast');
  assert.equal(audit.length, 2);
  assert.ok(A.db.store.list('auditLog', (a) => a.action === 'venue.importRead' && a.details.source === 'toast').length >= 2);
  assert.ok(!toast.log.calls.some((c) => /POST|PUT/.test(c)), 'nothing is ever written to Toast');
});

test('Toast as sections of one room: each service area is a colored section', () => {
  const data = { serviceAreas: [{ guid: 's1', name: 'Section 1' }, { guid: 's2', name: 'Section 2' }], tables: [
    { guid: 'a', name: '10', serviceArea: { guid: 's1' } }, { guid: 'b', name: '11', serviceArea: { guid: 's1' } }, { guid: 'c', name: '20', serviceArea: { guid: 's2' } }, { guid: 'd', name: '30' },
  ] };
  const { mgr, store } = fresh();
  const room = mgr('venue.saveRoom', { name: 'Dining' });
  mgr('venue.importApply', { incoming: incomingFromToast(data, { mode: 'zones', roomId: room.id, otherName: 'Other' }) });
  const plan = store.get('rooms', room.id).plan;
  assert.deepEqual(plan.zones.map((z) => z.name), ['Section 1', 'Section 2', 'Other']);
  const zoneOf = (label) => plan.zones.find((z) => z.id === plan.items.find((i) => i.label === label).zone).name;
  assert.deepEqual(['10', '11', '20', '30'].map(zoneOf), ['Section 1', 'Section 1', 'Section 2', 'Other']);
  assert.equal(planWarnings(plan).length, 0);
  assert.throws(() => mgr('venue.importApply', { incoming: incomingFromToast(data, { mode: 'zones' }) }), /Pick a room for these tables/);
});

test('a picture: the AI reads it, the manager adjusts, Apply saves; without AI it says so', async () => {
  const moe = await browser(A, 'moe@demo.shiftboard');
  const staff = await browser(A, 'styves@demo.shiftboard');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64'); // a few bytes are enough: the AI is a fake
  assert.equal((await staff.post('/api/venue/import/image', { image: png, mediaType: 'image/png' })).status, 403);
  assert.equal((await moe.post('/api/venue/import/image', { image: png, mediaType: 'text/html' })).status, 400);

  fake.clear();
  fake.reply(text(JSON.stringify({ room: null, items: [
    { kind: 'table', shape: 'square', label: '1', seats: 4, x: 100, y: 100, w: 80, h: 100 },
    { kind: 'table', shape: 'round', label: '2', seats: null, x: 300, y: 100, w: 80, h: 100 },
    { kind: 'booth', label: '3', seats: 4, x: 500, y: 100, w: 150, h: 100 },
    { kind: 'host', label: 'Host', x: 50, y: 900, w: 100, h: 60 },
  ], notes: '' })));
  const r = await moe.post('/api/venue/import/image', { image: png, mediaType: 'image/png', width: 1000, height: 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.available, true);
  const sent = fake.calls[0].params;
  assert.equal(sent.messages[0].content[0].type, 'image');
  assert.deepEqual(sent.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: png });
  assert.match(sent.system[0].text, /JSON/);
  const read = r.body.result.read;
  assert.equal(read.items.length, 4);
  assert.equal(read.height, 1000);

  // The manager fixes table 2's seats in the preview, and drops the host stand.
  read.items[1].seats = 2;
  read.items.pop();
  const incoming = incomingFromImage(read, { roomName: 'Upstairs' });
  const applied = await moe.rpc('venue.importApply', { incoming, fileName: 'upstairs.png' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  await A.db.sync();
  const up = A.db.store.list('rooms').find((r) => r.name === 'Upstairs');
  assert.deepEqual(up.plan.items.map((i) => [i.label, i.type, i.seats, i.x, i.y]), [['1', 'table-square', 4, 100, 100], ['2', 'table-round', 2, 300, 100], ['3', 'booth', 4, 500, 100]]);
  assert.ok(A.db.store.list('auditLog', (a) => a.action === 'venue.imported' && a.details.source === 'image' && a.details.fileName === 'upstairs.png').length);
  const ledger = A.db.store.list('auditLog', (a) => a.action === 'venue.importRead' && a.details.source === 'image');
  assert.ok(ledger.length && !JSON.stringify(ledger).includes(png), 'the picture itself is never logged');

  // Not set up: no key → the page says so, and no call is made.
  const other = await browser(B, 'moe@demo.shiftboard');
  const st = await other.get('/api/venue/import/status');
  assert.deepEqual(st.body.result, { toast: { available: false, reason: 'notConnected' }, ai: { available: false, reason: 'no_key' } });
  const before = fake.calls.length;
  const nope = await other.post('/api/venue/import/image', { image: png, mediaType: 'image/png' });
  assert.deepEqual(nope.body.result, { available: false, reason: 'no_key' });
  assert.equal(fake.calls.length, before);
  const noToast = await other.post('/api/venue/import/toast', {});
  assert.equal(noToast.status, 400);
  assert.match(noToast.body.error, /Toast isn’t connected yet/);
});

test('permissions: managers and admins import and edit; staff view; the plan’s venue feature gates the routes', async () => {
  const staff = await browser(A, 'styves@demo.shiftboard');
  const v = await staff.rpc('venue.get');
  assert.equal(v.status, 200);
  assert.ok(v.body.result.rooms.some((r) => r.plan.items.length), 'staff see floor plans');
  const room = v.body.result.rooms[0];
  assert.equal((await staff.rpc('venue.savePlan', { roomId: room.id, plan: room.plan })).status, 403);
  assert.equal((await staff.rpc('venue.importApply', { incoming: { source: 'csv', rooms: [{ name: 'X', items: [{ label: '1' }] }] } })).status, 403);
  const { svc, store } = fresh();
  const admin = store.insert('users', { id: 'usr_a', name: 'Admin One', role: 'admin', email: 'a@test.local', active: true, jobCodes: [], availability: {} });
  const out = svc.call(admin, 'venue.importApply', { incoming: { source: 'csv', rooms: [{ name: 'Bar', items: [{ label: '1', seats: 2 }] }] } });
  assert.equal(out.counts.create, 1);
  assert.throws(() => svc.call(admin, 'venue.importApply', { incoming: { source: 'fax', rooms: [] } }), /Pick what to import/);
  assert.throws(() => svc.call(admin, 'venue.importApply', { incoming: { source: 'csv', rooms: [] } }), /nothing to import/);
});
