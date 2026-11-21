// The phone app's server side: bearer-token sessions, push token registration, Expo push
// after a commit (with a stand-in for the Expo Push API), language preference and
// account deletion requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { createExpoPush, pushNotifications, pushMessages, isExpoPushToken, EXPO_PUSH_URL, EXPO_RECEIPTS_URL } from '../server/expo-push.js';
import { addDays, todayStr } from '../core/time.js';

const SECRET = 'test-secret-for-mobile-sessions';
const ENV = { SEED_DEMO: 'true', JWT_SECRET: SECRET };
const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

/** A stand-in for the Expo Push API. `tickets(messages)` and `receipts(ids)` decide the answers. */
function fakeExpo({ tickets, receipts } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (url === EXPO_PUSH_URL) {
      const data = tickets ? tickets(body) : body.map((m, i) => ({ status: 'ok', id: `tkt-${calls.length}-${i}` }));
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if (url === EXPO_RECEIPTS_URL) return { ok: true, status: 200, json: async () => ({ data: receipts ? receipts(body.ids) : {} }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetchImpl, sent: () => calls.filter((c) => c.url === EXPO_PUSH_URL).flatMap((c) => c.body) };
}

async function start({ env = ENV, expo } = {}) {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env, ...(expo ? { expoPush: createExpoPush(env, { fetchImpl: expo.fetchImpl }) } : {}) });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, db, base,
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); },
  };
}

