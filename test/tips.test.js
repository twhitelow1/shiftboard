// Tip pooling: the split math, distribution methods, areas, roles, Toast hours, locking,
// privacy and permissions (core/tips.js, mounted in core/service.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { splitCents, percentOf, toCents, fmtCents, exampleSplit, normalizePool, poolOverlaps, describePool } from '../core/tips.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';

const WEEK = '2026-09-28'; // a Monday
const TUE = '2026-09-29';
const WED = '2026-09-30';

/** A small restaurant with exact numbers: no demo pools, no demo shifts. */
function fixture() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, weekStartDow: 1, areas: ['Restaurant', 'Rabbit Hole'] });
  for (const [id, name] of [['job_srv', 'Server'], ['job_bar', 'Bartender'], ['job_bus', 'Busser'], ['job_fr', 'Food Runner'], ['job_bbk', 'Barback'], ['job_mgr', 'Manager']]) {
    store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), department: 'Restaurant', order: 0 });
  }
  const people = [['owner', 'Olive', 'admin'], ['mgr', 'Max', 'manager'], ['sup', 'Sam', 'supervisor'],
    ['ana', 'Ana', 'employee'], ['ben', 'Ben', 'employee'], ['cat', 'Cat', 'employee'], ['dan', 'Dan', 'employee'],
    ['eve', 'Eve', 'employee'], ['fay', 'Fay', 'employee'], ['gus', 'Gus', 'employee'], ['hal', 'Hal', 'employee'], ['ida', 'Ida', 'employee']];
  for (const [id, name, role] of people) store.insert('users', { id, name, role, email: `${id}@test.local`, jobCodes: [], active: true });
  const svc = createService(store, { now: () => new Date('2026-10-05T10:00:00') });
  const u = (id) => store.get('users', id);
  const shift = (userId, date, start, end, jobCodeId, area = 'Restaurant', extra = {}) =>
    store.insert('shifts', { date, start, end, userId, jobCodeId, area, published: true, breakMin: 0, ...extra });
  const pool = (patch = {}) => svc.call(u('owner'), 'tipPools.save', {
    name: 'House', period: 'day', method: 'hours_points',
    jobs: [{ jobCodeId: 'job_srv', points: 1 }, { jobCodeId: 'job_bar', points: 1 }, { jobCodeId: 'job_bus', points: 0.5 }, { jobCodeId: 'job_fr', points: 0.6 }, { jobCodeId: 'job_bbk', points: 0.5 }],
    ...patch,
  });
  const enter = (poolId, date, patch = {}, who = 'mgr') => svc.call(u(who), 'tipEntries.save', { poolId, date, card: 0, cash: 0, ...patch });
  const week = (who = 'mgr') => svc.call(u(who), 'tips.week', { weekStart: WEEK });
  const periodOn = (rep, poolId, date) => rep.pools.find((p) => p.pool.id === poolId).periods.find((p) => p.start <= date && date <= p.end);
  const sum = (per) => per.people.reduce((t, p) => t + p.amount, 0);
  return { store, svc, u, shift, pool, enter, week, periodOn, sum };
}

// ---------- the math ----------

