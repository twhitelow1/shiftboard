// API client. In the hosted app it talks to the server over HTTP.
// In the demo build it runs the exact same business logic in the browser.
import { MemoryStore } from '../../core/store.js';
import { createService } from '../../core/service.js';
import { seedDemo } from '../../core/seed.js';

export const IS_DEMO = __DEMO__;
export const DEMO_NOW = new Date(2026, 8, 27, 12, 0, 0); // Sun Sep 27 2026, noon

let demo = null;
function getDemo() {
  if (!demo) {
    const store = new MemoryStore();
    const ids = seedDemo(store);
    const service = createService(store, { now: () => DEMO_NOW });
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
      throw new ApiError(e.status || 500, e.message);
    }
  }
  const res = await fetch(`/api/rpc/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `Request failed (${res.status})`);
  return body.result;
}

export async function login(email, password) {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || 'Sign-in failed');
  return true;
}

export async function logout() {
  if (IS_DEMO) return;
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
