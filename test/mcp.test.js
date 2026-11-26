// The Claude connector (server/mcp/, server/tools/): OAuth discovery, Dynamic Client Registration's allowlist, the
// authorize flow with PKCE and the second step, tokens (rotation, reuse, revocation, sessionVersion), scopes, the MCP
// server through the official SDK client (tools per role, calls end to end), plan gating, rate limits, and the
// security basics (hashed storage, constant-time checks, nothing secret in the logs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp } from './helpers/app.js';
import { browser, connect, register, authorize, pkcePair, refresh, rpc, CLAUDE_CALLBACK } from './helpers/mcp.js';
import { signIn } from './helpers/signin.js';
import * as T from '../server/mcp/tokens.js';
import { resolveDate, resolveWeek } from '../server/tools/dates.js';
import { TOOLS, toolByName, toolJsonSchema, toClaudeTool, visibleTools, READ, WRITE } from '../server/tools/index.js';
import { toolError } from '../server/tools/errors.js';

const clock = { offset: 0 };
const now = () => Date.now() + clock.offset;

async function mcpClient(base, token) {
  const client = new Client({ name: 'shiftboard-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const textOf = (r) => r.content.map((c) => c.text).join('\n');

// ---------- pure parts ----------

test('redirect URIs: Claude’s callbacks and loopback /callback only, matched strictly', () => {
  for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://localhost:3118/callback', 'http://127.0.0.1:65535/callback', 'http://localhost/callback']) {
    assert.ok(T.redirectKind(ok), ok);
  }
  for (const bad of ['https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1', 'https://Claude.ai/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback',
    'https://evil.example/api/mcp/auth_callback', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'http://localhost.evil.example/callback', 'http://localhost:3118/callback/x',
    'http://localhost:0/callback', 'http://localhost:99999/callback', 'http://user@localhost:3000/callback', 'https://localhost:3000/callback', 'http://[::1]:3000/callback', 'javascript:alert(1)', '']) {
    assert.equal(T.redirectKind(bad), null, bad);
  }
  assert.ok(T.redirectMatches(['http://localhost:3000/callback'], 'http://localhost:4567/callback'), 'loopback: any port');
  assert.ok(!T.redirectMatches(['http://localhost:3000/callback'], 'http://127.0.0.1:3000/callback'), 'loopback: same host');
  assert.ok(!T.redirectMatches([CLAUDE_CALLBACK], 'https://claude.com/api/mcp/auth_callback'), 'exact match otherwise');
});

test('tokens: keys per restaurant, client ids signed, PKCE S256, constant-time compare', () => {
  const a = T.createKeys(() => 'secret', 'shiftboard');
  const b = T.createKeys(() => 'secret', 't_bistro');
  const reg = T.checkRegistration({ redirect_uris: [CLAUDE_CALLBACK], client_name: 'Claude <script>' });
  const { clientId } = T.issueClient(a, reg.metadata, 1);
  assert.equal(T.readClient(a, clientId).name, 'Claude script');
  assert.equal(T.readClient(b, clientId), null, 'another restaurant’s client id is unknown here');
  assert.equal(T.readClient(a, clientId.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null, 'tampered');
  const conf = T.issueClient(a, { ...reg.metadata, token_endpoint_auth_method: 'client_secret_post' }, 1);
  assert.ok(T.clientSecretOk(a, T.readClient(a, conf.clientId), conf.secret));
  assert.ok(!T.clientSecretOk(a, T.readClient(a, conf.clientId), `${conf.secret}x`));
  const { verifier, challenge } = pkcePair();
  assert.ok(T.pkceOk(verifier, challenge));
  assert.ok(!T.pkceOk(`${verifier}x`, challenge));
  assert.ok(!T.pkceOk('short', challenge));
  assert.ok(T.safeEqual('abc', 'abc') && !T.safeEqual('abc', 'abd') && !T.safeEqual('abc', 'abcd'));
  const access = T.signAccess(a, { sub: 'u', g: 'g', v: 0, scope: [T.SCOPES.read], iss: 'https://x', aud: 'https://x/mcp' }, 100);
  assert.ok(T.readAccess(a, access, { iss: 'https://x', aud: 'https://x/mcp', nowSec: 101 }));
  assert.equal(T.readAccess(b, access, { iss: 'https://x', aud: 'https://x/mcp', nowSec: 101 }), null, 'another restaurant’s key');
  assert.equal(T.readAccess(a, access, { iss: 'https://y', aud: 'https://y/mcp', nowSec: 101 }), null, 'another host');
  assert.equal(T.readAccess(a, access, { iss: 'https://x', aud: 'https://x/mcp', nowSec: 100 + 3601 }), null, 'expired after an hour');
  assert.deepEqual(T.parseScope('offline_access shiftboard.write').scopes, [T.SCOPES.read, T.SCOPES.write]);
  assert.ok(T.parseScope('admin').error);
  assert.deepEqual(T.checkRegistration({ redirect_uris: ['https://evil.example/cb'] }).error, 'invalid_redirect_uri');
});

test('dates in the restaurant’s words; the tool registry exports JSON Schema for the Claude API', () => {
  const today = '2026-11-26'; // a Thursday
  assert.equal(resolveDate('today', today), today);
  assert.equal(resolveDate('tomorrow', today), '2026-11-27');
  assert.equal(resolveDate('friday', today), '2026-11-27');
  assert.equal(resolveDate('this Thursday', today), today);
  assert.equal(resolveDate('next friday', today), '2026-12-04');
  assert.equal(resolveDate('viernes', today), '2026-11-27');
  assert.equal(resolveDate('mañana', today), '2026-11-27');
  assert.equal(resolveDate('2027-02-28', today), '2027-02-28');
  assert.throws(() => resolveDate('2027-02-30', today), /Use a date like/);
  assert.equal(resolveWeek('next week', today, 1), '2026-11-30');
  assert.equal(toolError('Use a date like 2026-11-26, “today”, “tomorrow” or a weekday', 'es'), 'Usa una fecha como 2026-11-26, “hoy”, “mañana” o un día de la semana');
  const t = toClaudeTool(toolByName('create_shift'));
  assert.equal(t.input_schema.type, 'object');
  assert.deepEqual(t.input_schema.required.sort(), ['date', 'position', 'start']);
  for (const tool of TOOLS) {
    assert.equal(toolJsonSchema(tool).type, 'object', tool.name);
    assert.ok(tool.description.length > 40, `${tool.name} has a real description`);
    assert.equal(tool.scope, tool.write ? WRITE : READ);
  }
  assert.ok(toolByName('publish_week').confirm, 'publishing needs confirm: true');
  const employee = { id: 'u', role: 'employee', active: true };
  const names = (u, scopes = [READ, WRITE], has = () => true) => visibleTools(TOOLS, u, { has, scopes, settings: {} }).map((x) => x.name);
  assert.ok(!names(employee).includes('create_shift'));
  assert.ok(!names(employee, [READ]).includes('request_time_off'), 'read-only connections list no write tools');
  assert.ok(!names(employee, [READ, WRITE], (f) => f !== 'eightySix').includes('get_86_list'), 'plan features hide tools');
});

// ---------- over HTTP ----------

test('discovery: protected resource (RFC 9728), authorization server (RFC 8414), and a 401 that points to them', async () => {
  const app = await startApp({ now });
  try {
    const b = browser({ base: app.base });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await b.get(path);
      assert.equal(r.status, 200);
      assert.equal(r.body.resource, `${app.base}/mcp`);
      assert.deepEqual(r.body.authorization_servers, [app.base]);
      assert.deepEqual(r.body.scopes_supported, ['shiftboard.read', 'shiftboard.write']);
    }
    const as = (await b.get('/.well-known/oauth-authorization-server')).body;
    assert.equal(as.issuer, app.base);
    assert.equal(as.authorization_endpoint, `${app.base}/oauth/authorize`);
    assert.equal(as.token_endpoint, `${app.base}/oauth/token`);
    assert.equal(as.registration_endpoint, `${app.base}/oauth/register`);
    assert.equal(as.revocation_endpoint, `${app.base}/oauth/revoke`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
    const r = await rpc(b, null, 'tools/list');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), new RegExp(`^Bearer resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`));
    const bad = await rpc(b, 'not-a-token', 'tools/list');
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  } finally { await app.close(); }
});

test('Dynamic Client Registration: only Claude’s callbacks and loopback; rate limited', async () => {
  const app = await startApp({ now, env: { MCP_REGISTER_PER_IP: '7' } });
  try {
    const b = browser({ base: app.base });
    const ok = await b.post('/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] });
    assert.equal(ok.status, 201);
    assert.match(ok.body.client_id, /^sbc1\./);
    assert.equal(ok.body.client_secret, undefined, 'public client');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const local = await b.post('/oauth/register', { client_name: 'Claude Code', redirect_uris: ['http://localhost:51234/callback', 'http://127.0.0.1:51234/callback'] });
    assert.equal(local.status, 201);
    const conf = await b.post('/oauth/register', { redirect_uris: ['https://claude.com/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' });
    assert.match(conf.body.client_secret, /^sbs_/);
    for (const redirect_uris of [['https://evil.example/callback'], [CLAUDE_CALLBACK, 'https://evil.example/cb'], ['http://localhost:3000/other']]) {
      const r = await b.post('/oauth/register', { redirect_uris });
      assert.equal(r.status, 400, JSON.stringify(redirect_uris));
      assert.equal(r.body.error, 'invalid_redirect_uri');
    }
    assert.equal((await b.post('/oauth/register', { redirect_uris: [CLAUDE_CALLBACK], grant_types: ['client_credentials'] })).body.error, 'invalid_client_metadata');
    const limited = await b.post('/oauth/register', { redirect_uris: [CLAUDE_CALLBACK] });
    assert.equal(limited.status, 429, 'the 8th registration from one address in an hour');
  } finally { await app.close(); }
});

test('authorize → sign in (with the second step) → consent → code → token → refresh rotation → revoke', async () => {
  const app = await startApp({ now });
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    const b = browser({ base: app.base });
    const client = await register(b);
    const { verifier, challenge } = pkcePair();
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256' };

    // Requests that can't go back to the app get a page; the rest go back with an error.
    assert.equal((await authorize(b, { ...base, client_id: 'sbc1.nope.nope' })).status, 400);
    assert.equal((await authorize(b, { ...base, redirect_uri: 'https://evil.example/cb' })).status, 400);
    const noPkce = await authorize(b, { ...base, code_challenge: undefined });
    assert.match(noPkce.location, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request/);
    assert.match(noPkce.location, /state=st-1/);
    assert.match((await authorize(b, { ...base, code_challenge_method: 'plain' })).location, /error=invalid_request/);
    assert.match((await authorize(b, { ...base, state: undefined })).location, /error=invalid_request/);
    assert.match((await authorize(b, { ...base, scope: 'admin' })).location, /error=invalid_scope/);
    assert.match((await authorize(b, { ...base, resource: 'https://other.example/mcp' })).location, /error=invalid_target/);

    const a = await authorize(b, { ...base, resource: `${app.base}/mcp` });
    assert.equal(a.status, 302);
    assert.ok(a.r, 'sent to the app’s connect page');
    // Not signed in: the page shows ShiftBoard's sign-in; deciding is refused.
    const before = await b.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`);
    assert.equal(before.body.result.person, null);
    assert.equal(before.body.result.client.name, 'Claude');
    assert.equal((await b.post('/api/oauth/decide', { r: a.r, allow: true })).status, 401);
    // Password + the second step, like every sign-in.
    const first = await b.post('/api/auth/login', { email: 'kelly@demo.shiftboard', password: 'demo1234' });
    assert.ok(first.body.mfa, 'a second step is required');
    assert.equal((await b.post('/api/oauth/decide', { r: a.r, allow: true })).status, 401, 'the password alone is not enough');
    const s = await signIn((p, body) => b.post(p, body), 'kelly@demo.shiftboard');
    assert.equal(s.status, 200);
    let info = (await b.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`)).body.result;
    if (info.person.needsTerms) { await b.post('/api/rpc/consent.accept', { terms: true }); info = (await b.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`)).body.result; }
    assert.equal(info.person.name, 'Kelly');
    assert.equal(info.person.fresh, true);
    assert.ok(info.capabilities.some((c) => c.key === 'publish' && c.write), 'managers see the manager lines');
    // Another site can't decide for them; a tampered request is refused.
    assert.equal((await b.post('/api/oauth/decide', { r: a.r, allow: true }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await b.post('/api/oauth/decide', { r: `${a.r}x`, allow: true })).status, 400);
    const d = await b.post('/api/oauth/decide', { r: a.r, allow: true });
    assert.equal(d.status, 200);
    const back = new URL(d.body.result.redirect);
    assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
    assert.equal(back.searchParams.get('state'), 'st-1');
    assert.equal(back.searchParams.get('iss'), app.base);
    const code = back.searchParams.get('code');
    assert.match(code, /^sbac_/);

    const exchange = (extra = {}) => b.send('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, ...extra } });
    assert.equal((await b.send('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK, client_id: 'sbc1.x.y' } })).body.error, 'invalid_client');
    const tok = await exchange();
    assert.equal(tok.status, 200, tok.text);
    assert.equal(tok.body.token_type, 'Bearer');
    assert.equal(tok.body.expires_in, 3600);
    assert.equal(tok.body.scope, 'shiftboard.read shiftboard.write');
    assert.match(tok.body.refresh_token, /^sbr_/);
    assert.equal(tok.headers.get('cache-control'), 'no-store');

    // Stored hashed only.
    const { rows } = await app.db.query(`SELECT data::text AS t FROM shiftboard.docs WHERE col = 'mcpGrants'`);
    const stored = rows.map((r) => r.t).join('\n');
    for (const secret of [code, tok.body.refresh_token, tok.body.access_token]) assert.ok(!stored.includes(secret), 'no plain token in the database');
    assert.ok(stored.includes(T.sha256(tok.body.refresh_token)));

    // The code works once; using it again ends what it gave out.
    const again = await exchange();
    assert.equal(again.body.error, 'invalid_grant');
    assert.equal((await rpc(b, tok.body.access_token, 'tools/list')).status, 401, 'a reused code revokes the connection');

    // Refresh tokens rotate. Presenting the old one right after (two refreshes racing) only fails; later, it means the
    // old one leaked, and the whole connection ends.
    const c2 = await connect(b, 'kelly@demo.shiftboard', { client, skipSignIn: true });
    const r1 = await refresh(b, client, c2.tokens.refresh_token);
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(r1.body.refresh_token, c2.tokens.refresh_token, 'rotated');
    assert.equal((await rpc(b, r1.body.access_token, 'tools/list')).status, 200);
    assert.equal((await refresh(b, client, c2.tokens.refresh_token)).body.error, 'invalid_grant', 'the old refresh token is spent');
    const r2 = await refresh(b, client, r1.body.refresh_token);
    assert.equal(r2.status, 200, 'a race doesn’t end the connection');
    assert.equal((await refresh(b, { client_id: (await register(b)).client_id }, r2.body.refresh_token)).body.error, 'invalid_grant', 'bound to its client');
    assert.equal((await refresh(b, client, r2.body.refresh_token, { scope: 'shiftboard.read' })).body.scope, 'shiftboard.read', 'narrower scope on request');
    clock.offset = 60_000;
    assert.equal((await refresh(b, client, r1.body.refresh_token)).body.error, 'invalid_grant');
    assert.equal((await rpc(b, r2.body.access_token, 'tools/list')).status, 401, 'reuse of a rotated refresh token ends the connection');
    clock.offset = 0;

    // Revocation (RFC 7009): always 200; the connection ends.
    const c3 = await connect(b, 'kelly@demo.shiftboard', { client, skipSignIn: true });
    assert.equal((await rpc(b, c3.tokens.access_token, 'tools/list')).status, 200);
    const rev = await b.send('POST', '/oauth/revoke', { form: { token: c3.tokens.refresh_token, client_id: client.client_id } });
    assert.equal(rev.status, 200);
    assert.equal((await rpc(b, c3.tokens.access_token, 'tools/list')).status, 401);
    assert.equal((await refresh(b, client, c3.tokens.refresh_token)).body.error, 'invalid_grant');
    assert.equal((await b.send('POST', '/oauth/revoke', { form: { token: 'whatever', client_id: client.client_id } })).status, 200);
    const audit = app.db.store.list('auditLog', (x) => x.via === 'claude').map((x) => x.action);
    for (const act of ['claude.authorized', 'claude.connected', 'claude.revoked']) assert.ok(audit.includes(act), act);
  } finally {
    Object.assign(console, orig);
    await app.close();
  }
  for (const line of logged) assert.ok(!/sb(ac|r)_[A-Za-z0-9_-]{20}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(line), `no token in the logs: ${line.slice(0, 80)}`);
});

test('the consent decision: a fresh sign-in, Deny, codes expire in 5 minutes, PKCE and redirect_uri must match, loopback clients', async () => {
  const app = await startApp({ now });
  try {
    const b = browser({ base: app.base });
    const client = await register(b);
    const { verifier, challenge } = pkcePair();
    const start = () => authorize(b, { response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    let a = await start();
    await signIn((p, body) => b.post(p, body), 'alexd@demo.shiftboard');
    await b.post('/api/rpc/consent.accept', { terms: true });
    // Deny goes back with access_denied.
    const no = await b.post('/api/oauth/decide', { r: a.r, allow: false });
    assert.equal(new URL(no.body.result.redirect).searchParams.get('error'), 'access_denied');
    // A sign-in from over 10 minutes ago isn't enough to connect: sign in again.
    clock.offset = 11 * 60_000;
    a = await start();
    assert.equal((await b.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`)).body.result.person.fresh, false);
    assert.equal((await b.post('/api/oauth/decide', { r: a.r, allow: true })).body.code, 'signIn');
    clock.offset = 0;
    // A wrong verifier, a wrong redirect_uri, an expired code: invalid_grant, and the code is spent.
    const codeFor = async () => { const x = await start(); const d = await b.post('/api/oauth/decide', { r: x.r, allow: true }); return new URL(d.body.result.redirect).searchParams.get('code'); };
    const tokenWith = (code, extra) => b.send('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id, ...extra } });
    let code = await codeFor();
    assert.equal((await tokenWith(code, { code_verifier: pkcePair().verifier })).body.error, 'invalid_grant');
    assert.equal((await tokenWith(code)).body.error, 'invalid_grant', 'spent by the failed try');
    code = await codeFor();
    assert.equal((await tokenWith(code, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).body.error, 'invalid_grant');
    code = await codeFor();
    clock.offset = 5 * 60_000 + 2000;
    assert.equal((await tokenWith(code)).body.error, 'invalid_grant', 'expired after 5 minutes');
    clock.offset = 0;
    assert.equal((await b.send('POST', '/oauth/token', { form: { grant_type: 'password', client_id: client.client_id } })).body.error, 'unsupported_grant_type');
    // Claude Code: a loopback client on any port, shown as a local app with a warning.
    const local = await register(b, ['http://localhost:4321/callback'], { client_name: 'Claude Code' });
    const x = await authorize(b, { response_type: 'code', client_id: local.client_id, redirect_uri: 'http://localhost:60001/callback', state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    const info = (await b.get(`/api/oauth/request?r=${encodeURIComponent(x.r)}`)).body.result;
    assert.equal(info.client.kind, 'loopback');
    assert.equal(info.client.redirectHost, 'localhost:60001');
    const c = await connect(b, 'alexd@demo.shiftboard', { client: local, redirectUri: 'http://localhost:60001/callback', skipSignIn: true });
    assert.ok(c.tokens.access_token);
  } finally { clock.offset = 0; await app.close(); }
});

test('connections end with the person’s sessionVersion (password change), deactivation, or Disconnect in Connected apps', async () => {
  const app = await startApp({ now });
  try {
    const b = browser({ base: app.base });
    const c = await connect(b, 'alexd@demo.shiftboard');
    assert.equal((await rpc(b, c.tokens.access_token, 'tools/list')).status, 200);
    const list = await b.get('/api/mcp/connections');
    assert.equal(list.body.result.connections.length, 1);
    assert.equal(list.body.result.connections[0].name, 'Claude');
    assert.ok(list.body.result.connections[0].connectedAt && list.body.result.connections[0].lastUsedAt);
    // Connecting Claude again replaces the earlier connection (Claude registers a new client each time).
    const again = await connect(b, 'alexd@demo.shiftboard', { skipSignIn: true });
    assert.equal((await b.get('/api/mcp/connections')).body.result.connections.length, 1);
    assert.equal((await rpc(b, c.tokens.access_token, 'tools/list')).status, 401, 'the old one ended');
    Object.assign(c, again);
    // A password change signs out everywhere, Claude included.
    assert.equal((await b.post('/api/rpc/employees.changePassword', { password: 'a-brand-new-passphrase' })).status, 200);
    const gone = await rpc(b, c.tokens.access_token, 'tools/list');
    assert.equal(gone.status, 401);
    assert.match(gone.body.error.message, /connection has ended/);
    assert.equal((await refresh(b, c.client, c.tokens.refresh_token)).body.error, 'invalid_grant');

    // Deactivated: the connection stops.
    const k = browser({ base: app.base });
    const kc = await connect(k, 'kelly@demo.shiftboard');
    const kelly = app.db.store.list('users', (u) => u.email === 'kelly@demo.shiftboard')[0];
    await app.db.run((s) => s.update('users', kelly.id, { active: false }), { write: true });
    assert.equal((await rpc(k, kc.tokens.access_token, 'tools/list')).status, 401);
    await app.db.run((s) => s.update('users', kelly.id, { active: true }), { write: true });

    // Disconnect in My settings → Connected apps.
    const mgr = browser({ base: app.base });
    const m = await connect(mgr, 'moe@demo.shiftboard');
    const id = (await mgr.get('/api/mcp/connections')).body.result.connections[0].id;
    assert.equal((await k.post(`/api/mcp/connections/${id}/revoke`, {})).status, 404, 'only your own');
    assert.equal((await mgr.post(`/api/mcp/connections/${id}/revoke`, {})).status, 200);
    assert.equal((await rpc(mgr, m.tokens.access_token, 'tools/list')).status, 401);
    assert.deepEqual((await mgr.get('/api/mcp/connections')).body.result.connections, []);
  } finally { await app.close(); }
});

test('the MCP server through the SDK client: tools per role, calls end to end, notifications and the audit log as usual', async () => {
  const app = await startApp({ now });
  try {
    const eb = browser({ base: app.base });
    const emp = await connect(eb, 'alexd@demo.shiftboard');
    const staff = await mcpClient(app.base, emp.tokens.access_token);
    const empTools = (await staff.listTools()).tools;
    const names = empTools.map((t) => t.name);
    for (const n of ['whoami', 'get_my_shifts', 'get_schedule', 'request_time_off', 'report_86_item', 'search_menu', 'get_events', 'get_my_tips']) assert.ok(names.includes(n), n);
    for (const n of ['create_shift', 'publish_week', 'get_team', 'get_forecast', 'get_pending_approvals', 'approve_request', 'save_event', 'get_86_history']) assert.ok(!names.includes(n), `employees don’t get ${n}`);
    const ann = empTools.find((t) => t.name === 'get_schedule').annotations;
    assert.equal(ann.readOnlyHint, true);
    assert.equal(empTools.find((t) => t.name === 'cancel_request').annotations.destructiveHint, true);

    const who = await staff.callTool({ name: 'whoami', arguments: {} });
    assert.match(textOf(who), /Alex D \(Employee\)/);
    const sched = await staff.callTool({ name: 'get_schedule', arguments: { week: '2026-09-28' } });
    assert.ok(!sched.isError);
    const data = JSON.parse(textOf(sched).split('\n\n')[1]);
    assert.ok(data.shifts.length > 20 && data.shifts.every((s) => !s.draft), 'the published schedule, never drafts');

    const off = await staff.callTool({ name: 'request_time_off', arguments: { startDate: '2099-01-15', reason: 'Family trip' } });
    assert.ok(!off.isError, textOf(off));
    assert.match(textOf(off), /pending/);
    const t = app.db.store.list('timeOff', (x) => x.startDate === '2099-01-15')[0];
    assert.ok(t, 'saved through timeOff.create');
    const managersTold = app.db.store.list('notifications', (n) => n.link === '#/timeoff' && /Alex D/.test(n.text));
    assert.ok(managersTold.length > 0, 'managers were notified, as in the app');
    const entry = app.db.store.list('auditLog', (a) => a.action === 'claude.request_time_off')[0];
    assert.equal(entry.via, 'claude');
    assert.equal(entry.client, 'Claude');
    assert.deepEqual(entry.details.methods, ['timeOff.create']);

    const r86 = await staff.callTool({ name: 'report_86_item', arguments: { item: 'Burrata & Stone Fruit', status: 'out' } });
    assert.ok(!r86.isError, textOf(r86));
    assert.ok(app.db.store.list('eightySixItems', (i) => i.name === 'Burrata & Stone Fruit' && i.status === 'out').length);
    const back = await staff.callTool({ name: 'mark_back_in_stock', arguments: { item: 'burrata & stone fruit' } });
    assert.ok(!back.isError, textOf(back));

    // A manager's tool isn't there for staff.
    const nope = await rpc(eb, emp.tokens.access_token, 'tools/call', { name: 'publish_week', arguments: { week: 'this week', confirm: true } });
    assert.ok(nope.body.error || nope.body.result?.isError);

    // Managers: drafts, and publishing only with confirm: true.
    const mb = browser({ base: app.base });
    const mgr = await mcpClient(app.base, (await connect(mb, 'kelly@demo.shiftboard')).tokens.access_token);
    const mgrNames = (await mgr.listTools()).tools.map((x) => x.name);
    for (const n of ['create_shift', 'update_shift', 'delete_shift', 'publish_week', 'get_pending_approvals', 'get_team', 'get_forecast', 'save_event']) assert.ok(mgrNames.includes(n), n);
    const add = await mgr.callTool({ name: 'create_shift', arguments: { date: '2099-03-03', start: '16:00', position: 'Server', person: 'Alex D', room: 'Restaurant' } });
    assert.ok(!add.isError, textOf(add));
    const shift = app.db.store.list('shifts', (s) => s.date === '2099-03-03')[0];
    assert.equal(shift.published, false, 'a draft');
    const pub = await mgr.callTool({ name: 'publish_week', arguments: { week: '2099-03-03' } });
    assert.equal(pub.isError, true);
    assert.match(textOf(pub), /confirm: true/);
    assert.equal(app.db.store.get('shifts', shift.id).published, false, 'nothing published without confirm');
    const ok = await mgr.callTool({ name: 'publish_week', arguments: { week: '2099-03-03', confirm: true } });
    assert.ok(!ok.isError, textOf(ok));
    assert.equal(app.db.store.get('shifts', shift.id).published, true);
    // A published shift: changing it needs confirm too (it notifies the person).
    const upd = await mgr.callTool({ name: 'update_shift', arguments: { shiftId: shift.id, start: '17:00' } });
    assert.equal(upd.isError, true);
    assert.ok(!(await mgr.callTool({ name: 'update_shift', arguments: { shiftId: shift.id, start: '17:00', confirm: true } })).isError);
    assert.equal(app.db.store.get('shifts', shift.id).start, '17:00');
    // Approvals go through timeOff.decide.
    const pending = JSON.parse(textOf(await mgr.callTool({ name: 'get_pending_approvals', arguments: {} })).split('\n\n')[1]);
    const mine = pending.timeOff.find((x) => x.from === '2099-01-15');
    assert.ok(mine);
    assert.ok(!(await mgr.callTool({ name: 'approve_request', arguments: { timeOffId: mine.id } })).isError);
    assert.equal(app.db.store.get('timeOff', t.id).status, 'approved');
    const team = JSON.parse(textOf(await mgr.callTool({ name: 'get_team', arguments: { query: 'alex' } })).split('\n\n')[1]);
    assert.ok(team.people.length >= 1 && !('passwordHash' in team.people[0]));
    await staff.close(); await mgr.close();
  } finally { await app.close(); }
});

test('scopes: read-only connections list no write tools and can’t change anything; admins can make staff read-only or turn it off', async () => {
  const app = await startApp({ now });
  try {
    const b = browser({ base: app.base });
    const ro = await connect(b, 'alexd@demo.shiftboard', { readOnly: true });
    assert.equal(ro.tokens.scope, 'shiftboard.read');
    const c = await mcpClient(app.base, ro.tokens.access_token);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('get_schedule'));
    assert.ok(!names.includes('request_time_off') && !names.includes('report_86_item'));
    const call = await rpc(b, ro.tokens.access_token, 'tools/call', { name: 'request_time_off', arguments: { startDate: '2099-02-02' } });
    assert.ok(call.body.error || call.body.result?.isError, 'refused');
    assert.equal(app.db.store.list('timeOff', (x) => x.startDate === '2099-02-02').length, 0);
    const ro2 = await connect(b, 'alexd@demo.shiftboard', { scope: 'shiftboard.read', skipSignIn: true });
    assert.equal(ro2.tokens.scope, 'shiftboard.read', 'asked for read-only at authorize');
    assert.equal((await refresh(b, ro2.client, ro2.tokens.refresh_token, { scope: 'shiftboard.write' })).body.error, 'invalid_scope', 'refresh can’t widen');

    const admin = browser({ base: app.base });
    await signIn((p, body) => admin.post(p, body), 'moe@demo.shiftboard');
    assert.equal((await b.post('/api/mcp/settings', { staffReadOnly: true })).status, 403, 'admins only');
    const set = await admin.post('/api/mcp/settings', { staffReadOnly: true });
    assert.equal(set.body.result.staffReadOnly, true);
    assert.equal(set.body.result.url, `${app.base}/mcp`);
    const forced = await connect(b, 'alexd@demo.shiftboard', { skipSignIn: true });
    assert.equal(forced.tokens.scope, 'shiftboard.read', 'staff get read-only');
    const mgr = await connect(browser({ base: app.base }), 'kelly@demo.shiftboard');
    assert.equal(mgr.tokens.scope, 'shiftboard.read shiftboard.write', 'managers can still make changes');
    await admin.post('/api/mcp/settings', { enabled: false });
    const offRpc = await rpc(b, mgr.tokens.access_token, 'tools/list');
    assert.equal(offRpc.status, 403);
    assert.match(offRpc.body.error.message, /turned off/);
    assert.equal((await b.get('/.well-known/oauth-authorization-server')).status, 403);
    await admin.post('/api/mcp/settings', { enabled: true });
    assert.equal((await rpc(b, mgr.tokens.access_token, 'tools/list')).status, 200, 'back on: connections work again');
    assert.ok(app.db.store.list('auditLog', (a) => a.action === 'claude.settings').length >= 3);
    await c.close();
  } finally { await app.close(); }
});

test('errors in Spanish for Spanish speakers', async () => {
  const app = await startApp({ now });
  try {
    const b = browser({ base: app.base });
    const c = await connect(b, 'alexd@demo.shiftboard');
    await b.post('/api/rpc/account.preferences', { language: 'es' });
    const client = await mcpClient(app.base, c.tokens.access_token);
    const bad = await client.callTool({ name: 'get_schedule', arguments: { date: 'someday' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Usa una fecha como/);
    await b.post('/api/rpc/employees.changePassword', { password: 'otra-frase-bastante-larga' });
    const r = await rpc(b, c.tokens.access_token, 'tools/list');
    assert.match(r.body.error.message, /Tu conexión con ShiftBoard terminó/);
    await client.close();
  } finally { await app.close(); }
});

test('plan gating (the mcp feature, and tools by feature) and rate limits per connection', async () => {
  const starter = { id: 't1', slug: 'x', name: 'X', isDefault: true, status: 'active', plan: 'starter', features: { training: true, tips: true, eightySix: true, mcp: false } };
  let app = await startApp({ now, tenant: starter });
  try {
    const b = browser({ base: app.base });
    assert.equal((await b.get('/.well-known/oauth-protected-resource')).status, 404);
    assert.equal((await b.post('/oauth/register', { redirect_uris: [CLAUDE_CALLBACK] })).status, 404);
    assert.equal((await rpc(b, 'x', 'tools/list')).status, 404);
    assert.equal((await b.get('/oauth/authorize?client_id=x')).status, 400);
  } finally { await app.close(); }
  const pro = { ...starter, plan: 'pro', features: { training: true, tips: true, eightySix: false, events: false, forecast: true, mcp: true } };
  app = await startApp({ now, tenant: pro, env: { MCP_CALLS_PER_TOKEN: '3' } });
  try {
    const b = browser({ base: app.base });
    const c = await connect(b, 'alexd@demo.shiftboard');
    const client = await mcpClient(app.base, c.tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('get_86_list') && !names.includes('get_events'), 'features outside the plan aren’t listed');
    assert.ok(names.includes('get_my_tips'));
    for (let i = 0; i < 3; i++) assert.ok(!(await client.callTool({ name: 'whoami', arguments: {} })).isError);
    const r = await rpc(b, c.tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} });
    assert.equal(r.status, 429);
    assert.match(r.body.error.message, /Too many requests/);
    assert.equal((await rpc(b, c.tokens.access_token, 'tools/list')).status, 200, 'listing isn’t counted');
    await client.close();
  } finally { await app.close(); }
});
