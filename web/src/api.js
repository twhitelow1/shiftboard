// API client. In the hosted app it talks to the server over HTTP.
// In the demo build it runs the exact same business logic in the browser.
import { MemoryStore } from '../../core/store.js';
import { createService } from '../../core/service.js';
import { seedDemo } from '../../core/seed.js';
import { seedAnnouncementDemo, DEMO_CHANNELS } from '../../core/announce-seed.js';
import { startServiceWorker, forgetThisDevice } from './push.js';
import { getLang, translateError } from './i18n/index.js';

// The server answers errors in the caller's language; this tells it the app's language (which it uses
// when the person hasn't picked one, and before sign-in). See server/app.js and core/errors.js.
const langHeader = () => ({ 'X-ShiftBoard-Language': getLang() });

export const IS_DEMO = __DEMO__;
// Phone notifications need the service worker (web/public/sw.js). The demo has no server, so no worker.
if (!IS_DEMO) startServiceWorker();
export const DEMO_NOW = new Date(2026, 8, 27, 12, 0, 0); // Sun Sep 27 2026, noon

let demo = null;
function getDemo() {
  if (!demo) {
    const store = new MemoryStore();
    const ids = seedDemo(store, { now: DEMO_NOW }); // the demo clock, so the 86 List's sample items are from "today"
    seedAnnouncementDemo(store, { userId: ids.userId, now: DEMO_NOW }); // consents, phones and two sample announcements
    const service = createService(store, { now: () => DEMO_NOW, announce: DEMO_CHANNELS }); // announcements "go out" at once
    demo = { store, ids, service, userId: ids.userId['Moe'] };
  }
  return demo;
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function call(method, args = {}) {
  if (IS_DEMO) {
    const d = getDemo();
    const actor = d.store.get('users', d.userId);
    try {
      // Clone to mimic a network boundary (no shared references into the store).
      return JSON.parse(JSON.stringify(d.service.call(actor, method, args) ?? null));
    } catch (e) {
      throw new ApiError(e.status || 500, translateError(e.message)); // the demo has no server to translate it
    }
  }
  const res = await fetch(`/api/rpc/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...langHeader() },
    credentials: 'same-origin',
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || translateError(`Request failed (${res.status})`));
  return body.result;
}

export async function login(email, password) {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...langHeader() }, body: JSON.stringify({ email, password }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || translateError('Sign-in failed'));
  return true;
}

export async function logout() {
  if (IS_DEMO) return;
  await forgetThisDevice(call); // no more of this person's notifications on this phone
  await fetch('/api/auth/logout', { method: 'POST' });
}

export async function icalLink() {
  if (IS_DEMO) return null;
  const res = await fetch('/api/rpc-ical-link', { method: 'POST' });
  const body = await res.json();
  return body.result ? `${location.origin}${body.result}` : null;
}

// Demo-only persona switching
export function demoPersonas() {
  const d = getDemo();
  const pick = ['Moe', 'Kelly', 'Events Team', 'Alex D', 'Styves', 'Tori', 'Ever', 'Hans', 'Agustina'];
  return pick.map((n) => d.store.get('users', d.ids.userId[n])).map((u) => ({ id: u.id, name: u.name, role: u.role }));
}
export function demoSwitch(userId) { getDemo().userId = userId; }
export function demoCurrent() { return getDemo().userId; }
export function nowDate() { return IS_DEMO ? DEMO_NOW : new Date(); }

// ---------- email features (hosted app only) ----------
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...langHeader() }, credentials: 'same-origin', body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || translateError(`Request failed (${res.status})`));
  return data.result ?? data;
}
/** Server features the UI adapts to: { email: boolean, emailFrom } */
export async function getConfig() {
  if (IS_DEMO) return { email: false, emailFrom: null, language: 'auto' };
  try { return await (await fetch('/api/config')).json(); } catch { return { email: false, emailFrom: null }; }
}
export const forgotPassword = (email) => post('/api/auth/forgot', { email });
export const resetPassword = (token, password) => post('/api/auth/reset', { token, password });
export const sendTestEmail = () => post('/api/email/test');
export const sendSignInLink = (userId) => post(`/api/users/${encodeURIComponent(userId)}/invite`);
export const inviteAll = () => post('/api/users/invite-all');
// Phone notifications and texts (server/channels.js)
export const sendTestPush = () => post('/api/push/test');
export const sendTestText = (phone) => post('/api/sms/test', { phone });
// The billing banner's button (server/billing.js): Stripe's billing portal in phase 2, nothing yet.
export const billingPortal = () => post('/api/billing/portal');
