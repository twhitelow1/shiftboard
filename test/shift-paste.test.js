// Copy & paste a shift (core/shift-paste.js): a pasted shift is a new draft for the target row's person on the target
// day with the copied times, tag and notes; its position follows the row, else the copied one if they hold it, else
// their primary; giving someone a position, pasting over a shift and pasting on a day off / time off are asked first
// (nothing written until then); each paste is logged "pasted from <person>'s <day> shift". Every person is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { sentence } from '../core/schedule-log.js';
import { pastePosition } from '../core/shift-paste.js';

const NOW = new Date(2026, 8, 27, 12);
const THU = '2026-10-01', FRI = '2026-10-02', SAT = '2026-10-03';
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (id, name, jobCodes, role = 'employee') => store.insert('users', { id, name, role, active: true, availability: {}, jobCodes });
  const p = {
    mgr: add('usr_p_mgr', 'Juno Marsh', [{ jobCodeId: 'job_mgr', primary: true }], 'manager'),
    a: add('usr_p_a', 'Tobin Reyes', [{ jobCodeId: 'job_bar', primary: true, areas: ['Restaurant'] }]),
    b: add('usr_p_b', 'Wren Ochoa', [{ jobCodeId: 'job_bar', primary: true, areas: ['Restaurant'] }]),
    srv: add('usr_p_srv', 'Odile Park', [{ jobCodeId: 'job_srv', primary: true, areas: ['Restaurant'] }, { jobCodeId: 'job_fr', areas: ['Restaurant'] }]),
    rh: add('usr_p_rh', 'Casper Lund', [{ jobCodeId: 'job_bar', primary: true, areas: ['Rabbit Hole'] }]),
    none: add('usr_p_none', 'Imre Vale', []),
    staff: add('usr_p_staff', 'Pia Torres', [{ jobCodeId: 'job_bar', areas: ['Restaurant'] }]),
  };
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const log = (what) => store.list('auditLog', (e) => e.action === `schedule.${what}`);
  const names = { person: (id) => store.get('users', id)?.name, job: (id) => store.get('jobCodes', id)?.name };
  const src = call(p.mgr, 'shifts.save', { date: THU, start: '16:00', end: null, jobCodeId: 'job_bar', userId: p.a.id, area: 'Restaurant', tag: 'BAR 1', notes: 'Cut fruit first', published: true }).shift;
  const on = (u, d) => store.list('shifts', (s) => s.userId === u.id && s.date === d);
  return { store, p, call, log, names, src, on };
}

test('paste: a new draft for the row’s person and the column’s day, keeping the times, tag and notes', () => {
  const { p, call, src, on, store } = demo();
  const r = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: SAT }] });
  assert.equal(r.done, true);
  assert.equal(r.created, 1);
  const [s] = on(p.b, SAT);
  assert.ok(s && s.id !== src.id, 'a new shift');
  assert.equal(s.userId, p.b.id, 'that row’s person');
  assert.equal(s.date, SAT, 'that column’s day');
  assert.deepEqual([s.start, s.end, s.tag, s.notes], ['16:00', null, 'BAR 1', 'Cut fruit first'], 'in time, until close, tag and notes kept');
  assert.equal(s.jobCodeId, 'job_bar');
  assert.equal(s.area, 'Restaurant');
  assert.equal(s.published, false, 'a draft, even from a published shift');
  assert.equal(store.get('shifts', src.id).userId, p.a.id, 'the copied shift is untouched');
  // Several cells at once (a column): one shift each.
  const m = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.a.id, date: FRI }, { userId: p.a.id, date: SAT }, { userId: p.a.id, date: SAT }] });
  assert.equal(m.created, 2, 'the same cell twice counts once');
  // The copied shift deleted since: the remembered copy still pastes.
  call(p.mgr, 'shifts.delete', { id: src.id });
  const g = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, from: { ...src }, targets: [{ userId: p.b.id, date: FRI }] });
  assert.equal(g.created, 1);
  assert.equal(on(p.b, FRI)[0].start, '16:00');
});

test('paste: position from the row, else the copied one if they hold it, else their primary', () => {
  const { p, call, src, on, store } = demo();
  const jobs = Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  assert.deepEqual(pastePosition({ person: p.srv, src, row: null, jobs }), { jobCodeId: 'job_srv', room: 'Restaurant' }, 'primary position');
  assert.deepEqual(pastePosition({ person: p.rh, src, row: null, jobs }), { jobCodeId: 'job_bar', room: 'Rabbit Hole' }, 'their room for the copied position');
  assert.deepEqual(pastePosition({ person: p.srv, src, row: { jobCodeId: 'job_fr', area: 'Restaurant' }, jobs }), { jobCodeId: 'job_fr', room: 'Restaurant' }, 'the row wins');
  call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.srv.id, date: FRI }, { userId: p.rh.id, date: FRI }, { userId: p.srv.id, date: SAT, jobCodeId: 'job_fr', area: 'Restaurant' }] });
  assert.equal(on(p.srv, FRI)[0].jobCodeId, 'job_srv');
  assert.equal(on(p.rh, FRI)[0].jobCodeId, 'job_bar');
  assert.equal(on(p.rh, FRI)[0].area, 'Rabbit Hole');
  assert.equal(on(p.srv, SAT)[0].jobCodeId, 'job_fr');
});

