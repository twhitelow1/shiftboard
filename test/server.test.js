// Postgres layer + HTTP API tests.
// Uses TEST_DATABASE_URL when set (a throwaway database: the shiftboard schema is dropped
// before each test); otherwise an in-memory embedded Postgres (PGlite).
// Several DocDb instances against one database stand in for several Vercel instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DocDb, openConnection, pgOptions } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { addDays, todayStr } from '../core/time.js';
import { createMailer } from '../server/email.js';
import { fakeResend } from './helpers/fake-resend.js';

const URL = process.env.TEST_DATABASE_URL;

async function instances(count) {
  if (URL) {
    const admin = openConnection({ DATABASE_URL: URL });
    await admin.query('DROP SCHEMA IF EXISTS shiftboard CASCADE');
    await admin.end();
    const dbs = Array.from({ length: count }, () => new DocDb(openConnection({ DATABASE_URL: URL })));
    return { dbs, close: () => Promise.all(dbs.map((d) => d.close())) };
  }
  const conn = await openPglite();
  return { dbs: Array.from({ length: count }, () => new DocDb(conn)), close: () => conn.end() };
}

async function migrated(count) {
  const env = await instances(count);
  await env.dbs[0].migrate();
  return env;
}

// ---------- DocDb ----------

test('migrate is idempotent and keeps tables away from Supabase API roles', async () => {
  const { dbs: [db], close } = await instances(1);
  try {
    await db.migrate();
    await db.migrate();
    const { rows } = await db.query(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'shiftboard' AND c.relkind = 'r' ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.relname), ['auth_tokens', 'docs', 'login_attempts', 'meta']);
    assert.ok(rows.every((r) => r.relrowsecurity), 'row level security enabled on every table');
  } finally { await close(); }
});

test('writes persist and other instances see them', async () => {
  const { dbs: [a, b], close } = await migrated(2);
  try {
    await a.run((s) => s.insert('shifts', { id: 's1', userId: 'u1' }), { write: true });
    assert.equal(await b.run((s) => s.get('shifts', 's1').userId), 'u1');

    await b.run((s) => s.update('shifts', 's1', { userId: 'u2' }), { write: true });
    assert.equal(await a.run((s) => s.get('shifts', 's1').userId), 'u2');

    await a.run((s) => s.remove('shifts', 's1'), { write: true });
    assert.equal(await b.run((s) => s.get('shifts', 's1')), null);

    // A brand-new instance (cold start) loads the current state, without the deleted doc.
    const c = new DocDb(a.conn);
    await c.sync();
    assert.equal(c.store.get('shifts', 's1'), null);
  } finally { await close(); }
});

test('concurrent writes from different instances are serialized', async () => {
  const { dbs, close } = await migrated(3);
  try {
    await dbs[0].run((s) => s.insert('counters', { id: 'c', n: 0 }), { write: true });
    const bump = (db) => db.run((s) => s.update('counters', 'c', { n: s.get('counters', 'c').n + 1 }), { write: true });
    await Promise.all(dbs.flatMap((db) => Array.from({ length: 15 }, () => bump(db))));
    for (const db of dbs) assert.equal(await db.run((s) => s.get('counters', 'c').n), 45);
  } finally { await close(); }
});

