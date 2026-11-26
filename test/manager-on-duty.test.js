// All the managers on duty today (core/training.js mod.get → managers): who's on now first (the one in charge at
// the top), then later today, then earlier; another day by start time; and the call-out line when nobody's on.
// The printed schedule's M.O.D. block uses the same rule (core/mod.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { isModShift, isManagerJob } from '../core/mod.js';
import { sheetModel } from '../core/schedule-pdf.js';

const DAY = '2026-12-04'; // a Friday

function fixture() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Bistro' });
  const job = (id, name, department, defaultRole = 'employee') => store.insert('jobCodes', { id, name, department, defaultRole, order: 0, archived: false });
  job('job_mgr', 'Manager', 'Leadership', 'manager');
  job('job_kmgr', 'Kitchen Manager', 'Kitchen', 'manager');
  job('job_srv', 'Server', 'Restaurant');
  const user = (id, name, role, jobId, phone = '') => store.insert('users', { id, name, role, active: true, phone, availability: {}, jobCodes: [{ jobCodeId: jobId }] });
  user('open', 'Opal Morning', 'manager', 'job_mgr', '(555) 020-0001'); // 9–15: earlier
  user('mid', 'Milo Center', 'manager', 'job_mgr', '(555) 020-0002'); // 12–20: on now
  user('kit', 'Kit Range', 'employee', 'job_kmgr', '(555) 020-0003'); // a manager position: 13–22, on now
  user('close', 'Cleo Night', 'manager', 'job_mgr', '(555) 020-0004'); // 17–close: later
  user('floor', 'Finn Floor', 'manager', 'job_srv', '(555) 020-0005'); // a manager working a server shift: 19–23, later
  user('srv', 'Sam Plate', 'employee', 'job_srv', '(555) 020-0009'); // staff: never on the list
  const shift = (userId, jobCodeId, start, end, published = true) => store.insert('shifts', { date: DAY, start, end, jobCodeId, userId, area: '', published });
  shift('open', 'job_mgr', '09:00', '15:00');
  shift('mid', 'job_mgr', '12:00', '20:00');
  shift('kit', 'job_kmgr', '13:00', '22:00');
  shift('close', 'job_mgr', '17:00', null);
  shift('floor', 'job_srv', '19:00', '23:00');
  shift('srv', 'job_srv', '11:00', '19:00');
  const clock = { now: new Date(2026, 11, 4, 16, 0) };
  const svc = createService(store, { now: () => clock.now });
  return { store, clock, as: (id) => (m, a) => svc.call(store.get('users', id), m, a) };
}

test('every manager on today’s schedule: on now (in charge first), later today, earlier today', () => {
  const f = fixture();
  const r = f.as('srv')('mod.get');
  assert.deepEqual(r.managers.map((m) => [m.name, m.state, m.inCharge]), [
    ['Milo Center', 'now', true], // front of house beats the kitchen
    ['Kit Range', 'now', false],
    ['Cleo Night', 'later', false],
    ['Finn Floor', 'later', false],
    ['Opal Morning', 'earlier', false],
  ]);
  assert.equal(r.person.id, 'mid', 'the card still names the one in charge');
  assert.deepEqual([r.managers[2].shift.start, r.managers[2].shift.estimatedEnd, r.managers[2].shift.jobName], ['17:00', true, 'Manager'], 'until close');
  // Call / Text for everyone on duty; someone who already went home keeps their number from staff.
  assert.deepEqual(r.managers.map((m) => Boolean(m.phone)), [true, true, true, true, false]);
  assert.ok(!JSON.stringify(r).includes('020-0009'), 'staff phones never show');
  assert.equal(f.as('mid')('mod.get').managers.at(-1).phone, '(555) 020-0001', 'managers see it');
  // Later: the closer is in charge, the opener and the mid are earlier (latest finish first).
  f.clock.now = new Date(2026, 11, 4, 21, 0);
  assert.deepEqual(f.as('srv')('mod.get').managers.map((m) => [m.id, m.state]), [['close', 'now'], ['kit', 'now'], ['floor', 'now'], ['mid', 'earlier'], ['open', 'earlier']]);
  // A manager picked by hand comes first, even with no shift that day.
  f.store.insert('users', { id: 'boss', name: 'Bo Picked', role: 'manager', active: true, phone: '(555) 020-0006', jobCodes: [] });
  f.as('mid')('mod.setOverride', { date: DAY, userId: 'boss' });
  const o = f.as('srv')('mod.get');
  assert.deepEqual([o.managers[0].id, o.managers[0].inCharge, o.managers[0].shift], ['boss', true, null]);
});

