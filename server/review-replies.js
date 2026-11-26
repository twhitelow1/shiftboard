// Answering reviews from ShiftBoard (managers): an AI draft, then post it to Google (or edit or delete it there),
// or copy it for Yelp and OpenTable, where there's no API to reply. Mounted by server/app.js (the plan's
// `reviews` feature gates /api/reviews).
//   GET  /api/reviews/ai            { available, reason? }: is the built-in Claude module set up for this restaurant
//   POST /api/reviews/draft         { id } → { available, text } (available false: "AI drafts aren't set up")
//   POST /api/reviews/reply         { id, text }: post (or replace) the reply on Google
//   POST /api/reviews/reply/delete  { id }: delete it from Google
//   GET  /api/cron/reviews          Vercel Cron, daily: Google, then Yelp (a single-restaurant install; the
//                                   platform runs every restaurant from server/platform/index.js)
// Every draft, post, edit and delete is in the restaurant's audit log (who, which review; never the review's text).
//
// The AI: server/ai/index.js (built alongside this) exports aiFor({ db, tenant, env, now, lang? }), synchronous →
// { available, reason?: 'no_key' | 'off' | 'cap' | 'plan', complete({ purpose, system, messages, maxTokens, user }) },
// metered and capped per restaurant; complete() throws AiUnavailable (with .reason and a friendly message) when it
// can't run. Review replies need the plan feature 'reviews' in its AI_FEATURES. It's loaded when first needed and
// only if it's there: without it, or when it isn't available, the page shows "AI drafts aren't set up" (or "this
// month's AI limit is reached" for 'cap') and the manager writes the reply. Never sent to it: a staff member's last
// name, anyone's schedule, or Yelp's review text (Yelp's API terms forbid it).
import { canManageSchedule } from '../core/roles.js';
import { uid } from '../core/store.js';
import { createService } from '../core/service.js';
import { draftReply, staffForReply, replySettings, MAX_REPLY } from '../core/review-reply.js';
import { integration as googleIntegration, recordReply } from '../core/google-reviews.js';
import { googleConfig, GoogleError } from './google.js';
import { cronAuthorized } from './toast-routes.js';

export const NOT_SET_UP = 'AI drafts aren’t set up';
export const YELP_NO_AI = 'Yelp’s terms don’t allow sending its reviews to an AI. Paste the full review from Yelp for Business to draft a reply, or write one yourself.';

/**
 * The AI module for this restaurant, or { available: false, reason } when it isn't installed or set up.
 * importer: how to load server/ai/index.js (tests pass their own).
 */
export async function loadAi({ db, tenant = null, env, now, importer = () => import('./ai/index.js') }) {
  let mod;
  try { mod = await importer(); } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|Failed to load|not found/i.test(String(e?.message))) return { available: false, reason: 'missing' };
    console.error('Loading the AI module failed:', e);
    return { available: false, reason: 'error' };
  }
  if (typeof mod?.aiFor !== 'function') return { available: false, reason: 'missing' };
  try {
    const ai = await mod.aiFor({ db, tenant, env, now }); // synchronous today; awaiting is harmless
    if (!ai?.available || typeof ai.complete !== 'function') return { available: false, reason: ai?.reason || 'off' };
    return ai;
  } catch (e) {
    console.error('The AI module failed:', e);
    return { available: false, reason: 'error' };
  }
}

/**
 * @param {import('express').Express} app
 * @param {object} o  { db, env, tenant, userOf, now, onCommit, google (mountGoogle's { clientFor, tokenOf }), aiImporter }
 */
