// Phone notifications (Web Push) and text messages (Twilio). No network: the push sender and
// Twilio's HTTP API are fakes that record what would have been sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { normalizePhone, formatPhone, textMessage, plainText, replyKeyword, applyTextReply, cleanSubscription } from '../core/notify-prefs.js';
import { createTexter, twilioSignature, validTwilioSignature } from '../server/sms.js';
import { createPusher } from '../server/push.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { addDays, todayStr } from '../core/time.js';

// ---------- fakes ----------

// Twilio's Messages API: records each text; `fail` answers with a Twilio error, `hang` never answers.
function fakeTwilio({ fail, hang } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, form: Object.fromEntries(new URLSearchParams(init.body)) });
    if (hang) return new Promise(() => {});
    if (fail) return { ok: false, status: 400, json: async () => ({ code: fail.code, message: fail.message }) };
    return { ok: true, status: 201, json: async () => ({ sid: `SM${calls.length}`, status: 'queued' }) };
  };
  return { calls, fetchImpl, texts: () => calls.map((c) => c.form) };
}
const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'test-auth-token', TWILIO_MESSAGING_SERVICE_SID: 'MGtest' };

// The web-push send function: records each push; `status` makes the push service answer with that error.
function fakePushService({ status = {}, hang } = {}) {
  const sent = [];
  const send = async (sub, payload, options) => {
    sent.push({ endpoint: sub.endpoint, keys: sub.keys, message: JSON.parse(payload), options });
    if (hang) return new Promise(() => {});
    const code = status[sub.endpoint];
    if (code) throw Object.assign(new Error(`Received unexpected response code ${code}`), { statusCode: code });
    return { statusCode: 201 };
  };
  return { sent, send };
}
const PUSH_ENV = { VAPID_PUBLIC_KEY: 'test-public-key', VAPID_PRIVATE_KEY: 'test-private-key', VAPID_SUBJECT: 'mailto:owner@example.com' };

