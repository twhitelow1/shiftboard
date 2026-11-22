// Tentative events count as confirmed from two weeks before their date (core/beo.js eventStatus): staff
// see them on the schedule and in Events, and the badge says "automatic". Further out they stay the events
// team's. Nothing runs at night: the status is worked out when the event is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { eventStatus, AUTO_CONFIRM_DAYS } from '../core/beo.js';

test('eventStatus: tentative turns confirmed within two weeks; other statuses never change', () => {
  assert.equal(AUTO_CONFIRM_DAYS, 14);
  const today = '2026-09-27';
  assert.equal(eventStatus({ status: 'tentative', date: '2026-10-11' }, today), 'confirmed', 'exactly 14 days out');
  assert.equal(eventStatus({ status: 'tentative', date: '2026-10-12' }, today), 'tentative', '15 days out');
  assert.equal(eventStatus({ status: 'tentative', date: '2026-09-20' }, today), 'confirmed', 'a past tentative event happened');
  for (const status of ['confirmed', 'completed', 'cancelled']) assert.equal(eventStatus({ status, date: '2026-09-30' }, today), status);
});

test('staff see a tentative event only once it is within two weeks; managers see both, marked automatic', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const as = (name) => (method, args) => svc.call(store.get('users', ids.userId[name]), method, args);
  const near = store.insert('events', { id: 'evt_near', name: 'Near Rehearsal Dinner', date: '2026-10-08', start: '18:00', status: 'tentative', guestCount: 30, staffing: [] });
  const far = store.insert('events', { id: 'evt_far', name: 'Far Holiday Party', date: '2026-11-20', start: '19:00', status: 'tentative', guestCount: 80, staffing: [] });

  const staff = as('Alex D');
  const seen = staff('events.list', { start: '2026-09-27' }).map((e) => e.id);
  assert.ok(seen.includes(near.id), 'within two weeks: staff see it');
  assert.ok(!seen.includes(far.id), 'further out: still the events team’s');
  const got = staff('events.get', { id: near.id });
  assert.deepEqual([got.status, got.autoConfirmed], ['confirmed', true]);
  assert.throws(() => staff('events.get', { id: far.id }), /Event not found/);
  const mine = (list) => list.filter((e) => e.id === near.id || e.id === far.id).map((e) => [e.id, e.status]);
  assert.deepEqual(mine(staff('shifts.list', { start: '2026-10-05', end: '2026-10-11' }).events), [['evt_near', 'confirmed']]);
  assert.deepEqual(mine(staff('shifts.list', { start: '2026-11-16', end: '2026-11-22' }).events), [], 'a far tentative event isn’t on staff’s schedule');
  assert.deepEqual(mine(as('Moe')('shifts.list', { start: '2026-11-16', end: '2026-11-22' }).events), [['evt_far', 'tentative']], 'managers still see it');

  const mgr = as('Moe');
  const list = mgr('events.list', { start: '2026-09-27' });
  assert.deepEqual(list.filter((e) => e.id === near.id || e.id === far.id).map((e) => [e.id, e.status, !!e.autoConfirmed]),
    [['evt_near', 'confirmed', true], ['evt_far', 'tentative', false]]);
  assert.equal(store.get('events', near.id).status, 'tentative', 'reading never writes');
});
