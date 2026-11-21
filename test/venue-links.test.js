// Rooms linked to events and shifts: event rooms by id, and server sections (core/venue-links.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';

const DAY = '2026-11-27';

// A restaurant with a venue: Main (tables T1–T4, booth B1, a bar and a plant) and the Library (L1).
function venue() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Corner Bistro', rooms: ['Main', 'Library', 'Full Buyout'] });
  const person = (id, role, extra = {}) => store.insert('users', { id, name: id.slice(4), role, jobCodes: [{ jobCodeId: 'job_srv' }], active: true, ...extra });
  person('usr_mgr', 'manager');
  person('usr_emp', 'employee');
  person('usr_two', 'employee');
  person('usr_sup', 'supervisor');
  person('usr_ev', 'employee', { eventsAccess: true });
  store.insert('jobCodes', { id: 'job_srv', name: 'Server', short: 'SRV', order: 0 });
  const svc = createService(store, { now: () => new Date('2026-11-20T10:00:00') });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  const mgr = as('usr_mgr');
  const v = mgr('venue.setup');
  const main = v.rooms.find((r) => r.name === 'Main');
  const library = v.rooms.find((r) => r.name === 'Library');
  mgr('venue.savePlan', {
    roomId: main.id,
    plan: { items: [
      { id: 't1', type: 'table-square', x: 0, y: 0, w: 70, h: 70, label: 'T1', seats: 4 },
      { id: 't2', type: 'table-square', x: 100, y: 0, w: 70, h: 70, label: 'T2', seats: 4 },
      { id: 't3', type: 'table-round', x: 200, y: 0, w: 80, h: 80, label: 'T3', seats: 6 },
      { id: 't4', type: 'table-rect', x: 300, y: 0, w: 140, h: 60, label: 'T4', seats: 6 },
      { id: 'b1', type: 'booth', x: 0, y: 200, w: 140, h: 70, label: 'B1', seats: 4 },
      { id: 'bar', type: 'bar', x: 400, y: 300, w: 300, h: 50, label: 'Bar', seats: 8 },
      { id: 'p1', type: 'plant', x: 900, y: 600, w: 40, h: 40 },
    ] },
  });
  mgr('venue.savePlan', { roomId: library.id, plan: { items: [{ id: 'lt1', type: 'table-rect', x: 0, y: 0, w: 140, h: 60, label: 'L1', seats: 8 }] } });
  const shift = (userId, date = DAY, extra = {}) => mgr('shifts.save', { date, start: '16:00', jobCodeId: 'job_srv', userId, published: true, ...extra }).shift;
  return { store, svc, mgr, emp: as('usr_emp'), sup: as('usr_sup'), ev: as('usr_ev'), main, library, shift };
}
const users = (days) => days.flatMap((d) => d.entries.map((e) => e.userId));
const byUser = (days) => Object.fromEntries(days[0].entries.map((e) => [e.userId, e.tableIds]));

// ---------- events ----------

test('an event picks its room by id; the name stays for display, follows renames and survives deleting the room', () => {
  const { mgr, emp, ev, main, library } = venue();
  const e = mgr('events.save', { name: 'Gala', date: '2026-12-05', start: '18:00', status: 'confirmed', roomId: main.id, room: 'whatever was typed' });
  assert.deepEqual([e.roomId, e.room], [main.id, 'Main']);
  const got = emp('events.get', { id: e.id });
  assert.deepEqual([got.roomId, got.room], [main.id, 'Main']);

  // Full Buyout is a booking, not a room: no link, the name is kept.
  const buyout = ev('events.save', { name: 'Wedding', date: '2026-12-06', roomId: '', room: 'Full Buyout' });
  assert.deepEqual([buyout.roomId, buyout.room], [null, 'Full Buyout']);
  const moved = mgr('events.save', { ...mgr('events.get', { id: e.id }), roomId: '', room: 'Full Buyout' });
  assert.deepEqual([moved.roomId, moved.room], [null, 'Full Buyout'], 'moving to the buyout drops the link');
  assert.equal(mgr('events.save', { ...moved, roomId: main.id }).roomId, main.id);
  // Saving without touching the room keeps the link.
  assert.equal(mgr('events.save', { id: e.id, name: 'Gala dinner', date: '2026-12-05' }).roomId, main.id);

  assert.throws(() => mgr('events.save', { name: 'X', date: '2026-12-05', roomId: 'room_gone' }), /That room is gone/);
  assert.throws(() => emp('events.save', { name: 'X', date: '2026-12-05', roomId: main.id }), /Events team or managers only/);

  mgr('venue.saveRoom', { id: main.id, name: 'Main Dining' });
  assert.equal(mgr('events.get', { id: e.id }).room, 'Main Dining', 'renaming the room renames the event’s room');
  assert.equal(mgr('events.list', { start: '2026-12-01' }).find((x) => x.id === e.id).room, 'Main Dining');
  mgr('venue.deleteRoom', { id: library.id });
  mgr('venue.deleteRoom', { id: main.id });
  const after = mgr('events.get', { id: e.id });
  assert.deepEqual([after.roomId, after.room], [null, 'Main Dining'], 'the name stays when the room is deleted');
});

