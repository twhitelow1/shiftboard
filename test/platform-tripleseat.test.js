// Tripleseat on the platform: the plan feature, per-restaurant settings (encrypted keys, never inherited),
// the per-restaurant cron, and each restaurant's own webhook link. Fake Tripleseat APIs only (no network)
// and fake values only, clearly not real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { openConnection } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { tenantEnv, cleanIntegrations, integrationsView, INTEGRATION_FIELDS } from '../server/platform/tenant-env.js';
import { featureForMethod, ROUTE_FEATURES, PLANS, resolveFeatures } from '../server/platform/plans.js';
import { _tokenCache } from '../server/tripleseat.js';
import { addDays, todayStr } from '../core/time.js';
import { fakeResend } from './helpers/fake-resend.js';
import { hostClient, request } from './helpers/hosts.js';

// ---------- pure parts ----------

test('Tripleseat is a Pro and Beta feature; its RPCs and routes follow the plan', () => {
  assert.ok(PLANS.pro.features.includes('tripleseat'));
  assert.ok(PLANS.beta.features.includes('tripleseat'));
  assert.ok(!PLANS.starter.features.includes('tripleseat'));
  assert.equal(resolveFeatures('starter', { tripleseat: true }).tripleseat, true, 'DubLow can switch it on for one restaurant');
  for (const m of ['tripleseat.get', 'tripleseat.saveRooms', 'tripleseat.saveRules', 'tripleseat.webhookLink']) assert.equal(featureForMethod(m), 'tripleseat', m);
  assert.ok(ROUTE_FEATURES.some(([path, f]) => path === '/api/tripleseat' && f === 'tripleseat'));
});

const PLATFORM_ENV = { TRIPLESEAT_CLIENT_ID: 'default-ts-id', TRIPLESEAT_CLIENT_SECRET: 'default-ts-secret', TRIPLESEAT_LOCATION_ID: '1', TRIPLESEAT_WEBHOOK_SECRET: 'default-whsec', JWT_SECRET: 'j' };

test('per-restaurant settings: keys are secrets, never inherited from the default restaurant, and gone without the feature', () => {
  const fields = Object.fromEntries(INTEGRATION_FIELDS.filter((f) => f.group === 'tripleseat').map((f) => [f.key, f]));
  for (const k of ['TRIPLESEAT_CLIENT_ID', 'TRIPLESEAT_CLIENT_SECRET', 'TRIPLESEAT_WEBHOOK_SECRET', 'TRIPLESEAT_PUBLIC_KEY', 'TRIPLESEAT_SECRET_KEY']) assert.equal(fields[k].secret, true, k);
  for (const k of ['TRIPLESEAT_LOCATION_ID', 'TRIPLESEAT_SITE_ID', 'TRIPLESEAT_API_HOST']) assert.ok(!fields[k].secret, k);

  const bistro = { id: 't1', slug: 'bistro', name: 'Bistro', is_default: false, integrations: { TRIPLESEAT_LOCATION_ID: '22' }, resolved: { tripleseat: true } };
  const env = tenantEnv(PLATFORM_ENV, bistro, { TRIPLESEAT_CLIENT_ID: 'bistro-ts-id', TRIPLESEAT_CLIENT_SECRET: 'bistro-ts-secret' });
  assert.deepEqual([env.TRIPLESEAT_CLIENT_ID, env.TRIPLESEAT_CLIENT_SECRET, env.TRIPLESEAT_LOCATION_ID], ['bistro-ts-id', 'bistro-ts-secret', '22']);
  assert.equal(env.TRIPLESEAT_WEBHOOK_SECRET, undefined, 'another restaurant never inherits the default restaurant’s Tripleseat values');
  const blank = tenantEnv(PLATFORM_ENV, { ...bistro, integrations: {} }, {});
  assert.ok(!Object.keys(blank).some((k) => k.startsWith('TRIPLESEAT_')));
  const off = tenantEnv(PLATFORM_ENV, { ...bistro, resolved: { tripleseat: false } }, { TRIPLESEAT_CLIENT_ID: 'bistro-ts-id', TRIPLESEAT_CLIENT_SECRET: 'bistro-ts-secret' });
  assert.ok(!Object.keys(off).some((k) => k.startsWith('TRIPLESEAT_')), 'nothing when Tripleseat isn’t in the plan');

  const def = { id: 'default', is_default: true, name: 'CR', integrations: {}, resolved: { tripleseat: true } };
  assert.equal(tenantEnv(PLATFORM_ENV, def, {}).TRIPLESEAT_CLIENT_ID, 'default-ts-id', 'the first client falls back to its env vars');
  assert.equal(tenantEnv(PLATFORM_ENV, def, { TRIPLESEAT_CLIENT_SECRET: 'console-secret' }).TRIPLESEAT_CLIENT_SECRET, 'console-secret', 'a console setting wins');
  const view = integrationsView(def, {}, PLATFORM_ENV);
  assert.equal(view.effective.tripleseat, true);
  assert.equal(integrationsView({ ...bistro, integrations: {} }, {}, PLATFORM_ENV).effective.tripleseat, false);

  assert.throws(() => cleanIntegrations({ TRIPLESEAT_LOCATION_ID: 'downtown' }), /location ID is a number/);
  assert.throws(() => cleanIntegrations({ TRIPLESEAT_CLIENT_SECRET: 'has a space' }), /no spaces/);
  assert.throws(() => cleanIntegrations({ TRIPLESEAT_API_HOST: 'http://insecure.example' }), /https/);
  assert.deepEqual(cleanIntegrations({ TRIPLESEAT_CLIENT_SECRET: ' padded-secret ', TRIPLESEAT_SITE_ID: '7' }), { plain: { TRIPLESEAT_SITE_ID: '7' }, secrets: { TRIPLESEAT_CLIENT_SECRET: 'padded-secret' } });
});

