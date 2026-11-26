// OpenTable's API mode (hosted app only: the demo has no server). Importing OpenTable's exported files is
// plain RPC (opentable.previewImport / opentable.import in core/opentable.js) and works in the demo too.
import { IS_DEMO, ApiError } from './api.js';
import { getLang } from './i18n/index.js';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-ShiftBoard-Language': getLang() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data.result;
}

/** { configured, missing, present, host, rid, cron } or { demo: true }. */
export async function opentableStatus() {
  if (IS_DEMO) return { demo: true, configured: false, missing: [], present: [] };
  return request('/api/opentable/status');
}

/** Sync now: one chunk per request until done. Returns { counts, warnings }. */
export async function opentableSyncAll({ onProgress } = {}) {
  if (IS_DEMO) throw new ApiError(400, 'OpenTable sync works in the hosted app');
  const counts = {};
  let warnings = [];
  let next = null;
  for (let calls = 0; calls < 80; calls++) {
    onProgress?.({ phase: next?.phase || 'reservations', calls });
    const r = await request('/api/opentable/sync', { method: 'POST', body: { next } });
    for (const [k, n] of Object.entries(r.counts || {})) counts[k] = (counts[k] || 0) + n;
    if (r.warnings?.length) warnings = r.warnings;
    if (!r.next) return { counts, warnings };
    next = r.next;
  }
  throw new ApiError(500, 'Sync made no progress. Try again in a minute.');
}
