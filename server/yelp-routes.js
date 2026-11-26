// Yelp: finding the restaurant's business and pulling the review excerpts Yelp's API gives. Mounted by
// server/app.js (the plan's `reviews` feature gates /api/yelp).
//   GET  /api/yelp/status    managers: key and business set (names only), the last sync
//   GET  /api/yelp/lookup    admins: ?id=<id or alias>, or ?term=<name>&location=<city>: candidates to pick
//                            (the pick is saved as YELP_BUSINESS_ID through Settings → Integrations)
//   POST /api/yelp/sync      managers: fetch the excerpts now
// The daily run is app.locals.yelpCron (/api/cron/reviews). What's kept and for how long: core/yelp-reviews.js.
import { canManageSchedule, canChangeSettings } from '../core/roles.js';
import { createService } from '../core/service.js';
import { integration, saveIntegration } from '../core/yelp-reviews.js';
import { createYelpClient, yelpConfig, YelpError } from './yelp.js';

const stamp = () => new Date().toISOString();

/** One sync: Yelp's excerpts for the business, saved for 24 hours, alerts for new ones. */
export async function runYelpSync({ db, env = process.env, client, by = null, onCommit }) {
  client ||= createYelpClient({ env });
  const cfg = yelpConfig(env);
  await db.sync();
  const first = !integration(db.store).firstSyncAt;
  let out;
  try {
    const rows = await client.reviews(cfg.businessId);
    const counts = await db.run((store) => createService(store).reviews.applyYelp(rows, { backfill: first }), { write: true, onCommit });
    out = { ok: true, counts };
  } catch (e) {
    if (!(e instanceof YelpError)) console.error('Yelp sync failed:', e);
    out = { ok: false, counts: {}, error: e instanceof YelpError ? e.message : `Sync failed: ${e.message}`, status: e.status || 0 };
  }
  await db.run((store) => {
    const i = integration(store);
    const lastSync = { at: stamp(), by, ok: out.ok, counts: out.counts, error: out.error || null };
    saveIntegration(store, { lastSync, history: [lastSync, ...(i.history || [])].slice(0, 10), ...(by === 'cron' ? { lastCron: lastSync } : {}), ...(out.ok ? { firstSyncAt: i.firstSyncAt || stamp() } : {}) });
  }, { write: true }).catch((e) => console.error('Could not save Yelp sync status:', e.message));
  return out;
}

/**
 * @param {import('express').Express} app
 * @param {object} o  { db, env, userOf, onCommit, makeClient }
 */
export function mountYelp(app, { db, env, userOf, onCommit = () => {}, makeClient = () => createYelpClient({ env }), managed = false }) {
  const who = (check, label) => async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!check(u)) { res.status(403).json({ error: label }); return null; }
    res.set('Cache-Control', 'no-store');
    return u;
  };
  const manager = who(canManageSchedule, 'Managers only');
  const admin = who(canChangeSettings, 'Admins only');
  const fail = (res, e) => {
    if (!(e instanceof YelpError)) console.error('Yelp:', e);
    res.status(e instanceof YelpError && e.status >= 400 ? (e.status === 401 ? 409 : e.status) : 502).json({ error: e instanceof YelpError ? e.message : 'Something went wrong' });
  };

  app.get('/api/yelp/status', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const { configured, missing, hasKey, businessId, cron } = yelpConfig(env);
    const i = integration(db.store);
    res.json({ result: { configured, missing, hasKey, businessId, cron, managed, canEdit: canChangeSettings(u), lastSync: i.lastSync || null, lastCron: i.lastCron || null } });
  });

  app.get('/api/yelp/lookup', async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      const yelp = makeClient();
      const id = String(req.query.id || '').trim().replace(/^https:\/\/(www\.)?yelp\.[a-z.]+\/biz\//i, '').split(/[?#/]/)[0];
      const list = id ? [await yelp.business(id)] : await yelp.search(req.query.term, req.query.location);
      res.json({ result: { businesses: list } });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/yelp/sync', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const cfg = yelpConfig(env);
    if (!cfg.configured) return res.status(400).json({ error: 'Add the Yelp API key and pick the business first' });
    const out = await runYelpSync({ db, env, client: makeClient(), by: u.id, onCommit: (c) => onCommit(c, req) });
    if (!out.ok) return res.status(out.status === 429 ? 429 : 502).json({ error: out.error, result: out });
    res.json({ result: out });
  });

  app.locals.yelpCron = async ({ base = '' } = {}) => {
    if (!yelpConfig(env).configured) return { skipped: 'Yelp is not set up' };
    const at = base ? new URL(base) : null;
    const linkReq = at ? { protocol: at.protocol.replace(':', ''), get: () => at.host } : null;
    const out = await runYelpSync({ db, env, client: makeClient(), by: 'cron', onCommit: (c) => onCommit(c, linkReq) });
    return { ok: out.ok, counts: out.counts, error: out.error || null };
  };
}
