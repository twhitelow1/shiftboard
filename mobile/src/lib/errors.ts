// The phone app's own crashes, and "Report a problem" (More), for DubLow Digital: they go to the restaurant's
// ShiftBoard server (POST /api/client-errors and /api/report-problem, server/errors-routes.js) and show up in the
// console's Errors & reports. The same code runs in the browser version at /app.
//
//   installErrorHandlers()   once, at startup: React Native's global handler (ErrorUtils), unhandled promise
//                            rejections, and window.onerror / unhandledrejection in the browser version
//   setErrorTarget(...)      which restaurant and session to send to (the root layout keeps it current)
//   reportError(...)         the crash screen (components/CrashScreen.tsx) sends what it caught
//   noteRpc / notePage       the last calls to the server (method and status only) and screens, for reports
//   sendReport(...)          the Report a problem screen
//
// Nothing personal is sent: no request bodies, no names or emails (the server keeps the user id).
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

type Source = 'global' | 'promise' | 'boundary' | 'window';
interface Target { server: string; token: () => string | null }
interface RecentError { name: string; message: string; source: Source; at: string }
interface Call { method: string; status: number; ms: number; at: string }

let target: Target | null = null;
let installed = false;
const waiting: object[] = []; // crashes before a restaurant is known (sent once it is)
const recent: RecentError[] = [];
const calls: Call[] = [];
const sentKeys = new Set<string>();
let page = '';
let before = '';

/** '1.0.3', and the build's commit when there is one ('1.0.3+abc1234'). */
export function appVersion(): string {
  const v = Constants.expoConfig?.version || '1.0.0';
  const commit = String((Constants.expoConfig?.extra as { commit?: string } | undefined)?.commit || '').slice(0, 7);
  return commit ? `${v}+${commit}` : v;
}

/** The phone, as the server describes it ("Phone app 1.0.3 · iOS 18.1 · iPhone 15"): no identifiers. */
export function deviceInfo() {
  return {
    platform: Platform.OS, osVersion: String(Platform.Version ?? '').slice(0, 16), model: Platform.OS === 'web' ? '' : (Device.modelName || '').slice(0, 40),
    appVersion: appVersion(), app: Platform.OS === 'web' ? 'app-web' : 'phone',
  };
}

export function setErrorTarget(server: string | null, token: () => string | null) {
  target = server ? { server, token } : null;
  if (!target) return;
  while (waiting.length) post('/api/client-errors', waiting.shift()!).catch(() => {});
}

/** The screen on show (expo-router's path, ids taken out). */
export function notePage(path: string) {
  const clean = String(path || '').split('?')[0].split('/').map((p) => (/\d/.test(p) && p.length >= 6 ? ':id' : p)).join('/').slice(0, 120);
  if (clean && clean !== page) { before = page; page = clean; }
}
/** The screen before this one (Report a problem is opened from More: the one before that is what they mean). */
export const pageBefore = (skip: string[] = []) => [page, before].find((p) => p && !skip.some((s) => p.endsWith(s))) || '';

export function noteRpc(method: string, status: number, ms: number) {
  calls.push({ method: String(method).slice(0, 60), status, ms: Math.round(ms), at: new Date().toISOString() });
  if (calls.length > 20) calls.shift();
}

async function post(path: string, body: object): Promise<Response> {
  if (!target) throw new Error('No restaurant yet');
  const token = target.token();
  return fetch(`${target.server}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

// A lost connection or an answer the screen already shows ("Please sign in") isn't a crash.
const NOISE = /ResizeObserver loop|^Network (error|request failed)$|Failed to fetch|Load failed|AbortError|aborted|-extension:\/\//i;

/** Send one crash (deduplicated, at most 10 per run). Never throws. */
export function reportError(error: unknown, source: Source, extra: { fatal?: boolean; componentStack?: string } = {}) {
  try {
    const e = error instanceof Error ? error : null;
    const message = String(e ? e.message : (error as { message?: string })?.message || error || '').slice(0, 2000);
    if (!message || NOISE.test(message)) return;
    if (e && typeof (e as { status?: unknown }).status === 'number' && (e as unknown as { status: number }).status < 500) return; // ApiError the app handles
    recent.push({ name: e?.name || '', message: message.slice(0, 300), source, at: new Date().toISOString() });
    if (recent.length > 10) recent.shift();
    const key = `${source}|${message}`;
    if (sentKeys.has(key) || sentKeys.size >= 10) return;
    sentKeys.add(key);
    const body = {
      kind: 'phone', source, app: Platform.OS === 'web' ? 'app-web' : 'phone', name: e?.name || '', message,
      stack: String(e?.stack || '').slice(0, 12000), page, version: appVersion(), device: deviceInfo(),
      ...(extra.fatal ? { fatal: true } : {}), ...(extra.componentStack ? { componentStack: extra.componentStack.slice(0, 4000) } : {}),
    };
    if (!target) { if (waiting.length < 5) waiting.push(body); return; }
    post('/api/client-errors', body).catch(() => {});
  } catch { /* reporting never gets in the way */ }
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike { getGlobalHandler(): GlobalHandler; setGlobalHandler(h: GlobalHandler): void }

/** Catch what nothing else caught. Once. */
export function installErrorHandlers() {
  if (installed) return;
  installed = true;
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      window.addEventListener('error', (ev) => reportError(ev.error || ev.message, 'window'));
      window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, 'promise'));
      return;
    }
    const g = globalThis as unknown as { ErrorUtils?: ErrorUtilsLike; HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } };
    const eu = g.ErrorUtils;
    if (eu?.getGlobalHandler) {
      const previous = eu.getGlobalHandler();
      eu.setGlobalHandler((error, isFatal) => {
        reportError(error, 'global', { fatal: !!isFatal });
        previous?.(error, isFatal); // React Native's own (the red screen in development, the crash in a release)
      });
    }
    // Unhandled promise rejections (development keeps React Native's own warnings).
    if (!__DEV__) g.HermesInternal?.enablePromiseRejectionTracker?.({ allRejections: true, onUnhandled: (_id: number, rejection: unknown) => reportError(rejection, 'promise') });
  } catch { /* no handlers: crashes still show the crash screen */ }
}

/** What a report attaches by itself. */
export function reportContext(extra: object = {}) {
  return { app: Platform.OS === 'web' ? 'app-web' : 'phone', version: appVersion(), route: page, errors: recent.slice(-10), rpc: calls.slice(-20), ...extra };
}

/** Report a problem. Resolves the report's id; rejects with the server's message (or a network error). */
export async function sendReport(r: { text: string; page?: string; screenshot?: string; error?: Error | null; lang?: string }): Promise<string> {
  const context = reportContext({
    lang: r.lang,
    ...(r.error ? { error: { name: r.error.name || '', message: String(r.error.message || r.error), stack: String(r.error.stack || '').slice(0, 6000) } } : {}),
  });
  const res = await post('/api/report-problem', { text: r.text, page: r.page || '', screenshot: r.screenshot || undefined, version: appVersion(), device: deviceInfo(), context });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data?.result?.id || '';
}

/** Is there a restaurant to send to yet? */
export const canReport = () => !!target;