test('splitCents adds up exactly, gives leftover cents by rule, and ignores input order', () => {
  const rows = [{ key: 'a', units: 1, name: 'A' }, { key: 'b', units: 1, name: 'B' }, { key: 'c', units: 1, name: 'C' }];
  assert.deepEqual([...splitCents(100, rows)], [['a', 34], ['b', 33], ['c', 33]]);
  assert.deepEqual([...splitCents(100, [...rows].reverse())].sort(), [['a', 34], ['b', 33], ['c', 33]]);
  assert.deepEqual([...splitCents(1, rows)], [['a', 1], ['b', 0], ['c', 0]]);
  assert.deepEqual([...splitCents(500, rows.map((r) => ({ ...r, units: 0 })))], [['a', 0], ['b', 0], ['c', 0]], 'nobody to pay');
  // Bigger remainder first: 2/3 of a cent beats 1/3.
  assert.deepEqual([...splitCents(10, [{ key: 'x', units: 1 }, { key: 'y', units: 2 }])], [['x', 3], ['y', 7]]);

  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const cents = rnd(5000000);
    const list = Array.from({ length: 1 + rnd(40) }, (_, k) => ({ key: `p${k}`, units: rnd(4) ? 1 + rnd(600000) : 0, name: `P${k}` }));
    const total = list.reduce((t, r) => t + r.units, 0);
    const out = splitCents(cents, list);
    const paid = [...out.values()].reduce((t, v) => t + v, 0);
    assert.equal(paid, total ? cents : 0, 'always adds up to the pool');
    for (const r of list) {
      const exact = total ? (cents * r.units) / total : 0;
      assert.ok(Math.abs(out.get(r.key) - exact) < 1.000001, 'never more than a cent from the exact share');
    }
    const shuffled = [...list].sort(() => rnd(3) - 1);
    assert.deepEqual(new Map([...splitCents(cents, shuffled)].sort()), new Map([...out].sort()), 'same answer in any order');
  }
});

test('money helpers: cents in and out, percents rounded to the cent', () => {
  assert.equal(toCents('812.40'), 81240);
  assert.equal(toCents('$1,234.5'), 123450);
  assert.equal(toCents('0.29'), 29);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('abc'), null);
  assert.equal(fmtCents(81240), '$812.40');
  assert.equal(fmtCents(123456789), '$1,234,567.89');
  assert.equal(fmtCents(-1500), '−$15.00');
  assert.equal(percentOf(100000, 3), 3000);
  assert.equal(percentOf(12345, 2.5), 309, '308.625 rounds up');
  assert.equal(percentOf(50, 1), 1, 'half a cent rounds up');
});

test('hours × points: the worked example, and shares add up to the pool', () => {
  const f = fixture();
  const p = f.pool();
  // 41.2 points in all: Ana is 6.5 of them.
  f.shift('ana', TUE, '16:00', '22:30', 'job_srv');           // 6.5 h × 1.0 = 6.5
  f.shift('ben', TUE, '15:00', '23:00', 'job_bar');           // 8 h × 1.0 = 8
  f.shift('cat', TUE, '16:00', '22:00', 'job_bus');           // 6 h × 0.5 = 3
  f.shift('eve', TUE, '15:00', '22:30', 'job_srv');           // 7.5 h × 1.0 = 7.5
  f.shift('fay', TUE, '16:00', '23:00', 'job_bar');           // 7 h × 1.0 = 7
  f.shift('gus', TUE, '17:00', '23:00', 'job_bbk');           // 6 h × 0.5 = 3
  f.shift('hal', TUE, '17:00', '22:00', 'job_fr');            // 5 h × 0.6 = 3
  f.shift('ida', TUE, '16:00', '22:24', 'job_bus');           // 6.4 h × 0.5 = 3.2
  f.enter(p.id, TUE, { card: 70000, cash: 11240 });           // $812.40
  const rep = f.week();
  const per = f.periodOn(rep, p.id, TUE);
  assert.equal(per.total, 81240);
  assert.equal(Number(per.totalPoints.toFixed(4)), 41.2);
  assert.equal(f.sum(per), 81240, 'shares add up to the pool exactly');
  const ana = per.people.find((x) => x.userId === 'ana');
  assert.equal(ana.minutes, 390);
  assert.equal(Number(ana.sharePct.toFixed(2)), 15.78);
  assert.ok(Math.abs(ana.amount - (81240 * 6.5) / 41.2) < 1);
  const mine = f.svc.call(f.u('ana'), 'myTips.week', { weekStart: WEEK });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].lines[0], `You worked 6.5 hrs × 1.0 points = 6.5 of 41.2 points × $812.40 pool = ${fmtCents(ana.amount)}`);
  assert.equal(mine.total, ana.amount);
  assert.equal(mine.final, false);
});

