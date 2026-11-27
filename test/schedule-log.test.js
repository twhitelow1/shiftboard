// The schedule log (core/schedule-log.js): every schedule change writes an entry with who, via and before → after;
// the managers' viewer filters it; staff see only what affected them; CSV export; a failing log write never blocks.
// Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { scheduleLogger, sentence } from '../core/schedule-log.js';

const NOW = new Date(2026, 8, 27, 12);
function demo(opts = {}) {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW, ...opts });
  const add = (id, name, role = 'employee', jobs = ['job_bar']) => store.insert('users', { id, name, role, active: true, availability: {}, jobCodes: jobs.map((jobCodeId) => ({ jobCodeId })) });
  const p = { mgr: add('usr_t_mgr', 'Moss Avery', 'manager', []), a: add('usr_t_a', 'Ren Calder'), b: add('usr_t_b', 'Fay Dunn'), c: add('usr_t_c', 'Hal Ives') };
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const log = () => store.list('auditLog', (e) => e.action.startsWith('schedule.')).sort((x, y) => x.at.localeCompare(y.at));
  const last = (what) => log().filter((e) => e.action === `schedule.${what}`).at(-1);
  return { store, p, call, log, last, svc };
}

test('each kind of change writes an entry, with via and before → after', () => {
  const { store, p, call, last } = demo();
  const s = call(p.mgr, 'shifts.save', { date: '2026-10-03', start: '16:00', jobCodeId: 'job_bar', userId: p.a.id, area: 'Restaurant' }).shift;
  assert.equal(last('shift.create').via, 'web');
  call(p.mgr, 'shifts.save', { ...s, start: '17:00' });
  const edit = last('shift.edit');
  assert.deepEqual(edit.details.changes, [{ field: 'start', before: '16:00', after: '17:00' }]);
  assert.deepEqual(edit.details.affected, [p.a.id]);
  assert.match(sentence(edit, 'en', { person: (id) => store.get('users', id)?.name, job: (id) => store.get('jobCodes', id)?.name }),
    /^Moss Avery changed Ren Calder’s Sat, Oct 3 4p Bartender shift \(Restaurant\): time 4p → 5p$/);
  call(p.mgr, 'shifts.publish', { start: '2026-10-03', end: '2026-10-03' });
  assert.ok(last('week.publish').details.count >= 1);
  call(p.mgr, 'notes.save', { kind: 'day', date: '2026-10-03', text: 'Private party' });
  assert.deepEqual(last('note.save').details.changes, [{ field: 'notes', before: '', after: 'Private party' }]);
  // Trades: request, accept, approve.
  const r = call(p.a, 'swaps.create', { shiftId: s.id, type: 'drop' });
  assert.equal(last('request.create').details.type, 'drop');
  call(p.b, 'swaps.accept', { requestId: r.id });
  call(p.mgr, 'swaps.approve', { requestId: r.id });
  assert.deepEqual(last('request.approve').details.changes, [{ field: 'userId', before: p.a.id, after: p.b.id }]);
  // Time off: create, manager-added, approve, cancel.
  const t = call(p.c, 'timeOff.create', { startDate: '2026-10-10' });
  call(p.mgr, 'timeOff.decide', { id: t.id, status: 'approved' });
  assert.deepEqual(last('timeOff.approve').details.changes, [{ field: 'status', before: 'pending', after: 'approved' }]);
  call(p.mgr, 'timeOff.create', { userId: p.c.id, startDate: '2026-10-11', source: 'email' });
  assert.equal(last('timeOff.add').details.source, 'email');
  call(p.c, 'timeOff.cancel', { id: t.id });
  assert.ok(last('timeOff.cancel'));
  // Availability, MOD override, copy week, clear drafts, delete.
  call(p.mgr, 'employees.setAvailability', { userId: p.a.id, availability: { 1: { available: false } } });
  assert.deepEqual(last('availability.change').details.affected, [p.a.id]);
  call(p.mgr, 'mod.setOverride', { date: '2026-10-03', userId: p.mgr.id });
  assert.equal(last('mod.set').details.changes[0].after, p.mgr.id);
  call(p.mgr, 'shifts.copyWeek', { fromWeek: '2026-09-28', toWeek: '2026-10-05' });
  assert.ok(last('week.copy').details.count > 0);
  call(p.mgr, 'shifts.clearDrafts', { weekStart: '2026-10-05' });
  assert.ok(last('drafts.clear'));
  call(p.mgr, 'shifts.delete', { id: s.id });
  assert.equal(last('shift.delete').details.shift.userId, p.b.id);
  // Never secrets: nothing like a password in any entry.
  assert.ok(!JSON.stringify(store.list('auditLog')).includes('passwordHash'));
});