/** A phone: signs in with { client: 'mobile' } and sends the token as Authorization: Bearer. */
function phone(base) {
  const c = {
    token: '',
    async post(path, body = {}, token = c.token) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    },
    rpc: (method, args) => c.post(`/api/rpc/${method}`, args),
    async signIn(email, password = 'demo1234') {
      const r = await c.post('/api/auth/login', { email, password, client: 'mobile' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      c.token = r.body.token;
      return c;
    },
  };
  return c;
}

test('phone sign-in returns a bearer token (no cookie) that works on the RPC routes', async () => {
  const A = await start();
  try {
    const p = phone(A.base);
    const r = await p.post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234', client: 'mobile' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null, 'no cookie for the phone app');
    assert.equal(r.body.expiresIn, 30 * 24 * 60 * 60);
    p.token = r.body.token;
    const claims = jwt.verify(p.token, SECRET);
    assert.equal(claims.exp - claims.iat, 30 * 24 * 60 * 60, 'same 30-day expiry as the cookie');

    const boot = await p.rpc('app.bootstrap');
    assert.equal(boot.status, 200);
    assert.equal(boot.body.result.me.email, 'alexd@demo.shiftboard');
    assert.equal((await p.post('/api/rpc-ical-link')).status, 200, 'calendar link works with the token too');

    // Wrong password, a made-up token, an expired token: all refused.
    assert.equal((await phone(A.base).post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'nope', client: 'mobile' })).status, 401);
    assert.equal((await p.post('/api/rpc/app.bootstrap', {}, 'not-a-token')).status, 401);
    const expired = jwt.sign({ sub: claims.sub, v: 0, iat: Math.floor(Date.now() / 1000) - 31 * 86400, exp: Math.floor(Date.now() / 1000) - 86400 }, SECRET);
    assert.equal((await p.post('/api/rpc/app.bootstrap', {}, expired)).status, 401);
    const forged = jwt.sign({ sub: claims.sub, v: 0 }, 'some-other-secret', { expiresIn: '30d' });
    assert.equal((await p.post('/api/rpc/app.bootstrap', {}, forged)).status, 401);

    // The web sign-in is unchanged: a cookie, no token in the body.
    const web = await fetch(`${A.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alexd@demo.shiftboard', password: 'demo1234' }) });
    assert.match(web.headers.get('set-cookie'), /sb_session=/);
    assert.deepEqual(await web.json(), { ok: true });
  } finally { await A.close(); }
});

test('changing the password from the phone hands back a fresh token and signs other phones out', async () => {
  const A = await start();
  try {
    const p1 = await phone(A.base).signIn('alexd@demo.shiftboard');
    const p2 = await phone(A.base).signIn('alexd@demo.shiftboard');
    const r = await p1.rpc('employees.changePassword', { password: 'brand-new-pass' });
    assert.equal(r.status, 200);
    const fresh = r.headers.get('x-session-token');
    assert.ok(fresh, 'new token in X-Session-Token');
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal((await p1.post('/api/rpc/app.bootstrap', {}, fresh)).status, 200);
    assert.equal((await p1.rpc('app.bootstrap')).status, 401, 'the old token stops working');
    assert.equal((await p2.rpc('app.bootstrap')).status, 401, 'other phones are signed out');
  } finally { await A.close(); }
});

test('devices.register validates, keeps one owner per phone, and unregister removes only your own', async () => {
  const A = await start();
  try {
    const alex = await phone(A.base).signIn('alexd@demo.shiftboard');
    const styves = await phone(A.base).signIn('styves@demo.shiftboard');
    assert.equal((await alex.rpc('devices.register', { token: 'hello', platform: 'ios' })).status, 400);
    assert.equal((await alex.rpc('devices.register', { token: TOKEN_A, platform: 'windows' })).status, 400);
    assert.equal((await phone(A.base).rpc('devices.register', { token: TOKEN_A, platform: 'ios' })).status, 401);

    assert.equal((await alex.rpc('devices.register', { token: TOKEN_A, platform: 'ios' })).status, 200);
    assert.equal((await alex.rpc('devices.register', { token: TOKEN_A, platform: 'ios' })).status, 200, 'registering twice is fine');
    let docs = A.db.store.list('deviceTokens');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].userId, 'usr_alexd');
    assert.deepEqual(Object.keys(docs[0]).sort(), ['createdAt', 'id', 'platform', 'seenAt', 'token', 'userId', 'v']);

    // Someone else signs in on the same phone: the phone is theirs now.
    assert.equal((await styves.rpc('devices.register', { token: TOKEN_A, platform: 'ios' })).status, 200);
    docs = A.db.store.list('deviceTokens');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].userId, 'usr_styves');

    assert.equal((await alex.rpc('devices.unregister', { token: TOKEN_A })).body.result.removed, 0, 'not Alex’s phone any more');
    assert.equal((await styves.rpc('devices.unregister', { token: TOKEN_A })).body.result.removed, 1);
    assert.equal(A.db.store.list('deviceTokens').length, 0);

    // At most 10 phones per person; the oldest go first.
    for (let i = 0; i < 12; i++) await styves.rpc('devices.register', { token: `ExponentPushToken[phone${String(i).padStart(2, '0')}]`, platform: 'android' });
    const left = A.db.store.list('deviceTokens').map((d) => d.token).sort();
    assert.equal(left.length, 10);
    assert.ok(!left.includes('ExponentPushToken[phone00]') && left.includes('ExponentPushToken[phone11]'));
    assert.ok(isExpoPushToken(TOKEN_A) && isExpoPushToken('ExpoPushToken[x1-_]') && !isExpoPushToken('ExponentPushToken[]'));
  } finally { await A.close(); }
});

test('new notifications are pushed to the person’s phones after the commit', async () => {
  const expo = fakeExpo();
  const A = await start({ expo });
  try {
    const mgr = await phone(A.base).signIn('moe@demo.shiftboard');
    await mgr.rpc('settings.update', { restaurantName: 'Chasing Rabbits' });
    const styves = await phone(A.base).signIn('styves@demo.shiftboard');
    await styves.rpc('devices.register', { token: TOKEN_A, platform: 'ios' });
    await styves.rpc('devices.register', { token: TOKEN_B, platform: 'android' });

    const date = addDays(todayStr(), 20);
    const r = await mgr.rpc('shifts.save', { date, start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_styves', published: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await A.app.locals.settled();

    const sent = expo.sent();
    assert.deepEqual(sent.map((m) => m.to).sort(), [TOKEN_A, TOKEN_B]);
    const m = sent[0];
    assert.equal(m.title, 'Chasing Rabbits');
    assert.match(m.body, /^New shift: Server/);
    assert.equal(m.data.link, '#/my');
    assert.ok(m.data.notificationId);
    assert.equal(m.channelId, 'default');
    assert.ok(m.badge >= 1, 'badge = unread count');
    assert.ok(A.db.store.list('pushTickets').length === 2, 'tickets kept to check receipts later');

    // Reads never push, and nobody else's phone gets Styves's notification.
    const before = expo.calls.length;
    await styves.rpc('app.bootstrap');
    await mgr.rpc('shifts.save', { date: addDays(date, 1), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_victor', published: true });
    await A.app.locals.settled();
    assert.equal(expo.calls.length, before, 'Victor has no phone registered');

    // A password change signs the phones out, so they stop getting pushes until they sign in again.
    const fresh = (await styves.rpc('employees.changePassword', { password: 'another-pass-1' })).headers.get('x-session-token');
    await mgr.rpc('shifts.save', { date: addDays(date, 2), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_styves', published: true });
    await A.app.locals.settled();
    assert.equal(expo.calls.length, before, 'no push to phones signed in before the change');
    await styves.post('/api/rpc/devices.register', { token: TOKEN_A, platform: 'ios' }, fresh);
    await mgr.rpc('shifts.save', { date: addDays(date, 3), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_styves', published: true });
    await A.app.locals.settled();
    assert.deepEqual(expo.sent().slice(2).map((x) => x.to), [TOKEN_A], 'the phone that signed in again gets it');
  } finally { await A.close(); }
});

test('DeviceNotRegistered (in a ticket or a later receipt) deletes the token', async () => {
  const expo = fakeExpo({
    tickets: (msgs) => msgs.map((m, i) => (m.to === TOKEN_B ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `new-${i}` })),
    receipts: (ids) => Object.fromEntries(ids.map((id) => [id, id === 'old-1' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }])),
  });
  const A = await start({ expo });
  try {
    const styves = await phone(A.base).signIn('styves@demo.shiftboard');
    const victor = await phone(A.base).signIn('victor@demo.shiftboard');
    const TOKEN_C = 'ExponentPushToken[cccccccccccccccccccccc]';
    await styves.rpc('devices.register', { token: TOKEN_A, platform: 'ios' });
    await styves.rpc('devices.register', { token: TOKEN_B, platform: 'android' });
    await victor.rpc('devices.register', { token: TOKEN_C, platform: 'ios' });
    // Tickets from earlier sends: one old enough to check, one too new, one too old to bother with.
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    await A.db.run((s) => {
      s.insert('pushTickets', { id: 'old-1', token: TOKEN_C, at: ago(20) });
      s.insert('pushTickets', { id: 'new-1', token: TOKEN_A, at: ago(2) });
      s.insert('pushTickets', { id: 'ancient', token: TOKEN_A, at: ago(60 * 25) });
    }, { write: true });

    const mgr = await phone(A.base).signIn('moe@demo.shiftboard');
    await mgr.rpc('shifts.save', { date: addDays(todayStr(), 21), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_styves', published: true });
    await A.app.locals.settled();

    const tokens = A.db.store.list('deviceTokens').map((d) => d.token).sort();
    assert.deepEqual(tokens, [TOKEN_A], 'B (ticket) and C (receipt) were removed');
    const receiptCall = expo.calls.find((c) => c.url === EXPO_RECEIPTS_URL);
    assert.deepEqual(receiptCall.body.ids, ['old-1'], 'only receipts old enough and not expired are checked');
    assert.deepEqual(A.db.store.list('pushTickets').map((t) => t.id).sort(), ['new-0', 'new-1']);
  } finally { await A.close(); }
});

test('Expo push: batches of 100, access token header, off switch', async () => {
  const expo = fakeExpo();
  const push = createExpoPush({ EXPO_ACCESS_TOKEN: 'expo-test-token' }, { fetchImpl: expo.fetchImpl });
  const msgs = Array.from({ length: 150 }, (_, i) => ({ to: `ExponentPushToken[t${i}]`, body: 'hi' }));
  const { tickets } = await push.send(msgs);
  assert.equal(expo.calls.length, 2);
  assert.deepEqual(expo.calls.map((c) => c.body.length), [100, 50]);
  assert.equal(tickets.length, 150);
  assert.equal(tickets[120].token, 'ExponentPushToken[t120]');
  assert.equal(expo.calls[0].headers.Authorization, 'Bearer expo-test-token');

  const off = fakeExpo();
  const disabled = createExpoPush({ EXPO_PUSH: 'off' }, { fetchImpl: off.fetchImpl });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(await disabled.send(msgs), { tickets: [], unregistered: [] });
  assert.equal(off.calls.length, 0);

  const failing = createExpoPush({}, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ errors: [{ message: 'Too many' }] }) }) });
  await assert.rejects(failing.send(msgs.slice(0, 1)), /Expo push 429: Too many/);

  // Nothing to push: no request at all.
  const quiet = fakeExpo();
  const conn = await openPglite();
  try {
    const db = new DocDb(conn);
    await db.migrate();
    await db.sync();
    assert.deepEqual(pushMessages([{ col: 'shifts', id: 'x', doc: {}, isNew: true }], db.store), []);
    assert.deepEqual(await pushNotifications({ changes: [], db, push: createExpoPush({}, { fetchImpl: quiet.fetchImpl }) }), { sent: 0 });
    assert.equal(quiet.calls.length, 0);
  } finally { await conn.end(); }
});

test('language preference and account deletion requests', async () => {
  const A = await start();
  try {
    const alex = await phone(A.base).signIn('alexd@demo.shiftboard');
    assert.equal((await alex.rpc('account.preferences', { language: 'es' })).body.result.language, 'es');
    assert.equal((await alex.rpc('app.bootstrap')).body.result.me.language, 'es');
    assert.equal((await alex.rpc('account.preferences', { language: 'fr' })).body.result.language, '', 'unknown → follow the phone');
    assert.equal((await alex.rpc('account.preferences', { language: 'en' })).body.result.language, 'en');
    assert.equal((await alex.rpc('account.preferences', { appearance: 'dark' })).body.result.language, 'en', 'other preferences leave it alone');

    const r = await alex.rpc('account.requestDeletion', {});
    assert.equal(r.status, 200);
    assert.ok(r.body.result.requestedAt);
    const mgr = await phone(A.base).signIn('moe@demo.shiftboard');
    const notes = (await mgr.rpc('notifications.list')).body.result.filter((n) => /asked to delete/.test(n.text));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].link, '#/team');
    await alex.rpc('account.requestDeletion', {});
    assert.equal((await mgr.rpc('notifications.list')).body.result.filter((n) => /asked to delete/.test(n.text)).length, 1, 'asking twice in a day notifies once');
  } finally { await A.close(); }
});

test('the standalone server serves /privacy and /support (the store listings link to them)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
  for (const page of ['privacy', 'support']) fs.copyFileSync(new URL(`../web/public/${page}.html`, import.meta.url), path.join(dir, `${page}.html`));
  const conn = await openPglite();
  const app = createApp({ db: new DocDb(conn), env: ENV, staticDir: dir });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const privacy = await (await fetch(`${base}/privacy`)).text();
    assert.match(privacy, /ShiftBoard Privacy Policy/);
    assert.match(privacy, /Política de privacidad/);
    assert.match(privacy, /push token/i);
    assert.match(await (await fetch(`${base}/support`)).text(), /id="delete-account"/);
    assert.match(await (await fetch(`${base}/schedule`)).text(), /<title>app<\/title>/, 'other paths still get the web app');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