test('points per shift and equal split', () => {
  const f = fixture();
  f.shift('ana', TUE, '11:00', '14:00', 'job_srv'); // short shift
  f.shift('ben', TUE, '16:00', '23:00', 'job_srv');
  f.shift('cat', TUE, '16:00', '23:00', 'job_bus');
  f.shift('cat', TUE, '11:00', '13:00', 'job_bus'); // a double: two shifts
  const shiftPool = f.pool({ name: 'Per shift', method: 'points_shift' });
  f.enter(shiftPool.id, TUE, { card: 30000 });
  let per = f.periodOn(f.week(), shiftPool.id, TUE);
  // Ana 1 × 1.0, Ben 1 × 1.0, Cat 2 × 0.5: 3 points, $100 each whatever the hours.
  assert.deepEqual(per.people.map((p) => [p.userId, p.amount]).sort(), [['ana', 10000], ['ben', 10000], ['cat', 10000]]);
  assert.match(f.svc.call(f.u('cat'), 'myTips.week', { weekStart: WEEK }).items[0].lines[0], /You worked 2 shifts × 0\.5 points = 1\.0 of 3\.0 points × \$300\.00 pool = \$100\.00/);

  f.svc.call(f.u('owner'), 'tipPools.save', { ...shiftPool, method: 'equal' });
  f.enter(shiftPool.id, TUE, { card: 10000 });
  per = f.periodOn(f.week(), shiftPool.id, TUE);
  assert.deepEqual(per.people.map((p) => p.amount).sort(), [3333, 3333, 3334]);
  assert.equal(f.sum(per), 10000);
  assert.match(f.svc.call(f.u('ana'), 'myTips.week', { weekStart: WEEK }).items[0].lines[0], /^Split equally: \$100\.00 pool ÷ 3 people = \$33\.3[34]$/);
});

test('per week: the whole week is added up and split once', () => {
  const f = fixture();
  const p = f.pool({ period: 'week' });
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');
  f.shift('ben', WED, '16:00', '22:00', 'job_srv');
  f.shift('ben', TUE, '16:00', '22:00', 'job_srv');
  f.enter(p.id, TUE, { card: 20000 });
  f.enter(p.id, WED, { cash: 10000 });
  const rep = f.week();
  const pr = rep.pools[0];
  assert.equal(pr.periods.length, 1);
  assert.deepEqual(pr.periods[0].people.map((x) => [x.userId, x.amount]), [['ben', 20000], ['ana', 10000]]);
  assert.equal(pr.days.length, 7);
});

test('what goes in: card tips only, and a tip-out of a share of sales', () => {
  const f = fixture();
  const p = f.pool({ jobs: [{ jobCodeId: 'job_bus', points: 1 }], contributions: [
    { type: 'tips', source: 'card', percent: 100 },
    { type: 'sales', jobCodeId: 'job_srv', percent: 3 },
  ] });
  f.shift('cat', TUE, '16:00', '22:00', 'job_bus');
  const sales = p.contributions.find((c) => c.type === 'sales');
  f.enter(p.id, TUE, { card: 50000, cash: 99900, sales: { [sales.id]: 1234567 } });
  const day = f.week().pools[0].days.find((d) => d.date === TUE);
  assert.equal(day.total, 50000 + 37037, 'card tips + 3% of $12,345.67, cash kept');
  assert.match(describePool(p, { jobName: (id) => f.store.get('jobCodes', id).name })[0], /100% of card tips \+ Servers tip out 3% of their sales/);
});

// ---------- areas, roles, Toast ----------

