import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { assignableRoles, canManageUser, roleOf } from '../core/roles.js';

function setup() {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  store.update('users', ids.userId.Courtney, { role: 'supervisor' });
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const u = (name) => store.get('users', ids.userId[name]);
  return { store, svc, ids, u };
}

test('role ladder: who can give which role', () => {
  assert.deepEqual(assignableRoles({ role: 'super_admin' }), ['super_admin', 'admin', 'manager', 'supervisor', 'employee']);
  assert.deepEqual(assignableRoles({ role: 'admin' }), ['admin', 'manager', 'supervisor', 'employee']);
  assert.deepEqual(assignableRoles({ role: 'admin' }, { superAdminExists: false }), ['super_admin', 'admin', 'manager', 'supervisor', 'employee']);
  assert.deepEqual(assignableRoles({ role: 'manager' }), ['supervisor', 'employee']);
  assert.deepEqual(assignableRoles({ role: 'supervisor' }), []);
  assert.ok(!canManageUser({ role: 'admin' }, { role: 'super_admin' }));
  assert.ok(canManageUser({ role: 'manager' }, { role: 'supervisor' }));
  assert.ok(!canManageUser({ role: 'manager' }, { role: 'manager' }));
  assert.equal(roleOf({ role: 'events' }), 'employee');
});

test('adding and editing users follows the hierarchy', () => {
  const { svc, u } = setup();
  // Admin creates the first Super Admin; after that only Super Admins can.
  const owner = svc.call(u('Moe'), 'employees.save', { name: 'Owner', email: 'owner@rabbits.co', role: 'super_admin' });
  assert.equal(owner.role, 'super_admin');
  assert.match(owner.tempPassword, /^[a-zA-Z2-9]{10}$/);
  assert.throws(() => svc.call(u('Moe'), 'employees.save', { name: 'Two', email: 'two@rabbits.co', role: 'super_admin' }), /can’t give someone the Super Admin role/);
  assert.throws(() => svc.call(u('Moe'), 'employees.save', { ...owner, name: 'Renamed' }), /Only a higher role can edit a Super Admin/);

  assert.equal(svc.call(u('Kelly'), 'employees.save', { name: 'Lead', email: 'lead@rabbits.co', role: 'supervisor' }).role, 'supervisor');
  assert.throws(() => svc.call(u('Kelly'), 'employees.save', { name: 'X', email: 'x@rabbits.co', role: 'admin' }), /Admin role/);
  assert.throws(() => svc.call(u('Kelly'), 'employees.save', { ...u('Moe'), name: 'Moe X' }), /Only a higher role can edit an Admin/);
  assert.throws(() => svc.call(u('Moe'), 'employees.save', { ...u('Moe'), role: 'manager' }), /own role/);
  assert.throws(() => svc.call(u('Moe'), 'employees.save', { ...u('Moe'), active: false }), /deactivate yourself/);
  assert.throws(() => svc.call(u('Courtney'), 'employees.save', { name: 'Y', role: 'employee' }), /Managers only/);
});

test('the last active Super Admin cannot be demoted or deactivated', () => {
  const { svc, store, u } = setup();
  const owner = svc.call(u('Moe'), 'employees.save', { name: 'Owner', email: 'owner@rabbits.co', role: 'super_admin' });
  const ownerUser = store.get('users', owner.id);
  const second = svc.call(ownerUser, 'employees.save', { name: 'Partner', email: 'partner@rabbits.co', role: 'super_admin' });
  // With two Super Admins, one can step the other down…
  svc.call(store.get('users', second.id), 'employees.save', { ...store.get('users', owner.id), role: 'admin' });
  assert.equal(store.get('users', owner.id).role, 'admin');
  // …then the remaining one can't be touched by the (now) Admin, can't demote themselves,
  assert.throws(() => svc.call(store.get('users', owner.id), 'employees.save', { ...store.get('users', second.id), active: false }), /Only a higher role/);
  assert.throws(() => svc.call(store.get('users', second.id), 'employees.save', { ...store.get('users', second.id), role: 'admin' }), /own role/);
  // …and the safety net holds even for any other Super Admin session.
  const ghost = { id: 'usr_ghost', role: 'super_admin', name: 'Ghost' };
  assert.throws(() => svc.call(ghost, 'employees.save', { ...store.get('users', second.id), role: 'admin' }), /at least one active Super Admin/);
  assert.throws(() => svc.call(ghost, 'employees.save', { ...store.get('users', second.id), active: false }), /at least one active Super Admin/);
});

test('supervisors approve requests (not their own) but cannot touch the schedule', () => {
  const { svc, store, u, ids } = setup();
  const pending = store.list('requests', (r) => r.status === 'pending_approval')[0];
  assert.throws(() => svc.call(u('Courtney'), 'shifts.save', { date: '2026-10-06', start: '16:00', jobCodeId: 'job_srv' }), /Managers only/);
  assert.deepEqual(svc.call(u('Courtney'), 'swaps.approve', { requestId: pending.id }), { ok: true });

  // Their own time off needs someone else.
  const t = svc.call(u('Courtney'), 'timeOff.create', { startDate: '2026-10-20' });
  assert.throws(() => svc.call(u('Courtney'), 'timeOff.decide', { id: t.id, status: 'approved' }), /approve your own request/);
  assert.equal(svc.call(u('Kelly'), 'timeOff.decide', { id: t.id, status: 'approved' }).status, 'approved');

  // Turning the setting off takes approval away from supervisors.
  svc.call(u('Moe'), 'settings.update', { supervisorsCanApprove: false });
  const t2 = svc.call(u('Styves'), 'timeOff.create', { startDate: '2026-10-21' });
  assert.throws(() => svc.call(u('Courtney'), 'timeOff.decide', { id: t2.id, status: 'approved' }), /Managers and supervisors only/);
  assert.ok(ids);
});

test('supervisors see coworker contact info but not pay rates; employees see neither', () => {
  const { svc, u } = setup();
  const asSup = svc.call(u('Courtney'), 'app.bootstrap').employees.find((e) => e.name === 'Styves');
  assert.ok('email' in asSup && 'phone' in asSup);
  assert.ok(asSup.jobCodes.every((j) => !('rate' in j)));
  const asEmp = svc.call(u('Alex D'), 'app.bootstrap').employees.find((e) => e.name === 'Styves');
  assert.ok(!('email' in asEmp));
});

test('event access is a per-person switch; the old events role keeps working', () => {
  const { svc, u } = setup();
  const ev = svc.call(u('Moe'), 'app.bootstrap').employees.find((e) => e.name === 'Events Team');
  assert.deepEqual([ev.role, ev.eventsAccess, ev.onSchedule], ['employee', true, false]);
  assert.ok(svc.call(u('Events Team'), 'events.save', { name: 'Holiday party', date: '2026-12-12', start: '18:00', guestCount: 40 }).id);
  assert.throws(() => svc.call(u('Styves'), 'events.save', { name: 'Nope', date: '2026-12-12' }), /Events team or managers only/);
  const lead = svc.call(u('Kelly'), 'employees.save', { name: 'Banquet Lead', email: 'bc@rabbits.co', role: 'supervisor', eventsAccess: true });
  assert.equal(lead.eventsAccess, true);
});
