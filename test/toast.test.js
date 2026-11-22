// Toast POS integration: HTTP client (mocked fetch, no network), sync, mappings, cron and labor math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { summarizeOrders, applyDay, applyLists, matchEmployees, matchJobs, isManualSales, localStamp, upsertSales } from '../core/toast.js';
import { laborReview } from '../core/labor.js';
import { createToastClient, toastConfig, _tokenCache, DEFAULT_HOST } from '../server/toast.js';
import { runToastSync, syncRange, cronRange } from '../server/toast-sync.js';
import { cronAuthorized } from '../server/toast-routes.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { cookieFor } from './helpers/signin.js';

const HOST = 'https://toast.example.test';
const GUID = 'rest-0000-test';
const ENV = { TOAST_CLIENT_ID: 'client-id', TOAST_CLIENT_SECRET: 'test-secret', TOAST_RESTAURANT_GUID: GUID, TOAST_API_HOST: HOST };
const noSleep = async () => {};

// ---------- a fake Toast API, as a fetch function ----------

const order = (guid, { guests = 2, amount = 50, voided = false, deleted = false, checks } = {}) => ({
  guid, numberOfGuests: guests, voided, deleted,
  checks: checks || [{ guid: `${guid}-c1`, amount, voided: false, deleted: false, selections: [] }],
});
const entry = (guid, emp, job, date, inIso, outIso, extra = {}) => ({
  guid, employeeReference: { guid: emp }, jobReference: { guid: job }, businessDate: date.replaceAll('-', ''),
  inDate: inIso, outDate: outIso, regularHours: 6, overtimeHours: 0, hourlyWage: 15, declaredCashTips: 10, nonCashTips: 80,
  cashGratuityServiceCharges: 0, nonCashGratuityServiceCharges: 12.5, deleted: false, breaks: [], ...extra,
});

function fakeToast({ orders = {}, entries = {}, employees = [], jobs = [], restaurant = { general: { name: 'Test Bistro', locationName: 'Downtown', timeZone: 'America/Denver', closeoutHour: 4 } }, linkHeaders = false, expiresIn = 86400 } = {}) {
  const log = { logins: 0, calls: [] };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  let token = null;
  log.revoke = () => { token = null; };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    log.calls.push(u.pathname + u.search);
    if (u.pathname === '/authentication/v1/authentication/login') {
      const b = JSON.parse(init.body);
      assert.equal(init.method, 'POST');
      assert.equal(b.userAccessType, 'TOAST_MACHINE_CLIENT');
      if (b.clientId !== ENV.TOAST_CLIENT_ID || b.clientSecret !== ENV.TOAST_CLIENT_SECRET) return json(401, { status: 'ERROR', message: 'Access denied' });
      log.logins++;
      token = `token-${log.logins}`;
      return json(200, { status: 'SUCCESS', token: { tokenType: 'Bearer', accessToken: token, expiresIn } });
    }
    if (init.headers?.Authorization !== `Bearer ${token}`) return json(401, { message: 'Unauthorized' });
    if (init.headers?.['Toast-Restaurant-External-ID'] !== GUID) return json(400, { message: 'Missing restaurant' });
    if (u.pathname === `/restaurants/v1/restaurants/${GUID}`) return json(200, restaurant);
    if (u.pathname === '/labor/v1/employees') return json(200, employees);
    if (u.pathname === '/labor/v1/jobs') return json(200, jobs);
    if (u.pathname === '/labor/v1/timeEntries') return json(200, entries[u.searchParams.get('businessDate')] || []);
    if (u.pathname === '/orders/v2/ordersBulk') {
      const all = orders[u.searchParams.get('businessDate')] || [];
      const size = Number(u.searchParams.get('pageSize'));
      const page = Number(u.searchParams.get('page'));
      const rows = all.slice((page - 1) * size, page * size);
      const headers = {};
      if (linkHeaders) {
        const next = page * size < all.length ? `, <${HOST}${u.pathname}?page=${page + 1}>; rel="next"` : '';
        headers.Link = `<${HOST}${u.pathname}?page=${page}>; rel="self"${next}`;
      }
      return json(200, rows, headers);
    }
    return json(404, { message: `No route ${u.pathname}` });
  };
  return { fetch, log };
}

const client = (fake, extra = {}) => createToastClient({ env: ENV, fetch: fake.fetch, sleep: noSleep, minGapMs: 0, ...extra });

// ---------- configuration ----------

