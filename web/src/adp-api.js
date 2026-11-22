// ADP API endpoints (hosted app only; the demo has no server, so the API sync shows as unavailable).
// The CSV import doesn't need these: it reads the file here and uses the adp.* RPC methods, so it
// works in the demo too.
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

/** { configured, missing: [env names], problems: [{ env, problem }], host, tokenUrl, team, cron } or { demo: true }. */
export async function adpStatus() {
  if (IS_DEMO) return { demo: true, configured: false, missing: [], problems: [] };
  return request('/api/adp/status');
}

/** Sync a date range, a chunk per request, until done. onProgress({ done, total, date }). Returns { days, entries, unmatched }. */
export async function adpSyncRange({ from, to, onProgress }) {
  if (IS_DEMO) throw new ApiError(400, 'ADP sync works in the hosted app');
  const total = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const run = { id: Math.random().toString(36).slice(2, 10), from, to };
  const sum = { days: 0, entries: 0, unmatched: 0 };
  let next = from;
  let refresh = true;
  while (next) {
    onProgress?.({ done: sum.days, total, date: next });
    const r = await request('/api/adp/sync', { method: 'POST', body: { from: next, to, refresh, run } });
    refresh = false;
    for (const d of r.done || []) { sum.days++; sum.entries += d.found; sum.unmatched += d.unmatched; }
    if (!r.done?.length && r.next === next) throw new ApiError(500, 'Sync made no progress. Try a shorter range.');
    next = r.next;
  }
  onProgress?.({ done: total, total, date: null });
  return sum;
}
