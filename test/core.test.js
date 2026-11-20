import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';

function setup() {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const u = (name) => store.get('users', ids.userId[name]);
  return { store, svc, ids, u };
}

test('seed loads the posted week', () => {
  const { svc, u } = setup();
  const res = svc.call(u('Alex D'), 'shifts.list', { start: '2026-09-28', end: '2026-10-04' });
  assert.ok(res.shifts.length > 120);
  const boot = svc.call(u('Alex D'), 'app.bootstrap');
  assert.equal(boot.jobCodes.length, 11, 'one job code per position');
  assert.deepEqual(boot.settings.areas, ['Restaurant', 'Rabbit Hole', 'Moon Rabbit', 'Host Stand', 'Back Host Stand']);
  // A bartender keeps one position and works several areas, like the house sheet.
  const dante = boot.employees.find((e) => e.name === 'Dante');
  assert.deepEqual(dante.jobCodes.map((j) => j.jobCodeId), ['job_bar']);
  const mak = res.shifts.filter((s) => s.userId === u('Mak').id);
  assert.ok(mak.length && mak.every((s) => s.jobCodeId === 'job_bar' && s.area === 'Rabbit Hole'));
  assert.ok(!boot.employees.some((e) => e.email && e.id !== u('Alex D').id), 'employees must not see coworker emails');
});

test('employees cannot see drafts or manage shifts', () => {
  const { svc, u, ids } = setup();
  svc.call(u('Moe'), 'shifts.save', { date: '2026-10-06', start: '16:00', jobCodeId: ids.jobId.SRV, userId: ids.userId['Alex D'] });
  const asAlex = svc.call(u('Alex D'), 'shifts.list', { start: '2026-10-05', end: '2026-10-11' });
  assert.equal(asAlex.shifts.length, 0);
  assert.throws(() => svc.call(u('Alex D'), 'shifts.save', { date: '2026-10-06', start: '16:00', jobCodeId: ids.jobId.SRV }), /Managers only/);
  svc.call(u('Moe'), 'shifts.publish', { start: '2026-10-05', end: '2026-10-11' });
  assert.equal(svc.call(u('Alex D'), 'shifts.list', { start: '2026-10-05', end: '2026-10-11' }).shifts.length, 1);
});

test('conflicts: time off, double booking, not qualified', () => {
  const { svc, u, ids } = setup();
  // Victor has approved time off Sunday
  const r = svc.call(u('Moe'), 'shifts.save', { date: '2026-10-04', start: '16:00', jobCodeId: ids.jobId.SRV, userId: ids.userId.Victor });
  assert.ok(r.warnings.includes('Approved time off'));
  const r2 = svc.call(u('Moe'), 'shifts.save', { date: '2026-09-30', start: '18:00', jobCodeId: ids.jobId.BAR, userId: ids.userId.Victor });
  assert.ok(r2.warnings.some((w) => w.startsWith('Overlaps')));
  assert.ok(r2.warnings.some((w) => w.includes("isn't trained")));
});

