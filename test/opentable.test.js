// OpenTable: reading its exports (invented fixtures in test/fixtures/opentable-*.csv, shaped like what
// OpenTable's Guest Center exports are described to look like: an approximation, since OpenTable doesn't
// publish the formats), idempotent re-imports, privacy (no guest phone or email stored), booked covers in the
// forecast, the API client and sync against a fake OpenTable (the real API is partner-only, so its paths are
// UNVERIFIED), and the plan features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { addDays, dow } from '../core/time.js';
import { readFile, readReservations, readReviews, parseWhen, parseRating, shortName, scrub, reservationStatus, chunkItems } from '../core/guest-csv.js';
import { readApiReservation, bookingBlend } from '../core/opentable.js';
import { createOpenTableClient, opentableConfig, _tokenCache } from '../server/opentable.js';
import { featureForMethod, ROUTE_FEATURES, PLANS, resolveFeatures } from '../server/platform/plans.js';
import { tenantEnv, cleanIntegrations, INTEGRATION_FIELDS } from '../server/platform/tenant-env.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { jsonClient, signIn } from './helpers/signin.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const NOW = new Date('2026-08-25T12:00:00');

/** A small team: two people answer to "Alex"? No: Alex D only here; Sam, Will and Rose test everyday words. */
function setup() {
  const store = new MemoryStore();
  const add = (id, name, role = 'employee', extra = {}) => store.insert('users', { id, name, role, email: `${id}@t.test`, jobCodes: [], active: true, ...extra });
  add('kelly', 'Kelly', 'manager'); add('alexd', 'Alex D'); add('sam', 'Samantha'); add('will', 'Will'); add('rose', 'Rose'); add('flor', 'Flor'); add('jamie', 'Jamie'); add('mike', 'Michael');
  store.insert('settings', { id: 'settings', restaurantName: 'Test Bistro', closedDays: [1] });
  const svc = createService(store, { now: () => NOW });
  const as = (id) => store.get('users', id);
  return { store, svc, as };
}
function parseReservations() {
  const f = readFile(fixture('opentable-reservations.csv'), 'reservations');
  return { f, out: readReservations(f.rows, f.mapping, f.headerRow) };
}
function parseReviews(name = 'opentable-reviews.csv', source = '') {
  const f = readFile(fixture(name), 'reviews');
  return { f, out: readReviews(f.rows, f.mapping, f.headerRow, { source }) };
}
const strip = (items) => items.map(({ row, ...x }) => x);

test('reading the reservations export: header after title lines, columns, statuses, names cut, contact details left out', () => {
  const { f, out } = parseReservations();
  assert.equal(f.header[0], 'Visit Date', 'the header is found below the report’s title lines');
  assert.equal(f.header[f.mapping.notes], 'Special Requests');
  assert.equal(f.header[f.mapping.venueNotes], 'Visit Notes');
  assert.deepEqual(out.dropped, ['phone', 'email']);
  assert.equal(out.items.length, 8);
  const [a, b, c, d, e, g, h] = out.items;
  assert.deepEqual([a.date, a.time, a.partySize, a.status, a.key, a.guest, a.server], ['2026-08-07', '19:00', 4, 'done', 'c_10001', 'Dana K.', 'Alex D']);
  assert.equal(b.notes.includes('[phone]'), true, 'a phone number typed in the notes is blanked');
  assert.ok(!JSON.stringify(out.items).match(/555|example\.test|Kimura|Sandoval/), 'no phone, email or last name in what goes to the server');
  assert.equal(c.status, 'noShow');
  assert.equal(d.status, 'cancelled');
  assert.equal(d.guest, 'Marcus T.');
  assert.equal(e.status, 'seated');
  assert.ok(g.notes.includes('[email]'));
  assert.match(h.key, /^h_[0-9a-z]+$/, 'no confirmation number: a stable hash');
  assert.equal(readReservations(f.rows, f.mapping, f.headerRow).items[6].key, h.key, 'the same row always gets the same key');
});

