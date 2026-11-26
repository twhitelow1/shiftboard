// Google Business Profile reviews → ShiftBoard: the mapping and the store side (no network; server/google.js
// talks to Google, server/google-sync.js runs a sync, server/google-routes.js has the connect and reply routes).
//
// A Google review (mybusiness v4 accounts.locations.reviews: name, reviewId, reviewer { displayName,
// isAnonymous }, starRating ONE…FIVE, comment, createTime, updateTime, reviewReply { comment, updateTime,
// reviewReplyState }) becomes an import item for core/impact.js applyReviews with source 'google', origin 'api'
// and a key made from Google's reviewId, so syncing again (or after a CSV import of the same review) never
// counts twice. Google's own fields are kept on the review under `google` ({ name, updateTime, replyState }):
// `name` is what a reply is posted to. An owner's reply already on Google is brought in as the review's reply.
//
// integrations 'google' (one per restaurant): the chosen account and location, refreshTokenEnc (the OAuth
// refresh token, sealed with server/secret-box.js; never sent to a browser), connectedAt/By, lastSync,
// lastCron, cronCursor, lastFullAt, firstSyncAt, history, needsReconnect.
import { localStamp } from './toast.js';
import { cleanId, hashKey } from './guest-csv.js';
import { cleanReviewItems } from './impact.js';

export const INTEGRATION_ID = 'google';
export const SOURCE = 'google';
export const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const NAME_RE = /^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/;

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID) ? store.update('integrations', INTEGRATION_ID, patch) : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}

/** Google's star rating ('ONE'…'FIVE', or a number) → 1–5, or null (STAR_RATING_UNSPECIFIED). */
export const starsOf = (v) => (typeof v === 'number' ? (v >= 1 && v <= 5 ? Math.round(v) : null) : STARS[String(v || '').toUpperCase()] || null);

/**
 * The guest's own words. Google adds a machine translation to some reviews ("…(Translated by Google)…" with
 * the "(Original)" after it, or the original first): keep the original. UNVERIFIED: the markers are what
 * reviews have been seen to carry; Google doesn't document them.
 */
export function originalText(comment) {
  const s = String(comment ?? '');
  const orig = s.indexOf('(Original)');
  if (orig >= 0 && s.includes('(Translated by Google)') && s.indexOf('(Translated by Google)') < orig) return s.slice(orig + '(Original)'.length).trim();
  const tr = s.indexOf('(Translated by Google)');
  return (tr > 0 ? s.slice(0, tr) : s).trim();
}

/** One review from Google → { item (for applyReviews), google: { name, updateTime, reply } }, or null. */
export function readGoogleReview(raw, { timeZone } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '');
  const reviewId = String(raw.reviewId || name.split('/').pop() || '');
  const rating = starsOf(raw.starRating);
  const created = localStamp(raw.createTime || raw.updateTime, timeZone);
  if (!reviewId || !rating || !created) return null;
  const reply = raw.reviewReply && typeof raw.reviewReply === 'object' && String(raw.reviewReply.comment || '').trim()
    ? { comment: String(raw.reviewReply.comment).replace(/\r/g, '').trim().slice(0, 4096), updateTime: String(raw.reviewReply.updateTime || ''), state: String(raw.reviewReply.reviewReplyState || '') } : null;
  return {
    item: {
      key: `i_g${hashKey(`google|${reviewId}`)}`, externalId: cleanId(reviewId), source: SOURCE, date: created.slice(0, 10), diningDate: '',
      rating, text: originalText(raw.comment), reviewer: raw.reviewer?.isAnonymous ? 'A Google user' : String(raw.reviewer?.displayName || ''), server: '',
    },
    google: { name: NAME_RE.test(name) ? name : '', reviewId, updateTime: String(raw.updateTime || ''), reply },
  };
}

/**
 * Save a page of Google reviews. impact: the bound core/impact.js. Returns { counts, replies } (replies: how many
 * reviews' replies changed from Google's side).
 */
export function applyGoogleReviews({ store, impact, fail }, rows, { timeZone, importId = null, backfill = false } = {}) {
  const read = (Array.isArray(rows) ? rows : []).map((r) => readGoogleReview(r, { timeZone })).filter(Boolean);
  if (!read.length) return { counts: { new: 0, updated: 0, same: 0, duplicate: 0, fiveStar: 0 }, replies: 0 };
  const byKey = new Map(read.map((x) => [x.item.key, x.google]));
  const items = cleanReviewItems(read.map((x) => x.item), { source: SOURCE, fail });
  const plan = impact.planReviews(items);
  const r = impact.applyReviews(items, { origin: 'api', importId, backfill });
  let replies = 0;
  for (const row of plan.rows) {
    if (row.status === 'duplicate') continue;
    const g = byKey.get(row.key);
    const doc = store.get('guestReviews', row.id);
    if (!g || !doc) continue;
    const patch = { google: { name: g.name || doc.google?.name || '', reviewId: g.reviewId, updateTime: g.updateTime, replyState: g.reply?.state || null } };
    if (g.reply && (doc.reply !== g.reply.comment || !doc.replied)) {
      Object.assign(patch, { replied: true, reply: g.reply.comment, repliedAt: g.reply.updateTime || null, replySource: 'google' });
      replies++;
    } else if (!g.reply && doc.replied && doc.replySource === 'google') { // deleted on Google
      Object.assign(patch, { replied: false, reply: '', repliedAt: null, repliedBy: null, replySource: null });
      replies++;
    }
    store.update('guestReviews', doc.id, patch);
  }
  return { counts: r.counts, replies };
}

/** A reply posted to (or deleted from) Google through ShiftBoard, on the review. */
export function recordReply(store, reviewId, { comment = '', state = null, by, at, deleted = false }) {
  const r = store.get('guestReviews', reviewId);
  if (!r) return null;
  return store.update('guestReviews', reviewId, deleted
    ? { replied: false, reply: '', repliedAt: null, repliedBy: null, replySource: null, google: { ...(r.google || {}), replyState: null } }
    : { replied: true, reply: comment, repliedAt: at, repliedBy: by, replySource: 'google', google: { ...(r.google || {}), replyState: state || 'PENDING' } });
}

/** What Settings shows about the connection (never the token). */
export function googleView(store) {
  const i = integration(store);
  const by = i.connectedBy ? store.get('users', i.connectedBy) : null;
  return {
    connected: !!i.refreshTokenEnc, needsReconnect: !!i.needsReconnect,
    account: i.accountId ? { id: i.accountId, name: i.accountName || '' } : null,
    location: i.locationId ? { id: i.locationId, title: i.locationTitle || '', address: i.locationAddress || '' } : null,
    connectedAt: i.connectedAt || null, connectedBy: by?.name || '',
    lastSync: i.lastSync || null, lastCron: i.lastCron || null,
  };
}