test('giveaway flow: drop -> coworker accepts -> manager approves', () => {
  const { svc, u, store, ids } = setup();
  const kelly = store.list('shifts', (s) => s.userId === ids.userId.Jonathan && s.date === '2026-09-29')[0];
  const req = svc.call(u('Jonathan'), 'swaps.create', { shiftId: kelly.id, type: 'drop' });
  assert.equal(req.status, 'open');
  // Mak is a bartender, not a server → cannot take it
  assert.throws(() => svc.call(u('Mak'), 'swaps.accept', { requestId: req.id }), /aren't set up/);
  const offers = svc.call(u('Manny'), 'swaps.list').offers;
  assert.ok(offers.some((o) => o.id === req.id));
  svc.call(u('Manny'), 'swaps.accept', { requestId: req.id });
  assert.equal(store.get('requests', req.id).status, 'pending_approval');
  assert.equal(store.get('shifts', kelly.id).userId, ids.userId.Jonathan, 'no change until approved');
  svc.call(u('Kelly'), 'swaps.approve', { requestId: req.id });
  assert.equal(store.get('shifts', kelly.id).userId, ids.userId.Manny);
  assert.ok(store.list('notifications', (n) => n.userId === ids.userId.Jonathan && n.text.startsWith('Approved')).length);
});

test('trade flow executes both sides and closes competing requests', () => {
  const { svc, u, store } = setup();
  const pending = store.list('requests', (r) => r.type === 'swap')[0];
  const a = store.get('shifts', pending.shiftId), b = store.get('shifts', pending.targetShiftId);
  svc.call(u('Moe'), 'swaps.approve', { requestId: pending.id });
  assert.equal(store.get('shifts', a.id).userId, b.userId);
  assert.equal(store.get('shifts', b.id).userId, a.userId);
});

test('open shift pickup; approving one denies the others', () => {
  const { svc, u, store } = setup();
  const pickup = store.list('requests', (r) => r.type === 'pickup')[0];
  const other = svc.call(u('Ever'), 'swaps.create', { shiftId: pickup.shiftId, type: 'pickup' });
  svc.call(u('Moe'), 'swaps.approve', { requestId: pickup.id });
  assert.equal(store.get('requests', other.id).status, 'denied');
  assert.ok(store.get('shifts', pickup.shiftId).userId);
});

test('forecast produces covers, labor % and staffing gaps', () => {
  const { svc, u } = setup();
  const f = svc.call(u('Moe'), 'forecast.week', { weekStart: '2026-09-28' });
  const mon = f.days[0], sat = f.days[5];
  assert.equal(mon.closed, true);
  assert.ok(sat.covers > 200 && sat.covers < 340, `sat covers ${sat.covers}`);
  assert.equal(sat.eventGuests, 110);
  assert.ok(sat.laborPct > 0);
  const dinner = sat.dayparts.find((d) => d.name === 'Dinner');
  assert.ok(dinner.rows.find((r) => r.recommended != null));
  assert.throws(() => svc.call(u('Alex D'), 'forecast.week', { weekStart: '2026-09-28' }), /Managers only/);
});

test('events: suggest staffing, generate shifts, comments notify staff', () => {
  const { svc, u, store, ids } = setup();
  const evRole = u('Events Team');
  const ev = svc.call(evRole, 'events.save', { name: 'Test Gala', date: '2026-10-09', start: '18:00', end: '22:00', guestCount: 120, serviceStyle: 'plated', status: 'confirmed' });
  const lines = svc.call(evRole, 'events.suggestStaffing', ev);
  assert.ok(lines.find((l) => l.jobCodeId === ids.jobId.SRV).count === 6);
  assert.ok(lines.find((l) => l.jobCodeId === ids.jobId.BC));
  svc.call(evRole, 'events.save', { ...ev, staffing: lines });
  assert.throws(() => svc.call(evRole, 'events.generateShifts', { id: ev.id }), /Managers only/);
  const g = svc.call(u('Moe'), 'events.generateShifts', { id: ev.id, publish: true });
  assert.equal(g.created, lines.reduce((t, l) => t + l.count, 0));
  const again = svc.call(u('Moe'), 'events.generateShifts', { id: ev.id });
  assert.equal(again.created, 0, 'idempotent');
  const view = svc.call(u('Alex D'), 'events.get', { id: 'evt_wedding' });
  assert.equal(view.estRevenue, undefined);
  assert.ok(view.needed >= view.filled);
  svc.call(u('Events Team'), 'events.comment', { eventId: 'evt_wedding', text: 'Cake arrives at 4pm' });
  assert.ok(store.list('notifications', (n) => n.userId === ids.userId.Styves && n.text.includes('Cake')).length);
});

test('copy week creates drafts', () => {
  const { svc, u } = setup();
  const r = svc.call(u('Moe'), 'shifts.copyWeek', { fromWeek: '2026-09-28', toWeek: '2026-10-05' });
  assert.ok(r.copied >= 100);
  const next = svc.call(u('Moe'), 'shifts.list', { start: '2026-10-05', end: '2026-10-11' });
  assert.ok(next.shifts.every((s) => !s.published && !s.eventId));
});
