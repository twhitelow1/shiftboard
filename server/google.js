// Google Business Profile API client: OAuth 2.0 (web server flow, offline access) and the calls ShiftBoard uses.
// Verified against Google's reference (docs/integrations/GOOGLE-YELP.md has the links and what isn't verified):
//   scope       https://www.googleapis.com/auth/business.manage
//   accounts    GET  https://mybusinessaccountmanagement.googleapis.com/v1/accounts            (pageSize ≤ 20)
//   locations   GET  https://mybusinessbusinessinformation.googleapis.com/v1/{accounts/*}/locations
//                    readMask is required; pageSize ≤ 100
//   reviews     GET  https://mybusiness.googleapis.com/v4/{accounts/*/locations/*}/reviews
//                    pageSize ≤ 50, pageToken, orderBy 'updateTime desc' (the default)
//   reply       PUT  https://mybusiness.googleapis.com/v4/{accounts/*/locations/*/reviews/*}/reply  { comment }
//   delete      DELETE the same /reply
// OAuth: https://accounts.google.com/o/oauth2/v2/auth (access_type=offline, prompt=consent so a refresh token
// comes back), tokens at https://oauth2.googleapis.com/token, revoke at https://oauth2.googleapis.com/revoke.
//
// Platform env (DubLow's one Google OAuth client, Sensitive in Vercel): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Each restaurant's refresh token is in its own store, sealed (server/google-routes.js). Access tokens live in
// memory until shortly before they expire; a 401 gets one fresh token; invalid_grant (revoked, or the password
// changed) means the restaurant connects again. 429 waits Retry-After, 5xx is retried twice.
import crypto from 'node:crypto';

export const SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const URLS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  accounts: 'https://mybusinessaccountmanagement.googleapis.com/v1',
  info: 'https://mybusinessbusinessinformation.googleapis.com/v1',
  v4: 'https://mybusiness.googleapis.com/v4',
};
export const NEEDED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
export const REVIEWS_PAGE = 50;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRY_WAIT_MS = 10_000;

export class GoogleError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const RECONNECT = 'Google stopped accepting ShiftBoard’s access (it was removed in Google, or the account’s password changed). An admin connects Google again in Settings → Integrations.';