// ---------- the platform, end to end ----------

const PG_URL = process.env.TEST_DATABASE_URL;
async function freshConn() {
  if (!PG_URL) return openPglite();
  const u = new URL(PG_URL);
  const name = `${u.pathname.slice(1) || 'postgres'}_platform_ts`;
  const admin = openConnection({ DATABASE_URL: PG_URL });
  try { await admin.query(`CREATE DATABASE "${name}"`); } catch (e) { if (e.code !== '42P04') throw e; } finally { await admin.end(); }
  u.pathname = `/${name}`;
  const conn = openConnection({ DATABASE_URL: u.toString() });
  const { rows } = await conn.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('shiftboard', 'platform') OR nspname LIKE 't\\_%'`);
  for (const r of rows) await conn.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  return conn;
}

/** A fake Tripleseat account at `host` that answers only its own client ID and secret. */
function fakeAccount(host, { clientId, clientSecret, events }) {
  const seen = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const handle = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(u.pathname);
    if (u.pathname === '/oauth2/token') {
      const b = new URLSearchParams(init.body);
      if (b.get('client_id') !== clientId || b.get('client_secret') !== clientSecret) return json({ error: 'invalid_client' }, 401);
      return json({ access_token: `tok-${clientId}`, expires_in: 7200 });
    }
    if (init.headers?.Authorization !== `Bearer tok-${clientId}`) return json({ error: 'invalid_token' }, 401);
    if (u.pathname === '/v1/sites.json') return json({ results: [{ id: 1, name: `${clientId} site` }], total_pages: 1 });
    if (u.pathname === '/v1/locations.json') return json({ results: [{ id: 1, name: 'Main', rooms: [{ id: 5, name: 'Patio' }] }], total_pages: 1 });
    if (u.pathname === '/v1/menus.json') return json({ results: [], total_pages: 1 });
    if (u.pathname === '/v1/events/search.json') return json({ results: events, total_pages: 1 });
    const m = u.pathname.match(/^\/v1\/events\/(\w+)(\/menu_item_selections)?\.json$/);
    if (m?.[2]) return json({ results: [] });
    if (m) { const e = events.find((x) => String(x.id) === m[1]); return e ? json({ event: e }) : json({ error: 'Not found' }, 404); }
    return json({ error: 'no route' }, 404);
  };
  return { host, seen, handle };
}
const mdY = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const ev = (id, date, name) => ({ id, name, status: 'DEFINITE', event_start: `${mdY(date)} 06:00 PM`, event_end: `${mdY(date)} 09:00 PM`, guest_count: 40, location_id: 1, rooms: [{ id: 5, name: 'Patio' }], updated_at: `${mdY(date)} 09:00 AM` });

test('isolation: each restaurant syncs its own Tripleseat account into its own schema, with its own webhook link; Starter gets none of it', async () => {
  _tokenCache.clear();
  const conn = await freshConn();
  const soon = addDays(todayStr(), 10);
  const DEFAULT_TS = 'https://ts-default.example.test', BISTRO_TS = 'https://ts-bistro.example.test';
  const accounts = [
    fakeAccount(DEFAULT_TS, { clientId: 'default-ts-id', clientSecret: 'default-ts-secret', events: [ev(1001, soon, 'Default Gala')] }),
    fakeAccount(BISTRO_TS, { clientId: 'bistro-ts-id', clientSecret: 'bistro-ts-secret', events: [ev(2001, soon, 'Bistro Rehearsal Dinner')] }),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const a = accounts.find((x) => String(url).startsWith(x.host));
    return a ? a.handle(String(url), init) : realFetch(url, init);
  };
  const env = {
    PLATFORM_DOMAIN: 'lvh.test', LEGACY_HOSTS: 'legacy.example.test',
    PLATFORM_ADMIN_EMAIL: 'ops@dublow.test', PLATFORM_ADMIN_PASSWORD: 'console-password-1',
    PLATFORM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), JWT_SECRET: 'platform-test-jwt', SEED_DEMO: 'true', EXPO_PUSH: 'off',
    CRON_SECRET: 'cron-test-value', RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>',
    // The default restaurant's Tripleseat, from env (the first client's fallback).
    TRIPLESEAT_CLIENT_ID: 'default-ts-id', TRIPLESEAT_CLIENT_SECRET: 'default-ts-secret', TRIPLESEAT_API_HOST: DEFAULT_TS,
  };
  const resend = fakeResend();
  const app = createPlatformApp({ conn, env, mailerFor: (e) => createMailer(e, { fetchImpl: resend.fetchImpl }) });
  await app.locals.warmDefault();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const at = (host) => hostClient(port, host);
  try {
    const admin = at('admin.lvh.test');
    const signIn = await admin.post('/api/platform/login', { email: 'ops@dublow.test', password: 'console-password-1' });
    assert.equal(signIn.status, 200);
    // The first console admin from env has a temporary password: set it before anything else.
    if (signIn.body.result?.mustChange) assert.equal((await admin.post('/api/platform/password', { password: 'console-password-1' })).status, 200);
    const make = async (body) => {
      const r = await admin.post('/api/platform/tenants', { ownerName: 'Pat Owner', ...body });
      assert.equal(r.status, 200, r.text);
      return r.body.result;
    };
    const bistro = await make({ name: 'Bistro Test', slug: 'bistro', ownerEmail: 'pat@bistro.local', plan: 'pro' });
    await make({ name: 'Starter Spot', slug: 'starter-spot', ownerEmail: 'sky@starter.local', plan: 'starter' });
    const accept = async (host, email) => {
      const mail = resend.emails().filter((m) => m.to.includes(email)).at(-1);
      const token = /token=([\w-]+)/.exec(mail.text)[1];
      const c = at(host);
      assert.equal((await c.post('/api/auth/reset', { token, password: 'owner-password-1' })).status, 200);
      return c;
    };
    const pat = await accept('bistro.lvh.test', 'pat@bistro.local');
    const sky = await accept('starter-spot.lvh.test', 'sky@starter.local');
    const moe = await at('chasing-rabbits.lvh.test').login('moe@demo.shiftboard');

    // Bistro's own keys, set in the console (encrypted; only "set" and the last 4 come back).
    const put = await admin.put(`/api/platform/tenants/${bistro.tenant.id}/integrations`, {
      TRIPLESEAT_CLIENT_ID: 'bistro-ts-id', TRIPLESEAT_CLIENT_SECRET: 'bistro-ts-secret', TRIPLESEAT_API_HOST: BISTRO_TS, TRIPLESEAT_LOCATION_ID: '1' });
    assert.equal(put.status, 200, put.text);
    const fields = Object.fromEntries(put.body.result.integrations.fields.map((f) => [f.key, f]));
    assert.deepEqual([fields.TRIPLESEAT_CLIENT_SECRET.set, fields.TRIPLESEAT_CLIENT_SECRET.value], [true, undefined]);
    assert.ok(!put.text.includes('bistro-ts-secret'), 'the secret never comes back');
    assert.equal(put.body.result.integrations.effective.tripleseat, true);

    // Starter: not in the plan, so no Tripleseat at all (RPCs, routes, webhook), and none of the default's env.
    assert.equal((await sky.rpc('tripleseat.get')).status, 403);
    assert.equal((await sky.get('/api/tripleseat/status')).status, 403);
    assert.equal((await sky.post('/api/tripleseat/sync', {})).status, 403);
    assert.equal((await request(port, { host: 'starter-spot.lvh.test', method: 'POST', path: '/api/tripleseat/webhook/x', body: {} })).status, 403);
    assert.equal((await sky.rpc('app.bootstrap')).body.result.tenant.features.tripleseat, false);

    // Each restaurant's status shows its own setup.
    assert.equal((await pat.get('/api/tripleseat/status')).body.result.host, BISTRO_TS);
    assert.equal((await moe.get('/api/tripleseat/status')).body.result.host, DEFAULT_TS);

    // The cron: both restaurants with Tripleseat, each against its own account, into its own schema.
    assert.equal((await request(port, { host: 'legacy.example.test', path: '/api/cron/tripleseat' })).status, 401);
    const cron = await request(port, { host: 'shiftboard-gamma.vercel.app', path: '/api/cron/tripleseat', headers: { Authorization: 'Bearer cron-test-value' } });
    assert.equal(cron.status, 200, cron.text);
    const results = Object.fromEntries(cron.body.result.tenants.map((t) => [t.slug, t]));
    assert.equal(results.bistro.ok, true, JSON.stringify(results));
    assert.equal(results['chasing-rabbits'].ok, true, JSON.stringify(results));
    assert.equal(results['starter-spot'], undefined, 'Starter isn’t even looked at');
    assert.ok(accounts.every((a) => a.seen.includes('/oauth2/token')));
    const names = async (schema) => (await conn.query(`SELECT data->>'name' AS name FROM "${schema}".docs WHERE col = 'events' AND data->>'source' = 'tripleseat' AND NOT deleted ORDER BY 1`)).rows.map((r) => r.name);
    assert.deepEqual(await names('t_bistro'), ['Bistro Rehearsal Dinner']);
    assert.ok((await names('shiftboard')).includes('Default Gala'));
    assert.ok(!(await names('shiftboard')).includes('Bistro Rehearsal Dinner'));
    assert.deepEqual(await names('t_starter_spot'), []);
    const again = await request(port, { host: 'shiftboard-gamma.vercel.app', path: '/api/cron/tripleseat', headers: { Authorization: 'Bearer cron-test-value' } });
    assert.equal(again.body.result.tenants.find((t) => t.slug === 'bistro').skipped, 'Already synced today');

    // Webhook links: each restaurant's own; one restaurant's link does nothing on another's host.
    const bistroToken = (await pat.rpc('tripleseat.webhookLink', {})).body.result.token;
    const crToken = (await moe.rpc('tripleseat.webhookLink', {})).body.result.token;
    assert.notEqual(bistroToken, crToken);
    const hook = (host, token, id) => request(port, { host, method: 'POST', path: `/api/tripleseat/webhook/${token}`, body: { webhook_trigger_type: 'UPDATE_EVENT', event: { id } } });
    assert.equal((await hook('chasing-rabbits.lvh.test', bistroToken, 2001)).status, 404);
    assert.equal((await hook('starter-spot.lvh.test', bistroToken, 2001)).status, 403);
    const okHook = await hook('bistro.lvh.test', bistroToken, 2001);
    assert.equal(okHook.status, 200, okHook.text);
    assert.deepEqual(okHook.body.result.events, [{ id: '2001', action: 'same' }]);
    // Bistro's webhook naming the default's event: Bistro's account doesn't have it, and the default's data is untouched.
    const cross = await hook('bistro.lvh.test', bistroToken, 1001);
    assert.equal(cross.status, 200);
    assert.deepEqual(cross.body.result.events, [{ id: '1001', action: 'skipped' }]);
    assert.ok((await names('shiftboard')).includes('Default Gala'));
    assert.equal((await moe.rpc('tripleseat.get')).body.result.totals.events >= 1, true);
  } finally {
    globalThis.fetch = realFetch;
    _tokenCache.clear();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
