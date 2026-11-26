// Error tracking's HTTP side (server/errors.js keeps and reads them):
//   * capture(): every request runs in a small context. When the response is a 500 (an RPC or a route threw),
//     or an integration's Sync now or cron answers 502, the error is recorded after the response, with the
//     restaurant, the route, the signed-in person's id and the app version. The exception itself comes from the
//     console.error() the code already does for a 500 (hooked here for the request it belongs to), so no
//     route had to change. Request bodies are never read.
//   * POST /api/client-errors  the web app, the console and the phone app report their own crashes here,
//     signed in or out; rate-limited per IP and person, browser noise (extensions, ResizeObserver…) dropped.
//   * POST /api/report-problem "Report a problem": what happened, the page, an optional screenshot, and the
//     app's own recent errors and RPC calls (method names and status only), allowlisted.
import { AsyncLocalStorage } from 'node:async_hooks';
import { scrubText, cleanStack, cleanFile, cleanPath, deviceOf, setRawConsoleError, logQuietly } from './errors.js';

const als = new AsyncLocalStorage();
let hooked = false;

/** console.error(…, err) during a request remembers err for that request (the first one). Installed once. */
export function hookConsole() {
  if (hooked) return;
  hooked = true;
  const orig = console.error;
  setRawConsoleError((...a) => orig.apply(console, a));
  console.error = function errorWithCapture(...args) {
    try {
      const ctx = als.getStore();
      if (ctx && !ctx.error) {
        const e = args.find((a) => a instanceof Error);
        if (e) ctx.error = e;
      }
    } catch { /* never in the way */ }
    return orig.apply(this, args);
  };
}

/** This request's failure is already recorded (the platform's cron records each restaurant's itself). */
export function markHandled() {
  const c = als.getStore();
  if (c) c.handled = true;
}

/** A sliding-window counter per key, in memory (per instance). */
export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  take(key) {
    const n = this.now();
    const list = (this.hits.get(key) || []).filter((t) => n - t < this.windowMs);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(n);
    this.hits.set(key, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.length || n - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
    return true;
  }
}

const SYNC = /^\/api\/(?:(toast|adp|tripleseat)\/sync|cron\/(toast|adp|tripleseat))\/?$/;
const NAMES = { toast: 'Toast', adp: 'ADP', tripleseat: 'Tripleseat' };

function wrapJson(res, ctx) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (ctx.bodyError == null && body && typeof body === 'object' && typeof body.error === 'string') ctx.bodyError = body.error;
    return json(body);
  };
}

function routeOf(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (path.startsWith('/api/rpc/')) return /^\/api\/rpc\/[\w.-]{1,80}$/.test(path) ? path : '/api/rpc/:method';
  const pattern = req.route?.path;
  if (typeof pattern === 'string' && req.baseUrl != null) return `${req.baseUrl || ''}${pattern}`.slice(0, 120);
  return cleanPath(path, 120);
}

/**
 * The per-request context and what's recorded when the response ends. On the platform the platform app starts the
 * context and each restaurant's app adds its own recorder and who's signed in.
 * @param {object} o
 * @param {object} [o.recorder]  { record(ev) } for this restaurant (errors.js ErrorLog.forTenant)
 * @param {(req) => object|null} [o.userOf]  the signed-in person (only their id is kept)
 */
export function capture({ recorder = null, userOf = null } = {}) {
  hookConsole();
  return (req, res, next) => {
    const existing = als.getStore();
    if (existing) {
      if (recorder) existing.recorder = recorder;
      if (userOf) existing.userOf = userOf;
      wrapJson(res, existing);
      return next();
    }
    const ctx = { recorder, userOf, error: null, bodyError: null, handled: false };
    wrapJson(res, ctx);
    res.on('finish', () => { try { finish(req, res, ctx); } catch (e) { logQuietly('Error tracking failed:', e); } });
    als.run(ctx, next);
  };
}

