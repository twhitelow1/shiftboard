// Trades & pickups by season (core/trade-stats.js): each count by its definition, across season boundaries
// (Winter's New Year, the last minute of April), custom seasons, every outcome, permissions, CSV, speed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { statsCsv, validSeasons, comparePeriods, periodOf, dayOf } from '../core/trade-stats.js';
import { seasonById } from '../core/seasons.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { signIn } from './helpers/signin.js';

// A local time as the ISO timestamp the app stores (the restaurant's wall clock, whatever TZ the tests run in).
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

/** A small restaurant: a manager, a supervisor, three servers, a bartender. Shifts 4p–10p (6 hours). */
function small({ seasons, today = '2026-09-27' } = {}) {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, ...(seasons ? { seasons } : {}) });
  store.insert('jobCodes', { id: 'job_srv', name: 'Server', department: 'Restaurant' });
  store.insert('jobCodes', { id: 'job_bar', name: 'Bartender', department: 'Bar' });
  const person = (id, name, role, jobs) => store.insert('users', { id, name, role, active: true, jobCodes: jobs.map(([jobCodeId, areas]) => ({ jobCodeId, ...(areas ? { areas } : {}) })) });
  person('mgr', 'Manager Mo', 'manager', []);
  person('sup', 'Sue Lead', 'supervisor', [['job_srv']]);
  person('ana', 'Ana', 'employee', [['job_srv', ['Restaurant']]]);
  person('ben', 'Ben', 'employee', [['job_srv', ['Restaurant', 'Patio']]]);
  person('cat', 'Cat', 'employee', [['job_srv', ['Patio']]]);
  person('dan', 'Dan', 'employee', [['job_bar', ['Moon Rabbit']]]);
  let n = 0;
  const shift = (date, userId, { job = 'job_srv', area = 'Restaurant', end = '22:00' } = {}) => store.insert('shifts', { id: `s${++n}`, date, start: '16:00', end, jobCodeId: job, area, userId, published: true });
  const req = (doc) => store.insert('requests', { id: `r${++n}`, note: '', ...doc });
  const [y, m, d] = today.split('-').map(Number);
  const svc = createService(store, { now: () => new Date(y, m - 1, d, 12) });
  const as = (id) => store.get('users', id);
  return { store, svc, shift, req, as };
}