test('config: env names only, production host by default', () => {
  assert.deepEqual(toastConfig({}).missing, ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID']);
  assert.equal(toastConfig({}).host, DEFAULT_HOST);
  assert.equal(toastConfig({}).configured, false);
  const c = toastConfig({ ...ENV, TOAST_API_HOST: `${HOST}/`, CRON_SECRET: 'x' });
  assert.equal(c.configured, true);
  assert.equal(c.host, HOST);
  assert.equal(c.cron, true);
  assert.ok(!JSON.stringify(c).includes(ENV.TOAST_CLIENT_SECRET), 'the secret is never echoed');
});

// ---------- auth & token cache ----------

test('token: one login, cached across clients until it expires; a 401 gets one fresh token', async () => {
  _tokenCache.clear();
  let now = 1_000_000;
  const fake = fakeToast({ expiresIn: 3600 });
  const a = client(fake, { now: () => now });
  await Promise.all([a.employees(), a.jobs(), a.employees()]);
  assert.equal(fake.log.logins, 1, 'concurrent requests share one login');
  await client(fake, { now: () => now }).jobs();
  assert.equal(fake.log.logins, 1, 'a new client in the same instance reuses the cached token');

  now += 3600 * 1000 - 4 * 60 * 1000; // within 5 minutes of expiry
  await a.jobs();
  assert.equal(fake.log.logins, 2, 'renewed shortly before it expires');

  fake.log.revoke(); // Toast invalidates the token early
  await a.jobs();
  assert.equal(fake.log.logins, 3, 'a 401 triggers one fresh login and the request is retried');

  _tokenCache.clear();
  const bad = createToastClient({ env: { ...ENV, TOAST_CLIENT_SECRET: 'wrong' }, fetch: fake.fetch, sleep: noSleep });
  await assert.rejects(bad.jobs(), /didn’t accept the client ID and secret/);
  _tokenCache.clear();
});

test('rate limit: a 429 waits for Retry-After and tries again', async () => {
  _tokenCache.clear();
  const fake = fakeToast({ jobs: [{ guid: 'j1', title: 'Server' }] });
  let limited = 1;
  const waits = [];
  const fetch = async (url, init) => {
    if (url.includes('/labor/v1/jobs') && limited-- > 0) return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
    return fake.fetch(url, init);
  };
  const c = createToastClient({ env: ENV, fetch, sleep: async (ms) => { waits.push(ms); }, minGapMs: 0 });
  assert.equal((await c.jobs()).length, 1);
  assert.deepEqual(waits, [2000]);
  _tokenCache.clear();
});

// ---------- orders ----------

test('orders: every page of ordersBulk, with or without Link headers', async () => {
  _tokenCache.clear();
  const many = Array.from({ length: 237 }, (_, i) => order(`o${i}`));
  for (const linkHeaders of [false, true]) {
    _tokenCache.clear();
    const fake = fakeToast({ orders: { 20260921: many }, linkHeaders });
    const got = await client(fake).orders('2026-09-21');
    assert.equal(got.length, 237);
    const pages = fake.log.calls.filter((c) => c.startsWith('/orders/v2/ordersBulk'));
    assert.equal(pages.length, 3, `${linkHeaders ? 'Link' : 'full-page'} pagination`);
    assert.ok(pages.every((p) => p.includes('businessDate=20260921') && p.includes('pageSize=100')));
    assert.deepEqual(pages.map((p) => new URL(`http://x${p}`).searchParams.get('page')), ['1', '2', '3']);
  }
  // Exactly one full page and nothing after it.
  _tokenCache.clear();
  const fake = fakeToast({ orders: { 20260922: many.slice(0, 100) } });
  assert.equal((await client(fake).orders('2026-09-22')).length, 100);
  _tokenCache.clear();
});

test('net sales and covers leave out voided and deleted orders and checks, and gift cards', () => {
  const s = summarizeOrders([
    order('a', { guests: 2, amount: 40.25 }),
    order('b', { guests: 4, amount: 100, voided: true }),
    order('c', { guests: 3, amount: 70, deleted: true }),
    order('d', { guests: 5, checks: [
      { guid: 'd1', amount: 80, voided: false, selections: [{ price: 25, selectionType: 'TOAST_CARD_SELL' }, { price: 55, selectionType: 'NONE' }] },
      { guid: 'd2', amount: 30, voided: true },
      { guid: 'd3', amount: 20, deleted: true },
    ] }),
    order('e', { guests: 6, checks: [{ guid: 'e1', amount: 90, voided: true }] }), // every check voided
    null,
  ]);
  assert.deepEqual(s, { sales: 95.25, covers: 7, orders: 2, skipped: 4 });
});

// ---------- applying a day (sales + time entries), idempotent ----------

function toastData() {
  const employees = [
    { guid: 'e-ann', firstName: 'Ann', lastName: 'Lee', email: 'ANN@example.com' },
    { guid: 'e-bo', firstName: 'Bo', lastName: 'Diaz', email: '' },
    { guid: 'e-cy', firstName: 'Cy', lastName: 'Unknown' },
  ];
  const jobs = [{ guid: 'j-srv', title: 'Servers', code: 'SRV' }, { guid: 'j-cook', title: 'Line Cook' }];
  return { employees, jobs };
}
function people() {
  const store = new MemoryStore();
  store.insert('users', { id: 'u-ann', name: 'Annie', email: 'ann@example.com', role: 'employee', jobCodes: [{ jobCodeId: 'job-srv', rate: 14 }] });
  store.insert('users', { id: 'u-bo', name: 'Bo D', email: '', role: 'employee', jobCodes: [] });
  store.insert('users', { id: 'u-mgr', name: 'Mo', email: 'mo@example.com', role: 'manager', jobCodes: [] });
  store.insert('jobCodes', { id: 'job-srv', name: 'Server', short: 'SRV', defaultRate: 12 });
  store.insert('jobCodes', { id: 'job-host', name: 'Host', short: 'HOST', defaultRate: 15 });
  return store;
}

test('a re-sync replaces the day: no duplicates, deleted entries go away, hand-typed sales stay', () => {
  const store = people();
  const { employees, jobs } = toastData();
  applyLists(store, { employees, jobs, restaurant: { general: { name: 'Test Bistro', timeZone: 'America/Denver' } } });
  const date = '2026-09-21';
  const entries = [
    entry('t1', 'e-ann', 'j-srv', date, '2026-09-21T22:00:00.000Z', '2026-09-22T04:05:00.000Z'),
    entry('t2', 'e-cy', 'j-cook', date, '2026-09-21T21:00:00.000Z', '2026-09-22T03:00:00.000Z'),
  ];
  const orders = [order('a', { guests: 2, amount: 50 }), order('b', { guests: 3, amount: 75.5 })];
  const r1 = applyDay(store, { date, orders, entries });
  assert.equal(r1.sales.saved, 'added');
  assert.deepEqual(r1.entries, { found: 2, added: 2, updated: 0, removed: 0, unmatched: 1 });
  const sale = store.get('sales', date);
  assert.equal(sale.source, 'toast');
  assert.equal(sale.sales, 125.5);
  assert.equal(sale.covers, 5);

  const t1 = store.get('timeEntries', 'toast_t1');
  for (const k of ['id', 'source', 'externalId', 'date', 'userId', 'toastEmployeeId', 'jobCodeId', 'toastJobId', 'inAt', 'outAt', 'regularHours', 'overtimeHours', 'hourlyWage', 'declaredCashTips', 'nonCashTips']) {
    assert.ok(k in t1, `time entry has ${k}`);
  }
  assert.equal(t1.userId, 'u-ann');
  assert.equal(t1.jobCodeId, 'job-srv');
  assert.equal(t1.date, date);
  assert.equal(t1.inLocal, '2026-09-21T16:00', 'local time in the restaurant’s zone');
  assert.equal(t1.nonCashGratuityServiceCharges, 12.5);

  // Same data again: nothing new.
  const r2 = applyDay(store, { date, orders, entries });
  assert.equal(r2.sales.saved, 'same');
  assert.deepEqual(r2.entries, { found: 2, added: 0, updated: 0, removed: 0, unmatched: 1 });
  assert.equal(store.list('timeEntries').length, 2);
  assert.equal(store.list('sales').length, 1);

  // Toast deleted t2, and edited t1.
  const r3 = applyDay(store, { date, orders, entries: [{ ...entries[0], regularHours: 6.5 }, { ...entries[1], deleted: true }] });
  assert.deepEqual(r3.entries, { found: 1, added: 0, updated: 1, removed: 1, unmatched: 0 });
  assert.equal(store.get('timeEntries', 'toast_t1').regularHours, 6.5);
  // An entry Toast no longer reports for the day is dropped too.
  applyDay(store, { date, orders, entries: [] });
  assert.equal(store.list('timeEntries').length, 0);

  // A manager typed a day in by hand (Sales history): Toast keeps it unless asked to replace it.
  store.insert('sales', { id: '2026-09-22', date: '2026-09-22', sales: 999, covers: 9, notes: '' });
  assert.equal(applyDay(store, { date: '2026-09-22', orders }).sales.saved, 'kept');
  assert.equal(store.get('sales', '2026-09-22').sales, 999);
  assert.equal(store.get('sales', '2026-09-22').toast.sales, 125.5, 'Toast’s number is kept alongside');
  assert.equal(applyDay(store, { date: '2026-09-22', orders, replaceManual: true }).sales.saved, 'updated');
  assert.equal(store.get('sales', '2026-09-22').sales, 125.5);
  assert.equal(store.get('sales', '2026-09-22').replaced.sales, 999);

  // Editing a synced day by hand makes it manual; re-saving it unchanged doesn't.
  assert.equal(isManualSales(store.get('sales', date)), false);
  store.update('sales', date, { sales: 125.5, covers: 5, notes: '' });
  assert.equal(isManualSales(store.get('sales', date)), false);
  store.update('sales', date, { sales: 130 });
  assert.equal(isManualSales(store.get('sales', date)), true);
  assert.equal(upsertSales(store, date, { sales: 125.5, covers: 5, orders: 2 }), 'kept');
});

test('forecast overrides are never touched by a sync', () => {
  const store = people();
  store.insert('forecastOverrides', { id: '2026-09-21', date: '2026-09-21', covers: 300, sales: 20000 });
  applyDay(store, { date: '2026-09-21', orders: [order('a')], entries: [] });
  assert.deepEqual(store.get('forecastOverrides', '2026-09-21'), { id: '2026-09-21', date: '2026-09-21', covers: 300, sales: 20000 });
});

test('local time follows the restaurant’s zone', () => {
  assert.equal(localStamp('2026-09-22T04:05:00.000Z', 'America/Denver'), '2026-09-21T22:05');
  assert.equal(localStamp('2026-01-15T17:30:00Z', 'America/New_York'), '2026-01-15T12:30');
  assert.equal(localStamp(null, 'America/Denver'), null);
});

// ---------- mapping ----------

test('employees match by email, then name; jobs by name; hand-made matches stick', () => {
  const users = [
    { id: 'u1', name: 'Alex D', email: '' }, { id: 'u2', name: 'Mary Ann', email: '' }, { id: 'u3', name: 'Moe', email: 'boss@example.com' },
    { id: 'u4', name: 'Sam', email: '' }, { id: 'u5', name: 'Pat Kim', email: '' }, { id: 'u6', name: 'Lee', email: '' },
  ];
  const toast = [
    { id: 't1', firstName: 'Alex', lastName: 'Dunn', email: '' }, // first + last initial
    { id: 't2', firstName: 'Mary Ann', lastName: 'Ortiz', email: '' }, // first name only, unique
    { id: 't3', firstName: 'Maurice', lastName: 'B', email: 'Boss@Example.com' }, // email wins
    { id: 't4', firstName: 'Sam', lastName: 'One', email: '' }, // two Sams in Toast: ambiguous
    { id: 't5', firstName: 'Sam', lastName: 'Two', email: '' },
    { id: 't6', firstName: 'Patricia', chosenName: 'Pat', lastName: 'Kim', email: '' }, // chosen name + last
    { id: 't7', firstName: 'Lee', lastName: 'Park', email: '', userId: null, matchedBy: 'manual' }, // left unmatched on purpose
  ];
  const m = matchEmployees(toast, users);
  assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, `${v.userId}/${v.by}`])), {
    t1: 'u1/name', t2: 'u2/name', t3: 'u3/email', t6: 'u5/name',
  });

  const jm = matchJobs([{ id: 'j1', title: 'Servers' }, { id: 'j2', title: 'Line Cook', code: '' }, { id: 'j3', title: 'Bar', code: 'BAR' }, { id: 'j4', title: 'Host', jobCodeId: 'x', matchedBy: 'manual' }],
    [{ id: 'srv', name: 'Server', short: 'SRV' }, { id: 'bar', name: 'Bartender', short: 'BAR' }, { id: 'host', name: 'Host', short: 'HOST' }]);
  assert.deepEqual(Object.fromEntries([...jm].map(([k, v]) => [k, v.jobCodeId])), { j1: 'srv', j3: 'bar' });
});

