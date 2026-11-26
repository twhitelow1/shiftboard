// Settings → Integrations: a restaurant's own admins set up ADP, Toast, Tripleseat, the text sender and the
// email From (server/integrations-routes.js, server/platform/integrations.js). Admins only, secrets never
// returned, the plan decides which integrations, one restaurant never reads or writes another's, the
// restaurant runs with the new settings right after a save, and a single install is read-only (env).
// Fake values only, clearly not real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { restaurantView, allowedKeys, GROUPS } from '../server/platform/integrations.js';
import { resolveFeatures } from '../server/platform/plans.js';
import { fakeResend } from './helpers/fake-resend.js';
import { hostClient } from './helpers/hosts.js';
import { cookieFor, onboard } from './helpers/signin.js';

test('the view: plan decides the integrations; secrets only as set + last 4; env fallback marked', () => {
  const tenant = { id: 't1', slug: 'bistro', name: 'Bistro', is_default: false, integrations: { TOAST_RESTAURANT_GUID: '11111111-2222-3333-4444-555555555555' }, resolved: resolveFeatures('starter') };
  const starter = restaurantView({ tenant, secretView: { TOAST_CLIENT_SECRET: { set: true, last4: 'abcd' } }, env: { RESEND_API_KEY: 're_x', PLATFORM_EMAIL_FROM: 'ShiftBoard <s@mail.example.test>' } });
  assert.deepEqual(starter.groups.map((g) => g.key), ['email'], 'Starter: only the email From');
  assert.equal(starter.groups[0].status, 'connected');
  assert.equal(starter.groups[0].from, 'Bistro <s@mail.example.test>');
  assert.ok(!allowedKeys(tenant.resolved).has('TOAST_CLIENT_ID') && allowedKeys(tenant.resolved).has('EMAIL_FROM_NAME'));
  // DubLow's sender identities: shown to the restaurant, changed only in the console.
  assert.ok(!allowedKeys(resolveFeatures('pro')).has('EMAIL_FROM_ADDRESS'));
  assert.ok(!allowedKeys(resolveFeatures('pro')).has('TWILIO_MESSAGING_SERVICE_SID') && !allowedKeys(resolveFeatures('pro')).has('TWILIO_FROM_NUMBER'));
  assert.equal(starter.groups[0].fields.find((f) => f.key === 'EMAIL_FROM_ADDRESS').managed, true);
  assert.equal(starter.groups[0].fields.find((f) => f.key === 'EMAIL_FROM_NAME').managed, false);

  const pro = restaurantView({ tenant: { ...tenant, resolved: resolveFeatures('pro') }, secretView: { TOAST_CLIENT_SECRET: { set: true, last4: 'abcd' } }, env: {} });
  assert.deepEqual(pro.groups.map((g) => g.key), GROUPS);
  const toast = pro.groups.find((g) => g.key === 'toast');
  assert.equal(toast.status, 'partial');
  assert.deepEqual(toast.missing, ['TOAST_CLIENT_ID']);
  const secret = toast.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET');
  assert.deepEqual([secret.set, secret.last4, 'value' in secret], [true, 'abcd', false]);
  assert.equal(pro.groups.find((g) => g.key === 'twilio').status, 'noAccount', 'no Twilio account on the server yet');

  const env = { TOAST_CLIENT_ID: 'env-id', TOAST_CLIENT_SECRET: 'env-secret-value', TOAST_RESTAURANT_GUID: '11111111-2222-3333-4444-555555555555' };
  const local = restaurantView({ env, mode: 'env' });
  assert.equal(local.editable, false);
  const lt = local.groups.find((g) => g.key === 'toast');
  assert.equal(lt.status, 'connected');
  assert.ok(lt.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET').fromEnv);
  assert.ok(!JSON.stringify(local).includes('env-secret-value'), 'never a secret, even from env');
});

test('single-restaurant install: admins see what env sets, read-only; managers and staff see nothing', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', TOAST_CLIENT_ID: 'env-client-id', TOAST_CLIENT_SECRET: 'env-secret-value', TOAST_RESTAURANT_GUID: '11111111-2222-3333-4444-555555555555' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (email) => cookieFor(base, email); // password + second step (test/helpers/signin.js)
  const req = (path, cookie, { method = 'GET', body, lang } = {}) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(lang ? { 'X-ShiftBoard-Language': lang } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, text: await r.clone().text(), body: await r.json().catch(() => null) }));
  try {
    assert.equal((await req('/api/integrations')).status, 401);
    assert.equal((await req('/api/integrations', await login('kelly@demo.shiftboard'))).status, 403, 'a manager isn’t an admin');
    assert.equal((await req('/api/integrations', await login('styves@demo.shiftboard'))).status, 403);
    const moe = await login('moe@demo.shiftboard');
    const r = await req('/api/integrations', moe);
    assert.equal(r.status, 200);
    assert.equal(r.body.result.mode, 'env');
    assert.equal(r.body.result.groups.find((g) => g.key === 'toast').status, 'connected');
    assert.ok(!r.text.includes('env-secret-value'));
    const put = await req('/api/integrations', moe, { method: 'PUT', body: { TOAST_CLIENT_ID: 'other' }, lang: 'es' });
    assert.equal(put.status, 400);
    assert.match(put.body.error, /^En esta instalación, las integraciones se configuran con variables de entorno/);
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }
});

