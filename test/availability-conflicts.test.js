// Availability conflicts on the schedule (core/schedule-conflicts.js): a day the person is unavailable, has a standing
// request off or approved time off blocks scheduling there (409 without overrideConflict: true, on save, move and paste);
// confirming saves it marked conflictOverride and logged; publishing tells the person once; pending time off refuses the
// save (409 pending_request, not overridable) until the request is denied; approved time off says who approved it;
// conflict-free saves answer exactly as before. Every person is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { sentence } from '../core/schedule-log.js';
import { dayConflict } from '../core/schedule-conflicts.js';
import { translateError } from '../core/errors.js';

const NOW = new Date(2026, 8, 27, 12);
const WEEK = '2026-09-28';
const WED = '2026-09-30', THU = '2026-10-01', FRI = '2026-10-02', SAT = '2026-10-03';

function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (id, name, role, extra = {}) => store.insert('users', { id, name, role, active: true, availability: {}, jobCodes: [{ jobCodeId: 'job_bar', primary: true, areas: ['Restaurant'] }], ...extra });
  const p = {
    mgr: add('usr_c_mgr', 'Juno Marsh', 'manager', { jobCodes: [{ jobCodeId: 'job_mgr', primary: true }] }),
    fri: add('usr_c_fri', 'Tobin Reyes', 'employee', { availability: { 5: { available: false, standing: true, requestedAt: '2026-08-01T12:00:00.000Z', source: 'app', note: 'Class' } } }),
    sat: add('usr_c_sat', 'Wren Ochoa', 'employee', { availability: { 6: { available: false }, 4: { available: true, from: '16:00', to: '' } } }),
    free: add('usr_c_free', 'Odile Park', 'employee'),
  };
  store.insert('timeOff', { id: 'to_c_ok', userId: p.free.id, startDate: WED, endDate: WED, status: 'approved', reason: 'Trip', requestedAt: '2026-09-01T10:00:00.000Z', decidedBy: p.mgr.id, decidedAt: '2026-09-03T15:00:00.000Z', note: 'Enjoy' });
  store.insert('timeOff', { id: 'to_c_wait', userId: p.free.id, startDate: SAT, endDate: SAT, status: 'pending', reason: 'Wedding', requestedAt: '2026-09-02T10:00:00.000Z' });
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const shift = (u, date, extra = {}) => ({ date, start: '16:00', end: '22:00', jobCodeId: 'job_bar', userId: u.id, area: 'Restaurant', published: false, ...extra });
  const notes = (u) => store.list('notifications', (n) => n.userId === u.id && n.kind === 'scheduledOverConflict');
  return { store, svc, p, call, shift, notes };
}
const conflict = (fn, kind) => assert.throws(fn, (e) => e.status === 409 && e.conflict?.kind === kind);

test('blocked days: standing request off, unavailable, approved time off; partial shows the window; pending is a request', () => {
  const { call, p } = demo();
  const r = call(p.mgr, 'schedule.conflicts', { start: WEEK, end: '2026-10-04' });
  const cell = (u, d) => r.cells.find((c) => c.userId === u.id && c.date === d);
  assert.equal(cell(p.fri, FRI).block.kind, 'standing');
  assert.equal(cell(p.fri, FRI).block.weekday, 5);
  assert.equal(cell(p.sat, SAT).block.kind, 'unavailable');
  assert.deepEqual(cell(p.sat, THU).window, { from: '16:00', to: '' });
  assert.equal(cell(p.sat, THU).block, undefined);
  assert.equal(cell(p.free, WED).block.kind, 'timeOff');
  assert.equal(cell(p.free, SAT).pending, true);
  assert.equal(cell(p.free, SAT).block, undefined, 'pending time off is not an overridable block');
  assert.equal(cell(p.free, SAT).request.id, 'to_c_wait');
  assert.equal(cell(p.free, SAT).request.canDeny, true);
  assert.equal(cell(p.free, SAT).request.requestedAt, '2026-09-02T10:00:00.000Z');
  // Approved: who approved it and when (managers only: schedule.conflicts is manager-only).
  assert.deepEqual(cell(p.free, WED).block.timeOff, { id: 'to_c_ok', startDate: WED, endDate: WED, requestedAt: '2026-09-01T10:00:00.000Z', approx: false, reason: 'Trip',
    decidedBy: p.mgr.id, decidedByName: 'Juno Marsh', decidedAt: '2026-09-03T15:00:00.000Z', decisionNote: 'Enjoy' });
  assert.equal(cell(p.free, FRI), undefined);
  assert.throws(() => call(p.fri, 'schedule.conflicts', { start: WEEK, end: '2026-10-04' }), (e) => e.status === 403);
  assert.equal(dayConflict({ id: 'x', availability: {} }, FRI, []).block, null);
});

