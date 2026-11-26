// OpenTable API client (read-only). UNVERIFIED: OpenTable's partner API reference (docs.opentable.com, the
// Partner Portal at dev.opentable.com) is only open to approved partners, so the paths and answer shapes
// below follow what's public: OAuth 2.0 client credentials and a bearer token, HTTPS only, "Sync API"
// feeds for reservations and guests, and a separate Reviews API a restaurant grants to a partner. Every
// guess is in one place (DEFAULTS and PATHS) so it can be corrected from the real reference in minutes,
// and the answers are read tolerantly (core/opentable.js readApiReservation / readApiReview).
// Credentials come from env only (the platform swaps in each restaurant's own, server/platform/tenant-env.js):
//   OPENTABLE_CLIENT_ID, OPENTABLE_CLIENT_SECRET   the partner application's OAuth client
//   OPENTABLE_RID                                  the restaurant's OpenTable restaurant ID
//   OPENTABLE_API_HOST (optional)                  default https://platform.opentable.com
//   OPENTABLE_TOKEN_URL (optional)                 default https://oauth.opentable.com/api/v2/oauth/token
//
// Auth: POST the token URL with grant_type=client_credentials and HTTP Basic (client ID:secret); the token
// is cached in memory until shortly before it expires, and a 401 gets one fresh token.
// Requests: GET {host}{path}?rid=…&updated_after=…&offset=…&limit=…, Accept: application/json, and an
// X-Request-Id on each (OpenTable asks partners for one). Rate limits are set per partner in the contract:
// 429 is retried after Retry-After, 5xx twice, and requests are spaced (minGapMs).
import crypto from 'node:crypto';

export const DEFAULTS = { host: 'https://platform.opentable.com', tokenUrl: 'https://oauth.opentable.com/api/v2/oauth/token' };
export const PATHS = { reservations: '/sync/v2/reservations', reviews: '/sync/v2/reviews' }; // UNVERIFIED
export const NEEDED = ['OPENTABLE_CLIENT_ID', 'OPENTABLE_CLIENT_SECRET', 'OPENTABLE_RID'];
export const PAGE_SIZE = 200;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRY_WAIT_MS = 10_000;

export class OpenTableError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const val = (env, k) => String(env[k] || '').trim();
const clean = (v, d) => String(v || d).trim().replace(/\/+$/, '');

/** Which settings are present (names only, never values). */
export function opentableConfig(env = process.env) {
  const missing = NEEDED.filter((k) => !val(env, k));
  return {
    configured: !missing.length, missing, present: NEEDED.filter((k) => val(env, k)),
    host: clean(env.OPENTABLE_API_HOST, DEFAULTS.host), tokenUrl: clean(env.OPENTABLE_TOKEN_URL, DEFAULTS.tokenUrl),
    rid: val(env, 'OPENTABLE_RID'), cron: !!val(env, 'CRON_SECRET'),
  };
}

/** A list answer's rows: { items }, { reservations }, { reviews }, { results }, { data } or a bare array. */
export function rowsOf(data, key) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ['items', key, 'results', 'data', 'records']) if (k && Array.isArray(data[k])) return data[k];
  return [];
}
/** True when a page says there's more: hasNextPage / has_more / a next link, else a full page. */
export function hasMore(data, rows, limit) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of ['hasNextPage', 'has_next_page', 'has_more', 'hasMore']) if (typeof data[k] === 'boolean') return data[k];
    for (const k of ['nextPageUrl', 'next_page_url', 'next']) if (k in data) return !!data[k];
  }
  return rows.length >= limit;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = new Map();
export const _tokenCache = tokens; // tests

/**
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {Function} [opts.fetch]  defaults to the global fetch (looked up per call, so tests can swap it)
 */