test('area pools: a Rabbit Hole pool takes its shifts, the house pool takes the rest', () => {
  const f = fixture();
  const house = f.pool();
  const rh = f.pool({ name: 'Rabbit Hole', areas: ['RABBIT HOLE'], jobs: [{ jobCodeId: 'job_bar', points: 1 }] });
  assert.deepEqual(rh.areas, ['RABBIT HOLE']);
  f.shift('ben', TUE, '16:00', '22:00', 'job_bar', 'Rabbit Hole');
  f.shift('fay', TUE, '16:00', '22:00', 'job_bar', 'Restaurant');
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv', 'Rabbit Hole'); // servers aren't in the RH pool, so the house pool has them
  f.enter(house.id, TUE, { card: 10000 });
  f.enter(rh.id, TUE, { card: 5000 });
  const rep = f.week();
  assert.deepEqual(f.periodOn(rep, rh.id, TUE).people.map((p) => p.userId), ['ben']);
  assert.deepEqual(f.periodOn(rep, house.id, TUE).people.map((p) => p.userId).sort(), ['ana', 'fay']);
  assert.deepEqual(f.svc.call(f.u('ana'), 'tipPools.list').overlaps, []);
  // A second pool for the same area and position would count those shifts twice: flagged.
  const pools = f.svc.call(f.u('ana'), 'tipPools.list').pools;
  assert.equal(poolOverlaps([...pools, normalizePool({ id: 'x', name: 'Also RH', areas: ['Rabbit Hole'], jobs: [{ jobCodeId: 'job_bar', points: 1 }] })], () => 'Bartender').length, 1);
});

test('event shifts can be left out of a pool', () => {
  const f = fixture();
  const p = f.pool({ events: false });
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv', 'Restaurant', { eventId: 'evt_1' });
  f.shift('ben', TUE, '16:00', '22:00', 'job_srv');
  f.enter(p.id, TUE, { card: 10000 });
  assert.deepEqual(f.periodOn(f.week(), p.id, TUE).people.map((x) => x.userId), ['ben']);
});

test('managers are left out by default; supervisors can be; nobody gives a manager an adjustment', () => {
  const f = fixture();
  const p = f.pool();
  assert.deepEqual(p.excludeRoles, ['super_admin', 'admin', 'manager']);
  f.shift('mgr', TUE, '16:00', '22:00', 'job_srv');
  f.shift('sup', TUE, '16:00', '22:00', 'job_srv');
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');
  f.enter(p.id, TUE, { card: 10000 });
  let per = f.periodOn(f.week(), p.id, TUE);
  assert.deepEqual(per.people.map((x) => x.userId).sort(), ['ana', 'sup']);
  assert.deepEqual(per.excluded.map((x) => [x.userId, x.minutes]), [['mgr', 360]]);
  assert.equal(f.sum(per), 10000);
  assert.throws(() => f.enter(p.id, TUE, { card: 10000, adjustments: [{ userId: 'mgr', cents: 500, note: 'Helped' }] }), /Max \(Manager\) can’t get money/);
  assert.throws(() => f.enter(p.id, TUE, { card: 10000, adjustments: [{ userId: 'owner', cents: 500, note: 'Helped' }] }), /Olive \(Admin\) can’t get money/);

  f.svc.call(f.u('owner'), 'tipPools.save', { ...p, excludeRoles: [...p.excludeRoles, 'supervisor'] });
  per = f.periodOn(f.week(), p.id, TUE);
  assert.deepEqual(per.people.map((x) => [x.userId, x.amount]), [['ana', 10000]]);
  assert.deepEqual(f.svc.call(f.u('mgr'), 'myTips.week', { weekStart: WEEK }).items, [], 'managers get nothing from the pool');
});

