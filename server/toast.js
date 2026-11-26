// Toast POS API client (read-only). Credentials come from env only, never the database:
//   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_RESTAURANT_GUID, TOAST_API_HOST (optional)
//
// Auth: POST {host}/authentication/v1/authentication/login with the client ID and secret and
// userAccessType TOAST_MACHINE_CLIENT returns a bearer token (token.accessToken) valid for
// token.expiresIn seconds (about a day). The login endpoint is rate limited, so the token is
// cached in memory until shortly before it expires and shared by every request in this instance.
// Every data request sends Toast-Restaurant-External-ID: <restaurant GUID>, which also makes
// Toast apply its rate limits per location. 429 answers are retried after Retry-After.
import { toToastDate } from '../core/toast.js';

export const DEFAULT_HOST = 'https://ws-api.toasttab.com';
export const REQUIRED_ENV = ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID'];
const PAGE_SIZE = 100; // the most ordersBulk returns per page
const MAX_PAGES = 100;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export class ToastError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Which settings are present (names only; never the values). */
export function toastConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((k) => !String(env[k] || '').trim());
  return {
    configured: !missing.length,
    missing,
    host: String(env.TOAST_API_HOST || DEFAULT_HOST).trim().replace(/\/+$/, ''),
    restaurantGuid: String(env.TOAST_RESTAURANT_GUID || '').trim(),
    cron: !!String(env.CRON_SECRET || '').trim(),
  };
}

