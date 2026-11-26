// The Claude connector's cryptography: everything that is signed, hashed or compared lives here, so it can
// be read (and tested) in one place. Nothing in this file touches the database.
//
//   * Keys: derived from the app's signing secret with HMAC, one per purpose and per restaurant schema, so a
//     token made for one restaurant (or one purpose) never verifies as another, even where JWT_SECRET is shared.
//   * Client IDs (Dynamic Client Registration, RFC 7591): stateless. The client's metadata (its redirect URIs,
//     name and auth method) is signed into the client_id itself, so registering stores nothing and Claude can
//     register as often as it likes. A confidential client's secret is an HMAC of its client_id.
//   * Authorization codes and refresh tokens: random, opaque, stored only as SHA-256 hashes.
//   * Access tokens: short JWTs (HS256, 1 hour) bound to the restaurant, the host (aud), the person, the
//     connection (grant) and the scopes. They are checked against the connection on every request.
//   * PKCE (S256 only) and the redirect URI allowlist.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export const ACCESS_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TTL_DAYS = 30; // each new refresh token lives 30 days from when it's issued
export const CODE_TTL_SEC = 5 * 60; // authorization codes: single use, 5 minutes
export const REQUEST_TTL_SEC = 15 * 60; // a signed authorization request, while the person signs in and decides
export const FRESH_SIGN_IN_SEC = 10 * 60; // connecting needs a sign-in from the last 10 minutes

export const SCOPES = { read: 'shiftboard.read', write: 'shiftboard.write' };
export const ALL_SCOPES = [SCOPES.read, SCOPES.write];
// Asked for by some clients; accepted and ignored (refresh tokens are always issued).
const IGNORED_SCOPES = new Set(['offline_access']);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');

/** Constant-time string equality (false on different lengths, without leaking where they differ). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x); // same work either way
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** A random opaque token with a readable prefix (sbac_ codes, sbr_ refresh tokens). */
export const randomToken = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

/**
 * The keys for one restaurant. secret() is the app's signing secret (JWT_SECRET or the generated one);
 * scope is the restaurant's schema name.
 */
export function createKeys(secret, scope) {
  const cache = new Map();
  const key = (purpose) => {
    const s = secret();
    if (!s) throw new Error('The signing secret isn’t ready yet');
    const k = `${purpose}|${s.length}`;
    if (!cache.has(k)) cache.set(k, crypto.createHmac('sha256', s).update(`shiftboard-mcp:${purpose}:${scope}`).digest());
    return cache.get(k);
  };
  const mac = (purpose, data) => crypto.createHmac('sha256', key(purpose)).update(data).digest();
  return { key, mac };
}

// ---------- redirect URIs ----------
// Claude's hosted apps (claude.ai on the web, Desktop, phone, Cowork) use one fixed callback; Anthropic says it may
// move to claude.com, so both are allowed. Claude Code and other local tools use a loopback redirect on any port.
export const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?\/callback$/;

/** 'claude' (a Claude callback), 'loopback' (localhost/127.0.0.1 /callback, any port) or null (not allowed). */
export function redirectKind(uri) {
  const u = String(uri ?? '');
  if (u.length > 200) return null;
  if (CLAUDE_CALLBACKS.includes(u)) return 'claude';
  const m = LOOPBACK.exec(u);
  if (m && (m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535 && !/^0/.test(m[2])))) return 'loopback';
  return null;
}

/**
 * Does the redirect_uri of a request match one the client registered? Exact string match, except that a
 * loopback URI matches whatever port the app opened this time (RFC 8252 §7.3), same host and path.
 */
export function redirectMatches(registered, requested) {
  if (!redirectKind(requested)) return false;
  for (const r of registered || []) {
    if (safeEqual(r, requested)) return true;
    if (redirectKind(r) === 'loopback' && redirectKind(requested) === 'loopback') {
      const a = LOOPBACK.exec(r), b = LOOPBACK.exec(requested);
      if (a[1] === b[1]) return true;
    }
  }
  return false;
}

// ---------- clients (stateless Dynamic Client Registration) ----------
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Check a registration request (RFC 7591). Returns { metadata } or { error, description }.
 * Only Claude's callbacks and loopback /callback URIs are allowed; only the code flow; PKCE is checked later.
 */
export function checkRegistration(body) {
  const b = body && typeof body === 'object' ? body : {};
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5) return { error: 'invalid_redirect_uri', description: 'redirect_uris must list 1 to 5 URIs' };
  for (const u of uris) {
    if (!redirectKind(u)) {
      return { error: 'invalid_redirect_uri', description: `Not an allowed redirect URI: ${clean(u, 120)}. Allowed: ${CLAUDE_CALLBACKS.join(', ')}, http://localhost:<port>/callback and http://127.0.0.1:<port>/callback` };
    }
  }
  const grants = b.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    return { error: 'invalid_client_metadata', description: 'grant_types: authorization_code and refresh_token only' };
  }
  const types = b.response_types ?? ['code'];
  if (!Array.isArray(types) || types.some((t) => t !== 'code')) return { error: 'invalid_client_metadata', description: 'response_types: code only' };
  const method = b.token_endpoint_auth_method ?? 'none';
  if (!AUTH_METHODS.includes(method)) return { error: 'invalid_client_metadata', description: `token_endpoint_auth_method: one of ${AUTH_METHODS.join(', ')}` };
  return { metadata: { redirect_uris: [...new Set(uris)], client_name: clean(b.client_name, 80), token_endpoint_auth_method: method } };
}