test('matching by hand re-points clock-ins; later syncs keep it', () => {
  const store = people();
  const { employees, jobs } = toastData();
  const lists = applyLists(store, { employees, jobs });
  assert.equal(lists.employeesMatched, 2, 'Ann by email, Bo by first name + last initial');
  assert.equal(store.get('toastEmployees', 'e-bo').userId, 'u-bo');
  applyDay(store, { date: '2026-09-21', entries: [entry('t2', 'e-cy', 'j-cook', '2026-09-21', '2026-09-21T21:00:00Z', '2026-09-22T03:00:00Z')] });
  assert.equal(store.get('timeEntries', 'toast_t2').userId, null);

  const svc = createService(store);
  const mgr = store.get('users', 'u-mgr');
  assert.throws(() => svc.call(store.get('users', 'u-ann'), 'toast.saveMapping', { employees: [{ id: 'e-cy', userId: 'u-mgr' }] }), /Managers only/);
  assert.throws(() => svc.call(mgr, 'toast.saveMapping', { employees: [{ id: 'e-cy', userId: 'u-ann' }] }), /already matched/);
  const r = svc.call(mgr, 'toast.saveMapping', { employees: [{ id: 'e-cy', userId: 'u-mgr' }], jobs: [{ id: 'j-cook', jobCodeId: 'job-host' }] });
  assert.equal(r.entriesUpdated, 1);
  const t2 = store.get('timeEntries', 'toast_t2');
  assert.equal(t2.userId, 'u-mgr');
  assert.equal(t2.jobCodeId, 'job-host');

  // Next sync: Toast's names change, the hand-made match stays.
  applyLists(store, { employees: employees.map((e) => (e.guid === 'e-cy' ? { ...e, firstName: 'Cyrus' } : e)), jobs });
  assert.equal(store.get('toastEmployees', 'e-cy').userId, 'u-mgr');
  assert.equal(store.get('toastEmployees', 'e-cy').name, 'Cyrus Unknown');
  assert.equal(store.get('toastJobs', 'j-cook').jobCodeId, 'job-host');

  const info = svc.call(mgr, 'toast.get');
  assert.equal(info.employees.length, 3);
  assert.equal(info.totals.unmatchedEntries, 0);
});

