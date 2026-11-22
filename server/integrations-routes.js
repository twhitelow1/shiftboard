// Settings → Integrations for a restaurant's own admins (role Admin and up). Mounted by server/app.js.
//   GET /api/integrations         each integration in the plan: connected or not, what's missing, its fields
//                                 (plain values; a secret only as "set" and its last 4)
//   PUT /api/integrations         save some fields: { KEY: value }, '' clears, absent keeps (POST works too)
// On the platform this is the same storage the console edits (encrypted secrets in the registry,
// server/platform/integrations.js), audited with the restaurant's admin as the actor, and the restaurant
// runs with the new settings from its next request. A single-restaurant install has no registry: its
// integrations come from env vars, so the page is read-only there.
import { canChangeSettings } from '../core/roles.js';
import { restaurantView } from './platform/integrations.js';

export const ENV_ONLY = 'On this install, integrations are set with environment variables. Ask whoever runs your ShiftBoard server.';

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} o.env
 * @param {object|null} o.tenant   the platform's restaurant (with integrations.view/save), or null
 * @param {(req) => object|null} o.userOf
 */
export function mountIntegrations(app, { db, env, tenant, userOf }) {
  const admin = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canChangeSettings(u)) { res.status(403).json({ error: 'Admins only' }); return null; }
    res.set('Cache-Control', 'no-store');
    return u;
  };
  const view = () => (tenant?.integrations ? tenant.integrations.view() : restaurantView({ env, mode: 'env' }));

  app.get('/api/integrations', async (req, res) => {
    if (!(await admin(req, res))) return;
    try { res.json({ result: await view() }); } catch (e) { console.error('Integrations:', e); res.status(500).json({ error: 'Something went wrong' }); }
  });

  const save = async (req, res) => {
    const u = await admin(req, res);
    if (!u) return;
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    if (!tenant?.integrations) return res.status(400).json({ error: ENV_ONLY });
    try {
      const changed = await tenant.integrations.save(req.body && typeof req.body === 'object' ? req.body : {}, u);
      res.json({ result: { changed, ...(await view()) } });
    } catch (e) {
      if (!e.status) console.error('Saving integrations failed:', e);
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
    }
  };
  app.put('/api/integrations', save);
  app.post('/api/integrations', save);
}
