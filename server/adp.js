// ADP API client (read-only). Credentials come from env only, never the database:
//   ADP_CLIENT_ID, ADP_CLIENT_SECRET   the API Central project's (or partner app's) client credentials
//   ADP_CERT_PEM, ADP_KEY_PEM          the client certificate ADP signed from your CSR, and its private key
//                                      (PEM text, PEM with \n escapes, or base64 of the PEM)
//   ADP_API_HOST (optional)            default https://api.adp.com
//   ADP_TOKEN_URL (optional)           default https://accounts.adp.com/auth/oauth/v2/token
//   ADP_MANAGER_AOID (optional)        a manager's associate OID: read their team's time cards in one call
//                                      instead of each worker's
// All config is read in adpConfig(), so per-restaurant secrets can replace env vars in one place.
//
// Auth: OAuth 2.0 client credentials over mutual TLS. Every request (the token one too) presents the
// client certificate, through one https.Agent. The token (expires_in, usually an hour) is cached in
// memory until shortly before it expires and shared by every request in this instance.
// Lists are paged with $top/$skip (100 at a time) until a short page or 204 No Content.
// 429 answers are retried after Retry-After; ADP doesn't publish fixed limits (they're per client).
import https from 'node:https';

export const DEFAULT_HOST = 'https://api.adp.com';
export const DEFAULT_TOKEN_URL = 'https://accounts.adp.com/auth/oauth/v2/token';
export const REQUIRED_ENV = ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM'];
export const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRY_WAIT_MS = 10_000;

export class AdpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * PEM text from an env value: the PEM itself (real newlines, or \n typed into a one-line field),
 * or base64 of the PEM. `kind` is 'cert' or 'key'. Returns { pem } or { problem }.
 */
export function readPem(value, kind) {
  let v = String(value || '').trim();
  if (!v) return { problem: 'missing' };
  if (!v.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(v.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) v = decoded.trim();
    } catch { /* not base64 */ }
  }
  if (!v.includes('-----BEGIN')) return { problem: 'notPem' };
  v = v.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  if (kind === 'cert' && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(v)) return { problem: 'notCertificate' };
  if (kind === 'key') {
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(v)) return { problem: 'encryptedKey' };
    if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC )?PRIVATE KEY-----/.test(v)) return { problem: 'notPrivateKey' };
  }
  return { pem: `${v}\n`.replace(/\n+$/, '\n') };
}

/** Which settings are present and usable (names and problems only; never the values). */
export function adpConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((k) => !String(env[k] || '').trim());
  const cert = readPem(env.ADP_CERT_PEM, 'cert');
  const key = readPem(env.ADP_KEY_PEM, 'key');
  const problems = [];
  if (env.ADP_CERT_PEM && cert.problem) problems.push({ env: 'ADP_CERT_PEM', problem: cert.problem });
  if (env.ADP_KEY_PEM && key.problem) problems.push({ env: 'ADP_KEY_PEM', problem: key.problem });
  const clean = (v, d) => String(v || d).trim().replace(/\/+$/, '');
  return {
    configured: !missing.length && !problems.length,
    missing,
    problems,
    host: clean(env.ADP_API_HOST, DEFAULT_HOST),
    tokenUrl: clean(env.ADP_TOKEN_URL, DEFAULT_TOKEN_URL),
    managerAoid: String(env.ADP_MANAGER_AOID || '').trim(),
    cron: !!String(env.CRON_SECRET || '').trim(),
  };
}

/** The https.Agent that presents the client certificate on every connection (mutual TLS). */
export function mtlsAgent(env = process.env) {
  const cert = readPem(env.ADP_CERT_PEM, 'cert');
  const key = readPem(env.ADP_KEY_PEM, 'key');
  if (cert.problem || key.problem) throw new AdpError('The ADP certificate or key isn’t set up. Check ADP_CERT_PEM and ADP_KEY_PEM.');
  return new https.Agent({ cert: cert.pem, key: key.pem, keepAlive: true, minVersion: 'TLSv1.2' });
}