// ---------- the sync run, against the real database layer ----------

async function freshDb() {
  const conn = await openPglite();
  const db = new DocDb(conn);
  await db.migrate();
  await db.run((s) => {
    s.insert('users', { id: 'u-ann', name: 'Annie', email: 'ann@example.com', role: 'employee', jobCodes: [] });
    s.insert('jobCodes', { id: 'job-srv', name: 'Server', short: 'SRV', defaultRate: 12 });
  }, { write: true });
  return { db, close: () => conn.end() };
}

test('sync: day by day within a time budget, then continues; running it twice changes nothing', async () => {
  _tokenCache.clear();
  const { db, close } = await freshDb();
  try {
    const { employees, jobs } = toastData();
    const orders = {}, entries = {};
    for (const d of ['20260914', '20260915', '20260916', '20260917']) {
      orders[d] = Array.from({ length: 130 }, (_, i) => order(`${d}-${i}`, { guests: 2, amount: 10, voided: i % 13 === 0 }));
      entries[d] = [entry(`${d}-t1`, 'e-ann', 'j-srv', `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, '2026-09-14T22:00:00Z', '2026-09-15T04:00:00Z')];
    }
    const fake = fakeToast({ orders, entries, employees, jobs });
    let clock = 0;
    const slowClient = (() => {
      const c = client(fake);
      return { ...c, orders: async (d) => { clock += 4000; return c.orders(d); } }; // each day "takes" 4 s
    })();
    const first = await runToastSync({ db, env: ENV, client: slowClient, from: '2026-09-14', to: '2026-09-17', refresh: true, by: 'u-ann',
      run: { id: 'r1', from: '2026-09-14', to: '2026-09-17' }, budgetMs: 10_000, clock: () => clock });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.done.length, 2);
    assert.equal(first.next, '2026-09-16');
    assert.equal(first.lists.employeesMatched, 1);
    const second = await runToastSync({ db, env: ENV, client: slowClient, from: first.next, to: '2026-09-17', by: 'u-ann',
      run: { id: 'r1', from: '2026-09-14', to: '2026-09-17' }, budgetMs: 10_000, clock: () => clock });
    assert.equal(second.next, null);
    assert.deepEqual(second.done.map((d) => d.date), ['2026-09-16', '2026-09-17']);

    const count = (col) => db.store.list(col).length;
    assert.equal(count('sales'), 4);
    assert.equal(count('timeEntries'), 4);
    const day = db.store.get('sales', '2026-09-14');
    assert.equal(day.covers, 2 * 120, '10 voided orders left out');
    assert.equal(day.sales, 1200);
    const status = db.store.get('integrations', 'toast');
    assert.equal(status.restaurantName, 'Test Bistro');
    assert.equal(status.lastSync.days, 4, 'chunks of one run add up');
    assert.equal(status.lastSync.finished, true);

    // Everything again, in one go: same documents, nothing duplicated.
    const before = JSON.stringify(['sales', 'timeEntries'].map((c) => db.store.list(c).map(({ syncedAt, toast, ...d }) => d).sort((a, b) => a.id.localeCompare(b.id))));
    const again = await runToastSync({ db, env: ENV, client: client(fake), from: '2026-09-14', to: '2026-09-17', refresh: true, budgetMs: 60_000 });
    assert.equal(again.done.length, 4);
    assert.ok(again.done.every((d) => d.sales.saved === 'same' && d.entries.added === 0 && d.entries.updated === 0));
    const after = JSON.stringify(['sales', 'timeEntries'].map((c) => db.store.list(c).map(({ syncedAt, toast, ...d }) => d).sort((a, b) => a.id.localeCompare(b.id))));
    assert.equal(after, before);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM shiftboard.docs WHERE col IN ('sales', 'timeEntries') AND NOT deleted`);
    assert.equal(rows[0].n, 8);

    // A Toast error is reported, not thrown, and recorded for the Settings page.
    const broken = { ...client(fake), orders: async () => { throw new Error('boom'); } };
    const failed = await runToastSync({ db, env: ENV, client: broken, from: '2026-09-14', to: '2026-09-14' });
    assert.equal(failed.ok, false);
    assert.equal(db.store.get('integrations', 'toast').lastSync.ok, false);
  } finally { await close(); _tokenCache.clear(); }
});

test('sync ranges: never today, 14 days by default; the cron catches up on missed days', () => {
  assert.deepEqual(syncRange({}, '2026-11-21'), { from: '2026-11-07', to: '2026-11-20' });
  assert.deepEqual(syncRange({ from: '2026-11-15', to: '2026-11-30' }, '2026-11-21'), { from: '2026-11-15', to: '2026-11-20' });
  assert.deepEqual(syncRange({ from: '2025-01-01', to: '2026-11-20' }, '2026-11-21').from, '2026-08-21');
  const store = new MemoryStore();
  assert.deepEqual(cronRange(store, '2026-11-21'), { from: '2026-11-18', to: '2026-11-20' });
  store.insert('integrations', { id: 'toast', cronThrough: '2026-11-12' });
  assert.deepEqual(cronRange(store, '2026-11-21'), { from: '2026-11-13', to: '2026-11-20' });
  store.update('integrations', 'toast', { cronThrough: '2026-10-01' });
  assert.deepEqual(cronRange(store, '2026-11-21'), { from: '2026-11-07', to: '2026-11-20' });
});

// ---------- HTTP: cron secret and permissions ----------

test('cron secret: Bearer token must match CRON_SECRET; missing secret fails closed', () => {
  assert.equal(cronAuthorized('Bearer s3cret-value', 's3cret-value'), true);
  assert.equal(cronAuthorized('Bearer wrong', 's3cret-value'), false);
  assert.equal(cronAuthorized('s3cret-value', 's3cret-value'), false);
  assert.equal(cronAuthorized('', 's3cret-value'), false);
  assert.equal(cronAuthorized('Bearer ', ''), false);
  assert.equal(cronAuthorized(undefined, undefined), false);
});

test('HTTP: status and Sync now are for managers; the cron needs the secret', async () => {
  _tokenCache.clear();
  const conn = await openPglite();
  const db = new DocDb(conn);
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const fake = fakeToast({ employees: [{ guid: 'e-moe', firstName: 'Moe', lastName: 'Smith', email: 'moe@demo.shiftboard' }], jobs: [{ guid: 'j-mgr', title: 'Manager' }] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith(HOST) ? fake.fetch(url, init) : realFetch(url, init));
  const env = { SEED_DEMO: 'true', ...ENV, CRON_SECRET: 'cron-test-value' };
  const app = createApp({ db, env });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (email) => cookieFor(base, email, 'demo1234', { fetchImpl: realFetch });
  const req = (path, { cookie, method = 'GET', body, auth } = {}) => realFetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(auth ? { Authorization: auth } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    const moe = await login('moe@demo.shiftboard');
    const styves = await login('styves@demo.shiftboard');
    assert.equal((await req('/api/toast/status')).status, 401);
    assert.equal((await req('/api/toast/status', { cookie: styves })).status, 403);
    const st = await req('/api/toast/status', { cookie: moe });
    assert.equal(st.status, 200);
    assert.deepEqual(st.body.result, { configured: true, missing: [], host: HOST, cron: true });

    assert.equal((await req('/api/toast/sync', { cookie: styves, method: 'POST', body: {} })).status, 403);
    const synced = await req('/api/toast/sync', { cookie: moe, method: 'POST', body: { from: yesterday, to: yesterday } });
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.equal(synced.body.result.done.length, 1);
    assert.equal(synced.body.result.lists.employeesMatched, 1, 'Moe matched by email');

    assert.equal((await req('/api/cron/toast')).status, 401);
    assert.equal((await req('/api/cron/toast', { auth: 'Bearer nope' })).status, 401);
    const cron = await req('/api/cron/toast', { auth: 'Bearer cron-test-value' });
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    assert.equal(cron.body.result.ok, true);
    assert.equal(cron.body.result.to, yesterday);
    assert.equal(db.store.get('integrations', 'toast').lastCron.by, 'cron');

    // Labor review over HTTP (read-only RPC): managers only.
    assert.equal((await req('/api/rpc/labor.week', { cookie: styves, method: 'POST', body: {} })).status, 403);
    assert.equal((await req('/api/rpc/labor.week', { cookie: moe, method: 'POST', body: { weekStart: '2026-09-14' } })).body.result.totals.actual.entries > 100, true);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
    _tokenCache.clear();
  }
});

test('without Toast env vars the cron does nothing and Sync now explains what to add', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', CRON_SECRET: 'cron-test-value' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cron = await fetch(`${base}/api/cron/toast`, { headers: { Authorization: 'Bearer cron-test-value' } });
    assert.equal(cron.status, 200);
    assert.match((await cron.json()).result.skipped, /not set up/);
    const cookie = await cookieFor(base, 'moe@demo.shiftboard');
    const r = await fetch(`${base}/api/toast/sync`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_RESTAURANT_GUID/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});

// ---------- labor comparison math ----------

test('labor review: hours, cost, overtime, labor % and who was off-schedule', () => {
  const settings = { overtimeHours: 40, weekStartDow: 1, closedDays: [], targetLaborPct: 30, openEndHours: 7, hours: {} };
  const users = [
    { id: 'ann', name: 'Ann', jobCodes: [{ jobCodeId: 'srv', rate: 10 }] },
    { id: 'bo', name: 'Bo', jobCodes: [{ jobCodeId: 'srv' }] },
    { id: 'cy', name: 'Cy', jobCodes: [{ jobCodeId: 'host' }] },
  ];
  const jobCodes = [{ id: 'srv', name: 'Server', defaultRate: 12 }, { id: 'host', name: 'Host', defaultRate: 15 }];
  const shift = (id, userId, date, start, end, jobCodeId = 'srv', extra = {}) => ({ id, userId, date, start, end, jobCodeId, published: true, ...extra });
  const shifts = [
    // Ann: 5 × 9h = 45 h scheduled → 5 h overtime on Friday
    ...['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'].map((d, i) => shift(`a${i}`, 'ann', d, '09:00', '18:00')),
    shift('b1', 'bo', '2026-09-15', '16:00', '22:00'), // Bo never clocks in
    shift('draft', 'bo', '2026-09-16', '16:00', '22:00', 'srv', { published: false }), // drafts don't count
    shift('open', null, '2026-09-16', '16:00', '22:00'), // open shift: counted separately
  ];
  const te = (id, userId, date, inT, outT, reg, ot = 0, extra = {}) => ({ id, userId, date, jobCodeId: userId === 'cy' ? 'host' : 'srv', inLocal: `${date}T${inT}`, outLocal: `${date}T${outT}`, regularHours: reg, overtimeHours: ot, hourlyWage: null, declaredCashTips: 5, nonCashTips: 20, ...extra });
  const entries = [
    te('t0', 'ann', '2026-09-14', '09:05', '18:00', 8.9),
    te('t1', 'ann', '2026-09-15', '08:55', '18:10', 9.25),
    te('t2', 'ann', '2026-09-16', '09:00', '18:00', 9),
    te('t3', 'ann', '2026-09-17', '09:00', '19:00', 10),
    te('t4', 'ann', '2026-09-18', '09:00', '18:00', 2.85, 6.15, { hourlyWage: 11 }), // Toast wage wins
    te('t5', 'cy', '2026-09-15', '17:00', '21:00', 4), // no shift
    te('t6', null, '2026-09-15', '17:00', '21:00', 4, 0, { toastEmployeeId: 'x', toastEmployeeName: 'Dee Toast', toastJobTitle: 'Dish', jobCodeId: null, hourlyWage: 9 }),
  ];
  const sales = [{ date: '2026-09-14', sales: 1000, covers: 20 }, { date: '2026-09-15', sales: 2000, covers: 40, source: 'toast' }];
  const r = laborReview({ weekStart: '2026-09-14', shifts, entries, sales, users, jobCodes, settings });

  // Scheduled: Ann 45 h at $10 (5 h OT at 1.5×) + Bo 6 h at $12
  assert.equal(r.totals.sched.hours, 51);
  assert.equal(r.totals.sched.ot, 5);
  assert.equal(r.totals.sched.cost, 40 * 10 + 5 * 15 + 6 * 12);
  // Actual: Ann 37.15 reg at $10 + (2.85 + 6.15 × 1.5) at $11; Cy 4 h at $15; Dee 4 h at $9
  const annCost = (8.9 + 9.25 + 9 + 10) * 10 + (2.85 + 6.15 * 1.5) * 11;
  assert.equal(r.totals.actual.hours, Math.round((8.9 + 9.25 + 9 + 10 + 9 + 4 + 4) * 10) / 10);
  assert.equal(r.totals.actual.cost, Math.round((annCost + 60 + 36) * 100) / 100);
  assert.equal(r.totals.actual.ot, 6.2);
  assert.equal(r.totals.actual.tips, 7 * 25);

  const mon = r.days[0], tue = r.days[1];
  assert.equal(mon.sched.hours, 9);
  assert.equal(mon.actual.hours, 8.9);
  assert.equal(mon.actualPct, 8.9, '$89 of $1,000');
  assert.equal(mon.schedPct, 9);
  assert.equal(tue.actual.cost, 92.5 + 60 + 36);
  assert.equal(tue.salesSource, 'toast');
  assert.equal(r.days[5].sales, null);
  assert.equal(r.days[5].schedPct, null, 'nothing scheduled: no labor %');
  // Week labor %: actual over days with clock data (all sales here), scheduled over the week
  assert.equal(r.totals.schedPct, Math.round(((40 * 10 + 5 * 15 + 6 * 12) / 3000) * 1000) / 10);

  assert.deepEqual(r.noShift.map((e) => e.name), ['Cy']);
  assert.deepEqual(r.noClockIn.map((s) => `${s.name} ${s.date}`), ['Bo 2026-09-15']);
  assert.deepEqual(r.overtime.map((o) => [o.name, o.schedOt, o.actualOt]), [['Ann', 5, 6.2]]);
  assert.deepEqual(r.unmatched, { entries: 1, hours: 4 });
  assert.equal(r.openShifts, 1);
  const dee = r.people.find((p) => !p.matched);
  assert.equal(dee.name, 'Dee Toast');
  assert.equal(r.positions.find((p) => p.name === 'Dish').actual.hours, 4);
  assert.equal(r.positions.find((p) => p.jobCodeId === 'srv').sched.shifts, 6);
  assert.equal(r.people.find((p) => p.userId === 'ann').diffHours, Math.round((46.15 - 45) * 10) / 10);
});

test('labor review: a shift with a clock-in at another time of day is both late-listed and unscheduled', () => {
  const settings = { overtimeHours: 40, closedDays: [], hours: {} };
  const r = laborReview({
    weekStart: '2026-09-14',
    shifts: [{ id: 's', userId: 'a', date: '2026-09-14', start: '10:00', end: '14:00', jobCodeId: 'j', published: true },
      { id: 'n', userId: 'a', date: '2026-09-15', start: '22:00', end: '02:00', jobCodeId: 'j', published: true }],
    entries: [{ id: 'e', userId: 'a', date: '2026-09-14', inLocal: '2026-09-14T18:30', outLocal: '2026-09-14T23:00', regularHours: 4.5, overtimeHours: 0 },
      { id: 'o', userId: 'a', date: '2026-09-15', inLocal: '2026-09-15T21:55', outLocal: '2026-09-16T02:10', regularHours: 4.25, overtimeHours: 0 }],
    users: [{ id: 'a', name: 'A' }], jobCodes: [{ id: 'j', name: 'J', defaultRate: 10 }], settings,
  });
  assert.deepEqual(r.noShift.map((e) => e.id), ['e']);
  assert.deepEqual(r.noClockIn.map((s) => s.id), ['s'], 'the overnight shift matched its clock-in');
});

test('demo: Labor review has sample clock-ins for the two weeks before the posted week', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T12:00:00') });
  const moe = store.get('users', ids.userId.Moe);
  const r = svc.call(moe, 'labor.week', {});
  assert.equal(r.weekStart, '2026-09-14', 'opens on last week');
  assert.ok(r.totals.actual.entries > 100);
  assert.ok(r.noShift.length > 0 && r.noClockIn.length > 0 && r.overtime.length > 0);
  assert.ok(r.totals.actualPct > 0);
  assert.throws(() => svc.call(store.get('users', ids.userId.Styves), 'labor.week', {}), /Managers only/);
  // Fields the tip-pool feature reads
  const t = store.list('timeEntries')[0];
  for (const k of ['date', 'userId', 'jobCodeId', 'regularHours', 'overtimeHours', 'declaredCashTips', 'nonCashTips']) assert.ok(k in t, k);
  // Nothing on or after the demo's "today"
  assert.ok(store.list('timeEntries').every((e) => e.date < '2026-09-27'));
});
