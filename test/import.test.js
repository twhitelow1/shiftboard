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
  assert.deepEqual(r, { jobCodes: 2, employees: 3, shifts: 3, duplicates: 1, invalid: 1, jobsAdded: 1, timeOff: 1, events: 1, covers: 1 });
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