// One token per host + client, shared by every client created in this instance.
const tokens = new Map();
export const _tokenCache = tokens; // tests

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function nextLink(header) {
  // RFC 8288 Link header: <https://...&page=3>; rel="next"
  for (const part of String(header || '').split(',')) {
    if (/;\s*rel="?next"?/i.test(part)) return part.match(/<([^>]+)>/)?.[1] || null;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {Function} [opts.fetch]   defaults to the global fetch (looked up per call, so tests can swap it)
 * @param {Function} [opts.now]     ms clock
 * @param {Function} [opts.sleep]
 * @param {number}   [opts.timeoutMs] per request
 * @param {number}   [opts.minGapMs]  spacing between ordersBulk pages (Toast allows ~5/sec per location)
 */
export function createToastClient({ env = process.env, fetch, now = () => Date.now(), sleep = wait, timeoutMs = 12_000, minGapMs = 220 } = {}) {
  const cfg = toastConfig(env);
  const doFetch = (...a) => (fetch || globalThis.fetch)(...a);
  const clientId = String(env.TOAST_CLIENT_ID || '').trim();
  const clientSecret = String(env.TOAST_CLIENT_SECRET || '').trim();
  const key = `${cfg.host}|${clientId}`;

  function signal() {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  }

  async function login() {
    let res;
    try {
      res = await doFetch(`${cfg.host}/authentication/v1/authentication/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' }),
        signal: signal(),
      });
    } catch (e) {
      throw new ToastError(`Couldn't reach Toast at ${cfg.host} (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new ToastError('Toast didn’t accept the client ID and secret. Check TOAST_CLIENT_ID and TOAST_CLIENT_SECRET.', res.status);
    if (res.status === 429) throw new ToastError('Toast is limiting sign-ins right now. Try again in a few minutes.', 429);
    if (!res.ok) throw new ToastError(`Toast sign-in failed (${res.status})${body?.message ? `: ${body.message}` : ''}`, res.status);
    const t = body?.token || {};
    if (!t.accessToken) throw new ToastError('Toast sign-in returned no token');
    let ms = Number(t.expiresIn) * 1000;
    if (!(ms > 0)) {
      // Fall back to the JWT's own exp claim, else an hour.
      try { ms = JSON.parse(Buffer.from(t.accessToken.split('.')[1], 'base64url').toString()).exp * 1000 - now(); } catch { ms = 0; }
      if (!(ms > 0)) ms = 60 * 60 * 1000;
    }
    return { accessToken: t.accessToken, expiresAt: now() + ms };
  }

  /** A valid access token, from the cache when possible. Concurrent callers share one login. */
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

  /** GET a Toast path. Returns { data, headers }. Retries once after a 401 (fresh token), and after 429/5xx. */
  async function get(pathOrUrl, query) {
    if (!cfg.configured) throw new ToastError(`Toast isn’t set up. Missing: ${cfg.missing.join(', ')}`);
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : cfg.host + pathOrUrl);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const access = await token({ fresh: refreshed && attempt === 1 });
      let res;
      try {
        res = await doFetch(url.toString(), {
          headers: { Authorization: `Bearer ${access}`, 'Toast-Restaurant-External-ID': cfg.restaurantGuid, Accept: 'application/json' },
          signal: signal(),
        });
      } catch (e) {
        if (attempt < 2) { await sleep(500); continue; }
        throw new ToastError(`Couldn't reach Toast (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
      }
      if (res.status === 401 && !refreshed) { refreshed = true; tokens.delete(key); attempt = 0; continue; }
      if (res.status === 429 && attempt < 3) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000, 5000));
        continue;
      }
      if (res.status >= 500 && attempt < 2) { await sleep(700); continue; }
      const body = await res.json().catch(() => null);
      if (res.ok) return { data: body, headers: res.headers };
      const msg = body?.message || body?.error || '';
      if (res.status === 401) throw new ToastError('Toast rejected the access token. Check the client ID and secret.', 401);
      if (res.status === 403) throw new ToastError(`Toast says this API client can’t read ${url.pathname.split('/')[1]} for this restaurant. Check the credential's scopes and locations.`, 403);
      if (res.status === 404) throw new ToastError(`Toast couldn't find ${url.pathname}${msg ? `: ${msg}` : ''}. Check TOAST_RESTAURANT_GUID.`, 404);
      if (res.status === 429) throw new ToastError('Toast is rate limiting requests. Try again in a minute.', 429);
      throw new ToastError(`Toast answered ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    }
  }

  const list = (data) => (Array.isArray(data) ? data : []);

  return {
    config: cfg,
    token,
    get,
    /** GET /restaurants/v1/restaurants/{guid}: general.name, timeZone, closeoutHour (needs restaurants:read). */
    restaurant: async () => (await get(`/restaurants/v1/restaurants/${encodeURIComponent(cfg.restaurantGuid)}`)).data,
    /** GET /labor/v1/employees (labor.employees:read). */
    employees: async () => list((await get('/labor/v1/employees')).data),
    /** GET /labor/v1/jobs (labor:read). */
    jobs: async () => list((await get('/labor/v1/jobs')).data),
    /** GET /labor/v1/timeEntries for one business date (labor:read). */
    timeEntries: async (date) => list((await get('/labor/v1/timeEntries', { businessDate: toToastDate(date) })).data),
    /**
     * The floor plan setup (config:read): GET /config/v2/tables, /config/v2/serviceAreas and /config/v2/revenueCenters,
     * every page (Toast-Next-Page-Token). Toast has no positions, shapes or seat counts, and no API to write any of it
     * (docs/integrations/TOAST-FLOOR-PLAN.md). Venue → Import → From Toast uses this.
     */
    async floorConfig() {
      const all = async (path) => {
        const out = [];
        let pageToken;
        for (let page = 0; page < MAX_PAGES; page++) {
          const { data, headers } = await get(path, pageToken ? { pageToken } : undefined);
          out.push(...list(data));
          pageToken = headers.get('toast-next-page-token');
          if (!pageToken) return out;
        }
        return out;
      };
      const [tables, serviceAreas, revenueCenters] = [await all('/config/v2/tables'), await all('/config/v2/serviceAreas'), await all('/config/v2/revenueCenters').catch(() => [])];
      const ref = (r) => (r?.guid ? { guid: String(r.guid) } : null);
      return {
        tables: tables.filter((t) => t?.guid && t?.name).map((t) => ({ guid: String(t.guid), name: String(t.name).slice(0, 40), serviceArea: ref(t.serviceArea), revenueCenter: ref(t.revenueCenter) })),
        serviceAreas: serviceAreas.filter((a) => a?.guid && a?.name).map((a) => ({ guid: String(a.guid), name: String(a.name).slice(0, 60), revenueCenter: ref(a.revenueCenter), serviceAreaType: a.serviceAreaType || null })),
        revenueCenters: revenueCenters.filter((r) => r?.guid).map((r) => ({ guid: String(r.guid), name: String(r.name || '').slice(0, 60) })),
      };
    },
    /**
     * GET /orders/v2/ordersBulk for one business date, every page (orders:read). Follows the
     * Link rel="next" header; without one, keeps going while pages come back full.
     */
    async orders(date) {
      const out = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1 && minGapMs) await sleep(minGapMs);
        const { data, headers } = await get('/orders/v2/ordersBulk', { businessDate: toToastDate(date), pageSize: PAGE_SIZE, page });
        const rows = list(data);
        out.push(...rows);
        const link = headers.get('link');
        const more = link ? !!nextLink(link) : rows.length === PAGE_SIZE;
        if (!more || !rows.length) return out;
      }
      throw new ToastError(`More than ${MAX_PAGES * PAGE_SIZE} orders on ${date}; stopped to be safe`);
    },
  };
}