test('each count by its definition, with every outcome', () => {
  const { svc, shift, req, as } = small();
  // Ana gives away a shift and Ben takes it (approved): put up for Ana, picked up for Ben, 6 hours each way.
  req({ type: 'drop', status: 'approved', requesterId: 'ana', pickupUserId: 'ben', shiftId: shift('2026-07-10', 'ben').id, createdAt: at(2026, 7, 1), acceptedAt: at(2026, 7, 2), resolvedAt: at(2026, 7, 3) });
  // Ana offers a trade with Cat (approved): put up for Ana; a trade done for both; no pickup.
  req({ type: 'swap', status: 'approved', requesterId: 'ana', targetUserId: 'cat', shiftId: shift('2026-07-12', 'cat').id, targetShiftId: shift('2026-07-13', 'ana', { end: '20:00' }).id, createdAt: at(2026, 7, 5), resolvedAt: at(2026, 7, 6) });
  // Ana's other requests: declined by the coworker, denied by a manager, cancelled, still open for a past shift
  // (never taken), still open for a future one (waiting).
  req({ type: 'swap', status: 'declined', requesterId: 'ana', targetUserId: 'cat', shiftId: shift('2026-08-01', 'ana').id, targetShiftId: shift('2026-08-02', 'cat').id, createdAt: at(2026, 7, 20), resolvedAt: at(2026, 7, 21) });
  req({ type: 'drop', status: 'denied', requesterId: 'ana', pickupUserId: 'ben', shiftId: shift('2026-08-03', 'ana').id, createdAt: at(2026, 7, 22), resolvedAt: at(2026, 7, 23) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'ana', shiftId: shift('2026-08-05', 'ana').id, createdAt: at(2026, 7, 24), resolvedAt: at(2026, 7, 25) });
  req({ type: 'drop', status: 'open', requesterId: 'ana', shiftId: shift('2026-09-01', 'ana').id, createdAt: at(2026, 8, 25) });
  req({ type: 'drop', status: 'pending_approval', requesterId: 'ana', pickupUserId: 'cat', shiftId: shift('2026-10-04', 'ana').id, createdAt: at(2026, 9, 20) });
  // Cat picks up an open shift (approved) and asks for another (denied: not a pickup).
  req({ type: 'pickup', status: 'approved', requesterId: 'cat', pickupUserId: 'cat', shiftId: shift('2026-07-15', 'cat').id, createdAt: at(2026, 7, 8), resolvedAt: at(2026, 7, 9) });
  req({ type: 'pickup', status: 'denied', requesterId: 'cat', pickupUserId: 'cat', shiftId: shift('2026-07-16', null).id, createdAt: at(2026, 7, 8), resolvedAt: at(2026, 7, 9) });

  const r = svc.call(as('mgr'), 'tradeStats.summary', { season: 'summer-2026' });
  assert.equal(r.period.id, 'summer-2026');
  const row = (id) => r.rows.find((x) => x.userId === id);
  assert.deepEqual(
    (({ putUp, givenAway, tradesOffered, taken, waiting, notTaken, cancelled, pickedUp, tradesDone }) => ({ putUp, givenAway, tradesOffered, taken, waiting, notTaken, cancelled, pickedUp, tradesDone }))(row('ana')),
    { putUp: 7, givenAway: 5, tradesOffered: 2, taken: 2, waiting: 1, notTaken: 3, cancelled: 1, pickedUp: 0, tradesDone: 1 },
  );
  assert.equal(row('ana').putUp, row('ana').taken + row('ana').waiting + row('ana').notTaken + row('ana').cancelled, 'put up = taken + waiting + not taken + cancelled');
  assert.deepEqual([row('ana').hoursGiven, row('ana').hoursTaken, row('ana').netHours], [12, 4, -8], 'gave two 6-hour shifts, took a 4-hour one');
  assert.deepEqual([row('ben').pickedUp, row('ben').giveawaysTaken, row('ben').putUp, row('ben').hoursTaken], [1, 1, 0, 6]);
  assert.deepEqual([row('cat').pickedUp, row('cat').openPickedUp, row('cat').tradesDone, row('cat').putUp], [1, 1, 1, 0], 'a denied pickup is not a pickup; a trade is not a pickup');
  assert.equal(row('cat').netHours, 6 + 6 - 4);
  assert.equal(r.totals.putUp, 7);
  assert.equal(r.totals.pickedUp, 2);
  assert.ok(row('dan') && row('dan').putUp === 0, 'everyone on the schedule is listed, with zeros');
  assert.ok(!row('mgr'), 'people with no positions and no activity are left out');

  // A person's requests for the season, each with what it counted for.
  const list = svc.call(as('mgr'), 'tradeStats.list', { userId: 'ana', season: 'summer-2026' }).requests;
  assert.equal(list.length, 7);
  assert.deepEqual(list.find((x) => x.status === 'declined').counts.sort(), ['notTaken', 'putUp', 'tradesOffered']);
  assert.equal(list.find((x) => x.status === 'open').outcome, 'notTaken');
  const ben = svc.call(as('mgr'), 'tradeStats.list', { userId: 'ben', season: 'summer-2026' }).requests;
  assert.deepEqual(ben.map((x) => [x.side, x.otherName, x.counts.sort().join()]), [['pickup', 'Ana', 'giveawaysTaken,pickedUp']]);
});

