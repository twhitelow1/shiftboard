// HTTP routes for the Toast integration. Mounted by server/app.js.
//   GET  /api/toast/status  managers: is Toast configured (env names only, never values)
//   POST /api/toast/sync    managers: sync a date range, one chunk per call (the UI keeps calling with `next`)
//   GET  /api/cron/toast    Vercel Cron, daily. Requires Authorization: Bearer <CRON_SECRET>.
import crypto from 'node:crypto';
import { canManageSchedule } from '../core/roles.js';
import { createToastClient, toastConfig } from './toast.js';
import { runToastSync, syncRange, cronRange } from './toast-sync.js';

const BUDGET_MS = 18_000; // leaves room inside the 30 s function limit for boot and the final write

/** Constant-time check of the cron's Authorization header against CRON_SECRET. Fails closed. */
export function cronAuthorized(header, secret) {
  const want = String(secret || '').trim();
  if (!want) return false;
  const got = String(header || '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${want}`).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} o.env
 * @param {(req) => object|null} o.userOf   the signed-in user for a request (after db.sync)
 */
export function mountToast(app, { db, env, userOf, budgetMs = BUDGET_MS }) {
  const manager = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canManageSchedule(u)) { res.status(403).json({ error: 'Managers only' }); return null; }
    return u;
  };

  app.get('/api/toast/status', async (req, res) => {
    if (!(await manager(req, res))) return;
    const { configured, missing, host, cron } = toastConfig(env);
    res.json({ result: { configured, missing, host, cron } });
  });

  app.post('/api/toast/sync', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const cfg = toastConfig(env);
    if (!cfg.configured) return res.status(400).json({ error: `Toast isn’t set up yet. Add ${cfg.missing.join(', ')} in Vercel, then redeploy.` });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { from, to } = syncRange({ from: b.from, to: b.to });
    const run = b.run && typeof b.run === 'object'
      ? { id: String(b.run.id || '').slice(0, 40) || null, from: syncRange({ from: b.run.from, to: b.run.to }).from, to: syncRange({ from: b.run.from, to: b.run.to }).to }
      : null;
    const out = await runToastSync({
      db, env, client: createToastClient({ env }), from, to, refresh: b.refresh !== false, replaceManual: !!b.replaceManual, by: u.id, run, budgetMs,
    });
    if (!out.ok) return res.status(502).json({ error: out.error, result: out });
    res.json({ result: out });
  });

  app.get('/api/cron/toast', async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    if (!toastConfig(env).configured) return res.json({ result: { skipped: 'Toast is not set up' } });
    await db.sync();
    const { from, to } = cronRange(db.store);
    const out = await runToastSync({ db, env, client: createToastClient({ env }), from, to, refresh: true, by: 'cron', budgetMs });
    res.status(out.ok ? 200 : 502).json({ result: { ok: out.ok, from, to, days: out.done.length, next: out.next, error: out.error || null } });
  });
}