test('small readers: dates, stars, statuses, names, scrubbing, chunks', () => {
  assert.deepEqual(parseWhen('09/19/2026 7:30 PM'), { date: '2026-09-19', time: '19:30' });
  assert.deepEqual(parseWhen('Sat, Sep 19, 2026'), { date: '2026-09-19', time: '' });
  assert.deepEqual(parseWhen('19 de septiembre de 2026'), { date: '2026-09-19', time: '' });
  assert.deepEqual(parseWhen('19/09/2026'), { date: '2026-09-19', time: '' });
  assert.equal(parseWhen('not a date'), null);
  assert.deepEqual(['5', '4.5', '5/5', 'FIVE', '★★★★☆', '50', '9'].map(parseRating), [5, 4.5, 5, 5, 4, 5, 4.5]);
  assert.deepEqual(['Seated', 'Done', 'No Show', 'Canceled by guest', 'Confirmed', ''].map(reservationStatus), ['seated', 'done', 'noShow', 'cancelled', 'booked', 'booked']);
  assert.equal(shortName('Dana Kimura'), 'Dana K.');
  assert.equal(shortName('KIMURA, DANA'), 'Dana K.');
  assert.equal(shortName('dana@example.test'), '');
  assert.equal(scrub('call 303.555.0100 or a@b.co, party on 2026-09-19'), 'call [phone] or [email], party on 2026-09-19');
  const parts = chunkItems(Array.from({ length: 50 }, (_, i) => ({ i, text: 'x'.repeat(1000) })), 10_000);
  assert.ok(parts.length > 4 && parts.flat().length === 50);
});

test('import is idempotent: the same file twice adds nothing, and nothing is counted twice', () => {
  const { store, svc, as } = setup();
  const items = strip(parseReservations().out.items);
  const first = svc.call(as('kelly'), 'opentable.import', { kind: 'reservations', items, fileName: 'res.csv' });
  assert.equal(first.counts.new, 8);
  const mentions = store.list('impactMentions').length;
  const preview = svc.call(as('kelly'), 'opentable.previewImport', { kind: 'reservations', items });
  assert.deepEqual([preview.counts.new, preview.counts.same], [0, 8]);
  const again = svc.call(as('kelly'), 'opentable.import', { kind: 'reservations', items, fileName: 'res.csv' });
  assert.deepEqual([again.counts.new, again.counts.updated, again.counts.same], [0, 0, 8]);
  assert.equal(store.list('otReservations').length, 8);
  assert.equal(store.list('impactMentions').length, mentions);
  // A newer export: one booking's status changed. Updated in place.
  const changed = items.map((r) => (r.key === 'c_10007' ? { ...r, status: 'done' } : r));
  const third = svc.call(as('kelly'), 'opentable.import', { kind: 'reservations', items: changed });
  assert.deepEqual([third.counts.updated, third.counts.same], [1, 7]);
  assert.equal(store.get('otReservations', 'otr_c_10007').status, 'done');
  // Reviews: twice, and then the same review from the API with an id (a different key): still one.
  const reviews = strip(parseReviews().out.items);
  svc.call(as('kelly'), 'opentable.import', { kind: 'reviews', items: reviews });
  const r2 = svc.call(as('kelly'), 'opentable.import', { kind: 'reviews', items: reviews });
  assert.equal(r2.counts.same, 5);
  const fromApi = { ...reviews[1], key: 'i_api-777', externalId: 'api-777' };
  svc.opentable.applyReviews([fromApi], { origin: 'api' });
  assert.equal(store.list('guestReviews').length, 5);
  const report = svc.call(as('kelly'), 'impact.summary', { period: 'month', month: '2026-08' });
  const again2 = svc.call(as('kelly'), 'impact.summary', { period: 'month', month: '2026-08' });
  assert.deepEqual(report.rows, again2.rows);
  assert.ok(svc.call(as('kelly'), 'opentable.get').imports.length >= 3);
});

test('privacy: no guest phone number or email address is stored, from files, from text, or from the API', () => {
  const { store, svc, as } = setup();
  svc.call(as('kelly'), 'opentable.import', { kind: 'reservations', items: strip(parseReservations().out.items) });
  svc.call(as('kelly'), 'opentable.import', { kind: 'reviews', items: strip(parseReviews().out.items) });
  // A careless client sends extra fields and contact details anyway: the server drops and scrubs them.
  svc.call(as('kelly'), 'opentable.import', { kind: 'reservations', items: [{ date: '2026-08-20', time: '19:00', partySize: 2, status: 'Done', guest: 'Zed Quill', phone: '303-555-0177', email: 'zed@example.test', notes: 'text me 303 555 0166', key: 'c_555' }] });
  svc.opentable.applyReservations([readApiReservation({ confirmation_number: 'API1', scheduled_time: '2026-08-21T19:00:00', party_size: 2, state: 'Seated', guest: { first_name: 'Ann', last_name: 'Lee', email: 'ann@example.test', phone: '+13035550155' }, guest_request: 'email ann@example.test' }, { timeZone: 'America/Denver' })]
    .map((r) => ({ ...r, key: r.key, partySize: r.partySize })), { origin: 'api' });
  const all = JSON.stringify(['otReservations', 'guestReviews', 'impactMentions', 'notifications', 'integrations'].flatMap((c) => store.list(c)));
  assert.doesNotMatch(all, /@example\.test/);
  assert.doesNotMatch(all, /555[-. ]?01\d\d|\(303\)|3035550/);
  assert.doesNotMatch(all, /Kimura|Sandoval|Quill/, 'last names are cut to an initial');
  assert.ok(store.list('otReservations').every((r) => !('phone' in r) && !('email' in r)));
});

