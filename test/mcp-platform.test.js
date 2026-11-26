// The Claude connector on the multi-restaurant platform: each restaurant's host is its own authorization server and
// MCP server. A token, a client id or a code from one restaurant is useless on another host, and the plan decides
// whether a restaurant has the connector at all. Uses the embedded Postgres (PGlite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { openPglite } from '../server/pglite.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { fakeResend } from './helpers/fake-resend.js';
import { hostClient } from './helpers/hosts.js';
import { onboard } from './helpers/signin.js';
import { browser, connect, register, authorize, pkcePair, refresh, rpc, CLAUDE_CALLBACK } from './helpers/mcp.js';

const ENV = {
  PLATFORM_DOMAIN: 'lvh.test', LEGACY_HOSTS: 'legacy.example.test', PLATFORM_ADMIN_EMAIL: 'ops@dublow.test', PLATFORM_ADMIN_PASSWORD: 'console-password-1',
  PLATFORM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), JWT_SECRET: 'shared-platform-secret', SEED_DEMO: 'true', EXPO_PUSH: 'off',
  RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>',
};

async function startPlatform() {
  const conn = await openPglite();
  const resend = fakeResend();
  const app = createPlatformApp({ conn, env: ENV, mailerFor: (e) => createMailer(e, { fetchImpl: resend.fetchImpl }) });
  await app.locals.warmDefault();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const admin = hostClient(port, 'admin.lvh.test');
  const login = await admin.post('/api/platform/login', { email: 'ops@dublow.test', password: 'console-password-1' });
  assert.equal(login.status, 200, login.text);
  if (login.body.result?.mustChange) await admin.post('/api/platform/password', { password: 'console-password-1' });
  return { port, admin, resend, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); } };
}

async function restaurant(p, slug, plan) {
  const r = await p.admin.post('/api/platform/tenants', { name: `${slug} Test`, slug, plan, ownerName: 'Pat Owner', ownerEmail: `owner@${slug}.local` });
  assert.equal(r.status, 200, r.text);
  const mail = p.resend.emails().filter((m) => m.to.includes(`owner@${slug}.local`)).at(-1);
  const token = /#\/welcome\?token=([\w-]+)/.exec(mail.text)[1];
  const c = hostClient(p.port, `${slug}.lvh.test`);
  const done = await onboard((path, body) => c.post(path, body), token, { password: 'bright-kitchen-77', realm: slug });
  assert.equal(done.status, 200, done.text);
  return r.body.result.tenant;
}

test('platform: each restaurant’s host is its own authorization server; tokens, clients and codes never cross', async () => {
  const p = await startPlatform();
  try {
    await restaurant(p, 'bistro', 'pro');
    const bistro = browser({ port: p.port, host: 'bistro.lvh.test' });
    const legacy = browser({ port: p.port, host: 'legacy.example.test' });

    // Discovery names the host's own address.
    const meta = await bistro.get('/.well-known/oauth-protected-resource/mcp');
    assert.equal(meta.status, 200, meta.text);
    assert.equal(meta.body.resource, 'http://bistro.lvh.test/mcp');
    assert.deepEqual(meta.body.authorization_servers, ['http://bistro.lvh.test']);

    const b = await connect(bistro, 'owner@bistro.local', { password: 'bright-kitchen-77', realm: 'bistro' });
    const d = await connect(legacy, 'moe@demo.shiftboard');
    assert.equal((await rpc(bistro, b.tokens.access_token, 'tools/list')).status, 200);
    assert.equal((await rpc(legacy, d.tokens.access_token, 'tools/list')).status, 200);

    // Bistro's token on the default restaurant's host, and the other way round: refused.
    assert.equal((await rpc(legacy, b.tokens.access_token, 'tools/list')).status, 401);
    assert.equal((await rpc(bistro, d.tokens.access_token, 'tools/list')).status, 401);
    // Bistro's refresh token and client id mean nothing on another host.
    assert.equal((await refresh(legacy, b.client, b.tokens.refresh_token)).body.error, 'invalid_client');
    const { challenge } = pkcePair();
    const cross = await authorize(legacy, { response_type: 'code', client_id: b.client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(cross.status, 400, 'another restaurant’s client id is unknown here');
    // A consent request made on one host can't be used on another.
    const legacyClient = await register(legacy);
    const a = await authorize(legacy, { response_type: 'code', client_id: legacyClient.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal((await bistro.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`)).status, 400);
    // The same person's session cookie from one host doesn't sign them in on another (the platform's rule), so they can't consent there.
    const stranger = browser({ port: p.port, host: 'bistro.lvh.test' });
    const bistroReq = await authorize(stranger, { response_type: 'code', client_id: b.client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal((await stranger.post('/api/oauth/decide', { r: bistroReq.r, allow: true }, { headers: { Cookie: legacy.cookie() } })).status, 401);
    // An unknown restaurant host answers JSON, not the app.
    const nowhere = browser({ port: p.port, host: 'nowhere.lvh.test' });
    const nf = await rpc(nowhere, b.tokens.access_token, 'tools/list');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.notFound, true);
  } finally { await p.close(); }
});

test('platform: the connector follows the plan (Starter: off; Pro and Beta: on; DubLow can switch it per restaurant)', async () => {
  const p = await startPlatform();
  try {
    const t = await restaurant(p, 'deli', 'starter');
    const deli = browser({ port: p.port, host: 'deli.lvh.test' });
    assert.equal((await deli.get('/.well-known/oauth-protected-resource')).status, 404);
    assert.equal((await deli.post('/oauth/register', { redirect_uris: [CLAUDE_CALLBACK] })).status, 404);
    assert.equal((await rpc(deli, null, 'tools/list')).status, 404);
    // DubLow switches it on for this restaurant only.
    assert.equal((await p.admin.patch(`/api/platform/tenants/${t.id}`, { features: { mcp: true } })).status, 200);
    assert.equal((await deli.get('/.well-known/oauth-protected-resource')).status, 200);
    const c = await connect(deli, 'owner@deli.local', { password: 'bright-kitchen-77', realm: 'deli' });
    const list = await rpc(deli, c.tokens.access_token, 'tools/list');
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map((x) => x.name);
    assert.ok(names.includes('get_86_list'), 'Starter has the 86 List');
    assert.ok(!names.includes('get_events') && !names.includes('get_forecast'), 'but not Pro’s features');
    // Paused: nothing works.
    assert.equal((await p.admin.patch(`/api/platform/tenants/${t.id}`, { status: 'suspended' })).status, 200);
    assert.equal((await rpc(deli, c.tokens.access_token, 'tools/list')).status, 403);
  } finally { await p.close(); }
});