test('season boundaries: put up by the day it was asked, picked up by the day it moved; Winter crosses New Year', () => {
  const { svc, shift, req, as } = small({ today: '2026-11-26' });
  // Asked on the last evening of April, approved just after midnight on May 1.
  req({ type: 'drop', status: 'approved', requesterId: 'ana', pickupUserId: 'ben', shiftId: shift('2026-05-02', 'ben').id, createdAt: at(2026, 4, 30, 23, 30), resolvedAt: at(2026, 5, 1, 0, 30) });
  // New Year's Eve and January 2nd are the same Winter 2025–26; Nov 1 starts it, Oct 31 is still Summer.
  req({ type: 'drop', status: 'cancelled', requesterId: 'cat', shiftId: shift('2026-01-05', 'cat').id, createdAt: at(2025, 12, 31, 22) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'cat', shiftId: shift('2026-01-06', 'cat').id, createdAt: at(2026, 1, 2, 9) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'cat', shiftId: shift('2025-11-03', 'cat').id, createdAt: at(2025, 11, 1, 0, 5) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'cat', shiftId: shift('2025-11-02', 'cat').id, createdAt: at(2025, 10, 31, 23, 55) });
  assert.equal(dayOf(at(2026, 4, 30, 23, 30)), '2026-04-30');

  const get = (season) => svc.call(as('mgr'), 'tradeStats.summary', { season }).rows;
  const winter = get('winter-2025');
  const summer = get('summer-2026');
  const row = (rows, id) => rows.find((x) => x.userId === id);
  assert.equal(row(winter, 'ana').putUp, 1, 'asked in Winter');
  assert.equal(row(winter, 'ben').pickedUp, 0);
  assert.equal(row(summer, 'ana').putUp, 0);
  assert.equal(row(summer, 'ben').pickedUp, 1, 'moved in Summer');
  assert.equal(row(summer, 'ana').hoursGiven, 6, 'hours go with the move');
  assert.equal(row(winter, 'cat').putUp, 3, 'Nov 1 00:05, Dec 31 and Jan 2 are one Winter');
  assert.equal(row(get('summer-2025'), 'cat').putUp, 1, 'Oct 31 23:55 is still Summer');

  // The season list shows the seasons with data (and the current one), newest first.
  const seasons = svc.call(as('mgr'), 'tradeStats.summary', {}).seasons.map((s) => s.id);
  assert.deepEqual(seasons, ['winter-2026', 'summer-2026', 'winter-2025', 'summer-2025']);
  assert.equal(svc.call(as('mgr'), 'tradeStats.summary', {}).period.id, 'winter-2026', 'the current season by default');
  // A custom range.
  const custom = svc.call(as('mgr'), 'tradeStats.summary', { from: '2025-12-31', to: '2026-01-01' });
  assert.equal(custom.period.id, 'custom');
  assert.equal(row(custom.rows, 'cat').putUp, 1);
});

