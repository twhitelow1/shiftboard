// Tripleseat endpoints (hosted app only; the demo has no server, so Tripleseat shows as unavailable).
// The settings themselves (rooms, rules, the webhook link) are plain RPC: tripleseat.* in core/tripleseat.js.
import { IS_DEMO, ApiError } from './api.js';
import { getLang } from './i18n/index.js';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-ShiftBoard-Language': getLang() }, // errors come back in this language
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data.result;
}

/** { configured, auth, missing, present, host, siteId, locationId, webhookSecret, cron } or { demo: true }. */
export async function tripleseatStatus() {
  if (IS_DEMO) return { demo: true, configured: false, missing: [], present: [] };
  return request('/api/tripleseat/status');
}

const PHASES = ['lists', 'changed', 'window', 'missing'];

/**
 * Sync now: one chunk per request until Tripleseat's window is done. onProgress({ step, of }).
 * Returns { counts: { added, updated, … }, warnings }.
 */
export async function tripleseatSyncAll({ onProgress } = {}) {
  if (IS_DEMO) throw new ApiError(400, 'Tripleseat sync works in the hosted app');
  const counts = {};
  let warnings = [];
  let next = null;
  for (let calls = 0; calls < 60; calls++) {
    onProgress?.({ step: next ? PHASES.indexOf(next.phase) + 1 : 0, of: PHASES.length });
    const r = await request('/api/tripleseat/sync', { method: 'POST', body: { next } });
    for (const [k, n] of Object.entries(r.counts || {})) counts[k] = (counts[k] || 0) + n;
    if (r.warnings?.length) warnings = r.warnings;
    if (!r.next) return { counts, warnings };
    next = r.next;
  }
  throw new ApiError(500, 'Sync made no progress. Try again in a minute.');
}