export function createOpenTableClient({ env = process.env, fetch, now = () => Date.now(), sleep = wait, timeoutMs = 12_000, minGapMs = 120, pageSize = PAGE_SIZE } = {}) {
  const cfg = opentableConfig(env);
  const doFetch = (...a) => (fetch || globalThis.fetch)(...a);
  const id = val(env, 'OPENTABLE_CLIENT_ID');
  const secret = val(env, 'OPENTABLE_CLIENT_SECRET');
  const key = `${cfg.tokenUrl}|${id}`;
  let lastAt = 0;
  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  const reach = (e) => (e.name === 'TimeoutError' ? 'timed out' : e.message);

  async function login() {
    let res;
    try {
      res = await doFetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        signal: signal(),
      });
    } catch (e) {
      throw new OpenTableError(`Couldn't reach OpenTable at ${new URL(cfg.tokenUrl).host} (${reach(e)})`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new OpenTableError('OpenTable didn’t accept the client ID and secret. Check them, and that OpenTable approved the application.', res.status);
    if (res.status === 429) throw new OpenTableError('OpenTable is limiting requests right now. Try again in a minute.', 429);
    if (!res.ok) throw new OpenTableError(`OpenTable sign-in failed (${res.status})`, res.status);
    if (!body?.access_token) throw new OpenTableError('OpenTable sign-in returned no token');
    const secs = Number(body.expires_in);
    return { accessToken: body.access_token, expiresAt: now() + (secs > 0 ? secs : 3600) * 1000 };
  }

  async function token({ fresh = false } = {}) {
    const cur = tokens.get(key);
    if (!fresh && cur?.accessToken && cur.expiresAt - EXPIRY_MARGIN_MS > now()) return cur.accessToken;
    if (!fresh && cur?.pending) return (await cur.pending).accessToken;
    const pending = login();
    tokens.set(key, { pending });
    try { const t = await pending; tokens.set(key, t); return t.accessToken; } catch (e) { tokens.delete(key); throw e; }
  }

  function urlFor(path, query = {}) {
    const url = new URL(`${cfg.host}${path}`);
    url.searchParams.set('rid', cfg.rid);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    return url.toString();
  }

  /** GET a path. Returns the body; null for a 404 when { allow404: true }. Retries 401 once (fresh token), 429, 5xx. */
  async function get(path, query, { allow404 = false } = {}) {
    if (!cfg.configured) throw new OpenTableError(`OpenTable isn’t set up. Missing: ${cfg.missing.join(', ')}`);
    const url = urlFor(path, query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const gap = lastAt + minGapMs - now();
      if (minGapMs && gap > 0) await sleep(gap);
      lastAt = now();
      const auth = `Bearer ${await token({ fresh: refreshed && attempt === 0 })}`;
      let res;
      try {
        res = await doFetch(url, { headers: { Authorization: auth, Accept: 'application/json', 'X-Request-Id': crypto.randomUUID() }, signal: signal() });
      } catch (e) {
        if (attempt < 2) { await sleep(500); continue; }
        throw new OpenTableError(`Couldn't reach OpenTable (${reach(e)})`);
      }
      if (res.status === 401 && !refreshed) { refreshed = true; tokens.delete(key); attempt = -1; continue; }
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
        if (body === null && text.trim().startsWith('<')) throw new OpenTableError('OpenTable answered with a web page instead of data. Check the API host.', res.status);
        return body;
      }
      if (res.status === 404 && allow404) return null;
      const msg = String(body?.error_description || body?.error || body?.message || '').slice(0, 200);
      if (res.status === 401) throw new OpenTableError('OpenTable rejected the credentials. Check the client ID and secret.', 401);
      if (res.status === 403) throw new OpenTableError(`OpenTable says this application can’t read ${path.split('/').filter(Boolean).at(-1)} for this restaurant. The restaurant grants access in OpenTable (Integrations → API partners).`, 403);
      if (res.status === 404) throw new OpenTableError(`OpenTable couldn't find ${path}${msg ? `: ${msg}` : ''}`, 404);
      if (res.status === 429) throw new OpenTableError('OpenTable is limiting requests right now. Try again in a minute.', 429);
      throw new OpenTableError(`OpenTable answered ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    }
  }

  /** One page of a feed: { rows, more }. since: ISO date-time (changes after it). */
  async function page(path, key2, { since, offset = 0 } = {}) {
    const data = await get(path, { updated_after: since, offset, limit: pageSize });
    const rows = rowsOf(data, key2);
    return { rows, more: rows.length > 0 && hasMore(data, rows, pageSize) };
  }

  return {
    config: cfg, token, get, urlFor, pageSize,
    /** Reservations changed since `since` (Sync API). UNVERIFIED path and parameters. */
    reservations: (opts) => page(PATHS.reservations, 'reservations', opts),
    /** Reviews posted or changed since `since` (Reviews API, a separate grant). UNVERIFIED path and parameters. */
    reviews: (opts) => page(PATHS.reviews, 'reviews', opts),
  };
}
