// The Claude connector: a remote MCP server for one restaurant, with its own OAuth 2.1 authorization server, so
// people add ShiftBoard to Claude (claude.ai, Desktop, the phone apps, Claude Code) and Claude acts as them, with
// exactly their permissions. docs/integrations/CLAUDE-MCP.md has the setup, the tools and the security notes.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: this restaurant's /mcp and its authorization server
//   GET  /.well-known/oauth-authorization-server        RFC 8414
//   POST /oauth/register                                RFC 7591, stateless (tokens.js): Claude's callbacks and loopback only
//   GET  /oauth/authorize                               code + PKCE S256 + state → the app's sign-in and consent (#/authorize)
//   POST /oauth/token                                   authorization_code, refresh_token (rotating, reuse detected)
//   POST /oauth/revoke                                  RFC 7009
//   POST /mcp                                           Streamable HTTP, stateless (a new server per request: Vercel-friendly)
//   GET  /api/oauth/request, POST /api/oauth/decide     the consent screen (signed in on the web, freshly)
//   GET  /api/mcp/connections, POST …/:id/revoke        My settings → Connected apps
//   GET/POST /api/mcp/settings                          Settings → Claude connector (admins)
//
// The restaurant comes from the host like everything else (server/platform/): a token is bound to this
// restaurant's schema (its signing keys), its id (t) and this host's /mcp (aud), and checked against the
// connection stored in this restaurant's own data.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { canChangeSettings, roleLabel } from '../../core/roles.js';
import { consentState } from '../../core/consent.js';
import { langOf, isLang } from '../../core/i18n.js';
import { createService } from '../../core/service.js';
import { uid } from '../../core/store.js';
import { TOOLS, visibleTools, runTool, createToolContext, READ, WRITE } from '../tools/index.js';
import * as T from './tokens.js';
import * as G from './grants.js';
import { say, errorPage } from './messages.js';

const CAPABILITY_ORDER = ['read', 'menu', 'tips', 'team', 'reports', 'timeOff', 'availability', 'trades', 'eightySix', 'drafts', 'publish', 'approve', 'events'];

/**
 * @param app  the restaurant's Express app (server/app.js)
 * @param d    { db, env, tenant, now, has(feature), paused, secret(), session(store, token), sessionToken(req), ready(),
 *              serviceOpts(req), onCommit(changes, req) }
 */