test('paste: someone who doesn’t hold the position there is asked first, then given it', () => {
  const { p, call, src, on, store } = demo();
  const before = store.list('shifts').length;
  const r = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.none.id, date: FRI }, { userId: p.b.id, date: FRI }] });
  assert.equal(r.done, false);
  assert.deepEqual(r.needs.position.map((x) => [x.userId, x.jobCodeId, x.room]), [[p.none.id, 'job_bar', 'Restaurant']]);
  assert.equal(store.list('shifts').length, before, 'nothing written, not even the clear cell');
  const ok = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, givePosition: true, targets: [{ userId: p.none.id, date: FRI }, { userId: p.b.id, date: FRI }] });
  assert.equal(ok.created, 2);
  assert.equal(on(p.none, FRI)[0].jobCodeId, 'job_bar');
  assert.ok(store.get('users', p.none.id).jobCodes.some((e) => e.jobCodeId === 'job_bar'), 'now listed in that section');
});

test('paste over a shift: asked; replace keeps its id, add makes another', () => {
  const { p, call, src, on, store, log } = demo();
  const there = call(p.mgr, 'shifts.save', { date: FRI, start: '11:00', end: '15:00', jobCodeId: 'job_bar', userId: p.b.id, area: 'Restaurant', tag: 'LUNCH' }).shift;
  const r = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: FRI }] });
  assert.equal(r.done, false);
  assert.equal(r.needs.occupied[0].shifts[0].id, there.id);
  const rep = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: FRI, replaceId: there.id }] });
  assert.equal(rep.replaced, 1);
  assert.equal(rep.items[0].before.start, '11:00', 'the answer has what it was, for undo');
  assert.equal(on(p.b, FRI).length, 1);
  const s = store.get('shifts', there.id);
  assert.deepEqual([s.start, s.end, s.tag, s.notes], ['16:00', null, 'BAR 1', 'Cut fruit first']);
  assert.equal(log('shift.pasteReplace').length, 1);
  const add = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: FRI, add: true }] });
  assert.equal(add.created, 1);
  assert.equal(on(p.b, FRI).length, 2);
});

test('paste on a day off or approved time off: asked, never silently created', () => {
  const { p, call, src, on, store } = demo();
  call(p.mgr, 'schedule.dayOff.set', { userId: p.b.id, date: FRI });
  store.insert('timeOff', { id: 'tof_p_1', userId: p.b.id, startDate: SAT, endDate: SAT, status: 'approved', reason: '' });
  const r = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: FRI }, { userId: p.b.id, date: SAT }] });
  assert.equal(r.done, false);
  assert.deepEqual(r.needs.off.map((x) => [x.date, x.codes]), [[FRI, ['dayOff']], [SAT, ['timeOffApproved']]]);
  assert.equal(on(p.b, FRI).length + on(p.b, SAT).length, 0);
  const ok = call(p.mgr, 'shifts.pasteMany', { fromId: src.id, confirmOff: true, targets: [{ userId: p.b.id, date: FRI }, { userId: p.b.id, date: SAT }] });
  assert.equal(ok.created, 2);
  assert.ok(ok.items[0].warnings.length, 'the warning still shows on the shift');
});

test('paste is logged: "pasted from <person>’s <day> shift", in English and Spanish', () => {
  const { p, call, src, log, names } = demo();
  call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: SAT }] });
  const [e] = log('shift.paste');
  assert.ok(e, 'logged as a paste');
  assert.equal(log('shift.create').length, 1, 'only the original add is a plain add');
  assert.equal(e.details.pastedFrom.userId, p.a.id);
  assert.deepEqual(e.details.affected, [p.b.id]);
  assert.match(sentence(e, 'en', names), /^Juno Marsh added Wren Ochoa’s Sat, Oct 3 4p Bartender shift \(Restaurant\), pasted from Tobin Reyes’s Thu, Oct 1 shift$/);
  assert.match(sentence(e, 'es', names), /^Juno Marsh agregó .*, pegado del turno de Tobin Reyes del /);
  const list = call(p.mgr, 'scheduleLog.list', { group: 'shift' });
  assert.ok(list.some((x) => x.action === 'shift.paste'), 'in the Shifts group');
});

test('paste: managers only; bad input refused', () => {
  const { p, call, src } = demo();
  assert.throws(() => call(p.staff, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: SAT }] }), (e) => e.status === 403);
  assert.throws(() => call(p.mgr, 'shifts.pasteMany', { fromId: 'shf_nope', targets: [{ userId: p.b.id, date: SAT }] }), (e) => e.status === 400);
  assert.throws(() => call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [] }), (e) => e.status === 400);
  assert.throws(() => call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: 'usr_nobody', date: SAT }] }), (e) => e.status === 400);
  assert.throws(() => call(p.mgr, 'shifts.pasteMany', { fromId: src.id, targets: [{ userId: p.b.id, date: SAT, replaceId: src.id }] }), (e) => e.status === 400);
});
