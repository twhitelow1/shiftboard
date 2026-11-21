// Toast POS endpoints (hosted app only; the demo build has no server, so Toast shows as unavailable).
import { IS_DEMO, ApiError } from './api.js';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data.result;
}

/** { configured, missing: [env names], host, cron } or { demo: true }. */
export async function toastStatus() {
  if (IS_DEMO) return { demo: true, configured: false, missing: [] };
  return request('/api/toast/status');
}

/**
 * Sync a date range, a chunk per request, until done. onProgress({ done, total, date }).
 * Returns the combined result: { days, sales, covers, entries, kept, warning }.
 */
export async function toastSyncRange({ from, to, replaceManual = false, onProgress }) {
  if (IS_DEMO) throw new ApiError(400, 'Toast sync works in the hosted app');
  const total = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const run = { id: Math.random().toString(36).slice(2, 10), from, to };
  const sum = { days: 0, sales: 0, covers: 0, entries: 0, kept: 0, unmatched: 0, warning: null };
  let next = from;
  let refresh = true;
  while (next) {
    onProgress?.({ done: sum.days, total, date: next });
    const r = await request('/api/toast/sync', { method: 'POST', body: { from: next, to, refresh, replaceManual, run } });
    refresh = false;
    for (const d of r.done || []) {
      sum.days++;
      if (d.sales) { sum.sales += d.sales.sales; sum.covers += d.sales.covers; if (d.sales.saved === 'kept') sum.kept++; }
      if (d.entries) { sum.entries += d.entries.found; sum.unmatched += d.entries.unmatched; }
    }
    sum.warning ||= r.warning || null;
    if (!r.done?.length && r.next === next) throw new ApiError(500, 'Sync made no progress. Try a shorter range.');
    next = r.next;
  }
  onProgress?.({ done: total, total, date: null });
  return sum;
}
