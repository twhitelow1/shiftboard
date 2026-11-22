// Tripleseat API client (read-only). Credentials come from env only, never the database; every
// setting is read in tripleseatConfig(), so the platform can swap in each restaurant's own values:
//   TRIPLESEAT_CLIENT_ID, TRIPLESEAT_CLIENT_SECRET  an OAuth 2.0 application from Tripleseat Settings → API
//                                                   (what Tripleseat uses now)
//   TRIPLESEAT_PUBLIC_KEY, TRIPLESEAT_SECRET_KEY    the old OAuth 1.0a key pair (Tripleseat turned OAuth 1.0
//                                                   off on July 1, 2026; kept for accounts still on it)
//   TRIPLESEAT_SITE_ID (optional)       one site (a group of venues) when the keys see several
//   TRIPLESEAT_LOCATION_ID (optional)   one venue (location): only its events are imported
//   TRIPLESEAT_API_HOST (optional)      default https://api.tripleseat.com
//   TRIPLESEAT_TOKEN_URL (optional)     default {host}/oauth2/token
//   TRIPLESEAT_WEBHOOK_SECRET (optional) the webhook endpoint's signing key (X-Signature)
//
// Auth, OAuth 2.0: POST {host}/oauth2/token with grant_type=client_credentials returns a bearer token
// (expires_in, about 2 hours). It's cached in memory until shortly before it expires and shared by
// every request in this instance; a 401 gets one fresh token.
// Auth, OAuth 1.0a ("two-legged"): every request is signed with HMAC-SHA1 using the public (consumer)
// key and the secret key, with no token (RFC 5849). Tripleseat answers 410 once it no longer takes it.
//
// Requests: GET {host}/v1/<path>.json. Lists are paged with ?page=N (50 per page) and answer
// { results, total_pages } (or a bare array). Limits: 10 requests a second, 1,200 a minute,
// 18,000 an hour; over that Tripleseat answers 429, which is retried after Retry-After. Requests are
// also spaced (minGapMs) so one sync stays under 10 a second.
import crypto from 'node:crypto';

export const DEFAULT_HOST = 'https://api.tripleseat.com';
export const OAUTH2_ENV = ['TRIPLESEAT_CLIENT_ID', 'TRIPLESEAT_CLIENT_SECRET'];
export const OAUTH1_ENV = ['TRIPLESEAT_PUBLIC_KEY', 'TRIPLESEAT_SECRET_KEY'];
export const PAGE_SIZE = 50; // what Tripleseat returns per page
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRY_WAIT_MS = 10_000;

export class TripleseatError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const val = (env, k) => String(env[k] || '').trim();
const clean = (v, d) => String(v || d).trim().replace(/\/+$/, '');

/**
 * Which settings are present (names only; never the values). OAuth 2.0 wins when both pairs are set.
 * missing lists the OAuth 2.0 names when neither pair is complete.
 */
export function tripleseatConfig(env = process.env) {
  const oauth2 = OAUTH2_ENV.every((k) => val(env, k));
  const oauth1 = OAUTH1_ENV.every((k) => val(env, k));
  const auth = oauth2 ? 'oauth2' : oauth1 ? 'oauth1' : null;
  const host = clean(env.TRIPLESEAT_API_HOST, DEFAULT_HOST);
  const present = [...OAUTH2_ENV, ...OAUTH1_ENV].filter((k) => val(env, k));
  return {
    configured: !!auth,
    auth,
    missing: auth ? [] : OAUTH2_ENV.filter((k) => !val(env, k)),
    present,
    host,
    tokenUrl: clean(env.TRIPLESEAT_TOKEN_URL, `${host}/oauth2/token`),
    siteId: val(env, 'TRIPLESEAT_SITE_ID'),
    locationId: val(env, 'TRIPLESEAT_LOCATION_ID'),
    webhookSecret: !!val(env, 'TRIPLESEAT_WEBHOOK_SECRET'),
    cron: !!val(env, 'CRON_SECRET'),
  };
}

// ---------------------------------------------------------------- OAuth 1.0a signing (RFC 5849)

/** RFC 3986 percent-encoding, as OAuth 1.0 wants it (also ! * ' ( )). */
export const oauthEncode = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The OAuth 1.0a Authorization header for one request (HMAC-SHA1). `token`/`tokenSecret` are empty for
 * Tripleseat's two-legged keys. `params` are extra form parameters that are signed too (none for GETs).
 * nonce and timestamp can be passed for tests; otherwise they're random / now.
 */
export function oauth1Header({ method, url, consumerKey, consumerSecret, token = '', tokenSecret = '', params = {}, nonce, timestamp }) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(token ? { oauth_token: token } : {}),
  };
  const pairs = [...u.searchParams.entries(), ...Object.entries(params), ...Object.entries(oauth)]
    .map(([k, v]) => [oauthEncode(k), oauthEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), oauthEncode(`${u.protocol}//${u.host}${u.pathname}`), oauthEncode(pairs.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const key = `${oauthEncode(consumerSecret)}&${oauthEncode(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  const header = Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${oauthEncode(k)}="${oauthEncode(v)}"`).join(', ');
  return { header: `OAuth ${header}`, base, signature };
}

