// The HTTP API. Shared by the Vercel function (api/index.js) and the standalone
// server (server/index.js). All state lives in Postgres via DocDb.
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { uid } from '../core/store.js';
import { createService, AppError } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { effectiveShift } from '../core/forecast.js';
import { addDays } from '../core/time.js';

const COOKIE = 'sb_session';
const MAX_LOGIN_ATTEMPTS = 10; // per IP + email, per 15 minutes
// Methods that only read. Purely a speed hint: if one of these ever writes, DocDb
// notices and redoes it under the write lock.
const READ_ONLY = /\.(bootstrap|list|get|eligible|week|summary|suggestStaffing)$/;

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
 */
export function createApp({ db, env = process.env, staticDir } = {}) {
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

  // ---------- app ----------
  const app = express();
  app.locals.ready = ready;
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
      if (!userFromToken(db.store, token)) throw new AppError(401, 'Please sign in');

      const out = await db.run((store) => {
        const actor = userFromToken(store, token);
        if (!actor) throw new AppError(401, 'Please sign in');
        const result = createService(store, { hashPassword }).call(actor, method, structuredClone(body));
        // Changing your password signs out other devices; this one gets a fresh cookie.
        const rotated = method === 'employees.changePassword'
          ? store.update('users', actor.id, { sessionVersion: (actor.sessionVersion || 0) + 1 })
          : null;
        return { result, rotated };
      }, { write: !READ_ONLY.test(method), synced: true });

      if (out.rotated) res.cookie(COOKIE, sign(out.rotated), cookieOpts);
      res.json({ result: out.result === undefined ? null : out.result });
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if (status === 500) console.error(method, e);
      res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
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
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ShiftBoard//EN', `X-WR-CALNAME:${st.restaurantName} shifts`];
    for (const raw of shifts) {
      const s = effectiveShift(raw, st);
      const endDate = s.end <= s.start ? addDays(s.date, 1) : s.date;
      lines.push('BEGIN:VEVENT', `UID:${s.id}@shiftboard`, `DTSTAMP:${dt(s.date, s.start)}`, `DTSTART:${dt(s.date, s.start)}`, `DTEND:${dt(endDate, s.end)}`,
        `SUMMARY:${jobs[s.jobCodeId] || 'Shift'}${s.tag ? ' · ' + s.tag : ''}${raw.end ? '' : ' (until close)'}`, 'END:VEVENT');
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