const val = (env, k) => String(env[k] || '').trim();
/** Whether the platform's OAuth client is set up (names only, never values). */
export function googleConfig(env = process.env) {
  const missing = NEEDED.filter((k) => !val(env, k));
  return { configured: !missing.length, missing, cron: !!val(env, 'CRON_SECRET') };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = new Map(); // sha256(refresh token) → { accessToken, expiresAt } | { pending }
export const _tokenCache = tokens; // tests

/**
 * @param {object} o
 * @param {object} [o.env]           GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * @param {string} [o.refreshToken]  the restaurant's (not needed for the consent URL or the code exchange)
 * @param {Function} [o.fetch]       defaults to the global fetch (looked up per call, so tests can swap it)
 * @param {object} [o.urls]          Google's endpoints (tests point them at a fake)
 */
export function createGoogleClient({ env = process.env, refreshToken = '', fetch, urls = URLS, now = () => Date.now(), sleep = wait, timeoutMs = 12_000 } = {}) {
  const cfg = googleConfig(env);
  const doFetch = (...a) => (fetch || globalThis.fetch)(...a);
  const clientId = val(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = val(env, 'GOOGLE_CLIENT_SECRET');
  const key = crypto.createHash('sha256').update(`${clientId}|${refreshToken}`).digest('hex');
  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  const reach = (e) => (e.name === 'TimeoutError' ? 'timed out' : e.message);
  const need = () => { if (!cfg.configured) throw new GoogleError(`Google isn’t set up on this server. Missing: ${cfg.missing.join(', ')}`, 400, 'notConfigured'); };

  /** POST the token endpoint (a form). */
  async function tokenCall(form) {
    need();
    let res;
    try {
      res = await doFetch(urls.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }).toString(), signal: signal(),
      });
    } catch (e) { throw new GoogleError(`Couldn’t reach Google (${reach(e)})`); }
    const body = await res.json().catch(() => ({}));
    if (body?.error === 'invalid_grant') throw new GoogleError(RECONNECT, 401, 'invalid_grant');
    if (body?.error === 'invalid_client' || res.status === 401) throw new GoogleError('Google didn’t accept ShiftBoard’s OAuth client. DubLow Digital checks GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 401, 'invalid_client');
    if (res.status === 429) throw new GoogleError('Google is limiting requests right now. Try again in a minute.', 429);
    if (!res.ok || !body?.access_token) throw new GoogleError(`Google sign-in failed (${res.status}${body?.error ? `: ${String(body.error).slice(0, 60)}` : ''})`, res.status || 502);
    return body;
  }

  /** The consent page's address. state: signed by the caller; redirectUri: registered in the OAuth client. */
  function authUrl({ state, redirectUri, loginHint }) {
    need();
    const u = new URL(urls.auth);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('access_type', 'offline'); // a refresh token, for the daily sync
    u.searchParams.set('prompt', 'consent'); // …every time, even if this Google account said yes before
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', state);
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    return u.toString();
  }

  /** The code from the callback → { refreshToken, accessToken, expiresIn, scope }. */
  async function exchangeCode(code, redirectUri) {
    const body = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!body.refresh_token) throw new GoogleError('Google didn’t give ShiftBoard ongoing access. Connect again and allow access.', 400, 'noRefresh');
    if (body.scope && !String(body.scope).split(/\s+/).includes(SCOPE)) throw new GoogleError('Google didn’t grant access to the Business Profile. Connect again and allow “See, edit, create and delete your Google business listings”.', 403, 'scope');
    const secs = Number(body.expires_in);
    tokens.set(crypto.createHash('sha256').update(`${clientId}|${body.refresh_token}`).digest('hex'), { accessToken: body.access_token, expiresAt: now() + (secs > 0 ? secs : 3600) * 1000 });
    return { refreshToken: body.refresh_token, accessToken: body.access_token, expiresIn: secs, scope: body.scope || '' };
  }

  async function accessToken({ fresh = false } = {}) {
    if (!refreshToken) throw new GoogleError('Google isn’t connected for this restaurant', 400, 'notConnected');
    const cur = tokens.get(key);
    if (!fresh && cur?.accessToken && cur.expiresAt - EXPIRY_MARGIN_MS > now()) return cur.accessToken;
    if (!fresh && cur?.pending) return (await cur.pending).accessToken;
    const pending = tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }).then((b) => {
      const secs = Number(b.expires_in);
      return { accessToken: b.access_token, expiresAt: now() + (secs > 0 ? secs : 3600) * 1000 };
    });
    tokens.set(key, { pending });
    try { const t = await pending; tokens.set(key, t); return t.accessToken; } catch (e) { tokens.delete(key); throw e; }
  }

  /** A call to one of the Business Profile APIs. Returns the JSON body ({} for an empty answer). */
  async function call(method, url, { body, allow404 = false } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const auth = `Bearer ${await accessToken({ fresh: refreshed && attempt === 0 })}`;
      let res;
      try {
        res = await doFetch(url, { method, headers: { Authorization: auth, Accept: 'application/json', 'X-GOOG-API-FORMAT-VERSION': '2', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: signal() });
      } catch (e) {
        if (attempt < 2) { await sleep(500); continue; }
        throw new GoogleError(`Couldn’t reach Google (${reach(e)})`);
      }
      if (res.status === 401 && !refreshed) { refreshed = true; tokens.delete(key); attempt = -1; continue; }
      if (res.status === 429 && attempt < 3) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000, MAX_RETRY_WAIT_MS));
        continue;
      }
      if (res.status >= 500 && attempt < 2) { await sleep(700); continue; }
      const textBody = await res.text().catch(() => '');
      let data = null;
      try { data = textBody ? JSON.parse(textBody) : {}; } catch { data = null; }
      if (res.ok) return data || {};
      if (res.status === 404 && allow404) return null;
      const msg = String(data?.error?.message || '').slice(0, 200);
      if (res.status === 401) throw new GoogleError(RECONNECT, 401, 'invalid_grant');
      if (res.status === 403) {
        // 0 QPM until Google approves the project's API access, or the location isn't this account's.
        if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) throw new GoogleError('The Business Profile APIs aren’t enabled for DubLow’s Google Cloud project yet.', 403, 'disabled');
        throw new GoogleError(`Google says this account can’t manage that Business Profile${msg ? `: ${msg}` : ''}`, 403, 'forbidden');
      }
      if (res.status === 429) throw new GoogleError('Google is limiting requests right now. Try again in a minute. (Until Google approves API access, the quota is 0.)', 429, 'quota');
      if (res.status === 404) throw new GoogleError('Google couldn’t find that review or location. It may have been removed.', 404, 'notFound');
      throw new GoogleError(`Google answered ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    }
  }
  const get = (url, q = {}) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    return call('GET', u.toString());
  };

  return {
    config: cfg, authUrl, exchangeCode, accessToken,
    /** Every account this Google user can manage (a few pages at most). */
    async accounts() {
      const out = [];
      let pageToken = '';
      for (let i = 0; i < 10; i++) {
        const d = await get(`${urls.accounts}/accounts`, { pageSize: 20, pageToken });
        out.push(...(Array.isArray(d.accounts) ? d.accounts : []));
        if (!d.nextPageToken) break;
        pageToken = d.nextPageToken;
      }
      return out.map((a) => ({ name: String(a.name || ''), accountName: String(a.accountName || ''), type: String(a.type || '') })).filter((a) => /^accounts\/[^/]+$/.test(a.name));
    },
    /** An account's locations: { name: 'locations/…', title, address }. */
    async locations(account) {
      const out = [];
      let pageToken = '';
      for (let i = 0; i < 10; i++) {
        const d = await get(`${urls.info}/${account}/locations`, { readMask: 'name,title,storefrontAddress,metadata', pageSize: 100, pageToken });
        out.push(...(Array.isArray(d.locations) ? d.locations : []));
        if (!d.nextPageToken) break;
        pageToken = d.nextPageToken;
      }
      return out.map((l) => ({
        name: String(l.name || ''), title: String(l.title || ''),
        address: [...(l.storefrontAddress?.addressLines || []), l.storefrontAddress?.locality].filter(Boolean).join(', '),
        mapsUri: String(l.metadata?.mapsUri || ''),
      })).filter((l) => /^locations\/[^/]+$/.test(l.name));
    },
    /** One page of a location's reviews, newest change first: { reviews, nextPageToken, averageRating, totalReviewCount }. */
    async reviews({ account, location, pageToken = '' }) {
      const d = await get(`${urls.v4}/${account}/${location}/reviews`, { pageSize: REVIEWS_PAGE, pageToken, orderBy: 'updateTime desc' });
      return { reviews: Array.isArray(d.reviews) ? d.reviews : [], nextPageToken: d.nextPageToken || '', averageRating: d.averageRating ?? null, totalReviewCount: d.totalReviewCount ?? null };
    },
    /** Post (or replace) the owner's reply. name: accounts/…/locations/…/reviews/…. Returns Google's ReviewReply. */
    updateReply: (name, comment) => call('PUT', `${urls.v4}/${name}/reply`, { body: { comment } }),
    deleteReply: (name) => call('DELETE', `${urls.v4}/${name}/reply`, { allow404: true }),
    /** Revoke the refresh token at Google (best effort: a token already revoked is fine). */
    async revoke() {
      if (!refreshToken) return false;
      tokens.delete(key);
      try {
        const r = await doFetch(urls.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }).toString(), signal: signal() });
        return r.ok;
      } catch { return false; }
    },
  };
}
