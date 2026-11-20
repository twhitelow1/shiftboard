import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';

// A brand-new restaurant: settings, one manager, one employee, no venue yet.
function fresh(rooms = DEFAULT_SETTINGS.rooms) {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Corner Bistro', rooms });
  store.insert('users', { id: 'usr_mgr', name: 'Mgr', role: 'manager', jobCodes: [], active: true });
  store.insert('users', { id: 'usr_emp', name: 'Emp', role: 'employee', jobCodes: [], active: true });
  const svc = createService(store, { now: () => new Date('2026-11-20T10:00:00') });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  return { store, svc, mgr: as('usr_mgr'), emp: as('usr_emp'), roomsSetting: () => svc.settings().rooms };
}

test('a fresh restaurant has no venue until someone sets one up', () => {
  const { emp } = fresh();
  const v = emp('venue.get');
  assert.deepEqual([v.locations.length, v.rooms.length], [0, 0]);
  assert.ok(v.itemTypes.includes('table-round') && v.kinds.includes('bar'));
});

test('one-click setup builds a location and rooms from the room list', () => {
  const { mgr, emp, roomsSetting } = fresh(['Restaurant', 'Library', 'Rabbit Hole', 'Moon Rabbit', 'Patio', 'Full Buyout', 'Wine Bar']);
  assert.throws(() => emp('venue.setup'), /Managers only/);
  const v = mgr('venue.setup');
  assert.equal(v.locations.length, 1);
  assert.equal(v.locations[0].name, 'Corner Bistro');
  assert.deepEqual(v.rooms.map((r) => r.name), ['Restaurant', 'Library', 'Rabbit Hole', 'Moon Rabbit', 'Patio', 'Wine Bar'], 'Full Buyout is a booking, not a room');
  assert.deepEqual(v.rooms.find((r) => r.name === 'Rabbit Hole').kinds, ['bar']);
  assert.deepEqual(v.rooms.find((r) => r.name === 'Wine Bar').kinds, ['bar']);
  assert.deepEqual(v.rooms.find((r) => r.name === 'Library').kinds, ['dining']);
  assert.ok(v.rooms.every((r) => r.level === 'Main floor' && r.plan.width === 1000 && r.plan.items.length === 0));
  assert.deepEqual(roomsSetting(), ['Restaurant', 'Library', 'Rabbit Hole', 'Moon Rabbit', 'Patio', 'Wine Bar', 'Full Buyout']);
  assert.throws(() => mgr('venue.setup'), /already set up/);
});

test('a one-room place: adding a room creates the location for you, and the room list stays in sync', () => {
  const { mgr, emp, roomsSetting } = fresh(['Full Buyout']);
  assert.throws(() => emp('venue.saveRoom', { name: 'Dining room' }), /Managers only/);
  const room = mgr('venue.saveRoom', { name: '  Dining   room ', capacity: '48', kinds: ['dining', 'bar', 'nope'] });
  assert.equal(room.name, 'Dining room');
  assert.deepEqual(room.kinds, ['dining', 'bar']);
  assert.equal(room.capacity, 48);
  assert.equal(room.level, 'Main floor');
  const v = emp('venue.get');
  assert.equal(v.locations.length, 1, 'default location created');
  assert.equal(v.locations[0].name, 'Corner Bistro');
  assert.deepEqual(roomsSetting(), ['Dining room', 'Full Buyout']);

  mgr('venue.saveRoom', { id: room.id, name: 'Main Room' });
  assert.deepEqual(roomsSetting(), ['Main Room', 'Full Buyout'], 'renames flow through to events and the importer');
  assert.throws(() => mgr('venue.saveRoom', { name: 'main room' }), /already a room called main room/);
  mgr('venue.deleteRoom', { id: room.id });
  assert.deepEqual(roomsSetting(), ['Full Buyout']);
});

test('multiple locations: rooms belong to one, and a location with rooms cannot be deleted', () => {
  const { mgr, emp } = fresh(['Full Buyout']);
  const a = mgr('venue.saveLocation', { name: 'Downtown', address: '1 Main St' });
  const b = mgr('venue.saveLocation', { name: 'Uptown' });
  assert.throws(() => mgr('venue.saveLocation', { name: '' }), /Location name is required/);
  assert.throws(() => emp('venue.saveLocation', { name: 'X' }), /Managers only/);
  const patioA = mgr('venue.saveRoom', { name: 'Patio', locationId: a.id });
  const patioB = mgr('venue.saveRoom', { name: 'Patio', locationId: b.id, level: 'Rooftop' }); // same name, other location is fine
  assert.equal(patioB.level, 'Rooftop');
  assert.throws(() => mgr('venue.saveRoom', { name: 'Bar', locationId: 'loc_nope' }), /Location not found/);
  assert.throws(() => mgr('venue.deleteLocation', { id: a.id }), /Move or delete its 1 room first/);
  mgr('venue.deleteRoom', { id: patioA.id });
  assert.deepEqual(mgr('venue.deleteLocation', { id: a.id }), { ok: true });
  assert.deepEqual(emp('venue.get').locations.map((l) => l.name), ['Uptown']);
});

