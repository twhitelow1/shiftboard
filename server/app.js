// The HTTP API. Shared by the Vercel function (api/index.js) and the standalone
// server (server/index.js). All state lives in Postgres via DocDb.
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { canChangeSettings, canManageUser, canManageSchedule } from '../core/roles.js';
import { createMailer, deliverable, notificationEmail, inviteEmail, resetEmail, testEmail } from './email.js';
import { createChannels } from './channels.js';
import { sendNotificationEmails } from './notify-email.js';
import { mountSchedulePdf } from './schedule-pdf-routes.js';
import { trainingRoutes } from './training-routes.js';
import { eightySixRoutes } from './eighty-six-routes.js';
import { createExpoPush, pushNotifications } from './expo-push.js';
import { uid } from '../core/store.js';
import { createService, AppError } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { effectiveShift } from '../core/forecast.js';
import { addDays } from '../core/time.js';
import { langOf, isLang } from '../core/i18n.js';
import { translateError } from '../core/errors.js';
import { mountToast, toastCron } from './toast-routes.js';
import { featuresForMethod, ROUTE_FEATURES, NOT_IN_PLAN, PAUSED, isPaused, billingBanner } from './platform/plans.js';
import { billingPortal } from './billing.js';
import { mountAdp } from './adp-routes.js';
import { mountTripleseat } from './tripleseat-routes.js';
import { mountOpenTable } from './opentable-routes.js';
import { mountGoogle } from './google-routes.js';
import { mountYelp } from './yelp-routes.js';
import { mountReviewReplies } from './review-replies.js';
import { mountIntegrations } from './integrations-routes.js';
import { createAuth } from './auth.js';
import { mountOnboarding } from './onboarding.js';
import { mountAnnouncements } from './announcements.js';
import { publicRoutes } from './public-routes.js';
import { ErrorLog } from './errors.js';
import { capture as captureErrors, clientRoutes as errorRoutes } from './errors-routes.js';
import { createTexter } from './sms.js';
import { mountMcp } from './mcp/index.js';
import { migrateConsents, emailConsentOf, legalLinks, CONSENT_MIGRATION, CONSENT_TEXT, CONSENT_VERSION } from '../core/consent.js';
import { roleAllows, cleanDraft, ROLE_ROUTES, ROLE_OFF } from '../core/role-features.js';
import { createViewAs } from './view-as.js';
import { mountAssistant } from './assistant/index.js';
import { mountBeoAi } from './beo-ai-routes.js';
import { mountImport } from './import-routes.js';

const COOKIE = 'sb_session';
// Not allowed while DubLow staff are signed in as the owner for support ("Sign in as owner"): the owner's
// password, account, consent (only the person can agree to texts or terms) and photo.
const NOT_IN_SUPPORT = new Set(['employees.changePassword', 'account.requestDeletion', 'consent.accept', 'sms.preferences', 'profile.setPhoto', 'profile.removePhoto']);
// Methods that only read. Purely a speed hint: if one of these ever writes, DocDb
// notices and redoes it under the write lock.
const READ_ONLY = /\.(bootstrap|list|get|eligible|week|summary|suggestStaffing|covers|publicKey)$/;

const hashPassword = (p) => bcrypt.hashSync(p, 10);
const sameString = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * @param {object} opts
 * @param {import('./db.js').DocDb} opts.db
 * @param {object} [opts.env]       defaults to process.env
 * @param {string} [opts.staticDir] serve the built web app from here (not used on Vercel, where the CDN serves dist/)
 * @param {object} [opts.mailer]    email sender (defaults to Resend, configured from env)
 * @param {object} [opts.pusher]    phone notification sender (defaults to server/push.js, configured from env)
 * @param {object} [opts.texter]    text message sender (defaults to server/sms.js, configured from env)
 * @param {object} [opts.expoPush]  phone app push sender (defaults to the Expo Push API, see expo-push.js)
 * @param {object} [opts.tenant]    on the multi-restaurant platform (server/platform/), the restaurant this app serves:
 *   { id, slug, name, isDefault, status, plan, features: { training: true, … }, trialEndsAt, billing,
 *     consumeSupportGrant(token) }. Without it the app serves one restaurant with every feature, as it always has.
 * @param {Function} [opts.now]     clock in ms (tests)
 * @param {Function} [opts.aiClient] ({ apiKey }) => an Anthropic client (tests: a fake; default: the SDK, server/ai/)
 * @param {object} [opts.reviewClients]  tests: { google({ refreshToken }), yelp(), ai() } for fake Google, Yelp and AI
 */