test('a request that throws writes nothing', async () => {
  const { dbs: [db], close } = await migrated(1);
  try {
    await assert.rejects(db.run((s) => {
      s.insert('shifts', { id: 'x' });
      throw new Error('boom');
    }, { write: true }), /boom/);
    assert.equal(db.store.get('shifts', 'x'), null);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM shiftboard.docs WHERE col = 'shifts'`);
    assert.equal(rows[0].n, 0);
  } finally { await close(); }
});

test('a "read-only" call that writes is redone under the lock and persisted', async () => {
  const { dbs: [a, b], close } = await migrated(2);
  try {
    let runs = 0;
    await a.run((s) => { runs++; s.insert('notes', { id: 'n1', text: 'hi' }); });
    assert.equal(runs, 2);
    assert.equal(await b.run((s) => s.get('notes', 'n1').text), 'hi');
  } finally { await close(); }
});

test('documents round-trip intact, NUL characters are dropped', async () => {
  const { dbs: [a, b], close } = await migrated(2);
  try {
    const doc = { id: 'e1', name: 'Wedding — “Smith” ✨', nested: { list: [1, 'two', { three: true }], empty: [] }, n: 12.5, nul: 'a\u0000b' };
    await a.run((s) => s.insert('events', doc), { write: true });
    await b.sync();
    assert.deepEqual(b.store.get('events', 'e1'), { ...doc, nul: 'ab' });
  } finally { await close(); }
});

test('sslmode follows libpq meaning', () => {
  assert.equal(pgOptions('postgres://u:p@localhost:5432/db', {}).ssl, false);
  assert.deepEqual(pgOptions('postgres://u:p@db.example.com:6543/postgres?sslmode=require&supa=base-pooler.x', {}),
    { connectionString: 'postgres://u:p@db.example.com:6543/postgres', ssl: { rejectUnauthorized: false } });
  assert.deepEqual(pgOptions('postgres://u:p@db.example.com/db?sslmode=verify-full', {}).ssl, { rejectUnauthorized: true });
  assert.deepEqual(pgOptions('postgres://u:p@db.example.com/db', { DATABASE_CA_CERT: 'CERT' }).ssl, { rejectUnauthorized: true, ca: 'CERT' });
  assert.equal(pgOptions('postgres://u:p@db.example.com/db?sslmode=disable', {}).ssl, false);
});

// ---------- HTTP API ----------

async function startApp(db, env, extra = {}) {
  const app = createApp({ db, env, ...extra });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, base, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

function client(base) {
  let cookie = '';
  async function post(path, body = {}) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return {
    post,
    get: (path) => fetch(base + path),
    rpc: (method, args) => post(`/api/rpc/${method}`, args),
    async login(email, password = 'demo1234') {
      const r = await post('/api/auth/login', { email, password });
      assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
      return this;
    },
  };
}

const DEMO = { SEED_DEMO: 'true' };

test('two instances booting at once seed the demo only once', async () => {
  const { dbs: [a, b], close } = await instances(2);
  const apps = await Promise.all([startApp(a, DEMO), startApp(b, DEMO)]);
  try {
    const { rows } = await a.query(`SELECT count(*)::int AS n FROM shiftboard.docs WHERE col = 'users'`);
    assert.equal(rows[0].n, a.store.list('users').length);
    assert.ok(rows[0].n > 10);
    const { rows: s } = await a.query(`SELECT count(DISTINCT value)::int AS n FROM shiftboard.meta WHERE key = 'jwt_secret'`);
    assert.equal(s[0].n, 1);
  } finally {
    await Promise.all(apps.map((x) => x.close()));
    await close();
  }
});

test('first run without demo data creates the admin from env', async () => {
  const { dbs: [db], close } = await instances(1);
  const app = await startApp(db, { ADMIN_EMAIL: 'Owner@Example.com', ADMIN_PASSWORD: 'correct-horse', ADMIN_NAME: 'Owner' });
  try {
    const c = client(app.base);
    assert.equal((await c.post('/api/auth/login', { email: 'owner@example.com', password: 'nope' })).status, 401);
    await c.login('owner@example.com', 'correct-horse');
    const boot = await c.rpc('app.bootstrap');
    assert.equal(boot.body.result.me.role, 'admin');
    assert.equal(boot.body.result.me.passwordHash, undefined);
  } finally { await app.close(); await close(); }
});

test('sign-in, sessions, password change, rate limit and iCal across instances', async () => {
  const { dbs: [a, b], close } = await instances(2);
  const A = await startApp(a, DEMO);
  const B = await startApp(b, DEMO);
  try {
    assert.equal((await client(A.base).rpc('app.bootstrap')).status, 401);

    // A session from instance A works on instance B (shared secret in the database).
    const onA = await client(A.base).login('styves@demo.shiftboard');
    const boot = await onA.rpc('app.bootstrap');
    assert.equal(boot.status, 200);
    assert.equal(boot.body.result.me.name, 'Styves');

    // Password change on B signs out the other session but keeps this one.
    const onB = await client(B.base).login('styves@demo.shiftboard');
    assert.equal((await onB.rpc('employees.changePassword', { password: 'new-password-1' })).status, 200);
    assert.equal((await onB.rpc('app.bootstrap')).status, 200);
    assert.equal((await onA.rpc('app.bootstrap')).status, 401);
    await client(A.base).login('styves@demo.shiftboard', 'new-password-1');

    // iCal link
    const link = (await onB.post('/api/rpc-ical-link')).body.result;
    const ics = await client(A.base).get(link);
    assert.equal(ics.status, 200);
    assert.match(await ics.text(), /^BEGIN:VCALENDAR/);
    assert.equal((await client(A.base).get(link.replace(/[0-9a-f]{24}\.ics$/, '000000000000000000000000.ics'))).status, 404);

    // Rate limit is shared: 10 failures spread across instances, then even the right password is refused.
    for (let i = 0; i < 10; i++) {
      const r = await client(i % 2 ? A.base : B.base).post('/api/auth/login', { email: 'victor@demo.shiftboard', password: 'wrong' });
      assert.equal(r.status, 401);
    }
    const blocked = await client(A.base).post('/api/auth/login', { email: 'victor@demo.shiftboard', password: 'demo1234' });
    assert.equal(blocked.status, 429);
  } finally {
    await A.close(); await B.close(); await close();
  }
});

test('two employees grabbing the same open shift on different instances: exactly one gets it', async () => {
  const { dbs: [a, b], close } = await instances(2);
  const A = await startApp(a, DEMO);
  const B = await startApp(b, DEMO);
  try {
    const mgr = await client(A.base).login('moe@demo.shiftboard');
    assert.equal((await mgr.rpc('settings.update', { requirePickupApproval: false, minSwapNoticeHours: 0 })).status, 200);
    const styves = await client(A.base).login('styves@demo.shiftboard');
    const victor = await client(B.base).login('victor@demo.shiftboard');

    for (let i = 0; i < 4; i++) {
      const date = addDays(todayStr(), 30 + i * 7);
      const saved = await mgr.rpc('shifts.save', { date, start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: null, published: true });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const shiftId = saved.body.result.shift.id;

      const results = await Promise.all([
        styves.rpc('swaps.create', { shiftId, type: 'pickup' }),
        victor.rpc('swaps.create', { shiftId, type: 'pickup' }),
      ]);
      const winners = results.filter((r) => r.status === 200);
      assert.equal(winners.length, 1, JSON.stringify(results.map((r) => [r.status, r.body])));
      assert.match(results.find((r) => r.status !== 200).body.error, /not open/);

      const week = await mgr.rpc('shifts.list', { start: date, end: date });
      const shift = week.body.result.shifts.find((s) => s.id === shiftId);
      assert.ok(['usr_styves', 'usr_victor'].includes(shift.userId));
    }
  } finally {
    await A.close(); await B.close(); await close();
  }
});

test('API answers unknown routes and bad JSON with JSON errors', async () => {
  const { dbs: [db], close } = await instances(1);
  const app = await startApp(db, DEMO);
  try {
    const nf = await fetch(`${app.base}/api/nope`);
    assert.equal(nf.status, 404);
    const bad = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Invalid JSON' });
  } finally { await app.close(); await close(); }
});

// ---------- email (Resend) ----------

async function emailApp(db) {
  const resend = fakeResend();
  const mailer = createMailer({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'ShiftBoard <schedule@rabbits.co>' }, { fetchImpl: resend.fetchImpl });
  const started = await startApp(db, { ...DEMO, APP_URL: 'https://schedule.rabbits.co' }, { mailer });
  return { ...started, resend };
}
const setEmail = (db, id, email) => db.run((s) => s.update('users', id, { email }), { write: true });
const linkToken = (mail) => mail.text.match(/#\/reset\?token=([\w-]+)/)[1];

test('new notifications are emailed after the commit, respecting opt-outs', async () => {
  const { dbs: [db], close } = await instances(1);
  const A = await emailApp(db);
  try {
    await setEmail(db, 'usr_styves', 'styves@rabbits.co');
    await setEmail(db, 'usr_victor', 'victor@rabbits.co');
    const victor = await client(A.base).login('victor@rabbits.co');
    assert.equal((await victor.rpc('account.preferences', { emailNotifications: false })).status, 200);
    const mgr = await client(A.base).login('moe@demo.shiftboard');
    const date = addDays(todayStr(), 20);
    for (const userId of ['usr_styves', 'usr_victor']) {
      const r = await mgr.rpc('shifts.save', { date, start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId, published: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    await A.app.locals.settled();
    const sent = A.resend.emails();
    assert.deepEqual(sent.map((m) => m.to[0]), ['styves@rabbits.co'], 'Victor opted out');
    assert.match(sent[0].subject, /New shift/);
    assert.ok(sent[0].html.includes('https://schedule.rabbits.co/#/my'));

    // Reads never email.
    const before = A.resend.calls.length;
    await mgr.rpc('app.bootstrap');
    await mgr.rpc('notifications.list');
    // A failed request never emails.
    assert.equal((await mgr.rpc('shifts.save', { date, start: 'nope', jobCodeId: 'job_srv', userId: 'usr_styves', published: true })).status, 400);
    // The restaurant-wide switch turns email off.
    await mgr.rpc('settings.update', { emailNotifications: false });
    await mgr.rpc('shifts.save', { date: addDays(date, 1), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_styves', published: true });
    await A.app.locals.settled();
    assert.equal(A.resend.calls.length, before);
  } finally { await A.close(); await close(); }
});

test('forgot password emails a one-time link that resets the password and signs in', async () => {
  const { dbs: [db], close } = await instances(1);
  const A = await emailApp(db);
  try {
    await setEmail(db, 'usr_styves', 'styves@rabbits.co');
    const anon = client(A.base);
    assert.deepEqual((await anon.post('/api/auth/forgot', { email: 'nobody@rabbits.co' })).body, { ok: true });
    assert.deepEqual((await anon.post('/api/auth/forgot', { email: 'Styves@Rabbits.co' })).body, { ok: true });
    await A.app.locals.settled();
    const mails = A.resend.emails();
    assert.equal(mails.length, 1, 'only the real account gets an email');
    assert.match(mails[0].subject, /Reset your/);
    const token = linkToken(mails[0]);

    assert.equal((await anon.post('/api/auth/reset', { token, password: '123' })).status, 400); // too short; link still good
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'fresh-password-9' })).status, 200);
    assert.equal((await anon.rpc('app.bootstrap')).status, 200, 'the reset signs you in');
    assert.equal((await client(A.base).post('/api/auth/reset', { token, password: 'again-again' })).status, 400, 'single use');
    assert.equal((await client(A.base).post('/api/auth/login', { email: 'styves@rabbits.co', password: 'demo1234' })).status, 401);
    await client(A.base).login('styves@rabbits.co', 'fresh-password-9');
  } finally { await A.close(); await close(); }
});

test('new people get an invite link; sign-in links and the test email are permission-checked', async () => {
  const { dbs: [db], close } = await instances(1);
  const A = await emailApp(db);
  try {
    const mgr = await client(A.base).login('moe@demo.shiftboard');
    const r = await mgr.rpc('employees.save', { name: 'New Server', email: 'newbie@rabbits.co', role: 'employee', jobCodes: [{ jobCodeId: 'job_srv' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.invited, true);
    const invite = A.resend.emails().find((m) => m.to[0] === 'newbie@rabbits.co');
    assert.match(invite.subject, /Set up your/);
    const newbie = client(A.base);
    assert.equal((await newbie.post('/api/auth/reset', { token: linkToken(invite), password: 'my-own-pass' })).status, 200);
    assert.equal((await newbie.rpc('app.bootstrap')).body.result.me.name, 'New Server');

    assert.equal((await mgr.post(`/api/users/${r.body.result.id}/invite`)).status, 200, 'resend a sign-in link');
    await setEmail(db, 'usr_styves', 'styves@rabbits.co');
    const styves = await client(A.base).login('styves@rabbits.co');
    assert.equal((await styves.post(`/api/users/${r.body.result.id}/invite`)).status, 403);

    assert.equal((await styves.post('/api/email/test')).status, 403);
    assert.equal((await mgr.post('/api/email/test')).status, 400, 'demo address can’t receive mail');
    await setEmail(db, 'usr_moe', 'moe@rabbits.co');
    const t = await mgr.post('/api/email/test');
    assert.equal(t.status, 200);
    assert.equal(t.body.result.to, 'moe@rabbits.co');
  } finally { await A.close(); await close(); }
});

test('without Resend configured, email features stay off', async () => {
  const { dbs: [db], close } = await instances(1);
  const A = await startApp(db, DEMO);
  try {
    const cfg = await (await fetch(`${A.base}/api/config`)).json();
    assert.deepEqual([cfg.email, cfg.emailFrom], [false, null]);
    assert.deepEqual(cfg.brand, { name: 'Our Restaurant', color: '', nav: '', logo: '' }, 'branding for the sign-in page');
    assert.equal((await client(A.base).post('/api/auth/forgot', { email: 'moe@demo.shiftboard' })).status, 400);
    const mgr = await client(A.base).login('moe@demo.shiftboard');
    const r = await mgr.rpc('employees.save', { name: 'No Mail', email: 'nomail@rabbits.co', role: 'employee' });
    assert.equal(r.body.result.invited, false);
    assert.ok(r.body.result.tempPassword);
  } finally { await A.close(); await close(); }
});

test('sign-ins are tracked; invite everyone reaches only people who never signed in; returning people get a reset link', async () => {
  const { dbs: [db], close } = await instances(1);
  const A = await emailApp(db);
  try {
    await setEmail(db, 'usr_styves', 'styves@rabbits.co');
    await setEmail(db, 'usr_victor', 'victor@rabbits.co');
    await setEmail(db, 'usr_manny', 'manny@rabbits.co');
    await client(A.base).login('victor@rabbits.co'); // Victor has signed in before
    assert.ok(db.store.get('users', 'usr_victor').lastLoginAt);

    const mgr = await client(A.base).login('moe@demo.shiftboard');
    const before = A.resend.emails().length;
    const all = await mgr.post('/api/users/invite-all');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const sent = A.resend.emails().slice(before).map((m) => m.to[0]).sort();
    assert.deepEqual(sent, ['manny@rabbits.co', 'styves@rabbits.co'], 'not Victor (signed in), not demo addresses');
    assert.ok(all.body.result.noEmail > 10, 'people without a real email are counted');
    assert.ok(db.store.get('users', 'usr_styves').invitedAt);

    // A returning person gets a password reset email instead of a welcome.
    const r = await mgr.post('/api/users/usr_victor/invite');
    assert.equal(r.status, 200);
    assert.match(A.resend.emails().at(-1).subject, /Reset your/);
    assert.match(A.resend.emails().at(-1).text, /Moe sent you a link .* 24 hours/);

    const styves = await client(A.base).login('styves@rabbits.co');
    assert.equal((await styves.post('/api/users/invite-all')).status, 403);
  } finally { await A.close(); await close(); }
});

test('branding: admins upload a logo that everyone (and the sign-in page) can load; colors are validated', async () => {
  const { dbs: [db], close } = await instances(1);
  const A = await startApp(db, DEMO);
  try {
    const admin = await client(A.base).login('moe@demo.shiftboard');
    const staff = await client(A.base).login('styves@demo.shiftboard');
    // A 1×1 transparent PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    assert.equal((await staff.rpc('branding.setLogo', { dataUrl: `data:image/png;base64,${png}` })).status, 403);
    assert.equal((await admin.rpc('branding.setLogo', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400, 'no SVG (scripts)');
    const up = await admin.rpc('branding.setLogo', { dataUrl: `data:image/png;base64,${png}` });
    assert.equal(up.status, 200);
    const cfg = await (await fetch(`${A.base}/api/config`)).json();
    assert.equal(cfg.brand.logo, `/api/branding/logo?v=${up.body.result.logoVersion}`);
    const img = await fetch(`${A.base}${cfg.brand.logo}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control'), /immutable/);
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())].slice(1, 4), [80, 78, 71], 'PNG bytes');
    // Colors: valid hex kept, anything else cleared.
    await admin.rpc('settings.update', { brandColor: '#AA3300', navColor: 'red' });
    const st = (await staff.rpc('app.bootstrap')).body.result.settings;
    assert.deepEqual([st.brandColor, st.navColor, st.logoVersion], ['#aa3300', '', up.body.result.logoVersion]);
    assert.equal((await admin.rpc('branding.removeLogo', {})).status, 200);
    assert.equal((await fetch(`${A.base}/api/branding/logo`)).status, 404);
  } finally { await A.close(); await close(); }
});
