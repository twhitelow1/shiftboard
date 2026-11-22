// The multi-restaurant platform (server/platform/): routing by host, tenant isolation, creating a
// restaurant, the default restaurant on schema shiftboard, plans and features, paused restaurants,
// encrypted secrets, the LRU of open restaurants, the console's own sign-in and audit log, and support
// sign-in. Uses the embedded Postgres (PGlite); with TEST_DATABASE_URL set it uses a separate throwaway
// database next to it (<name>_platform, created if needed) so it never collides with server.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { DocDb, openConnection, lockKeyFor } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { hostConfig, resolveHost, domainProblem, normalizeHost } from '../server/platform/hosts.js';
import { slugProblem, slugify, schemaForSlug, RESERVED_SLUGS } from '../server/platform/slugs.js';
import { encrypt, decrypt } from '../server/platform/secrets.js';
import { TenantCache } from '../server/platform/tenant-cache.js';
import { resolveFeatures, featureForMethod, billingBanner, PLANS, planForPrice } from '../server/platform/plans.js';
import { tenantEnv } from '../server/platform/tenant-env.js';
import { _tokenCache } from '../server/toast.js';
import { addDays, todayStr } from '../core/time.js';
import { fakeResend } from './helpers/fake-resend.js';
import { hostClient, request } from './helpers/hosts.js';

const PG_URL = process.env.TEST_DATABASE_URL;

