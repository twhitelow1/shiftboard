// Google Business Profile, Yelp and answering reviews: the server's routes (server/google-routes.js,
// server/yelp-routes.js, server/review-replies.js). The demo has no server: it never calls Google, Yelp or
// the AI. It shows a sample connection, and its drafts come from a template (core/review-reply.js cannedDraft,
// through reviews.sampleDraft); a "posted" reply is saved in the demo only.
import { IS_DEMO, ApiError, call } from './api.js';
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

// ---------- Google ----------
const DEMO_GOOGLE = {
  demo: true, configured: true, connected: true, canEdit: true, needsReconnect: false, cron: true,
  account: { id: 'accounts/demo', name: 'Sample account' }, location: { id: 'locations/demo', title: 'Sample restaurant (demo)', address: '100 Main St, Springfield' },
  connectedAt: '2026-09-01T16:00:00.000Z', connectedBy: 'Moe', lastSync: { ok: true, at: '2026-09-27T12:30:00.000Z', counts: { new: 2, updated: 0, same: 31 } },
};
export const googleStatus = () => (IS_DEMO ? Promise.resolve(DEMO_GOOGLE) : request('/api/google/status'));
export const googleConnect = () => request('/api/google/connect', { method: 'POST', body: {} });
export const googleLocations = () => request('/api/google/locations');
export const googlePickLocation = (account, location) => request('/api/google/location', { method: 'POST', body: { account, location } });
export const googleDisconnect = () => request('/api/google/disconnect', { method: 'POST', body: {} });
/** Sync now: one chunk per request until done. Returns { counts }. */
export async function googleSyncAll() {
  if (IS_DEMO) throw new ApiError(400, 'Syncing works in the hosted app');
  const counts = {};
  let next = null;
  for (let calls = 0; calls < 40; calls++) {
    const r = await request('/api/google/sync', { method: 'POST', body: { next } });
    for (const [k, n] of Object.entries(r.counts || {})) counts[k] = (counts[k] || 0) + n;
    if (!r.next) return { counts };
    next = r.next;
  }
  throw new ApiError(500, 'Sync made no progress. Try again in a minute.');
}

// ---------- Yelp ----------
const DEMO_YELP = { demo: true, configured: true, hasKey: true, businessId: 'sample-restaurant-springfield', canEdit: true, cron: true, lastSync: { ok: true, at: '2026-09-27T12:31:00.000Z', counts: { excerpts: 3, new: 1 } } };
export const yelpStatus = () => (IS_DEMO ? Promise.resolve(DEMO_YELP) : request('/api/yelp/status'));
export const yelpLookup = (q) => request(`/api/yelp/lookup?${new URLSearchParams(q)}`);
export const yelpSync = () => (IS_DEMO ? Promise.reject(new ApiError(400, 'Syncing works in the hosted app')) : request('/api/yelp/sync', { method: 'POST', body: {} }));

// ---------- replies ----------
/** { available, reason? }: is the built-in AI set up. The demo has canned drafts instead. */
export const aiStatus = () => (IS_DEMO ? Promise.resolve({ available: true, sample: true }) : request('/api/reviews/ai'));
/** A draft for a review: { available, text } (available false: AI drafts aren't set up). */
export async function draftReply(id) {
  if (IS_DEMO) { const r = await call('reviews.sampleDraft', { id }); return { available: true, text: r.text, sample: true }; }
  return request('/api/reviews/draft', { method: 'POST', body: { id } });
}
/** Post (or replace) the reply on Google. The demo saves it here only. */
export async function postGoogleReply(id, text) {
  if (IS_DEMO) { await call('reviews.markReplied', { id, reply: text, replied: true }); return { demo: true }; }
  return request('/api/reviews/reply', { method: 'POST', body: { id, text } });
}
export async function deleteGoogleReply(id) {
  if (IS_DEMO) { await call('reviews.markReplied', { id, replied: false }); return { demo: true }; }
  return request('/api/reviews/reply/delete', { method: 'POST', body: { id } });
}