test('Toast hours win over the schedule, per person and day, and Toast tips can fill the pool', () => {
  const f = fixture();
  const house = f.pool();
  const rh = f.pool({ name: 'Rabbit Hole', areas: ['Rabbit Hole'], jobs: [{ jobCodeId: 'job_bar', points: 1 }] });
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');                  // scheduled 6 h, Toast says 6.75 h
  f.shift('ben', TUE, '16:00', '22:00', 'job_srv');                  // scheduled 6 h, no punch
  f.shift('dan', TUE, '12:00', '16:00', 'job_bar', 'Restaurant');    // a split shift across two areas,
  f.shift('dan', TUE, '18:00', '22:00', 'job_bar', 'Rabbit Hole');   // Toast says 9 h in all
  f.shift('eve', WED, '16:00', null, 'job_srv');                     // "until close", no Toast that day
  const te = (userId, date, jobCodeId, regularHours, overtimeHours, nonCashTips, declaredCashTips) =>
    f.store.insert('timeEntries', { date, userId, jobCodeId, regularHours, overtimeHours, nonCashTips, declaredCashTips, source: 'toast' });
  te('ana', TUE, 'job_srv', 6.5, 0.25, 120.5, 20);
  te('dan', TUE, 'job_bar', 9, 0, 90, 0);
  te('cat', TUE, null, 5, 0, 0, 0); // clocked in without being scheduled, no position: can't be placed
  te('gus', TUE, 'job_bbk', 4, 0, 10.25, 5);  // clocked in as Barback without being scheduled
  f.enter(house.id, TUE, { useToast: true });
  f.enter(house.id, WED, { card: 5000 });
  const rep = f.week();
  const tue = f.periodOn(rep, house.id, TUE);
  const by = Object.fromEntries(tue.people.map((p) => [p.userId, p]));
  assert.deepEqual([by.ana.minutes, by.ana.source], [405, 'toast']);
  assert.deepEqual([by.ben.minutes, by.ben.source, by.ben.noPunch], [360, 'schedule', [TUE]], 'no punch on a Toast day is flagged');
  assert.deepEqual([by.dan.minutes, by.dan.source], [270, 'toast'], 'half of the 9 h, by scheduled length');
  assert.deepEqual([by.gus.minutes, by.gus.source], [240, 'toast'], 'unscheduled Toast time counts in the house pool');
  assert.equal(by.cat, undefined);
  assert.equal(f.periodOn(rep, rh.id, TUE).people[0].minutes, 270);
  const day = rep.pools[0].days.find((d) => d.date === TUE);
  assert.equal(day.toastAvailable, true);
  assert.deepEqual([day.card, day.cash, day.total], [12050 + 4500 + 1025, 2000 + 500, 12050 + 4500 + 1025 + 2500], 'Toast tips of the people in this pool');
  const eve = f.periodOn(rep, house.id, WED).people[0];
  assert.deepEqual([eve.source, eve.estimated, eve.noPunch], ['schedule', true, []]);
  assert.match(f.svc.call(f.u('ana'), 'myTips.week', { weekStart: WEEK }).items[0].lines[0], /^You worked 6\.75 hrs × 1\.0 points/);
});

// ---------- entries, locking ----------

test('adjustments need a note, come off the top, and can’t be more than the pool', () => {
  const f = fixture();
  const p = f.pool();
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');
  f.shift('ben', TUE, '16:00', '22:00', 'job_srv');
  assert.throws(() => f.enter(p.id, TUE, { card: 10000, adjustments: [{ userId: 'ana', cents: 1000, note: ' ' }] }), /Add a note/);
  assert.throws(() => f.enter(p.id, TUE, { card: 10000, adjustments: [{ userId: 'ana', cents: 20000, note: 'Bonus' }] }), /more than the pool/);
  assert.throws(() => f.enter(p.id, TUE, { card: 12.5 }), /Card tips/);
  f.enter(p.id, TUE, { card: 10001, adjustments: [{ userId: 'cat', cents: 1001, note: 'Polished glasses' }] });
  const per = f.periodOn(f.week(), p.id, TUE);
  assert.deepEqual(per.people.map((x) => [x.userId, x.split, x.adjustment, x.amount]), [['ana', 4500, 0, 4500], ['ben', 4500, 0, 4500], ['cat', 0, 1001, 1001]]);
  assert.equal(f.sum(per), 10001);
  assert.deepEqual(f.svc.call(f.u('cat'), 'myTips.week', { weekStart: WEEK }).items[0].lines, ['+ $10.01 adjustment: Polished glasses']);
  // Clearing a day removes its entry.
  assert.equal(f.enter(p.id, TUE, {}).removed, true);
  assert.equal(f.store.list('tipEntries').length, 0);
});

