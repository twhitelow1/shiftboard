// Tripleseat → Events & BEOs: request signing, pagination, the status rules, field ownership, room
// matching, notifications to staffed people, cancellations, the webhook, the cron and permissions.
// Every Tripleseat answer comes from a fake fetch below: no network. Values are fake, never real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { mapStatus, cleanRules, readEvent, parseWhen, parseTime, menuLines, menuItemIndex, eventDocId, DEFAULT_RULES } from '../core/tripleseat.js';
import { createTripleseatClient, tripleseatConfig, oauth1Header, oauthEncode, _tokenCache, DEFAULT_HOST } from '../server/tripleseat.js';
import { runTripleseatSync, syncOneEvent } from '../server/tripleseat-sync.js';
import { verifySignature, webhookEventIds } from '../server/tripleseat-routes.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { translateError } from '../core/errors.js';

const HOST = 'https://tripleseat.example.test';
const ENV = { TRIPLESEAT_CLIENT_ID: 'test-client-id', TRIPLESEAT_CLIENT_SECRET: 'test-client-secret', TRIPLESEAT_API_HOST: HOST, TIMEZONE: 'America/Denver' };
const OLD_KEYS = { TRIPLESEAT_PUBLIC_KEY: 'test-public-key', TRIPLESEAT_SECRET_KEY: 'test-secret-key', TRIPLESEAT_API_HOST: HOST };
const TODAY = '2026-11-22';
const noSleep = async () => {};

// ---------- a fake Tripleseat API, as a fetch function ----------

const mdY = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const ymd = (s) => `${s.slice(6, 10)}-${s.slice(0, 2)}-${s.slice(3, 5)}`;
/** A Tripleseat event the way its API answers (with a client contact and account ShiftBoard must never read). */
const tsEvent = (id, { date = '2026-12-05', start = '06:30 PM', end = '10:00 PM', guests = 80, status = 'DEFINITE', rooms = [{ id: 11, name: 'Library' }],
  type = 'Wedding', updated = '11/20/2026 09:15 AM', location = 1, ...extra } = {}) => ({
  id, name: `Event ${id}`, event_start: `${mdY(date)} ${start}`, event_end: `${mdY(date)} ${end}`, guest_count: guests, status, rooms,
  event_type: { id: 3, name: type }, location_id: location, booking_id: 500 + Number(id), owner: { first_name: 'Sam', last_name: 'Seller' }, updated_at: updated,
  url: `${HOST}/events/${id}`,
  contact: { first_name: 'Pat', last_name: 'Client', email: 'pat.client@example.test', phone_number: '555-0100' }, account: { name: 'Client Holdings' },
  ...extra,
});

function fakeTripleseat({ events = [], locations = [{ id: 1, name: 'Test Venue', rooms: [{ id: 11, name: 'Library' }, { id: 12, name: 'Patio Bar' }] }],
  menus = [{ id: 1, name: 'Dinner', categories: [{ name: 'Entrées', menu_items: [{ id: 101, name: 'Roast chicken' }] }, { name: 'Bar', menu_items: [{ id: 201, name: 'Open bar' }] }] }],
  selections = {}, oauth1 = false, ignorePage = false } = {}) {
  const log = { tokens: 0, calls: [], auth: [] };
  let token = null;
  const state = { events: [...events], selections: { ...selections }, rateLimitNext: 0 };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const paged = (rows, page, size = 50) => ({ results: rows.slice((page - 1) * size, page * size), total_pages: Math.max(1, Math.ceil(rows.length / size)), page });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/oauth2/token') {
      assert.equal(init.method, 'POST');
      assert.match(init.headers['Content-Type'], /x-www-form-urlencoded/);
      const b = new URLSearchParams(init.body);
      assert.equal(b.get('grant_type'), 'client_credentials');
      if (b.get('client_id') !== ENV.TRIPLESEAT_CLIENT_ID || b.get('client_secret') !== ENV.TRIPLESEAT_CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      log.tokens++;
      token = `tok-${log.tokens}`;
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 7200 });
    }
    log.calls.push(u.pathname + u.search);
    log.auth.push(init.headers?.Authorization);
    if (state.rateLimitNext > 0) { state.rateLimitNext--; return json(429, { error: 'Too Many Requests' }, { 'Retry-After': '2' }); }
    if (oauth1) {
      const h = String(init.headers?.Authorization || '');
      const p = Object.fromEntries([...h.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
      const again = oauth1Header({ method: 'GET', url, consumerKey: OLD_KEYS.TRIPLESEAT_PUBLIC_KEY, consumerSecret: OLD_KEYS.TRIPLESEAT_SECRET_KEY, nonce: p.oauth_nonce, timestamp: p.oauth_timestamp });
      if (!h.startsWith('OAuth ') || p.oauth_signature !== again.signature) return json(401, { error: 'bad signature' });
    } else if (init.headers?.Authorization !== `Bearer ${token}`) return json(401, { error: 'invalid_token' });
    const page = Number(u.searchParams.get('page') || 1);
    if (u.pathname === '/v1/sites.json') return json(200, paged([{ id: 7, name: 'Test Restaurant Group' }], page));
    if (u.pathname === '/v1/locations.json') return json(200, paged(locations, page));
    if (u.pathname === '/v1/menus.json') return json(200, paged(menus, page));
    if (u.pathname === '/v1/events/search.json') {
      let rows = state.events;
      const from = u.searchParams.get('event_start_date'), to = u.searchParams.get('event_end_date');
      if (from) rows = rows.filter((e) => ymd(e.event_start) >= ymd(from));
      if (to) rows = rows.filter((e) => ymd(e.event_start) <= ymd(to));
      if (u.searchParams.get('location_id')) rows = rows.filter((e) => String(e.location_id) === u.searchParams.get('location_id'));
      if (u.searchParams.get('order') === 'updated_at') rows = [...rows].sort((a, b) => ymd(b.updated_at).localeCompare(ymd(a.updated_at)));
      return json(200, paged(rows, ignorePage ? 1 : page));
    }
    let m = u.pathname.match(/^\/v1\/events\/(\w+)\/menu_item_selections\.json$/);
    if (m) return json(200, { results: state.selections[m[1]] || [] });
    m = u.pathname.match(/^\/v1\/events\/(\w+)\.json$/);
    if (m) {
      const e = state.events.find((x) => String(x.id) === m[1]);
      return e ? json(200, { event: e }) : json(404, { error: 'Not found' });
    }
    return json(404, { error: `No route ${u.pathname}` });
  };
  return { fetch, log, state };
}
const client = (fake, env = ENV, extra = {}) => createTripleseatClient({ env, fetch: fake.fetch, sleep: noSleep, minGapMs: 0, ...extra });

