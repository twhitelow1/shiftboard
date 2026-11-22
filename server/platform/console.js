// The platform console's API, for DubLow Digital staff: /api/platform/*. Answers only on
// admin.<PLATFORM_DOMAIN> and on legacy hosts (where the console page is /platform), never on a
// restaurant's own host.
//
// Its own sign-in (platform.admins), separate from every restaurant's: a 12-hour cookie scoped to
// /api/platform, SameSite=Strict, and sign-in attempts rate-limited like the app's (10 per 15 minutes per
// IP and email). Every change is written to platform.audit_log.
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { FEATURES, PLANS, PLAN_KEYS, STATUSES, TRIAL_DAYS, cleanOverrides, isPaused } from './plans.js';
import { RESERVED_SLUGS, slugProblem, slugify } from './slugs.js';
import { consoleAllowed, domainProblem, normalizeHost, tenantAddress } from './hosts.js';
import { INTEGRATION_FIELDS, PLAIN_KEYS, cleanIntegrations, integrationsView } from './tenant-env.js';
import { createTenant, OnboardError } from './onboard.js';
import { encryptionKey } from './secrets.js';

const COOKIE = 'sb_platform';
const MAX_ATTEMPTS = 10;
const SESSION_HOURS = 12;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {object} o
 * @param o.registry   server/platform/registry.js
 * @param o.platform   { registry, conn, runtime(tenant), hostCfg, env, consoleSecret() }
 */