test('save onto a blocked day: 409 with the reason, nothing saved; override saves it marked and logged', () => {
  const { call, p, shift, store } = demo();
  const before = store.list('shifts').length;
  assert.throws(() => call(p.mgr, 'shifts.save', shift(p.fri, FRI)), (e) => e.status === 409 && e.message === 'Tobin Reyes has a standing request off on Fridays. Schedule anyway?' && e.conflict.userId === p.fri.id && e.conflict.date === FRI);
  conflict(() => call(p.mgr, 'shifts.save', shift(p.sat, SAT)), 'unavailable');
  assert.throws(() => call(p.mgr, 'shifts.save', shift(p.free, WED)), (e) => e.status === 409 && e.conflict.kind === 'timeOff' && e.conflict.timeOff.decidedByName === 'Juno Marsh' && e.conflict.timeOff.requestedAt === '2026-09-01T10:00:00.000Z');
  assert.equal(store.list('shifts').length, before, 'nothing written');
  assert.equal(translateError('Tobin Reyes has a standing request off on Fridays. Schedule anyway?', 'es'), 'Tobin Reyes tiene un descanso fijo los viernes. ¿Programar de todos modos?');

  const r = call(p.mgr, 'shifts.save', { ...shift(p.fri, FRI), overrideConflict: true });
  assert.equal(r.shift.conflictOverride.reason, 'standing');
  assert.equal(r.shift.conflictOverride.by, p.mgr.id);
  assert.ok(r.shift.conflictOverride.at);
  assert.equal(r.shift.overrideConflict, undefined, 'the flag itself is never stored');
  const log = store.list('auditLog', (e) => e.action === 'schedule.shift.create' && e.details.shift?.userId === p.fri.id).at(-1);
  assert.equal(log.details.conflictOverride, 'standing');
  const names = { person: (id) => store.get('users', id)?.name, job: (id) => store.get('jobCodes', id)?.name };
  assert.match(sentence(log, 'en', names), /scheduled over a standing request off/);
  assert.match(sentence(log, 'es', names), /descanso fijo/);
  const marked = call(p.mgr, 'schedule.conflicts', { start: WEEK, end: '2026-10-04' }).shifts.find((s) => s.id === r.shift.id);
  assert.equal(marked.kind, 'standing');
  assert.equal(marked.override.reason, 'standing');

  // Editing it in place (times, notes) never asks again.
  const e = call(p.mgr, 'shifts.save', { ...r.shift, start: '17:00' });
  assert.equal(e.shift.start, '17:00');
});

test('pending time off: 409 pending_request, not overridable, until the request is denied', () => {
  const { call, p, shift, store } = demo();
  const before = store.list('shifts').length;
  const pending = (fn) => assert.throws(fn, (e) => e.status === 409 && e.conflict?.kind === 'pending_request' && e.conflict.overridable === false &&
    e.conflict.request.id === 'to_c_wait' && e.message === 'Odile Park requested off 2026-10-03 (requested 2026-09-02). Deny the request before scheduling them.');
  pending(() => call(p.mgr, 'shifts.save', shift(p.free, SAT)));
  pending(() => call(p.mgr, 'shifts.save', { ...shift(p.free, SAT), overrideConflict: true }));
  const s = call(p.mgr, 'shifts.save', shift(p.free, FRI)).shift;
  pending(() => call(p.mgr, 'shifts.move', { id: s.id, date: SAT, overrideConflict: true }));
  assert.equal(store.get('shifts', s.id).date, FRI, 'not moved');
  assert.equal(store.list('shifts').length, before + 1, 'nothing else written');
  assert.equal(translateError('Odile Park requested off 2026-10-03 (requested 2026-09-02). Deny the request before scheduling them.', 'es'),
    'Odile Park pidió libre el 2026-10-03 (lo pidió el 2026-09-02). Rechaza la solicitud antes de programarle.');
  // Someone who can't decide it (the approver's scope leaves out the bar) is told who can.
  store.insert('users', { id: 'usr_c_sup', name: 'Ines Halvorsen', role: 'manager', active: true, jobCodes: [{ jobCodeId: 'job_mgr', primary: true }], approvalScope: { mode: 'include', positions: ['job_mgr'], rooms: [], timeOff: true } });
  assert.throws(() => call({ id: 'usr_c_sup' }, 'shifts.save', shift(p.free, SAT)), (e) => e.conflict?.kind === 'pending_request' && e.conflict.request.canDeny === false && e.conflict.request.deciders.length > 0 && !e.conflict.request.deciders.includes('Ines Halvorsen') && e.conflict.request.position === 'Bartender');
  // Deny it, then the save goes through like any other.
  call(p.mgr, 'timeOff.decide', { id: 'to_c_wait', status: 'denied', note: 'Short-staffed' });
  const r = call(p.mgr, 'shifts.save', shift(p.free, SAT));
  assert.equal(r.shift.date, SAT);
  assert.equal(r.shift.conflictOverride, undefined);
  assert.deepEqual(r.warnings, []);
});