// ---------- a restaurant in memory: people, positions, rooms ----------

function restaurant() {
  const store = new MemoryStore();
  const add = (id, name, role, extra = {}) => store.insert('users', { id, name, role, email: `${id}@example.test`, active: true, jobCodes: [{ jobCodeId: 'job_srv' }, { jobCodeId: 'job_bc' }], availability: {}, ...extra });
  add('u_mgr', 'Morgan', 'manager');
  add('u_admin', 'Ada', 'admin');
  add('u_evt', 'Eve', 'employee', { eventsAccess: true });
  add('u_ana', 'Ana', 'employee', { language: 'es' });
  add('u_ben', 'Ben', 'employee', { language: 'en' });
  store.insert('jobCodes', { id: 'job_srv', name: 'Server', eventRole: true, order: 0 });
  store.insert('jobCodes', { id: 'job_bc', name: 'Banquet Captain', eventRole: true, order: 1 });
  store.insert('jobCodes', { id: 'job_bar', name: 'Bartender', eventRole: true, order: 2 });
  store.insert('locations', { id: 'loc_1', name: 'Test Venue', order: 0 });
  store.insert('rooms', { id: 'room_lib', locationId: 'loc_1', name: 'Library', level: 'Main floor', kinds: ['events'], capacity: 60, order: 0, plan: { width: 1000, height: 700, items: [] } });
  store.insert('rooms', { id: 'room_main', locationId: 'loc_1', name: 'Main Dining', level: 'Main floor', kinds: ['dining'], capacity: 90, order: 1, plan: { width: 1000, height: 700, items: [] } });
  const svc = createService(store, { now: () => new Date('2026-11-22T19:00:00Z') });
  const as = (id) => store.get('users', id);
  const call = (who, method, args) => svc.call(as(who), method, args);
  const apply = (raw, ctx = {}) => svc.tripleseat.applyEvent(raw, { timeZone: 'America/Denver', rules: DEFAULT_RULES, ...ctx });
  const notes = (userId) => store.list('notifications', (n) => n.userId === userId).map((n) => n.text);
  return { store, svc, call, apply, notes };
}

// ---------- signing and the client ----------

test('OAuth 1.0a signing matches the spec’s worked example, and two-legged requests verify', async () => {
  // The worked example in the OAuth Core 1.0 spec (Appendix A.5): its published example values.
  const ex = oauth1Header({ method: 'GET', url: 'http://photos.example.net/photos?file=vacation.jpg&size=original', consumerKey: 'dpf43f3p2l4k3l03', consumerSecret: 'kd94hf93k423kf44',
    token: 'nnch734d00sl2jdk', tokenSecret: 'pfkkdhi9sl3r4s00', nonce: 'kllo9940pd9333jh', timestamp: 1191242096 });
  assert.equal(ex.base, 'GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal');
  assert.equal(ex.signature, 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
  assert.equal(oauthEncode("a b!*'()"), 'a%20b%21%2A%27%28%29');

  // Tripleseat's old keys: no token, the query (site, page) is signed too, and the fake API checks it.
  const fake = fakeTripleseat({ oauth1: true, events: [tsEvent(1)] });
  const c = client(fake, { ...OLD_KEYS, TRIPLESEAT_SITE_ID: '7' });
  assert.equal(c.config.auth, 'oauth1');
  const p = await c.searchEvents({ from: '2026-12-01', to: '2026-12-31' });
  assert.equal(p.rows.length, 1);
  assert.match(fake.log.auth[0], /^OAuth oauth_consumer_key="test-public-key", oauth_nonce="\w+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_version="1.0", oauth_signature="/);
  assert.ok(!/oauth_token/.test(fake.log.auth[0]), 'two-legged: no token');
  assert.match(fake.log.calls[0], /site_id=7/);
  assert.equal(fake.log.tokens, 0);
});

test('OAuth 2.0: one client-credentials token, cached and shared; a 401 gets one fresh token; 410 explains the old keys', async () => {
  _tokenCache.clear();
  const fake = fakeTripleseat({ events: [tsEvent(1)] });
  const a = client(fake), b = client(fake);
  await Promise.all([a.sites(), b.sites(), a.locations()]);
  assert.equal(fake.log.tokens, 1, 'one sign-in for concurrent callers');
  assert.ok(fake.log.auth.every((h) => h === 'Bearer tok-1'));
  assert.ok(fake.log.calls.every((c) => c.startsWith('/v1/') && /\.json/.test(c)));
  // Tripleseat revokes the token: the client signs in again once and carries on.
  const realFetch = fake.fetch;
  let revoked = true;
  const c = client({ fetch: async (url, init) => (revoked && !String(url).includes('/oauth2/') ? (revoked = false, new Response('{}', { status: 401 })) : realFetch(url, init)) });
  assert.equal((await c.event(1)).id, 1);
  assert.equal(fake.log.tokens, 2);
  // Wrong secret, and Tripleseat's answer for OAuth 1.0 after July 2026.
  _tokenCache.clear();
  await assert.rejects(client(fake, { ...ENV, TRIPLESEAT_CLIENT_SECRET: 'wrong-secret-value' }).sites(), /didn’t accept the client ID and secret/);
  const gone = createTripleseatClient({ env: OLD_KEYS, fetch: async () => new Response('{"error":"OAuth 1.0 is no longer supported"}', { status: 410 }), sleep: noSleep, minGapMs: 0 });
  await assert.rejects(gone.sites(), /no longer accepts the old API keys \(OAuth 1\.0\)/);
  assert.match(translateError('Tripleseat no longer accepts the old API keys (OAuth 1.0). Create an OAuth 2.0 application in Tripleseat (Settings → API) and use its client ID and secret.', 'es'), /^Tripleseat ya no acepta/);
  _tokenCache.clear();
});

test('config: env names only; OAuth 2.0 wins; the documented host by default', () => {
  assert.deepEqual(tripleseatConfig({}).missing, ['TRIPLESEAT_CLIENT_ID', 'TRIPLESEAT_CLIENT_SECRET']);
  assert.equal(tripleseatConfig({}).host, DEFAULT_HOST);
  assert.equal(tripleseatConfig({}).tokenUrl, 'https://api.tripleseat.com/oauth2/token');
  assert.equal(tripleseatConfig({ ...OLD_KEYS }).auth, 'oauth1');
  const both = tripleseatConfig({ ...OLD_KEYS, ...ENV, TRIPLESEAT_LOCATION_ID: '1', TRIPLESEAT_WEBHOOK_SECRET: 'whsec-test-value' });
  assert.equal(both.auth, 'oauth2');
  assert.equal(both.locationId, '1');
  assert.equal(both.webhookSecret, true);
  assert.ok(!JSON.stringify(both).includes('test-client-secret'), 'never a value');
});

test('pagination: every page by total_pages, an API that ignores ?page stops, and a 429 waits for Retry-After', async () => {
  _tokenCache.clear();
  const many = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `Loc ${i + 1}` }));
  const fake = fakeTripleseat({ locations: many });
  const waits = [];
  const c = client(fake, ENV, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal((await c.locations()).length, 120);
  assert.deepEqual(fake.log.calls.filter((x) => x.startsWith('/v1/locations')).map((x) => new URL(`${HOST}${x}`).searchParams.get('page')), ['1', '2', '3']);
  const stuck = fakeTripleseat({ locations: many, ignorePage: false });
  stuck.fetch = ((f) => async (url, init) => { const u = new URL(url); u.searchParams.set('page', '1'); return f(u.toString(), init); })(stuck.fetch);
  assert.equal((await client(stuck).locations()).length, 50, 'the same page twice is the end');
  fake.state.rateLimitNext = 1;
  await c.sites();
  assert.ok(waits.includes(2000), `waited ${waits}`);
  _tokenCache.clear();
});

