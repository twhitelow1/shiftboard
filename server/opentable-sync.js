// Pull OpenTable reservations (and reviews, when the restaurant granted the Reviews API too) inside a time
// budget, so each call fits Vercel's 30 s limit; what doesn't fit comes back as `next` and the caller (Sync
// now, or the next cron run) carries on. Every write goes through core/opentable.js with OpenTable's own ids,
// so running any part again never double-counts, and an import of the same bookings from a file lands on
// the same documents (both are keyed by the confirmation number).
//
// One run, in phases:
//   reservations  changed since the last finished run (a day of overlap), or the last 400 days the first time
//   reviews       the same; a 403/404 means this application has no Reviews API grant: a warning, not a failure
import { addDays, todayStr } from '../core/time.js';
import { createService } from '../core/service.js';
import { integration, saveIntegration, readApiReservation, readApiReview, cleanReservationItems } from '../core/opentable.js';
import { cleanReviewItems } from '../core/impact.js';
import { createOpenTableClient, OpenTableError } from './opentable.js';

export const FIRST_DAYS = 400; // the first sync reaches back a year and a bit (last year's same season)
const MAX_PAGES = 200;
const stamp = () => new Date().toISOString();
const failWith = (status, message) => { throw new OpenTableError(message, status); };

export function newCursor(store, { runId, today = todayStr() } = {}) {
  const i = integration(store);
  const last = i.lastFullAt ? String(i.lastFullAt).slice(0, 10) : null;
  return { runId: String(runId || Math.random().toString(36).slice(2, 10)).slice(0, 40), phase: 'reservations', offset: 0,
    since: `${last ? addDays(last, -1) : addDays(today, -FIRST_DAYS)}T00:00:00Z`, startedAt: stamp(), pages: 0 };
}
/** A cursor that came back from the browser, checked. */
export function cleanCursor(c) {
  if (!c || typeof c !== 'object' || !['reservations', 'reviews'].includes(c.phase)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(String(c.since || ''))) return null;
  return { runId: String(c.runId || '').slice(0, 40) || null, phase: c.phase, offset: Math.min(Math.max(0, Math.floor(Number(c.offset) || 0)), 1e6),
    since: c.since, startedAt: typeof c.startedAt === 'string' ? c.startedAt.slice(0, 40) : stamp(), pages: Math.min(Math.floor(Number(c.pages) || 0), MAX_PAGES) };
}

/**
 * @returns {Promise<{ ok, next, counts, warnings?, error? }>}
 */
export async function runOpenTableSync({ db, env = process.env, client, cursor = null, by = null, budgetMs = 18_000, clock = () => Date.now(), onCommit, today = todayStr() }) {
  const started = clock();
  client ||= createOpenTableClient({ env });
  const timeZone = env.TIMEZONE || process.env.TZ || '';
  await db.sync();
  let cur = cleanCursor(cursor) || newCursor(db.store, { today });
  if (!cur.runId) cur.runId = newCursor(db.store, { today }).runId;
  const out = { ok: true, next: null, counts: {}, runId: cur.runId };
  const warnings = [];
  const add = (prefix, counts) => { for (const [k, n] of Object.entries(counts || {})) if (typeof n === 'number') out.counts[`${prefix}${k[0].toUpperCase()}${k.slice(1)}`] = (out.counts[`${prefix}${k[0].toUpperCase()}${k.slice(1)}`] || 0) + n; };
  let slowest = 0;
  let steps = 0;
  const enough = () => steps > 0 && clock() - started + Math.max(slowest, 1500) > budgetMs;
  const timed = async (fn) => { const t0 = clock(); try { return await fn(); } finally { slowest = Math.max(slowest, clock() - t0); steps++; } };
  const importId = `api_${cur.runId}`;

  try {
    while (cur.phase !== 'done') {
      if (enough()) { out.next = cur; break; }
      if (cur.pages >= MAX_PAGES) throw new OpenTableError(`More than ${MAX_PAGES} pages of ${cur.phase}; stopped to be safe`);
      if (cur.phase === 'reservations') {
        const p = await timed(() => client.reservations({ since: cur.since, offset: cur.offset }));
        const items = p.rows.map((r) => readApiReservation(r, { timeZone })).filter((r) => r && r.partySize >= 1);
        if (items.length) {
          const r = await timed(() => db.run((store) => createService(store).opentable.applyReservations(cleanReservationItems(items, { fail: failWith }), { origin: 'api', importId }), { write: true, onCommit }));
          add('reservations', r.counts);
        }
        cur = p.more ? { ...cur, offset: cur.offset + p.rows.length, pages: cur.pages + 1 } : { ...cur, phase: 'reviews', offset: 0, pages: 0 };
      } else if (cur.phase === 'reviews') {
        let p;
        try {
          p = await timed(() => client.reviews({ since: cur.since, offset: cur.offset }));
        } catch (e) {
          if (e instanceof OpenTableError && [403, 404].includes(e.status)) { warnings.push({ code: 'reviews', error: e.message }); cur = { ...cur, phase: 'done' }; continue; }
          throw e;
        }
        const items = p.rows.map((r) => readApiReview(r, { timeZone })).filter(Boolean);
        if (items.length) {
          const r = await timed(() => db.run((store) => createService(store).opentable.applyReviews(cleanReviewItems(items, { source: 'opentable', fail: failWith }), { origin: 'api', importId }), { write: true, onCommit }));
          add('reviews', r.counts);
        }
        cur = p.more ? { ...cur, offset: cur.offset + p.rows.length, pages: cur.pages + 1 } : { ...cur, phase: 'done' };
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = e instanceof OpenTableError ? e.message : `Sync failed: ${e.message}`;
    if (!(e instanceof OpenTableError)) console.error('OpenTable sync failed:', e);
    out.next = null;
  }
  if (warnings.length) out.warnings = warnings;

  const finished = out.ok && !out.next;
  await db.run((store) => {
    const i = integration(store);
    const prev = i.lastSync?.runId === cur.runId ? i.lastSync : null;
    const counts = { ...(prev?.counts || {}) };
    for (const [k, n] of Object.entries(out.counts)) counts[k] = (counts[k] || 0) + n;
    const lastSync = { runId: cur.runId, at: stamp(), by, since: cur.since, counts, ok: out.ok, error: out.error || null,
      warnings: [...(prev?.warnings || []), ...warnings].filter((w, k, a) => a.findIndex((x) => x.code === w.code) === k), finished };
    const patch = { lastSync, history: [lastSync, ...(i.history || []).filter((h) => h.runId !== cur.runId)].slice(0, 10) };
    if (by === 'cron') { patch.lastCron = lastSync; patch.cronCursor = out.next ? { ...out.next, savedAt: stamp() } : null; }
    if (finished) Object.assign(patch, { lastFullAt: cur.startedAt, firstSyncAt: i.firstSyncAt || stamp() });
    saveIntegration(store, patch);
  }, { write: true }).catch((e) => console.error('Could not save OpenTable sync status:', e.message));
  return out;
}
