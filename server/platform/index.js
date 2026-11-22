// The multi-restaurant platform: one deployment, one Postgres database, one schema per restaurant.
//
//   request ─► host ─► restaurant (server/platform/hosts.js)
//                      ├─ its runtime: a DocDb on its schema + server/app.js's Express app for it,
//                      │  opened on its first request and kept in an LRU cache (TENANT_CACHE_MAX)
//                      ├─ admin.<PLATFORM_DOMAIN> or /platform on a legacy host: the platform console
//                      └─ unknown: "restaurant not found" (never another restaurant's data)
//
// The business logic (core/) doesn't know about any of this: each request simply runs against its
// restaurant's own store and service. The registry (platform schema) is in registry.js, the console's
// API in console.js, restaurant creation in onboard.js. See docs/platform/README.md.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DocDb } from '../db.js';
import { createApp } from '../app.js';
import { cronAuthorized, BUDGET_MS } from '../toast-routes.js';
import { toastConfig } from '../toast.js';
import { integration } from '../../core/toast.js';
import { Registry } from './registry.js';
import { TenantCache } from './tenant-cache.js';
import { hostConfig, resolveHost, consoleAllowed } from './hosts.js';
import { tenantEnv } from './tenant-env.js';
import { consoleRouter } from './console.js';
import { isPaused } from './plans.js';

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Restaurant not found · ShiftBoard</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#0f172a}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#475569;margin:6px 0}</style></head>
<body><main><h1>Restaurant not found</h1><p>There’s no ShiftBoard restaurant at this address. Check the link your manager sent you.</p>
<p lang="es">No encontramos ningún restaurante de ShiftBoard en esta dirección. Revisa el enlace que te mandó tu gerente.</p></main></body></html>`;

/**
 * @param {object} o
 * @param o.conn         the shared Postgres connection (openConnection())
 * @param {object} [o.env]
 * @param {string} [o.staticDir]  the built web app (standalone server; on Vercel the CDN serves it)
 * @param {Function} [o.mailerFor] (env, tenant) => mailer, for tests; default: Resend from the restaurant's env
 * @param {Function} [o.texterFor] (env, tenant) => texter, for tests
 * @param {object} [o.pusher] [o.expoPush]  shared phone notification senders (tests)
 * @param {Function} [o.now]      clock in ms (tests)
 */
export function createPlatformApp({ conn, env = process.env, staticDir, mailerFor, texterFor, pusher, expoPush, now } = {}) {
  const registry = new Registry({ conn, env });
  const hostCfg = hostConfig(env);
  const cache = new TenantCache({ max: Number(env.TENANT_CACHE_MAX) || 25 });
  const dbs = new Map(); // schema -> DocDb kept while its runtime is cached (so a rebuilt app keeps its warm cache)
  const building = new Map(); // tenant id -> Promise<entry>
  const hashPassword = (p) => bcrypt.hashSync(p, 10);

  let secretPromise = null;
  const platform = {
    registry, conn, env, hostCfg, cache,
    /** Signs console sessions: derived from JWT_SECRET, else generated once and kept in platform.meta. */
    consoleSecret: () => (secretPromise ??= env.JWT_SECRET
      ? Promise.resolve(crypto.createHmac('sha256', env.JWT_SECRET).update('shiftboard-platform-console').digest('hex'))
      : registry.ensureMeta('console_secret', () => crypto.randomBytes(48).toString('hex'))),
    runtime,
    /** Drop a restaurant's app (its settings changed); the next request builds it again with the same warm DocDb. */
    forget(id) { const e = cache.peek(id); if (e) e.stale = true; },
  };

  // ---------- boot: platform schema, the default restaurant, the first platform admin ----------
  let booting = null;
  function ready() {
    booting ??= (async () => {
      await registry.migrate();
      await registry.ensureDefaultTenant();
      await registry.ensureFirstAdmin(hashPassword);
    })().catch((e) => { booting = null; throw e; });
    return booting;
  }

  // ---------- each restaurant's runtime ----------
  function tenantContext(t) {
    return {
      id: t.id, slug: t.slug, name: t.name, isDefault: t.is_default, status: t.status, plan: t.plan,
      features: t.resolved, trialEndsAt: t.trial_ends_at,
      consumeSupportGrant: (token) => registry.consumeSupportGrant(token, t.id),
    };
  }

  /** The restaurant's { db, app, env, tenant }, built on first use and rebuilt when its registry row changes. */
  async function runtime(t) {
    const cur = cache.get(t.id);
    if (cur && cur.version === t.version && !cur.stale) return cur;
    if (building.has(t.id)) return building.get(t.id);
    const p = (async () => {
      const secrets = await registry.secretValues(t.id);
      const tEnv = tenantEnv(env, t, secrets);
      let db = cur?.db || dbs.get(t.schema_name);
      if (!db) db = new DocDb(conn, { schema: t.schema_name });
      const app = createApp({
        db, env: tEnv, staticDir, tenant: tenantContext(t),
        ...(mailerFor ? { mailer: mailerFor(tEnv, t) } : {}),
        ...(texterFor ? { texter: texterFor(tEnv, t) } : {}),
        ...(pusher ? { pusher } : {}),
        ...(expoPush ? { expoPush } : {}),
        ...(now ? { now } : {}),
      });
      // Requests still running on a replaced entry finish on it; the new entry starts with none.
      const entry = { id: t.id, version: t.version, tenant: t, db, app, env: tEnv, inflight: 0 };
      dbs.set(t.schema_name, db);
      cache.set(t.id, entry);
      return entry;
    })().finally(() => building.delete(t.id));
    building.set(t.id, p);
    return p;
  }
  cache.onEvict = (id, e) => { if (dbs.get(e.tenant.schema_name) === e.db) dbs.delete(e.tenant.schema_name); };

  // ---------- the app ----------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.ready = ready;
  app.locals.platform = platform;
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const booted = async (req, res, next) => {
    try { await ready(); next(); } catch (e) {
      console.error('ShiftBoard could not reach its database:', e.message);
      res.status(503).json({ error: 'The database is not reachable right now. Try again in a minute.' });
    }
  };

  // The daily Toast sync (Vercel Cron), for every restaurant with Toast set up, each within its share of the time.
  app.get('/api/cron/toast', booted, async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ result: await toastCronAll() });
  });

  async function toastCronAll() {
    const budget = Number(env.CRON_BUDGET_MS) || BUDGET_MS;
    const started = Date.now();
    const snap = await registry.snapshot({ fresh: true });
    const list = snap.list.filter((t) => !isPaused(t.status) && t.resolved.toast);
    // Start at a different restaurant each hour, so the ones at the end aren't always the ones left out.
    const offset = list.length ? Math.floor(Date.now() / 3_600_000) % list.length : 0;
    const order = [...list.slice(offset), ...list.slice(0, offset)];
    const tenants = [];
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      const left = budget - (Date.now() - started);
      if (left < 2500) {
        for (const r of order.slice(i)) tenants.push({ slug: r.slug, skipped: 'Out of time; the next run picks it up' });
        break;
      }
      let rt;
      try { rt = await runtime(t); } catch (e) { tenants.push({ slug: t.slug, ok: false, error: e.message }); continue; }
      if (!toastConfig(rt.env).configured) { tenants.push({ slug: t.slug, skipped: 'Toast is not set up' }); continue; }
      const release = cache.hold(rt);
      try {
        await rt.db.sync();
        const last = integration(rt.db.store).lastCron;
        if (last?.ok && Date.now() - Date.parse(last.at) < 20 * 3_600_000) { tenants.push({ slug: t.slug, skipped: 'Already synced today' }); continue; }
        const share = Math.max(2500, Math.floor(left / (order.length - i)));
        tenants.push({ slug: t.slug, ...(await rt.app.locals.toastCron({ budgetMs: share })) });
      } catch (e) {
        console.error(`Toast cron for ${t.slug} failed:`, e);
        tenants.push({ slug: t.slug, ok: false, error: e.message });
      } finally { release(); }
    }
    return { tenants, ms: Date.now() - started };
  }
  app.locals.toastCronAll = toastCronAll;
  /** Open the default restaurant (its schema, first account or demo data) before the first request. */
  app.locals.warmDefault = async () => {
    await ready();
    const t = (await registry.snapshot()).defaultTenant;
    if (t) await (await runtime(t)).app.locals.ready();
  };

  // The platform console's API (its own sign-in).
  app.use('/api/platform', booted, consoleRouter({ platform }));

  // The platform console page: /platform on the console's hosts (Vercel rewrites /platform to platform.html).
  const consolePage = staticDir && fs.existsSync(path.join(staticDir, 'platform.html')) ? path.join(staticDir, 'platform.html') : null;
  app.get(['/platform', '/platform/'], (req, res, next) => {
    if (!consoleAllowed(req.hostname, hostCfg)) return next();
    if (!consolePage) return res.status(404).type('text').send('Build the web app first (npm run build)');
    res.sendFile('platform.html', { root: staticDir });
  });

  // Everything else: the restaurant for this host.
  const staticFiles = staticDir && fs.existsSync(staticDir) ? express.static(staticDir, { index: false, maxAge: '1h' }) : null;
  const indexPage = staticDir && fs.existsSync(path.join(staticDir, 'index.html')) ? path.join(staticDir, 'index.html') : null;
  app.use(async (req, res, next) => {
    try { await ready(); } catch (e) {
      console.error('ShiftBoard could not reach its database:', e.message);
      return res.status(503).json({ error: 'The database is not reachable right now. Try again in a minute.' });
    }
    let where;
    try {
      where = resolveHost(req.hostname, hostCfg, await registry.snapshot());
    } catch (e) { return next(e); }
    const api = req.path.startsWith('/api/');

    if (where.kind === 'console') {
      // admin.<PLATFORM_DOMAIN>: the console. The web app at / reads /api/config and goes to /platform.
      if (req.path === '/api/config') return res.json({ console: '/platform' });
      if (api) return res.status(404).json({ error: 'Not found' });
      if (req.path === '/') return res.redirect(302, '/platform');
      if (staticFiles) return staticFiles(req, res, () => (consolePage ? res.sendFile('platform.html', { root: staticDir }) : res.status(404).end()));
      return res.status(404).end();
    }
    if (where.kind === 'notFound') {
      if (api) return res.status(404).json({ error: 'Restaurant not found', notFound: true });
      // The web app shows "restaurant not found" in the visitor's language (from /api/config); without it, a plain page.
      const page = () => (indexPage ? res.status(404).sendFile('index.html', { root: staticDir }) : res.status(404).type('html').send(NOT_FOUND_HTML));
      return staticFiles ? staticFiles(req, res, page) : page();
    }

    let rt;
    try { rt = await runtime(where.tenant); } catch (e) { return next(e); }
    const release = cache.hold(rt);
    res.on('finish', release);
    res.on('close', release);
    rt.app(req, res, next);
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
