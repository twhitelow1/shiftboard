// Team availability (availability.team.get, core/availability-team.js): everyone's week side by side, for managers.
//   - one row per active person: name, positions, primary room, each day standing / unavailable / partial / open + note
//   - dated time off (approved or pending) in the chosen week sits on its day; denied and other weeks don't
//   - counts per day; the week defaults to next week and any date picks its week
//   - staff never see it; supervisors only when "Edit staff availability" is on for them, and then only employees
//   - managers see it even with that switch off (read only, canEdit false)
//   - the get_team_availability tool reads it
// Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { translateError } from '../core/errors.js';
import { dayStatus } from '../core/availability-team.js';
import { toolByName, runTool, createToolContext, READ } from '../server/tools/index.js';

const NOW = new Date(2026, 8, 27, 12); // Sunday 2026-09-27: next week starts Monday 2026-09-28

function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (doc) => store.insert('users', { role: 'employee', active: true, jobCodes: [], availability: {}, ...doc });
  const job = store.list('jobCodes', (j) => /server/i.test(j.name))[0];
  const staff = add({
    id: 'usr_t_juniper', name: 'Juniper Hale', legalFirstName: 'Junie', legalLastName: 'Halvorsen',
    jobCodes: [{ jobCodeId: job.id, primary: true, areas: ['Restaurant', 'Moon Rabbit'], primaryRoom: 'Moon Rabbit' }],
    availability: {
      1: { available: false, standing: true, requestedAt: '2026-01-05T15:00:00.000Z', source: 'sheet' }, // Monday: standing
      2: { available: false, note: 'School' }, // Tuesday: unavailable
      5: { available: true, from: '16:00', note: 'Sheet note: WOH' }, // Friday: after 4
    },
  });
  const coworker = add({ id: 'usr_t_oren', name: 'Oren Bask', jobCodes: [{ jobCodeId: job.id, primary: true }], availability: { 1: { available: false, standing: true } } });
  const gone = add({ id: 'usr_t_gone', name: 'Pell Varnum', active: false, availability: { 1: { available: false, standing: true } } });
  const sup = add({ id: 'usr_t_sup', name: 'Wren Talbot', role: 'supervisor' });
  const mgr = add({ id: 'usr_t_mgr', name: 'Quinn Ashby', role: 'manager' });
  const admin = store.list('users', (u) => u.role === 'admin')[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const off = (doc) => store.insert('timeOff', { id: `to_t_${Math.random().toString(36).slice(2, 8)}`, reason: '', createdAt: '2026-09-01T12:00:00.000Z', ...doc });
  return { store, svc, call, staff, coworker, gone, sup, mgr, admin, job, off };
}
const find = (r, id) => r.people.find((p) => p.id === id);

test('a manager sees everyone active, each day standing, unavailable, partial or open, with notes and counts', () => {
  const { call, admin, staff, coworker, gone, job } = demo();
  const r = call(admin, 'availability.team.get');
  assert.equal(r.weekStart, '2026-09-28', 'next week by default');
  assert.equal(r.dates.length, 7);
  assert.equal(r.dates[6], '2026-10-04');
  assert.ok(!find(r, gone.id), 'inactive people are left out');
  const p = find(r, staff.id);
  assert.equal(p.name, 'Juniper Hale');
  assert.equal(p.legalName, 'Junie Halvorsen', 'admins see the legal name');
  assert.equal(p.room, 'Moon Rabbit', 'the primary room');
  assert.equal(p.jobCodeId, job.id);
  assert.deepEqual(p.positions.map((x) => x.name), [job.name]);
  const by = Object.fromEntries(p.days.map((d) => [d.dow, d]));
  assert.equal(by[1].status, 'standing');
  assert.equal(by[1].requestedAt, '2026-01-05T15:00:00.000Z');
  assert.equal(by[2].status, 'off');
  assert.equal(by[2].note, 'School');
  assert.equal(by[5].status, 'partial');
  assert.equal(by[5].from, '16:00');
  assert.equal(by[5].note, 'Sheet note: WOH');
  assert.equal(by[3].status, 'open');
  assert.ok(p.canEdit);
  // Monday's count: at least these two (the demo may have others).
  const mon = r.dates.indexOf('2026-09-28');
  assert.ok(r.counts.standing[mon] >= 2);
  assert.equal(r.counts.standing[mon], r.people.filter((x) => x.days[mon].status === 'standing').length);
  assert.ok(find(r, coworker.id));
  assert.ok(r.rooms.some((x) => x.room === 'Moon Rabbit' && x.color && x.positions.length), 'the schedule rooms, with colors and positions');
});