test('the forecast takes booked covers for upcoming days: bookings less no-shows plus usual walk-ins, never lower than history', () => {
  const { store, svc, as } = setup();
  const today = '2026-08-25'; // a Tuesday (NOW)
  // Eight weeks of history: actual covers and, on those days, reservations seated (60 covers) and a few no-shows.
  for (let w = 1; w <= 8; w++) {
    const sat = addDays('2026-08-29', -7 * w);
    store.insert('sales', { id: sat, date: sat, covers: 200, sales: 12000, notes: '' });
    const items = [];
    for (let i = 0; i < 30; i++) items.push({ key: `c_h${w}_${i}`, date: sat, time: '19:00', partySize: 2, status: 'done' });
    items.push({ key: `c_h${w}_ns`, date: sat, time: '19:00', partySize: 4, status: 'noShow' });
    svc.opentable.applyReservations(items, {});
  }
  const before = svc.call(as('kelly'), 'forecast.week', { weekStart: '2026-08-24' }).days.find((d) => d.date === '2026-08-29');
  assert.equal(before.basisKey, 'weighted');
  // Upcoming Saturday: 180 covers on the books.
  svc.opentable.applyReservations(Array.from({ length: 45 }, (_, i) => ({ key: `c_up${i}`, date: '2026-08-29', time: '19:00', partySize: 4, status: 'booked' })), {});
  const week = svc.call(as('kelly'), 'forecast.week', { weekStart: '2026-08-24' });
  const sat = week.days.find((d) => d.date === '2026-08-29');
  // walk-ins = 200 − 60 = 140; no-shows = 4 / 64 ≈ 6.25% → 180 × 0.9375 + 140 = 309
  assert.equal(sat.basisKey, 'bookings');
  assert.equal(sat.covers, 309);
  assert.deepEqual(sat.basisParams, { booked: 180, walkIns: 140, noShow: 6, history: before.covers, dow: 6 });
  assert.deepEqual(sat.booked, { covers: 180, parties: 45 });
  assert.equal(sat.sales, Math.round(309 * (before.sales / before.covers)));
  // Staff "projected covers" follow.
  assert.equal(svc.call(as('alexd'), 'forecast.covers', { weekStart: '2026-08-24' }).days.find((d) => d.date === '2026-08-29').totalCovers, sat.totalCovers);
  // A few bookings never pull the forecast down; a manager's override wins.
  const fri = week.days.find((d) => d.date === '2026-08-28');
  assert.equal(fri.basisKey === 'bookings', false);
  svc.call(as('kelly'), 'forecast.override', { date: '2026-08-29', covers: 250 });
  assert.equal(svc.call(as('kelly'), 'forecast.week', { weekStart: '2026-08-24' }).days.find((d) => d.date === '2026-08-29').covers, 250);
  // Past days keep their forecast (the bookings show, as information only).
  const blend = bookingBlend(store, svc.settings(), today, '2026-08-17');
  const past = blend({ date: '2026-08-22', covers: 190, sales: 1, basisKey: 'weighted' });
  assert.equal(past.covers, 190);
  assert.equal(dow('2026-08-29'), 6);
});

test('opentable.* is for managers', () => {
  const { svc, as } = setup();
  for (const m of ['opentable.get', 'opentable.previewImport', 'opentable.import']) assert.throws(() => svc.call(as('alexd'), m, { kind: 'reservations', items: [] }), /Managers only/, m);
  assert.throws(() => svc.call(as('kelly'), 'opentable.import', { kind: 'reservations', items: [] }), /no reservations/);
  assert.throws(() => svc.call(as('kelly'), 'opentable.import', { kind: 'menus', items: [{}] }), /reservations or reviews/);
});

