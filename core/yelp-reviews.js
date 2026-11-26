// Yelp's review excerpts, from its API (server/yelp.js fetches them, server/yelp-sync.js runs a sync).
//
// What Yelp allows (docs/integrations/GOOGLE-YELP.md has the sources):
//   * the reviews endpoint gives up to 3 excerpts per business (the Enhanced plan; Premium up to 7), each cut
//     short, with a link to the full review on Yelp; there is no API to reply;
//   * its API terms say no Yelp content is kept longer than 24 hours (business IDs are the exception), and no
//     Yelp content goes into a generative AI model, prompts included.
// So the excerpts live in their own collection, yelpExcerpts, and every read and sync deletes the ones older than
// 24 hours. They never go through core/impact.js applyReviews (that keeps reviews for good) and never to the AI
// drafter. Staff names in them are found when they're shown (nothing about them is stored), and the managers'
// alert for a new one names the stars and the staff, never Yelp's words. To keep a Yelp review for good (in
// Positive impact's counts, with an AI draft), a manager pastes the full review from Yelp for Business
// (reviews.add) or imports Yelp's export (Kudos → import reviews), as before.
//
// Kept in integrations 'yelp' (no Yelp content): seen (one-way hashes of the review ids, so a review alerts
// once), replied (the same hashes, marked by a manager), lastSync / lastCron / firstSyncAt / history.
import { scrub, shortName, hashKey } from './guest-csv.js';
import { findMentions, resolveHit } from './impact.js';

export const INTEGRATION_ID = 'yelp';
export const KEEP_MS = 24 * 3_600_000; // Yelp's API terms: 24 hours at most
export const MAX_SEEN = 300;
const DAY = /^\d{4}-\d{2}-\d{2}/;

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID) ? store.update('integrations', INTEGRATION_ID, patch) : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}

/** A one-way reference for a Yelp review id (what's kept after the excerpt is gone). */
export const refOf = (id) => `y${hashKey(`yelp|${id}`)}`;
const docId = (ref) => `yx_${ref}`;

/** One review from Yelp's reviews endpoint → an excerpt, or null. */
export function readYelpReview(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const rating = Number(raw.rating);
  if (!(rating >= 1 && rating <= 5)) return null;
  const url = /^https:\/\/([a-z0-9-]+\.)*yelp\.[a-z.]+\//i.test(String(raw.url || '')) ? String(raw.url).slice(0, 500) : '';
  const created = String(raw.time_created || '');
  return {
    ref: refOf(raw.id), rating: Math.round(rating), text: scrub(raw.text, 600), url,
    date: DAY.test(created) ? created.slice(0, 10) : '', reviewer: shortName(raw.user?.name),
  };
}

/** Delete excerpts older than 24 hours. Returns how many went. */
export function pruneExcerpts(store, now = new Date()) {
  const cutoff = now.getTime() - KEEP_MS;
  let n = 0;
  for (const x of store.list('yelpExcerpts', (d) => !(Date.parse(d.fetchedAt) > cutoff))) { store.remove('yelpExcerpts', x.id); n++; }
  return n;
}

/**
 * Save a sync's excerpts (each one's 24 hours start again) and drop the old ones. Returns the ones never seen
 * before (for the alerts) and the counts.
 */
export function upsertExcerpts(store, excerpts, { now = new Date() } = {}) {
  pruneExcerpts(store, now);
  const i = integration(store);
  const seen = new Set(Array.isArray(i.seen) ? i.seen : []);
  const fresh = [];
  const at = now.toISOString();
  for (const x of excerpts) {
    if (!x?.ref) continue;
    const cur = store.get('yelpExcerpts', docId(x.ref));
    const doc = { ref: x.ref, rating: x.rating, text: x.text, url: x.url, date: x.date, reviewer: x.reviewer, fetchedAt: at };
    if (cur) store.update('yelpExcerpts', cur.id, doc); else store.insert('yelpExcerpts', { id: docId(x.ref), ...doc });
    if (!seen.has(x.ref)) { fresh.push(x); seen.add(x.ref); }
  }
  saveIntegration(store, { seen: [...seen].slice(-MAX_SEEN) });
  return { fresh, counts: { excerpts: excerpts.length, new: fresh.length } };
}

/** Staff an excerpt names, worked out now (nothing stored): { spans, people: [{ userId, name, status }] }. */
export function namesIn(textValue, team) {
  if (!team) return { spans: [], people: [] };
  const spans = [];
  const people = [];
  for (const hit of findMentions(textValue, team, {})) {
    const r = resolveHit(hit, {});
    spans.push(...hit.spans);
    const p = r.userId ? team.people.get(r.userId) : null;
    people.push({ userId: r.userId, name: p?.name || hit.token, status: r.status });
  }
  return { spans, people };
}

/** The excerpts to show (the last 24 hours), newest first, with the names in them and whether they were answered. */
export function excerptsFor(store, { now = new Date(), team = null } = {}) {
  pruneExcerpts(store, now);
  const replied = integration(store).replied || {};
  return store.list('yelpExcerpts').sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((x) => ({
    ref: x.ref, source: 'yelp', rating: x.rating, text: x.text, url: x.url, date: x.date, reviewer: x.reviewer, fetchedAt: x.fetchedAt,
    replied: !!replied[x.ref], ...namesIn(x.text, team),
  }));
}

/** Mark an excerpt answered (or not). False when there's no such excerpt now. */
export function markExcerpt(store, ref, replied, { at, by } = {}) {
  if (!store.get('yelpExcerpts', docId(ref))) return false;
  const cur = { ...(integration(store).replied || {}) };
  if (replied) cur[ref] = { at, by }; else delete cur[ref];
  const keep = Object.entries(cur).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at))).slice(0, MAX_SEEN);
  saveIntegration(store, { replied: Object.fromEntries(keep) });
  return true;
}
