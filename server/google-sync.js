// Pull a restaurant's Google reviews inside a time budget (each call fits Vercel's 30 s limit); what doesn't fit
// comes back as `next` and the caller (Sync now, or the next cron run) carries on.
//
// Incremental by updateTime: Google lists a location's reviews newest change first (orderBy 'updateTime desc'),
// so a run reads pages until it reaches reviews changed before the last finished run started (less a day of
// overlap), or 400 days back the first time. Every write goes through core/google-reviews.js with Google's
// review id as the key, so running any part again never double-counts. The first run is a back-fill: its
// history doesn't alert the managers (only the last 7 days do).
import { addDays, todayStr } from '../core/time.js';
import { createService } from '../core/service.js';
import { integration, saveIntegration, applyGoogleReviews } from '../core/google-reviews.js';
import { GoogleError } from './google.js';

export const FIRST_DAYS = 400;
const MAX_PAGES = 100;
const stamp = () => new Date().toISOString();
const failWith = (status, message) => { throw new GoogleError(message, status); };

export function newCursor(store, { runId, today = todayStr() } = {}) {
  const i = integration(store);
  const last = i.lastFullAt ? String(i.lastFullAt).slice(0, 10) : null;
  return { runId: String(runId || Math.random().toString(36).slice(2, 10)).slice(0, 40), pageToken: '', pages: 0, startedAt: stamp(),
    since: `${last ? addDays(last, -1) : addDays(today, -FIRST_DAYS)}T00:00:00Z`, backfill: !i.firstSyncAt };
}
/** A cursor that came back from the browser, checked. */
export function cleanCursor(c) {
  if (!c || typeof c !== 'object' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(String(c.since || ''))) return null;
  return { runId: String(c.runId || '').slice(0, 40) || null, pageToken: String(c.pageToken || '').replace(/[^A-Za-z0-9_=+/.-]/g, '').slice(0, 600),
    pages: Math.min(Math.max(0, Math.floor(Number(c.pages) || 0)), MAX_PAGES), since: c.since, startedAt: typeof c.startedAt === 'string' ? c.startedAt.slice(0, 40) : stamp(), backfill: !!c.backfill };
}

/**
 * @param {object} o
 * @param {object} o.client     server/google.js client with the restaurant's refresh token
 * @returns {Promise<{ ok, next, counts, error?, reconnect? }>}
 */
export async function runGoogleSync({ db, env = process.env, client, cursor = null, by = null, budgetMs = 18_000, clock = () => Date.now(), onCommit, today = todayStr() }) {
  const started = clock();
  const timeZone = env.TIMEZONE || process.env.TZ || '';
  await db.sync();
  const i0 = integration(db.store);
  const out = { ok: true, next: null, counts: {} };
  if (!i0.refreshTokenEnc || !i0.accountId || !i0.locationId) return { ok: false, next: null, counts: {}, error: 'Pick the Google Business Profile location first' };
  let cur = cleanCursor(cursor) || newCursor(db.store, { today });
  if (!cur.runId) cur.runId = newCursor(db.store, { today }).runId;
  out.runId = cur.runId;
  const add = (counts) => { for (const [k, n] of Object.entries(counts || {})) if (typeof n === 'number') out.counts[k] = (out.counts[k] || 0) + n; };
  let slowest = 0;
  let steps = 0;
  const enough = () => steps > 0 && clock() - started + Math.max(slowest, 1500) > budgetMs;
  const timed = async (fn) => { const t0 = clock(); try { return await fn(); } finally { slowest = Math.max(slowest, clock() - t0); steps++; } };
  let done = false;
  let reconnect = false;
  try {
    while (!done) {
      if (enough()) { out.next = cur; break; }
      if (cur.pages >= MAX_PAGES) throw new GoogleError(`More than ${MAX_PAGES} pages of Google reviews; stopped to be safe`);
      const p = await timed(() => client.reviews({ account: i0.accountId, location: i0.locationId, pageToken: cur.pageToken }));
      const fresh = p.reviews.filter((r) => !r.updateTime || String(r.updateTime) >= cur.since);
      if (fresh.length) {
        const r = await timed(() => db.run((store) => {
          const svc = createService(store);
          return applyGoogleReviews({ store, impact: svc.impact, fail: failWith }, fresh, { timeZone, importId: `api_${cur.runId}`, backfill: cur.backfill });
        }, { write: true, onCommit }));
        add(r.counts); add({ replies: r.replies });
      }
      const olderSeen = fresh.length < p.reviews.length; // the rest changed before `since`
      if (!p.nextPageToken || olderSeen) done = true;
      else cur = { ...cur, pageToken: p.nextPageToken, pages: cur.pages + 1 };
    }
  } catch (e) {
    out.ok = false;
    out.error = e instanceof GoogleError ? e.message : `Sync failed: ${e.message}`;
    reconnect = e instanceof GoogleError && e.code === 'invalid_grant';
    if (!(e instanceof GoogleError)) console.error('Google sync failed:', e);
    out.next = null;
  }
  if (reconnect) out.reconnect = true;
  const finished = out.ok && !out.next;
  await db.run((store) => {
    const i = integration(store);
    const prev = i.lastSync?.runId === cur.runId ? i.lastSync : null;
    const counts = { ...(prev?.counts || {}) };
    for (const [k, n] of Object.entries(out.counts)) counts[k] = (counts[k] || 0) + n;
    const lastSync = { runId: cur.runId, at: stamp(), by, since: cur.since, counts, ok: out.ok, error: out.error || null, finished };
    const patch = { lastSync, history: [lastSync, ...(i.history || []).filter((h) => h.runId !== cur.runId)].slice(0, 10) };
    if (by === 'cron') { patch.lastCron = lastSync; patch.cronCursor = out.next ? { ...out.next, savedAt: stamp() } : null; }
    if (finished) Object.assign(patch, { lastFullAt: cur.startedAt, firstSyncAt: i.firstSyncAt || stamp(), needsReconnect: false });
    if (reconnect) patch.needsReconnect = true;
    saveIntegration(store, patch);
  }, { write: true }).catch((e) => console.error('Could not save Google sync status:', e.message));
  return out;
}