test('via: the connector, Ask ShiftBoard, the phone app, imports', () => {
  for (const [opts, via] of [[{ via: 'claude' }, 'connector'], [{ via: 'assistant' }, 'assistant'], [{ request: { phone: true } }, 'phone'], [{ request: {} }, 'web']]) {
    const { p, call, last } = demo(opts);
    call(p.mgr, 'shifts.save', { date: '2026-10-03', start: '16:00', jobCodeId: 'job_bar', userId: p.a.id });
    assert.equal(last('shift.create').via, via);
  }
});

test('the viewer filters (dates, person, type, position, via); staff see only theirs; CSV export', () => {
  const { p, call } = demo();
  call(p.mgr, 'shifts.save', { date: '2026-10-03', start: '16:00', jobCodeId: 'job_bar', userId: p.a.id, area: 'Restaurant' });
  call(p.mgr, 'shifts.save', { date: '2026-10-20', start: '16:00', jobCodeId: 'job_srv', userId: p.b.id });
  call(p.c, 'timeOff.create', { startDate: '2026-10-10' });
  const all = call(p.mgr, 'scheduleLog.list', {});
  assert.ok(all.length >= 3);
  assert.ok(all[0].text && all[0].link);
  assert.deepEqual(call(p.mgr, 'scheduleLog.list', { person: p.a.id }).map((r) => r.action), ['shift.create']);
  assert.deepEqual(call(p.mgr, 'scheduleLog.list', { group: 'timeOff' }).map((r) => r.action), ['timeOff.create']);
  assert.equal(call(p.mgr, 'scheduleLog.list', { from: '2026-10-15', to: '2026-10-31', group: 'shift' }).length, 1);
  assert.equal(call(p.mgr, 'scheduleLog.list', { jobCodeId: 'job_srv' }).length, 1);
  assert.equal(call(p.mgr, 'scheduleLog.list', { room: 'restaurant' }).length, 1);
  assert.equal(call(p.mgr, 'scheduleLog.list', { via: 'phone' }).length, 0);
  assert.throws(() => call(p.a, 'scheduleLog.list', {}), (e) => e.status === 403);
  const mine = call(p.a, 'scheduleLog.mine', {});
  assert.deepEqual(mine.map((r) => r.action), ['shift.create']);
  assert.equal(mine[0].affected, undefined, 'no list of other people');
  const es = call(p.mgr, 'scheduleLog.list', { person: p.a.id });
  assert.match(es[0].text, /added Ren Calder’s/);
  const csv = call(p.mgr, 'scheduleLog.csv', {});
  assert.match(csv.csv, /^﻿When,Who,Via,What,Schedule date,Changes\r\n/);
  assert.equal(csv.rows, all.length);
});

test('a log write that fails never blocks the change', () => {
  const store = new MemoryStore();
  const broken = { insert: () => { throw new Error('disk full'); } };
  const err = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try {
    scheduleLogger({ store: broken, now: () => NOW, uid: () => 'x', via: () => 'web' })({ id: 'u' }, 'shift.create', { shift: { id: 's', date: '2026-10-03', userId: 'u' } });
  } finally { console.error = err; }
  assert.ok(seen.some((s) => /not written/.test(s)));
  // And in the service: a store whose auditLog insert throws still saves the shift.
  seedDemo(store, { now: NOW });
  const insert = store.insert.bind(store);
  store.insert = (col, doc) => { if (col === 'auditLog') throw new Error('log down'); return insert(col, doc); };
  console.error = () => {};
  try {
    const mgr = store.list('users', (u) => u.role === 'manager')[0];
    const out = createService(store, { now: () => NOW }).call(mgr, 'shifts.save', { date: '2026-10-03', start: '16:00', jobCodeId: 'job_bar' });
    assert.ok(store.get('shifts', out.shift.id));
  } finally { console.error = err; }
});