// ---------- reading Tripleseat's events ----------

test('reading events: Tripleseat’s date formats, rooms, owner and link; contacts, accounts and money are never read', () => {
  assert.deepEqual(parseWhen('10/08/2026 06:30 PM'), { date: '2026-10-08', time: '18:30' });
  assert.deepEqual(parseWhen('2026-10-08T18:30:00'), { date: '2026-10-08', time: '18:30' });
  assert.deepEqual(parseWhen('2026-10-09T00:30:00Z', 'America/Denver'), { date: '2026-10-08', time: '18:30' }, 'UTC moved into the venue’s zone');
  assert.equal(parseWhen('13/45/2026'), null);
  assert.equal(parseTime('12:15 AM'), '00:15');
  assert.equal(parseTime('9pm'), '21:00');
  const raw = tsEvent(42, { rooms: [{ id: 11, name: 'Library' }, { room: { id: 12, name: 'Patio Bar' } }], show_financial: true, grand_total: 12000, guaranteed_guest_count: 75 });
  const ev = readEvent(raw, { timeZone: 'America/Denver' });
  assert.deepEqual([ev.id, ev.date, ev.start, ev.end, ev.guestCount, ev.guaranteed, ev.status, ev.type, ev.owner], ['42', '2026-12-05', '18:30', '22:00', 80, 75, 'definite', 'Wedding', 'Sam Seller']);
  assert.deepEqual(ev.rooms, [{ id: '11', name: 'Library' }, { id: '12', name: 'Patio Bar' }]);
  assert.equal(ev.url, `${HOST}/events/42`);
  assert.equal(readEvent({ ...raw, url: 'javascript:alert(1)' }).url, null, 'only https links');
  const text = JSON.stringify(ev);
  for (const secret of ['pat.client@example.test', '555-0100', 'Client Holdings', 'Pat Client', '12000']) assert.ok(!text.includes(secret), secret);
  assert.equal(readEvent({ name: 'no id' }), null);
});

test('the status rules: Definite → confirmed, Tentative → tentative; Prospect, Closed and Lost as configured', () => {
  const table = (rules) => ['DEFINITE', 'Tentative', 'prospect', 'Closed', 'LOST', 'Something new'].map((s) => mapStatus(s, rules));
  assert.deepEqual(table(DEFAULT_RULES), ['confirmed', 'tentative', 'skip', 'completed', 'cancel', 'skip']);
  assert.deepEqual(table({ tentative: 'skip', prospect: 'tentative', closed: 'skip', lost: 'remove' }), ['confirmed', 'skip', 'tentative', 'skip', 'cancel', 'skip']);
  assert.deepEqual(cleanRules({ tentative: 'nonsense', lost: 'remove' }), { ...DEFAULT_RULES, lost: 'remove' });

  const r = restaurant();
  assert.equal(r.apply(tsEvent(1)).action, 'added');
  assert.equal(r.store.get('events', eventDocId(1)).status, 'confirmed');
  assert.equal(r.apply(tsEvent(2, { status: 'TENTATIVE' })).action, 'added');
  assert.equal(r.apply(tsEvent(3, { status: 'PROSPECT' })).action, 'skipped');
  assert.equal(r.apply(tsEvent(4, { status: 'LOST' })).action, 'skipped');
  assert.equal(r.apply(tsEvent(5, { status: 'CLOSED', date: '2026-11-18' })).action, 'added');
  assert.equal(r.store.get('events', eventDocId(5)).status, 'completed');
  // Tentative events are for managers and the events team only, as ShiftBoard already does.
  const staff = r.call('u_ben', 'events.list', { start: '2026-11-01' }).map((e) => e.id);
  assert.ok(staff.includes(eventDocId(1)) && !staff.includes(eventDocId(2)));
  assert.ok(r.call('u_evt', 'events.list', { start: '2026-11-01' }).some((e) => e.id === eventDocId(2) && e.source === 'tripleseat'));
  // Prospect brought in as tentative when the rule says so; another venue's events stay out.
  assert.equal(r.apply(tsEvent(3, { status: 'PROSPECT' }), { rules: { prospect: 'tentative' } }).action, 'added');
  assert.equal(r.apply(tsEvent(6, { location: 2 }), { locationId: '1' }).action, 'skipped');
});

test('idempotent: the same event twice changes nothing and tells nobody twice', () => {
  const r = restaurant();
  assert.equal(r.apply(tsEvent(1)).action, 'added');
  const before = JSON.stringify(r.store.list('events'));
  const notes = r.store.list('notifications').length;
  for (let i = 0; i < 3; i++) assert.equal(r.apply(tsEvent(1)).action, 'same');
  assert.equal(JSON.stringify(r.store.list('events')), before);
  assert.equal(r.store.list('notifications').length, notes);
  assert.equal(r.store.list('events').length, 1);
});

