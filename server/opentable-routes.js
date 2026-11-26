// HTTP routes for OpenTable's API mode. Mounted by server/app.js. (Import mode, OpenTable's exported
// files, is plain RPC: opentable.previewImport / opentable.import in core/opentable.js, so it works in the demo.)
//   GET  /api/opentable/status   managers: is the API set up (setting names only, never values)
//   POST /api/opentable/sync     managers: one chunk of a sync run; the page calls again with `next`
//   GET  /api/cron/opentable     Vercel Cron, daily. Requires Authorization: Bearer <CRON_SECRET>.
// No webhook: OpenTable's partner webhooks aren't publicly documented (docs/integrations/OPENTABLE.md).
import { canManageSchedule } from '../core/roles.js';
import { integration } from '../core/opentable.js';
import { createOpenTableClient, opentableConfig } from './opentable.js';
import { runOpenTableSync } from './opentable-sync.js';
import { cronAuthorized } from './toast-routes.js';

export const BUDGET_MS = 18_000;
export const NOT_CONNECTED = 'OpenTable’s API isn’t connected yet. Import OpenTable’s exports instead, or ask DubLow Digital to connect it.';
const CRON_RESUME_MS = 26 * 3_600_000;

/**
 * @param {import('express').Express} app
 * @param {object} o  { db, env, userOf, onCommit, managed, budgetMs, makeClient, now }
 */
export function mountOpenTable(app, { db, env, userOf, onCommit = () => {}, managed = false, budgetMs = BUDGET_MS, makeClient = () => createOpenTableClient({ env }), now = () => Date.now() }) {
  const manager = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canManageSchedule(u)) { res.status(403).json({ error: 'Managers only' }); return null; }
    return u;
  };

  app.get('/api/opentable/status', async (req, res) => {
    if (!(await manager(req, res))) return;
    const { configured, missing, present, host, rid, cron } = opentableConfig(env);
    res.json({ result: { configured, missing, present, host, rid, cron } });
  });

  app.post('/api/opentable/sync', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const cfg = opentableConfig(env);
    if (!cfg.configured) return res.status(400).json({ error: managed ? NOT_CONNECTED : `OpenTable’s API isn’t set up yet. Add ${cfg.missing.join(', ')}, then redeploy.` });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await runOpenTableSync({ db, env, client: makeClient(), cursor: b.next || null, by: u.id, budgetMs, onCommit: (c) => onCommit(c, req) });
    if (!out.ok) return res.status(502).json({ error: out.error, result: out });
    res.json({ result: out });
  });

  // One restaurant's daily sync; on the platform, server/platform/index.js runs it for every restaurant
  // with OpenTable set up and passes its address (base), so links in the notifications it sends point there.
  const opentableCron = async ({ budgetMs: budget = budgetMs, base = '' } = {}) => {
    const cfg = opentableConfig(env);
    if (!cfg.configured) return { skipped: 'OpenTable is not set up' };
    await db.sync();
    const saved = integration(db.store).cronCursor;
    const resume = saved && now() - Date.parse(saved.savedAt) < CRON_RESUME_MS ? saved : null;
    const at = base ? new URL(base) : null;
    const linkReq = at ? { protocol: at.protocol.replace(':', ''), get: () => at.host } : null;
    const out = await runOpenTableSync({ db, env, client: makeClient(), cursor: resume, by: 'cron', budgetMs: budget, onCommit: (c) => onCommit(c, linkReq) });
    return { ok: out.ok, finished: out.ok && !out.next, counts: out.counts, error: out.error || null, ...(out.warnings ? { warnings: out.warnings } : {}) };
  };
  app.locals.opentableCron = opentableCron;

  app.get('/api/cron/opentable', async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    const result = await opentableCron();
    res.status(result.ok === false ? 502 : 200).json({ result });
  });
}