function finish(req, res, ctx) {
  if (ctx.handled || !ctx.recorder) return;
  const status = res.statusCode;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  let ev;
  if (status >= 500 && ![502, 503, 504].includes(status)) {
    const e = ctx.error;
    ev = {
      source: path.startsWith('/api/rpc/') ? 'rpc' : 'route',
      name: e?.name || 'HTTP 500', message: e?.message || `${req.method} ${routeOf(req)} answered ${status}`, stack: e?.stack || '',
    };
  } else if (status === 502 && SYNC.test(path)) {
    const m = SYNC.exec(path);
    const which = NAMES[m[1] || m[2]];
    ev = { source: m[2] ? 'cron' : 'sync', name: `${which} sync`, message: `${which}: ${ctx.bodyError || 'the sync failed'}`, stack: '' };
  } else return;
  let userId = null;
  try { userId = ctx.userOf?.(req)?.id || null; } catch { /* signed out */ }
  ctx.recorder.record({
    kind: 'server', ...ev, route: routeOf(req), method: req.method, httpStatus: status, userId, device: deviceOf(req.get?.('user-agent') || ''),
  });
}

// ---------- what the apps send ----------
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const oneOf = (v, list, dflt = '') => (list.includes(v) ? v : dflt);
const APPS = ['web', 'console', 'phone', 'app-web'];
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

