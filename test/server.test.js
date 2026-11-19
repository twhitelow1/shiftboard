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
    assert.deepEqual(rows.map((r) => r.relname), ['docs', 'login_attempts', 'meta']);
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

async function startApp(db, env) {
  const app = createApp({ db, env });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
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
