// Beta error tracking (server/errors.js, server/errors-routes.js, server/platform/errors-console.js): a thrown RPC
// error still answers 500 and is recorded once, then grouped; nothing secret is kept; the apps' own error reports
// are rate-limited and filtered; "Report a problem" with a screenshot; one alert email per fingerprint per hour;
// the daily digest; the console's Errors & reports page is DubLow's only; every error is tagged with its restaurant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';
import { hostClient } from './helpers/hosts.js';
import { fakeResend } from './helpers/fake-resend.js';
import { openPglite } from '../server/pglite.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { scrubText, cleanStack, cleanPath, fingerprintOf, topFrame, normalizeMessage, deviceOf, issueMarkdown } from '../server/errors.js';
import { isNoise, cleanScreenshot, RateLimiter } from '../server/errors-routes.js';

const ADMIN = 'ops@dublow.test';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'usr_x' })).toString('base64url')}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;

/** One restaurant with a clock the test moves, alerts to ADMIN. */
async function start(env = {}) {
  const clock = { t: Date.parse('2026-11-20T15:00:00Z') };
  const a = await startApp({ env: { PLATFORM_ADMIN_EMAIL: ADMIN, ...env }, now: () => clock.t });
  const c = jsonClient(a.base);
  const errors = a.app.locals.errors;
  return {
    ...a, c, clock, errors, log: errors.log,
    async login(email = 'moe@demo.shiftboard') { const r = await signIn(c.post, email, 'demo1234', { now: () => clock.t }); assert.equal(r.status, 200, JSON.stringify(r.body)); },
    rows: async () => (await a.conn.query('SELECT * FROM shiftboard.errors ORDER BY first_seen')).rows,
    events: async () => (await a.conn.query('SELECT * FROM shiftboard.error_events ORDER BY id')).rows,
    alerts: () => a.resend.emails().filter((m) => m.to.includes(ADMIN)),
  };
}
const clientError = (over = {}) => ({
  kind: 'browser', source: 'window', name: 'TypeError', message: "Cannot read properties of undefined (reading 'id')",
  stack: "TypeError: Cannot read properties of undefined (reading 'id')\n    at Ab (https://bistro.example/assets/index-B2x9Kq.js:1:23456)\n    at https://bistro.example/assets/index-B2x9Kq.js:1:999",
  page: '/#/schedule', version: 'abc1234', app: 'web', ...over,
});

// ---------- pure parts ----------
test('scrubbing takes out tokens, passwords, secrets, emails and phone numbers', () => {
  const s = scrubText(`password=hunter2-secret token: abc.def Authorization: Bearer sk_live_${'a'.repeat(24)} ${JWT} ana.lopez@mail.test (720) 555-0134 /api/ical/usr_1/0123456789abcdef01234567.ics ?code=123456&ok=1 client_secret="shh-${'z'.repeat(20)}"`, 2000);
  for (const bad of ['hunter2', 'abc.def', 'sk_live', JWT, 'ana.lopez', '555-0134', '0123456789abcdef01234567', '123456', 'shh-']) assert.ok(!s.includes(bad), `${bad} in ${s}`);
  assert.match(s, /password=\[redacted\]/);
  assert.match(s, /ok=1/, 'harmless values stay');
  // Stacks: paths lose the machine and the build hash, frames keep line:column, the message part is scrubbed.
  const st = cleanStack('Error: bad token=abc123def\n    at listShifts (/var/task/core/service.js:120:9)\n    at async run (file:///home/u/app/server/db.js:250:5)\n    at node:internal/process/task_queues:95:5');
  assert.equal(st.split('\n')[1].trim(), 'at listShifts (core/service.js:120:9)');
  assert.equal(st.split('\n')[2].trim(), 'at async run (server/db.js:250:5)');
  assert.ok(!st.includes('abc123def'));
  assert.equal(cleanPath('/#/welcome?token=secret-token'), '/#/welcome');
  assert.equal(cleanPath('/api/users/usr_8Hk2a/invite'), '/api/users/:id/invite');
  assert.equal(cleanPath('https://bistro.example/#/events/evt_abc123/edit'), '/#/events/:id/edit');
});