// Errors that aren't ours, or that tell us nothing: browser extensions, ResizeObserver, cross-origin "Script error.",
// a lost connection, an aborted request, in-app browsers' own scripts.
const NOISE = [
  /ResizeObserver loop/i,
  /^(Uncaught )?Script error\.?$/i,
  /Non-Error promise rejection captured/i,
  /\b(?:chrome|moz|safari|safari-web|ms-browser|edge)-extension:\/\//i,
  /webkit-masked-url|__gCrWeb|_AutofillCallbackHandler|instantSearchSDKJSBridge|Can't find variable: (?:gmo|CONFIG|zaloJSV2)/i,
  /^(?:TypeError: )?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed|The network connection was lost\.?|Network error)$/i,
  /^(?:AbortError: )?(?:The (?:user|operation) aborted a request\.?|The operation was aborted\.?|signal is aborted without reason|Aborted)$/i,
];
export function isNoise({ message = '', stack = '', filename = '' }) {
  const m = String(message).trim();
  if (!m) return true;
  if (NOISE.some((re) => re.test(m))) return true;
  const where = `${stack}\n${filename}`;
  if (/\b(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i.test(where)) {
    // Every frame from an extension: not ours.
    const frames = where.split('\n').filter((l) => /:\d+:\d+/.test(l));
    if (!frames.length || frames.every((l) => /-extension:\/\//i.test(l))) return true;
  }
  return false;
}

/** A client error report, allowlisted. null when there's nothing to keep. */
export function cleanClientError(b) {
  if (!b || typeof b !== 'object') return null;
  const message = str(b.message, 2000).trim();
  if (!message) return null;
  const kind = b.kind === 'phone' ? 'phone' : 'browser';
  const filename = str(b.filename, 300);
  return {
    kind,
    source: oneOf(b.source, ['window', 'promise', 'boundary', 'global', 'console'], 'window'),
    name: str(b.name, 60),
    message,
    stack: str(b.stack, 12000),
    page: str(b.page, 300),
    version: str(b.version, 40),
    context: {
      app: oneOf(b.app, APPS, kind === 'phone' ? 'phone' : 'web'),
      ...(b.componentStack ? { componentStack: cleanStack(str(b.componentStack, 4000), 2500) } : {}),
      ...(filename ? { at: `${cleanFile(filename)}${Number.isInteger(b.line) ? `:${b.line}${Number.isInteger(b.col) ? `:${b.col}` : ''}` : ''}` } : {}),
      ...(b.fatal === true ? { fatal: true } : {}),
    },
    filename,
  };
}

const IMAGE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_SCREENSHOT = 1_200_000; // bytes, after the app shrinks it
const MAGIC = { 'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/png': (b) => b.subarray(0, 4).toString('hex') === '89504e47', 'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };

/** A screenshot data URL → { mime, data (base64) }, or an error message. */
export function cleanScreenshot(dataUrl) {
  if (dataUrl == null || dataUrl === '') return { file: null };
  const m = IMAGE.exec(String(dataUrl).slice(0, MAX_SCREENSHOT * 1.4 + 100));
  if (!m) return { error: 'That screenshot isn’t a picture we can use' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_SCREENSHOT) return { error: 'That screenshot is too large' };
  if (!MAGIC[m[1]](buf)) return { error: 'That screenshot isn’t a picture we can use' };
  return { file: { mime: m[1], data: buf.toString('base64') } };
}

/** The details the app attaches to a report: allowlisted, scrubbed. */
export function cleanReportContext(c) {
  c = c && typeof c === 'object' ? c : {};
  const arr = (v, n) => (Array.isArray(v) ? v.slice(-n) : []);
  const out = {
    app: oneOf(c.app, APPS, 'web'),
    ...(c.route ? { route: cleanPath(str(c.route, 300)) } : {}),
    ...(/^\d{2,5}x\d{2,5}$/.test(String(c.screen || '')) ? { screen: String(c.screen) } : {}),
    ...(['en', 'es'].includes(c.lang) ? { lang: c.lang } : {}),
    ...(typeof c.online === 'boolean' ? { online: c.online } : {}),
    errors: arr(c.errors, 10).filter((e) => e && typeof e === 'object').map((e) => ({
      name: str(e.name, 60).replace(/[^\w$.: -]/g, ''), message: scrubText(str(e.message, 600), 300), source: oneOf(e.source, ['window', 'promise', 'boundary', 'global', 'console'], ''),
      at: isoOrNull(e.at),
    })),
    rpc: arr(c.rpc, 20).filter((r) => r && typeof r === 'object').map((r) => ({
      method: /^[\w.-]{1,60}$/.test(String(r.method || '')) ? String(r.method) : '?',
      status: Number.isInteger(r.status) && r.status >= 0 && r.status < 1000 ? r.status : 0,
      ...(Number.isFinite(r.ms) ? { ms: Math.max(0, Math.min(600_000, Math.round(r.ms))) } : {}),
      at: isoOrNull(r.at),
    })),
  };
  if (c.error && typeof c.error === 'object' && c.error.message) {
    out.error = { name: str(c.error.name, 60).replace(/[^\w$.: -]/g, ''), message: scrubText(str(c.error.message, 600), 400), stack: cleanStack(str(c.error.stack, 6000), 3000) };
  }
  if (c.componentStack) out.componentStack = cleanStack(str(c.componentStack, 4000), 2500);
  return out;
}

/**
 * POST <prefix>/client-errors and (unless reports is false) POST <prefix>/report-problem.
 * @param o.recorder  { record(ev), report(ev) } for this restaurant
 * @param o.userOf    async (req) => the signed-in person or null (signed out is fine)
 */
export function clientRoutes(app, { recorder, userOf = async () => null, prefix = '/api', reports = true, now = () => Date.now() }) {
  const perMinute = new RateLimiter({ limit: 20, windowMs: 60_000, now });
  const perHour = new RateLimiter({ limit: 120, windowMs: 3_600_000, now });
  const reportBurst = new RateLimiter({ limit: 5, windowMs: 600_000, now });
  const reportDay = new RateLimiter({ limit: 30, windowMs: 86_400_000, now });
  const who = async (req) => { try { return await userOf(req); } catch { return null; } };
  const tooMany = (res) => res.status(429).json({ error: 'Too many requests. Try again in a minute.' });

  app.post(`${prefix}/client-errors`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const user = await who(req);
    const key = `${req.ip}|${user?.id || ''}`;
    if (!perMinute.take(key) || !perHour.take(req.ip || '')) return tooMany(res);
    const ev = cleanClientError(req.body);
    if (!ev) return res.status(400).json({ error: 'Nothing to record' });
    if (isNoise(ev)) return res.status(202).json({ result: { ignored: true } });
    const { filename, ...rest } = ev;
    recorder.record({ ...rest, userId: user?.id || null, device: deviceOf(req.get('user-agent') || '', req.body?.device) });
    res.status(202).json({ result: { ok: true } });
  });

  if (!reports) return;
  app.post(`${prefix}/report-problem`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const user = await who(req);
    const key = user?.id ? `u|${user.id}` : `ip|${req.ip}`;
    if (!reportBurst.take(key) || !reportDay.take(key)) return tooMany(res);
    const text = str(b.text, 4000).trim();
    if (text.length < 3) return res.status(400).json({ error: 'Tell us what happened' });
    const shot = cleanScreenshot(b.screenshot);
    if (shot.error) return res.status(400).json({ error: shot.error });
    const context = cleanReportContext(b.context);
    const r = await recorder.report({
      report: { text: text.slice(0, 2000), page: str(b.page, 100).trim() },
      page: context.route || '', version: str(b.version || b.context?.version, 40), userId: user?.id || null,
      device: deviceOf(req.get('user-agent') || '', b.device || b.context?.device), context, file: shot.file,
    }).catch((e) => { logQuietly('Could not save a report:', e); return null; });
    if (!r) return res.status(503).json({ error: 'Something went wrong' });
    res.json({ result: { ok: true, id: r.id } });
  });
}