export function createApp({ db, env = process.env, staticDir, mailer = createMailer(env), pusher, texter, expoPush = createExpoPush(env), tenant = null, now = () => Date.now(), aiClient = null, reviewClients = {} } = {}) {
  const PROD = env.NODE_ENV === 'production';
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 1000 * 60 * 60 * 24 * 30 };
  let secret = null;
  // Platform: the restaurant's features (all on without a tenant) and whether its account is paused.
  const has = (feature) => !tenant || tenant.features?.[feature] !== false;
  const paused = !!tenant && isPaused(tenant.status);

  // ---------- startup: schema, signing secret, first account ----------
  let booting = null;
  function ready() {
    booting ??= (async () => {
      await db.migrate();
      secret = env.JWT_SECRET || (await db.ensureMeta('jwt_secret', () => crypto.randomBytes(48).toString('hex')));
      await db.sync();
      // A restaurant created in the platform console already has its owner; only the default one is set up from env.
      if (!db.store.col('users').size && (!tenant || tenant.isDefault)) await db.run(createFirstAccount, { write: true });
      // Once per restaurant: people from before consent records keep what they had (core/consent.js).
      if (!db.store.get('migrations', CONSENT_MIGRATION)) {
        const st = createService(db.store).settings();
        await db.run((s) => migrateConsents(s, { at: new Date(now()).toISOString(), langOf: (u) => langOf(u, st) }), { write: true });
      }
    })().catch((e) => {
      booting = null; // try again on the next request
      throw e;
    });
    return booting;
  }

  function createFirstAccount(store) {
    if (store.list('users').length) return; // another instance got there first
    if (env.SEED_DEMO === 'true') {
      seedDemo(store, { hashPassword, password: env.DEMO_PASSWORD || 'demo1234' });
      console.log('Seeded demo data. Sign in as moe@demo.shiftboard / demo1234');
      return;
    }
    const email = (env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    const password = env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    store.insert('users', {
      id: uid('usr'), name: env.ADMIN_NAME || 'Admin', email, role: 'admin', jobCodes: [], active: true, availability: {},
      passwordHash: hashPassword(password), smsConsent: false, emailConsent: false, createdAt: new Date().toISOString(),
    });
    // A new install has nobody from before consent records (the demo data is treated as if it had).
    store.insert('migrations', { id: CONSENT_MIGRATION, at: new Date().toISOString(), users: 0 });
    console.log(`Created admin account: ${email} / ${env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password}`);
  }

  // ---------- sessions ----------
  // On the platform a session carries its restaurant (t) and works on that restaurant's host only. A session
  // with no t is from before the platform existed: it belongs to the default restaurant (Chasing Rabbits).
  // "Sign in as owner" sessions also carry sup: { by: the DubLow admin's email, until: ms }.
  const sign = (u, extra = {}, expiresIn = '30d') => jwt.sign({ sub: u.id, v: u.sessionVersion || 0, ...(tenant ? { t: tenant.id } : {}), ...extra }, secret, { expiresIn });
  const icalToken = (userId) => crypto.createHmac('sha256', secret).update(`ical:${userId}`).digest('hex').slice(0, 24);

  /** The signed-in person and the session's claims, or null. */
  function session(store, token) {
    if (!token) return null;
    try {
      const claims = jwt.verify(token, secret);
      if (claims.p) return null; // a sign-in ticket or an onboarding session is never a session
      if (tenant && (claims.t ?? (tenant.isDefault ? tenant.id : null)) !== tenant.id) return null; // another restaurant's session
      if (claims.sup && !(Number(claims.sup.until) > now())) return null; // support session over
      const u = store.get('users', claims.sub);
      if (!u || u.active === false) return null;
      if ((u.sessionVersion || 0) !== (claims.v || 0)) return null; // password change invalidates sessions
      return { user: u, claims };
    } catch {
      return null;
    }
  }
  const userFromToken = (store, token) => session(store, token)?.user || null;
  // The phone app (mobile/) sends the same signed session as a header, Authorization: Bearer <token>,
  // instead of the cookie. Same JWT, same 30-day expiry, same sign-out on password change.
  const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1] || null;
  const sessionToken = (req) => bearer(req) || req.cookies[COOKIE];
  /** Who a request is computed as: the viewed person while a Super Admin views as someone (server/view-as.js), else the signed-in person. */
  const whoIs = (req, token = sessionToken(req)) => req.sbView?.actor ?? userFromToken(db.store, token);
  const planFeatures = () => (tenant ? tenant.features || null : null); // Roles & features: plan ∩ role (core/role-features.js)

  // ---------- email ----------
  // Links in emails point at APP_URL, else the production domain, else this request's host.
  const appUrl = (req) => (env.APP_URL
    || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : req ? `${req.protocol}://${req.get('host')}` : '')).replace(/\/+$/, '');
  const restaurantName = () => createService(db.store).settings().restaurantName;
  // The language to write to someone in: theirs, else the restaurant's default, else English (core/i18n.js).
  const langFor = (u) => langOf(u, createService(db.store).settings());
  // The restaurant's color and logo for emails (Settings → Branding).
  const brandOf = (req) => {
    const st = createService(db.store).settings();
    return { color: st.brandColor || '', logoUrl: st.logoVersion ? `${appUrl(req)}/api/branding/logo?v=${st.logoVersion}` : '' };
  };

  // Work that finishes after the response (emails). On Vercel, waitUntil keeps the function alive for it.
  const pending = new Set();
  function background(promise) {
    const p = Promise.resolve(promise).catch((e) => console.error('Email failed:', e.message)).finally(() => pending.delete(p));
    pending.add(p);
    if (env.VERCEL) waitUntil(p);
  }

  // Email a copy of each new in-app notification (after the commit), unless the restaurant or the person turned
  // email off, in the words the restaurant chose for that type of email (server/notify-email.js).
  function emailNotifications(changes, req) {
    if (!mailer.enabled) return;
    const notes = changes.filter((c) => c.col === 'notifications' && c.isNew).map((c) => c.doc);
    if (!notes.length) return;
    const st = createService(db.store).settings();
    if (st.emailNotifications === false) return;
    background(sendNotificationEmails({ notes, store: db.store, settings: st, appUrl: appUrl(req), brand: brandOf(req), mailer, idempotencyKey: `ntf-${notes[0].id}` }));
  }

  // Phone notifications and text messages (server/channels.js): sent after the commit too, never failing the request.
  const channels = createChannels({ db, env, pusher, texter, background, appUrl, signedIn: (req) => userFromToken(db.store, req.cookies[COOKIE]) });
  // Push each new in-app notification to the person's phones (the ShiftBoard app), after the commit.
  function pushToPhones(changes) {
    if (!expoPush.enabled || !changes.some((c) => c.col === 'notifications' && c.isNew)) return;
    background(pushNotifications({ changes, db, push: expoPush, title: restaurantName() }).catch((e) => console.error('Push failed:', e.message)));
  }

  const stamp = (userIds, field) => userIds.length && db.run((s) => { for (const id of userIds) s.update('users', id, { [field]: new Date().toISOString() }); }, { write: true });

  /**
   * Email someone a link: an invitation (7 days, single use) to the welcome wizard for someone who has never
   * signed in, or a password reset link (24 hours) for someone who has. True when Resend accepted it.
   * Invitations go by email only, never by text.
   */
  async function sendInvite(user, invitedBy, req) {
    if (!mailer.enabled || !deliverable(user.email)) return false;
    const returning = !!user.lastLoginAt;
    const token = await db.createToken(user.id, returning ? 'reset' : 'invite', returning ? 24 * 60 : 7 * 24 * 60);
    const link = `${appUrl(req)}/#/${returning ? 'reset' : 'welcome'}?token=${token}`;
    const lang = langFor(user);
    await mailer.send(returning
      ? resetEmail({ user, link, restaurant: restaurantName(), hours: 24, sentBy: invitedBy, brand: brandOf(req), lang })
      : inviteEmail({ user, link, restaurant: restaurantName(), invitedBy, brand: brandOf(req), lang }));
    await stamp([user.id], 'invitedAt');
    return true;
  }

  /**
   * Invitations for people a smart import just made (only when the manager asked: options.invite / sendInvitations).
   * Email only, never a text; people who can't get one (no real email, inactive, signed in before) are counted.
   */
  async function inviteImported(userIds, invitedBy, req) {
    const out = { sent: 0, noEmail: 0, failed: 0 };
    await db.sync();
    for (const id of [...new Set(userIds || [])].slice(0, 500)) {
      const u = db.store.get('users', id);
      if (!u || u.active === false || u.lastLoginAt) continue;
      if (!mailer.enabled || !deliverable(u.email)) { out.noEmail++; continue; }
      try { if (await sendInvite(u, invitedBy, req)) out.sent++; else out.noEmail++; } catch (e) { console.error('Import invite failed:', e.message); out.failed++; }
    }
    return out;
  }

  /** What the web app needs to know about the restaurant on the platform (null without a tenant). */
  function tenantInfo(user, claims = {}) {
    if (!tenant) return null;
    return {
      slug: tenant.slug, plan: tenant.plan, status: tenant.status, features: { ...tenant.features }, managed: !tenant.isDefault,
      support: claims.sup ? { by: claims.sup.by, until: new Date(Number(claims.sup.until)).toISOString() } : null,
      // Billing banners are for the restaurant's admins only, never staff.
      billing: user && canChangeSettings(user) ? billingBanner({ status: tenant.status, trial_ends_at: tenant.trialEndsAt }, now()) : null,
    };
  }

  // The Privacy Policy and Terms (PRIVACY_URL / TERMS_URL override the defaults in core/consent.js).
  const legal = legalLinks(env);

  const sendError = (res, e, label) => {
    const status = e instanceof AppError ? e.status : 500;
    if (status === 500) console.error(label, e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
  };

  // ---------- app ----------
  const app = express();
  app.locals.ready = ready;
  app.locals.settled = () => Promise.all([...pending]); // for tests and graceful shutdown
  // For the platform (server/platform/): the daily Toast sync for this restaurant, and the owner's invite.
  app.locals.toastCron = async ({ budgetMs } = {}) => { await ready(); return toastCron({ db, env, budgetMs }); };
  /**
   * Invite someone to set their password: by email when email is set up, otherwise a link to show once.
   * base is the restaurant's address (the platform console passes it; links from requests use their own host).
   */
  app.locals.invite = async (userId, { invitedBy = 'DubLow Digital', base = '', linkOnly = false } = {}) => {
    await ready();
    await db.sync();
    const user = db.store.get('users', userId);
    if (!user) throw new Error('No such person');
    const fakeReq = base ? { protocol: new URL(base).protocol.replace(':', ''), get: () => new URL(base).host } : null;
    if (!linkOnly && mailer.enabled && deliverable(user.email)) {
      await sendInvite(user, invitedBy, fakeReq);
      return { emailed: true, to: user.email };
    }
    const token = await db.createToken(user.id, 'invite', 7 * 24 * 60);
    await stamp([user.id], 'invitedAt');
    return { emailed: false, link: `${appUrl(fakeReq)}/#/welcome?token=${token}` };
  };
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Tripleseat's webhook signature covers the exact bytes it sent, so that route keeps them (req.rawBody).
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl?.startsWith('/api/tripleseat/webhook/')) req.rawBody = buf; } }));
  app.use(cookieParser());
  // Error messages in the caller's language (core/errors.js): every API answer with an `error` goes through here.
  // Signed in: their language (or, if they haven't picked one, the app's, sent as X-ShiftBoard-Language).
  // Signed out: the app's language, else the restaurant's default, else the browser's (Accept-Language).
  const requestLang = (req) => {
    if (req.sbLang) return req.sbLang;
    let user = null;
    let st = null;
    try { user = secret ? userFromToken(db.store, sessionToken(req)) : null; } catch { /* signed out */ }
    if (isLang(user?.language)) return user.language;
    const asked = String(req.get('x-shiftboard-language') || '').toLowerCase();
    if (isLang(asked)) return asked;
    try { st = createService(db.store).settings(); } catch { /* no settings yet */ }
    if (isLang(st?.language)) return st.language;
    return /^es\b/i.test(String(req.get('accept-language') || '').trim()) ? 'es' : 'en';
  };
  app.use('/api', (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && (typeof body.error === 'string' || typeof body.result?.inviteError === 'string')) {
        const lang = requestLang(req);
        if (lang !== 'en') {
          if (typeof body.error === 'string') body = { ...body, error: translateError(body.error, lang) };
          if (typeof body.result?.inviteError === 'string') body = { ...body, result: { ...body.result, inviteError: translateError(body.result.inviteError, lang) } };
        }
      }
      return json(body);
    };
    next();
  });
  // Errors & reports (server/errors.js): the platform's log tagged with this restaurant, else this schema's own.
  const errors = tenant?.errors || new ErrorLog({ conn: db.conn, schema: db.schema, env, mailer, texter: texter || createTexter(env), now, background: env.VERCEL ? waitUntil : null }).forTenant(null);
  app.locals.errors = errors;
  app.use(captureErrors({ recorder: errors, userOf: (req) => userFromToken(db.store, sessionToken(req)) })); // 500s and failed syncs
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api', async (req, res, next) => {
    try {
      await ready();
      next();
    } catch (e) {
      console.error('ShiftBoard could not reach its database:', e.message);
      res.status(503).json({ error: 'The database is not reachable right now. Try again in a minute.' });
    }
  });

  // A suspended or canceled restaurant: nobody signs in, nothing is read or written; the data is kept.
  // The sign-in page still gets its branding (/api/config says paused) and can show why.
  if (paused) {
    const open = new Set(['/config', '/health', '/branding/logo', '/auth/logout']);
    app.use('/api', (req, res, next) => (open.has(req.path) ? next() : res.status(403).json({ error: PAUSED, paused: true })));
  }
  // Routes of features the restaurant's plan doesn't include (the RPCs are checked in /api/rpc below).
  for (const [prefix, feature] of ROUTE_FEATURES) {
    app.use(prefix, (req, res, next) => (has(feature) ? next() : res.status(403).json({ error: NOT_IN_PLAN })));
  }
  // View as (server/view-as.js): a Super Admin sees the app as someone else, read-only. Marks the request
  // (req.sbView) and refuses every write route; RPCs are handled in /api/rpc below.
  const viewAs = createViewAs({ db, tenant, now, secret: () => secret, session, bearer, cookie: COOKIE, cookieOpts, langFor });
  app.use('/api', viewAs.middleware);
  viewAs.routes(app);
  // Routes of features the caller's role doesn't include (Settings → Roles & features; RPCs: core/service.js).
  for (const [prefix, feature] of ROLE_ROUTES) {
    app.use(prefix, async (req, res, next) => {
      try { await db.sync(); } catch (e) { return next(e); }
      const u = whoIs(req);
      const st = { ...createService(db.store).settings(), ...(req.sbView?.draft ? cleanDraft(req.sbView.draft) : {}) };
      if (u && roleAllows(u, st)[feature] === false) return res.status(403).json({ error: ROLE_OFF });
      next();
    });
  }

  // Signing in, the second step, passkeys, email links, password reset and sign-in settings (server/auth.js),
  // and the invitation wizard (server/onboarding.js).
  const auth = createAuth({
    db, env, tenant, now, mailer, secret: () => secret, sign, session, sessionToken, cookie: COOKIE, cookieOpts,
    appUrl, restaurantName, brandOf, langFor, background, stamp, hashPassword,
  });
  auth.routes(app);
  mountOnboarding(app, { db, env, tenant, now, auth, channels, langFor, hashPassword, cookieOpts, secret: () => secret });
  // Announcements: the batches that send them after the commit, and their cron (server/announcements.js).
  const announcer = mountAnnouncements(app, { db, env, mailer, channels, expoPush, background, appUrl, has, brandOf, now });

  app.post('/api/rpc/:method', async (req, res) => {
    const method = req.params.method;
    const token = sessionToken(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      // Reject signed-out callers before they can take the write lock.
      await db.sync();
      const sess = session(db.store, token);
      const caller = sess?.user;
      if (!caller) throw new AppError(401, 'Please sign in');
      const feature = featuresForMethod(method).find((f) => !has(f)); // the first one the plan doesn't include
      if (feature) throw new AppError(403, NOT_IN_PLAN);
      if (sess.claims.sup && NOT_IN_SUPPORT.has(method)) throw new AppError(403, 'Not available while DubLow Digital is signed in for support');

      if (isLang(caller.language)) req.sbLang = caller.language; // errors in the caller's language
      // View as: reads only, computed as the viewed person, never saved (server/view-as.js).
      if (req.sbView) {
        let result = await viewAs.rpc(req.sbView, method, body, { hashPassword, channels: channels.info, request: { ip: req.ip, userAgent: req.get('user-agent') || null }, legal, planFeatures: planFeatures() });
        if (method === 'app.bootstrap' && tenant && result) result = { ...result, tenant: tenantInfo(req.sbView.actor) };
        return res.json({ result: result ?? null });
      }
      // Support sessions can't change the owner's email consent either (language and appearance are fine).
      const args = structuredClone(body);
      if (sess.claims.sup && method === 'account.preferences') { delete args.emailConsent; delete args.emailNotifications; }
      // Consent records keep where the choice came from.
      const request = { ip: req.ip, userAgent: req.get('user-agent') || null };
      const out = await db.run((store) => {
        const actor = userFromToken(store, token);
        if (!actor) throw new AppError(401, 'Please sign in');
        const result = createService(store, { hashPassword, channels: channels.info, request, legal, announce: announcer.info, planFeatures: planFeatures() }).call(actor, method, structuredClone(args));
        // Changing your password signs out other devices; this one gets a fresh cookie.
        const rotated = method === 'employees.changePassword'
          ? store.update('users', actor.id, { sessionVersion: (actor.sessionVersion || 0) + 1 })
          : null;
        return { result, rotated };
      }, {
        write: !READ_ONLY.test(method), synced: true,
        onCommit: (changes) => {
          channels.afterCommit(changes, req); // web push and text messages (server/channels.js)
          emailNotifications(changes, req);
          pushToPhones(changes); // the phone app (Expo push)
        },
      });

      // A new person with an email gets an invitation by email (never by text).
      if (method === 'employees.save' && out.result?.created && out.result.email) {
        try {
          out.result.invited = await sendInvite(out.result, caller.name, req);
          if (!out.result.invited && !out.result.tempPassword) out.result.inviteError = 'Email isn’t set up yet, so no invitation went out. Set a temporary password from their profile, or set up email.';
        } catch (e) {
          console.error('Invite email failed:', e.message);
          out.result.invited = false;
          out.result.inviteError = out.result.tempPassword ? 'The welcome email could not be sent. Share the temporary password instead.'
            : 'The invitation email could not be sent. Try Resend invite in a minute.';
        }
      }

      // A smart import with "Send invitations now": the people it made get their invitation email (never a text).
      if (method === 'employees.importApply' && out.result?.invite?.length) out.result.invited = await inviteImported(out.result.invite, caller.name, req);

      // On the platform, the app learns the restaurant's features, the support banner and (admins only) the billing banner.
      if (method === 'app.bootstrap' && tenant && out.result) out.result = { ...out.result, tenant: tenantInfo(caller, sess.claims) };

      if (out.rotated && bearer(req)) res.set('X-Session-Token', sign(out.rotated)); // the phone app swaps in the new token
      else if (out.rotated) res.cookie(COOKIE, sign(out.rotated), cookieOpts);
      res.json({ result: out.result === undefined ? null : out.result });
    } catch (e) {
      sendError(res, e, method);
    }
  });

  // ---------- email: setup, invites, password reset ----------
  // Public: what the sign-in page needs before anyone signs in (email on/off, the restaurant's branding).
  app.get('/api/config', async (req, res) => {
    let brand = null;
    let language = 'auto';
    try {
      await db.sync();
      const st = createService(db.store).settings();
      brand = { name: st.restaurantName, color: st.brandColor || '', nav: st.navColor || '', bg: st.bgColor || '', mode: st.appearance || 'auto',
        logo: st.logoVersion ? `/api/branding/logo?v=${st.logoVersion}` : '' };
      language = isLang(st.language) ? st.language : 'auto'; // the restaurant's default language, for the sign-in page
    } catch { /* the sign-in page still works with ShiftBoard's look */ }
    // legal and consent: the links and the exact consent words (and versions), for the phone app's consent screen.
    res.json({ email: mailer.enabled, emailFrom: mailer.enabled ? mailer.from : null, brand, language, legal, consent: { text: CONSENT_TEXT, versions: CONSENT_VERSION }, ...channels.config(),
      ...(tenant ? { restaurant: tenant.slug, features: { ...tenant.features }, managed: !tenant.isDefault, ...(paused ? { paused: true } : {}) } : {}) });
  });

  // The restaurant's logo (public: the sign-in page, emails and the browser tab use it).
  app.get('/api/branding/logo', async (req, res) => {
    await db.sync();
    const logo = db.store.get('assets', 'logo');
    if (!logo || !/^image\/(png|jpeg|webp)$/.test(logo.mime)) return res.status(404).end();
    res.set('Content-Type', logo.mime);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    res.set('Content-Security-Policy', "default-src 'none'");
    res.send(Buffer.from(logo.data, 'base64'));
  });

  app.post('/api/email/test', async (req, res) => {
    await db.sync();
    const u = userFromToken(db.store, req.cookies[COOKIE]);
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    if (!canChangeSettings(u)) return res.status(403).json({ error: 'Admins only' });
    if (!mailer.enabled) return res.status(400).json({ error: 'Email isn’t set up yet. Add RESEND_API_KEY and EMAIL_FROM in Vercel, then redeploy.' });
    if (!deliverable(u.email)) return res.status(400).json({ error: 'Your account needs a real email address first.' });
    try {
      await mailer.send(testEmail({ user: u, restaurant: restaurantName(), appUrl: appUrl(req), brand: brandOf(req), lang: langFor(u) }));
      res.json({ result: { ok: true, to: u.email } });
    } catch (e) {
      res.status(502).json({ error: e.message }); // Resend's reason (e.g. domain not verified) helps the admin fix setup
    }
  });

  app.post('/api/users/:id/invite', async (req, res) => {
    await db.sync();
    const actor = userFromToken(db.store, req.cookies[COOKIE]);
    if (!actor) return res.status(401).json({ error: 'Please sign in' });
    const target = db.store.get('users', req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id !== actor.id && !canManageUser(actor, target)) return res.status(403).json({ error: 'You can’t send a sign-in link to this person' });
    if (target.active === false) return res.status(400).json({ error: 'This person is inactive' });
    if (!mailer.enabled) return res.status(400).json({ error: 'Email isn’t set up yet' });
    if (!deliverable(target.email)) return res.status(400).json({ error: 'Add a real email address first' });
    try {
      await sendInvite(target, actor.name, req);
      res.json({ result: { ok: true, to: target.email } });
    } catch (e) {
      console.error('Invite email failed:', e.message);
      res.status(502).json({ error: 'The email could not be sent. Try again in a minute.' });
    }
  });

  // Invite everyone the caller manages who hasn't signed in yet and has an email address.
  app.post('/api/users/invite-all', async (req, res) => {
    await db.sync();
    const actor = userFromToken(db.store, req.cookies[COOKIE]);
    if (!actor) return res.status(401).json({ error: 'Please sign in' });
    if (!canManageSchedule(actor)) return res.status(403).json({ error: 'Managers only' });
    if (!mailer.enabled) return res.status(400).json({ error: 'Email isn’t set up yet' });
    const waiting = db.store.list('users', (u) => u.active !== false && u.id !== actor.id && !u.lastLoginAt && canManageUser(actor, u));
    const ready = waiting.filter((u) => deliverable(u.email));
    const restaurant = restaurantName();
    const base = appUrl(req);
    const messages = [];
    for (const u of ready) {
      const token = await db.createToken(u.id, 'invite', 7 * 24 * 60);
      messages.push(inviteEmail({ user: u, link: `${base}/#/welcome?token=${token}`, restaurant, invitedBy: actor.name, brand: brandOf(req), lang: langFor(u) }));
    }
    try {
      await mailer.sendMany(messages, { idempotencyKey: `invite-all-${actor.id}-${Date.now()}` });
    } catch (e) {
      console.error('Invite-all failed:', e.message);
      return res.status(502).json({ error: 'The emails could not be sent. Try again in a minute.' });
    }
    await stamp(ready.map((u) => u.id), 'invitedAt');
    res.json({ result: { sent: ready.length, noEmail: waiting.length - ready.length } });
  });

  // "Sign in as owner" from the platform console: a one-time link (a few minutes) opens a session as the
  // owner that ends after the minutes DubLow picked. The app shows a banner the whole time, and the
  // sign-in is in the platform's audit log. Only for this restaurant (the grant names it).
  app.get('/api/auth/support', async (req, res) => {
    const fail = () => res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>Support link</title>'
      + '<p style="font:16px system-ui;margin:40px">This support link has expired or was already used. Start a new one from the platform console.</p>');
    if (!tenant?.consumeSupportGrant) return fail();
    const grant = await tenant.consumeSupportGrant(String(req.query.token || ''));
    if (!grant) return fail();
    await db.sync();
    const u = db.store.get('users', grant.userId);
    if (!u || u.active === false) return fail();
    const until = now() + grant.sessionMinutes * 60_000;
    res.cookie(COOKIE, sign(u, { sup: { by: grant.adminEmail, until } }, `${grant.sessionMinutes}m`), { ...cookieOpts, maxAge: grant.sessionMinutes * 60_000 });
    res.redirect(302, '/#/');
  });

  // The billing banner's button (admins). Phase 2 sends them to Stripe's billing portal (server/billing.js);
  // until then there's no portal, and the app says to contact DubLow Digital.
  app.post('/api/billing/portal', async (req, res) => {
    await db.sync();
    const u = userFromToken(db.store, sessionToken(req));
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    if (!canChangeSettings(u)) return res.status(403).json({ error: 'Admins only' });
    const portal = await billingPortal({ tenant, returnUrl: `${appUrl(req)}/#/settings` });
    res.json({ result: { url: portal?.url || null } });
  });

  app.get('/api/health', async (req, res) => {
    await db.sync();
    res.json({ ok: true });
  });

  // Calendar feed (iCal) per user, authenticated by a per-user token.
  app.get('/api/ical/:userId/:token.ics', async (req, res) => {
    await db.sync();
    const u = db.store.get('users', req.params.userId);
    if (!u || !sameString(req.params.token, icalToken(u.id))) return res.status(404).end();
    const shifts = db.store.list('shifts', (s) => s.userId === u.id && s.published);
    const jobs = Object.fromEntries(db.store.list('jobCodes').map((j) => [j.id, j.name]));
    const st = createService(db.store).settings();
    const dt = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
    const icalText = (v) => String(v).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ShiftBoard//EN', `X-WR-CALNAME:${st.restaurantName} shifts`];
    for (const raw of shifts) {
      const s = effectiveShift(raw, st);
      const endDate = s.end <= s.start ? addDays(s.date, 1) : s.date;
      lines.push('BEGIN:VEVENT', `UID:${s.id}@shiftboard`, `DTSTAMP:${dt(s.date, s.start)}`, `DTSTART:${dt(s.date, s.start)}`, `DTEND:${dt(endDate, s.end)}`,
        `SUMMARY:${icalText(jobs[s.jobCodeId] || 'Shift')}${s.tag ? ' · ' + icalText(s.tag) : ''}${raw.end || st.startTimesOnly ? '' : ' (until close)'}`,
        ...(s.area ? [`LOCATION:${icalText(s.area)}`] : []), 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    res.type('text/calendar').send(lines.join('\r\n'));
  });

  app.post('/api/rpc-ical-link', async (req, res) => {
    await db.sync();
    const u = userFromToken(db.store, sessionToken(req));
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    res.json({ result: `/api/ical/${u.id}/${icalToken(u.id)}.ics` });
  });

  channels.routes(app); // /api/push/test, /api/sms/test, /api/twilio/inbound
  // The printable schedule PDF and Settings → Email notifications → Send me a test (server/schedule-pdf-routes.js).
  mountSchedulePdf(app, { db, mailer, signedIn: (req) => userFromToken(db.store, sessionToken(req)), appUrl, brandOf });
  // Profile photos, the consent log CSV (admins) and the public text opt-in page (server/public-routes.js).
  publicRoutes(app, { db, env, legal, signedIn: (req) => whoIs(req), restaurantName });
  // Toast POS: status, Sync now, and the daily Vercel Cron (server/toast-routes.js).
  mountToast(app, { db, env, userOf: (req) => whoIs(req, req.cookies[COOKIE]), managed: !!tenant && !tenant.isDefault });
  // ADP: status, Sync now, and its daily Vercel Cron (server/adp-routes.js). The CSV import is plain RPC.
  mountAdp(app, { db, env, userOf: (req) => whoIs(req, req.cookies[COOKIE]) });
  // Tripleseat: status, Sync now, its webhook and daily Vercel Cron (server/tripleseat-routes.js). A sync's
  // notifications (staff on a changed event) go out like any other: email, web push, texts, the phone app.
  mountTripleseat(app, {
    db, env, userOf: (req) => whoIs(req, req.cookies[COOKIE]), managed: !!tenant && !tenant.isDefault,
    onCommit: (changes, req) => { channels.afterCommit(changes, req); emailNotifications(changes, req); pushToPhones(changes); },
  });
  // OpenTable's API: status, Sync now and its daily Vercel Cron (server/opentable-routes.js). Its exports are plain RPC.
  // A sync's notifications ("you were mentioned in a 5-star review") go out like any other.
  mountOpenTable(app, {
    db, env, userOf: (req) => userFromToken(db.store, req.cookies[COOKIE]), managed: !!tenant && !tenant.isDefault,
    onCommit: (changes, req) => { channels.afterCommit(changes, req); emailNotifications(changes, req); pushToPhones(changes); },
  });
  // Google Business Profile and Yelp reviews (server/google-routes.js, server/yelp-routes.js), and answering
  // reviews: AI drafts, posting to Google, the daily /api/cron/reviews (server/review-replies.js). Review alerts
  // go out like any other notification.
  const reviewCommit = (changes, req) => { channels.afterCommit(changes, req); emailNotifications(changes, req); pushToPhones(changes); };
  const google = mountGoogle(app, { db, env, tenant, userOf: (req) => whoIs(req, req.cookies[COOKIE]), secret: () => secret, appUrl, onCommit: reviewCommit, now, secure: PROD,
    ...(reviewClients.google ? { makeClient: reviewClients.google } : {}) });
  mountYelp(app, { db, env, userOf: (req) => whoIs(req, req.cookies[COOKIE]), onCommit: reviewCommit, managed: !!tenant && !tenant.isDefault, ...(reviewClients.yelp ? { makeClient: reviewClients.yelp } : {}) });
  mountReviewReplies(app, { db, env, tenant, userOf: (req) => whoIs(req, req.cookies[COOKIE]), now, onCommit: reviewCommit, google, ...(reviewClients.ai ? { aiImporter: reviewClients.ai } : {}) });
  // Settings → Integrations: the restaurant's admins set up ADP, Toast, Tripleseat, the text sender and the
  // email From themselves (server/integrations-routes.js); read-only from env on a single-restaurant install.
  mountIntegrations(app, { db, env, tenant, userOf: (req) => whoIs(req) });
  // Training photos (menu study guide, quizzes), for signed-in staff only (cookie on the web, bearer token in the phone app).
  trainingRoutes(app, { db, signedIn: (req) => whoIs(req) });
  // 86 List photos, for people who can see the item's list (cookie on the web, bearer token in the phone app).
  eightySixRoutes(app, { db, signedIn: (req) => whoIs(req) });
  // The apps' own crashes and "Report a problem", signed in or out (server/errors-routes.js).
  errorRoutes(app, { recorder: errors, userOf: async (req) => { await db.sync(); return whoIs(req); }, now });
  // The Claude connector (server/mcp/): /mcp, OAuth (/oauth/*, /.well-known/*), the consent screen and Connected apps.
  // Its tools call the same RPCs as the app (server/tools/), and what they change notifies people the same way.
  mountMcp(app, {
    db, env, tenant, now, has, paused, secret: () => secret, session, sessionToken, ready,
    serviceOpts: (req) => ({ hashPassword, channels: channels.info, request: { ip: req.ip, userAgent: req.get('user-agent') || null }, legal, announce: announcer.info, planFeatures: planFeatures() }),
    onCommit: (changes, req) => { channels.afterCommit(changes, req); emailNotifications(changes, req); pushToPhones(changes); },
    invite: inviteImported,
  });

  // Ask ShiftBoard (server/assistant/): Claude in the app, as the signed-in person, with the same tools as the
  // connector; metered and capped per restaurant (server/ai/). What its confirmed changes do notifies people as usual.
  mountAssistant(app, {
    db, env, tenant, now, has, session, sessionToken, planFeatures, aiClient, invite: inviteImported,
    serviceOpts: (req) => ({ hashPassword, channels: channels.info, request: { ip: req.ip, userAgent: req.get('user-agent') || null }, legal, announce: announcer.info, planFeatures: planFeatures() }),
    onCommit: (changes, req) => { channels.afterCommit(changes, req); emailNotifications(changes, req); pushToPhones(changes); },
  });

  // "Read it with AI" for a BEO that isn't Tripleseat's layout (server/beo-ai-routes.js): metered like every AI call.
  mountBeoAi(app, { db, env, tenant, now, has, userOf: (req) => whoIs(req), aiClient });
  // Smart import → Read it with AI (server/import-routes.js); the rest of the import is plain RPC (core/import-api.js).
  mountImport(app, { db, env, tenant, now, has, aiClient, signedIn: (req) => whoIs(req) });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- static web app (standalone server only) ----------
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h', extensions: ['html'] })); // /privacy → privacy.html
    // root: send() refuses absolute paths that go through a dot-directory; relative to root it checks only 'index.html'.
    // The phone app's browser version (dist/app, npm run build:app) has its own page for its routes.
    if (fs.existsSync(`${staticDir}/app/index.html`)) app.get(/^\/app(\/.*)?$/, (req, res) => res.sendFile('app/index.html', { root: staticDir }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile('index.html', { root: staticDir }));
  }

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