test('old events with only a room name link to the room with that name, ignoring case', () => {
  const { store, mgr, emp, main, library } = venue();
  const old = (id, room) => store.insert('events', { id, name: id, date: '2026-12-01', start: '18:00', room, status: 'confirmed', staffing: [] });
  old('evt_old', '  library ');
  old('evt_text', 'Patio / RH / LIB');
  old('evt_buyout', 'Full Buyout');

  const got = emp('events.get', { id: 'evt_old' });
  assert.deepEqual([got.roomId, got.room], [library.id, 'Library']);
  const list = Object.fromEntries(emp('events.list', { start: '2026-11-01' }).map((x) => [x.id, x]));
  assert.deepEqual([list.evt_old.roomId, list.evt_old.room], [library.id, 'Library']);
  assert.deepEqual([list.evt_text.roomId, list.evt_text.room], [null, 'Patio / RH / LIB'], 'free text that isn’t a room stays as it is');
  assert.deepEqual([list.evt_buyout.roomId, list.evt_buyout.room], [null, 'Full Buyout']);
  assert.equal(store.get('events', 'evt_old').roomId, undefined, 'reading never writes');

  // Saving with only a name (an old event, an older app, the importer) stores the link.
  const saved = mgr('events.save', { id: 'evt_text', name: 'Bottle service', date: '2026-12-01', room: 'MAIN' });
  assert.deepEqual([saved.roomId, saved.room], [main.id, 'Main']);
  assert.equal(store.get('events', 'evt_text').roomId, main.id);

  // Renaming a room carries along old events that only had its name.
  mgr('venue.saveRoom', { id: library.id, name: 'Reading Room' });
  assert.deepEqual([store.get('events', 'evt_old').roomId, store.get('events', 'evt_old').room], [library.id, 'Reading Room']);
});

// ---------- sections ----------

test('sections: managers and up assign rooms and tables; supervisors and staff only read', () => {
  const { mgr, emp, sup, ev, main, shift } = venue();
  const s = shift('usr_emp');
  for (const who of [emp, sup, ev]) {
    assert.throws(() => who('sections.assign', { shiftId: s.id, roomId: main.id, tableIds: ['t1'] }), /Managers only/);
    assert.throws(() => who('sections.clear', { roomId: main.id, date: DAY, tableIds: ['t1'] }), /Managers only/);
    assert.throws(() => who('sections.copy', { fromDate: DAY, toDate: '2026-12-04' }), /Managers only/);
  }
  const out = mgr('sections.assign', { shiftId: s.id, roomId: main.id, tableIds: ['t1', 't2', 't2'] });
  assert.equal(out[0].roomName, 'Main');
  assert.deepEqual(out[0].entries.map((e) => [e.userId, e.tableIds, e.tables, e.seats]), [['usr_emp', ['t1', 't2'], ['T1', 'T2'], 8]]);
  for (const who of [emp, sup, ev]) assert.deepEqual(byUser(who('sections.list', { start: DAY })), { usr_emp: ['t1', 't2'] });
});