test('plan features: opentable and impact are Pro and Beta; RPCs, routes and settings follow the plan', () => {
  for (const f of ['opentable', 'impact']) {
    assert.ok(PLANS.pro.features.includes(f) && PLANS.beta.features.includes(f) && !PLANS.starter.features.includes(f), f);
    assert.equal(resolveFeatures('starter', { [f]: true })[f], true, 'DubLow can switch it on for one restaurant');
  }
  for (const m of ['opentable.get', 'opentable.import', 'opentable.previewImport']) assert.equal(featureForMethod(m), 'opentable');
  for (const m of ['impact.summary', 'impact.get', 'impact.list', 'impact.decide', 'impact.saveKudos', 'impact.importReviews', 'impact.setAka']) assert.equal(featureForMethod(m), 'impact');
  assert.ok(ROUTE_FEATURES.some(([p, f]) => p === '/api/opentable' && f === 'opentable'));
  const fields = Object.fromEntries(INTEGRATION_FIELDS.filter((f) => f.group === 'opentable').map((f) => [f.key, f]));
  assert.ok(fields.OPENTABLE_CLIENT_ID.secret && fields.OPENTABLE_CLIENT_SECRET.secret && !fields.OPENTABLE_RID.secret);
  assert.throws(() => cleanIntegrations({ OPENTABLE_RID: 'downtown' }), /RID\) is a number/);
  const bistro = { id: 't1', slug: 'b', name: 'B', is_default: false, integrations: { OPENTABLE_RID: '123' } };
  const env = tenantEnv({ OPENTABLE_CLIENT_ID: 'platform-id' }, { ...bistro, resolved: { opentable: true } }, { OPENTABLE_CLIENT_ID: 'b-id', OPENTABLE_CLIENT_SECRET: 'b-secret-1' });
  assert.deepEqual([env.OPENTABLE_CLIENT_ID, env.OPENTABLE_RID], ['b-id', '123']);
  const off = tenantEnv({}, { ...bistro, resolved: { opentable: false } }, { OPENTABLE_CLIENT_ID: 'b-id', OPENTABLE_CLIENT_SECRET: 'b-secret-1' });
  assert.ok(!Object.keys(off).some((k) => k.startsWith('OPENTABLE_')));
});

// ---------- the API (UNVERIFIED paths: a fake OpenTable that answers what server/opentable.js asks for) ----------

function fakeOpenTable({ reservations = [], reviews = null, failFirst = {} } = {}) {
  const calls = [];
  let tokenCalls = 0;
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/api/v2/oauth/token') {
      tokenCalls++;
      if (init.headers.Authorization !== `Basic ${Buffer.from('ot-id:ot-secret-1').toString('base64')}`) return json({ error: 'invalid_client' }, 401);
      return json({ access_token: `tok${tokenCalls}`, expires_in: 3600 });
    }
    if (!/^Bearer tok\d+$/.test(init.headers.Authorization)) return json({ error: 'no' }, 401);
    if (failFirst[u.pathname]) { const s = failFirst[u.pathname]; delete failFirst[u.pathname]; return json({ error: 'x' }, s, s === 429 ? { 'Retry-After': '0' } : {}); }
    assert.equal(u.searchParams.get('rid'), '4242');
    assert.ok(init.headers['X-Request-Id']);
    const offset = Number(u.searchParams.get('offset')), limit = Number(u.searchParams.get('limit'));
    if (u.pathname === '/sync/v2/reservations') { const items = reservations.slice(offset, offset + limit); return json({ items, hasNextPage: offset + limit < reservations.length }); }
    if (u.pathname === '/sync/v2/reviews') return reviews ? json({ items: reviews.slice(offset, offset + limit), hasNextPage: false }) : json({ error: 'not granted' }, 403);
    return json({ error: 'no route' }, 404);
  };
  return { fetch, calls, tokens: () => tokenCalls };
}
const OT_ENV = { OPENTABLE_CLIENT_ID: 'ot-id', OPENTABLE_CLIENT_SECRET: 'ot-secret-1', OPENTABLE_RID: '4242', OPENTABLE_API_HOST: 'https://ot.example.test', OPENTABLE_TOKEN_URL: 'https://ot.example.test/api/v2/oauth/token', TIMEZONE: 'America/Denver' };
const apiRes = (i, extra = {}) => ({ confirmation_number: `C${i}`, scheduled_time: `2026-09-0${1 + (i % 5)}T01:30:00Z`, party_size: 2 + (i % 3), state: 'Pending', guest: { first_name: 'Guest', last_name: `Number${i}`, phone: '+13035550100', email: `g${i}@example.test` }, guest_request: i === 2 ? 'Request Sam please' : '', ...extra });

