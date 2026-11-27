// Quick shifts from a schedule cell (core/quick-shift.js): moving a shift keeps its id and logs a move (never a
// delete + create); days off are their own records (shown as DAY OFF, never a shift or hours), logged, and make a
// shift on that day warn without blocking it. Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { sentence } from '../core/schedule-log.js';

const NOW = new Date(2026, 8, 27, 12);
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (id, name, role = 'employee') => store.insert('users', { id, name, role, active: true, availability: {}, jobCodes: [{ jobCodeId: 'job_bar' }] });
  const p = { mgr: add('usr_q_mgr', 'Juno Marsh', 'manager'), a: add('usr_q_a', 'Tobin Reyes'), b: add('usr_q_b', 'Wren Ochoa') };
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const log = (what) => store.list('auditLog', (e) => e.action === `schedule.${what}`);
  const names = { person: (id) => store.get('users', id)?.name, job: (id) => store.get('jobCodes', id)?.name };
  return { store, p, call, log, names };
}

test('shifts.move: same id, new date and person, logged as a move, not a create or delete', () => {
  const { store, p, call, log, names } = demo();
  const s = call(p.mgr, 'shifts.save', { date: '2026-10-01', start: '16:00', jobCodeId: 'job_bar', userId: p.a.id, area: 'Restaurant', tag: 'BAR 1' }).shift;
  const before = store.list('shifts').length;
  const r = call(p.mgr, 'shifts.move', { id: s.id, date: '2026-10-02', userId: p.b.id });
  assert.equal(r.moved, true);
  assert.equal(r.shift.id, s.id, 'the same shift');
  assert.equal(store.list('shifts').length, before, 'no new shift');
  const moved = store.get('shifts', s.id);
  assert.equal(moved.date, '2026-10-02');
  assert.equal(moved.userId, p.b.id);
  assert.equal(moved.start, '16:00', 'what was not given stays');
  assert.equal(moved.tag, 'BAR 1');
  assert.equal(log('shift.move').length, 1);
  assert.equal(log('shift.delete').length, 0);
  assert.equal(log('shift.create').length, 1, 'only the original add');
  const e = log('shift.move')[0];
  assert.deepEqual(e.details.changes.map((c) => c.field).sort(), ['date', 'userId']);
  assert.ok(e.details.affected.includes(p.a.id) && e.details.affected.includes(p.b.id), 'both people see it in their changes');
  assert.match(sentence(e, 'en', names), /^Juno Marsh moved Tobin Reyes’s Thu, Oct 1 4p Bartender shift/);
  assert.match(sentence(e, 'es', names), /^Juno Marsh movió /);
  // A plain edit is still an edit.
  call(p.mgr, 'shifts.save', { ...moved, start: '17:00' });
  assert.equal(log('shift.edit').length, 1);
  assert.equal(log('shift.move').length, 1);
});

test('shifts.move: published shifts tell both people; managers only; unknown shift is 404', () => {
  const { store, p, call } = demo();
  const s = call(p.mgr, 'shifts.save', { date: '2026-10-01', start: '16:00', jobCodeId: 'job_bar', userId: p.a.id, published: true }).shift;
  call(p.mgr, 'shifts.move', { id: s.id, userId: p.b.id });
  const told = (u) => store.list('notifications', (n) => n.userId === u.id).map((n) => n.text).join('\n');
  assert.match(told(p.a), /./);
  assert.match(told(p.b), /./);
  assert.throws(() => call(p.a, 'shifts.move', { id: s.id, date: '2026-10-03' }), (e) => e.status === 403);
  assert.throws(() => call(p.mgr, 'shifts.move', { id: 'shf_nope', date: '2026-10-03' }), (e) => e.status === 404);
});

test('day off: removes that day’s shifts, is its own record, logged, listed, undone; a later shift warns, never blocked', () => {
  const { store, p, call, log, names } = demo();
  const s = call(p.mgr, 'shifts.save', { date: '2026-10-01', start: '16:00', jobCodeId: 'job_bar', userId: p.a.id }).shift;
  const r = call(p.mgr, 'schedule.dayOff.set', { userId: p.a.id, date: '2026-10-01', removeShifts: true });
  assert.equal(r.removed, 1);
  assert.equal(store.get('shifts', s.id), null, 'the shift is gone');
  assert.equal(log('shift.delete').length, 1, 'the removal is logged like any delete');
  assert.equal(log('dayOff.set').length, 1);
  assert.match(sentence(log('dayOff.set')[0], 'en', names), /Juno Marsh marked Tobin Reyes off on Thu, Oct 1/);
  assert.ok(sentence(log('dayOff.set')[0], 'es', names).includes('descanso'));
  // Setting it again changes nothing and logs nothing.
  call(p.mgr, 'schedule.dayOff.set', { userId: p.a.id, date: '2026-10-01' });
  assert.equal(store.list('daysOff').length, 1);
  assert.equal(log('dayOff.set').length, 1);

  const list = call(p.mgr, 'schedule.dayOff.list', { start: '2026-09-28', end: '2026-10-04' });
  assert.deepEqual(list.map((d) => [d.userId, d.date]), [[p.a.id, '2026-10-01']]);
  assert.equal(call(p.a, 'schedule.dayOff.list', { start: '2026-09-28', end: '2026-10-04' }).length, 1, 'staff see it on the schedule too');

  // Not a shift: no hours, nothing in shifts.list.
  const week = call(p.mgr, 'shifts.list', { start: '2026-09-28', end: '2026-10-04' });
  assert.equal(week.shifts.filter((x) => x.userId === p.a.id && x.date === '2026-10-01').length, 0);

  // Adding a shift on that day works, with a warning.
  const again = call(p.mgr, 'shifts.save', { date: '2026-10-01', start: '11:00', end: '15:00', jobCodeId: 'job_bar', userId: p.a.id });
  assert.ok(again.shift.id);
  assert.ok(again.warnings.includes('Marked as a day off'), again.warnings.join(' | '));
  // Moving a shift onto someone's day off warns too.
  const other = call(p.mgr, 'shifts.save', { date: '2026-10-02', start: '16:00', jobCodeId: 'job_bar', userId: p.b.id }).shift;
  call(p.mgr, 'schedule.dayOff.set', { userId: p.b.id, date: '2026-10-03' });
  assert.ok(call(p.mgr, 'shifts.move', { id: other.id, date: '2026-10-03' }).warnings.includes('Marked as a day off'));

  // Undo.
  assert.equal(call(p.mgr, 'schedule.dayOff.clear', { userId: p.a.id, date: '2026-10-01' }).cleared, true);
  assert.equal(log('dayOff.clear').length, 1);
  assert.equal(call(p.mgr, 'schedule.dayOff.clear', { userId: p.a.id, date: '2026-10-01' }).cleared, false);
  assert.equal(call(p.mgr, 'shifts.save', { date: '2026-10-01', start: '17:00', jobCodeId: 'job_bar', userId: p.a.id }).warnings.includes('Marked as a day off'), false);

  // Managers only.
  assert.throws(() => call(p.a, 'schedule.dayOff.set', { userId: p.a.id, date: '2026-10-05' }), (e) => e.status === 403);
  assert.throws(() => call(p.a, 'schedule.dayOff.clear', { userId: p.b.id, date: '2026-10-03' }), (e) => e.status === 403);
  assert.throws(() => call(p.mgr, 'schedule.dayOff.set', { userId: 'usr_nobody', date: '2026-10-05' }), (e) => e.status === 400);
});
