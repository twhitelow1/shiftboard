// HTTP routes for the ADP API sync. Mounted by server/app.js. (The CSV import needs no route: the
// browser reads the file and sends punches to the adp.previewImport / adp.importCsv RPC methods.)
//   GET  /api/adp/status  managers: is ADP configured (env names and problems only, never values)
//   POST /api/adp/sync    managers: sync a date range, one chunk per call (the UI keeps calling with `next`)
//   GET  /api/cron/adp    Vercel Cron, daily. Requires Authorization: Bearer <CRON_SECRET>.
import { canManageSchedule } from '../core/roles.js';
import { adpConfig, createAdpClient } from './adp.js';
import { runAdpSync, syncRange, cronRange } from './adp-sync.js';
import { cronAuthorized } from './toast-routes.js';

const BUDGET_MS = 18_000; // leaves room inside the 30 s function limit for boot and the final write

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} o.env
 * @param {(req) => object|null} o.userOf   the signed-in user for a request (after db.sync)
 */
export function mountAdp(app, { db, env, userOf, budgetMs = BUDGET_MS, makeClient = () => createAdpClient({ env }) }) {
  const manager = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canManageSchedule(u)) { res.status(403).json({ error: 'Managers only' }); return null; }
    return u;
  };
  const notReady = (cfg) => `ADP isn’t set up yet. Add ${[...cfg.missing, ...cfg.problems.map((p) => p.env)].join(', ')} in Vercel, then redeploy.`;

  app.get('/api/adp/status', async (req, res) => {
    if (!(await manager(req, res))) return;
    const { configured, missing, problems, host, tokenUrl, managerAoid, cron } = adpConfig(env);
    res.json({ result: { configured, missing, problems, host, tokenUrl, team: !!managerAoid, cron } });
  });

  app.post('/api/adp/sync', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const cfg = adpConfig(env);
    if (!cfg.configured) return res.status(400).json({ error: notReady(cfg) });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { from, to } = syncRange({ from: b.from, to: b.to });
    const whole = b.run && typeof b.run === 'object' ? syncRange({ from: b.run.from, to: b.run.to }) : null;
    const run = whole ? { id: String(b.run.id || '').slice(0, 40) || null, ...whole } : null;
    const out = await runAdpSync({ db, env, client: makeClient(), from, to, refresh: b.refresh !== false, by: u.id, run, budgetMs });
    if (!out.ok) return res.status(502).json({ error: out.error, result: out });
    res.json({ result: out });
  });

  app.get('/api/cron/adp', async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    if (!adpConfig(env).configured) return res.json({ result: { skipped: 'ADP is not set up' } });
    await db.sync();
    const { from, to } = cronRange(db.store);
    const out = await runAdpSync({ db, env, client: makeClient(), from, to, refresh: true, by: 'cron', budgetMs });
    res.status(out.ok ? 200 : 502).json({ result: { ok: out.ok, from, to, days: out.done.length, next: out.next, error: out.error || null } });
  });
}