test('fingerprints: message and top frame, without ids, numbers, line numbers or build hashes', () => {
  const a = fingerprintOf({ kind: 'server', name: 'TypeError', message: 'Shift shf_ab12cd not found (42)', stack: 'TypeError: x\n    at save (/var/task/core/service.js:10:3)' });
  const b = fingerprintOf({ kind: 'server', name: 'TypeError', message: 'Shift shf_zz99yy not found (43)', stack: 'TypeError: x\n    at save (/opt/app/core/service.js:99:1)' });
  const c = fingerprintOf({ kind: 'server', name: 'TypeError', message: 'Shift shf_ab12cd not found (42)', stack: 'TypeError: x\n    at publish (/var/task/core/service.js:10:3)' });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint, 'another function is another group');
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(normalizeMessage('Shift shf_ab12cd not found (42)'), 'Shift <id> not found (<n>)');
  assert.equal(topFrame('E\n    at Ab (https://x.example/assets/index-B2x9Kq.js:1:2)').key, 'Ab (assets/index.js)');
  assert.equal(topFrame('fn@https://x.example/assets/index-C3d4Ef.js:1:2').key, 'fn (assets/index.js)');
  assert.equal(topFrame('E\n    at fn (address at index.android.bundle:1:5)').key, 'fn (index.android.bundle)');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 'Chrome 131 · Android phone');
  assert.equal(deviceOf('okhttp/4.12', { platform: 'android', osVersion: '14', model: 'Pixel 8', appVersion: '1.0.3' }), 'Phone app 1.0.3 · Android 14 · Pixel 8');
});

test('noise filter, screenshots and the rate limiter', () => {
  assert.ok(isNoise({ message: 'ResizeObserver loop completed with undelivered notifications.' }));
  assert.ok(isNoise({ message: 'Script error.' }));
  assert.ok(isNoise({ message: 'TypeError: x is undefined', stack: 'at f (chrome-extension://abcdef/content.js:1:2)' }));
  assert.ok(isNoise({ message: 'Failed to fetch' }));
  assert.ok(!isNoise({ message: 'x is not a function', stack: 'at f (https://bistro.example/assets/index.js:1:2)' }));
  assert.ok(cleanScreenshot(PNG).file);
  assert.equal(cleanScreenshot(`data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`).error, 'That screenshot isn’t a picture we can use');
  assert.ok(cleanScreenshot('data:image/svg+xml;base64,PHN2Zz4=').error);
  let t = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.ok(rl.take('a') && rl.take('a'));
  assert.equal(rl.take('a'), false);
  assert.ok(rl.take('b'));
  t = 1001;
  assert.ok(rl.take('a'));
});