test('on the platform: each restaurant’s admins save their own settings (encrypted, audited, in their plan only), and the restaurant uses them at once', async () => {
  const conn = await openPglite();
  const resend = fakeResend();
  const env = {
    PLATFORM_DOMAIN: 'lvh.test', LEGACY_HOSTS: 'legacy.example.test',
    PLATFORM_ADMIN_EMAIL: 'ops@dublow.test', PLATFORM_ADMIN_PASSWORD: 'console-password-1',
    PLATFORM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), JWT_SECRET: 'platform-test-jwt', SEED_DEMO: 'true', EXPO_PUSH: 'off',
    RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>',
    // The default restaurant's Toast from env (its fallback).
    TOAST_CLIENT_ID: 'env-toast-id', TOAST_CLIENT_SECRET: 'env-toast-secret', TOAST_RESTAURANT_GUID: '99999999-2222-3333-4444-555555555555', TOAST_API_HOST: 'https://env-toast.example.test',
  };
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
      const token = /token=([\w-]+)/.exec(resend.emails().filter((m) => m.to.includes(email)).at(-1).text)[1];
      const c = at(host);
      // The owner's invitation opens the welcome wizard: password, a second step, profile, consent; then signed in.
      const done = await onboard((path, body) => c.post(path, body), token, { password: 'bright-kitchen-77' });
      assert.equal(done.status, 200, done.text);
      return c;
    };
    const pat = await accept('bistro.lvh.test', 'pat@bistro.local');
    const sky = await accept('starter-spot.lvh.test', 'sky@starter.local');
    const moe = await at('chasing-rabbits.lvh.test').login('moe@demo.shiftboard');
    const kelly = await at('chasing-rabbits.lvh.test').login('kelly@demo.shiftboard');

    // Admins only.
    assert.equal((await kelly.get('/api/integrations')).status, 403);
    assert.equal((await kelly.put('/api/integrations', { TOAST_API_HOST: 'https://x.example.test' })).status, 403);

    // Bistro (Pro): every integration; Toast not set up; then the owner pastes Toast's keys.
    const before = (await pat.get('/api/integrations')).body.result;
    assert.deepEqual(before.groups.map((g) => g.key), ['adp', 'toast', 'tripleseat', 'opentable', 'twilio', 'email']);
    assert.equal(before.groups.find((g) => g.key === 'toast').status, 'notSetUp');
    assert.equal(before.envFallback, false);
    assert.equal((await pat.get('/api/toast/status')).body.result.configured, false);
    const saved = await pat.put('/api/integrations', { TOAST_CLIENT_ID: 'bistro-toast-id', TOAST_CLIENT_SECRET: 'bistro-toast-secret-value', TOAST_RESTAURANT_GUID: '11111111-2222-3333-4444-555555555555' });
    assert.equal(saved.status, 200, saved.text);
    assert.ok(!saved.text.includes('bistro-toast-secret-value') && !saved.text.includes('bistro-toast-id'), 'secrets never come back');
    const toast = saved.body.result.groups.find((g) => g.key === 'toast');
    assert.equal(toast.status, 'connected');
    assert.deepEqual(toast.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET'), { key: 'TOAST_CLIENT_SECRET', secret: true, multiline: false, placeholder: '', managed: false, set: true, last4: 'alue', fromEnv: false });
    assert.deepEqual(saved.body.result.changed.sort(), ['TOAST_CLIENT_ID (set)', 'TOAST_CLIENT_SECRET (set)', 'TOAST_RESTAURANT_GUID'].sort());
    // The restaurant runs with them from the next request.
    const st = (await pat.get('/api/toast/status')).body.result;
    assert.equal(st.configured, true);
    // Stored encrypted, and audited with the restaurant's admin as the actor.
    const raw = (await conn.query(`SELECT value_enc FROM platform.tenant_secrets WHERE tenant_id = $1`, [bistro.tenant.id])).rows.map((r) => r.value_enc).join(' ');
    assert.ok(raw && !raw.includes('bistro-toast-secret-value'));
    const audit = (await admin.get(`/api/platform/audit?tenant=${bistro.tenant.id}`)).body.result.find((a) => a.action === 'tenant.integrations');
    assert.equal(audit.adminEmail, 'pat@bistro.local');
    assert.equal(audit.details.via, 'restaurant settings');
    assert.ok(audit.details.changed.includes('TOAST_CLIENT_SECRET (set)'));
    assert.ok(!JSON.stringify(audit).includes('bistro-toast-secret-value'));
    // The console sees the same settings.
    const consoleView = (await admin.get(`/api/platform/tenants/${bistro.tenant.id}`)).body.result.integrations;
    assert.equal(consoleView.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET').set, true);
    // Checks, in the caller's language; clearing a secret.
    const bad = await pat.put('/api/integrations', { TRIPLESEAT_LOCATION_ID: 'downtown' }, { 'X-ShiftBoard-Language': 'es' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'El ID del local es un número');
    const cleared = await pat.put('/api/integrations', { TOAST_CLIENT_SECRET: '' });
    assert.equal(cleared.body.result.groups.find((g) => g.key === 'toast').fields.find((f) => f.key === 'TOAST_CLIENT_SECRET').set, false);
    assert.equal((await pat.get('/api/toast/status')).body.result.configured, false);
    assert.equal((await pat.send('PUT', '/api/integrations', 'TOAST_CLIENT_ID=x', { 'Content-Type': 'text/plain' })).status, 415);

    // Starter: only the email From; anything else is outside its plan.
    assert.deepEqual((await sky.get('/api/integrations')).body.result.groups.map((g) => g.key), ['email']);
    const outside = await sky.put('/api/integrations', { TOAST_CLIENT_ID: 'sneaky-id' });
    assert.equal(outside.status, 403);
    assert.equal(outside.body.error, 'Not included in your plan');
    assert.equal((await sky.put('/api/integrations', { EMAIL_FROM_NAME: 'Starter Spot Schedule' })).status, 200);
    // The From address and the texting number are DubLow's: a restaurant admin can't change them.
    const managed = await sky.put('/api/integrations', { EMAIL_FROM_ADDRESS: 'me@elsewhere.example.test' });
    assert.equal(managed.status, 403);
    assert.equal(managed.body.error, 'DubLow Digital sets this one. Ask DubLow to change it.');
    assert.equal((await pat.put('/api/integrations', { TWILIO_FROM_NUMBER: '+17205550100' })).status, 403);

    // One restaurant can't reach another's: its session is refused there, and the default restaurant sees only its own.
    const patOnCr = at('chasing-rabbits.lvh.test');
    patOnCr.setCookies(pat.cookies());
    assert.equal((await patOnCr.get('/api/integrations')).status, 401);
    assert.equal((await patOnCr.put('/api/integrations', { TOAST_API_HOST: 'https://evil.example.test' })).status, 401);
    const cr = (await moe.get('/api/integrations')).body.result;
    assert.equal(cr.envFallback, true);
    const crToast = cr.groups.find((g) => g.key === 'toast');
    assert.equal(crToast.status, 'connected', 'the default restaurant falls back to env');
    assert.ok(crToast.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET').fromEnv);
    assert.equal(crToast.fields.find((f) => f.key === 'TOAST_CLIENT_SECRET').set, false, 'none of Bistro’s secrets');

    // The default restaurant: a value saved in Settings wins over env.
    assert.equal((await moe.get('/api/toast/status')).body.result.host, 'https://env-toast.example.test');
    assert.equal((await moe.put('/api/integrations', { TOAST_API_HOST: 'https://saved-toast.example.test' })).status, 200);
    assert.equal((await moe.get('/api/toast/status')).body.result.host, 'https://saved-toast.example.test');
    assert.equal((await pat.get('/api/toast/status')).body.result.host, 'https://ws-api.toasttab.com', 'Bistro never gets the default restaurant’s value');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