test('paste skips a day with a pending request, saying so; the rest is pasted', () => {
  const { call, p, shift } = demo();
  const s = call(p.mgr, 'shifts.save', shift(p.free, THU)).shift;
  const r = call(p.mgr, 'shifts.pasteMany', { fromId: s.id, targets: [{ userId: p.free.id, date: SAT }, { userId: p.free.id, date: FRI }], confirmOff: true });
  assert.equal(r.done, true);
  assert.deepEqual(r.items.map((x) => x.date), [FRI]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'pending_request');
  assert.equal(r.skipped[0].request.id, 'to_c_wait');
});

test('move and paste onto a blocked day ask too', () => {
  const { call, p, shift, store } = demo();
  const s = call(p.mgr, 'shifts.save', shift(p.fri, THU)).shift;
  conflict(() => call(p.mgr, 'shifts.move', { id: s.id, date: FRI }), 'standing');
  assert.equal(store.get('shifts', s.id).date, THU, 'not moved');
  conflict(() => call(p.mgr, 'shifts.move', { id: s.id, userId: p.sat.id, date: SAT }), 'unavailable');
  const m = call(p.mgr, 'shifts.move', { id: s.id, date: FRI, overrideConflict: true });
  assert.equal(m.moved, true);
  assert.equal(m.shift.conflictOverride.reason, 'standing');
  const mv = store.list('auditLog', (e) => e.action === 'schedule.shift.move').at(-1);
  assert.equal(mv.details.conflictOverride, 'standing');
  // Moved off it to a free day: the mark goes.
  const back = call(p.mgr, 'shifts.move', { id: s.id, date: THU });
  assert.equal(back.shift.conflictOverride, null);

  // Paste asks (needs.off) and, confirmed, saves it marked.
  const ask = call(p.mgr, 'shifts.pasteMany', { fromId: s.id, targets: [{ userId: p.sat.id, date: SAT }] });
  assert.equal(ask.done, false);
  assert.deepEqual(ask.needs.off.map((o) => o.codes), [['unavailable']]);
  const ok = call(p.mgr, 'shifts.pasteMany', { fromId: s.id, targets: [{ userId: p.sat.id, date: SAT }], confirmOff: true });
  assert.equal(ok.done, true);
  assert.equal(ok.items[0].shift.conflictOverride.reason, 'unavailable');
  assert.equal(store.list('auditLog', (e) => e.action === 'schedule.shift.paste').at(-1).details.conflictOverride, 'unavailable');
});

test('publish: each person scheduled over a blocked day is told once, with the manager’s name', () => {
  const { call, p, shift, notes, svc } = demo();
  call(p.mgr, 'shifts.save', { ...shift(p.fri, FRI), overrideConflict: true });
  call(p.mgr, 'shifts.save', shift(p.free, THU));
  const r = call(p.mgr, 'shifts.publish', { start: WEEK, end: '2026-10-04' });
  assert.equal(r.conflictsNotified, 1);
  const [n] = notes(p.fri);
  assert.ok(n, 'told');
  assert.match(n.text, /^Juno Marsh scheduled you for .*over your standing request off/);
  assert.match(n.i18n.es, /descanso fijo/);
  assert.equal(notes(p.free).length, 0, 'conflict-free: only the usual notice');
  // Unpublish and publish again, nothing changed: not told twice.
  call(p.mgr, 'shifts.unpublish', { start: WEEK, end: '2026-10-04', notify: false });
  const again = call(p.mgr, 'shifts.publish', { start: WEEK, end: '2026-10-04' });
  assert.equal(again.conflictsNotified, undefined);
  assert.equal(notes(p.fri).length, 1);
  // Silent publish tells nobody (like the rest of the publish).
  call(p.mgr, 'shifts.save', { ...shift(p.sat, SAT), overrideConflict: true });
  call(p.mgr, 'shifts.publish', { start: WEEK, end: '2026-10-04', notify: false });
  assert.equal(notes(p.sat).length, 0);
  assert.ok(svc);
});

test('conflict-free saves answer exactly as before (no new fields, no new notifications)', () => {
  const { call, p, shift, store } = demo();
  const r = call(p.mgr, 'shifts.save', shift(p.free, FRI));
  assert.deepEqual(Object.keys(r).sort(), ['shift', 'warnings']);
  assert.equal('conflictOverride' in r.shift, false);
  assert.deepEqual(r.warnings, []);
  const pub = call(p.mgr, 'shifts.publish', { start: FRI, end: FRI });
  assert.deepEqual(Object.keys(pub).sort(), ['notified', 'published', 'silent']);
  assert.equal(store.list('notifications', (n) => n.kind === 'scheduledOverConflict').length, 0);
});
