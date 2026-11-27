// Custom roles ("types of managers"): a name on a base level (core/custom-roles.js).
//   - creating one, giving it to someone, and its rank (the base level's, for every permission check)
//   - its own Roles & features column (a copy of the base level's) and its own "Approves for" default
//   - a Bar Manager approves bar trades only; deleting a role moves its people to the base level
//   - nobody grants a base level above their own; View as by custom role; labels in English and Spanish
// Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, OverlayStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { roleLabel, canManageSchedule, canApprove, roleOf, useCustomRoles } from '../core/roles.js';
import { roleAllows, roleMatrix } from '../core/role-features.js';
import { resolveTarget, viewedPerson } from '../core/view-as.js';
import { translateError } from '../core/errors.js';

const NOW = new Date(2026, 8, 27, 12);
const DAY = '2026-10-06';
const OUT = 'You don’t approve requests for this position. A manager who does will decide it.';

function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  for (const r of store.list('requests')) store.remove('requests', r.id);
  store.insert('users', { id: 'usr_t_owner', name: 'Owner', role: 'super_admin', active: true, jobCodes: [], availability: {} });
  const svc = createService(store, { now: () => NOW });
  const add = (id, name, role, jobs = []) => store.insert('users', { id, name, role, active: true, availability: {}, jobCodes: jobs.map((jobCodeId, i) => ({ jobCodeId, primary: i === 0 })) });
  const people = {
    owner: store.get('users', 'usr_t_owner'), admin: store.list('users', (u) => u.role === 'admin')[0],
    mgr: add('usr_t_mgr', 'Rory Fenwick', 'manager'), lead: add('usr_t_lead', 'Ivy Marsh', 'supervisor'),
    barA: add('usr_t_bara', 'Tess Hollow', 'employee', ['job_bar']), barB: add('usr_t_barb', 'Nico Brand', 'employee', ['job_bar']),
    hostA: add('usr_t_hosta', 'Dell Ames', 'employee', ['job_host']), hostB: add('usr_t_hostb', 'Kai Wren', 'employee', ['job_host']),
    person: add('usr_t_person', 'Lou Carver', 'employee'),
  };
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  return { store, svc, people, call };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message), `${status} ${message || ''}`);

test('a custom role: made by an admin, given to someone, ranked as its base level, with its own column', () => {
  const { store, people: p, call } = demo();
  const bar = call(p.admin, 'roles.custom.save', { name: 'Bar Manager', nameEs: 'Gerente de bar', base: 'manager' });
  assert.match(bar.id, /^cr_/);
  assert.equal(bar.base, 'manager');
  call(p.admin, 'employees.save', { ...store.get('users', p.person.id), customRole: bar.id });
  const u = store.get('users', p.person.id);
  assert.deepEqual([u.role, u.customRole], ['manager', bar.id], 'role = the base level');
  assert.equal(canManageSchedule(u), true, 'every rank check follows the base level');
  assert.equal(roleOf(u), 'manager');
  const st = call(p.admin, 'roleFeatures.get');
  assert.ok(st.roles.includes(bar.id), 'its own column in Roles & features');
  assert.deepEqual(st.values[bar.id], st.values.manager, 'starting as a copy of Managers');
  call(p.admin, 'roleFeatures.save', { roleFeatures: { [bar.id]: { reports: false } } });
  const settings = store.get('settings', 'settings');
  assert.equal(roleAllows(store.get('users', p.person.id), settings).reports, false, 'its own switches');
  assert.equal(roleAllows(store.get('users', p.mgr.id), settings).reports, true, 'Managers keep theirs');
  // Labels: the role's name, in Spanish when it has one.
  useCustomRoles(settings.customRoles);
  assert.equal(roleLabel(u), 'Bar Manager');
  assert.equal(roleLabel(u, 'es'), 'Gerente de bar');
  const lead = call(p.admin, 'roles.custom.save', { name: 'Shift Lead', base: 'supervisor' });
  useCustomRoles(store.get('settings', 'settings').customRoles);
  assert.equal(roleLabel(lead.id, 'es'), 'Shift Lead', 'no Spanish name: the English one');
  // The connector's whoami and the app's bootstrap carry it too.
  assert.equal(call(p.person, 'app.bootstrap').me.customRole, bar.id);
  assert.ok(call(p.person, 'roles.custom.list').some((r) => r.name === 'Bar Manager' && r.people === 1));
  // Its own approval switch for a supervisor-level role, copied from Supervisors.
  call(p.admin, 'employees.save', { ...store.get('users', p.lead.id), customRole: lead.id });
  assert.equal(canApprove(store.get('users', p.lead.id), store.get('settings', 'settings')), true);
  assert.equal(roleMatrix(store.get('settings', 'settings'))[lead.id].approve, true);
});