test('custom seasons from Settings, and comparing seasons side by side', () => {
  const four = [{ key: 'spring', startMonth: 3, endMonth: 5 }, { key: 'summer', startMonth: 6, endMonth: 8 }, { key: 'fall', startMonth: 9, endMonth: 11 }, { key: 'winter', startMonth: 12, endMonth: 2, label: 'Ski season' }];
  const { svc, shift, req, as, store } = small({ seasons: four });
  req({ type: 'drop', status: 'cancelled', requesterId: 'ana', shiftId: shift('2026-01-10', 'ana').id, createdAt: at(2025, 12, 15) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'ana', shiftId: shift('2026-03-10', 'ana').id, createdAt: at(2026, 3, 1) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'ana', shiftId: shift('2025-10-10', 'ana').id, createdAt: at(2025, 10, 1) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'ana', shiftId: shift('2026-10-10', 'ana').id, createdAt: at(2026, 9, 2) });
  const r = svc.call(as('mgr'), 'tradeStats.summary', { season: 'winter-2025', compare: true });
  assert.equal(r.period.label, 'Ski season 2025–26');
  assert.equal(r.rows.find((x) => x.userId === 'ana').putUp, 1, 'Dec 15 is in the Dec–Feb season');
  const now = svc.call(as('mgr'), 'tradeStats.summary', { compare: true });
  assert.deepEqual(now.compare.periods.map((p) => p.id), ['fall-2026', 'fall-2025', 'summer-2026'], 'this season, the same one last year, the one before');
  assert.deepEqual(now.compare.totals.map((t) => t.putUp), [1, 1, 0]);
  assert.deepEqual(now.compare.rows.find((x) => x.userId === 'ana').cells.map((c) => c.putUp), [1, 1, 0]);
  // Default seasons: Summer 2026 compares with Summer 2025 and Winter 2025–26.
  assert.deepEqual(comparePeriods(seasonById('summer-2026', {}), {}).map((p) => p.id), ['summer-2025', 'winter-2025']);
  assert.deepEqual(comparePeriods(periodOf({ from: '2026-01-01', to: '2026-01-31' }, {}, '2026-02-01'), {}), [], 'a custom range has nothing to compare with');

  // Settings → Seasons: admins only, every month exactly once.
  assert.equal(validSeasons([{ key: 'winter', startMonth: 11, endMonth: 4 }, { key: 'summer', startMonth: 5, endMonth: 9 }]), null, 'October is missing');
  assert.equal(validSeasons([{ key: 'winter', startMonth: 11, endMonth: 4 }, { key: 'winter', startMonth: 5, endMonth: 10 }]), null, 'the same season twice');
  store.insert('users', { id: 'adm', name: 'Admin Al', role: 'admin', active: true, jobCodes: [] });
  assert.throws(() => svc.call(as('mgr'), 'seasons.save', { seasons: four }), /Admins only/);
  assert.throws(() => svc.call(as('adm'), 'seasons.save', { seasons: four.slice(1) }), /Every month must be in exactly one season/);
  const saved = svc.call(as('adm'), 'seasons.save', { seasons: [{ key: 'winter', startMonth: 10, endMonth: 3 }, { key: 'summer', startMonth: 4, endMonth: 9, label: 'Patio season' }] });
  assert.deepEqual(saved.seasons.map((s) => [s.key, s.startMonth, s.endMonth]), [['winter', 10, 3], ['summer', 4, 9]]);
  assert.equal(svc.call(as('mgr'), 'tradeStats.summary', { season: 'summer-2026' }).period.label, 'Patio season 2026');
});

test('position and room filters count only those shifts', () => {
  const { svc, shift, req, as } = small();
  req({ type: 'drop', status: 'cancelled', requesterId: 'ben', shiftId: shift('2026-07-01', 'ben', { area: 'Patio' }).id, createdAt: at(2026, 6, 20) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'ben', shiftId: shift('2026-07-02', 'ben').id, createdAt: at(2026, 6, 20) });
  req({ type: 'drop', status: 'cancelled', requesterId: 'dan', shiftId: shift('2026-07-03', 'dan', { job: 'job_bar', area: 'Moon Rabbit' }).id, createdAt: at(2026, 6, 20) });
  const sum = (args) => svc.call(as('mgr'), 'tradeStats.summary', { season: 'summer-2026', ...args });
  assert.equal(sum({}).totals.putUp, 3);
  assert.equal(sum({ jobCodeId: 'job_srv' }).totals.putUp, 2);
  const patio = sum({ area: 'patio' });
  assert.equal(patio.totals.putUp, 1);
  assert.deepEqual(patio.rows.map((x) => x.name).sort(), ['Ben', 'Cat'], 'people who work the Patio');
  assert.deepEqual(sum({ jobCodeId: 'job_bar' }).rows.map((x) => x.name), ['Dan']);
});

