import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';

// A brand-new restaurant: one admin, nothing else.
function fresh() {
  const store = new MemoryStore();
  store.insert('users', { id: 'usr_owner', name: 'Owner', email: 'o@r.co', role: 'super_admin', jobCodes: [], active: true });
  const svc = createService(store, { now: () => new Date('2026-11-14T10:00:00') });
  return { store, svc, owner: () => store.get('users', 'usr_owner') };
}

const IMPORT = {
  newJobCodes: [{ key: 'new:SRV', name: 'Server', department: 'Restaurant' }, { key: 'new:MOD', name: 'Manager', department: 'Leadership' }],
  newEmployees: [{ key: 'new:ALEX', name: 'Alex D', jobs: ['new:SRV'] }, { key: 'new:PAT', name: 'Pat', jobs: ['new:MOD'] }, { key: 'new:OFFWEEK', name: 'Off Week', jobs: ['new:SRV'] }],
  shifts: [
    { date: '2026-11-18', user: 'new:ALEX', job: 'new:SRV', start: '18:30', end: null, tag: '' },
    { date: '2026-11-19', user: 'new:ALEX', job: 'new:SRV', start: '15:30', end: null, tag: 'BC' },
    { date: '2026-11-18', user: 'new:ALEX', job: 'new:SRV', start: '18:30', end: null, tag: '' }, // listed in two sections
    { date: '2026-11-19', user: 'new:PAT', job: 'new:SRV', start: '12:00', end: null, tag: '' }, // Pat isn't a server yet
    { date: '2026-11-20', user: 'new:PAT', job: 'new:MOD', start: 'nope', end: null, tag: '' },
  ],
  timeOff: [{ user: 'new:ALEX', date: '2026-11-22' }],
  events: [{ date: '2026-11-19', name: 'Gala Night', room: 'Full Buyout', guestCount: 150, type: 'Buyout' }],
  covers: [{ date: '2026-11-19', covers: 100 }],
  skipDuplicates: true,
};

test('import.apply builds a restaurant from a schedule in one step', () => {
  const { svc, store, owner } = fresh();
  const r = svc.call(owner(), 'import.apply', IMPORT);
  assert.deepEqual(r, { jobCodes: 2, employees: 3, rolesLowered: 0, shifts: 3, duplicates: 1, invalid: 1, jobsAdded: 1, timeOff: 1, events: 1, covers: 1 });
  const alex = store.list('users', (u) => u.name === 'Alex D')[0];
  assert.equal(alex.role, 'employee');
  assert.equal(alex.passwordHash, null, 'no password until they get a sign-in link');
  assert.equal(store.list('shifts', (s) => s.userId === alex.id).length, 2);
  assert.ok(store.list('shifts').every((s) => s.published === false), 'imported as drafts');
  const pat = store.list('users', (u) => u.name === 'Pat')[0];
  assert.equal(pat.jobCodes.length, 2, 'got the Server job code they were scheduled for');
  assert.ok(store.list('users', (u) => u.name === 'Off Week').length, 'people with no shifts this week are still added');
  assert.equal(store.list('events')[0].status, 'confirmed');
  assert.equal(store.list('timeOff')[0].status, 'approved');

  // Importing the same thing again adds nothing new.
  const again = svc.call(owner(), 'import.apply', { ...IMPORT, newEmployees: [], shifts: IMPORT.shifts.map((s) => ({ ...s, user: s.user === 'new:ALEX' ? alex.id : pat.id })) });
  assert.equal(again.shifts, 0);
  assert.equal(again.jobCodes, 0, 'job codes matched by name');
  assert.equal(again.events, 0);
  assert.equal(again.timeOff, 0);
});

test('import.apply needs a manager and is all-or-nothing', () => {
  const { svc, store, owner } = fresh();
  store.insert('users', { id: 'usr_emp', name: 'Emp', role: 'employee', jobCodes: [], active: true });
  assert.throws(() => svc.call(store.get('users', 'usr_emp'), 'import.apply', IMPORT), /Managers only/);
  assert.throws(() => svc.call(owner(), 'import.apply', { ...IMPORT, newJobCodes: [{ key: 'x', name: ' ' }] }), /needs a name/);
});

