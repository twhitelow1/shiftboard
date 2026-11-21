// The HTTP API. Shared by the Vercel function (api/index.js) and the standalone
// server (server/index.js). All state lives in Postgres via DocDb.
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { canChangeSettings, canManageUser, canManageSchedule } from '../core/roles.js';
import { createMailer, deliverable, notificationEmail, inviteEmail, resetEmail, testEmail } from './email.js';
import { createChannels } from './channels.js';
import { trainingRoutes } from './training-routes.js';
import { uid } from '../core/store.js';
import { createService, AppError } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { effectiveShift } from '../core/forecast.js';
import { addDays } from '../core/time.js';
import { mountToast } from './toast-routes.js';

const COOKIE = 'sb_session';
const MAX_LOGIN_ATTEMPTS = 10; // per IP + email, per 15 minutes
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
 */
export function createApp({ db, env = process.env, staticDir, mailer = createMailer(env), pusher, texter } = {}) {
  const PROD = env.NODE_ENV === 'production';
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 1000 * 60 * 60 * 24 * 30 };
  let secret = null;

  // ---------- startup: schema, signing secret, first account ----------
  let booting = null;
  function ready() {
    booting ??= (async () => {
      await db.migrate();
      secret = env.JWT_SECRET || (await db.ensureMeta('jwt_secret', () => crypto.randomBytes(48).toString('hex')));
      await db.sync();
      if (!db.store.col('users').size) await db.run(createFirstAccount, { write: true });
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
      passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
    });
    console.log(`Created admin account: ${email} / ${env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password}`);
  }

  // ---------- sessions ----------
  const sign = (u) => jwt.sign({ sub: u.id, v: u.sessionVersion || 0 }, secret, { expiresIn: '30d' });
  const icalToken = (userId) => crypto.createHmac('sha256', secret).update(`ical:${userId}`).digest('hex').slice(0, 24);

  function userFromToken(store, token) {
    if (!token) return null;
    try {
      const { sub, v } = jwt.verify(token, secret);
      const u = store.get('users', sub);
      if (!u || u.active === false) return null;
      if ((u.sessionVersion || 0) !== (v || 0)) return null; // password change invalidates sessions
      return u;
    } catch {
      return null;
    }
  }

  // ---------- email ----------
  // Links in emails point at APP_URL, else the production domain, else this request's host.
  const appUrl = (req) => (env.APP_URL
    || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : `${req.protocol}://${req.get('host')}`)).replace(/\/+$/, '');
  const restaurantName = () => createService(db.store).settings().restaurantName;
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

  // Email a copy of each new in-app notification (after the commit), unless the restaurant
  // or the person turned email off.
  function emailNotifications(changes, req) {
    if (!mailer.enabled) return;
    const notes = changes.filter((c) => c.col === 'notifications' && c.isNew).map((c) => c.doc);
    if (!notes.length) return;
    const st = createService(db.store).settings();
    if (st.emailNotifications === false) return;
    const url = appUrl(req);
    const messages = [];
    for (const n of notes) {
      const u = db.store.get('users', n.userId);
      if (!u || u.active === false || u.emailNotifications === false || !deliverable(u.email)) continue;
      messages.push(notificationEmail({ user: u, note: n, appUrl: url, restaurant: st.restaurantName, brand: brandOf(req) }));
    }
    if (messages.length) background(mailer.sendMany(messages, { idempotencyKey: `ntf-${notes[0].id}` }));
  }

  // Phone notifications and text messages (server/channels.js): sent after the commit too, never failing the request.
  const channels = createChannels({ db, env, pusher, texter, background, appUrl, signedIn: (req) => userFromToken(db.store, req.cookies[COOKIE]) });

  const stamp = (userIds, field) => userIds.length && db.run((s) => { for (const id of userIds) s.update('users', id, { [field]: new Date().toISOString() }); }, { write: true });

  /**
   * Email someone a link to set their password: a welcome invite (7 days) for someone who has
   * never signed in, or a reset link (24 hours) for someone who has. True when Resend accepted it.
   */
  async function sendInvite(user, invitedBy, req) {
    if (!mailer.enabled || !deliverable(user.email)) return false;
    const returning = !!user.lastLoginAt;
    const token = await db.createToken(user.id, returning ? 'reset' : 'invite', returning ? 24 * 60 : 7 * 24 * 60);
    const link = `${appUrl(req)}/#/reset?token=${token}`;
    await mailer.send(returning
      ? resetEmail({ user, link, restaurant: restaurantName(), hours: 24, sentBy: invitedBy, brand: brandOf(req) })
      : inviteEmail({ user, link, restaurant: restaurantName(), invitedBy, brand: brandOf(req) }));
    await stamp([user.id], 'invitedAt');
    return true;
  }

  const sendError = (res, e, label) => {
    const status = e instanceof AppError ? e.status : 500;
    if (status === 500) console.error(label, e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
  };

  // ---------- app ----------
  const app = express();
  app.locals.ready = ready;
  app.locals.settled = () => Promise.all([...pending]); // for tests and graceful shutdown
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
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

  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    // Hashed so the rate-limit table doesn't hold IPs or emails.
    const key = crypto.createHash('sha256').update(`${req.ip}|${email}`).digest('hex');
    const [attempts] = await Promise.all([db.countAttempts(key), db.sync()]);
    if (attempts >= MAX_LOGIN_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = db.store.list('users', (x) => x.email === email)[0];
    if (!u || u.active === false || !(await bcrypt.compare(password, u.passwordHash || ''))) {
      await db.recordAttempt(key);
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    await db.clearAttempts(key);
    await stamp([u.id], 'lastLoginAt');
    res.cookie(COOKIE, sign(u), cookieOpts).json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }).json({ ok: true });
  });

  app.post('/api/rpc/:method', async (req, res) => {
    const method = req.params.method;
    const token = req.cookies[COOKIE];
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      // Reject signed-out callers before they can take the write lock.
      await db.sync();
      const caller = userFromToken(db.store, token);
      if (!caller) throw new AppError(401, 'Please sign in');

      const out = await db.run((store) => {
        const actor = userFromToken(store, token);
        if (!actor) throw new AppError(401, 'Please sign in');
        const result = createService(store, { hashPassword, channels: channels.info }).call(actor, method, structuredClone(body));
        // Changing your password signs out other devices; this one gets a fresh cookie.
        const rotated = method === 'employees.changePassword'
          ? store.update('users', actor.id, { sessionVersion: (actor.sessionVersion || 0) + 1 })
          : null;
        return { result, rotated };
      }, { write: !READ_ONLY.test(method), synced: true, onCommit: (changes) => { channels.afterCommit(changes, req); emailNotifications(changes, req); } });

      // A new person with an email gets a link to set their own password.
      if (method === 'employees.save' && out.result?.tempPassword && out.result.email) {
        try {
          out.result.invited = await sendInvite(out.result, caller.name, req);
        } catch (e) {
          console.error('Invite email failed:', e.message);
          out.result.invited = false;
          out.result.inviteError = 'The welcome email could not be sent. Share the temporary password instead.';
        }
      }

      if (out.rotated) res.cookie(COOKIE, sign(out.rotated), cookieOpts);
      res.json({ result: out.result === undefined ? null : out.result });
    } catch (e) {
      sendError(res, e, method);
    }
  });

  // ---------- email: setup, invites, password reset ----------
  // Public: what the sign-in page needs before anyone signs in (email on/off, the restaurant's branding).
  app.get('/api/config', async (req, res) => {
    let brand = null;
    try {
      await db.sync();
      const st = createService(db.store).settings();
      brand = { name: st.restaurantName, color: st.brandColor || '', nav: st.navColor || '', bg: st.bgColor || '', mode: st.appearance || 'auto',
        logo: st.logoVersion ? `/api/branding/logo?v=${st.logoVersion}` : '' };
    } catch { /* the sign-in page still works with ShiftBoard's look */ }
    res.json({ email: mailer.enabled, emailFrom: mailer.enabled ? mailer.from : null, brand, ...channels.config() });
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
      await mailer.send(testEmail({ user: u, restaurant: restaurantName(), appUrl: appUrl(req), brand: brandOf(req) }));
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
      messages.push(inviteEmail({ user: u, link: `${base}/#/reset?token=${token}`, restaurant, invitedBy: actor.name, brand: brandOf(req) }));
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

  app.post('/api/auth/forgot', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!mailer.enabled) return res.status(400).json({ error: 'Password reset by email isn’t set up. Ask a manager to reset it.' });
    const key = crypto.createHash('sha256').update(`forgot|${req.ip}|${email}`).digest('hex');
    const [attempts] = await Promise.all([db.countAttempts(key), db.sync()]);
    if (attempts >= 5) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
    await db.recordAttempt(key);
    const u = db.store.list('users', (x) => x.email === email)[0];
    if (u && u.active !== false && deliverable(u.email)) {
      // Sent in the background so the reply takes the same time whether or not the account exists.
      background((async () => {
        const token = await db.createToken(u.id, 'reset', 60);
        await mailer.send(resetEmail({ user: u, link: `${appUrl(req)}/#/reset?token=${token}`, restaurant: restaurantName(), brand: brandOf(req) }));
      })());
    }
    res.json({ ok: true }); // same answer either way, so this can't be used to find accounts
  });

  app.post('/api/auth/reset', async (req, res) => {
    try {
      const password = String(req.body?.password || '');
      if (password.length < 6) throw new AppError(400, 'Password must be at least 6 characters');
      const t = await db.consumeToken(req.body?.token);
      if (!t) throw new AppError(400, 'This link has expired or was already used. Ask for a new one.');
      const user = await db.run((store) => {
        const u = store.get('users', t.userId);
        if (!u || u.active === false) throw new AppError(400, 'This account is inactive. Ask a manager.');
        return store.update('users', u.id, { passwordHash: hashPassword(password), sessionVersion: (u.sessionVersion || 0) + 1 });
      }, { write: true });
      await db.revokeTokens(user.id);
      await stamp([user.id], 'lastLoginAt');
      res.cookie(COOKIE, sign(db.store.get('users', user.id) || user), cookieOpts).json({ ok: true });
    } catch (e) {
      sendError(res, e, 'reset');
    }
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
    const u = userFromToken(db.store, req.cookies[COOKIE]);
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    res.json({ result: `/api/ical/${u.id}/${icalToken(u.id)}.ics` });
  });

  channels.routes(app); // /api/push/test, /api/sms/test, /api/twilio/inbound
  // Toast POS: status, Sync now, and the daily Vercel Cron (server/toast-routes.js).
  mountToast(app, { db, env, userOf: (req) => userFromToken(db.store, req.cookies[COOKIE]) });
  // Training photos (menu study guide, quizzes), for signed-in staff only.
  trainingRoutes(app, { db, signedIn: (req) => userFromToken(db.store, req.cookies[COOKIE]) });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- static web app (standalone server only) ----------
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
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