test('sections are validated: real shifts, real rooms, and tables on that room’s plan', () => {
  const { mgr, main, library, shift } = venue();
  const s = shift('usr_emp');
  const assign = (args) => mgr('sections.assign', { shiftId: s.id, roomId: main.id, ...args });
  assert.throws(() => assign({ shiftId: 'shf_nope' }), /Shift not found/);
  assert.throws(() => assign({ roomId: 'room_nope' }), /Room not found/);
  assert.throws(() => assign({ tableIds: ['zz'] }), /isn’t on the Main floor plan/);
  assert.throws(() => assign({ tableIds: ['p1'] }), /isn’t on the Main floor plan/, 'a plant is not a table');
  assert.throws(() => assign({ tableIds: ['lt1'] }), /isn’t on the Main floor plan/, 'another room’s table');
  assert.throws(() => assign({ roomId: '', tableIds: ['t1'] }), /Pick a room/);
  assert.throws(() => mgr('sections.clear', { roomId: main.id, date: 'soon', tableIds: [] }), /Pick a date/);
  assert.throws(() => mgr('sections.clear', { roomId: 'room_nope', date: DAY, tableIds: [] }), /Room not found/);
  assert.throws(() => mgr('sections.list', { start: '2026-11-01', end: '2027-03-01' }), /at most 62 days/);
  assert.throws(() => mgr('sections.list', { start: DAY, end: '2026-11-01' }), /at most 62 days/);
  assert.throws(() => mgr('sections.list', {}), /Pick a date/);
  // Booths and the bar are sections too, and a shift can be in a room with no tables.
  assert.deepEqual(assign({ tableIds: ['b1', 'bar'] })[0].entries[0].tables, ['B1', 'Bar']);
  assert.deepEqual(assign({ roomId: library.id })[0].entries[0].tableIds, []);
});

test('sections: one server per table per room and day, and one room per shift per day', () => {
  const { store, mgr, main, library, shift } = venue();
  const a = shift('usr_emp'), b = shift('usr_two');
  mgr('sections.assign', { shiftId: a.id, roomId: main.id, tableIds: ['t1', 't2', 't3'] });
  let out = mgr('sections.assign', { shiftId: b.id, roomId: main.id, tableIds: ['t3', 't4'] });
  assert.deepEqual(byUser(out), { usr_emp: ['t1', 't2'], usr_two: ['t3', 't4'] }, 'T3 moved over');
  out = mgr('sections.assign', { shiftId: a.id, roomId: main.id, tableIds: ['b1'], mode: 'add' });
  assert.deepEqual(byUser(out).usr_emp, ['t1', 't2', 'b1'], 'add keeps the tables they had');
  out = mgr('sections.clear', { roomId: main.id, date: DAY, tableIds: ['t2', 't3', 't4'] });
  assert.deepEqual(byUser(out), { usr_emp: ['t1', 'b1'], usr_two: [] }, 'cleared tables leave the section; the person stays in the room');

  out = mgr('sections.assign', { shiftId: a.id, roomId: library.id, tableIds: ['lt1'] });
  assert.deepEqual(out.map((d) => [d.roomName, d.entries.map((e) => e.userId)]), [['Main', ['usr_two']], ['Library', ['usr_emp']]], 'moving rooms leaves the first');
  mgr('sections.assign', { shiftId: a.id, roomId: null });
  mgr('sections.assign', { shiftId: b.id, roomId: '' });
  assert.deepEqual(mgr('sections.list', { start: DAY }), [], 'no room takes them out of every room');
  assert.equal(store.list('sections').length, 0, 'an empty day leaves no document behind');

  const c = shift('usr_emp', '2026-11-28');
  mgr('sections.assign', { shiftId: a.id, roomId: main.id, tableIds: ['t1'] });
  mgr('sections.assign', { shiftId: c.id, roomId: main.id, tableIds: ['t1'] });
  assert.deepEqual(mgr('sections.list', { start: DAY, end: '2026-11-28' }).map((d) => [d.date, d.entries[0].tableIds]), [[DAY, ['t1']], ['2026-11-28', ['t1']]], 'each day is separate');
});