test('projected covers without sales are priced at the usual average check', () => {
  const { svc, store, owner } = fresh();
  for (let w = 1; w <= 4; w++) {
    const d = new Date(Date.UTC(2026, 10, 19 - 7 * w)).toISOString().slice(0, 10);
    store.insert('sales', { id: d, date: d, covers: 100, sales: 5000 });
  }
  svc.call(owner(), 'import.apply', { covers: [{ date: '2026-11-19', covers: 80 }] });
  const thu = svc.call(owner(), 'forecast.week', { weekStart: '2026-11-16' }).days.find((d) => d.date === '2026-11-19');
  assert.equal(thu.covers, 80);
  assert.equal(thu.sales, 4000);
  assert.equal(thu.basis, 'Projected covers');
});

test('import gives new people the role from their section, keeps the sheet order, and respects who can give which role', () => {
  const { svc, store, owner } = fresh();
  const r = svc.call(owner(), 'import.apply', {
    newJobCodes: [{ key: 'new:MOD', name: 'Manager', department: 'Leadership', defaultRole: 'manager' }, { key: 'new:SRV', name: 'Server', department: 'Restaurant' }],
    newEmployees: [{ key: 'a', name: 'Lucas', jobs: ['new:MOD'], role: 'manager' }, { key: 'b', name: 'Alex D', jobs: ['new:SRV'], role: 'employee' }],
  });
  assert.equal(r.employees, 2);
  const byName = (n) => store.list('users', (u) => u.name === n)[0];
  assert.equal(byName('Lucas').role, 'manager');
  assert.equal(byName('Alex D').role, 'employee');
  assert.ok(byName('Lucas').order < byName('Alex D').order, 'sheet order kept');
  assert.equal(store.list('jobCodes', (j) => j.name === 'Manager')[0].defaultRole, 'manager');

  // A manager can't create managers: those people come in as Employees, and it's reported.
  const lucas = byName('Lucas');
  const out = svc.call(lucas, 'import.apply', { newEmployees: [{ key: 'c', name: 'Kelly', jobs: [], role: 'manager' }, { key: 'd', name: 'Lead', jobs: [], role: 'supervisor' }] });
  assert.equal(out.rolesLowered, 1);
  assert.equal(byName('Kelly').role, 'employee');
  assert.equal(byName('Lead').role, 'supervisor');
});

test('managers set a temporary password for people they manage, not for higher roles', () => {
  const { svc, store, owner } = fresh();
  svc.call(owner(), 'import.apply', { newEmployees: [{ key: 'm', name: 'Mgr', jobs: [], role: 'manager' }, { key: 'e', name: 'Emp', jobs: [], role: 'employee' }] });
  const mgr = store.list('users', (u) => u.name === 'Mgr')[0];
  const emp = store.list('users', (u) => u.name === 'Emp')[0];
  const { tempPassword } = svc.call(mgr, 'employees.resetPassword', { userId: emp.id });
  assert.match(tempPassword, /^[a-zA-Z2-9]{10}$/);
  assert.equal(store.get('users', emp.id).passwordHash, `plain:${tempPassword}`);
  assert.equal(store.get('users', emp.id).sessionVersion, 1, 'other sessions signed out');
  assert.throws(() => svc.call(mgr, 'employees.resetPassword', { userId: 'usr_owner' }), /higher role/);
  assert.throws(() => svc.call(emp, 'employees.resetPassword', { userId: mgr.id }), /Managers only/);
});

test('copy a week forward into the next week, skipping people who left', () => {
  const { svc, store, owner } = fresh();
  svc.call(owner(), 'import.apply', {
    newJobCodes: [{ key: 'j', name: 'Server' }],
    newEmployees: [{ key: 'a', name: 'Stays', jobs: ['j'] }, { key: 'b', name: 'Leaves', jobs: ['j'] }],
    shifts: [{ date: '2026-11-18', user: 'a', job: 'j', start: '16:00' }, { date: '2026-11-19', user: 'b', job: 'j', start: '16:00' }],
  });
  store.update('users', store.list('users', (u) => u.name === 'Leaves')[0].id, { active: false });
  const r = svc.call(owner(), 'shifts.copyWeek', { fromWeek: '2026-11-16', toWeek: '2026-11-23' });
  assert.deepEqual([r.copied, r.skipped], [1, 1]);
  const next = store.list('shifts', (s) => s.date >= '2026-11-23');
  assert.deepEqual(next.map((s) => [s.date, s.start, s.published]), [['2026-11-25', '16:00', false]]);
  assert.throws(() => svc.call(owner(), 'shifts.copyWeek', { fromWeek: '2026-11-16', toWeek: '2026-11-16' }), /different week/);
});
