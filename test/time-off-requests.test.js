// Time off: when each request came in, who asked first, and managers adding requests for staff (core/time-off.js).
//   - the requested date is kept and never changes on approve, deny or edit; old requests are backfilled
//   - the order across overlapping requests, ties broken by the exact time; names for approvers, a place for staff
//   - a manager adds time off for someone: how it came in, when they asked (never the future), approved by default,
//     the person told (or not), clashing shifts listed and never removed; standing requests in bulk
//   - the connector: request_time_off for someone (confirm), get_time_off / get_pending_approvals with the order
// Every person here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { requestedOf, timeOffQueue } from '../core/time-off.js';
import { translateError } from '../core/errors.js';
import { toolByName, runTool, createToolContext, READ, WRITE } from '../server/tools/index.js';
import { startApp } from './helpers/app.js';

let clock = new Date(2026, 10, 3, 16, 12);
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: new Date(2026, 10, 3, 12) });
  for (const t of store.list('timeOff')) store.remove('timeOff', t.id);
  const svc = createService(store, { now: () => clock });
  const add = (id, name, role = 'employee') => store.insert('users', { id, name, role, active: true, availability: {}, jobCodes: [{ jobCodeId: 'job_srv', primary: true }] });
  const p = { a: add('usr_t_a', 'Mira Holt'), b: add('usr_t_b', 'Owen Pike'), c: add('usr_t_c', 'Lena Shaw'), mgr: add('usr_t_m', 'Cass Rowan', 'manager') };
  return { store, p, call: (u, m, a = {}) => svc.call(store.get('users', u.id), m, a) };
}
const at = (d, h, m = 0, s = 0) => { clock = new Date(2026, 10, d, h, m, s); };

test('the requested date: kept as asked, never changed by a decision; old requests backfilled', () => {
  const { store, p, call } = demo();
  at(3, 16, 12);
  const t = call(p.a, 'timeOff.create', { startDate: '2026-12-13' });
  assert.equal(t.requestedAt, new Date(2026, 10, 3, 16, 12).toISOString());
  at(5, 9);
  call(p.mgr, 'timeOff.decide', { id: t.id, status: 'approved' });
  assert.equal(store.get('timeOff', t.id).requestedAt, t.requestedAt, 'approving never changes it');
  call(p.mgr, 'timeOff.decide', { id: t.id, status: 'denied' });
  assert.equal(store.get('timeOff', t.id).requestedAt, t.requestedAt);
  // Older requests: createdAt is the same moment; with nothing, the decision time, marked approximate.
  assert.deepEqual(requestedOf({ createdAt: '2026-01-01T10:00:00.000Z' }), { at: '2026-01-01T10:00:00.000Z', approx: false });
  assert.deepEqual(requestedOf({ decidedAt: '2026-01-02T10:00:00.000Z' }), { at: '2026-01-02T10:00:00.000Z', approx: true });
  assert.deepEqual(requestedOf({}), { at: null, approx: true });
});

test('first come, first served: the order on overlapping days, ties by the exact time; names for approvers only', () => {
  const { p, call } = demo();
  at(3, 16, 12, 5);
  const first = call(p.b, 'timeOff.create', { startDate: '2026-12-12', endDate: '2026-12-13' });
  at(3, 16, 12, 9); // four seconds later: second
  const second = call(p.a, 'timeOff.create', { startDate: '2026-12-13' });
  at(4, 8);
  const third = call(p.c, 'timeOff.create', { startDate: '2026-12-13' });
  const q = call(p.mgr, 'timeOff.queue');
  assert.deepEqual([q[first.id].place, q[second.id].place, q[third.id].place], [1, 2, 3]);
  assert.equal(q[third.id].of, 3);
  assert.equal(q[third.id].date, '2026-12-13');
  assert.deepEqual(q[third.id].others.map((o) => o.name), ['Owen Pike', 'Mira Holt']);
  const mine = call(p.c, 'timeOff.queue');
  assert.deepEqual(Object.keys(mine), [third.id], 'staff see only their own requests');
  assert.deepEqual([mine[third.id].place, mine[third.id].of, mine[third.id].others], [3, 3, undefined], 'their place in line, no names');
  // A denied request leaves the line.
  call(p.mgr, 'timeOff.decide', { id: first.id, status: 'denied' });
  assert.equal(call(p.mgr, 'timeOff.queue')[third.id].place, 2);
  assert.ok(timeOffQueue([], []), 'empty is fine');
});