const KEYS = { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) };
const sub = (id, host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/${id}`, keys: KEYS });

// ---------- phone numbers, message text ----------

test('phone numbers are normalized to E.164 with +1 by default', () => {
  for (const [input, want] of [
    ['(303) 555-0123', '+13035550123'], ['303.555.0123', '+13035550123'], ['303 555 0123', '+13035550123'],
    ['1-303-555-0123', '+13035550123'], ['+1 303 555 0123', '+13035550123'], ['+44 7911 123456', '+447911123456'],
    ['0044 7911 123456', '+447911123456'], ['+61 412 345 678', '+61412345678'],
  ]) assert.equal(normalizePhone(input), want, input);
  for (const bad of ['', null, '555-0123', '123-456-7890', '303-055-0123', '+1 303 555 012', 'call me', '+0 123 456 789', '2 303 555 0123', '+1234567890123456']) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
  assert.equal(formatPhone('+13035550123'), '(303) 555-0123');
  assert.equal(formatPhone('+447911123456'), '+447911123456');
});

test('texts are short, plain (one GSM segment when possible) and carry the app link', () => {
  const url = 'https://schedule.rabbits.co/#/my';
  const t = textMessage({ restaurant: 'Chasing Rabbits', text: 'New shift: Server Tue, Sep 29 4p–10p', url });
  assert.equal(t, 'Chasing Rabbits: New shift: Server Tue, Sep 29 4p-10p https://schedule.rabbits.co/#/my');
  const long = textMessage({ restaurant: 'Chasing Rabbits', text: `Event updated: ${'x'.repeat(300)}`, url, more: 2 });
  assert.ok(long.length <= 160, `${long.length} chars`);
  assert.ok(long.endsWith(`... (+2 more) ${url}`));
  assert.equal(plainText('It’s “done” — ok…'), 'It\'s "done" - ok...');
});

// ---------- Twilio ----------

test('Twilio signatures: the published test vector, port variants, wrong token or params', () => {
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  assert.equal(twilioSignature('12345', url, params), 'RSOYDt4T1cUTdK1PDd93/VVr8B8='); // from Twilio's own validator tests
  assert.ok(validTwilioSignature('12345', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, params));
  assert.ok(validTwilioSignature('12345', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', 'https://mycompany.com:443/myapp.php?foo=1&bar=2', params));
  assert.ok(!validTwilioSignature('54321', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, params));
  assert.ok(!validTwilioSignature('12345', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, { ...params, Digits: '9999' }));
  assert.ok(!validTwilioSignature('12345', '', url, params));
});

test('a text is one POST to Twilio with basic auth and To, Body and the sender', async () => {
  const tw = fakeTwilio();
  const texter = createTexter(TWILIO_ENV, { fetchImpl: tw.fetchImpl });
  assert.equal(texter.enabled, true);
  assert.deepEqual(await texter.send('+13035550123', 'Hello'), { sid: 'SM1', status: 'queued' });
  const [c] = tw.calls;
  assert.equal(c.url, 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
  assert.equal(c.headers.Authorization, `Basic ${Buffer.from('ACtest:test-auth-token').toString('base64')}`);
  assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(c.form, { To: '+13035550123', Body: 'Hello', MessagingServiceSid: 'MGtest' });

  const fromNumber = createTexter({ ...TWILIO_ENV, TWILIO_MESSAGING_SERVICE_SID: '', TWILIO_FROM_NUMBER: '+17205550100' }, { fetchImpl: tw.fetchImpl });
  await fromNumber.send('+13035550123', 'Hi');
  assert.deepEqual(tw.calls[1].form, { To: '+13035550123', Body: 'Hi', From: '+17205550100' });
  assert.equal(fromNumber.from, '+17205550100');

  const failing = createTexter(TWILIO_ENV, { fetchImpl: fakeTwilio({ fail: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } }).fetchImpl });
  await assert.rejects(failing.send('+13035550123', 'x'), (e) => e.code === 21610 && /unsubscribed/.test(e.message));
  assert.equal(createTexter({ TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'x' }).enabled, false, 'needs a sender');
});

test('web push: VAPID details and the message go to the sender; 404/410 mean the phone is gone', async () => {
  const svc = fakePushService({ status: { 'https://fcm.googleapis.com/fcm/send/old': 410, 'https://fcm.googleapis.com/fcm/send/err': 500 } });
  const pusher = createPusher(PUSH_ENV, { send: svc.send });
  assert.equal(pusher.enabled, true);
  assert.deepEqual(await pusher.send(sub('ok'), { title: 'R', body: 'B', url: '/#/my' }), { ok: true });
  assert.deepEqual(svc.sent[0].message, { title: 'R', body: 'B', url: '/#/my' });
  assert.deepEqual(svc.sent[0].options.vapidDetails, { subject: 'mailto:owner@example.com', publicKey: 'test-public-key', privateKey: 'test-private-key' });
  assert.deepEqual(await pusher.send(sub('old'), {}), { gone: true });
  await assert.rejects(pusher.send(sub('err'), {}), /500/);
  assert.equal(createPusher({ ...PUSH_ENV, VAPID_SUBJECT: '' }).enabled, false);
});

// ---------- RPCs (core) ----------

function service(channels) {
  const store = new MemoryStore();
  seedDemo(store);
  const svc = createService(store, { channels });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  return { store, as };
}
const ON = { push: { enabled: true, publicKey: 'test-public-key' }, sms: { enabled: true } };

test('push.subscribe / push.unsubscribe: checked, one per phone, only your own', () => {
  const { store, as } = service(ON);
  const alex = as('usr_alexd'), styves = as('usr_styves');
  assert.deepEqual(alex('push.publicKey', {}), { enabled: true, publicKey: 'test-public-key', devices: 0, thisDevice: false });
  assert.throws(() => alex('push.subscribe', { subscription: sub('a', 'evil.example.com') }), /isn’t supported/);
  assert.throws(() => alex('push.subscribe', { subscription: { endpoint: 'http://fcm.googleapis.com/x', keys: KEYS } }), /isn’t a push subscription/);
  assert.throws(() => alex('push.subscribe', { subscription: { endpoint: sub('a').endpoint, keys: { auth: 'x' } } }), /keys/);
  for (const host of ['web.push.apple.com', 'updates.push.services.mozilla.com', 'wns2-by3p.notify.windows.com']) assert.doesNotThrow(() => cleanSubscription(sub('h', host)));

  assert.equal(alex('push.subscribe', { subscription: sub('a') }).devices, 1);
  assert.equal(alex('push.subscribe', { subscription: sub('a') }).devices, 1, 'subscribing again updates, not duplicates');
  alex('push.subscribe', { subscription: sub('b') });
  assert.equal(alex('push.publicKey', { endpoint: sub('a').endpoint }).thisDevice, true);
  assert.equal(store.list('pushSubscriptions').length, 2);

  // Someone else can't remove Alex's phones; signing up on Alex's phone moves it to them.
  assert.equal(styves('push.unsubscribe', { endpoint: sub('a').endpoint }).removed, 0);
  styves('push.subscribe', { subscription: sub('a') });
  assert.equal(store.list('pushSubscriptions', (s) => s.endpoint === sub('a').endpoint).length, 1);
  assert.equal(alex('push.publicKey', { endpoint: sub('a').endpoint }).thisDevice, false);
  assert.equal(alex('push.unsubscribe', { endpoint: sub('b').endpoint }).removed, 1);
  assert.equal(alex('push.publicKey', {}).devices, 0);

  // At most 10 phones per person: the oldest drops off.
  for (let i = 0; i < 12; i++) styves('push.subscribe', { subscription: sub(`s${i}`) });
  assert.equal(store.list('pushSubscriptions', (s) => s.userId === 'usr_styves').length, 10);

  // The demo (no server) has nothing set up.
  const demo = service(undefined).as('usr_alexd');
  assert.equal(demo('push.publicKey', {}).enabled, false);
  assert.throws(() => demo('push.subscribe', { subscription: sub('a') }), /aren’t set up/);
  assert.throws(() => demo('sms.preferences', { on: true, phone: '3035550123' }), /aren’t set up/);
});

test('texts: each person opts in themselves; managers can’t; the restaurant switch is admin-only', () => {
  const { store, as } = service(ON);
  const alex = as('usr_alexd'), moe = as('usr_moe'), kelly = as('usr_kelly');
  assert.equal(store.get('users', 'usr_alexd').smsNotifications, undefined, 'off by default');
  assert.throws(() => alex('sms.preferences', { on: true, phone: '555-0123' }), /mobile number/);
  assert.deepEqual(alex('sms.preferences', { on: true, phone: '(303) 555-0123' }), { smsNotifications: true, smsPhone: '+13035550123' });
  const consent = store.get('users', 'usr_alexd').smsConsentAt;
  assert.ok(consent);
  assert.deepEqual(alex('sms.preferences', { on: false }), { smsNotifications: false, smsPhone: '+13035550123' });

  // A manager editing Alex can't switch texts on or change the number.
  const me = store.get('users', 'usr_alexd');
  moe('employees.save', { ...me, smsNotifications: true, smsPhone: '+17205550199' });
  assert.equal(store.get('users', 'usr_alexd').smsNotifications, false);
  assert.equal(store.get('users', 'usr_alexd').smsPhone, '+13035550123');
  // sms.preferences only ever changes the caller.
  moe('sms.preferences', { on: true, phone: '7205550100', userId: 'usr_alexd' });
  assert.equal(store.get('users', 'usr_alexd').smsNotifications, false);
  assert.equal(store.get('users', 'usr_moe').smsPhone, '+17205550100');

  // Restaurant-wide switch.
  assert.throws(() => kelly('sms.setRestaurant', { on: false }), /Admins only/);
  assert.throws(() => alex('sms.setRestaurant', { on: false }), /Admins only/);
  moe('sms.setRestaurant', { on: false });
  assert.equal(moe('app.bootstrap').settings.smsNotifications, false);
  assert.throws(() => alex('sms.preferences', { on: true }), /turned off/);
  assert.doesNotThrow(() => alex('sms.preferences', { on: false }), 'turning off always works');
  moe('sms.setRestaurant', { on: true });
  alex('sms.preferences', { on: true });
  assert.equal(store.get('users', 'usr_alexd').smsNotifications, true, 'the saved number is reused');
});

test('STOP and START replies', () => {
  for (const w of ['STOP', 'stop', 'Stop.', 'STOPALL', 'unsubscribe', 'Cancel', 'END', 'quit']) assert.equal(replyKeyword(w), 'stop', w);
  for (const w of ['START', 'yes', 'UNSTOP']) assert.equal(replyKeyword(w), 'start', w);
  assert.equal(replyKeyword('Can I swap Friday?'), null);
  assert.equal(replyKeyword('please', 'STOP'), 'stop', 'Twilio’s OptOutType wins');
  const { store, as } = service(ON);
  as('usr_alexd')('sms.preferences', { on: true, phone: '3035550123' });
  assert.equal(applyTextReply(store, { from: '+13035550123', action: 'stop' }), 1);
  assert.equal(store.get('users', 'usr_alexd').smsNotifications, false);
  assert.ok(store.get('users', 'usr_alexd').smsStoppedAt);
  assert.equal(applyTextReply(store, { from: '+19995550123', action: 'stop' }), 0, 'unknown number');
  assert.equal(applyTextReply(store, { from: '+13035550123', action: 'start' }), 1);
  assert.equal(store.get('users', 'usr_alexd').smsNotifications, true);
});

// ---------- HTTP API: sent after the commit, never breaking the request ----------

async function startApp({ env = {}, push = fakePushService(), twilio = fakeTwilio() } = {}) {
  const db = new DocDb(await openPglite());
  const pusher = createPusher({ ...PUSH_ENV, ...env }, { send: push.send });
  const texter = createTexter({ ...TWILIO_ENV, ...env }, { fetchImpl: twilio.fetchImpl });
  const app = createApp({ db, env: { SEED_DEMO: 'true', APP_URL: 'https://schedule.rabbits.co', ...env }, pusher, texter });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, db, base, push, twilio,
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await db.close(); },
  };
}

function client(base) {
  let cookie = '';
  async function post(path, body = {}) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return {
    post,
    rpc: (method, args) => post(`/api/rpc/${method}`, args),
    async login(email) { assert.equal((await post('/api/auth/login', { email, password: 'demo1234' })).status, 200); return this; },
  };
}
const newShift = (mgr, userId, days = 20) => mgr.rpc('shifts.save', { date: addDays(todayStr(), days), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId, published: true });

test('new notifications go to phones and opted-in mobiles; expired phones are removed', async () => {
  const A = await startApp({ push: fakePushService({ status: { [sub('gone').endpoint]: 410 } }) });
  try {
    const cfg = await (await fetch(`${A.base}/api/config`)).json();
    assert.deepEqual([cfg.push, cfg.sms], [true, true]);
    const alex = await client(A.base).login('alexd@demo.shiftboard');
    const styves = await client(A.base).login('styves@demo.shiftboard');
    const mgr = await client(A.base).login('moe@demo.shiftboard');
    assert.equal((await alex.rpc('push.publicKey', {})).body.result.publicKey, 'test-public-key', 'read-only RPC');
    assert.equal((await alex.rpc('push.subscribe', { subscription: sub('alex-phone') })).status, 200);
    assert.equal((await alex.rpc('push.subscribe', { subscription: sub('gone') })).status, 200);
    assert.equal((await alex.rpc('sms.preferences', { on: true, phone: '(303) 555-0123' })).status, 200);
    await styves.rpc('push.subscribe', { subscription: sub('styves-phone') }); // Styves: push only, no texts
    await A.app.locals.settled();
    assert.deepEqual(A.twilio.texts().map((t) => t.To), ['+13035550123'], 'a welcome text after opting in');
    assert.match(A.twilio.texts()[0].Body, /Reply STOP to opt out/);

    assert.equal((await newShift(mgr, 'usr_alexd')).status, 200);
    assert.equal((await newShift(mgr, 'usr_styves')).status, 200);
    await A.app.locals.settled();
    const pushed = A.push.sent.map((p) => p.endpoint.split('/').pop()).sort();
    assert.deepEqual(pushed, ['alex-phone', 'gone', 'styves-phone']);
    const msg = A.push.sent.find((p) => p.endpoint.endsWith('alex-phone')).message;
    assert.equal(msg.title, 'Our Restaurant');
    assert.match(msg.body, /New shift/);
    assert.equal(msg.url, '/#/my');
    const texts = A.twilio.texts().slice(1);
    assert.equal(texts.length, 1, 'only Alex opted in to texts');
    assert.equal(texts[0].To, '+13035550123');
    assert.match(texts[0].Body, /^Our Restaurant: New shift.* https:\/\/schedule\.rabbits\.co\/#\/my$/);
    // The push service said 410: that subscription is gone, the others stay.
    assert.deepEqual((await alex.rpc('push.publicKey', {})).body.result.devices, 1);
    assert.equal(A.db.store.list('pushSubscriptions', (s) => s.endpoint === sub('gone').endpoint).length, 0);

    // Reads and failed requests send nothing.
    const before = [A.push.sent.length, A.twilio.calls.length];
    await mgr.rpc('app.bootstrap');
    assert.equal((await mgr.rpc('shifts.save', { date: addDays(todayStr(), 21), start: 'nope', jobCodeId: 'job_srv', userId: 'usr_alexd', published: true })).status, 400);
    // The restaurant switch stops texts (phones still get notifications); STOP-ed people get none.
    assert.equal((await alex.rpc('sms.setRestaurant', { on: false })).status, 403);
    assert.equal((await mgr.rpc('sms.setRestaurant', { on: false })).status, 200);
    await newShift(mgr, 'usr_alexd', 22);
    await A.app.locals.settled();
    assert.equal(A.twilio.calls.length, before[1]);
    assert.equal(A.push.sent.length, before[0] + 1);
  } finally { await A.close(); }
});

test('a failed or hanging push or text never fails or slows the request', async () => {
  for (const [label, opts] of [
    ['errors', { push: fakePushService({ status: { [sub('p').endpoint]: 500 } }), twilio: fakeTwilio({ fail: { code: 30007, message: 'Carrier violation' } }) }],
    ['hangs', { push: fakePushService({ hang: true }), twilio: fakeTwilio({ hang: true }) }],
  ]) {
    const A = await startApp(opts);
    try {
      const alex = await client(A.base).login('alexd@demo.shiftboard');
      const mgr = await client(A.base).login('moe@demo.shiftboard');
      await alex.rpc('push.subscribe', { subscription: sub('p') });
      await alex.rpc('sms.preferences', { on: true, phone: '3035550123' });
      const t0 = Date.now();
      const r = await newShift(mgr, 'usr_alexd');
      assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
      assert.ok(Date.now() - t0 < 2000, `${label}: answered without waiting for the send`);
      assert.equal((await alex.rpc('shifts.list', { start: todayStr(), end: addDays(todayStr(), 30) })).body.result.shifts.filter((s) => s.userId === 'usr_alexd').length > 0, true);
      if (label === 'errors') {
        await A.app.locals.settled();
        assert.equal(A.db.store.list('pushSubscriptions').length, 1, 'a 500 doesn’t remove the phone');
        assert.equal(A.db.store.get('users', 'usr_alexd').smsNotifications, true);
      }
      assert.ok(A.push.sent.length >= 1 && A.twilio.calls.length >= 1, `${label}: the sends were attempted`);
    } finally { await A.close(); }
  }
});

test('Twilio says a number unsubscribed: its texts are turned off', async () => {
  const A = await startApp({ twilio: fakeTwilio({ fail: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } }) });
  try {
    const alex = await client(A.base).login('alexd@demo.shiftboard');
    await alex.rpc('sms.preferences', { on: true, phone: '3035550123' }); // the welcome text fails with 21610
    await A.app.locals.settled();
    assert.equal(A.db.store.get('users', 'usr_alexd').smsNotifications, false);
  } finally { await A.close(); }
});

test('STOP / START webhook: only signed requests from Twilio count', async () => {
  const A = await startApp();
  try {
    const alex = await client(A.base).login('alexd@demo.shiftboard');
    await alex.rpc('sms.preferences', { on: true, phone: '3035550123' });
    const url = `${A.base}/api/twilio/inbound`;
    const inbound = (params, signature = twilioSignature('test-auth-token', url, params)) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: new URLSearchParams(params),
    });
    const stop = { From: '+13035550123', To: '+17205550100', Body: 'STOP', MessageSid: 'SM1', OptOutType: 'STOP' };
    assert.equal((await inbound(stop, 'forged')).status, 403);
    assert.equal((await inbound(stop, twilioSignature('wrong-token', url, stop))).status, 403);
    assert.equal(A.db.store.get('users', 'usr_alexd').smsNotifications, true);

    const r = await inbound(stop);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /xml/);
    assert.match(await r.text(), /<Response><\/Response>/);
    await A.db.sync();
    assert.equal(A.db.store.get('users', 'usr_alexd').smsNotifications, false);
    assert.ok(A.db.store.get('users', 'usr_alexd').smsStoppedAt);

    assert.equal((await inbound({ ...stop, Body: 'Running late', OptOutType: '' })).status, 200, 'other texts are ignored');
    assert.equal((await inbound({ ...stop, Body: 'START', OptOutType: 'START' })).status, 200);
    await A.db.sync();
    assert.equal(A.db.store.get('users', 'usr_alexd').smsNotifications, true);
  } finally { await A.close(); }
});

test('test buttons: push to my phones; test text for admins only', async () => {
  const A = await startApp();
  try {
    const alex = await client(A.base).login('alexd@demo.shiftboard');
    const kelly = await client(A.base).login('kelly@demo.shiftboard');
    const moe = await client(A.base).login('moe@demo.shiftboard');
    assert.equal((await alex.post('/api/push/test')).status, 400, 'no phone yet');
    await alex.rpc('push.subscribe', { subscription: sub('a') });
    const t = await alex.post('/api/push/test');
    assert.equal(t.status, 200);
    assert.equal(t.body.result.sent, 1);
    assert.match(A.push.sent.at(-1).message.body, /Test/);

    assert.equal((await alex.post('/api/sms/test', { phone: '3035550123' })).status, 403);
    assert.equal((await kelly.post('/api/sms/test', { phone: '3035550123' })).status, 403, 'managers aren’t admins');
    assert.equal((await moe.post('/api/sms/test', { phone: 'nope' })).status, 400);
    const s = await moe.post('/api/sms/test', { phone: '720 555 0100' });
    assert.equal(s.status, 200);
    assert.equal(s.body.result.to, '(720) 555-0100');
    assert.equal(A.twilio.texts().at(-1).To, '+17205550100');
  } finally { await A.close(); }

  // Without Twilio or VAPID settings: everything reports "not set up" and nothing is sent.
  const B = await startApp({ env: { TWILIO_ACCOUNT_SID: '', VAPID_PRIVATE_KEY: '' } });
  try {
    const cfg = await (await fetch(`${B.base}/api/config`)).json();
    assert.deepEqual([cfg.push, cfg.sms], [false, false]);
    const moe = await client(B.base).login('moe@demo.shiftboard');
    assert.equal((await moe.rpc('push.publicKey', {})).body.result.enabled, false);
    assert.equal((await moe.rpc('push.subscribe', { subscription: sub('a') })).status, 400);
    assert.equal((await moe.rpc('sms.preferences', { on: true, phone: '3035550123' })).status, 400);
    assert.equal((await moe.post('/api/sms/test', { phone: '3035550123' })).status, 400);
    assert.equal((await fetch(`${B.base}/api/twilio/inbound`, { method: 'POST' })).status, 403);
  } finally { await B.close(); }
});