test('levels can be renamed and rooms reordered', () => {
  const { mgr, emp } = fresh(['Full Buyout']);
  const r1 = mgr('venue.saveRoom', { name: 'One', level: 'Basement' });
  const r2 = mgr('venue.saveRoom', { name: 'Two', level: 'Basement' });
  const r3 = mgr('venue.saveRoom', { name: 'Three', level: 'Ground' });
  assert.deepEqual(mgr('venue.renameLevel', { locationId: r1.locationId, from: 'Basement', to: 'Lower level' }), { renamed: 2 });
  assert.throws(() => mgr('venue.renameLevel', { locationId: r1.locationId, from: 'Ground', to: ' ' }), /Level name is required/);
  const v = mgr('venue.reorderRooms', { ids: [r3.id, r2.id, r1.id] });
  assert.deepEqual(v.rooms.map((r) => [r.name, r.level]), [['Three', 'Ground'], ['Two', 'Lower level'], ['One', 'Lower level']]);
  assert.deepEqual(emp('venue.get').rooms.map((r) => r.name), ['Three', 'Two', 'One']);
});

test('floor plans are validated and clamped on save', () => {
  const { mgr, emp } = fresh(['Full Buyout']);
  const room = mgr('venue.saveRoom', { name: 'Main' });
  const saved = mgr('venue.savePlan', {
    roomId: room.id,
    plan: {
      width: 800, height: 99999,
      items: [
        { id: 't1', type: 'table-round', x: 790, y: -50, w: 80, h: 80, r: -30, label: 'T1', seats: 99 },
        { id: 't1', type: 'stage', x: 10, y: 10, w: 0, h: 'abc', seats: 6, label: 'x'.repeat(80) },
        { type: 'bar', x: '20', y: '30', w: 300, h: 50, seats: '8', r: 725 },
      ],
    },
  });
  const [t, s, b] = saved.plan.items;
  assert.deepEqual([saved.plan.width, saved.plan.height], [800, 5000]);
  assert.deepEqual([t.x, t.y, t.r, t.seats], [720, 0, 330, 40], 'kept inside the plan, rotation normalized, seats capped');
  assert.notEqual(s.id, 't1', 'duplicate ids get a fresh one');
  assert.deepEqual([s.w, s.h, s.seats, s.label.length], [4, 60, 0, 40], 'min size, default size, stages have no seats, label capped');
  assert.deepEqual([b.x, b.y, b.r, b.seats], [20, 30, 5, 8]);
  assert.ok(b.id);
  assert.equal(emp('venue.get').rooms[0].plan.items.length, 3, 'everyone can see floor plans');

  assert.throws(() => emp('venue.savePlan', { roomId: room.id, plan: { items: [] } }), /Managers only/);
  assert.throws(() => mgr('venue.savePlan', { roomId: room.id, plan: { items: [{ type: 'hot-tub', x: 0, y: 0, w: 10, h: 10 }] } }), /Unknown floor plan item "hot-tub"/);
  assert.throws(() => mgr('venue.savePlan', { roomId: room.id, plan: { items: Array.from({ length: 501 }, () => ({ type: 'plant', x: 0, y: 0, w: 10, h: 10 })) } }), /at most 500/);
  assert.throws(() => mgr('venue.savePlan', { roomId: 'room_nope', plan: { items: [] } }), /Room not found/);
});

test('the demo restaurant comes with a venue and floor plans', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store);
  const v = svc.call(store.get('users', ids.userId['Alex D']), 'venue.get');
  assert.equal(v.locations.length, 1);
  assert.deepEqual([...new Set(v.rooms.map((r) => r.level))], ['Main floor', 'Lower level', 'Upstairs']);
  const restaurant = v.rooms.find((r) => r.name === 'Restaurant');
  assert.ok(restaurant.plan.items.filter((i) => i.seats).reduce((t, i) => t + i.seats, 0) > 50);
  assert.ok(v.rooms.find((r) => r.name === 'Moon Rabbit').plan.items.some((i) => i.type === 'stage'));
  assert.throws(() => svc.call(store.get('users', ids.userId.Moe), 'venue.setup'), /already set up/);
});