test('a Bar Manager approves bar trades only (the role’s "Approves for" default); a person’s own setting wins', () => {
  const { store, people: p, call } = demo();
  const bar = call(p.admin, 'roles.custom.save', { name: 'Bar Manager', base: 'manager' });
  call(p.admin, 'approvalScope.saveRoles', { [bar.id]: { mode: 'include', positions: ['job_bar', 'job_bbk'] }, manager: { mode: 'none' } });
  call(p.admin, 'employees.save', { ...store.get('users', p.person.id), customRole: bar.id });
  const giveaway = (job, from, to) => {
    const s = store.insert('shifts', { date: DAY, start: '16:00', end: '22:00', jobCodeId: job, userId: from.id, area: '', published: true, tag: '', notes: '', breakMin: 0 });
    const r = call(from, 'swaps.create', { shiftId: s.id, type: 'drop' });
    call(to, 'swaps.accept', { requestId: r.id });
    return r.id;
  };
  const barReq = giveaway('job_bar', p.barA, p.barB);
  const hostReq = giveaway('job_host', p.hostA, p.hostB);
  assert.equal(call(p.person, 'approvalScope.get').source, 'role');
  assert.deepEqual(call(p.person, 'swaps.list').approvals.map((r) => r.id).includes(barReq), true);
  // The host request: nobody has it in scope (managers: none) → every manager may decide it; so test with a host lead.
  const host = call(p.admin, 'roles.custom.save', { name: 'Host Manager', base: 'manager' });
  call(p.admin, 'approvalScope.saveRoles', { [host.id]: { mode: 'include', positions: ['job_host'] } });
  call(p.admin, 'employees.save', { ...store.get('users', p.mgr.id), customRole: host.id });
  refused(() => call(p.person, 'swaps.approve', { requestId: hostReq }), 403, OUT);
  call(p.person, 'swaps.approve', { requestId: barReq });
  assert.equal(store.get('requests', barReq).status, 'approved');
  call(p.mgr, 'swaps.approve', { requestId: hostReq });
  // A person's own "Approves for" overrides the role's.
  call(p.admin, 'approvalScope.set', { userId: p.person.id, scope: { mode: 'all' } });
  assert.equal(call(p.person, 'approvalScope.get').source, 'person');
});

test('deleting a role asks first, then moves its people to the base level', () => {
  const { store, people: p, call } = demo();
  const r = call(p.admin, 'roles.custom.save', { name: 'Kitchen Manager', base: 'manager' });
  call(p.admin, 'employees.save', { ...store.get('users', p.person.id), customRole: r.id });
  const ask = call(p.admin, 'roles.custom.delete', { id: r.id });
  assert.deepEqual(ask, { needsConfirm: true, people: 1, base: 'manager' });
  assert.ok(store.get('settings', 'settings').customRoles.some((x) => x.id === r.id), 'nothing removed yet');
  const done = call(p.admin, 'roles.custom.delete', { id: r.id, confirm: true });
  assert.deepEqual([done.moved, done.base], [1, 'manager']);
  const u = store.get('users', p.person.id);
  assert.deepEqual([u.role, u.customRole], ['manager', null]);
  assert.ok(!store.get('settings', 'settings').customRoles.length);
  assert.ok(store.list('auditLog', (a) => a.action === 'roles.custom.delete').length === 1);
});

test('no escalation: managers can’t make roles or grant one above their level; admins make manager-level ones', () => {
  const { store, people: p, call } = demo();
  refused(() => call(p.mgr, 'roles.custom.save', { name: 'Floor Boss', base: 'manager' }), 403, 'Admins only');
  const r = call(p.admin, 'roles.custom.save', { name: 'Floor Boss', base: 'manager' });
  refused(() => call(p.admin, 'roles.custom.save', { name: 'Big Boss', base: 'admin' }), 400, 'Pick the level it’s based on: Manager, Supervisor or Employee');
  refused(() => call(p.admin, 'roles.custom.save', { name: 'manager', base: 'manager' }), 400, 'There’s already a role with that name');
  refused(() => call(p.mgr, 'employees.save', { ...store.get('users', p.barA.id), customRole: r.id }), 403);
  assert.equal(store.get('users', p.barA.id).role, 'employee');
  const sl = call(p.admin, 'roles.custom.save', { name: 'Shift Lead', base: 'supervisor' });
  call(p.mgr, 'employees.save', { ...store.get('users', p.barA.id), customRole: sl.id });
  assert.equal(store.get('users', p.barA.id).role, 'supervisor', 'a manager may grant a supervisor-level role');
  refused(() => call(p.mgr, 'employees.save', { ...store.get('users', p.mgr.id), customRole: r.id }), 400, 'You can’t change your own role. Ask another admin.');
  assert.equal(translateError('Pick the level it’s based on: Manager, Supervisor or Employee', 'es'), 'Elige el nivel en el que se basa: Gerente, Supervisor o Empleado');
  assert.equal(translateError('There’s already a role with that name', 'es'), 'Ya hay un rol con ese nombre');
});

test('View as by a custom role: a stand-in with its base level and its own features', () => {
  const { store, people: p, call } = demo();
  const r = call(p.admin, 'roles.custom.save', { name: 'Events Manager', nameEs: 'Gerente de eventos', base: 'manager' });
  call(p.admin, 'roleFeatures.save', { roleFeatures: { [r.id]: { tips: false } } });
  const owner = store.get('users', 'usr_t_owner');
  const target = resolveTarget(store, owner, { role: r.id }, { today: '2026-09-27' });
  assert.equal(target.role, r.id);
  const stand = viewedPerson(store, owner, target, 'es');
  assert.deepEqual([stand.role, stand.customRole, stand.name], ['manager', r.id, 'Gerente de eventos de muestra']);
  const view = new OverlayStore(store);
  view.insert('users', stand);
  const boot = createService(view, { now: () => NOW }).call(view.get('users', stand.id), 'app.bootstrap', {});
  assert.equal(boot.features.tips, false, 'the role’s own column');
  assert.equal(boot.features.schedule, true);
  void call;
});