test('another day (managers looking ahead) lists everyone by start time', () => {
  const f = fixture();
  f.clock.now = new Date(2026, 11, 3, 12, 0);
  const ahead = f.as('mid')('mod.get', { date: DAY });
  assert.deepEqual(ahead.managers.map((m) => [m.id, m.state]), [['open', 'planned'], ['mid', 'planned'], ['kit', 'planned'], ['close', 'planned'], ['floor', 'planned']]);
});

test('nobody on the schedule: no managers, the call-out line', () => {
  const f = fixture();
  f.store.insert('users', { id: 'adm', name: 'Ada Owner', role: 'admin', active: true, jobCodes: [] });
  f.as('adm')('training.saveSettings', { callOutPhone: '(555) 020-0100' });
  f.clock.now = new Date(2026, 11, 5, 12, 0); // Saturday: no shifts
  const r = f.as('srv')('mod.get');
  assert.deepEqual([r.status, r.person, r.managers, r.callOutPhone], ['none', null, [], '(555) 020-0100']);
});

test('the same rule for the printed M.O.D. block: manager role or a manager position', () => {
  const f = fixture();
  assert.ok(isManagerJob({ defaultRole: 'manager' }) && !isManagerJob({ defaultRole: 'employee' }));
  assert.ok(isModShift({ role: 'manager' }, { defaultRole: 'employee' }), 'a manager working the floor');
  assert.ok(isModShift({ role: 'employee' }, { defaultRole: 'manager' }), 'a manager position');
  assert.ok(!isModShift({ role: 'supervisor' }, { defaultRole: 'employee' }));
  const boot = f.as('mid')('app.bootstrap');
  const week = f.as('mid')('shifts.list', { start: '2026-11-30', end: '2026-12-06' });
  const model = sheetModel({ boot, week, weekStart: '2026-11-30' });
  assert.deepEqual(model.mod.map((r) => r.name).sort(), ['CLEO NIGHT', 'FINN FLOOR', 'KIT RANGE', 'MILO CENTER', 'OPAL MORNING']);
  const friday = model.mod.find((r) => r.name === 'FINN FLOOR').cells[4];
  assert.deepEqual(friday, { kind: 'shift', parts: [{ time: '7-11PM', tag: '' }] });
  assert.equal(model.mod.find((r) => r.name === 'FINN FLOOR').cells[0].kind, 'off');
});

// The managers on duty are for every restaurant, not only those with Training (the floor screen and My shifts show them).
test('mod.get is in every plan and for every role: not tied to Training', async () => {
  const { featureForMethod } = await import('../server/platform/plans.js');
  const { featuresForMethod } = await import('../core/role-features.js');
  assert.equal(featureForMethod('mod.get'), null);
  assert.deepEqual(featuresForMethod('mod.get'), []);
});

test('a switch per person: someone switched off never shows in Managers on duty; managers only', () => {
  const f = fixture();
  const vis = f.as('mid')('mod.visibility');
  assert.ok(vis.people.every((p) => p.shown), 'everyone shows by default');
  assert.ok(!vis.people.some((p) => p.id === 'srv'), 'staff aren’t in the list');
  const after = f.as('mid')('mod.setShown', { userId: 'kit', shown: false });
  assert.equal(after.people.find((p) => p.id === 'kit').shown, false);
  assert.ok(!f.as('srv')('mod.get').managers.some((m) => m.id === 'kit'), 'switched off: not in the list');
  f.as('mid')('mod.setShown', { userId: 'kit', shown: true });
  assert.ok(f.as('srv')('mod.get').managers.some((m) => m.id === 'kit'), 'back on');
  assert.throws(() => f.as('srv')('mod.setShown', { userId: 'kit', shown: false }), (e) => e.status === 403);
  assert.throws(() => f.as('srv')('mod.visibility'), (e) => e.status === 403);
  assert.throws(() => f.as('mid')('mod.setShown', { userId: 'srv', shown: false }), (e) => e.status === 400, 'only people who can be on duty');
});