test('dated time off in the week: approved and pending on their days; denied, cancelled and other weeks not', () => {
  const { call, admin, staff, coworker, off } = demo();
  off({ userId: staff.id, startDate: '2026-10-02', endDate: '2026-10-03', status: 'approved', reason: 'Wedding' });
  off({ userId: coworker.id, startDate: '2026-09-25', endDate: '2026-09-29', status: 'pending' });
  off({ userId: coworker.id, startDate: '2026-10-01', endDate: '2026-10-01', status: 'denied' });
  off({ userId: coworker.id, startDate: '2026-10-02', endDate: '2026-10-02', status: 'cancelled' });
  off({ userId: staff.id, startDate: '2026-10-12', endDate: '2026-10-12', status: 'approved' });
  const r = call(admin, 'availability.team.get', { weekStart: '2026-09-30' });
  assert.equal(r.weekStart, '2026-09-28', 'any date picks its week');
  const s = find(r, staff.id).days, c = find(r, coworker.id).days;
  assert.deepEqual(s.filter((d) => d.timeOff).map((d) => [d.date, d.timeOff.status, d.timeOff.reason]), [['2026-10-02', 'approved', 'Wedding'], ['2026-10-03', 'approved', 'Wedding']]);
  assert.deepEqual(c.filter((d) => d.timeOff).map((d) => [d.date, d.timeOff.status]), [['2026-09-28', 'pending'], ['2026-09-29', 'pending']]);
  assert.equal(r.counts.timeOff[4], r.people.filter((p) => p.days[4].timeOff).length);
  const later = call(admin, 'availability.team.get', { weekStart: '2026-10-12' });
  assert.equal(find(later, staff.id).days[0].timeOff.status, 'approved');
});

test('an availability that starts later: the week before it shows the one it replaces', () => {
  const { store, call, admin, staff } = demo();
  store.update('users', staff.id, { availabilityFrom: '2026-10-05', availabilityBefore: { 3: { available: false } }, availability: { 4: { available: false } } });
  const now = call(admin, 'availability.team.get', { weekStart: '2026-09-28' });
  assert.equal(find(now, staff.id).days.find((d) => d.dow === 3).status, 'off');
  assert.equal(find(now, staff.id).days.find((d) => d.dow === 4).status, 'open');
  assert.equal(find(now, staff.id).effectiveFrom, '2026-10-05');
  const then = call(admin, 'availability.team.get', { weekStart: '2026-10-05' });
  assert.equal(find(then, staff.id).days.find((d) => d.dow === 4).status, 'off');
});

test('staff never see it; supervisors only with "Edit staff availability", and then only employees', () => {
  const { store, call, staff, sup, mgr } = demo();
  assert.throws(() => call(staff, 'availability.team.get'), (e) => e.status === 403 && translateError(e.message, 'es') !== e.message);
  assert.throws(() => call(sup, 'availability.team.get'), (e) => e.status === 403);
  store.update('settings', 'settings', { roleFeatures: { supervisor: { editAvailability: true } } });
  const r = call(sup, 'availability.team.get');
  assert.ok(r.people.length > 1);
  assert.ok(r.people.every((p) => p.role === 'employee' || p.id === sup.id), 'employees (and themselves) only');
  assert.ok(!r.people.some((p) => p.id === mgr.id));
  assert.ok(!('legalName' in find(r, staff.id)), 'no legal names for supervisors');
});

test('managers see it with "Edit staff availability" off, read only', () => {
  const { store, call, mgr, staff } = demo();
  store.update('settings', 'settings', { roleFeatures: { manager: { editAvailability: false } } });
  const r = call(mgr, 'availability.team.get');
  assert.equal(find(r, staff.id).canEdit, false);
  assert.equal(find(r, mgr.id).canEdit, true, 'their own, always');
});

test('dayStatus reads stored days the way the editor does', () => {
  assert.equal(dayStatus(undefined).status, 'open');
  assert.equal(dayStatus({ available: true, from: '', to: '' }).status, 'open');
  assert.equal(dayStatus({ available: true, to: '15:00' }).status, 'partial');
  assert.equal(dayStatus({ available: false }).status, 'off');
  assert.equal(dayStatus({ available: false, standing: true }).status, 'standing');
});

test('get_team_availability: managers read it, filtered; staff don’t get the tool', async () => {
  const { store, admin, staff } = demo();
  const db = { store, run: async (fn) => fn(store) };
  const tool = toolByName('get_team_availability');
  assert.ok(tool);
  const ctxFor = (user) => createToolContext({ db, userId: user.id, v: user.sessionVersion || 0, has: () => true, scopes: [READ], serviceOpts: { now: () => NOW }, via: 'claude', client: 'Test client' });
  const got = await runTool(tool, { week_of: '2026-09-30', only_standing: true }, ctxFor(admin));
  assert.equal(got.ok, true, got.error);
  assert.equal(got.data.weekStart, '2026-09-28');
  const p = got.data.people.find((x) => x.name === 'Juniper Hale');
  assert.equal(p.days['Monday 2026-09-28'], 'standing request off');
  assert.equal(p.days['Friday 2026-10-02'], '16:00–close (Sheet note: WOH)');
  assert.ok(got.data.people.every((x) => Object.values(x.days).some((d) => d.startsWith('standing'))));
  const no = await runTool(tool, {}, ctxFor(staff));
  assert.equal(no.ok, false);
});