/** A clean database: PGlite, or the platform test database next to TEST_DATABASE_URL with every ShiftBoard schema dropped. */
async function freshConn() {
  if (!PG_URL) return openPglite();
  const u = new URL(PG_URL);
  const name = `${u.pathname.slice(1) || 'postgres'}_platform`;
  const admin = openConnection({ DATABASE_URL: PG_URL });
  try { await admin.query(`CREATE DATABASE "${name}"`); } catch (e) { if (e.code !== '42P04') throw e; } finally { await admin.end(); }
  u.pathname = `/${name}`;
  const conn = openConnection({ DATABASE_URL: u.toString() });
  const { rows } = await conn.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('shiftboard', 'platform') OR nspname LIKE 't\\_%'`);
  for (const r of rows) await conn.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  return conn;
}

const KEY = crypto.randomBytes(32).toString('base64'); // a throwaway key for this run
const BASE_ENV = {
  PLATFORM_DOMAIN: 'lvh.test', LEGACY_HOSTS: 'legacy.example.test, old.example.test',
  PLATFORM_ADMIN_EMAIL: 'ops@dublow.test', PLATFORM_ADMIN_PASSWORD: 'console-password-1',
  PLATFORM_ENCRYPTION_KEY: KEY, JWT_SECRET: 'platform-test-jwt', SEED_DEMO: 'true', EXPO_PUSH: 'off',
  CRON_SECRET: 'cron-test-value', RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>',
};

async function startPlatform({ env = {}, conn } = {}) {
  const ownConn = !conn;
  conn ??= await freshConn();
  const resend = fakeResend();
  const clock = { offset: 0 };
  const fullEnv = { ...BASE_ENV, ...env };
  const app = createPlatformApp({
    conn, env: fullEnv, now: () => Date.now() + clock.offset,
    mailerFor: (e) => createMailer(e, { fetchImpl: resend.fetchImpl }),
  });
  await app.locals.warmDefault();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const at = (host) => hostClient(port, host);
  return {
    app, conn, port, resend, clock, at, platform: app.locals.platform,
    console: async () => {
      const c = at('admin.lvh.test');
      const r = await c.post('/api/platform/login', { email: 'ops@dublow.test', password: 'console-password-1' });
      assert.equal(r.status, 200, r.text);
      return c;
    },
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); if (ownConn) await conn.end(); },
  };
}

async function createRestaurant(admin, body) {
  const r = await admin.post('/api/platform/tenants', { plan: 'starter', ownerName: 'Pat Owner', ...body });
  assert.equal(r.status, 200, r.text);
  return r.body.result;
}

/** The owner accepts the invite (email or link) and signs in on the restaurant's host. */
async function acceptInvite(p, host, { link, email }) {
  let url = link;
  if (!url) {
    const mail = p.resend.emails().filter((m) => m.to.includes(email)).at(-1);
    assert.ok(mail, `an email to ${email}`);
    url = /https?:\/\/\S+#\/reset\?token=[\w-]+/.exec(mail.text)?.[0];
  }
  const token = /token=([\w-]+)/.exec(url)[1];
  const c = p.at(host);
  const r = await c.post('/api/auth/reset', { token, password: 'owner-password-1' });
  assert.equal(r.status, 200, r.text);
  return c;
}

// ---------- pure parts ----------

test('host routing: exact domains first, then <slug>.<PLATFORM_DOMAIN>, then the legacy fallback; unknown hosts find nothing', () => {
  const def = { id: 'default', slug: 'chasing-rabbits', is_default: true, domains: [] };
  const bistro = { id: 't1', slug: 'bistro', domains: ['schedule.bistro.example'] };
  const admin = { id: 't2', slug: 'admin', domains: [] }; // can't exist, but even if it did it never wins over the console
  const reg = { byDomain: new Map([['schedule.bistro.example', bistro]]), bySlug: new Map([['bistro', bistro], ['admin', admin], ['chasing-rabbits', def]]), defaultTenant: def };
  const cfg = hostConfig({ PLATFORM_DOMAIN: 'ShiftBoard.app', LEGACY_HOSTS: 'shiftboard-gamma.vercel.app,schedule.chasingrabbits.example' });

  assert.deepEqual(resolveHost('bistro.shiftboard.app', cfg, reg), { kind: 'tenant', tenant: bistro, via: 'subdomain' });
  assert.deepEqual(resolveHost('Bistro.ShiftBoard.app:443', cfg, reg).tenant, bistro);
  assert.deepEqual(resolveHost('schedule.bistro.example', cfg, reg), { kind: 'tenant', tenant: bistro, via: 'domain' });
  assert.deepEqual(resolveHost('shiftboard-gamma.vercel.app', cfg, reg), { kind: 'tenant', tenant: def, via: 'legacy' });
  assert.equal(resolveHost('schedule.chasingrabbits.example', cfg, reg).tenant, def);
  assert.deepEqual(resolveHost('admin.shiftboard.app', cfg, reg), { kind: 'console' });
  for (const h of ['nope.shiftboard.app', 'www.shiftboard.app', 'api.shiftboard.app', 'a.b.shiftboard.app', 'shiftboard.app', 'localhost', 'evil.example']) {
    assert.deepEqual(resolveHost(h, cfg, reg), { kind: 'notFound' }, h);
  }
  // Without PLATFORM_DOMAIN (local development, tests, a single-restaurant install) every host is the default restaurant...
  const none = hostConfig({});
  assert.equal(resolveHost('localhost', none, reg).tenant, def);
  assert.equal(resolveHost('bistro.shiftboard.app', none, reg).tenant, def);
  // ...except a restaurant's own domains, which work before the platform domain exists (a spare *.vercel.app alias).
  assert.equal(resolveHost('schedule.bistro.example', none, reg).tenant, bistro);
  assert.equal(normalizeHost('Schedule.Bistro.Example.:8080'), 'schedule.bistro.example');
  // A legacy host listed explicitly wins even when it sits under the platform domain.
  const under = hostConfig({ PLATFORM_DOMAIN: 'shiftboard.app', LEGACY_HOSTS: 'cr.shiftboard.app' });
  assert.equal(resolveHost('cr.shiftboard.app', under, reg).tenant, def);
  assert.equal(resolveHost('bistro.shiftboard.app', under, reg).tenant, bistro);
});

test('slugs: format, reserved names, schema names; domains can’t be legacy hosts or under the platform domain', () => {
  for (const s of ['admin', 'www', 'api', 'app']) assert.match(slugProblem(s), /reserved/, s);
  assert.ok(RESERVED_SLUGS.length >= 4);
  for (const s of ['a', '-bistro', 'bistro-', 'Bistro', 'bis_tro', 'bis--tro', 'x'.repeat(41), 'bistro.place']) assert.ok(slugProblem(s), s);
  for (const s of ['bistro', 'the-rabbit-hole', 'b2', '86-bar']) assert.equal(slugProblem(s), null, s);
  assert.equal(slugify('The Rabbit Hole Café & Bar!'), 'the-rabbit-hole-cafe-and-bar');
  assert.equal(schemaForSlug('the-rabbit-hole'), 't_the_rabbit_hole');
  assert.notEqual(lockKeyFor('t_bistro'), lockKeyFor('t_bistro2'));
  assert.equal(lockKeyFor('shiftboard'), '5810442771', 'the default schema keeps its lock key');
  const cfg = hostConfig({ PLATFORM_DOMAIN: 'shiftboard.app', LEGACY_HOSTS: 'shiftboard-gamma.vercel.app' });
  assert.equal(domainProblem('schedule.bistro.example', cfg), null);
  assert.match(domainProblem('shiftboard-gamma.vercel.app', cfg), /legacy/);
  assert.match(domainProblem('bistro.shiftboard.app', cfg), /platform domain/);
  assert.match(domainProblem('not a domain', cfg), /isn’t a domain/);
});

test('secrets: AES-256-GCM, bound to the restaurant and the setting; the wrong key or context fails', () => {
  const key = crypto.randomBytes(32);
  const blob = encrypt(key, 'toast-secret-value-1234', 'ten_a:TOAST_CLIENT_SECRET');
  assert.ok(!blob.includes('toast-secret'), 'not stored in the clear');
  assert.notEqual(blob, encrypt(key, 'toast-secret-value-1234', 'ten_a:TOAST_CLIENT_SECRET'), 'a fresh IV each time');
  assert.equal(decrypt(key, blob, 'ten_a:TOAST_CLIENT_SECRET'), 'toast-secret-value-1234');
  assert.throws(() => decrypt(key, blob, 'ten_b:TOAST_CLIENT_SECRET'));
  assert.throws(() => decrypt(crypto.randomBytes(32), blob, 'ten_a:TOAST_CLIENT_SECRET'));
  // One flipped bit in the ciphertext or the tag fails authentication.
  const flip = (b64) => { const b = Buffer.from(b64, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
  const [v, iv, tag, ct] = blob.split('.');
  assert.throws(() => decrypt(key, [v, iv, tag, flip(ct)].join('.'), 'ten_a:TOAST_CLIENT_SECRET'));
  assert.throws(() => decrypt(key, [v, iv, flip(tag), ct].join('.'), 'ten_a:TOAST_CLIENT_SECRET'));
});

test('LRU: keeps the most recently used restaurants, never evicts one with a request in flight', () => {
  const evicted = [];
  const cache = new TenantCache({ max: 2, onEvict: (id) => evicted.push(id) });
  cache.set('a', {}); cache.set('b', {});
  cache.get('a'); // a is now the most recent
  cache.set('c', {});
  assert.deepEqual(cache.keys(), ['a', 'c']);
  assert.deepEqual(evicted, ['b']);
  const busy = cache.get('a');
  const release = cache.hold(busy);
  cache.get('c');
  cache.set('d', {}); // a is least recent but busy: c goes
  assert.deepEqual(cache.keys().sort(), ['a', 'd']);
  cache.set('e', {}); // still busy: over the limit for now
  assert.equal(cache.size, 2);
  release();
  release(); // twice is harmless
  assert.equal(cache.size, 2);
  assert.ok(!cache.keys().includes('a') || cache.size <= 2);
});

test('plans: features per plan with overrides, RPCs mapped to features, prices for Stripe, billing banners', () => {
  assert.deepEqual(Object.entries(resolveFeatures('starter')).filter(([, v]) => v).map(([k]) => k), ['training', 'tips', 'eightySix']);
  assert.equal(resolveFeatures('starter', { events: true }).events, true);
  assert.equal(resolveFeatures('pro', { toast: false }).toast, false);
  assert.ok(Object.values(resolveFeatures('beta')).every(Boolean));
  assert.equal(PLANS.starter.priceCents, 4900);
  assert.equal(PLANS.pro.priceCents, 9900);
  assert.equal(planForPrice('price_pro_x', { STRIPE_PRICE_PRO: 'price_pro_x' }), 'pro');
  assert.equal(planForPrice('price_unknown', {}), null);
  for (const [m, f] of [['menu.list', 'training'], ['mod.get', 'training'], ['myTips.week', 'tips'], ['eightySix.board.get', 'eightySix'], ['events.list', 'events'],
    ['labor.week', 'forecast'], ['settings.laborRules', 'forecast'], ['toast.get', 'toast'], ['sms.preferences', 'sms'], ['sections.list', 'venue'],
    ['shifts.list', null], ['app.bootstrap', null], ['settings.update', null], ['push.subscribe', null]]) {
    assert.equal(featureForMethod(m), f, m);
  }
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.deepEqual(billingBanner({ status: 'trialing', trial_ends_at: '2026-11-04T12:00:00Z' }, now), { kind: 'trial', daysLeft: 3, endsAt: '2026-11-04T12:00:00Z' });
  assert.deepEqual(billingBanner({ status: 'past_due' }, now), { kind: 'pastDue' });
  assert.equal(billingBanner({ status: 'active' }, now), null);
  assert.equal(billingBanner({ status: 'trialing', trial_ends_at: '2026-11-01T20:00:00Z' }, now).daysLeft, 0, 'ends later today');
  assert.equal(billingBanner({ status: 'trialing', trial_ends_at: '2026-10-30T20:00:00Z' }, now).daysLeft, 0, 'already over');
});

test('integrations: another restaurant never inherits the default restaurant’s env; console settings override env', () => {
  const env = { JWT_SECRET: 'j', ADMIN_EMAIL: 'owner@cr.example', SEED_DEMO: 'true', TOAST_CLIENT_ID: 'cr-id', TOAST_CLIENT_SECRET: 'cr-secret', TOAST_RESTAURANT_GUID: 'cr-guid',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG-cr', EMAIL_FROM: 'Chasing Rabbits <s@cr.example>', APP_URL: 'https://cr.example',
    PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@dublow.example>', RESEND_API_KEY: 're' };
  const all = resolveFeatures('beta');
  const def = tenantEnv(env, { id: 'default', is_default: true, name: 'Chasing Rabbits', integrations: {}, resolved: all }, {});
  assert.equal(def.TOAST_CLIENT_ID, 'cr-id');
  assert.equal(def.JWT_SECRET, 'j', 'the default restaurant keeps JWT_SECRET, so its sessions and iCal links keep working');
  assert.equal(def.EMAIL_FROM, 'Chasing Rabbits <s@cr.example>');
  const over = tenantEnv(env, { id: 'default', is_default: true, name: 'CR', integrations: { TWILIO_FROM_NUMBER: '+17205550100', EMAIL_FROM_NAME: 'CR Schedule' }, resolved: all }, { TOAST_CLIENT_SECRET: 'new' });
  assert.equal(over.TOAST_CLIENT_SECRET, 'new');
  assert.equal(over.TWILIO_FROM_NUMBER, '+17205550100');
  assert.equal(over.TWILIO_MESSAGING_SERVICE_SID, '', 'a console sender replaces the env one');
  assert.equal(over.EMAIL_FROM, 'CR Schedule <s@cr.example>');

  const other = tenantEnv(env, { id: 'ten_b', is_default: false, name: 'Bistro', integrations: { TWILIO_MESSAGING_SERVICE_SID: 'MGb' }, resolved: all }, {});
  for (const k of ['ADMIN_EMAIL', 'SEED_DEMO', 'TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID', 'APP_URL']) assert.equal(other[k], undefined, k);
  assert.notEqual(other.JWT_SECRET, 'j');
  assert.equal(other.TWILIO_ACCOUNT_SID, 'AC1', 'one Twilio account for the platform');
  assert.equal(other.TWILIO_MESSAGING_SERVICE_SID, 'MGb');
  assert.equal(other.EMAIL_FROM, 'Bistro <schedule@dublow.example>');
  const noSms = tenantEnv(env, { id: 'ten_c', is_default: false, name: 'C', integrations: {}, resolved: resolveFeatures('starter') }, {});
  assert.equal(noSms.TWILIO_ACCOUNT_SID, undefined, 'no texts without the feature');
});

// ---------- the default restaurant ----------

test('the default restaurant keeps schema shiftboard: its data, sessions, iCal links and email links keep working, untouched', async () => {
  const conn = await freshConn();
  // Today's single-restaurant app, before the platform: a session (no restaurant in it), an iCal link, a reset link.
  const legacyEnv = { SEED_DEMO: 'true', JWT_SECRET: 'platform-test-jwt', EXPO_PUSH: 'off' };
  const old = createApp({ db: new DocDb(conn), env: legacyEnv });
  await old.locals.ready();
  const server = old.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const before = hostClient(server.address().port, 'shiftboard-gamma.vercel.app');
  await before.login('styves@demo.shiftboard');
  const oldCookie = before.cookies();
  const mobile = await before.post('/api/auth/login', { email: 'moe@demo.shiftboard', password: 'demo1234', client: 'mobile' });
  const oldBearer = mobile.body.token;
  assert.equal(JSON.parse(Buffer.from(oldBearer.split('.')[1], 'base64url')).t, undefined, 'old tokens carry no restaurant');
  const ical = (await before.post('/api/rpc-ical-link')).body.result;
  const db0 = new DocDb(conn);
  await db0.sync();
  const victor = db0.store.list('users', (u) => u.email === 'victor@demo.shiftboard')[0];
  const resetToken = await db0.createToken(victor.id, 'reset', 60);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const fingerprint = async () => (await conn.query(`SELECT count(*)::int AS n, max(seq)::text AS seq, md5(string_agg(col || id || coalesce(data::text, ''), ',' ORDER BY col, id)) AS h FROM shiftboard.docs`)).rows[0];
  const meta = async () => (await conn.query('SELECT key, value FROM shiftboard.meta ORDER BY key')).rows;
  const fp0 = await fingerprint();
  const meta0 = await meta();

  // Now the platform on the same database, with the production host as a legacy host.
  const p = await startPlatform({ conn, env: { LEGACY_HOSTS: 'shiftboard-gamma.vercel.app' } });
  try {
    const { rows: [reg] } = await conn.query('SELECT * FROM platform.tenants WHERE is_default');
    assert.equal(reg.schema_name, 'shiftboard');
    assert.equal(reg.slug, 'chasing-rabbits');
    assert.equal(reg.plan, 'beta');
    assert.equal(reg.status, 'active');
    assert.equal(reg.name, 'Chasing Rabbits', 'named from the slug (the demo data has no name of its own)');

    const cr = p.at('shiftboard-gamma.vercel.app');
    cr.setCookies(oldCookie);
    const boot = await cr.rpc('app.bootstrap');
    assert.equal(boot.status, 200, 'an old session (no restaurant in it) still works on the default restaurant');
    assert.equal(boot.body.result.me.name, 'Styves');
    assert.ok(Object.values(boot.body.result.tenant.features).every(Boolean), 'beta: every feature');
    assert.equal(boot.body.result.tenant.billing, null);
    const viaBearer = await request(p.port, { host: 'shiftboard-gamma.vercel.app', method: 'POST', path: '/api/rpc/app.bootstrap', body: {}, headers: { Authorization: `Bearer ${oldBearer}` } });
    assert.equal(viaBearer.status, 200, 'the phone app’s old token too');
    const cal = await cr.get(ical);
    assert.equal(cal.status, 200);
    assert.match(cal.text, /^BEGIN:VCALENDAR/);
    assert.equal((await cr.get('/api/config')).body.restaurant, 'chasing-rabbits');

    // Booting the platform and reading changed nothing in shiftboard.
    assert.deepEqual(await fingerprint(), fp0);
    assert.deepEqual(await meta(), meta0);

    // A reset link made before the platform still works, once.
    const reset = await p.at('shiftboard-gamma.vercel.app').post('/api/auth/reset', { token: resetToken, password: 'victor-new-1' });
    assert.equal(reset.status, 200, reset.text);
    assert.equal((await p.at('shiftboard-gamma.vercel.app').post('/api/auth/reset', { token: resetToken, password: 'again-123' })).status, 400);
    // New sessions name their restaurant.
    const fresh = await p.at('shiftboard-gamma.vercel.app').post('/api/auth/login', { email: 'moe@demo.shiftboard', password: 'demo1234', client: 'mobile' });
    assert.equal(JSON.parse(Buffer.from(fresh.body.token.split('.')[1], 'base64url')).t, 'default');

    // Once PLATFORM_DOMAIN is set, a host that isn't the platform's, a restaurant's or a legacy one finds nothing.
    const stray = await p.at('localhost').get('/api/config');
    assert.equal(stray.status, 404);
    assert.equal(stray.body.notFound, true);
  } finally { await p.close(); await conn.end(); }
});

// ---------- the console ----------

test('platform console: its own sign-in (rate-limited), only on its hosts, and an audit log', async () => {
  const p = await startPlatform();
  try {
    const anon = p.at('admin.lvh.test');
    assert.equal((await anon.get('/api/platform/tenants')).status, 401);
    // A restaurant's Super Admin is not a platform admin.
    assert.equal((await anon.post('/api/platform/login', { email: 'moe@demo.shiftboard', password: 'demo1234' })).status, 401);
    for (let i = 0; i < 9; i++) assert.equal((await anon.post('/api/platform/login', { email: 'ops@dublow.test', password: 'wrong' })).status, 401);
    const blocked = await anon.post('/api/platform/login', { email: 'ops@dublow.test', password: 'wrong' });
    assert.equal(blocked.status, 401);
    assert.equal((await anon.post('/api/platform/login', { email: 'ops@dublow.test', password: 'console-password-1' })).status, 429, 'rate-limited after 10 failures');
    await p.conn.query('DELETE FROM platform.login_attempts');

    const admin = await p.console();
    const list = await admin.get('/api/platform/tenants');
    assert.equal(list.status, 200);
    const def = list.body.result.find((t) => t.isDefault);
    assert.equal(def.slug, 'chasing-rabbits');
    assert.ok(def.staff > 10);
    assert.ok(def.lastActivity);
    // The console answers on admin.<domain> and legacy hosts (/platform), never on a restaurant's host.
    assert.equal((await p.at('legacy.example.test').get('/api/platform/session')).status, 401);
    assert.equal((await p.at('chasing-rabbits.lvh.test').get('/api/platform/session')).status, 404);
    const cookieOnTenant = p.at('chasing-rabbits.lvh.test');
    cookieOnTenant.setCookies(admin.cookies());
    assert.equal((await cookieOnTenant.get('/api/platform/tenants')).status, 404);
    assert.equal((await p.at('admin.lvh.test').get('/api/config')).body.console, '/platform');
    // JSON only for changes (no cross-site form posts).
    const form = await admin.send('POST', '/api/platform/tenants', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    const xsite = await admin.post('/api/platform/tenants', { name: 'X' }, { Origin: 'https://evil.example' });
    assert.equal(xsite.status, 403);

    const audit = await admin.get('/api/platform/audit');
    assert.ok(audit.body.result.some((a) => a.action === 'admin.signin' && a.adminEmail === 'ops@dublow.test'));
    assert.equal((await admin.post('/api/platform/logout')).status, 200);
    assert.equal((await admin.get('/api/platform/tenants')).status, 401);
  } finally { await p.close(); }
});

test('creating a restaurant: its own schema with row-level security, its owner as Super Admin, and an invite', async () => {
  const p = await startPlatform();
  try {
    const admin = await p.console();
    for (const [slug, status] of [['admin', 400], ['www', 400], ['api', 400], ['app', 400], ['Bad Slug', 400], ['chasing-rabbits', 409]]) {
      const r = await admin.post('/api/platform/tenants', { name: 'X', slug, ownerName: 'O', ownerEmail: 'o@x.local', plan: 'starter' });
      assert.equal(r.status, status, `${slug}: ${r.text}`);
      assert.equal(r.body.field, 'slug');
    }
    const check = await admin.get('/api/platform/slug-check?slug=admin');
    assert.equal(check.body.result.ok, false);

    const made = await createRestaurant(admin, { name: 'Bistro Test', slug: 'bistro', ownerEmail: 'pat@bistro.local', trialEndsAt: addDays(todayStr(), 10) });
    assert.equal(made.tenant.address, 'http://bistro.lvh.test');
    assert.equal(made.tenant.schema, 't_bistro');
    assert.equal(made.invite.emailed, true);
    assert.equal(made.invite.link, undefined, 'emailed, so no link to show');
    assert.equal((await admin.post('/api/platform/tenants', { name: 'Again', slug: 'bistro', ownerName: 'O', ownerEmail: 'o@x.local', plan: 'starter' })).status, 409);

    const { rows } = await p.conn.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 't_bistro' AND c.relkind = 'r' ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.relname), ['auth_tokens', 'docs', 'login_attempts', 'meta']);
    assert.ok(rows.every((r) => r.relrowsecurity), 'row level security on every table');

    // The invite came from the restaurant's own name on the platform's address and links to its host.
    const mail = p.resend.emails().find((m) => m.to.includes('pat@bistro.local'));
    assert.equal(mail.from, 'Bistro Test <schedule@mail.dublow.test>');
    assert.match(mail.text, /http:\/\/bistro\.lvh\.test\/#\/reset\?token=/);
    const owner = await acceptInvite(p, 'bistro.lvh.test', { email: 'pat@bistro.local' });
    const boot = (await owner.rpc('app.bootstrap')).body.result;
    assert.equal(boot.me.role, 'super_admin');
    assert.equal(boot.me.email, 'pat@bistro.local');
    assert.equal(boot.settings.restaurantName, 'Bistro Test');
    assert.ok(!boot.settings.rooms.includes('Rabbit Hole'), 'none of the first restaurant’s room names');
    assert.equal(boot.employees.length, 1, 'just the owner, no demo data');
    assert.equal((await p.at('bistro.lvh.test').get('/api/config')).body.brand.name, 'Bistro Test');

    // Without email, the console shows the link once instead. (A second instance on the same database, as on
    // Vercel; this one has no Resend key.)
    const noMail = await startPlatform({ conn: p.conn, env: { RESEND_API_KEY: '' } });
    try {
      const a2 = await noMail.console();
      const r = await createRestaurant(a2, { name: 'Cafe Two', slug: 'cafe-two', ownerEmail: 'sam@cafe.local' });
      assert.equal(r.invite.emailed, false);
      assert.match(r.invite.link, /^http:\/\/cafe-two\.lvh\.test\/#\/reset\?token=[\w-]+$/);
      const sam = await acceptInvite(noMail, 'cafe-two.lvh.test', { link: r.invite.link });
      assert.equal((await sam.rpc('app.bootstrap')).body.result.me.name, 'Pat Owner');
      assert.equal((await a2.get(`/api/platform/tenants/${r.tenant.id}`)).body.result.trialEndsAt != null, true, 'a 14-day trial by default');
    } finally { await noMail.close(); }

    const audit = (await admin.get('/api/platform/audit')).body.result;
    const created = audit.find((a) => a.action === 'tenant.create' && a.details.slug === 'bistro');
    assert.equal(created.details.slug, 'bistro');
    assert.equal(created.adminEmail, 'ops@dublow.test');
  } finally { await p.close(); }
});

// ---------- isolation ----------

test('isolation: a session from one restaurant is refused on another, and no data crosses (RPCs, photos, iCal, cron)', async () => {
  _tokenCache.clear();
  const p = await startPlatform();
  const realFetch = globalThis.fetch;
  try {
    const admin = await p.console();
    const made = await createRestaurant(admin, { name: 'Bistro Test', slug: 'bistro', ownerEmail: 'pat@bistro.local', plan: 'pro' });
    const bistro = await acceptInvite(p, 'bistro.lvh.test', { email: 'pat@bistro.local' });
    const cr = await p.at('chasing-rabbits.lvh.test').login('moe@demo.shiftboard');

    // Cookies: Chasing Rabbits' session on Bistro's host, and the other way round.
    const crOnBistro = p.at('bistro.lvh.test');
    crOnBistro.setCookies(cr.cookies());
    assert.equal((await crOnBistro.rpc('app.bootstrap')).status, 401);
    const bistroOnCr = p.at('legacy.example.test');
    bistroOnCr.setCookies(bistro.cookies());
    assert.equal((await bistroOnCr.rpc('app.bootstrap')).status, 401);
    // Bearer tokens (the phone app) too.
    const token = (await p.at('bistro.lvh.test').post('/api/auth/login', { email: 'pat@bistro.local', password: 'owner-password-1', client: 'mobile' })).body.token;
    const asBearer = (host) => request(p.port, { host, method: 'POST', path: '/api/rpc/app.bootstrap', body: {}, headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await asBearer('bistro.lvh.test')).status, 200);
    assert.equal((await asBearer('legacy.example.test')).status, 401);
    assert.equal((await asBearer('chasing-rabbits.lvh.test')).status, 401);
    // Spoofing X-Forwarded-Host doesn't move a request to another restaurant.
    const spoof = await request(p.port, { host: 'bistro.lvh.test', method: 'POST', path: '/api/rpc/app.bootstrap', body: {}, headers: { Cookie: cr.cookies(), 'X-Forwarded-Host': 'chasing-rabbits.lvh.test' } });
    assert.equal(spoof.status, 401);
    // Email links (reset / invite tokens) live in each restaurant's own schema.
    const crRt = await p.platform.runtime((await p.platform.registry.snapshot()).defaultTenant);
    const victor = crRt.db.store.list('users', (u) => u.email === 'victor@demo.shiftboard')[0];
    const crReset = await crRt.db.createToken(victor.id, 'reset', 60);
    assert.equal((await p.at('bistro.lvh.test').post('/api/auth/reset', { token: crReset, password: 'whatever-1' })).status, 400);
    assert.equal((await p.at('legacy.example.test').post('/api/auth/reset', { token: crReset, password: 'whatever-1' })).status, 200);
    // Signing in on the wrong host doesn't find the account.
    assert.equal((await p.at('bistro.lvh.test').post('/api/auth/login', { email: 'moe@demo.shiftboard', password: 'demo1234' })).status, 401);

    // RPCs: Bistro sees none of Chasing Rabbits' people or shifts.
    const crWeek = (await cr.rpc('shifts.list', { start: '2020-01-01', end: '2030-12-31' })).body.result;
    assert.ok(crWeek.shifts.length > 10);
    assert.ok(crWeek.events.length > 0);
    const bistroWeek = (await bistro.rpc('shifts.list', { start: '2020-01-01', end: '2030-12-31' })).body.result;
    assert.deepEqual([bistroWeek.shifts.length, bistroWeek.events.length, bistroWeek.notes.length], [0, 0, 0]);
    assert.equal((await bistro.rpc('events.get', { id: crWeek.events[0].id })).status, 404);
    const bBoot = (await bistro.rpc('app.bootstrap')).body.result;
    assert.deepEqual(bBoot.employees.map((e) => e.email), ['pat@bistro.local']);

    // Photos: an 86 photo of Chasing Rabbits isn't served on Bistro's host, even to a signed-in Bistro owner.
    const mak = await p.at('chasing-rabbits.lvh.test').login('mak@demo.shiftboard');
    const item = (await mak.rpc('eightySix.board.get')).body.result.lists[0].items[0];
    const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]).toString('base64')}`;
    const photoId = (await mak.rpc('eightySix.addPhoto', { itemId: item.id, dataUrl: jpeg, w: 10, h: 10 })).body.result.photo.id;
    assert.equal((await mak.get(`/api/eighty-six/photos/${photoId}`)).status, 200);
    assert.equal((await bistro.get(`/api/eighty-six/photos/${photoId}`)).status, 404);
    assert.equal((await crOnBistro.get(`/api/eighty-six/photos/${photoId}`)).status, 401);

    // iCal: Chasing Rabbits' link doesn't work on Bistro's host.
    const ical = (await cr.post('/api/rpc-ical-link')).body.result;
    assert.equal((await cr.get(ical)).status, 200);
    assert.equal((await p.at('bistro.lvh.test').get(ical)).status, 404);
    const bIcal = (await bistro.post('/api/rpc-ical-link')).body.result;
    assert.equal((await p.at('bistro.lvh.test').get(bIcal)).status, 200);
    assert.equal((await p.at('legacy.example.test').get(bIcal)).status, 404);

    // Cron: only Bistro has Toast set up (in the console), so only Bistro's schema gets Toast data.
    const GUID = '11111111-2222-3333-4444-555555555555';
    const TOAST = 'https://toast-bistro.example.test';
    const put = await admin.put(`/api/platform/tenants/${made.tenant.id}/integrations`, {
      TOAST_CLIENT_ID: 'bistro-client-id', TOAST_CLIENT_SECRET: 'bistro-toast-secret-value', TOAST_RESTAURANT_GUID: GUID, TOAST_API_HOST: TOAST });
    assert.equal(put.status, 200, put.text);
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (!url.startsWith(TOAST)) return realFetch(url, init);
      seen.push(u.pathname);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname.endsWith('/login')) {
        assert.equal(JSON.parse(init.body).clientSecret, 'bistro-toast-secret-value');
        return json({ token: { accessToken: 'tok', expiresIn: 3600 } });
      }
      assert.equal(init.headers['Toast-Restaurant-External-ID'], GUID);
      if (u.pathname.includes('/restaurants/')) return json({ general: { name: 'Bistro', timeZone: 'America/Denver' } });
      return json([]);
    };
    assert.equal((await p.at('legacy.example.test').get('/api/cron/toast')).status, 401);
    const cron = await request(p.port, { host: 'shiftboard-gamma.vercel.app', path: '/api/cron/toast', headers: { Authorization: 'Bearer cron-test-value' } });
    assert.equal(cron.status, 200, cron.text);
    const results = Object.fromEntries(cron.body.result.tenants.map((t) => [t.slug, t]));
    assert.equal(results.bistro.ok, true, JSON.stringify(results));
    assert.equal(results['chasing-rabbits'].skipped, 'Toast is not set up');
    assert.ok(seen.length > 3);
    const toastDocs = async (schema) => Number((await p.conn.query(`SELECT count(*)::int AS n FROM "${schema}".docs WHERE col = 'integrations'`)).rows[0].n);
    assert.equal(await toastDocs('t_bistro'), 1);
    assert.equal(await toastDocs('shiftboard'), 0);
    // A second run the same day leaves it alone.
    const again = await request(p.port, { host: 'shiftboard-gamma.vercel.app', path: '/api/cron/toast', headers: { Authorization: 'Bearer cron-test-value' } });
    assert.equal(again.body.result.tenants.find((t) => t.slug === 'bistro').skipped, 'Already synced today');
  } finally {
    globalThis.fetch = realFetch;
    _tokenCache.clear();
    await p.close();
  }
});