export function consoleRouter({ platform }) {
  const { registry, hostCfg, env } = platform;
  const PROD = env.NODE_ENV === 'production';
  const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: PROD, path: '/api/platform', maxAge: SESSION_HOURS * 3600_000 };
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  r.use(cookieParser());

  // Only on the console's hosts; and for anything that changes data, JSON from this same site.
  r.use((req, res, next) => {
    if (!consoleAllowed(req.headers.host, hostCfg)) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
      const origin = req.get('origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* bad origin */ }
        if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused' });
      }
    }
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json({ result: out });
    } catch (e) {
      const status = e.status || (e instanceof OnboardError ? e.status : 500);
      if (status >= 500) console.error('Platform console:', e);
      res.status(status).json({ error: status >= 500 ? 'Something went wrong' : e.message, ...(e.field ? { field: e.field } : {}) });
    }
  };

  // ---------- sign-in ----------
  async function adminOf(req) {
    const token = req.cookies[COOKIE];
    if (!token) return null;
    try {
      const claims = jwt.verify(token, await platform.consoleSecret());
      if (claims.kind !== 'platform') return null;
      const a = await registry.adminById(claims.sub);
      if (!a || Number(a.session_version) !== Number(claims.v)) return null;
      return { id: a.id, email: a.email, name: a.name, mustChange: !!a.must_change };
    } catch { return null; }
  }
  // Everything but /session and /password waits until a temporary password has been replaced.
  const signedIn = async (req, { allowTemporary = false } = {}) => {
    const a = await adminOf(req);
    if (!a) throw new HttpError(401, 'Please sign in');
    if (a.mustChange && !allowTemporary) throw new HttpError(403, 'Set your own password first');
    return a;
  };

  r.post('/login', wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const key = crypto.createHash('sha256').update(`platform|${req.ip}|${email}`).digest('hex');
    if ((await registry.countAttempts(key)) >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const a = await registry.adminByEmail(email);
    if (!a || !(await bcrypt.compare(password, a.password_hash || ''))) {
      await registry.recordAttempt(key);
      throw new HttpError(401, 'Wrong email or password');
    }
    await registry.clearAttempts(key);
    await registry.stampAdminLogin(a.id);
    await registry.audit({ admin: a, action: 'admin.signin', details: {} });
    const token = jwt.sign({ sub: a.id, v: Number(a.session_version), kind: 'platform' }, await platform.consoleSecret(), { expiresIn: `${SESSION_HOURS}h` });
    res.cookie(COOKIE, token, cookieOpts);
    return { email: a.email, name: a.name, mustChange: !!a.must_change };
  }));

  r.post('/logout', (req, res) => { res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }).json({ ok: true }); });

  r.get('/session', wrap(async (req) => signedIn(req, { allowTemporary: true })));

  // ---------- reference data ----------
  r.get('/meta', wrap(async (req) => {
    await signedIn(req);
    let encryption = false;
    try { encryption = !!encryptionKey(env); } catch { encryption = false; }
    return {
      plans: Object.fromEntries(PLAN_KEYS.map((k) => [k, { label: PLANS[k].label, priceCents: PLANS[k].priceCents, interval: PLANS[k].interval, features: PLANS[k].features }])),
      features: FEATURES, statuses: STATUSES, reserved: RESERVED_SLUGS, trialDays: TRIAL_DAYS,
      platformDomain: hostCfg.platformDomain, legacyHosts: [...hostCfg.legacyHosts],
      encryption, email: !!(env.RESEND_API_KEY && (env.PLATFORM_EMAIL_FROM || env.EMAIL_FROM)), integrationFields: INTEGRATION_FIELDS,
    };
  }));

  // The restaurant's address as seen from this console request (protocol and port included in development).
  const addressFor = (req, t) => {
    const port = /:(\d+)$/.exec(req.get('host') || '')?.[1] || '';
    return tenantAddress(t, hostCfg, { proto: req.protocol, port: ['80', '443'].includes(port) ? '' : port, consoleHost: req.headers.host });
  };
  const summary = async (req, t) => ({
    id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan, isDefault: t.is_default, schema: t.schema_name,
    address: addressFor(req, t), domains: t.domains, createdAt: t.created_at, trialEndsAt: t.trial_ends_at, ownerEmail: t.owner_email,
    ...(await registry.tenantStats(t)),
  });

  // ---------- restaurants ----------
  r.get('/tenants', wrap(async (req) => {
    await signedIn(req);
    const snap = await registry.snapshot({ fresh: true });
    return Promise.all(snap.list.map((t) => summary(req, t)));
  }));

  r.get('/slug-check', wrap(async (req) => {
    await signedIn(req);
    const slug = String(req.query.slug || '');
    const problem = slugProblem(slug) || ((await registry.snapshot({ fresh: true })).bySlug.has(slug) ? `${slug} is already taken` : null);
    return { ok: !problem, problem, suggestion: req.query.name ? slugify(req.query.name) : undefined };
  }));

  r.post('/tenants', wrap(async (req) => {
    const admin = await signedIn(req);
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase();
    const base = addressFor(req, { slug, domains: [], is_default: false }) || '';
    const out = await createTenant(platform, {
      name: b.name, slug, owner: { name: b.ownerName, email: b.ownerEmail }, plan: b.plan, status: b.status, trialEndsAt: b.trialEndsAt,
    }, { actor: admin, base, source: 'console' });
    return { tenant: await summary(req, out.tenant), invite: out.invite };
  }));

  async function tenantOr404(id) {
    const t = await registry.get(id);
    if (!t) throw new HttpError(404, 'No such restaurant');
    return t;
  }

  async function detail(req, t) {
    return {
      ...(await summary(req, t)),
      features: t.features, resolved: t.resolved, notes: t.notes, ownerName: t.owner_name, billing: t.billing, updatedAt: t.updated_at,
      integrations: integrationsView(t, await registry.secretView(t.id), env),
      audit: await registry.auditLog({ tenantId: t.id, limit: 30 }),
    };
  }

  r.get('/tenants/:id', wrap(async (req) => {
    await signedIn(req);
    return detail(req, await tenantOr404(req.params.id));
  }));

  r.patch('/tenants/:id', wrap(async (req) => {
    const admin = await signedIn(req);
    const t = await tenantOr404(req.params.id);
    const b = req.body || {};
    const patch = {};
    if ('name' in b) {
      const name = String(b.name || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length > 80) throw new HttpError(400, 'Enter a name of up to 80 characters');
      patch.name = name;
    }
    if ('status' in b) {
      if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Unknown status');
      patch.status = b.status;
    }
    if ('plan' in b) {
      if (!PLAN_KEYS.includes(b.plan)) throw new HttpError(400, 'Unknown plan');
      patch.plan = b.plan;
    }
    if ('features' in b) patch.features = cleanOverrides(b.features);
    if ('domains' in b) {
      const raw = Array.isArray(b.domains) ? b.domains : String(b.domains || '').split(/[\s,]+/);
      const domains = [...new Set(raw.map(normalizeHost).filter(Boolean))];
      if (domains.length > 10) throw new HttpError(400, 'Up to 10 domains');
      for (const d of domains) {
        const p = domainProblem(d, hostCfg);
        if (p) throw new HttpError(400, p);
      }
      patch.domains = domains;
    }
    if ('notes' in b) patch.notes = String(b.notes || '').slice(0, 5000);
    if ('trialEndsAt' in b) {
      if (b.trialEndsAt && !Number.isFinite(Date.parse(b.trialEndsAt))) throw new HttpError(400, 'The trial end isn’t a date');
      patch.trial_ends_at = b.trialEndsAt ? new Date(Date.parse(b.trialEndsAt)).toISOString() : null;
    }
    if ('ownerName' in b) patch.owner_name = String(b.ownerName || '').trim().slice(0, 80);
    if ('ownerEmail' in b) patch.owner_email = String(b.ownerEmail || '').trim().toLowerCase().slice(0, 200);
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');

    const before = { name: t.name, status: t.status, plan: t.plan, features: t.features, domains: t.domains, trial_ends_at: t.trial_ends_at, owner_email: t.owner_email, owner_name: t.owner_name };
    const updated = await registry.updateTenant(t.id, patch);
    const changes = {};
    for (const k of Object.keys(patch)) {
      if (k === 'notes') { if (patch.notes !== t.notes) changes.notes = 'edited'; continue; }
      if (JSON.stringify(before[k]) !== JSON.stringify(updated[k])) changes[k] = { from: before[k], to: updated[k] };
    }
    if (Object.keys(changes).length) {
      const action = changes.status ? (isPaused(updated.status) ? 'tenant.pause' : isPaused(t.status) ? 'tenant.resume' : 'tenant.update') : 'tenant.update';
      await registry.audit({ admin, action, tenantId: t.id, details: changes });
    }
    platform.forget(t.id);
    return detail(req, updated);
  }));

  // Integration settings. Plain values are saved as typed; secrets are encrypted and never come back.
  r.put('/tenants/:id/integrations', wrap(async (req) => {
    const admin = await signedIn(req);
    const t = await tenantOr404(req.params.id);
    const { plain, secrets } = cleanIntegrations(req.body || {});
    const changed = [];
    if (Object.keys(plain).length) {
      const next = { ...t.integrations };
      for (const k of PLAIN_KEYS) {
        if (!(k in plain)) continue;
        if ((next[k] || '') !== plain[k]) changed.push(k);
        if (plain[k]) next[k] = plain[k]; else delete next[k];
      }
      await registry.updateTenant(t.id, { integrations: next });
    }
    if (Object.keys(secrets).length) {
      await registry.setSecrets(t.id, secrets);
      changed.push(...Object.entries(secrets).map(([k, v]) => `${k} (${v ? 'set' : 'cleared'})`));
    }
    if (changed.length) await registry.audit({ admin, action: 'tenant.integrations', tenantId: t.id, details: { changed } });
    platform.forget(t.id);
    return detail(req, await tenantOr404(t.id));
  }));

  // "Sign in as owner": a one-time link to the restaurant's host that opens a support session.
  r.post('/tenants/:id/support', wrap(async (req) => {
    const admin = await signedIn(req);
    const t = await tenantOr404(req.params.id);
    if (isPaused(t.status)) throw new HttpError(400, 'This restaurant is paused. Reactivate it to sign in.');
    const address = addressFor(req, t);
    if (!address) throw new HttpError(400, 'This restaurant has no address yet: add a domain, or set PLATFORM_DOMAIN');
    const minutes = Math.min(120, Math.max(5, Math.round(Number(req.body?.minutes) || 30)));
    const rt = await platform.runtime(t);
    await rt.db.sync();
    const users = rt.db.store.list('users', (u) => u.active !== false);
    const owner = users.find((u) => t.owner_email && u.email === t.owner_email) || users.find((u) => u.role === 'super_admin');
    if (!owner) throw new HttpError(404, 'This restaurant has no owner account to sign in as');
    const { token, linkMinutes } = await registry.createSupportGrant({ tenantId: t.id, userId: owner.id, admin, sessionMinutes: minutes });
    await registry.audit({ admin, action: 'support.start', tenantId: t.id, details: { as: owner.email || owner.name, minutes } });
    return { url: `${address}/api/auth/support?token=${encodeURIComponent(token)}`, as: owner.name, minutes, linkMinutes };
  }));

  // Send the owner a new invite (or show a new link when email isn't set up).
  r.post('/tenants/:id/invite', wrap(async (req) => {
    const admin = await signedIn(req);
    const t = await tenantOr404(req.params.id);
    if (isPaused(t.status)) throw new HttpError(400, 'This restaurant is paused. Reactivate it first.');
    const rt = await platform.runtime(t);
    await rt.db.sync();
    const owner = rt.db.store.list('users', (u) => u.active !== false && t.owner_email && u.email === t.owner_email)[0];
    if (!owner) throw new HttpError(404, 'No active account with the owner’s email in this restaurant');
    let invite;
    try {
      invite = await rt.app.locals.invite(owner.id, { base: addressFor(req, t) || '' });
    } catch (e) {
      invite = { ...(await rt.app.locals.invite(owner.id, { base: addressFor(req, t) || '', linkOnly: true })), error: `The email could not be sent (${e.message})` };
    }
    await registry.audit({ admin, action: 'tenant.invite', tenantId: t.id, details: { to: owner.email, how: invite.emailed ? 'email' : 'link shown once' } });
    return invite;
  }));

  // ---------- audit log and admins ----------
  r.get('/audit', wrap(async (req) => {
    await signedIn(req);
    return registry.auditLog({ tenantId: req.query.tenant ? String(req.query.tenant) : null, limit: req.query.limit });
  }));

  r.get('/admins', wrap(async (req) => {
    await signedIn(req);
    return registry.admins();
  }));

  r.post('/admins', wrap(async (req) => {
    const admin = await signedIn(req);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const password = String(req.body?.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter an email address');
    if (password.length < 12) throw new HttpError(400, 'Use a password of at least 12 characters');
    if (await registry.adminByEmail(email)) throw new HttpError(409, 'That email is already a platform admin');
    const a = await registry.createAdmin({ email, name, passwordHash: bcrypt.hashSync(password, 10) });
    await registry.audit({ admin, action: 'admin.create', details: { email } });
    return { id: a.id, email: a.email, name: a.name };
  }));

  r.post('/password', wrap(async (req, res) => {
    const admin = await signedIn(req, { allowTemporary: true });
    const password = String(req.body?.password || '');
    if (password.length < 12) throw new HttpError(400, 'Use a password of at least 12 characters');
    await registry.setAdminPassword(admin.id, bcrypt.hashSync(password, 10));
    await registry.audit({ admin, action: 'admin.password', details: {} });
    const a = await registry.adminById(admin.id);
    res.cookie(COOKIE, jwt.sign({ sub: a.id, v: Number(a.session_version), kind: 'platform' }, await platform.consoleSecret(), { expiresIn: `${SESSION_HOURS}h` }), cookieOpts);
    return { ok: true };
  }));

  r.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return r;
}