test('finalizing locks the week, tells each person their own share, and only an admin unlocks it', () => {
  const f = fixture();
  const p = f.pool();
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');
  f.shift('ben', TUE, '16:00', '20:00', 'job_srv');
  f.enter(p.id, TUE, { card: 10000 });
  assert.throws(() => f.svc.call(f.u('sup'), 'tips.finalize', { weekStart: WEEK }), /Managers only/);
  const done = f.svc.call(f.u('mgr'), 'tips.finalize', { weekStart: TUE }); // any day of the week works
  assert.equal(done.locked.byName, 'Max');
  assert.throws(() => f.svc.call(f.u('mgr'), 'tips.finalize', { weekStart: WEEK }), /already final/);

  const notes = (id) => f.store.list('notifications', (n) => n.userId === id).map((n) => n.text);
  assert.deepEqual(notes('ana'), ['Your tips for Sep 28 – Oct 4 are final: $60.00. Tap to see how it was worked out.']);
  assert.deepEqual(notes('ben'), ['Your tips for Sep 28 – Oct 4 are final: $40.00. Tap to see how it was worked out.']);
  assert.deepEqual(notes('cat'), []);

  // Locked: no edits, and later changes to the schedule don't move the numbers.
  assert.throws(() => f.enter(p.id, TUE, { card: 99999 }), /final/);
  f.shift('cat', TUE, '16:00', '22:00', 'job_srv');
  const locked = f.week();
  assert.ok(locked.locked);
  assert.deepEqual(f.periodOn(locked, p.id, TUE).people.map((x) => [x.userId, x.amount]), [['ana', 6000], ['ben', 4000]]);
  const mine = f.svc.call(f.u('ana'), 'myTips.week', { weekStart: WEEK });
  assert.deepEqual([mine.final, mine.total], [true, 6000]);

  assert.throws(() => f.svc.call(f.u('mgr'), 'tips.unlock', { weekStart: WEEK }), /Admins only/);
  f.svc.call(f.u('owner'), 'tips.unlock', { weekStart: WEEK });
  assert.match(notes('ana').at(-1), /reopened/);
  f.enter(p.id, TUE, { card: 9000 });
  assert.deepEqual(f.periodOn(f.week(), p.id, TUE).people.map((x) => x.amount), [3375, 3375, 2250]);
  assert.throws(() => f.svc.call(f.u('owner'), 'tips.unlock', { weekStart: WEEK }), /isn’t final/);
});

test('a week can’t be finalized while money has nobody to go to', () => {
  const f = fixture();
  const p = f.pool();
  assert.throws(() => f.svc.call(f.u('mgr'), 'tips.finalize', { weekStart: WEEK }), /No tips entered/);
  f.enter(p.id, TUE, { card: 10000 });
  assert.throws(() => f.svc.call(f.u('mgr'), 'tips.finalize', { weekStart: WEEK }), /nobody in this pool worked/);
});

// ---------- privacy and permissions ----------