test('API client: client credentials with Basic auth, the token is reused, 401 gets a fresh one, 429 is retried, pages are followed', async () => {
  _tokenCache.clear();
  const fake = fakeOpenTable({ reservations: Array.from({ length: 5 }, (_, i) => apiRes(i)), failFirst: { '/sync/v2/reservations': 429 } });
  const c = createOpenTableClient({ env: OT_ENV, fetch: fake.fetch, sleep: async () => {}, minGapMs: 0, pageSize: 2 });
  assert.equal(opentableConfig(OT_ENV).configured, true);
  assert.deepEqual(opentableConfig({}).missing, ['OPENTABLE_CLIENT_ID', 'OPENTABLE_CLIENT_SECRET', 'OPENTABLE_RID']);
  const p1 = await c.reservations({ since: '2026-08-01T00:00:00Z', offset: 0 });
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.more, true);
  const p3 = await c.reservations({ since: '2026-08-01T00:00:00Z', offset: 4 });
  assert.deepEqual([p3.rows.length, p3.more], [1, false]);
  assert.equal(fake.tokens(), 1, 'one token for every request');
  await assert.rejects(() => c.reviews({ since: '2026-08-01T00:00:00Z' }), (e) => e.status === 403);
  assert.ok(fake.calls.some((x) => x.includes('updated_after=2026-08-01T00%3A00%3A00Z')));
  // A UTC time becomes the restaurant's clock: 01:30 UTC on Sep 2 is 7:30 PM on Sep 1 in Denver.
  const r = readApiReservation(apiRes(0), { timeZone: 'America/Denver' });
  assert.deepEqual([r.date, r.time, r.partySize, r.status, r.key, r.guest], ['2026-08-31', '19:30', 2, 'booked', 'c_C0', 'Guest N.']);
});

test('API sync over HTTP: managers only, chunked, idempotent; no Reviews API grant is a warning; staff are refused', async () => {
  _tokenCache.clear();
  const reservations = Array.from({ length: 7 }, (_, i) => apiRes(i));
  const fake = fakeOpenTable({ reservations });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith('https://ot.example.test') ? fake.fetch(url, init) : realFetch(url, init));
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', CRON_SECRET: 'cron-secret-x', ...OT_ENV } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mgr = jsonClient(base, realFetch);
    assert.equal((await signIn(mgr.post, 'kelly@demo.shiftboard')).status, 200);
    const emp = jsonClient(base, realFetch);
    assert.equal((await signIn(emp.post, 'alexd@demo.shiftboard')).status, 200);
    assert.equal((await emp.post('/api/opentable/sync', {})).status, 403);
    const status = await realFetch(`${base}/api/opentable/status`, { headers: { Cookie: mgr.cookie() } }).then((r) => r.json());
    assert.deepEqual([status.result.configured, status.result.rid], [true, '4242']);
    assert.ok(!JSON.stringify(status).includes('ot-secret'), 'never a secret');
    const before = (await mgr.post('/api/rpc/opentable.get', {})).body.result.totals.reservations;
    let r = await mgr.post('/api/opentable/sync', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.counts.reservationsNew, 7);
    assert.equal(r.body.result.warnings[0].code, 'reviews');
    r = await mgr.post('/api/opentable/sync', {});
    assert.equal(r.body.result.counts.reservationsSame, 7, 'a second sync changes nothing');
    const after = (await mgr.post('/api/rpc/opentable.get', {})).body.result;
    assert.equal(after.totals.reservations, before + 7);
    assert.equal(after.lastSync.ok, true);
    assert.equal((await realFetch(`${base}/api/cron/opentable`)).status, 401);
    const cron = await realFetch(`${base}/api/cron/opentable`, { headers: { Authorization: 'Bearer cron-secret-x' } }).then((x) => x.json());
    assert.equal(cron.result.ok, true);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }
});

test('a restaurant without the features gets 403 for their RPCs and routes', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const tenant = { id: 't-x', slug: 'x', name: 'X', isDefault: true, status: 'active', plan: 'starter', features: resolveFeatures('starter'), consumeSupportGrant: async () => null };
  const app = createApp({ db, env: { SEED_DEMO: 'true' }, tenant });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mgr = jsonClient(base);
    assert.equal((await signIn(mgr.post, 'kelly@demo.shiftboard')).status, 200);
    for (const m of ['opentable.get', 'impact.summary', 'impact.get']) {
      const r = await mgr.post(`/api/rpc/${m}`, {});
      assert.deepEqual([r.status, r.body.error], [403, 'Not included in your plan'], m);
    }
    assert.equal((await mgr.post('/api/opentable/sync', {})).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }
});