// ---------------------------------------------------------------- helpers for Tripleseat's answers

/** 'YYYY-MM-DD' → 'MM/DD/YYYY' (the format Tripleseat's search parameters take). */
export const toTripleseatDate = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

/** A list answer's rows: { results: [...] }, { events: [...] }, { data: [...] } or a bare array. */
export function rowsOf(data, key) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ['results', key, 'data', 'items']) if (k && Array.isArray(data[k])) return data[k];
  return [];
}
/** One record's answer: { event: {...} } or the record itself. */
export const recordOf = (data, key) => (data && typeof data === 'object' && data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]) ? data[key] : data);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One OAuth 2.0 token per token URL + client, shared by every client created in this instance.
const tokens = new Map();
export const _tokenCache = tokens; // tests

/**
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {Function} [opts.fetch]   defaults to the global fetch (looked up per call, so tests can swap it)
 * @param {Function} [opts.now]     ms clock
 * @param {Function} [opts.sleep]
 * @param {number}   [opts.timeoutMs] per request
 * @param {number}   [opts.minGapMs]  spacing between requests (Tripleseat allows 10 a second)
 * @param {number}   [opts.maxPages]  safety stop for one list
 */
export function createTripleseatClient({ env = process.env, fetch, now = () => Date.now(), sleep = wait, timeoutMs = 12_000, minGapMs = 110, maxPages = 40 } = {}) {
  const cfg = tripleseatConfig(env);
  const doFetch = (...a) => (fetch || globalThis.fetch)(...a);
  const clientId = val(env, 'TRIPLESEAT_CLIENT_ID');
  const clientSecret = val(env, 'TRIPLESEAT_CLIENT_SECRET');
  const publicKey = val(env, 'TRIPLESEAT_PUBLIC_KEY');
  const secretKey = val(env, 'TRIPLESEAT_SECRET_KEY');
  const key = `${cfg.tokenUrl}|${clientId}`;
  let lastAt = 0;

  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  const reach = (e) => (e.name === 'TimeoutError' ? 'timed out' : e.message);

  async function login() {
    let res;
    try {
      res = await doFetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
        signal: signal(),
      });
    } catch (e) {
      throw new TripleseatError(`Couldn't reach Tripleseat at ${cfg.host} (${reach(e)})`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      if (body?.error === 'unsupported_grant_type' || body?.error === 'unauthorized_client') {
        throw new TripleseatError('Tripleseat didn’t allow this application to sign in by itself (client credentials). See docs/integrations/TRIPLESEAT.md.', res.status);
      }
      throw new TripleseatError('Tripleseat didn’t accept the client ID and secret. Check TRIPLESEAT_CLIENT_ID and TRIPLESEAT_CLIENT_SECRET.', res.status);
    }
    if (res.status === 429) throw new TripleseatError('Tripleseat is limiting requests right now. Try again in a minute.', 429);
    if (!res.ok) throw new TripleseatError(`Tripleseat sign-in failed (${res.status})`, res.status);
    if (!body?.access_token) throw new TripleseatError('Tripleseat sign-in returned no token');
    const secs = Number(body.expires_in);
    return { accessToken: body.access_token, expiresAt: now() + (secs > 0 ? secs : 7200) * 1000 };
  }

  /** A valid OAuth 2.0 access token, from the cache when possible. Concurrent callers share one sign-in. */
  async function token({ fresh = false } = {}) {
    const cur = tokens.get(key);
    if (!fresh && cur?.accessToken && cur.expiresAt - EXPIRY_MARGIN_MS > now()) return cur.accessToken;
    if (!fresh && cur?.pending) return (await cur.pending).accessToken;
    const pending = login();
    tokens.set(key, { pending });
    try {
      const t = await pending;
      tokens.set(key, t);
      return t.accessToken;
    } catch (e) {
      tokens.delete(key);
      throw e;
    }
  }

  async function authHeader(url, { fresh = false } = {}) {
    if (cfg.auth === 'oauth1') return oauth1Header({ method: 'GET', url, consumerKey: publicKey, consumerSecret: secretKey }).header;
    return `Bearer ${await token({ fresh })}`;
  }

  /** The /v1 URL for a path ('events/search' → {host}/v1/events/search.json) with the query and site. */
  function urlFor(path, query = {}) {
    const url = new URL(`${cfg.host}/v1/${String(path).replace(/^\/+|\.json$/g, '')}.json`);
    if (cfg.siteId) url.searchParams.set('site_id', cfg.siteId);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    return url.toString();
  }

  /**
   * GET a Tripleseat path. Returns the parsed body, or null for a 404 when { allow404: true }.
   * Retries once after a 401 (fresh token), after 429 (Retry-After), and after 5xx.
   */
  async function get(path, query, { allow404 = false } = {}) {
    if (!cfg.configured) throw new TripleseatError(`Tripleseat isn’t set up. Missing: ${cfg.missing.join(', ')}`);
    const url = urlFor(path, query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const gap = lastAt + minGapMs - now();
      if (minGapMs && gap > 0) await sleep(gap);
      lastAt = now();
      const auth = await authHeader(url, { fresh: refreshed && attempt === 0 });
      let res;
      try {
        res = await doFetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: signal() });
      } catch (e) {
        if (attempt < 2) { await sleep(500); continue; }
        throw new TripleseatError(`Couldn't reach Tripleseat (${reach(e)})`);
      }
      if (res.status === 401 && cfg.auth === 'oauth2' && !refreshed) { refreshed = true; tokens.delete(key); attempt = -1; continue; }
      if (res.status === 429 && attempt < 3) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000, MAX_RETRY_WAIT_MS));
        continue;
      }
      if (res.status >= 500 && attempt < 2) { await sleep(700); continue; }
      const text = await res.text().catch(() => '');
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (res.ok) {
        if (body === null && text.trim().startsWith('<')) throw new TripleseatError('Tripleseat answered with a web page instead of data. Check TRIPLESEAT_API_HOST.', res.status);
        return body;
      }
      if (res.status === 404 && allow404) return null;
      const msg = String(body?.error_description || body?.error || body?.message || '').slice(0, 200);
      if (res.status === 410) throw new TripleseatError('Tripleseat no longer accepts the old API keys (OAuth 1.0). Create an OAuth 2.0 application in Tripleseat (Settings → API) and use its client ID and secret.', 410);
      if (res.status === 401) throw new TripleseatError('Tripleseat rejected the credentials. Check the client ID and secret.', 401);
      if (res.status === 403) throw new TripleseatError(`Tripleseat says these credentials can’t read ${path.split('/')[0]}. Check the application’s permissions in Tripleseat.`, 403);
      if (res.status === 404) throw new TripleseatError(`Tripleseat couldn't find ${path}${msg ? `: ${msg}` : ''}`, 404);
      if (res.status === 429) throw new TripleseatError('Tripleseat is limiting requests right now. Try again in a minute.', 429);
      throw new TripleseatError(`Tripleseat answered ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    }
  }

  /** One page of a list: { rows, page, totalPages|null }. */
  async function page(path, query, n, key) {
    const data = await get(path, { ...query, page: n });
    const rows = rowsOf(data, key);
    const tp = Number(data?.total_pages ?? data?.totalPages ?? data?.meta?.total_pages);
    return { rows, page: n, totalPages: Number.isFinite(tp) && tp > 0 ? tp : null };
  }
  /** True when a page is the last one: total_pages says so, or it came back short or empty. */
  const lastPage = (p) => !p.rows.length || (p.totalPages ? p.page >= p.totalPages : p.rows.length < PAGE_SIZE);

  /** Every page of a list (for small lists: sites, locations, menus). */
  async function all(path, query, key) {
    const out = [];
    let first = null;
    for (let n = 1; n <= maxPages; n++) {
      const p = await page(path, query, n, key);
      // An API that ignores ?page answers page 1 again: that's the end, not more rows.
      if (n > 1 && p.rows.length && first != null && p.rows[0]?.id === first) return out;
      if (n === 1) first = p.rows[0]?.id ?? null;
      out.push(...p.rows);
      if (lastPage(p)) return out;
    }
    throw new TripleseatError(`More than ${maxPages} pages of ${path}; stopped to be safe`);
  }

  return {
    config: cfg,
    token,
    get,
    urlFor,
    lastPage,
    /** GET /v1/sites: the sites (groups of venues) these credentials see. */
    sites: () => all('sites', {}, 'sites'),
    /** GET /v1/locations: the venues, each with its rooms (areas). */
    locations: () => all('locations', {}, 'locations'),
    /** GET /v1/rooms: rooms on their own, for accounts whose locations come without them (404 → []). */
    rooms: async () => rowsOf(await get('rooms', {}, { allow404: true }), 'rooms'),
    /** One page of GET /v1/events/search. params: { from, to, order, direction, locationId }. */
    searchEvents: ({ from, to, order = 'event_start', direction = 'asc', locationId = cfg.locationId } = {}, n = 1) => page('events/search', {
      ...(from ? { event_start_date: toTripleseatDate(from) } : {}),
      ...(to ? { event_end_date: toTripleseatDate(to) } : {}),
      order, sort_direction: direction,
      ...(locationId ? { location_id: locationId } : {}),
    }, n, 'events'),
    /** GET /v1/events/{id}; null when Tripleseat has no such event (deleted). */
    event: async (id) => {
      const data = await get(`events/${encodeURIComponent(id)}`, {}, { allow404: true });
      return data ? recordOf(data, 'event') : null;
    },
    /** GET /v1/events/{id}/menu_item_selections: the menu items picked for the event (read-only). */
    menuSelections: async (id) => rowsOf(await get(`events/${encodeURIComponent(id)}/menu_item_selections`, {}, { allow404: true }), 'menu_item_selections'),
    /** GET /v1/menus: menus with their items (names and categories for the selections). */
    menus: () => all('menus', {}, 'menus'),
  };
}