const READ_ONLY = new RegExp(fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8').match(/const READ_ONLY = \/(.+)\/;/)[1]);

test('read methods are named so the server treats them as reads, and writes are not', () => {
  for (const m of ['tipPools.list', 'tips.week', 'myTips.week']) assert.ok(READ_ONLY.test(m), m);
  for (const m of ['tipPools.save', 'tipPools.delete', 'tipEntries.save', 'tips.finalize', 'tips.unlock']) assert.ok(!READ_ONLY.test(m), m);
});

test('privacy: an employee can’t read a coworker’s tips through any RPC', () => {
  const f = fixture();
  const p = f.pool();
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');
  f.shift('ben', TUE, '16:00', '21:00', 'job_srv');
  f.enter(p.id, TUE, { card: 123457, adjustments: [{ userId: 'ben', cents: 4321, note: 'ZZ-BEN-ONLY-ZZ' }] });
  const ben = f.periodOn(f.week(), p.id, TUE).people.find((x) => x.userId === 'ben');
  const benNumbers = [ben.amount, ben.split, ben.adjustment];
  const ana = f.u('ana');
  const leaks = (out) => {
    const json = JSON.stringify(out ?? null);
    // Ben's shifts are on the public schedule; his tip amounts and adjustment notes are not.
    return json.includes('ZZ-BEN-ONLY-ZZ') || benNumbers.some((n) => new RegExp(`[:\\[,]${n}[,\\]}]`).test(json));
  };
  const args = { weekStart: WEEK, start: WEEK, end: '2026-10-04', date: TUE, id: p.id, poolId: p.id, userId: 'ben', shiftId: 'x' };
  const sweep = () => {
    for (const method of Object.keys(f.svc.api).filter((m) => READ_ONLY.test(m) && m !== 'app.bootstrap')) {
      let out;
      try { out = f.svc.call(ana, method, args); } catch { continue; }
      assert.ok(!leaks(out), `${method} leaks a coworker’s tips`);
    }
  };
  sweep();
  assert.throws(() => f.svc.call(ana, 'tips.week', { weekStart: WEEK }), /Managers only/);
  const mine = f.svc.call(ana, 'myTips.week', { weekStart: WEEK, userId: 'ben' });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].poolTotal, 123457, 'the pool total is fine to show');
  assert.ok(!leaks(mine));
  assert.ok(!JSON.stringify(mine).includes('"ben"'), 'no coworkers at all in My tips');
  // Supervisors don't see other people's amounts either.
  assert.throws(() => f.svc.call(f.u('sup'), 'tips.week', { weekStart: WEEK }), /Managers only/);

  f.svc.call(f.u('mgr'), 'tips.finalize', { weekStart: WEEK });
  sweep();
  assert.ok(!leaks(f.svc.call(ana, 'notifications.list')));
  assert.ok(!leaks(f.svc.call(ana, 'myTips.week', { weekStart: WEEK })));
});

test('staff estimates can wait until the week is final', () => {
  const f = fixture();
  const p = f.pool({ showEstimates: false });
  f.shift('ana', TUE, '16:00', '22:00', 'job_srv');
  f.enter(p.id, TUE, { card: 10000 });
  let mine = f.svc.call(f.u('ana'), 'myTips.week', { weekStart: WEEK });
  assert.deepEqual([mine.items.length, mine.waiting], [0, ['House']]);
  f.svc.call(f.u('mgr'), 'tips.finalize', { weekStart: WEEK });
  mine = f.svc.call(f.u('ana'), 'myTips.week', { weekStart: WEEK });
  assert.deepEqual([mine.items.length, mine.total, mine.waiting], [1, 10000, []]);
});

test('permissions: admins set up pools, managers enter tips, everyone reads the rules', () => {
  const f = fixture();
  const body = { name: 'X', jobs: [{ jobCodeId: 'job_srv', points: 1 }] };
  for (const who of ['mgr', 'sup', 'ana']) assert.throws(() => f.svc.call(f.u(who), 'tipPools.save', body), /Admins only/);
  const p = f.svc.call(f.u('owner'), 'tipPools.save', body);
  assert.deepEqual([p.period, p.method, p.contributions[0].source], ['day', 'hours_points', 'all'], 'defaults: per day, hours × points, all tips');
  assert.throws(() => f.svc.call(f.u('owner'), 'tipPools.save', { name: 'Y', jobs: [] }), /at least one position/);
  assert.throws(() => f.svc.call(f.u('owner'), 'tipPools.save', { name: 'Y', jobs: [{ jobCodeId: 'job_srv', points: 0 }] }), /between 0\.01 and 10/);
  for (const who of ['sup', 'ana']) {
    assert.throws(() => f.enter(p.id, TUE, { card: 100 }, who), /Managers only/);
    assert.throws(() => f.svc.call(f.u(who), 'tipPools.delete', { id: p.id }), /Admins only/);
  }
  assert.equal(f.svc.call(f.u('ana'), 'tipPools.list').pools.length, 1);
  assert.throws(() => f.svc.call(null, 'myTips.week', {}), /sign in/);
  f.enter(p.id, TUE, { card: 100 });
  f.svc.call(f.u('owner'), 'tipPools.delete', { id: p.id });
  assert.equal(f.store.get('tipPools', p.id).archived, true, 'a pool with tips is archived, not deleted');
  assert.equal(f.svc.call(f.u('ana'), 'tipPools.list').pools.length, 0);
});