/** Sign a client's metadata into its client_id (and make its secret, for a confidential client). */
export function issueClient(keys, metadata, nowSec) {
  const body = b64u(JSON.stringify({ v: 1, r: metadata.redirect_uris, n: metadata.client_name || '', m: metadata.token_endpoint_auth_method, i: nowSec }));
  const clientId = `sbc1.${body}.${b64u(keys.mac('client', body)).slice(0, 43)}`;
  const secret = metadata.token_endpoint_auth_method === 'none' ? null : clientSecretFor(keys, clientId);
  return { clientId, secret };
}
const clientSecretFor = (keys, clientId) => `sbs_${b64u(keys.mac('client-secret', clientId))}`;

/** A client_id's metadata if its signature checks out (this restaurant made it), else null. */
export function readClient(keys, clientId) {
  const m = /^sbc1\.([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(String(clientId ?? ''));
  if (!m) return null;
  if (!safeEqual(b64u(keys.mac('client', m[1])).slice(0, 43), m[2])) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (p.v !== 1 || !Array.isArray(p.r) || !p.r.every((u) => redirectKind(u)) || !AUTH_METHODS.includes(p.m)) return null;
    return { clientId: clientId, redirectUris: p.r, name: clean(p.n, 80), authMethod: p.m, issuedAt: p.i };
  } catch {
    return null;
  }
}

/** Is this the right secret for a confidential client? Public clients ('none') need none. */
export function clientSecretOk(keys, client, secret) {
  if (client.authMethod === 'none') return true;
  return typeof secret === 'string' && safeEqual(clientSecretFor(keys, client.clientId), secret);
}

/** Who the consent screen and Connected apps say the client is: by its redirect URIs, never only by its own name. */
export function clientLabel(client) {
  const kinds = new Set(client.redirectUris.map(redirectKind));
  if (kinds.has('claude')) return { kind: 'claude', name: 'Claude', host: new URL(client.redirectUris.find((u) => redirectKind(u) === 'claude')).host };
  return { kind: 'loopback', name: client.name || 'Claude Code', host: 'localhost' };
}

// ---------- scopes ----------
/** The scopes asked for: { scopes } (default: read and write) or { error }. */
export function parseScope(scope) {
  const parts = String(scope ?? '').split(/\s+/).filter(Boolean);
  if (!parts.length) return { scopes: [...ALL_SCOPES] };
  const out = new Set();
  for (const p of parts) {
    if (ALL_SCOPES.includes(p)) out.add(p);
    else if (!IGNORED_SCOPES.has(p)) return { error: `Unknown scope: ${clean(p, 60)}` };
  }
  if (out.has(SCOPES.write)) out.add(SCOPES.read); // writing always comes with reading
  return { scopes: out.size ? ALL_SCOPES.filter((s) => out.has(s)) : [...ALL_SCOPES] };
}

// ---------- PKCE (RFC 7636), S256 only ----------
const PKCE_CHARS = /^[A-Za-z0-9\-._~]{43,128}$/;
export const validChallenge = (c) => /^[A-Za-z0-9_-]{43}$/.test(String(c ?? '')); // base64url of a SHA-256
export function pkceOk(verifier, challenge) {
  if (!PKCE_CHARS.test(String(verifier ?? '')) || !validChallenge(challenge)) return false;
  return safeEqual(b64u(crypto.createHash('sha256').update(String(verifier)).digest()), challenge);
}

// ---------- signed authorization requests (between /oauth/authorize and the consent screen) ----------
export function signRequest(keys, req, nowSec) {
  return jwt.sign({ p: 'oauth-req', ...req, iat: nowSec, exp: nowSec + REQUEST_TTL_SEC }, keys.key('request'), { algorithm: 'HS256', noTimestamp: true });
}
export function readRequest(keys, token, nowSec) {
  try {
    const c = jwt.verify(String(token ?? ''), keys.key('request'), { algorithms: ['HS256'], clockTimestamp: nowSec });
    return c.p === 'oauth-req' ? c : null;
  } catch {
    return null;
  }
}

// ---------- access tokens ----------
/**
 * { sub: userId, g: grantId, v: sessionVersion, scope: [..], t?: tenantId } for issuer `iss` and resource `aud`.
 */
export function signAccess(keys, { sub, g, v, scope, t, iss, aud }, nowSec) {
  return jwt.sign({ p: 'mcp', sub, g, v, scope: scope.join(' '), ...(t ? { t } : {}), iss, aud, iat: nowSec, exp: nowSec + ACCESS_TTL_SEC, jti: crypto.randomBytes(9).toString('base64url') },
    keys.key('access'), { algorithm: 'HS256', noTimestamp: true });
}

/** The claims of a valid access token for this issuer and resource, or null. */
export function readAccess(keys, token, { iss, aud, nowSec }) {
  try {
    const c = jwt.verify(String(token ?? ''), keys.key('access'), { algorithms: ['HS256'], issuer: iss, audience: aud, clockTimestamp: nowSec });
    if (c.p !== 'mcp' || typeof c.sub !== 'string' || typeof c.g !== 'string') return null;
    return { ...c, scopes: String(c.scope || '').split(' ').filter((s) => ALL_SCOPES.includes(s)) };
  } catch {
    return null;
  }
}
/** Does this look like one of our access tokens (for revocation, which accepts either kind)? */
export const looksLikeJwt = (t) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(t ?? ''));