// ---------- plans, pausing, secrets, support ----------

test('features follow the plan on the server: 403 for RPCs and routes outside it, overrides switch them on', async () => {
  const p = await startPlatform();
  try {
    const admin = await p.console();
    const made = await createRestaurant(admin, { name: 'Starter Spot', slug: 'starter-spot', ownerEmail: 'sky@starter.local', plan: 'starter' });
    const owner = await acceptInvite(p, 'starter-spot.lvh.test', { email: 'sky@starter.local' });
    const boot = (await owner.rpc('app.bootstrap')).body.result;
    assert.deepEqual(boot.tenant.features, resolveFeatures('starter'));
    assert.deepEqual((await owner.get('/api/config')).body.features, resolveFeatures('starter'));
    for (const m of ['events.list', 'forecast.week', 'labor.week', 'sections.list', 'venue.get', 'sms.preferences', 'toast.get', 'settings.laborRules']) {
      const r = await owner.rpc(m, {});
      assert.equal(r.status, 403, m);
      assert.equal(r.body.error, 'Not included in your plan');
    }
    const es = await owner.rpc('events.list', {}, { 'X-ShiftBoard-Language': 'es' });
    assert.equal(es.status, 403);
    for (const path of ['/api/toast/status', '/api/sms/test']) assert.equal((await owner.send(path.endsWith('status') ? 'GET' : 'POST', path, path.endsWith('status') ? undefined : {})).status, 403, path);
    assert.equal((await owner.rpc('training.summary')).status, 200, 'Training is in Starter');
    assert.equal((await owner.rpc('shifts.list', { start: todayStr(), end: todayStr() })).status, 200);

    const patched = await admin.patch(`/api/platform/tenants/${made.tenant.id}`, { features: { events: true, training: false } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal((await owner.rpc('events.list', {})).status, 200);
    assert.equal((await owner.rpc('training.summary')).status, 403);
    assert.equal((await owner.get('/api/training/photos/x')).status, 403);
    const audit = (await admin.get(`/api/platform/audit?tenant=${made.tenant.id}`)).body.result;
    assert.ok(audit.some((a) => a.action === 'tenant.update' && a.details.features));
  } finally { await p.close(); }
});

test('a suspended or canceled restaurant can’t sign in, its data is kept, and it comes back when reactivated', async () => {
  const p = await startPlatform();
  try {
    const admin = await p.console();
    const made = await createRestaurant(admin, { name: 'Paused Place', slug: 'paused', ownerEmail: 'lee@paused.local' });
    const owner = await acceptInvite(p, 'paused.lvh.test', { email: 'lee@paused.local' });
    assert.equal((await owner.rpc('notes.save', { kind: 'day', date: todayStr(), text: 'Keep me' })).status, 200);

    for (const status of ['suspended', 'canceled']) {
      assert.equal((await admin.patch(`/api/platform/tenants/${made.tenant.id}`, { status })).status, 200);
      const login = await p.at('paused.lvh.test').post('/api/auth/login', { email: 'lee@paused.local', password: 'owner-password-1' });
      assert.equal(login.status, 403);
      assert.equal(login.body.error, 'This restaurant’s account is paused. Contact DubLow Digital.');
      const es = await p.at('paused.lvh.test').post('/api/auth/login', { email: 'lee@paused.local', password: 'x' }, { 'X-ShiftBoard-Language': 'es' });
      assert.match(es.body.error, /pausada/);
      assert.equal((await owner.rpc('app.bootstrap')).status, 403, 'a session from before is refused too');
      const cfg = (await p.at('paused.lvh.test').get('/api/config')).body;
      assert.equal(cfg.paused, true);
      assert.equal(cfg.brand.name, 'Paused Place');
      assert.equal((await admin.post(`/api/platform/tenants/${made.tenant.id}/support`, {})).status, 400);
    }
    const n = Number((await p.conn.query(`SELECT count(*)::int AS n FROM t_paused.docs WHERE NOT deleted`)).rows[0].n);
    assert.ok(n >= 3, 'the data is kept');

    assert.equal((await admin.patch(`/api/platform/tenants/${made.tenant.id}`, { status: 'active' })).status, 200);
    const back = await owner.rpc('shifts.list', { start: todayStr(), end: todayStr() });
    assert.equal(back.status, 200);
    assert.deepEqual(back.body.result.notes.map((x) => x.text), ['Keep me']);
    const audit = (await admin.get(`/api/platform/audit?tenant=${made.tenant.id}`)).body.result.map((a) => a.action);
    assert.ok(audit.includes('tenant.pause'));
    assert.ok(audit.includes('tenant.resume'));
  } finally { await p.close(); }
});

test('integration secrets are encrypted at rest and never come back to the console, only “set” and the last 4', async () => {
  const p = await startPlatform();
  try {
    const admin = await p.console();
    const made = await createRestaurant(admin, { name: 'Secret Spot', slug: 'secret-spot', ownerEmail: 'kim@secret.local', plan: 'pro' });
    const id = made.tenant.id;
    const SECRET = 'toast-client-secret-ABCD9876';
    const r = await admin.put(`/api/platform/tenants/${id}/integrations`, {
      TOAST_CLIENT_ID: 'client-id-WXYZ1234', TOAST_CLIENT_SECRET: SECRET, TOAST_RESTAURANT_GUID: '11111111-2222-3333-4444-555555555555',
      TWILIO_MESSAGING_SERVICE_SID: `MG${'a'.repeat(32)}`, EMAIL_FROM_NAME: 'Secret Spot Schedule', EMAIL_FROM_ADDRESS: 'schedule@secret.local' });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(SECRET) && !r.text.includes('client-id-WXYZ1234'), 'never in a response');
    const fields = Object.fromEntries(r.body.result.integrations.fields.map((f) => [f.key, f]));
    assert.deepEqual([fields.TOAST_CLIENT_SECRET.set, fields.TOAST_CLIENT_SECRET.last4, fields.TOAST_CLIENT_SECRET.value], [true, '9876', undefined]);
    assert.equal(fields.TOAST_CLIENT_ID.last4, '1234');
    assert.equal(fields.TOAST_RESTAURANT_GUID.value, '11111111-2222-3333-4444-555555555555');
    assert.equal(fields.EMAIL_FROM_ADDRESS.value, 'schedule@secret.local');
    assert.equal(r.body.result.integrations.effective.toast, true);
    const detail = await admin.get(`/api/platform/tenants/${id}`);
    assert.ok(!detail.text.includes(SECRET));
    const audit = await admin.get('/api/platform/audit');
    assert.ok(!audit.text.includes(SECRET));
    // At rest: ciphertext only, and it decrypts with the key and this restaurant's id.
    const { rows } = await p.conn.query(`SELECT value_enc FROM platform.tenant_secrets WHERE tenant_id = $1 AND key = 'TOAST_CLIENT_SECRET'`, [id]);
    assert.ok(!rows[0].value_enc.includes(SECRET));
    assert.equal(decrypt(Buffer.from(KEY, 'base64'), rows[0].value_enc, `${id}:TOAST_CLIENT_SECRET`), SECRET);
    // The restaurant's app uses them (the managers' Toast status says configured), and its email comes from its own address.
    const owner = await acceptInvite(p, 'secret-spot.lvh.test', { email: 'kim@secret.local' });
    assert.equal((await owner.get('/api/toast/status')).body.result.configured, true);
    assert.equal((await owner.get('/api/config')).body.emailFrom, 'Secret Spot Schedule <schedule@secret.local>');
    // Bad values are refused; clearing works.
    assert.equal((await admin.put(`/api/platform/tenants/${id}/integrations`, { TWILIO_FROM_NUMBER: '555-0100' })).status, 400);
    const cleared = await admin.put(`/api/platform/tenants/${id}/integrations`, { TOAST_CLIENT_SECRET: '' });
    assert.equal(cleared.body.result.integrations.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET').set, false);
    assert.equal((await owner.get('/api/toast/status')).body.result.configured, false);
  } finally { await p.close(); }

  // Without PLATFORM_ENCRYPTION_KEY, secrets can't be saved at all.
  const q = await startPlatform({ env: { PLATFORM_ENCRYPTION_KEY: '' } });
  try {
    const admin = await q.console();
    const made = await createRestaurant(admin, { name: 'No Key', slug: 'no-key', ownerEmail: 'o@nokey.local' });
    const r = await admin.put(`/api/platform/tenants/${made.tenant.id}/integrations`, { TOAST_CLIENT_SECRET: 'something-secret' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /PLATFORM_ENCRYPTION_KEY/);
  } finally { await q.close(); }
});

test('support sign-in: a one-time link, a banner while it lasts, no password changes, it expires, and it’s audited', async () => {
  const p = await startPlatform();
  try {
    const admin = await p.console();
    const made = await createRestaurant(admin, { name: 'Help Me', slug: 'help-me', ownerEmail: 'ana@help.local' });
    await acceptInvite(p, 'help-me.lvh.test', { email: 'ana@help.local' });
    const s = await admin.post(`/api/platform/tenants/${made.tenant.id}/support`, { minutes: 15 });
    assert.equal(s.status, 200, s.text);
    assert.match(s.body.result.url, /^http:\/\/help-me\.lvh\.test\/api\/auth\/support\?token=/);
    const path = s.body.result.url.replace(/^http:\/\/[^/]+/, '');

    // The link works on its restaurant's host only, once.
    assert.equal((await p.at('legacy.example.test').get(path)).status, 400);
    const support = p.at('help-me.lvh.test');
    const open = await support.get(path);
    assert.equal(open.status, 302);
    assert.equal(open.headers.location, '/#/');
    assert.equal((await p.at('help-me.lvh.test').get(path)).status, 400, 'used already');
    const boot = (await support.rpc('app.bootstrap')).body.result;
    assert.equal(boot.me.email, 'ana@help.local');
    assert.equal(boot.tenant.support.by, 'ops@dublow.test');
    assert.ok(Date.parse(boot.tenant.support.until) > Date.now());
    assert.equal((await support.rpc('employees.changePassword', { password: 'hijacked-1' })).status, 403);
    assert.equal((await support.rpc('shifts.list', { start: todayStr(), end: todayStr() })).status, 200);

    // After the minutes picked, the session ends.
    p.clock.offset = 16 * 60_000;
    assert.equal((await support.rpc('app.bootstrap')).status, 401);
    p.clock.offset = 0;

    // A link not opened in time doesn't work.
    const late = await admin.post(`/api/platform/tenants/${made.tenant.id}/support`, {});
    await p.conn.query(`UPDATE platform.support_grants SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
    assert.equal((await p.at('help-me.lvh.test').get(late.body.result.url.replace(/^http:\/\/[^/]+/, ''))).status, 400);

    const actions = (await admin.get(`/api/platform/audit?tenant=${made.tenant.id}`)).body.result.map((a) => a.action);
    assert.ok(actions.includes('support.start'));
    assert.ok(actions.includes('support.signin'));
  } finally { await p.close(); }
});

test('billing banners: trial and payment-failed, for the restaurant’s admins only; the portal is a phase 2 stub', async () => {
  const p = await startPlatform();
  try {
    const admin = await p.console();
    const made = await createRestaurant(admin, { name: 'Trial Spot', slug: 'trial-spot', ownerEmail: 'jo@trial.local', trialEndsAt: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString() });
    const owner = await acceptInvite(p, 'trial-spot.lvh.test', { email: 'jo@trial.local' });
    let boot = (await owner.rpc('app.bootstrap')).body.result;
    assert.deepEqual([boot.tenant.status, boot.tenant.billing.kind, boot.tenant.billing.daysLeft], ['trialing', 'trial', 5]);
    // A staff member never sees it.
    const saved = await owner.rpc('employees.save', { name: 'Sam Server', email: 'sam@trial.local', role: 'employee', jobCodes: [] });
    assert.equal(saved.status, 200, saved.text);
    const staff = await p.at('trial-spot.lvh.test').login('sam@trial.local', saved.body.result.tempPassword);
    assert.equal((await staff.rpc('app.bootstrap')).body.result.tenant.billing, null);
    assert.equal((await staff.post('/api/billing/portal')).status, 403);
    const portal = await owner.post('/api/billing/portal');
    assert.equal(portal.status, 200);
    assert.equal(portal.body.result.url, null, 'no Stripe in phase 1');

    await admin.patch(`/api/platform/tenants/${made.tenant.id}`, { status: 'past_due' });
    boot = (await owner.rpc('app.bootstrap')).body.result;
    assert.equal(boot.tenant.billing.kind, 'pastDue');
    await admin.patch(`/api/platform/tenants/${made.tenant.id}`, { status: 'active' });
    assert.equal((await owner.rpc('app.bootstrap')).body.result.tenant.billing, null);
  } finally { await p.close(); }
});

test('only the most recently used restaurants stay open (TENANT_CACHE_MAX); evicted ones reopen on their next request', async () => {
  const p = await startPlatform({ env: { TENANT_CACHE_MAX: '2' } });
  try {
    const admin = await p.console();
    for (const slug of ['one', 'two', 'three']) {
      await createRestaurant(admin, { name: `Spot ${slug}`, slug, ownerEmail: `o@${slug}.local` });
    }
    const { cache } = p.platform;
    for (const slug of ['one', 'two', 'three']) assert.equal((await p.at(`${slug}.lvh.test`).get('/api/config')).body.brand.name, `Spot ${slug}`);
    assert.ok(cache.size <= 2, `open: ${cache.keys()}`);
    const snap = await p.platform.registry.snapshot({ fresh: true });
    assert.deepEqual(cache.keys(), ['two', 'three'].map((s) => snap.bySlug.get(s).id));
    assert.equal((await p.at('one.lvh.test').get('/api/config')).body.brand.name, 'Spot one');
    assert.deepEqual(cache.keys(), ['three', 'one'].map((s) => snap.bySlug.get(s).id));
  } finally { await p.close(); }
});

test('unknown restaurants: JSON 404 for the API, a page for browsers; reserved subdomains are never restaurants', async () => {
  const p = await startPlatform();
  try {
    for (const host of ['nope.lvh.test', 'www.lvh.test', 'api.lvh.test', 'lvh.test', 'deep.nope.lvh.test']) {
      const api = await p.at(host).get('/api/config');
      assert.equal(api.status, 404, host);
      assert.deepEqual(api.body, { error: 'Restaurant not found', notFound: true });
      assert.equal((await p.at(host).rpc('app.bootstrap')).status, 404);
      const page = await p.at(host).get('/');
      assert.equal(page.status, 404);
      assert.match(page.text, /Restaurant not found/);
    }
    assert.equal((await p.at('old.example.test').get('/api/config')).body.restaurant, 'chasing-rabbits', 'every legacy host is the default restaurant');
    assert.equal((await p.at('admin.lvh.test').get('/')).status, 302);
  } finally { await p.close(); }
});