test('field ownership: Tripleseat’s booking fields come back; the manager’s staffing, captain and notes stay', () => {
  const r = restaurant();
  r.apply(tsEvent(1, { guests: 80 }));
  const id = eventDocId(1);
  const e = r.call('u_mgr', 'events.get', { id });
  assert.equal(e.source, 'tripleseat');
  assert.ok(e.tripleseat.owns.includes('guestCount') && e.tripleseat.url, 'managers get the Tripleseat link');
  // The manager edits a Tripleseat field (guests) and the fields that are theirs.
  r.call('u_mgr', 'events.save', { ...e, guestCount: 95, start: '17:00', setupNotes: 'Rounds of 8', captainId: 'u_evt', serviceStyle: 'buffet',
    staffing: [{ jobCodeId: 'job_srv', count: 3, start: '17:30' }, { jobCodeId: 'job_bc', count: 1, start: '17:00' }] });
  r.call('u_mgr', 'events.generateShifts', { id, publish: true });
  const shift = r.store.list('shifts', (s) => s.eventId === id && s.jobCodeId === 'job_srv')[0];
  r.store.update('shifts', shift.id, { userId: 'u_ben' });
  r.call('u_mgr', 'events.comment', { eventId: id, text: 'Cake arrives at 5' });

  assert.equal(r.apply(tsEvent(1, { guests: 80 })).action, 'updated');
  const after = r.store.get('events', id);
  assert.equal(after.guestCount, 80, 'Tripleseat’s guest count is back');
  assert.equal(after.start, '18:30', 'and its start time');
  assert.equal(after.setupNotes, 'Rounds of 8');
  assert.equal(after.captainId, 'u_evt');
  assert.equal(after.serviceStyle, 'buffet');
  assert.deepEqual(after.staffing.map((l) => [l.jobCodeId, l.count]), [['job_srv', 3], ['job_bc', 1]]);
  assert.equal(r.store.list('shifts', (s) => s.eventId === id).length, 4, 'shifts and who works them stay');
  assert.equal(r.store.get('shifts', shift.id).userId, 'u_ben');
  assert.equal(r.store.list('eventComments', (c) => c.eventId === id).length, 1);

  // Staff see the badge but not the Tripleseat link or the flags.
  const staff = r.call('u_ben', 'events.get', { id });
  assert.equal(staff.tripleseat.url, undefined);
  assert.equal(staff.tripleseat.review, undefined);
  assert.equal(staff.contactEmail, undefined);
});

test('menus and drinks: Tripleseat’s menu lines own the menu; with none, the manager’s menu stays', () => {
  const index = menuItemIndex([{ id: 1, name: 'Dinner', categories: [{ name: 'Entrées', menu_items: [{ id: 101, name: 'Roast chicken' }] }, { name: 'Bar', menu_items: [{ id: 201, name: 'Open bar' }] }] }]);
  assert.deepEqual(index['101'], { name: 'Roast chicken', category: 'Entrées' });
  const lines = menuLines([{ id: 1, menu_item_id: 101, quantity: 80 }, { id: 2, menu_item_id: 201, quantity: 80 }, { id: 3, menu_item_id: 999 }, { id: 4, name: 'Vegetarian option', parent_id: 1, quantity: 1 }], index);
  assert.deepEqual(lines.food, [{ course: 'Entrées', item: 'Roast chicken × 80', notes: '' }, { course: 'Roast chicken', item: 'Vegetarian option', notes: '' }]);
  assert.deepEqual(lines.drinks, [{ item: 'Open bar × 80' }]);

  const r = restaurant();
  const id = eventDocId(9);
  r.apply(tsEvent(9), { menu: lines, menuFor: 'v1' });
  let e = r.store.get('events', id);
  assert.equal(e.menu.length, 2);
  assert.equal(e.beverage.package, 'Open bar × 80');
  assert.ok(e.tripleseat.owns.includes('menu') && e.tripleseat.owns.includes('beverage'));
  r.call('u_mgr', 'events.save', { ...r.call('u_mgr', 'events.get', { id }), menu: [{ course: 'X', item: 'Typed here', notes: '' }], beverage: { package: 'Typed', bar: 'Main bar', notes: '' } });
  r.apply(tsEvent(9), { menu: lines, menuFor: 'v1' });
  e = r.store.get('events', id);
  assert.equal(e.menu[0].item, 'Roast chicken × 80', 'Tripleseat’s menu is back');
  assert.deepEqual(e.beverage, { package: 'Open bar × 80', bar: 'Main bar', notes: '' }, 'the bar setup is the manager’s');
  // Not read this time (unchanged event): the menu and who owns it stay as they are.
  r.apply(tsEvent(9));
  assert.ok(r.store.get('events', id).tripleseat.owns.includes('menu'));
  // An event with no menu in Tripleseat: what the manager types stays.
  const id2 = eventDocId(10);
  r.apply(tsEvent(10), { menu: { food: [], drinks: [] } });
  r.call('u_mgr', 'events.save', { ...r.call('u_mgr', 'events.get', { id: id2 }), menu: [{ course: 'Dinner', item: 'Chef’s choice', notes: '' }] });
  r.apply(tsEvent(10, { updated: '11/21/2026 10:00 AM' }), { menu: { food: [], drinks: [] } });
  assert.equal(r.store.get('events', id2).menu[0].item, 'Chef’s choice');
});

