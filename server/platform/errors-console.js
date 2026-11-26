// Errors & reports on the platform: one error log for every restaurant (platform.errors, server/errors.js), its
// page in the DubLow console, the daily digest cron, and the console's own browser errors. DubLow staff only:
// these routes sit behind the console's own sign-in (server/platform/console.js); restaurant accounts, admins
// included, have no way in.
//   GET   /api/platform/errors                     the list, grouped by fingerprint (?tenant, status, kind, since, q)
//   GET   /api/platform/errors/:id                 one fingerprint: stack, occurrences, people, restaurants, issue text
//   PATCH /api/platform/errors/:id                 { status: acknowledged | fixed | ignored | new } (audited)
//   GET   /api/platform/errors/:id/files/:eventId  a report's screenshot
//   POST  /api/platform/client-errors              the console's own crashes
//   GET   /api/cron/errors-digest                  Vercel Cron, daily (Authorization: Bearer <CRON_SECRET>)
import { ErrorLog, STATUSES } from '../errors.js';
import { clientRoutes, markHandled } from '../errors-routes.js';
import { createMailer } from '../email.js';
import { createTexter } from '../sms.js';
import { cronAuthorized } from '../toast-routes.js';

/** The console's address for links in alert emails and texts. */
export function consoleBase(env, hostCfg) {
  if (hostCfg.platformDomain) return `https://${hostCfg.adminHost}/platform`;
  const legacy = [...hostCfg.legacyHosts][0];
  const base = env.APP_URL || (legacy ? `https://${legacy}` : env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return base ? `${base.replace(/\/+$/, '')}/platform` : '';
}

/**
 * The platform's error log. Alerts go to PLATFORM_ADMIN_EMAIL from PLATFORM_EMAIL_FROM (else EMAIL_FROM) through the
 * platform's Resend key; texts to PLATFORM_ALERT_PHONE through the platform's Twilio account.
 */
export function createPlatformErrors({ conn, env, registry, hostCfg, mailerFor, texterFor, now = () => Date.now(), background = null }) {
  const alertEnv = { RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.PLATFORM_EMAIL_FROM || env.EMAIL_FROM };
  const smsEnv = { TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID: env.TWILIO_MESSAGING_SERVICE_SID, TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER };
  const base = consoleBase(env, hostCfg);
  return new ErrorLog({
    conn, schema: 'platform', env, now, background,
    mailer: mailerFor ? mailerFor(alertEnv, null) : createMailer(alertEnv),
    texter: texterFor ? texterFor(smsEnv, null) : createTexter(smsEnv),
    consoleUrl: (id) => (base ? `${base}#/errors${id ? `/${id}` : ''}` : ''),
    tenantName: (id) => registry.cache?.byId?.get(id)?.name || id,
  });
}

/** A failed daily sync for one restaurant (server/platform/index.js cronAll). */
export function recordCronFailure(errors, { tenant, label, error, stack = '' }) {
  markHandled(); // the cron's own 502 isn't recorded again
  errors.forTenant(tenant).record({
    kind: 'server', source: 'cron', name: `${label} cron`, message: `${label}: ${error || 'the daily sync failed'}`, stack,
    route: `/api/cron/${label.toLowerCase()}`, method: 'GET', httpStatus: 502,
  });
}

/** GET /api/cron/errors-digest: the daily email (and trimming old data). */
export function mountErrorCron(app, { platform, booted }) {
  app.get('/api/cron/errors-digest', booted, async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), platform.env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      await platform.registry.snapshot();
      const out = await platform.errors.sendDigest();
      res.json({ result: { sent: out.sent, skipped: out.skipped || null, total: out.digest.total, new: out.digest.fresh.length, reports: out.digest.reports.length, pruned: out.pruned } });
    } catch (e) {
      console.error('Error digest failed:', e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });
}

/** The console's routes (inside consoleRouter, after its host and JSON checks). */
export function errorConsoleRoutes(r, { platform, signedIn, wrap, HttpError }) {
  const log = platform.errors;
  const names = async () => Object.fromEntries((await platform.registry.snapshot()).list.map((t) => [t.id, t.name]));

  r.get('/errors', wrap(async (req) => {
    await signedIn(req);
    const q = req.query;
    const out = await log.list({ tenant: String(q.tenant || ''), status: String(q.status || ''), kind: String(q.kind || ''), since: String(q.since || '7d'), q: String(q.q || '') });
    return { ...out, tenants: await names() };
  }));

  r.get('/errors/:id', wrap(async (req) => {
    await signedIn(req);
    await platform.registry.snapshot();
    const e = await log.get(req.params.id);
    if (!e) throw new HttpError(404, 'No such error');
    return { ...e, tenantNames: await names() };
  }));

  r.patch('/errors/:id', wrap(async (req) => {
    const admin = await signedIn(req);
    const status = String(req.body?.status || '');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    const e = await log.setStatus(req.params.id, status, admin.email);
    if (!e) throw new HttpError(404, 'No such error');
    await platform.registry.audit({ admin, action: 'error.status', details: { error: e.id, status, message: e.message.slice(0, 80) } });
    return e;
  }));

  r.get('/errors/:id/files/:eventId', async (req, res) => {
    try {
      await signedIn(req);
      const f = await log.file(req.params.id, req.params.eventId);
      if (!f) return res.status(404).json({ error: 'Not found' });
      res.set('Content-Type', f.mime);
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.set('Cache-Control', 'private, no-store');
      res.send(f.data);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
    }
  });

  // The console's own crashes, like the web app's (no reports: DubLow staff tell themselves).
  clientRoutes(r, { recorder: log.forTenant(null), userOf: (req) => signedIn(req, { allowTemporary: true }).catch(() => null), prefix: '', reports: false, now: log.now });
}
