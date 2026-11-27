// Managers editing staff availability, fully logged:
//   - a manager's change is logged (who, when, for whom, via, each day before → after) and the person is notified
//   - staff can't edit anyone else's; supervisors only when Roles & features turns "Edit staff availability" on
//   - the history is visible to the person and to managers, never to coworkers; it's kept 2 years
//   - the Claude connector and Ask ShiftBoard (set_availability for someone else, with confirm) are logged with their via
// Every person here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { LOG } from '../core/availability.js';
import { translateError } from '../core/errors.js';
import { roleMatrix } from '../core/role-features.js';
import { toolByName, runTool, createToolContext, READ, WRITE } from '../server/tools/index.js';
import { startApp } from './helpers/app.js';

const NOW = new Date(2026, 8, 27, 12);

function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (doc) => store.insert('users', { role: 'employee', active: true, jobCodes: [], availability: {}, ...doc });
  const staff = add({ id: 'usr_t_juniper', name: 'Juniper Hale' });
  const coworker = add({ id: 'usr_t_oren', name: 'Oren Bask' });
  const sup = add({ id: 'usr_t_sup', name: 'Wren Talbot', role: 'supervisor' });
  const mgr = add({ id: 'usr_t_mgr', name: 'Quinn Ashby', role: 'manager' });
  const admin = store.list('users', (u) => u.role === 'admin')[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  return { store, svc, staff, coworker, sup, mgr, admin, call };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message), `${status} ${message || ''}`);

test('a manager’s edit is logged with before → after per day, and the person is notified', () => {
  const { store, staff, mgr, call } = demo();
  const out = call(mgr, 'employees.setAvailability', { userId: staff.id, availability: { 1: { available: false, note: 'Class' }, 5: { available: true, from: '16:00' } }, notes: 'No doubles', maxDays: 4 });
  assert.deepEqual(out.availability, { 1: { available: false, note: 'Class' }, 5: { available: true, from: '16:00' } });
  const log = store.list(LOG, (e) => e.userId === staff.id);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].actorId, log[0].via], [mgr.id, 'app']);
  assert.deepEqual(log[0].days.map((d) => [d.day, d.before.available, d.after.available, d.after.from, d.after.note]), [[1, true, false, '', 'Class'], [5, true, true, '16:00', '']]);
  assert.deepEqual(log[0].fields.map((f) => [f.field, f.after]), [['notes', 'No doubles'], ['maxDays', 4]]);
  const told = store.list('notifications', (n) => n.userId === staff.id);
  assert.equal(told.length, 1);
  assert.match(told[0].text, /Quinn Ashby updated your availability/);
  assert.equal(told[0].link, '#/timeoff/availability');
  assert.match(told[0].i18n.es, /Quinn Ashby actualizó tu disponibilidad/);
  // The same week again: nothing logged, nobody told.
  call(mgr, 'employees.setAvailability', { userId: staff.id, availability: { 1: { available: false, note: 'Class' }, 5: { available: true, from: '16:00' } } });
  assert.equal(store.list(LOG).length, 1);
  assert.equal(store.list('notifications', (n) => n.userId === staff.id).length, 1);
  // Their own change is logged too, without a notification to themselves.
  call(staff, 'employees.setAvailability', { availability: {} });
  assert.equal(store.list(LOG, (e) => e.userId === staff.id).length, 2);
  assert.equal(store.list('notifications', (n) => n.userId === staff.id).length, 1);
  // The setting: managers' changes still logged, but not announced.
  call(store.list('users', (u) => u.role === 'admin')[0], 'settings.update', { notifyAvailabilityChanges: false });
  call(mgr, 'employees.setAvailability', { userId: staff.id, availability: { 0: { available: false } } });
  assert.equal(store.list(LOG, (e) => e.userId === staff.id).length, 3);
  assert.equal(store.list('notifications', (n) => n.userId === staff.id).length, 1);
});

test('staff can’t edit anyone else’s; supervisors only with “Edit staff availability”, and only employees', () => {
  const { store, staff, coworker, sup, mgr, admin, call } = demo();
  refused(() => call(coworker, 'employees.setAvailability', { userId: staff.id, availability: {} }), 403, 'You can only edit your own availability');
  assert.equal(translateError('You can only edit your own availability', 'es'), 'Solo puedes editar tu propia disponibilidad');
  refused(() => call(sup, 'employees.setAvailability', { userId: staff.id, availability: {} }), 403);
  assert.equal(roleMatrix({}).supervisor.editAvailability, false, 'off for supervisors by default');
  assert.equal(roleMatrix({}).manager.editAvailability, true, 'managers can, as before');
  assert.deepEqual(call(staff, 'availability.people').map((p) => p.id), [staff.id], 'the person picker: only themselves');
  call(admin, 'roleFeatures.save', { roleFeatures: { supervisor: { editAvailability: true } } });
  call(sup, 'employees.setAvailability', { userId: staff.id, availability: { 2: { available: false } } });
  assert.equal(store.get('users', staff.id).availability[2].available, false);
  refused(() => call(sup, 'employees.setAvailability', { userId: mgr.id, availability: {} }), 403, 'You can only edit your own availability');
  assert.ok(call(sup, 'availability.people').some((p) => p.id === staff.id));
  // Turned off for managers: their own only.
  call(admin, 'roleFeatures.save', { roleFeatures: { manager: { editAvailability: false } } });
  refused(() => call(mgr, 'employees.setAvailability', { userId: staff.id, availability: {} }), 403);
  call(mgr, 'employees.setAvailability', { availability: { 3: { available: false } } });
  assert.equal(call(mgr, 'availability.get', { userId: staff.id }).canEdit, false);
  assert.equal(call(admin, 'availability.get', { userId: staff.id }).canEdit, true, 'admins always');
});

