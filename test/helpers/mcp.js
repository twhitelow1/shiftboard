// The Claude connector's OAuth flow for tests, the way Claude does it: register (DCR), /oauth/authorize, sign in on
// the restaurant's page (password + the second step), Allow on the consent screen, then the code for tokens with PKCE.
// send(method, path, { body, form, headers }) → { status, headers, body, text } talks to one host and keeps cookies.
import crypto from 'node:crypto';
import { signIn } from './signin.js';
import { request } from './hosts.js';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** A cookie-keeping client for a base URL (fetch) or, with port + host, for one Host header on a local server. */
export function browser({ base, port, host }) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (list) => {
    for (const c of list) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      if (!value || attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a))) jar.delete(name); else jar.set(name, value);
    }
  };
  async function send(method, path, { body, form, headers = {} } = {}) {
    const h = { ...(jar.size ? { Cookie: cookie() } : {}), ...headers };
    let data;
    if (form) { data = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { data = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    if (port) {
      const r = await request(port, { host, method, path, headers: { ...h, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, body: data });
      keep([].concat(r.headers['set-cookie'] || []));
      return { status: r.status, headers: { get: (k) => r.headers[k.toLowerCase()] ?? null }, body: r.body, text: r.text };
    }
    const res = await fetch(base + path, { method, headers: h, body: data, redirect: 'manual' });
    keep(res.headers.getSetCookie?.() || []);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body: json, text };
  }
  return { send, get: (p, o) => send('GET', p, o), post: (p, body, o = {}) => send('POST', p, { ...o, body }), cookie, jar };
}

export async function register(b, redirectUris = [CLAUDE_CALLBACK], extra = {}) {
  const r = await b.post('/oauth/register', { client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra });
  if (r.status !== 201) throw new Error(`register: ${r.status} ${r.text}`);
  return r.body;
}

/** GET /oauth/authorize; returns { status, location, r } (r: the signed request the consent page gets). */
export async function authorize(b, params) {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
  const r = await b.get(`/oauth/authorize?${q}`);
  const location = r.headers.get('location');
  return { status: r.status, location, text: r.text, r: location && location.startsWith('/#/authorize?r=') ? decodeURIComponent(location.split('r=')[1]) : null };
}

/**
 * The whole flow for one person. Returns { client, tokens, code, redirect, b } (b: the browser, signed in).
 * opts: { readOnly, redirectUri, signedIn (a browser already signed in), scope, resource, password, realm }
 */
export async function connect(b, email, opts = {}) {
  const redirectUri = opts.redirectUri || CLAUDE_CALLBACK;
  const client = opts.client || await register(b, [redirectUri]);
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(8).toString('hex');
  const a = await authorize(b, { response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: opts.scope, resource: opts.resource });
  if (!a.r) throw new Error(`authorize: ${a.status} ${a.location || a.text}`);
  if (!opts.skipSignIn) {
    const s = await signIn((path, body) => b.post(path, body), email, opts.password || 'demo1234', { realm: opts.realm || '' });
    if (s.status !== 200) throw new Error(`sign in ${email}: ${s.status} ${s.text || JSON.stringify(s.body)}`);
  }
  let info = await b.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`);
  if (info.body?.result?.person?.needsTerms) { // people from before consent records agree to the terms first (the page shows that screen)
    await b.post('/api/rpc/consent.accept', { terms: true });
    info = await b.get(`/api/oauth/request?r=${encodeURIComponent(a.r)}`);
  }
  const d =await b.post('/api/oauth/decide', { r: a.r, allow: true, readOnly: !!opts.readOnly });
  if (d.status !== 200) throw new Error(`decide: ${d.status} ${d.text}`);
  const redirect = new URL(d.body.result.redirect);
  if (redirect.searchParams.get('state') !== state) throw new Error('state not returned');
  const code = redirect.searchParams.get('code');
  const t = await b.send('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id } });
  if (t.status !== 200) throw new Error(`token: ${t.status} ${t.text}`);
  return { client, tokens: t.body, code, verifier, redirect, info: info.body?.result, b, redirectUri };
}

export const refresh = (b, client, refreshToken, extra = {}) => b.send('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id, ...extra } });

/** A raw JSON-RPC call to /mcp (no SDK), for the error paths. */
export function rpc(b, token, method, params = {}, id = 1) {
  return b.send('POST', '/mcp', { body: { jsonrpc: '2.0', id, method, params }, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' } });
}