test('what staff can read: sections of published shifts only, and nothing stale', () => {
  const { store, mgr, emp, sup, main, shift } = venue();
  const mine = shift('usr_emp');
  const draft = shift('usr_two', DAY, { published: false });
  const open = shift(null);
  mgr('sections.assign', { shiftId: mine.id, roomId: main.id, tableIds: ['t1', 't2'] });
  mgr('sections.assign', { shiftId: draft.id, roomId: main.id, tableIds: ['t3'] });
  mgr('sections.assign', { shiftId: open.id, roomId: main.id, tableIds: ['t4'] });

  assert.deepEqual(users(mgr('sections.list', { start: DAY })), ['usr_emp', 'usr_two', null], 'managers see drafts');
  assert.deepEqual(users(emp('sections.list', { start: DAY })), ['usr_emp', null], 'staff never see a draft shift’s section');
  assert.deepEqual(users(sup('sections.list', { start: DAY })), ['usr_emp', null]);
  assert.deepEqual(Object.keys(emp('sections.list', { start: DAY })[0].entries[0]).sort(),
    ['end', 'eventId', 'jobCodeId', 'published', 'seats', 'shiftId', 'start', 'tableIds', 'tables', 'userId'], 'schedule facts only');

  mgr('shifts.publish', { start: DAY, end: DAY });
  assert.deepEqual(users(emp('sections.list', { start: DAY })), ['usr_emp', 'usr_two', null], 'published: now staff see it');
  store.update('shifts', mine.id, { userId: 'usr_sup' }); // e.g. an approved trade
  assert.deepEqual(users(emp('sections.list', { start: DAY })), ['usr_sup', 'usr_two', null], 'the section goes with the shift');

  mgr('shifts.delete', { id: draft.id });
  mgr('shifts.save', { ...store.get('shifts', open.id), date: '2026-11-30' });
  mgr('venue.savePlan', { roomId: main.id, plan: { items: store.get('rooms', main.id).plan.items.filter((i) => i.id !== 't2') } });
  assert.deepEqual(emp('sections.list', { start: DAY })[0].entries.map((e) => [e.userId, e.tableIds]), [['usr_sup', ['t1']]],
    'deleted and moved shifts, and tables taken off the plan, drop out');
  assert.deepEqual(emp('sections.list', { start: '2026-11-30' }), [], 'a moved shift doesn’t take its old section along');
  mgr('venue.deleteRoom', { id: main.id });
  assert.deepEqual(emp('sections.list', { start: DAY }), []);
  assert.equal(store.list('sections').length, 0, 'deleting the room deletes its sections');
});

test('sections can be copied from another day to the same people', () => {
  const { mgr, main, shift } = venue();
  const a = shift('usr_emp'), b = shift('usr_two');
  mgr('sections.assign', { shiftId: a.id, roomId: main.id, tableIds: ['t1', 't2'] });
  mgr('sections.assign', { shiftId: b.id, roomId: main.id, tableIds: ['t3'] });
  const a2 = shift('usr_emp', '2026-12-04');
  assert.deepEqual(mgr('sections.copy', { fromDate: DAY, toDate: '2026-12-04' }), { copied: 1, skipped: 1 }, 'usr_two isn’t working the 4th');
  assert.deepEqual(mgr('sections.list', { start: '2026-12-04' })[0].entries.map((e) => [e.shiftId, e.tableIds]), [[a2.id, ['t1', 't2']]]);
  assert.deepEqual(mgr('sections.copy', { fromDate: DAY, toDate: '2026-12-04' }), { copied: 0, skipped: 2 }, 'a day that has sections is left alone');
  assert.deepEqual(mgr('sections.copy', { fromDate: DAY, toDate: '2026-12-04', replace: true }), { copied: 1, skipped: 1 });
  assert.throws(() => mgr('sections.copy', { fromDate: DAY, toDate: DAY }), /different day/);
});

test('the demo has sections for Friday and a BEO with its staff’s tables', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store);
  const alex = store.get('users', ids.userId['Alex D']);
  const fri = svc.call(alex, 'sections.list', { start: '2026-10-02' });
  const restaurant = fri.find((d) => d.roomName === 'Restaurant');
  assert.ok(restaurant.entries.length >= 4);
  assert.ok(restaurant.entries.find((e) => e.userId === alex.id).tables.length >= 3, 'Alex D has a section on Friday');
  const aspen = svc.call(alex, 'events.get', { id: ids.eventId.aspen });
  assert.equal(aspen.roomId, 'room_moonrabbit');
  const tue = svc.call(alex, 'sections.list', { start: aspen.date, roomId: 'room_moonrabbit' });
  assert.ok(tue[0].entries.some((e) => e.eventId === aspen.id), 'event staff have sections in the event’s room');
});