test('rooms: matched by name to the venue, by hand in Settings, and unmatched rooms keep their name', () => {
  const r = restaurant();
  r.apply(tsEvent(1, { rooms: [{ id: 11, name: 'library' }] }));
  assert.deepEqual([r.store.get('events', eventDocId(1)).roomId, r.store.get('events', eventDocId(1)).room], ['room_lib', 'Library']);
  r.apply(tsEvent(2, { rooms: [{ id: 13, name: 'The Big Room' }] }));
  assert.deepEqual([r.store.get('events', eventDocId(2)).roomId, r.store.get('events', eventDocId(2)).room], [null, 'The Big Room']);
  r.apply(tsEvent(3, { rooms: [{ id: 11, name: 'Library' }, { id: 13, name: 'The Big Room' }] }));
  assert.equal(r.store.get('events', eventDocId(3)).room, 'Library & The Big Room', 'two rooms: their names, no single floor plan');

  const info = r.call('u_mgr', 'tripleseat.get');
  const big = info.rooms.find((x) => x.name === 'The Big Room');
  assert.equal(big.events, 2);
  assert.throws(() => r.call('u_ben', 'tripleseat.saveRooms', { rooms: [] }), /Managers only/);
  const saved = r.call('u_mgr', 'tripleseat.saveRooms', { rooms: [{ id: big.id, roomId: 'room_main' }] });
  assert.equal(saved.events, 2, 'events in that room follow now');
  assert.deepEqual([r.store.get('events', eventDocId(2)).roomId, r.store.get('events', eventDocId(2)).room], ['room_main', 'Main Dining']);
  assert.deepEqual([r.store.get('events', eventDocId(3)).roomId, r.store.get('events', eventDocId(3)).room], [null, 'Library & Main Dining']);
  assert.equal(r.call('u_mgr', 'events.get', { id: eventDocId(2) }).room, 'Main Dining');
  // The next sync keeps the match made by hand.
  assert.equal(r.apply(tsEvent(2, { rooms: [{ id: 13, name: 'The Big Room' }] })).action, 'same');
  assert.equal(r.store.get('tripleseatRooms', big.id).matchedBy, 'manual');
  assert.throws(() => r.call('u_mgr', 'tripleseat.saveRooms', { rooms: [{ id: 'tsr_nope', roomId: null }] }), /That Tripleseat room is gone/);
});

test('changes that matter to staff: date, time, guests and room tell the people on it, in their language', () => {
  const r = restaurant();
  const id = eventDocId(1);
  r.apply(tsEvent(1, { date: '2026-12-05', guests: 80 }));
  const e = r.call('u_mgr', 'events.get', { id });
  r.call('u_mgr', 'events.save', { ...e, staffing: [{ jobCodeId: 'job_srv', count: 3, start: '17:30' }] });
  r.call('u_mgr', 'events.generateShifts', { id, publish: true });
  const [s1, s2] = r.store.list('shifts', (s) => s.eventId === id);
  r.store.update('shifts', s1.id, { userId: 'u_ana' });
  r.store.update('shifts', s2.id, { userId: 'u_ben' });
  const count = (u) => r.notes(u).length;
  const before = { ana: count('u_ana'), ben: count('u_ben'), mgr: count('u_mgr') };

  // Only the event type changed: nothing for staff.
  r.apply(tsEvent(1, { date: '2026-12-05', guests: 80, type: 'Reception' }));
  assert.equal(count('u_ben'), before.ben);

  // New guests and a new room.
  r.apply(tsEvent(1, { date: '2026-12-05', guests: 95, rooms: [{ id: 12, name: 'Main Dining' }] }));
  assert.equal(count('u_ben'), before.ben + 1);
  assert.match(r.notes('u_ben').at(-1), /^BEO updated from Tripleseat: Event 1 \(Sat, Dec 5\)\. 95 guests; Room: Main Dining\. Review the latest details\.$/);
  assert.match(r.notes('u_ana').at(-1), /^Se actualizó el BEO desde Tripleseat: Event 1 \(.+\)\. 95 invitados; Salón: Main Dining\. Revisa/);

  // Moved to another day: open shifts go along, people’s shifts are flagged for a manager.
  r.apply(tsEvent(1, { date: '2026-12-06', start: '05:00 PM', guests: 95, rooms: [{ id: 12, name: 'Main Dining' }] }));
  assert.match(r.notes('u_ben').at(-1), /New date: Sun, Dec 6; New time: 5p–10p/);
  assert.match(r.notes('u_ana').at(-1), /Nueva fecha: .*6.*; Nuevo horario: 5 pm–10 pm/);
  const shifts = r.store.list('shifts', (s) => s.eventId === id);
  assert.deepEqual(shifts.filter((s) => !s.userId).map((s) => s.date), ['2026-12-06'], 'the open shift moved');
  assert.deepEqual(shifts.filter((s) => s.userId).map((s) => s.date), ['2026-12-05', '2026-12-05'], 'people’s shifts wait for a manager');
  const ev = r.call('u_mgr', 'events.get', { id });
  assert.deepEqual(ev.tripleseat.review.map((x) => [x.code, x.staffed]), [['moved', 2]]);
  assert.match(r.notes('u_mgr').at(-1), /moved to .*Dec 6.* in Tripleseat\. 2 people’s shifts are still on the old day/);
  assert.ok(r.call('u_mgr', 'events.list', { start: '2026-11-01' }).find((x) => x.id === id).review > 0);
  r.call('u_evt', 'tripleseat.clearReview', { id });
  assert.deepEqual(r.call('u_mgr', 'events.get', { id }).tripleseat.review, []);
});

test('cancellations: Lost or deleted marks it cancelled; an event with people on it is never deleted, it’s flagged', () => {
  const r = restaurant();
  const staffed = (n, user) => {
    const id = eventDocId(n);
    r.apply(tsEvent(n));
    r.call('u_mgr', 'events.save', { ...r.call('u_mgr', 'events.get', { id }), staffing: [{ jobCodeId: 'job_srv', count: 2, start: '17:30' }] });
    r.call('u_mgr', 'events.generateShifts', { id, publish: true });
    if (user) r.store.update('shifts', r.store.list('shifts', (s) => s.eventId === id)[0].id, { userId: user });
    return id;
  };
  // Lost, with Ben on it: cancelled, kept, flagged; the open shift is gone; the events team hears about it.
  const a = staffed(1, 'u_ben');
  const mgrBefore = r.notes('u_mgr').length;
  assert.equal(r.apply(tsEvent(1, { status: 'LOST' })).action, 'flagged');
  assert.equal(r.store.get('events', a).status, 'cancelled');
  assert.deepEqual(r.store.list('shifts', (s) => s.eventId === a).map((s) => s.userId), ['u_ben']);
  assert.equal(r.notes('u_mgr').length, mgrBefore + 1);
  assert.match(r.notes('u_mgr').at(-1), /cancelled or taken off in Tripleseat, but 1 person is still scheduled/);
  assert.equal(r.apply(tsEvent(1, { status: 'LOST' })).action, 'same', 'no second flag');
  assert.equal(r.notes('u_mgr').length, mgrBefore + 1);
  // Even with "delete Lost events", an event with people on it stays.
  assert.equal(r.apply(tsEvent(1, { status: 'LOST' }), { rules: { lost: 'remove' } }).action, 'same');
  assert.ok(r.store.get('events', a));
  // Lost, nobody on it, "delete": gone with its open shifts.
  const b = staffed(2, null);
  assert.equal(r.apply(tsEvent(2, { status: 'LOST' }), { rules: { lost: 'remove' } }).action, 'removed');
  assert.equal(r.store.get('events', b), null);
  assert.equal(r.store.list('shifts', (s) => s.eventId === b).length, 0);
  // Back to Prospect (left out): taken off when nobody is on it.
  r.apply(tsEvent(3));
  assert.equal(r.apply(tsEvent(3, { status: 'PROSPECT' })).action, 'removed');
  // Deleted in Tripleseat (a 404): cancelled; back to Definite later: confirmed again, flag cleared.
  const d = staffed(4, 'u_ana');
  assert.equal(r.svc.tripleseat.applyDeleted('4', { rules: DEFAULT_RULES }).action, 'flagged');
  assert.equal(r.store.get('events', d).status, 'cancelled');
  assert.equal(r.apply(tsEvent(4)).action, 'updated');
  assert.equal(r.store.get('events', d).status, 'confirmed');
  assert.deepEqual(r.store.get('events', d).tripleseat.review, []);
  // Events typed in by hand are never touched by the sync.
  r.store.insert('events', { id: eventDocId(99), name: 'Hand-made', date: '2026-12-01', status: 'confirmed', staffing: [] });
  assert.equal(r.apply(tsEvent(99)).action, 'ignored');
  assert.equal(r.svc.tripleseat.applyDeleted('99').action, 'skipped');
});