/** One HTTPS request through the mTLS agent. Resolves { status, headers: { get(name) }, text }. */
export function httpsTransport(url, { method = 'GET', headers = {}, body, agent, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (name) => { const v = res.headers[String(name).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// One token per token URL + client, shared by every client created in this instance.
const tokens = new Map();
export const _tokenCache = tokens; // tests

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const errorText = (body) => body?.confirmMessage?.processMessages?.[0]?.userMessage?.messageTxt || body?.error_description || body?.message || body?.error || '';

/**
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {Function} [opts.transport]  (url, { method, headers, body, agent }) → { status, headers, text }; tests pass a fake
 * @param {object} [opts.agent]        defaults to mtlsAgent(env)
 * @param {Function} [opts.now] [opts.sleep]
 * @param {number} [opts.concurrency]  worker time cards fetched at once (when there's no manager AOID)
 */
export function createAdpClient({ env = process.env, transport = httpsTransport, agent, now = () => Date.now(), sleep = wait, timeoutMs = 15_000, concurrency = 4 } = {}) {
  const cfg = adpConfig(env);
  const clientId = String(env.ADP_CLIENT_ID || '').trim();
  const clientSecret = String(env.ADP_CLIENT_SECRET || '').trim();
  const key = `${cfg.tokenUrl}|${clientId}`;
  let tls = agent || null;
  const getAgent = () => (tls ||= mtlsAgent(env));

  async function send(url, init) {
    try {
      return await transport(url, { ...init, agent: getAgent(), timeoutMs });
    } catch (e) {
      if (e instanceof AdpError) throw e;
      const why = e.name === 'TimeoutError' ? 'timed out' : /certificate|handshake|ssl|tls/i.test(e.message) ? `the certificate was refused: ${e.message}` : e.message;
      throw new AdpError(`Couldn't reach ADP at ${new URL(url).host} (${why})`);
    }
  }

  async function login() {
    const res = await send(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body = parse(res.text) || {};
    if (res.status === 401 || res.status === 403 || body.error === 'invalid_client') throw new AdpError('ADP didn’t accept the client ID and secret, or the certificate. Check ADP_CLIENT_ID, ADP_CLIENT_SECRET and ADP_CERT_PEM.', res.status);
    if (res.status === 429) throw new AdpError('ADP is limiting sign-ins right now. Try again in a few minutes.', 429);
    if (res.status < 200 || res.status >= 300) throw new AdpError(`ADP sign-in failed (${res.status})${errorText(body) ? `: ${errorText(body)}` : ''}`, res.status);
    if (!body.access_token) throw new AdpError('ADP sign-in returned no token');
    const ms = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 60 * 60 * 1000;
    return { accessToken: body.access_token, expiresAt: now() + ms };
  }

  /** A valid access token, from the cache when possible. Concurrent callers share one sign-in. */
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

  /** GET an ADP path. Returns { data, headers } (data null for 204). Retries after a 401 (fresh token), 429 and 5xx. */
  async function get(path, query) {
    if (!cfg.configured) throw new AdpError(`ADP isn’t set up. Missing: ${[...cfg.missing, ...cfg.problems.map((p) => p.env)].join(', ')}`);
    const url = new URL(path.startsWith('http') ? path : cfg.host + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const access = await token({ fresh: refreshed && attempt === 0 });
      let res;
      try {
        res = await send(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } });
      } catch (e) {
        if (attempt < 2) { await sleep(500); continue; }
        throw e;
      }
      if (res.status === 401 && !refreshed) { refreshed = true; tokens.delete(key); attempt = -1; continue; }
      if (res.status === 429 && attempt < 3) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * (attempt + 1), MAX_RETRY_WAIT_MS));
        continue;
      }
      if (res.status >= 500 && attempt < 2) { await sleep(700); continue; }
      if (res.status === 204) return { data: null, headers: res.headers };
      const body = parse(res.text);
      if (res.status >= 200 && res.status < 300) return { data: body, headers: res.headers };
      const msg = errorText(body);
      if (res.status === 401) throw new AdpError('ADP rejected the access token. Check the client ID, secret and certificate.', 401);
      if (res.status === 403) throw new AdpError(`ADP says this app can’t read ${url.pathname}. Ask your ADP rep to add it to the app's scope (API Central project or partner consent).`, 403);
      if (res.status === 404) throw new AdpError(`ADP couldn't find ${url.pathname}${msg ? `: ${msg}` : ''}`, 404);
      if (res.status === 429) throw new AdpError('ADP is rate limiting requests. Try again in a minute.', 429);
      throw new AdpError(`ADP answered ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    }
  }

  /** Every page of a list: $top/$skip, until a page comes back short, empty or 204. */
  async function paged(path, query, pick) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await get(path, { ...query, $top: PAGE_SIZE, $skip: page * PAGE_SIZE });
      const rows = data ? pick(data) || [] : [];
      out.push(...rows);
      if (rows.length < PAGE_SIZE) return out;
    }
    throw new AdpError(`More than ${MAX_PAGES * PAGE_SIZE} rows from ${path}; stopped to be safe`);
  }

  /** Run fn over items, a few at a time. */
  async function pool(items, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  const filterFor = (periodStart) => (periodStart ? `timeCards/timePeriod/startDate eq '${periodStart}'` : "timeCards/periodCode/codeValue eq 'current'");

  /**
   * Time cards for one pay period (by its start date; none = the current one), with day entries, for
   * everyone: the manager's team in one paged call when ADP_MANAGER_AOID is set, else each worker's own
   * time cards. Returns { teamTimeCards: [{ associateOID, timeCards: [...] }] } either way.
   */
  async function timeCards({ periodStart = null, aoids = [] } = {}) {
    const query = { $expand: 'dayEntries', $filter: filterFor(periodStart) };
    if (cfg.managerAoid) {
      const teamTimeCards = await paged(`/time/v2/workers/${encodeURIComponent(cfg.managerAoid)}/team-time-cards`, query, (d) => d?.teamTimeCards);
      return { teamTimeCards };
    }
    const teamTimeCards = await pool(aoids, async (aoid) => {
      const { data } = await get(`/time/v2/workers/${encodeURIComponent(aoid)}/time-cards`, query);
      return { associateOID: aoid, timeCards: data?.timeCards || [] };
    });
    return { teamTimeCards };
  }

  return {
    config: cfg,
    token,
    get,
    paged,
    timeCards,
    /** GET /hr/v2/workers, every page: associate OIDs, names, emails, file numbers. */
    workers: () => paged('/hr/v2/workers', {}, (d) => d?.workers),
    /** The current pay period { startDate, endDate }, to work out every other period from. */
    async currentPeriod({ aoids = [] } = {}) {
      const cards = await timeCards({ periodStart: null, aoids: cfg.managerAoid ? [] : aoids.slice(0, 3) });
      for (const t of cards.teamTimeCards || []) for (const c of t?.timeCards || []) {
        const p = c?.timePeriod;
        if (p?.startDate && p?.endDate) return { startDate: String(p.startDate).slice(0, 10), endDate: String(p.endDate).slice(0, 10) };
      }
      return null;
    },
  };
}