// ---------- server errors ----------
test('a thrown RPC error still answers 500, is recorded once with the route and user id, and groups on repeat', async () => {
  const A = await start({ VERCEL_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' });
  try {
    await A.login();
    const moe = A.db.store.list('users', (u) => u.email === 'moe@demo.shiftboard')[0];
    // Something unexpected inside a write: the database layer throws.
    const run = A.db.run.bind(A.db);
    A.db.run = async () => { throw new TypeError(`Cannot read properties of undefined (reading 'split') for ${moe.email} password=hunter2`); };
    const r = await A.c.post('/api/rpc/shifts.save', { date: '2026-12-01', start: '16:00', notes: 'my private note' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Something went wrong' }, 'the person sees the usual message');
    await A.errors.settled();
    let rows = await A.rows();
    assert.equal(rows.length, 1);
    const e = rows[0];
    assert.equal(e.kind, 'server');
    assert.equal(e.source, 'rpc');
    assert.equal(e.route, '/api/rpc/shifts.save');
    assert.equal(e.method, 'POST');
    assert.equal(e.http_status, 500);
    assert.equal(e.count, 1);
    assert.equal(e.status, 'new');
    assert.equal(e.last_version, '0123456');
    assert.match(e.top_frame, /test\/errors\.test\.js/);
    assert.ok(!JSON.stringify(e).includes('hunter2') && !JSON.stringify(e).includes('moe@demo'), 'scrubbed');
    let ev = await A.events();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].user_id, moe.id, 'the user id, not the email');
    assert.ok(!JSON.stringify(ev).includes('my private note'), 'the request body is never kept');

    // Again: same group, count 2, one more occurrence.
    A.clock.t += 60_000;
    assert.equal((await A.c.post('/api/rpc/shifts.save', { date: '2026-12-02', start: '17:00' })).status, 500);
    await A.errors.settled();
    rows = await A.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.equal((await A.events()).length, 2);

    // Expected errors (4xx) are not errors.
    A.db.run = run;
    assert.equal((await A.c.post('/api/rpc/shifts.save', { date: 'nope' })).status, 400);
    await A.errors.settled();
    assert.equal((await A.rows()).length, 1);
  } finally { await A.close(); }
});

test('error logging never breaks a request, even when its database is gone', async () => {
  const A = await start();
  try {
    await A.login();
    A.log.ready = Promise.resolve();
    A.log.conn = { query: async () => { throw new Error('connection refused'); }, connect: async () => { throw new Error('connection refused'); } };
    const run = A.db.run;
    A.db.run = async () => { throw new Error('boom'); };
    const r = await A.c.post('/api/rpc/shifts.save', {});
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Something went wrong' });
    const ce = await A.c.post('/api/client-errors', clientError());
    assert.equal(ce.status, 202);
    const rep = await A.c.post('/api/report-problem', { text: 'The schedule is blank' });
    assert.equal(rep.status, 503, 'a report that can’t be saved says so');
    await A.errors.settled();
    A.db.run = run;
    assert.equal((await A.c.post('/api/rpc/app.bootstrap', {})).status, 200, 'and the app carries on');
  } finally { await A.close(); }
});

test('a failed integration sync is recorded as a sync error', async () => {
  const A = await start({ TOAST_CLIENT_ID: 'id', TOAST_CLIENT_SECRET: 'secret-value-1', TOAST_RESTAURANT_GUID: '00000000-0000-0000-0000-000000000000', TOAST_API_HOST: 'http://127.0.0.1:9' });
  try {
    await A.login();
    const r = await A.c.post('/api/toast/sync', { from: '2026-11-01', to: '2026-11-01' });
    assert.equal(r.status, 502);
    await A.errors.settled();
    const [e] = await A.rows();
    assert.equal(e.source, 'sync');
    assert.equal(e.route, '/api/toast/sync');
    assert.match(e.message, /^Toast: /);
    assert.ok(!e.message.includes('secret-value-1'));
  } finally { await A.close(); }
});

// ---------- the apps' own errors ----------
test('client errors: signed in or out, noise dropped, scrubbed, rate-limited', async () => {
  const A = await start();
  try {
    const out = await A.c.post('/api/client-errors', clientError({ page: '/#/welcome?token=abcdef123456', message: `Bad ${JWT} for ana@mail.test`, stack: 'Error\n    at f (https://bistro.example/assets/index-B2x9Kq.js?token=zzz:1:2)' }));
    assert.equal(out.status, 202);
    assert.equal((await A.c.post('/api/client-errors', clientError({ message: 'ResizeObserver loop limit exceeded' }))).body.result.ignored, true);
    assert.equal((await A.c.post('/api/client-errors', clientError({ message: 'x is undefined', stack: 'at f (moz-extension://abc/x.js:1:2)' }))).body.result.ignored, true);
    assert.equal((await A.c.post('/api/client-errors', { message: '' })).status, 400);
    await A.login();
    assert.equal((await A.c.post('/api/client-errors', clientError({ kind: 'phone', source: 'global', app: 'phone', device: { platform: 'ios', osVersion: '18.1', model: 'iPhone 15', appVersion: '1.0.0' } }))).status, 202);
    await A.errors.settled();
    const rows = await A.rows();
    assert.equal(rows.length, 2, 'the noise isn’t stored');
    const dump = JSON.stringify([rows, await A.events()]);
    for (const bad of ['abcdef123456', JWT, 'ana@mail.test', 'zzz', 'bistro.example']) assert.ok(!dump.includes(bad), bad);
    const ev = await A.events();
    assert.equal(ev[0].user_id, null, 'signed out');
    assert.equal(ev[0].page, '/#/welcome');
    const moe = A.db.store.list('users', (u) => u.email === 'moe@demo.shiftboard')[0];
    assert.equal(ev[1].user_id, moe.id, 'signed in: the id');
    assert.equal(ev[1].device, 'Phone app 1.0.0 · iOS 18.1 · iPhone 15');
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['browser', 'phone']);

    // 20 a minute per person and address; then 429 until the minute is up.
    let codes = [];
    for (let i = 0; i < 20; i++) codes.push((await A.c.post('/api/client-errors', clientError({ message: `Error number ${i}` }))).status);
    assert.ok(codes.includes(429), 'the limit kicks in');
    assert.equal(codes.filter((s) => s === 202).length, 19, '20 in the minute (one used above)');
    A.clock.t += 61_000;
    assert.equal((await A.c.post('/api/client-errors', clientError())).status, 202);
    assert.equal((await A.c.post('/api/client-errors', 'not json', { 'Content-Type': 'text/plain' })).status, 415);
  } finally { await A.close(); }
});

test('Report a problem: stored with its screenshot and allowlisted details, alerted right away', async () => {
  const A = await start();
  try {
    await A.login('alexd@demo.shiftboard');
    const r = await A.c.post('/api/report-problem', {
      text: 'The trade button does nothing. My password is hunter2 and my number is 720-555-0134',
      page: 'Swaps', screenshot: PNG,
      context: {
        app: 'web', route: '/#/swaps?token=x', screen: '390x844', lang: 'es', version: 'abc1234', secretStuff: 'nope',
        errors: [{ name: 'TypeError', message: 'x is undefined', source: 'window', at: '2026-11-20T15:00:00Z', extra: 'drop me' }],
        rpc: [{ method: 'swaps.list', status: 200, ms: 120, args: { pin: '1234' } }, { method: 'swaps.create', status: 500, ms: 80 }, { method: '<script>', status: 'x' }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.result.id, /^rep_/);
    await A.errors.settled();
    const [e] = await A.rows();
    assert.equal(e.kind, 'report');
    assert.equal(e.report.page, 'Swaps');
    assert.ok(!e.report.text.includes('hunter2') && !e.report.text.includes('555-0134'), e.report.text);
    const [ev] = await A.events();
    assert.equal(ev.has_file, true);
    assert.equal(ev.page, '/#/swaps');
    assert.deepEqual(Object.keys(ev.context).sort(), ['app', 'errors', 'lang', 'route', 'rpc', 'screen']);
    assert.deepEqual(ev.context.rpc.map((x) => [x.method, x.status]), [['swaps.list', 200], ['swaps.create', 500], ['?', 0]]);
    assert.ok(!JSON.stringify(ev.context).includes('1234') && !JSON.stringify(ev.context).includes('drop me'));
    const f = await A.log.file(e.id, ev.id);
    assert.equal(f.mime, 'image/png');
    assert.equal(f.data.subarray(1, 4).toString(), 'PNG');
    // Each report is its own entry, and each one emails the admin.
    assert.equal((await A.c.post('/api/report-problem', { text: 'Again, the trade button' })).status, 200);
    await A.errors.settled();
    assert.equal((await A.rows()).length, 2);
    const mails = A.alerts();
    assert.equal(mails.length, 2);
    assert.match(mails[0].subject, /New report/);
    assert.ok(!mails[0].html.includes('hunter2'));
    // No words or a bad screenshot: refused. Five tries in ten minutes at most.
    assert.equal((await A.c.post('/api/report-problem', { text: 'x', screenshot: PNG })).status, 400);
    assert.equal((await A.c.post('/api/report-problem', { text: 'Screenshot', screenshot: 'data:text/html;base64,PGgxPg==' })).status, 400);
    assert.equal((await A.c.post('/api/report-problem', { text: 'The fifth one' })).status, 200);
    assert.equal((await A.c.post('/api/report-problem', { text: 'One too many' })).status, 429);
    // Signed out works too (the sign-in page can crash).
    const out = jsonClient(A.base);
    assert.equal((await out.post('/api/report-problem', { text: 'I can’t sign in' })).status, 200);
  } finally { await A.close(); }
});

// ---------- alerts and the digest ----------
test('alerts: a new fingerprint emails at once, then at most once an hour, and stop once acknowledged; ignored ones never', async () => {
  const A = await start();
  try {
    const send = (over) => A.c.post('/api/client-errors', clientError(over));
    await send();
    await A.errors.settled();
    assert.equal(A.alerts().length, 1);
    assert.match(A.alerts()[0].subject, /^\[ShiftBoard\] New browser error: TypeError: Cannot read/);
    for (let i = 0; i < 3; i++) { A.clock.t += 10 * 60_000; await send(); }
    await A.errors.settled();
    assert.equal(A.alerts().length, 1, 'repeats within the hour: no more email');
    A.clock.t += 31 * 60_000; // an hour and a minute after the first
    await send();
    await A.errors.settled();
    assert.equal(A.alerts().length, 2, 'still new an hour later: one reminder');
    assert.match(A.alerts()[1].subject, /Still happening \(5 times\)/);
    const [row] = await A.rows();
    await A.log.setStatus(row.id, 'acknowledged', ADMIN);
    A.clock.t += 2 * 3_600_000;
    await send();
    await A.errors.settled();
    assert.equal(A.alerts().length, 2, 'acknowledged: quiet');
    // Fixed, then back on a newer version: alerts again.
    await A.log.setStatus(row.id, 'fixed', ADMIN);
    await send({ version: 'abc1234' });
    await A.errors.settled();
    assert.equal((await A.rows())[0].status, 'fixed', 'the old version still running doesn’t reopen it');
    await send({ version: 'def5678' });
    await A.errors.settled();
    assert.equal((await A.rows())[0].status, 'new');
    assert.equal(A.alerts().length, 3);
    assert.match(A.alerts()[2].subject, /Back again/);
    // A text only when Twilio and PLATFORM_ALERT_PHONE are set, and only for new 500s (not browser errors).
    assert.equal(A.twilio.texts().length, 0);
    // Ignored: never alerts.
    await send({ message: 'Another thing broke' });
    await A.errors.settled();
    assert.equal(A.alerts().length, 4);
    const other = (await A.rows()).find((r) => r.message === 'Another thing broke');
    await A.log.setStatus(other.id, 'ignored', ADMIN);
    A.clock.t += 2 * 3_600_000;
    await send({ message: 'Another thing broke' });
    await A.errors.settled();
    assert.equal(A.alerts().length, 4);
  } finally { await A.close(); }
});

test('a text for a new server 500 when PLATFORM_ALERT_PHONE is set', async () => {
  const A = await start({ PLATFORM_ALERT_PHONE: '+17205550100' });
  try {
    await A.login();
    A.db.run = async () => { throw new RangeError('Invalid time value'); };
    await A.c.post('/api/rpc/shifts.save', {});
    await A.c.post('/api/rpc/shifts.save', {});
    await A.c.post('/api/client-errors', clientError());
    await A.errors.settled();
    const texts = A.twilio.texts();
    assert.equal(texts.length, 1, 'once, for the new 500 only');
    assert.equal(texts[0].To, '+17205550100');
    assert.match(texts[0].Body, /^ShiftBoard: new server error \(500\): Invalid time value · \/api\/rpc\/shifts\.save/);
  } finally { await A.close(); }
});

test('the daily digest: counts by kind, what’s new, reports and the busiest; nothing to say, no email', async () => {
  const A = await start();
  try {
    for (let i = 0; i < 3; i++) await A.c.post('/api/client-errors', clientError());
    await A.c.post('/api/client-errors', clientError({ kind: 'phone', message: 'Text strings must be rendered within a <Text> component' }));
    await A.c.post('/api/report-problem', { text: 'The 86 list did not refresh' });
    await A.errors.settled();
    const d = await A.log.digest();
    assert.equal(d.total, 5);
    assert.deepEqual(d.byKind, { server: 0, browser: 3, phone: 1, report: 1 });
    assert.equal(d.fresh.length, 2);
    assert.equal(d.reports.length, 1);
    assert.equal(d.busiest[0].recent, 3);
    assert.equal(d.open.new, 3);
    const before = A.alerts().length;
    const out = await A.log.sendDigest();
    assert.equal(out.sent, true);
    const mail = A.alerts().at(-1);
    assert.equal(A.alerts().length, before + 1);
    assert.match(mail.subject, /^\[ShiftBoard\] Daily errors: 5 in the last 24 hours, 2 new, 1 report$/);
    assert.match(mail.text, /The 86 list did not refresh/);
    assert.match(mail.text, /3 browser · 1 phone app · 1 report/);
    // Two days later, everything handled: no email.
    for (const r of await A.rows()) await A.log.setStatus(r.id, 'fixed', ADMIN);
    A.clock.t += 48 * 3_600_000;
    const quiet = await A.log.sendDigest();
    assert.equal(quiet.sent, false);
    assert.equal(quiet.skipped, 'Nothing to report');
    // The issue text is ready to paste and has no user ids.
    const [row] = await A.rows();
    const md = issueMarkdown(await A.log.get(row.id));
    assert.match(md, /^## \[browser · window\] TypeError: Cannot read properties/);
    assert.match(md, /\*\*Fingerprint:\*\* `[0-9a-f]{16}`/);
  } finally { await A.close(); }
});

// ---------- the platform: tagging, the console, the cron ----------
const KEY = crypto.randomBytes(32).toString('base64');
async function startPlatform() {
  const conn = await openPglite();
  const resend = fakeResend();
  const env = {
    PLATFORM_DOMAIN: 'lvh.test', LEGACY_HOSTS: 'legacy.example.test', PLATFORM_ADMIN_EMAIL: ADMIN, PLATFORM_ADMIN_PASSWORD: 'console-password-1',
    PLATFORM_ENCRYPTION_KEY: KEY, JWT_SECRET: 'errors-test-jwt', SEED_DEMO: 'true', EXPO_PUSH: 'off', CRON_SECRET: 'cron-test-value',
    RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>',
  };
  const app = createPlatformApp({ conn, env, mailerFor: (e) => createMailer(e, { fetchImpl: resend.fetchImpl }) });
  await app.locals.warmDefault();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const at = (host) => hostClient(port, host);
  return {
    app, conn, resend, at, errors: app.locals.platform.errors,
    console: async () => {
      const c = at('admin.lvh.test');
      const r = await c.post('/api/platform/login', { email: ADMIN, password: 'console-password-1' });
      assert.equal(r.status, 200, r.text);
      if (r.body.result?.mustChange) assert.equal((await c.post('/api/platform/password', { password: 'console-password-1' })).status, 200);
      return c;
    },
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); },
  };
}

test('platform: errors are tagged with their restaurant, the console reads them, restaurant admins can’t', async () => {
  const P = await startPlatform();
  try {
    const admin = await P.console();
    const made = await admin.post('/api/platform/tenants', { name: 'Bistro Nine', slug: 'bistro', plan: 'starter', ownerName: 'Pat Owner', ownerEmail: 'owner@bistro.test' });
    assert.equal(made.status, 200, made.text);
    const bistroId = made.body.result.tenant.id;

    // The same browser error at two restaurants: one group, both restaurants.
    const legacy = P.at('legacy.example.test');
    await legacy.login('moe@demo.shiftboard');
    assert.equal((await legacy.post('/api/client-errors', clientError())).status, 202);
    assert.equal((await P.at('bistro.lvh.test').post('/api/client-errors', clientError())).status, 202);
    // A server error at the default restaurant, with Moe signed in.
    const rt = await P.app.locals.platform.runtime((await P.app.locals.platform.registry.snapshot()).defaultTenant);
    const run = rt.db.run;
    rt.db.run = async () => { throw new TypeError('boom at the default restaurant'); };
    assert.equal((await legacy.rpc('shifts.save', {})).status, 500);
    rt.db.run = run;
    // A report from the default restaurant, with a screenshot.
    assert.equal((await legacy.post('/api/report-problem', { text: 'Tips page is empty', page: 'Tips', screenshot: PNG })).status, 200);
    await P.errors.settled();

    const { rows } = await P.conn.query('SELECT * FROM platform.errors ORDER BY first_seen');
    assert.equal(rows.length, 3);
    const browser = rows.find((r) => r.kind === 'browser');
    assert.deepEqual([...browser.tenants].sort(), ['default', bistroId].sort());
    const server = rows.find((r) => r.kind === 'server');
    assert.deepEqual(server.tenants, ['default']);
    const moe = rt.db.store.list('users', (u) => u.email === 'moe@demo.shiftboard')[0];
    const ev = (await P.conn.query('SELECT * FROM platform.error_events WHERE error_id = $1', [server.id])).rows[0];
    assert.equal(ev.tenant_id, 'default');
    assert.equal(ev.user_id, moe.id);
    // Nothing lands in the restaurants' own schemas.
    assert.equal((await P.conn.query(`SELECT to_regclass('shiftboard.errors') AS t`)).rows[0].t, null);

    // The console: the list, filters, the detail, status changes (audited), the screenshot.
    let list = await admin.get('/api/platform/errors?since=24h');
    assert.equal(list.status, 200);
    assert.equal(list.body.result.items.length, 3);
    assert.equal(list.body.result.tenants[bistroId], 'Bistro Nine');
    list = await admin.get(`/api/platform/errors?tenant=${bistroId}`);
    assert.deepEqual(list.body.result.items.map((i) => i.kind), ['browser']);
    list = await admin.get('/api/platform/errors?kind=report');
    assert.equal(list.body.result.items.length, 1);
    assert.equal(list.body.result.items[0].hasScreenshot, true);
    const reportId = list.body.result.items[0].id;
    const detail = await admin.get(`/api/platform/errors/${browser.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.result.events.length, 2);
    assert.deepEqual(detail.body.result.byTenant.map((t) => t.name).sort(), ['Bistro Nine', 'Chasing Rabbits'].sort());
    assert.match(detail.body.result.issueText, /Restaurants:\*\* .*Bistro Nine/);
    assert.ok(!detail.body.result.issueText.includes(moe.id));
    const rep = await admin.get(`/api/platform/errors/${reportId}`);
    const shot = await admin.get(`/api/platform/errors/${reportId}/files/${rep.body.result.events[0].id}`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    assert.match(shot.headers['content-security-policy'], /sandbox/);
    const ack = await admin.patch(`/api/platform/errors/${browser.id}`, { status: 'acknowledged' });
    assert.equal(ack.body.result.status, 'acknowledged');
    assert.equal((await admin.patch(`/api/platform/errors/${browser.id}`, { status: 'whatever' })).status, 400);
    const audit = await admin.get('/api/platform/audit');
    assert.ok(audit.body.result.some((a) => a.action === 'error.status' && a.details.status === 'acknowledged'));
    assert.equal((await admin.get('/api/platform/errors?status=acknowledged')).body.result.items.length, 1);

    // Not for restaurant accounts: not on a restaurant's host, not without the console's own sign-in.
    assert.equal((await legacy.get('/api/platform/errors')).status, 401, 'a restaurant session isn’t a console session');
    const onBistro = await P.at('bistro.lvh.test').get('/api/platform/errors');
    assert.equal(onBistro.status, 404);
    const stranger = P.at('admin.lvh.test');
    stranger.setCookies(legacy.cookies()); // a restaurant admin's session cookie on the console's host
    assert.equal((await stranger.get('/api/platform/errors')).status, 401);
    assert.equal((await stranger.get(`/api/platform/errors/${reportId}/files/1`)).status, 401);
    assert.equal((await legacy.rpc('errors.list', {})).status, 404, 'no RPC for it either');

    // The console's own crashes.
    assert.equal((await admin.post('/api/platform/client-errors', clientError({ app: 'console', message: 'Console blew up' }))).status, 202);
    await P.errors.settled();
    const consoleErr = (await P.conn.query(`SELECT * FROM platform.errors WHERE message = 'Console blew up'`)).rows[0];
    assert.deepEqual(consoleErr.tenants, []);

    // The daily digest cron: needs CRON_SECRET; emails the admin.
    assert.equal((await P.at('admin.lvh.test').get('/api/cron/errors-digest')).status, 401);
    const cron = await P.at('admin.lvh.test').get('/api/cron/errors-digest', { Authorization: 'Bearer cron-test-value' });
    assert.equal(cron.status, 200, cron.text);
    assert.equal(cron.body.result.sent, true);
    assert.ok(P.resend.emails().some((m) => m.to.includes(ADMIN) && /Daily errors/.test(m.subject)));
    // Alerts link to the console.
    const alert = P.resend.emails().find((m) => m.to.includes(ADMIN) && /New report/.test(m.subject));
    assert.ok(alert.html.includes('https://admin.lvh.test/platform#/errors/rep_'));
    assert.match(alert.subject, /Chasing Rabbits/);
  } finally { await P.close(); }
});

test('platform: a failed daily sync is recorded for its restaurant', async () => {
  const P = await startPlatform();
  try {
    const platform = P.app.locals.platform;
    const def = (await platform.registry.snapshot()).defaultTenant;
    const rt = await platform.runtime(def);
    rt.app.locals.toastCron = async () => ({ ok: false, error: 'Toast said 401: the credentials were rejected' });
    // Toast set up for the default restaurant (env), so the cron runs it.
    rt.env.TOAST_CLIENT_ID = 'id'; rt.env.TOAST_CLIENT_SECRET = 'secret-1234'; rt.env.TOAST_RESTAURANT_GUID = '00000000-0000-0000-0000-000000000000';
    const out = await P.app.locals.toastCronAll();
    assert.equal(out.tenants[0].ok, false);
    await P.errors.settled();
    const { rows } = await P.conn.query(`SELECT * FROM platform.errors WHERE source = 'cron'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].tenants, ['default']);
    assert.equal(rows[0].route, '/api/cron/toast');
    assert.match(rows[0].message, /^Toast: Toast said <n>: the credentials were rejected|^Toast: Toast said 401/);
  } finally { await P.close(); }
});
