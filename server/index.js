import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryStore, uid } from '../core/store.js';
import { createService, AppError } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { effectiveShift } from '../core/forecast.js';
import { addDays } from '../core/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PROD = process.env.NODE_ENV === 'production';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- secret ----------
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(f, 'utf8').trim();
}

// ---------- persistence: SQLite document table, write-through from the memory store ----------
const db = new Database(path.join(DATA_DIR, 'shiftboard.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (col, id))`);
const putStmt = db.prepare('INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
const delStmt = db.prepare('DELETE FROM docs WHERE col = ? AND id = ?');

const store = new MemoryStore({
  onChange(col, op, doc) {
    if (op === 'put') putStmt.run(col, doc.id, JSON.stringify(doc), new Date().toISOString());
    else delStmt.run(col, doc.id);
  },
});
// Wrap multi-write operations in one SQLite transaction.
store.beginTx = (fn) => db.transaction(fn)();

for (const row of db.prepare('SELECT col, data FROM docs').iterate()) store.hydrate(row.col, [JSON.parse(row.data)]);

const hashPassword = (p) => bcrypt.hashSync(p, 10);

if (!store.list('users').length) {
  if (process.env.SEED_DEMO === 'true') {
    store.transaction(() => seedDemo(store, { hashPassword, password: process.env.DEMO_PASSWORD || 'demo1234' }));
    console.log('Seeded demo data. Sign in as moe@demo.shiftboard / demo1234');
  } else {
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    store.insert('users', { id: uid('usr'), name: process.env.ADMIN_NAME || 'Admin', email, role: 'admin', jobCodes: [], active: true, availability: {}, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
    console.log(`Created admin account: ${email} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password}`);
  }
}

const service = createService(store, { hashPassword });

// ---------- app ----------
const app = express();
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

const COOKIE = 'sb_session';
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 1000 * 60 * 60 * 24 * 30 };

function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  try {
    const { sub, v } = jwt.verify(token, SECRET);
    const u = store.get('users', sub);
    if (!u || u.active === false) return null;
    if ((u.sessionVersion || 0) !== (v || 0)) return null; // password change invalidates sessions
    return u;
  } catch { return null; }
}

// Simple in-memory login rate limit: 10 attempts / 15 min per IP+email
const attempts = new Map();
function limited(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= 10;
}

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = `${req.ip}|${email}`;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = store.list('users', (x) => x.email === email)[0];
  if (!u || u.active === false || !bcrypt.compareSync(password, u.passwordHash || '')) {
    attempts.get(key).push(Date.now());
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  attempts.delete(key);
  const token = jwt.sign({ sub: u.id, v: u.sessionVersion || 0 }, SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, cookieOpts).json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }).json({ ok: true });
});

app.post('/api/rpc/:method', (req, res) => {
  const actor = currentUser(req);
  const method = req.params.method;
  try {
    if (!actor) throw new AppError(401, 'Please sign in');
    const result = service.call(actor, method, req.body || {});
    if (method === 'employees.changePassword') {
      // Rotate session so other devices are signed out, keep this one.
      const u = store.update('users', actor.id, { sessionVersion: (actor.sessionVersion || 0) + 1 });
      res.cookie(COOKIE, jwt.sign({ sub: u.id, v: u.sessionVersion }, SECRET, { expiresIn: '30d' }), cookieOpts);
    }
    res.json({ result: result === undefined ? null : result });
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    if (status === 500) console.error(method, e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Calendar feed (iCal) per user, authenticated by a per-user token.
app.get('/api/ical/:userId/:token.ics', (req, res) => {
  const u = store.get('users', req.params.userId);
  const expected = crypto.createHmac('sha256', SECRET).update(`ical:${u?.id}`).digest('hex').slice(0, 24);
  if (!u || req.params.token !== expected) return res.status(404).end();
  const shifts = store.list('shifts', (s) => s.userId === u.id && s.published);
  const jobs = Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j.name]));
  const st = service.settings();
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
app.post('/api/rpc-ical-link', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please sign in' });
  const token = crypto.createHmac('sha256', SECRET).update(`ical:${u.id}`).digest('hex').slice(0, 24);
  res.json({ result: `/api/ical/${u.id}/${token}.ics` });
});

// ---------- static web app ----------
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`ShiftBoard running on http://localhost:${PORT}`));