test('the settings example uses the same math and adds up', () => {
  const pool = normalizePool({ id: 'p', jobs: [{ jobCodeId: 'a', points: 1 }, { jobCodeId: 'b', points: 0.5 }, { jobCodeId: 'c', points: 0.6 }] });
  const ex = exampleSplit(pool, 81240, { jobName: (id) => ({ a: 'Server', b: 'Busser', c: 'Food Runner' })[id] });
  assert.equal(ex.people.length, 5);
  assert.equal(ex.people.reduce((t, p) => t + p.amount, 0), 81240);
  assert.equal(ex.people[0].name, 'Server A');
});

test('the demo has a house pool and a Rabbit Hole pool with a week of tips', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T12:00:00') });
  const rep = svc.call(store.get('users', ids.userId.Moe), 'tips.week', { weekStart: WEEK });
  assert.deepEqual(rep.pools.map((p) => p.pool.name), ['House pool', 'Rabbit Hole bar']);
  for (const pr of rep.pools) for (const per of pr.periods) {
    assert.equal(per.people.reduce((t, p) => t + p.amount, 0), per.total, `${pr.pool.name} ${per.label} adds up`);
    assert.deepEqual(per.warnings.filter((w) => w.block), []);
  }
  const alex = svc.call(store.get('users', ids.userId['Alex D']), 'myTips.week', { weekStart: WEEK });
  assert.ok(alex.items.length >= 2 && alex.total > 0);
});

test('HTTP: staff get their own tips and nothing else; managers enter and finalize', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email) => {
    let cookie = '';
    const post = async (path, body = {}) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    assert.equal((await post('/api/auth/login', { email, password: 'demo1234' })).status, 200);
    return (method, args) => post(`/api/rpc/${method}`, args);
  };
  try {
    const alex = await client('alexd@demo.shiftboard');
    const moe = await client('moe@demo.shiftboard');
    assert.equal((await alex('tips.week', { weekStart: WEEK })).status, 403);
    assert.equal((await alex('tipEntries.save', { poolId: 'tpl_house', date: TUE, card: 1 })).status, 403);
    const mine = (await alex('myTips.week', { weekStart: WEEK })).body.result;
    assert.ok(mine.items.length >= 2);
    assert.ok(!JSON.stringify(mine).includes('usr_'), 'no other people in it');
    const saved = await moe('tipEntries.save', { poolId: 'tpl_house', date: '2026-10-03', card: 50000, cash: 0 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await moe('tips.week', { weekStart: WEEK })).body.result.pools[0].days[5].total, 50000);
    assert.equal((await moe('tips.finalize', { weekStart: WEEK })).status, 200);
    assert.equal((await moe('tipEntries.save', { poolId: 'tpl_house', date: '2026-10-03', card: 1 })).status, 409);
    const note = (await alex('notifications.list')).body.result[0];
    assert.match(note.text, /^Your tips for Sep 28 – Oct 4 are final: \$[\d,]+\.\d\d\./);
    assert.equal(note.link, '#/tips/2026-09-28');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