export function mountMcp(app, d) {
  const { db, env, tenant, now } = d;
  const keys = T.createKeys(d.secret, db.schema);
  const nowSec = () => Math.floor(now() / 1000);
  const iso = (ms = now()) => new Date(ms).toISOString();
  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const resourceOf = (req) => `${origin(req)}/mcp`;
  const metadataUrl = (req) => `${origin(req)}/.well-known/oauth-protected-resource/mcp`;
  const limit = (name, fallback) => Number(env[name]) > 0 ? Number(env[name]) : fallback;
  const LIMITS = {
    register: [limit('MCP_REGISTER_PER_IP', 20), 60], registerAll: [limit('MCP_REGISTER_PER_RESTAURANT', 200), 60],
    token: [limit('MCP_TOKEN_PER_CLIENT', 60), 15], tokenAll: [limit('MCP_TOKEN_PER_RESTAURANT', 1200), 15],
    calls: [limit('MCP_CALLS_PER_TOKEN', 60), 1], callsAll: [limit('MCP_CALLS_PER_RESTAURANT', 600), 1],
  };

  /** Why the connector can't be used on this restaurant right now ('notInPlan', 'paused', 'turnedOff') or null. */
  const blocked = () => (!d.has('mcp') ? 'notInPlan' : d.paused ? 'paused' : !G.configOf(db.store).enabled ? 'turnedOff' : null);
  const restaurantName = () => createService(db.store).settings().restaurantName;
  const langOfUser = (u) => langOf(u, createService(db.store).settings());
  const requestLang = (req) => (/^es\b/i.test(String(req.get('accept-language') || '')) ? 'es' : 'en');

  // Shared rate limits (every instance counts the same rows; keys are hashed).
  async function overLimit(kind, id) {
    const [max, minutes] = LIMITS[kind];
    const key = T.sha256(`mcp|${kind}|${db.schema}|${id}`);
    if ((await db.countAttempts(key, minutes)) >= max) return true;
    await db.recordAttempt(key);
    return false;
  }

  const audit = (s, actorId, action, details = {}) => s.insert('auditLog', { id: uid('aud'), at: iso(), actorId, targetId: actorId, action, via: 'claude', ...details, details });

  // The public endpoints answer any origin (bearer tokens, no cookies); the consent and settings APIs don't.
  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  const booted = async (req, res, next) => {
    try { await d.ready(); await db.sync(); next(); } catch (e) {
      console.error('ShiftBoard could not reach its database:', e.message);
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'The database is not reachable right now. Try again in a minute.' });
    }
  };
  const noStore = (res) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const oauthError = (res, status, error, description) => { noStore(res); return res.status(status).json({ error, ...(description ? { error_description: description } : {}) }); };
  const available = (req, res, next) => {
    const why = blocked();
    if (!why) return next();
    if (why === 'notInPlan') return res.status(404).json({ error: 'not_found', error_description: say('notInPlan') });
    return res.status(403).json({ error: 'access_denied', error_description: say(why) });
  };
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  // ---------- discovery ----------
  const protectedResource = (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({
      resource: resourceOf(req), authorization_servers: [origin(req)], scopes_supported: T.ALL_SCOPES, bearer_methods_supported: ['header'],
      resource_name: `ShiftBoard · ${restaurantName()}`, resource_documentation: `${origin(req)}/#/settings`,
    });
  };
  app.options(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], cors);
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], cors, booted, available, protectedResource);
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], cors, booted, available, (req, res) => {
    const o = origin(req);
    res.set('Cache-Control', 'public, max-age=300').json({
      issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`, scopes_supported: T.ALL_SCOPES, response_types_supported: ['code'], response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true, service_documentation: `${o}/#/settings`,
    });
  });

  // ---------- Dynamic Client Registration (RFC 7591) ----------
  app.options('/oauth/register', cors);
  app.post('/oauth/register', cors, booted, available, async (req, res) => {
    if (await overLimit('register', req.ip) || await overLimit('registerAll', 'all')) return oauthError(res, 429, 'slow_down', 'Too many registrations. Try again later.');
    const check = T.checkRegistration(req.body);
    if (check.error) return oauthError(res, 400, check.error, check.description);
    const { clientId, secret } = T.issueClient(keys, check.metadata, nowSec());
    noStore(res).status(201).json({
      client_id: clientId, client_id_issued_at: nowSec(), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      ...check.metadata, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: T.ALL_SCOPES.join(' '),
    });
  });

  // ---------- authorize: check the request, then the app's own sign-in and consent screen ----------
  app.get('/oauth/authorize', booted, async (req, res) => {
    const q = req.query;
    const page = (key) => res.status(400).type('html').set('Cache-Control', 'no-store').send(errorPage(key));
    const why = blocked();
    if (why) return page(why);
    const client = T.readClient(keys, q.client_id);
    if (!client) return page('badClient');
    const redirectUri = String(q.redirect_uri || '');
    if (!T.redirectMatches(client.redirectUris, redirectUri)) return page('badRedirect');
    // From here on, problems go back to the app (RFC 6749 §4.1.2.1).
    const back = (error, description) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      if (description) u.searchParams.set('error_description', description);
      if (typeof q.state === 'string' && q.state) u.searchParams.set('state', q.state);
      u.searchParams.set('iss', origin(req));
      return res.redirect(302, u.toString());
    };
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (typeof q.state !== 'string' || !q.state || q.state.length > 1000) return back('invalid_request', 'state is required');
    if (q.code_challenge_method !== 'S256' || !T.validChallenge(q.code_challenge)) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    const scope = T.parseScope(q.scope);
    if (scope.error) return back('invalid_scope', scope.error);
    if (q.resource !== undefined && ![resourceOf(req), `${resourceOf(req)}/`].includes(String(q.resource))) return back('invalid_target', 'resource must be this restaurant’s /mcp');
    const r = T.signRequest(keys, { c: client.clientId, ru: redirectUri, st: q.state, cc: q.code_challenge, sc: scope.scopes, res: resourceOf(req), o: origin(req), ...(tenant ? { t: tenant.id } : {}) }, nowSec());
    res.set('Cache-Control', 'no-store').redirect(302, `/#/authorize?r=${encodeURIComponent(r)}`);
  });

  // The signed-in person on the web, if they signed in recently enough to grant access (never a support session).
  function webPerson(req) {
    const s = d.session(db.store, d.sessionToken(req));
    if (!s) return { user: null };
    const fresh = !s.claims.sup && Number(s.claims.iat) >= nowSec() - T.FRESH_SIGN_IN_SEC;
    return { user: s.user, claims: s.claims, fresh, support: !!s.claims.sup };
  }
  function readAuthRequest(req, r) {
    const c = T.readRequest(keys, r, nowSec());
    if (!c || c.o !== origin(req) || (tenant && c.t !== tenant.id) || (!tenant && c.t)) return null;
    const client = T.readClient(keys, c.c);
    if (!client || !T.redirectMatches(client.redirectUris, c.ru)) return null;
    return { ...c, client };
  }
  /** What the consent screen lists: the tools this person would get, grouped into lines, each marked read or change. */
  function capabilities(user) {
    const tools = visibleTools(TOOLS, user, { has: d.has, scopes: [READ, WRITE], settings: createService(db.store).settings() });
    const by = new Map();
    for (const t of tools) by.set(t.consent, (by.get(t.consent) ?? true) && t.write);
    return CAPABILITY_ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, write: by.get(k) }));
  }

  app.get('/api/oauth/request', async (req, res) => {
    await db.sync();
    const why = blocked();
    if (why) return res.status(403).json({ error: say(why, requestLang(req)), code: why });
    const ar = readAuthRequest(req, req.query.r);
    if (!ar) return res.status(400).json({ error: 'This connection request expired. Start again from Claude.', code: 'expired' });
    const label = T.clientLabel(ar.client);
    const me = webPerson(req);
    const u = me.user;
    const forced = u ? G.forcedReadOnly(db.store, u) : false;
    res.set('Cache-Control', 'no-store').json({ result: {
      client: { name: label.name, kind: label.kind, host: label.host, redirectHost: new URL(ar.ru).host },
      restaurant: restaurantName(), scopes: ar.sc, expiresAt: new Date(ar.exp * 1000).toISOString(),
      person: u ? { name: u.name, role: roleLabel(u, langOfUser(u)), fresh: me.fresh, support: me.support, needsTerms: !consentState(db.store, u).terms, language: isLang(u.language) ? u.language : '' } : null,
      capabilities: u ? capabilities(u) : [], readOnlyForced: forced, canWrite: ar.sc.includes(T.SCOPES.write) && !forced,
    } });
  });

  app.post('/api/oauth/decide', async (req, res) => {
    await db.sync();
    const o = req.get('origin');
    if (o && o !== origin(req)) return res.status(403).json({ error: 'Not allowed from another site', code: 'origin' });
    const why = blocked();
    if (why) return res.status(403).json({ error: say(why, requestLang(req)), code: why });
    const ar = readAuthRequest(req, req.body?.r);
    if (!ar) return res.status(400).json({ error: 'This connection request expired. Start again from Claude.', code: 'expired' });
    const me = webPerson(req);
    if (!me.user) return res.status(401).json({ error: 'Please sign in', code: 'signIn' });
    if (me.support) return res.status(403).json({ error: 'Not available while DubLow Digital is signed in for support', code: 'support' });
    if (!me.fresh) return res.status(401).json({ error: 'Sign in again to connect', code: 'signIn' });
    if (!consentState(db.store, me.user).terms) return res.status(403).json({ error: 'Open ShiftBoard and finish setting up your account first', code: 'needsTerms' });
    const redirect = new URL(ar.ru);
    redirect.searchParams.set('iss', origin(req));
    const label = T.clientLabel(ar.client);
    if (req.body?.allow !== true) {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('state', ar.st);
      await db.run((s) => audit(s, me.user.id, 'claude.denied', { client: label.name }), { write: true });
      return res.json({ result: { redirect: redirect.toString() } });
    }
    const readOnly = req.body?.readOnly === true || G.forcedReadOnly(db.store, me.user) || !ar.sc.includes(T.SCOPES.write);
    const scope = readOnly ? [T.SCOPES.read] : [...T.ALL_SCOPES];
    const code = T.randomToken('sbac_');
    await db.run((s) => {
      G.prune(s, now());
      const u = s.get('users', me.user.id);
      G.createPending(s, { user: u, client: ar.client, label, redirectUri: ar.ru, scope, resource: ar.res, codeHash: T.sha256(code), codeExpiresAt: iso(now() + T.CODE_TTL_SEC * 1000), codeChallenge: ar.cc, at: iso() });
      audit(s, u.id, 'claude.authorized', { client: label.name, scope: scope.join(' ') });
    }, { write: true });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', ar.st);
    res.set('Cache-Control', 'no-store').json({ result: { redirect: redirect.toString() } });
  });

  // ---------- token ----------
  function clientFromRequest(req) {
    let id = req.body?.client_id;
    let secret = req.body?.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (basic) {
      const [a, b] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      id = decodeURIComponent(a || '');
      secret = decodeURIComponent(b || '');
    }
    const client = T.readClient(keys, id);
    if (!client || !T.clientSecretOk(keys, client, secret)) return null;
    return client;
  }
  function issue(req, grant, scope) {
    const access = T.signAccess(keys, { sub: grant.userId, g: grant.id, v: grant.v || 0, scope, t: tenant?.id, iss: origin(req), aud: grant.resource || resourceOf(req) }, nowSec());
    return { access_token: access, token_type: 'Bearer', expires_in: T.ACCESS_TTL_SEC, scope: scope.join(' ') };
  }

  app.options(['/oauth/token', '/oauth/revoke'], cors);
  app.post('/oauth/token', cors, form, booted, available, async (req, res) => {
    const b = req.body || {};
    const client = clientFromRequest(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client, or a wrong client secret');
    if (await overLimit('token', client.clientId) || await overLimit('tokenAll', 'all')) return oauthError(res, 429, 'slow_down', 'Too many requests. Try again in a few minutes.');
    if (b.resource !== undefined && ![resourceOf(req), `${resourceOf(req)}/`].includes(String(b.resource))) return oauthError(res, 400, 'invalid_target', 'resource must be this restaurant’s /mcp');
    const at = iso();

    if (b.grant_type === 'authorization_code') {
      if (typeof b.code !== 'string' || typeof b.code_verifier !== 'string' || typeof b.redirect_uri !== 'string') return oauthError(res, 400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
      const hash = T.sha256(b.code);
      const refresh = T.randomToken('sbr_');
      const out = await db.run((s) => {
        const g = G.findByCode(s, hash);
        if (!g) return { error: 'The authorization code is not valid' };
        if (g.codeUsedAt || g.status !== 'pending') {
          // A code used twice: whatever it gave out is revoked (RFC 6749 §4.1.2).
          if (g.status === 'active') { G.revoke(s, g, 'code reused', at); audit(s, g.userId, 'claude.revoked', { client: g.clientName, reason: 'code reused' }); }
          return { error: 'The authorization code was already used' };
        }
        const fail = (why) => { s.update(G.GRANTS, g.id, { status: 'failed', codeUsedAt: at }); return { error: why }; };
        if (g.codeExpiresAt < at) return fail('The authorization code expired');
        if (!T.safeEqual(g.clientId, client.clientId)) return fail('The authorization code was issued to another client');
        if (!T.safeEqual(g.redirectUri, b.redirect_uri)) return fail('redirect_uri doesn’t match');
        if (!T.pkceOk(b.code_verifier, g.codeChallenge)) return fail('PKCE verification failed');
        const u = s.get('users', g.userId);
        if (!u || u.active === false || (u.sessionVersion || 0) !== (g.v || 0)) return fail('The person signed out since');
        const done = G.activate(s, g, { refreshHash: T.sha256(refresh), refreshExpiresAt: iso(now() + T.REFRESH_TTL_DAYS * 86400_000), at });
        audit(s, u.id, 'claude.connected', { client: g.clientName, scope: g.scope.join(' ') });
        return { grant: done };
      }, { write: true });
      if (out.error) return oauthError(res, 400, 'invalid_grant', out.error);
      return noStore(res).json({ ...issue(req, out.grant, out.grant.scope), refresh_token: refresh });
    }

    if (b.grant_type === 'refresh_token') {
      if (typeof b.refresh_token !== 'string') return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
      const asked = b.scope ? T.parseScope(b.scope) : null;
      if (asked?.error) return oauthError(res, 400, 'invalid_scope', asked.error);
      const hash = T.sha256(b.refresh_token);
      const refresh = T.randomToken('sbr_');
      const out = await db.run((s) => {
        const g = G.findByRefresh(s, hash);
        if (!g) {
          // A rotated refresh token used again: someone else may hold it. End the connection (unless two refreshes just
          // raced: the one that lost gets invalid_grant and nothing else happens).
          const old = G.findByOldRefresh(s, hash);
          if (old && old.status === 'active' && T.safeEqual(old.clientId, client.clientId) && Date.parse(at) - Date.parse(old.rotatedAt || 0) > 30_000) {
            G.revoke(s, old, 'refresh token reused', at);
            audit(s, old.userId, 'claude.revoked', { client: old.clientName, reason: 'refresh token reused' });
          }
          return { error: 'The refresh token is not valid' };
        }
        if (!T.safeEqual(g.clientId, client.clientId)) return { error: 'The refresh token was issued to another client' };
        const problem = G.grantProblem(s, g, at);
        if (problem) {
          if (problem !== 'revoked') G.revoke(s, g, problem, at);
          return { error: 'The connection has ended. Connect ShiftBoard again.' };
        }
        if (asked && asked.scopes.some((x) => !g.scope.includes(x))) return { error: 'scope', status: 'invalid_scope' };
        return { grant: G.rotate(s, g, { refreshHash: T.sha256(refresh), refreshExpiresAt: iso(now() + T.REFRESH_TTL_DAYS * 86400_000), at }) };
      }, { write: true });
      if (out.status === 'invalid_scope') return oauthError(res, 400, 'invalid_scope', 'More scope than the connection has');
      if (out.error) return oauthError(res, 400, 'invalid_grant', out.error);
      const scope = asked ? asked.scopes : out.grant.scope;
      return noStore(res).json({ ...issue(req, out.grant, scope), refresh_token: refresh });
    }
    return oauthError(res, 400, 'unsupported_grant_type', 'authorization_code or refresh_token');
  });

  // RFC 7009: always 200; a refresh token or an access token ends the whole connection.
  app.post('/oauth/revoke', cors, form, booted, async (req, res) => {
    const client = clientFromRequest(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client, or a wrong client secret');
    const token = String(req.body?.token || '');
    let grantId = null;
    if (T.looksLikeJwt(token)) grantId = T.readAccess(keys, token, { iss: origin(req), aud: resourceOf(req), nowSec: nowSec() })?.g || null;
    await db.run((s) => {
      const g = grantId ? s.get(G.GRANTS, grantId) : G.findByRefresh(s, T.sha256(token)) || G.findByOldRefresh(s, T.sha256(token));
      if (g && g.status === 'active' && T.safeEqual(g.clientId, client.clientId)) {
        G.revoke(s, g, 'revoked by the app', iso());
        audit(s, g.userId, 'claude.revoked', { client: g.clientName, reason: 'revoked by the app' });
      }
    }, { write: true });
    noStore(res).status(200).json({});
  });

  // ---------- My settings → Connected apps, and Settings → Claude connector ----------
  const signedIn = (req, res) => {
    const s = d.session(db.store, d.sessionToken(req));
    if (!s) { res.status(401).json({ error: 'Please sign in' }); return null; }
    return s;
  };
  app.get('/api/mcp/connections', async (req, res) => {
    await db.sync();
    const s = signedIn(req, res);
    if (!s) return;
    res.json({ result: { available: d.has('mcp'), connections: G.connectionsOf(db.store, s.user.id, iso()) } });
  });
  app.post('/api/mcp/connections/:id/revoke', async (req, res) => {
    await db.sync();
    const s = signedIn(req, res);
    if (!s) return;
    if (s.claims.sup) return res.status(403).json({ error: 'Not available while DubLow Digital is signed in for support' });
    const ok = await db.run((st) => {
      const g = st.get(G.GRANTS, req.params.id);
      if (!g || g.userId !== s.user.id || g.status !== 'active') return false;
      G.revoke(st, g, 'revoked by the person', iso());
      audit(st, s.user.id, 'claude.revoked', { client: g.clientName, reason: 'revoked by the person' });
      return true;
    }, { write: true });
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ result: { connections: G.connectionsOf(db.store, s.user.id, iso()) } });
  });
  app.get('/api/mcp/settings', async (req, res) => {
    await db.sync();
    const s = signedIn(req, res);
    if (!s) return;
    if (!canChangeSettings(s.user)) return res.status(403).json({ error: 'Admins only' });
    res.json({ result: { available: d.has('mcp'), ...G.configOf(db.store), url: resourceOf(req), connections: G.activeCount(db.store, iso()) } });
  });
  app.post('/api/mcp/settings', async (req, res) => {
    await db.sync();
    const s = signedIn(req, res);
    if (!s) return;
    if (!canChangeSettings(s.user)) return res.status(403).json({ error: 'Admins only' });
    if (!d.has('mcp')) return res.status(403).json({ error: 'Not included in your plan' });
    const cfg = await db.run((st) => {
      const out = G.saveConfig(st, req.body || {}, s.user.id, iso());
      audit(st, s.user.id, 'claude.settings', { enabled: out.enabled, staffReadOnly: out.staffReadOnly, ...(s.claims.sup ? { support: s.claims.sup.by } : {}) });
      return out;
    }, { write: true });
    res.json({ result: { available: true, ...cfg, url: resourceOf(req), connections: G.activeCount(db.store, iso()) } });
  });

  // ---------- the MCP endpoint ----------
  const rpcError = (res, status, message, headers = {}) => res.status(status).set(headers).json({ jsonrpc: '2.0', error: { code: status === 401 ? -32001 : -32000, message }, id: null });
  const challenge = (req, extra = '') => `Bearer resource_metadata="${metadataUrl(req)}", scope="${T.ALL_SCOPES.join(' ')}"${extra}`;

  /** The connection behind a bearer token, or a reason it can't be used. */
  async function authenticate(req) {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(req.get('authorization') || '');
    if (!m) return { status: 401, key: 'noToken' };
    const c = T.readAccess(keys, m[1], { iss: origin(req), aud: resourceOf(req), nowSec: nowSec() });
    if (!c || (tenant ? c.t !== tenant.id : !!c.t)) return { status: 401, key: 'signInAgain', invalid: true };
    const g = db.store.get(G.GRANTS, c.g);
    const problem = G.grantProblem(db.store, g, iso());
    if (problem || g.userId !== c.sub || (g.v || 0) !== (c.v || 0)) return { status: 401, key: 'signInAgain', invalid: true, user: db.store.get('users', c.sub) };
    const user = db.store.get('users', g.userId);
    const scopes = c.scopes.filter((x) => g.scope.includes(x));
    return { grant: g, user, scopes, lang: langOfUser(user) };
  }

  const handleMcp = async (req, res) => {
    const auth = await authenticate(req);
    if (!auth.grant) {
      const lang = auth.user ? langOfUser(auth.user) : requestLang(req);
      return rpcError(res, 401, say(auth.key, lang), { 'WWW-Authenticate': challenge(req, auth.invalid ? ', error="invalid_token"' : '') });
    }
    const why = blocked();
    if (why) return rpcError(res, 403, say(why, auth.lang));
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless (POST only).' }, id: null });

    const messages = [].concat(req.body || []);
    if (messages.some((m) => m?.method === 'tools/call')) {
      if (await overLimit('calls', auth.grant.id) || await overLimit('callsAll', 'all')) return rpcError(res, 429, say('rateLimited', auth.lang), { 'Retry-After': '60' });
    }
    // Last used, for Connected apps (written at most every 10 minutes).
    if (now() - Date.parse(auth.grant.lastUsedAt || 0) > 10 * 60_000) {
      await db.run((s) => { const g = s.get(G.GRANTS, auth.grant.id); if (g) s.update(G.GRANTS, g.id, { lastUsedAt: iso() }); }, { write: true }).catch((e) => console.error('lastUsedAt:', e.message));
    }

    const ctx = createToolContext({
      db, userId: auth.user.id, v: auth.grant.v || 0, has: d.has, scopes: auth.scopes, now, via: 'claude', client: auth.grant.clientName,
      serviceOpts: d.serviceOpts(req), onCommit: (changes) => d.onCommit(changes, req),
    });
    const settings = createService(db.store).settings();
    const tools = visibleTools(TOOLS, auth.user, { has: d.has, scopes: auth.scopes, settings });
    const server = new McpServer({ name: 'shiftboard', title: `ShiftBoard · ${settings.restaurantName}`, version: '1.0.0' }, {
      instructions: `ShiftBoard is ${settings.restaurantName}'s staff schedule app. You act as ${auth.user.name} (${roleLabel(auth.user)}), with exactly their permissions. `
        + 'Call whoami first for today\'s date in the restaurant\'s time zone. Dates are YYYY-MM-DD. Before anything that notifies people or publishes '
        + '(publish_week, changing or deleting a published shift), tell the user what will happen and ask; then pass confirm: true. '
        + `${auth.scopes.includes(WRITE) ? '' : 'This connection is read-only: no changes. '}Reply in the user's language.`,
    });
    for (const tool of tools) {
      server.registerTool(tool.name, {
        title: tool.title, description: tool.description, inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: !tool.write, destructiveHint: tool.write ? !!tool.destructive : false, idempotentHint: !!tool.idempotent, openWorldHint: false },
      }, async (args) => {
        const r = await runTool(tool, args, ctx);
        if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.error }] };
        return { content: [{ type: 'text', text: `${r.summary}\n\n${JSON.stringify(r.data)}` }] };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP request failed:', e.message);
      if (!res.headersSent) rpcError(res, 500, say('failed', auth.lang));
    }
  };
  app.options('/mcp', cors);
  app.all('/mcp', cors, booted, async (req, res) => {
    if (!d.has('mcp')) return rpcError(res, 404, say('notInPlan', requestLang(req)));
    try { await handleMcp(req, res); } catch (e) {
      console.error('MCP request failed:', e.message);
      if (!res.headersSent) rpcError(res, 500, say('failed'));
    }
  });
}