test('only managers and up see the report; staff see their own counts only', () => {
  const { svc, shift, req, as } = small();
  req({ type: 'drop', status: 'approved', requesterId: 'ana', pickupUserId: 'ben', shiftId: shift('2026-07-10', 'ben').id, createdAt: at(2026, 7, 1), resolvedAt: at(2026, 7, 3) });
  for (const who of ['ana', 'sup']) {
    assert.throws(() => svc.call(as(who), 'tradeStats.summary', {}), /Managers only/, who);
    assert.throws(() => svc.call(as(who), 'tradeStats.list', { userId: 'ben' }), /Managers only/, who);
  }
  assert.equal(svc.call(as('ana'), 'tradeStats.list', { season: 'summer-2026' }).requests.length, 1, 'my own list');
  const mine = svc.call(as('ben'), 'tradeStats.get', {});
  assert.equal(mine.period.id, 'summer-2026');
  assert.equal(mine.counts.pickedUp, 1);
  assert.ok(!('rows' in mine));
  assert.throws(() => svc.call(null, 'tradeStats.get', {}), /Please sign in/);
});

test('CSV: headers in the reader’s words, numbers as numbers, names that look like formulas defused', () => {
  const csv = statsCsv([
    { name: 'Ana', putUp: 3, pickedUp: 0, netHours: -4.5 },
    { name: '=HYPERLINK("http://x")', putUp: 1, pickedUp: 2, netHours: 6 },
    { name: 'Smith, Jo', putUp: 0, pickedUp: 1, netHours: 0 },
  ], [{ key: 'name', label: 'Nombre' }, { key: 'putUp', label: 'Ofrecidos' }, { key: 'pickedUp', label: 'Recogidos' }, { key: 'netHours', label: 'Horas netas' }]);
  assert.equal(csv, 'Nombre,Ofrecidos,Recogidos,Horas netas\r\nAna,3,0,-4.5\r\n"\'=HYPERLINK(""http://x"")",1,2,6\r\n"Smith, Jo",0,1,0\r\n');
});

test('the demo has three seasons of trades, and a few thousand requests stay quick', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date(2026, 8, 27, 12) });
  const moe = store.get('users', ids.userId.Moe);
  const r = svc.call(moe, 'tradeStats.summary', { compare: true });
  assert.equal(r.period.id, 'summer-2026');
  assert.ok(r.seasons.length >= 3, r.seasons.map((s) => s.id).join());
  assert.ok(r.totals.putUp > 10 && r.totals.pickedUp > 10, JSON.stringify(r.totals));
  assert.ok(r.compare.totals.every((t) => t.putUp > 0), 'data in each compared season');
  // Grow it to ~4,000 requests (copies of the demo's) and time the report.
  const reqs = store.list('requests', (x) => x.sample);
  for (let i = 0; store.list('requests').length < 4000; i++) {
    const x = reqs[i % reqs.length];
    store.insert('requests', { ...x, id: `copy_${i}` });
  }
  const t0 = performance.now();
  const big = svc.call(moe, 'tradeStats.summary', { compare: true });
  const ms = performance.now() - t0;
  assert.ok(big.totals.putUp > r.totals.putUp);
  assert.ok(ms < 1500, `${Math.round(ms)} ms for 4,000 requests`);
});

test('over the API: staff are refused, managers get the report', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', EXPO_PUSH: 'off' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const post = async (p, body = {}) => {
      const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { post, rpc: (m, a) => post(`/api/rpc/${m}`, a) };
  };
  try {
    const alex = client();
    assert.equal((await signIn(alex.post, 'alexd@demo.shiftboard')).status, 200);
    const refused = await alex.rpc('tradeStats.summary', {});
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'Managers only');
    assert.equal((await alex.rpc('tradeStats.get', {})).status, 200, 'my own counts');
    const kelly = client();
    assert.equal((await signIn(kelly.post, 'kelly@demo.shiftboard')).status, 200);
    const r = await kelly.rpc('tradeStats.summary', { season: 'summer-2026' });
    assert.equal(r.status, 200);
    assert.ok(r.body.result.totals.putUp > 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