test('a manager adds time off: how it came in, when they asked, approved by default, the person told, shifts left alone', () => {
  const { store, p, call } = demo();
  at(20, 10);
  const shift = store.insert('shifts', { date: '2026-12-13', start: '16:00', jobCodeId: 'job_srv', userId: p.a.id, area: '', published: true, tag: '', notes: '', breakMin: 0 });
  const conflicts = call(p.mgr, 'timeOff.clashes', { userId: p.a.id, startDate: '2026-12-13' });
  assert.deepEqual(conflicts.map((s) => s.id), [shift.id], 'warned first');
  const t = call(p.mgr, 'timeOff.create', { userId: p.a.id, startDate: '2026-12-13', reason: 'Wedding', source: 'email', requestedAt: '2026-11-03' });
  assert.deepEqual([t.status, t.source, t.enteredBy, t.requestedAt.slice(0, 10), t.enteredAt.slice(0, 10)], ['approved', 'email', p.mgr.id, '2026-11-03', clock.toISOString().slice(0, 10)]);
  assert.deepEqual(t.clashShifts.map((s) => s.id), [shift.id]);
  assert.equal(store.get('shifts', shift.id).userId, p.a.id, 'never removed silently');
  const told = store.list('notifications', (n) => n.userId === p.a.id && n.kind === 'timeOffAdded');
  assert.equal(told.length, 1);
  assert.match(told[0].text, /Cass Rowan added time off for you: .* \(approved\)/);
  const q = call(p.mgr, 'timeOff.queue')[t.id];
  assert.deepEqual([q.source, q.enteredByName], ['email', 'Cass Rowan']);
  // Pending, not told.
  const quiet = call(p.mgr, 'timeOff.create', { userId: p.b.id, startDate: '2026-12-20', status: 'pending', notify: false, source: 'phone' });
  assert.equal(quiet.status, 'pending');
  assert.equal(store.list('notifications', (n) => n.userId === p.b.id && n.kind === 'timeOffAdded').length, 0);
  // Never in the future; staff can't add for others.
  assert.throws(() => call(p.mgr, 'timeOff.create', { userId: p.a.id, startDate: '2026-12-14', requestedAt: '2027-01-01' }), (e) => e.status === 400 && e.message === 'The request date can’t be in the future');
  assert.equal(translateError('The request date can’t be in the future', 'es'), 'La fecha de la solicitud no puede ser en el futuro');
  assert.throws(() => call(p.b, 'timeOff.create', { userId: p.a.id, startDate: '2026-12-14' }), (e) => e.status === 403);
  // Standing requests in bulk ("every Sunday"), keeping when they first asked.
  const out = call(p.mgr, 'timeOff.addStanding', { rows: [{ userId: p.a.id, days: [0], reason: 'Church', requestedAt: '2026-10-01', source: 'in_person' }, { userId: p.b.id, days: [1, 2] }] });
  assert.equal(out.added, 2);
  assert.deepEqual([store.get('users', p.a.id).availability[0].standing, store.get('users', p.a.id).availability[0].requestedAt.slice(0, 10)], [true, '2026-10-01']);
  call(p.mgr, 'timeOff.addStanding', { rows: [{ userId: p.a.id, days: [0], requestedAt: '2026-11-01' }] });
  assert.equal(store.get('users', p.a.id).availability[0].requestedAt.slice(0, 10), '2026-10-01', 'it keeps the date they first asked');
  const hist = call(p.a, 'availability.history');
  assert.ok(hist.some((e) => e.days.some((d) => d.after.standing)), 'the history shows it');
});

// ---------- the connector ----------
let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });

test('MCP: request_time_off for someone (confirm, source, requestedAt); the order in get_time_off and get_pending_approvals', async () => {
  const store = A.db.store;
  const mgr = store.list('users', (u) => u.role === 'manager' && u.active !== false)[0];
  const emp = store.list('users', (u) => u.role === 'employee' && u.active !== false)[0];
  const other = store.list('users', (u) => u.role === 'employee' && u.active !== false)[1];
  const ctx = (u) => createToolContext({ db: A.db, userId: u.id, v: 0, has: () => true, scopes: [READ, WRITE], via: 'claude', client: 'Test' });
  const tool = toolByName('request_time_off');
  const ask = await runTool(tool, { startDate: '2027-02-10', person: emp.name, source: 'text', requestedAt: '2026-11-01' }, ctx(mgr));
  assert.deepEqual([ask.ok, ask.status], [false, 409]);
  const done = await runTool(tool, { startDate: '2027-02-10', person: emp.name, source: 'text', requestedAt: '2026-11-01', status: 'pending', confirm: true }, ctx(mgr));
  assert.equal(done.ok, true, done.error);
  assert.deepEqual([done.data.cameIn, done.data.status, done.data.requestedAt.slice(0, 10)], ['text', 'pending', '2026-11-01']);
  await runTool(tool, { startDate: '2027-02-10' }, ctx(other)); // their own, asked now: second in line
  const pending = await runTool(toolByName('get_pending_approvals'), {}, ctx(mgr));
  const mine = pending.data.timeOff.filter((t) => t.from === '2027-02-10');
  assert.deepEqual(mine.map((t) => t.person), [emp.name, other.name], 'oldest request first');
  assert.match(mine[0].order, /^1st of 2 for 2027-02-10$/);
  assert.equal(mine[0].requestedAt.slice(0, 10), '2026-11-01');
  assert.equal(mine[0].cameIn, 'text');
  assert.equal(mine[1].othersInLine[0].person, emp.name);
  const own = await runTool(toolByName('get_time_off'), {}, ctx(other));
  const t = own.data.timeOff.find((x) => x.from === '2027-02-10');
  assert.match(t.order, /^2nd of 2/);
  assert.equal(t.othersInLine, undefined, 'no other names for staff');
});
