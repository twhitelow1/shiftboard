// The web app's and the console's own crashes, sent to the server for DubLow Digital (server/errors-routes.js),
// and what "Report a problem" attaches by itself: the app version, the page, the screen size, the app's last
// errors and its last calls to the server (method names and status only, never what was sent).
//
//   installErrorReporting({ endpoint, app })  window.onerror and unhandled promise rejections (main.jsx)
//   reportError(error, source, extra)          for React error boundaries (ErrorBoundary.jsx)
//   noteRpc(method, status, ms)                api.js, after every RPC
//   sendReport({ text, page, screenshot, error })   pages/ReportProblem.jsx
//
// The demo build has no server, so nothing is sent from it.

/* global __APP_VERSION__ */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';

const MAX_SENT = 10; // per page load
const recent = []; // the last 10 errors, for reports
const calls = []; // the last 20 RPC calls, for reports
const sentKeys = new Set();
let cfg = { endpoint: '/api/client-errors', app: 'web', enabled: false, lang: () => '' };

/** Where the app is now, without ids or tokens: '/#/events/:id/edit'. */
export function currentPage() {
  try {
    const hash = location.hash.split('?')[0];
    const clean = (s) => s.split('/').map((p) => (/^[a-z]{2,8}_[\w-]{3,}$/.test(p) || (/\d/.test(p) && p.length >= 6) || p.length > 40 ? ':id' : p)).join('/');
    return `${clean(location.pathname)}${hash ? clean(hash) : ''}`.slice(0, 200);
  } catch { return ''; }
}

/** After every RPC: its name and how it ended (status 0: no answer). */
export function noteRpc(method, status, ms) {
  calls.push({ method: String(method).slice(0, 60), status: Number(status) || 0, ms: Math.round(Number(ms) || 0), at: new Date().toISOString() });
  if (calls.length > 20) calls.shift();
}

// Not ours, or nothing to learn from: extensions, ResizeObserver, cross-origin "Script error.", a dropped
// connection, and API answers like "Please sign in" that the screen already shows.
const NOISE = /ResizeObserver loop|^Script error\.?$|-extension:\/\/|^(TypeError: )?(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$|AbortError|aborted/i;
function isNoise(e, message) {
  if (!message || NOISE.test(message) || NOISE.test(String(e?.stack || ''))) return true;
  return e && typeof e.status === 'number' && e.status < 500; // an ApiError the app handles
}

/** Send one error (deduplicated, at most 10 a page load). Never throws. */
export function reportError(error, source = 'window', extra = {}) {
  try {
    const e = error instanceof Error ? error : null;
    const message = String(e ? e.message : extra.message || error || '').slice(0, 2000);
    if (isNoise(e || error, message)) return;
    recent.push({ name: e?.name || '', message: message.slice(0, 300), source, at: new Date().toISOString() });
    if (recent.length > 10) recent.shift();
    if (!cfg.enabled) return;
    const key = `${source}|${message}`;
    if (sentKeys.has(key) || sentKeys.size >= MAX_SENT) return;
    sentKeys.add(key);
    const body = {
      kind: 'browser', source, app: cfg.app, name: e?.name || '', message, stack: String(e?.stack || '').slice(0, 12000),
      page: currentPage(), version: APP_VERSION,
      ...(extra.componentStack ? { componentStack: String(extra.componentStack).slice(0, 4000) } : {}),
      ...(extra.filename ? { filename: String(extra.filename).slice(0, 300), line: extra.line, col: extra.col } : {}),
    };
    fetch(cfg.endpoint, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  } catch { /* reporting never gets in the way */ }
}

/** Catch what nothing else caught. enabled: false in the demo (no server). */
export function installErrorReporting({ endpoint = '/api/client-errors', app = 'web', enabled = true, lang } = {}) {
  cfg = { endpoint, app, enabled, lang: lang || cfg.lang };
  if (typeof window === 'undefined' || window.__sbErrors) return;
  window.__sbErrors = true;
  window.addEventListener('error', (ev) => {
    reportError(ev.error || ev.message, 'window', { message: ev.message, filename: ev.filename, line: ev.lineno, col: ev.colno });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    reportError(r instanceof Error ? r : (r && typeof r === 'object' && 'status' in r ? r : String(r?.message || r || '')), 'promise', { message: String(r?.message || r || '') });
  });
}

/** What a report attaches by itself. */
export function reportContext(extra = {}) {
  let screen = '';
  try { screen = `${window.innerWidth}x${window.innerHeight}`; } catch { /* no window */ }
  return {
    app: cfg.app, version: APP_VERSION, route: currentPage(), screen, lang: cfg.lang?.() || undefined,
    online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    errors: recent.slice(-10), rpc: calls.slice(-20), ...extra,
  };
}

/** "Report a problem": resolves { id } or rejects with the server's message. */
export async function sendReport({ text, page, screenshot, error, componentStack }) {
  const context = reportContext({
    ...(error ? { error: { name: error.name || '', message: String(error.message || error), stack: String(error.stack || '').slice(0, 6000) } } : {}),
    ...(componentStack ? { componentStack: String(componentStack).slice(0, 4000) } : {}),
  });
  const res = await fetch('/api/report-problem', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(cfg.lang?.() ? { 'X-ShiftBoard-Language': cfg.lang() } : {}) },
    body: JSON.stringify({ text, page, screenshot: screenshot || undefined, version: APP_VERSION, context }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data.result;
}