export function mountReviewReplies(app, { db, env, tenant = null, userOf, now = () => Date.now(), onCommit = () => {}, google, aiImporter }) {
  const iso = () => new Date(now()).toISOString();
  const audit = (store, actorId, action, details = {}) => store.insert('auditLog', { id: uid('aud'), at: iso(), actorId, targetId: null, action, details });
  const manager = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canManageSchedule(u)) { res.status(403).json({ error: 'Managers only' }); return null; }
    res.set('Cache-Control', 'no-store');
    return u;
  };
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  const ai = () => loadAi({ db, tenant, env, now, ...(aiImporter ? { importer: aiImporter } : {}) });

  app.get('/api/reviews/ai', async (req, res) => {
    if (!(await manager(req, res))) return;
    const a = await ai();
    res.json({ result: { available: !!a.available, ...(a.available ? {} : { reason: a.reason || 'off' }) } });
  });

  app.post('/api/reviews/draft', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const b = body(req);
    if (b.ref) return res.status(400).json({ error: YELP_NO_AI }); // one of Yelp's excerpts
    const review = db.store.get('guestReviews', String(b.id || ''));
    if (!review) return res.status(404).json({ error: 'That review is gone' });
    if (review.source === 'yelp' && review.origin === 'api') return res.status(400).json({ error: YELP_NO_AI });
    const a = await ai();
    if (!a.available) return res.json({ result: { available: false, reason: a.reason || 'off' } });
    const { staff, lastNames } = staffForReply(db.store, review.id);
    const restaurant = createService(db.store).settings().restaurantName;
    try {
      const d = await draftReply({ complete: (o) => a.complete(o), restaurant, review, staff, lastNames, settings: replySettings(db.store), user: { id: u.id, name: u.name, role: u.role, language: u.language || null } });
      if (!d.text) return res.status(502).json({ error: 'The AI didn’t write a draft. Try again, or write the reply yourself.' });
      await db.run((store) => audit(store, u.id, 'reviews.drafted', { reviewId: review.id, source: review.source, stopReason: d.stopReason }), { write: true }).catch(() => {});
      res.json({ result: { available: true, text: d.text, usage: d.usage || null } });
    } catch (e) {
      // The AI module's AiUnavailable: not set up, switched off, not in the plan, or this month's cap reached.
      if (e?.name === 'AiUnavailable' || (e?.reason && ['no_key', 'off', 'cap', 'plan'].includes(e.reason))) {
        return res.json({ result: { available: false, reason: e.reason || 'off', ...(typeof e.message === 'string' ? { message: e.message } : {}) } });
      }
      const status = Number(e?.status) || 0;
      if (status === 429 || /limit|cap|quota/i.test(String(e?.message))) return res.status(429).json({ error: 'This restaurant’s AI drafts for this month are used up. Write the reply yourself, or try again next month.' });
      console.error('AI draft failed:', e);
      res.status(502).json({ error: 'The AI didn’t write a draft. Try again, or write the reply yourself.' });
    }
  });

  /** The review and a Google client for it, or an error answered. */
  async function googleReview(req, res) {
    const u = await manager(req, res);
    if (!u) return null;
    const review = db.store.get('guestReviews', String(body(req).id || ''));
    if (!review) { res.status(404).json({ error: 'That review is gone' }); return null; }
    if (review.source !== 'google' || !review.google?.name) { res.status(400).json({ error: 'Only Google reviews synced from Google can be answered from ShiftBoard. Copy the reply and post it on the review site.' }); return null; }
    const g = googleIntegration(db.store);
    if (!googleConfig(env).configured || !g.refreshTokenEnc || !google) { res.status(400).json({ error: 'Connect Google first' }); return null; }
    if (!review.google.name.startsWith(`${g.accountId}/${g.locationId}/`)) { res.status(400).json({ error: 'That review is from another Google location. Sync again.' }); return null; }
    let client;
    try { client = google.clientFor(google.tokenOf()); } catch { res.status(409).json({ error: 'Connect Google again: ShiftBoard can’t read its saved access (the encryption key changed).' }); return null; }
    return { u, review, client };
  }
  const googleFail = (res, e) => {
    if (!(e instanceof GoogleError)) console.error('Google reply:', e);
    if (e instanceof GoogleError && e.code === 'invalid_grant') db.run((s) => { if (s.get('integrations', 'google')) s.update('integrations', 'google', { needsReconnect: true }); }, { write: true }).catch(() => {});
    res.status(e instanceof GoogleError ? (e.status === 401 ? 409 : e.status >= 400 && e.status < 600 ? e.status : 502) : 500).json({ error: e instanceof GoogleError ? e.message : 'Something went wrong' });
  };

  app.post('/api/reviews/reply', async (req, res) => {
    const x = await googleReview(req, res);
    if (!x) return;
    const text = String(body(req).text ?? '').replace(/\r/g, '').trim();
    if (!text) return res.status(400).json({ error: 'Write the reply first' });
    if (Buffer.byteLength(text) > 4096 || text.length > MAX_REPLY) return res.status(400).json({ error: 'That reply is too long for Google. Keep it under 4,000 characters.' });
    try {
      const r = await x.client.updateReply(x.review.google.name, text);
      const edited = x.review.replied && x.review.replySource === 'google';
      const saved = await db.run((store) => {
        const doc = recordReply(store, x.review.id, { comment: String(r?.comment ?? text), state: r?.reviewReplyState || null, by: x.u.id, at: iso() });
        audit(store, x.u.id, edited ? 'reviews.replyEdited' : 'reviews.replyPosted', { reviewId: x.review.id, source: 'google', chars: text.length });
        return doc;
      }, { write: true, onCommit: (c) => onCommit(c, req) });
      res.json({ result: { id: saved.id, replied: true, reply: saved.reply, replyState: saved.google?.replyState || null } });
    } catch (e) { googleFail(res, e); }
  });

  app.post('/api/reviews/reply/delete', async (req, res) => {
    const x = await googleReview(req, res);
    if (!x) return;
    try {
      await x.client.deleteReply(x.review.google.name);
      await db.run((store) => {
        recordReply(store, x.review.id, { deleted: true });
        audit(store, x.u.id, 'reviews.replyDeleted', { reviewId: x.review.id, source: 'google' });
      }, { write: true });
      res.json({ result: { id: x.review.id, replied: false } });
    } catch (e) { googleFail(res, e); }
  });

  // The daily review sync for a single-restaurant install: Google, then Yelp.
  app.get('/api/cron/reviews', async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    const google = app.locals.googleCron ? await app.locals.googleCron().catch((e) => ({ ok: false, error: e.message })) : { skipped: 'Not mounted' };
    const yelp = app.locals.yelpCron ? await app.locals.yelpCron().catch((e) => ({ ok: false, error: e.message })) : { skipped: 'Not mounted' };
    res.status(google.ok === false || yelp.ok === false ? 502 : 200).json({ result: { google, yelp } });
  });
}