test('a Tripleseat event deleted here stays out until an admin brings it back', () => {
  const r = restaurant();
  r.apply(tsEvent(1));
  r.call('u_mgr', 'events.delete', { id: eventDocId(1) });
  assert.equal(r.apply(tsEvent(1)).action, 'ignored');
  assert.deepEqual(r.call('u_mgr', 'tripleseat.get').skipped.map((s) => s.id), [eventDocId(1)]);
  assert.throws(() => r.call('u_mgr', 'tripleseat.restoreSkipped', {}), /Admins only/);
  assert.equal(r.call('u_admin', 'tripleseat.restoreSkipped', {}).restored, 1);
  assert.equal(r.apply(tsEvent(1)).action, 'added');
});

test('settings: rules for admins, the webhook token for admins only, Spanish errors', () => {
  const r = restaurant();
  assert.throws(() => r.call('u_ben', 'tripleseat.get'), /Managers only/);
  assert.equal(r.call('u_mgr', 'tripleseat.get').webhookToken, undefined, 'managers never see the webhook token');
  assert.throws(() => r.call('u_mgr', 'tripleseat.saveRules', { rules: { lost: 'remove' } }), /Admins only/);
  assert.throws(() => r.call('u_admin', 'tripleseat.saveRules', { rules: { lost: 'explode' } }), /Pick what happens to each status/);
  assert.deepEqual(r.call('u_admin', 'tripleseat.saveRules', { rules: { lost: 'remove' } }).rules, { ...DEFAULT_RULES, lost: 'remove' });
  const { token } = r.call('u_admin', 'tripleseat.webhookLink', {});
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(r.call('u_admin', 'tripleseat.webhookLink', {}).token, token, 'the same link until renewed');
  assert.notEqual(r.call('u_admin', 'tripleseat.webhookLink', { renew: true }).token, token);
  assert.equal(translateError('Pick what happens to each status', 'es'), 'Elige qué pasa con cada estado');
  assert.equal(translateError('That Tripleseat room is gone. Sync again.', 'es'), 'Ese salón de Tripleseat ya no existe. Vuelve a sincronizar.');
});

// ---------- the sync run, against the real database layer ----------

async function freshDb() {
  const conn = await openPglite();
  const db = new DocDb(conn);
  await db.migrate();
  await db.run((s) => {
    s.insert('users', { id: 'u_mgr', name: 'Morgan', role: 'manager', email: 'morgan@example.test', active: true, jobCodes: [] });
    s.insert('users', { id: 'u_ben', name: 'Ben', role: 'employee', email: 'ben@example.test', active: true, jobCodes: [{ jobCodeId: 'job_srv' }] });
    s.insert('jobCodes', { id: 'job_srv', name: 'Server', eventRole: true });
    s.insert('locations', { id: 'loc_1', name: 'Test Venue', order: 0 });
    s.insert('rooms', { id: 'room_lib', locationId: 'loc_1', name: 'Library', kinds: ['events'], order: 0, plan: { width: 1000, height: 700, items: [] } });
  }, { write: true });
  return { db, close: () => conn.end() };
}