test('the history: the person and managers see it, coworkers don’t; 2 years kept', () => {
  const { store, staff, coworker, mgr, call } = demo();
  call(mgr, 'employees.setAvailability', { userId: staff.id, availability: { 4: { available: false } } });
  const mine = call(staff, 'availability.history');
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].actorName, mine[0].via, mine[0].self], ['Quinn Ashby', 'app', false]);
  assert.equal(call(mgr, 'availability.history', { userId: staff.id }).length, 1);
  refused(() => call(coworker, 'availability.history', { userId: staff.id }), 403, 'You can only see your own availability');
  refused(() => call(coworker, 'availability.get', { userId: staff.id }), 403);
  assert.equal(translateError('You can only see your own availability', 'es'), 'Solo puedes ver tu propia disponibilidad');
  // An entry older than 2 years is gone from the history and dropped on the next change.
  store.insert(LOG, { id: 'avl_old', userId: staff.id, actorId: mgr.id, at: '2024-01-01T00:00:00.000Z', via: 'app', days: [], fields: [] });
  assert.equal(call(staff, 'availability.history').length, 1);
  call(staff, 'employees.setAvailability', { availability: {} });
  assert.equal(store.get(LOG, 'avl_old'), null);
});

// ---------- the Claude connector and Ask ShiftBoard ----------
let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });
const person = (name) => A.db.store.list('users', (u) => u.name === name)[0];
const ctxFor = (user, via = 'claude') => createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, has: () => true, scopes: [READ, WRITE], via, client: 'Test client' });

test('set_availability for someone else needs confirm, is logged with its via, and they’re notified; get_availability_history', async () => {
  const store = A.db.store;
  const mgr = store.list('users', (u) => u.role === 'manager' && u.active !== false)[0];
  const emp = store.list('users', (u) => u.role === 'employee' && u.active !== false)[0];
  const set = toolByName('set_availability');
  const days = [{ day: 'tuesday', available: false, note: 'School' }];
  const ask = await runTool(set, { days, person: emp.name }, ctxFor(mgr));
  assert.equal(ask.ok, false);
  assert.equal(ask.status, 409);
  assert.match(ask.error, /confirm: true/);
  const done = await runTool(set, { days, person: emp.name, confirm: true }, ctxFor(mgr));
  assert.equal(done.ok, true, done.error);
  assert.equal(store.get('users', emp.id).availability[2].note, 'School');
  const log = store.list(LOG, (e) => e.userId === emp.id);
  assert.deepEqual(log.map((e) => [e.via, e.actorId]), [['connector', mgr.id]]);
  assert.ok(store.list('notifications', (n) => n.userId === emp.id && n.kind === 'availabilityChanged').length >= 1);
  // Ask ShiftBoard: logged as the assistant.
  await runTool(set, { days: [{ day: 'friday', available: true, from: '17:00' }], person: emp.name, confirm: true }, ctxFor(mgr, 'assistant'));
  assert.deepEqual(store.list(LOG, (e) => e.userId === emp.id).map((e) => e.via).sort(), ['assistant', 'connector']);
  // Your own: no confirm needed (as before).
  const own = await runTool(set, { days: [{ day: 'monday', available: false }] }, ctxFor(emp));
  assert.equal(own.ok, true, own.error);
  // A coworker can't change someone else's.
  const other = store.list('users', (u) => u.role === 'employee' && u.active !== false && u.id !== emp.id)[0];
  const no = await runTool(set, { days, person: emp.name, confirm: true }, ctxFor(other));
  assert.equal(no.ok, false);
  // The history tool.
  const hist = await runTool(toolByName('get_availability_history'), { person: emp.name }, ctxFor(mgr));
  assert.equal(hist.ok, true, hist.error);
  assert.equal(hist.data.changes.length, 3);
  assert.deepEqual(hist.data.changes.map((c) => c.via).sort(), ['assistant', 'connector', 'connector']);
  assert.ok(hist.data.changes.some((c) => c.days.some((d) => d.day === 'Tuesday' && d.after === 'unavailable (School)')));
  const got = await runTool(toolByName('get_availability'), { person: emp.name }, ctxFor(mgr));
  assert.equal(got.data.days[2].note, 'School');
});