test('sync: the window page by page within a time budget, resumes from its cursor, and running it again changes nothing', async () => {
  _tokenCache.clear();
  const { db, close } = await freshDb();
  try {
    const events = Array.from({ length: 120 }, (_, i) => tsEvent(i + 1, { date: `2026-12-${String((i % 28) + 1).padStart(2, '0')}` }));
    events.push(tsEvent(500, { date: '2027-06-01' })); // outside the window: left alone
    const fake = fakeTripleseat({ events, selections: { 1: [{ id: 1, menu_item_id: 101, quantity: 80 }, { id: 2, menu_item_id: 201, quantity: 80 }] } });
    let clock = 0;
    const slow = (() => { const c = client(fake); return { ...c, searchEvents: async (...a) => { clock += 5000; return c.searchEvents(...a); } }; })();
    const first = await runTripleseatSync({ db, env: ENV, client: slow, by: 'u_mgr', budgetMs: 9_000, clock: () => clock, today: TODAY });
    assert.equal(first.ok, true, first.error);
    assert.ok(first.next, 'stopped inside its budget');
    let next = first.next, rounds = 1;
    while (next) {
      const r = await runTripleseatSync({ db, env: ENV, client: slow, cursor: next, by: 'u_mgr', budgetMs: 9_000, clock: () => clock, today: TODAY });
      assert.equal(r.ok, true, r.error);
      next = r.next; rounds++;
    }
    assert.ok(rounds >= 3, `took ${rounds} calls`);
    const pages = fake.log.calls.filter((c) => c.startsWith('/v1/events/search')).map((c) => new URL(`${HOST}${c}`).searchParams.get('page'));
    assert.deepEqual(pages, ['1', '2', '3']);
    assert.match(fake.log.calls.find((c) => c.startsWith('/v1/events/search')), /event_start_date=11%2F15%2F2026&event_end_date=03%2F22%2F2027/);
    const synced = db.store.list('events', (e) => e.source === 'tripleseat');
    assert.equal(synced.length, 120);
    const one = db.store.get('events', eventDocId(1));
    assert.deepEqual([one.roomId, one.menu[0].item, one.beverage.package], ['room_lib', 'Roast chicken × 80', 'Open bar × 80']);
    const status = db.store.get('integrations', 'tripleseat');
    assert.equal(status.lastSync.finished, true);
    assert.equal(status.lastSync.counts.added, 120, 'chunks of one run add up');
    assert.equal(status.site.name, 'Test Restaurant Group');
    assert.equal(db.store.list('tripleseatRooms').length, 2);
    assert.equal(db.store.list('notifications').length, 0, 'the first sync doesn’t announce every event');

    // Again: unchanged events aren’t written and their menus aren’t read again.
    const seq = Number((await db.query('SELECT max(seq)::int AS n FROM shiftboard.docs WHERE col = \'events\'')).rows[0].n);
    const menuReads = fake.log.calls.filter((c) => c.includes('menu_item_selections')).length;
    const again = await runTripleseatSync({ db, env: ENV, client: client(fake), budgetMs: 60_000, today: TODAY });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.next, null);
    assert.equal(again.counts.same, 120);
    assert.equal(Number((await db.query('SELECT max(seq)::int AS n FROM shiftboard.docs WHERE col = \'events\'')).rows[0].n), seq, 'no event written');
    assert.equal(fake.log.calls.filter((c) => c.includes('menu_item_selections')).length, menuReads);
    assert.ok(fake.log.calls.some((c) => /order=updated_at/.test(c)), 'the second run asks for what changed since the first');
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM shiftboard.docs WHERE col = 'events' AND NOT deleted`);
    assert.equal(rows[0].n, 120);

    // Deleted in Tripleseat with no webhook: the next run notices (it fetches the missing one: 404).
    fake.state.events = fake.state.events.filter((e) => e.id !== 7);
    const third = await runTripleseatSync({ db, env: ENV, client: client(fake), budgetMs: 60_000, today: TODAY });
    assert.equal(third.counts.cancelled, 1, JSON.stringify(third.counts));
    assert.equal(db.store.get('events', eventDocId(7)).status, 'cancelled');
    assert.ok(fake.log.calls.includes('/v1/events/7.json'));

    // A Tripleseat error is reported, not thrown, and saved for the Settings page.
    const broken = { ...client(fake), searchEvents: async () => { throw new Error('boom'); } };
    const failed = await runTripleseatSync({ db, env: ENV, client: broken, budgetMs: 60_000, today: TODAY });
    assert.equal(failed.ok, false);
    assert.equal(db.store.get('integrations', 'tripleseat').lastSync.ok, false);
  } finally { await close(); _tokenCache.clear(); }
});

test('sync: menus Tripleseat won’t share leave a warning (as a code), not a failed sync', async () => {
  _tokenCache.clear();
  const { db, close } = await freshDb();
  try {
    const fake = fakeTripleseat({ events: [tsEvent(1, { date: '2026-12-01' })] });
    const c = client(fake);
    const noMenus = { ...c, menus: async () => { throw Object.assign(new Error('Tripleseat says these credentials can’t read menus. Check the application’s permissions in Tripleseat.'), { status: 403 }); }, menuSelections: async () => { throw new Error('nope'); } };
    const out = await runTripleseatSync({ db, env: ENV, client: noMenus, budgetMs: 60_000, today: TODAY });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(out.warnings.map((w) => w.code), ['menus']);
    assert.equal(db.store.get('integrations', 'tripleseat').lastSync.warnings[0].code, 'menus');
    assert.equal(db.store.get('events', eventDocId(1)).guestCount, 80);
  } finally { await close(); _tokenCache.clear(); }
});

// ---------- the webhook ----------

const sign = (secret, t, body) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('webhook signatures: t and v1 over "<t>.<raw body>", constant time, 5 minutes of skew', () => {
  const secret = 'whsec-test-value', body = '{"webhook_trigger_type":"UPDATE_EVENT","event":{"id":1}}';
  const now = 1_790_000_000_000;
  const t = Math.floor(now / 1000);
  assert.deepEqual(verifySignature(sign(secret, t, body), body, secret, { now }), { ok: true });
  assert.equal(verifySignature(sign(secret, t, body), Buffer.from(body), secret, { now }).ok, true);
  assert.equal(verifySignature(sign(secret, t, body), body.replace('1', '2'), secret, { now }).reason, 'mismatch');
  assert.equal(verifySignature(sign('other-secret', t, body), body, secret, { now }).reason, 'mismatch');
  assert.equal(verifySignature(sign(secret, t - 3600, body), body, secret, { now }).reason, 'stale');
  assert.equal(verifySignature('', body, secret, { now }).reason, 'missing');
  assert.equal(verifySignature(`t=${t},v1=nothex`, body, secret, { now }).reason, 'missing');
  assert.equal(verifySignature(`${sign(secret, t, body)},v1=${'0'.repeat(64)}`, body, secret, { now }).ok, true, 'one good v1 is enough');
  assert.deepEqual(webhookEventIds({ webhook_trigger_type: 'UPDATE_EVENT', event: { id: 12 } }), ['12']);
  assert.deepEqual(webhookEventIds({ booking: { events: [{ id: 3 }, { id: 4 }] } }), ['3', '4']);
  assert.deepEqual(webhookEventIds({ webhook_trigger_type: 'CREATE_LEAD', lead: { id: 5 } }), []);
  assert.deepEqual(webhookEventIds({ event: { id: '../../etc' } }), []);
});

test('HTTP: status and Sync now for managers, the webhook only with the restaurant’s link and a good signature, the cron with its secret', async () => {
  _tokenCache.clear();
  const conn = await openPglite();
  const db = new DocDb(conn);
  const fake = fakeTripleseat({ events: [tsEvent(1, { date: '2026-12-10' })] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith(HOST) ? fake.fetch(url, init) : realFetch(url, init));
  const WEBHOOK_SECRET = 'whsec-test-value';
  const env = { SEED_DEMO: 'true', ...ENV, TRIPLESEAT_WEBHOOK_SECRET: WEBHOOK_SECRET, CRON_SECRET: 'cron-test-value' };
  const app = createApp({ db, env });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const r = await realFetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const req = (path, { cookie, method = 'GET', body, headers = {}, raw } = {}) => realFetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    const moe = await login('moe@demo.shiftboard');
    const styves = await login('styves@demo.shiftboard');
    assert.equal((await req('/api/tripleseat/status')).status, 401);
    assert.equal((await req('/api/tripleseat/status', { cookie: styves })).status, 403);
    const st = await req('/api/tripleseat/status', { cookie: moe });
    assert.deepEqual(st.body.result, { configured: true, auth: 'oauth2', missing: [], present: ['TRIPLESEAT_CLIENT_ID', 'TRIPLESEAT_CLIENT_SECRET'], host: HOST, siteId: '', locationId: '', webhookSecret: true, cron: true });

    assert.equal((await req('/api/tripleseat/sync', { cookie: styves, method: 'POST', body: {} })).status, 403);
    let r = await req('/api/tripleseat/sync', { cookie: moe, method: 'POST', body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    while (r.body.result.next) r = await req('/api/tripleseat/sync', { cookie: moe, method: 'POST', body: { next: r.body.result.next } });
    assert.equal(db.store.get('events', eventDocId(1)).guestCount, 80);

    // The webhook: the restaurant’s own link (admins get it), then a signature over the exact bytes.
    const token = (await req('/api/rpc/tripleseat.webhookLink', { cookie: moe, method: 'POST', body: {} })).body.result.token;
    fake.state.events[0] = tsEvent(1, { date: '2026-12-10', guests: 120 }); // what Tripleseat says now
    const body = JSON.stringify({ webhook_trigger_type: 'CHANGE_EVENT_GUEST_COUNTS', event: { id: 1, guest_count: 9999, name: 'Not trusted' } });
    const t = Math.floor(Date.now() / 1000);
    const hook = (path, sig, raw = body) => req(path, { method: 'POST', raw, headers: { 'X-Signature': sig } });
    assert.equal((await hook('/api/tripleseat/webhook/not-the-token', sign(WEBHOOK_SECRET, t, body))).status, 404);
    assert.equal((await hook(`/api/tripleseat/webhook/${token}`, sign('wrong-secret', t, body))).status, 401);
    assert.equal((await hook(`/api/tripleseat/webhook/${token}`, sign(WEBHOOK_SECRET, t - 3600, body))).status, 401, 'an old delivery replayed');
    const ok = await hook(`/api/tripleseat/webhook/${token}`, sign(WEBHOOK_SECRET, t, body));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.result.events, [{ id: '1', action: 'updated' }]);
    const e = db.store.get('events', eventDocId(1));
    assert.equal(e.guestCount, 120, 'read back from Tripleseat, not the payload');
    assert.equal(e.name, 'Event 1');
    // Lead webhooks: nothing to do. Deleted events: Tripleseat answers 404, so it’s cancelled.
    const lead = JSON.stringify({ webhook_trigger_type: 'CREATE_LEAD', lead: { id: 9 } });
    assert.equal((await hook(`/api/tripleseat/webhook/${token}`, sign(WEBHOOK_SECRET, t, lead), lead)).body.result.ignored, true);
    fake.state.events = [];
    const del = JSON.stringify({ webhook_trigger_type: 'DELETE_EVENT', event: { id: 1 } });
    assert.deepEqual((await hook(`/api/tripleseat/webhook/${token}`, sign(WEBHOOK_SECRET, t, del), del)).body.result.events, [{ id: '1', action: 'cancelled' }]);
    assert.equal(db.store.get('integrations', 'tripleseat').lastWebhook.trigger, 'DELETE_EVENT');

    // The cron: its secret, then once a day.
    assert.equal((await req('/api/cron/tripleseat')).status, 401);
    assert.equal((await req('/api/cron/tripleseat', { headers: { Authorization: 'Bearer nope' } })).status, 401);
    const cron = await req('/api/cron/tripleseat', { headers: { Authorization: 'Bearer cron-test-value' } });
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    assert.equal(cron.body.result.ok, true);
    assert.equal(db.store.get('integrations', 'tripleseat').lastCron.by, 'cron');

    // Errors in the caller’s language.
    const es = await req('/api/rpc/tripleseat.saveRules', { cookie: moe, method: 'POST', body: { rules: { lost: 'explode' } }, headers: { 'X-ShiftBoard-Language': 'es' } });
    assert.equal(es.status, 400);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
    _tokenCache.clear();
  }
});

test('without Tripleseat settings: the cron does nothing, Sync now says what to add, the webhook is not found', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', CRON_SECRET: 'cron-test-value' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cron = await fetch(`${base}/api/cron/tripleseat`, { headers: { Authorization: 'Bearer cron-test-value' } });
    assert.deepEqual((await cron.json()).result, { skipped: 'Tripleseat is not set up' });
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'moe@demo.shiftboard', password: 'demo1234' }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const r = await fetch(`${base}/api/tripleseat/sync`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-ShiftBoard-Language': 'es' }, body: '{}' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'Tripleseat todavía no está configurado. Agrega TRIPLESEAT_CLIENT_ID, TRIPLESEAT_CLIENT_SECRET en Vercel y vuelve a publicar.');
    assert.equal((await fetch(`${base}/api/tripleseat/webhook/anything`, { method: 'POST', body: '{}' })).status, 404);
    // The demo’s sample event is a Tripleseat event with no staffing yet.
    await db.sync();
    const sample = db.store.get('events', 'evt_ts_900001');
    assert.equal(sample.source, 'tripleseat');
    assert.deepEqual(sample.staffing, []);
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }
});

test('syncOneEvent reads the event back from Tripleseat and records the webhook', async () => {
  _tokenCache.clear();
  const { db, close } = await freshDb();
  try {
    const fake = fakeTripleseat({ events: [tsEvent(3, { date: '2026-12-03', status: 'TENTATIVE' })] });
    const out = await syncOneEvent({ db, env: ENV, client: client(fake), eventId: '3', trigger: 'CREATE_EVENT' });
    assert.deepEqual([out.ok, out.action], [true, 'added']);
    assert.equal(db.store.get('events', eventDocId(3)).status, 'tentative');
    const notes = db.store.list('notifications', (n) => n.userId === 'u_mgr');
    assert.equal(notes.length, 1, 'a new event from a webhook tells managers');
    assert.match(notes[0].text, /^New event: Event 3 on /);
    assert.equal(db.store.list('notifications', (n) => n.userId === 'u_ben').length, 0, 'tentative: staff aren’t told');
  } finally { await close(); _tokenCache.clear(); }
});
