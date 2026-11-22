// STOP and START texts to /api/twilio/inbound: every stop word turns texts off with a consent record, every start
// word turns them back on, case and spaces don't matter, the signature is checked on every request (403 and no
// change without a valid one, even when Twilio isn't set up), and after STOP nothing more is texted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, todayStr } from '../core/time.js';
import { STOP_WORDS, START_WORDS, replyKeyword } from '../core/notify-prefs.js';
import { twilioSignature, createTexter } from '../server/sms.js';
import { createChannels } from '../server/channels.js';
import { startApp, TWILIO_ENV } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';

const PHONE = '+13035550142';

async function setUp(env) {
  const A = await startApp(env);
  const c = jsonClient(A.base);
  assert.equal((await signIn(c.post, 'alexd@demo.shiftboard')).status, 200);
  assert.equal((await c.post('/api/rpc/sms.preferences', { on: true, phone: PHONE, consent: true })).status, 200);
  const url = `${A.base}/api/twilio/inbound`;
  const inbound = (params, signature = twilioSignature('test-auth-token', url, params), headers = {}) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(signature == null ? {} : { 'X-Twilio-Signature': signature }), ...headers },
    body: new URLSearchParams(params),
  });
  const alex = async () => { await A.db.sync(); return A.db.store.get('users', 'usr_alexd'); };
  const records = async () => { await A.db.sync(); return A.db.store.list('consents', (x) => x.userId === 'usr_alexd' && x.source === 'keyword'); };
  return { A, c, inbound, alex, records };
}
const text = (Body, extra = {}) => ({ From: PHONE, To: '+17205550100', Body, MessageSid: `SM${Math.random().toString(36).slice(2)}`, ...extra });

test('the keyword lists: Twilio’s words plus OPTOUT and REVOKE; case, spaces and punctuation don’t matter', () => {
  assert.deepEqual(STOP_WORDS, ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
  assert.deepEqual(START_WORDS, ['START', 'YES', 'UNSTOP']);
  for (const w of [' stop ', 'Stop.', 'sToP!', '\tUNSUBSCRIBE\n', 'opt-out', 'Revoke']) assert.equal(replyKeyword(w), 'stop', JSON.stringify(w));
  for (const w of [' start', 'Yes!', 'unstop ']) assert.equal(replyKeyword(w), 'start', JSON.stringify(w));
  for (const w of ['stop texting me so late', 'yes please swap', '']) assert.equal(replyKeyword(w), null, JSON.stringify(w));
});

test('each stop word turns texts off with a keyword record; each start word turns them back on', async () => {
  const { A, inbound, alex, records } = await setUp();
  try {
    const words = [...STOP_WORDS.flatMap((s, i) => [i % 2 ? ` ${s.toLowerCase()} ` : s, START_WORDS[i % START_WORDS.length]])];
    const seen = new Set();
    for (const w of words) {
      const r = await inbound(text(w), undefined, { 'X-Forwarded-For': '54.172.60.1' });
      assert.equal(r.status, 200, w);
      assert.match(await r.text(), /<Response><\/Response>/);
      const stop = replyKeyword(w) === 'stop';
      const u = await alex();
      assert.equal(u.smsConsent, !stop, w);
      if (stop) assert.ok(u.smsStoppedAt);
      const fresh = (await records()).filter((x) => !seen.has(x.id));
      assert.equal(fresh.length, 1, `one record for ${w}`);
      const [last] = fresh;
      seen.add(last.id);
      assert.deepEqual([last.channel, last.granted, last.source, last.phone, last.ip], ['sms', !stop, 'keyword', PHONE, '54.172.60.1'], w);
      assert.equal(last.version, `keyword:${w.trim().toUpperCase()}`);
      assert.equal(last.text, w.trim());
      assert.ok(last.at);
    }
    // A STOP when already stopped, or a START when already on, changes nothing and adds no record.
    await inbound(text('START'));
    const n = (await records()).length;
    await inbound(text('YES'));
    assert.equal((await records()).length, n);
  } finally { await A.close(); }
});

test('a bad or missing signature: 403 and nothing changes (also when Twilio isn’t set up)', async () => {
  const { A, inbound, alex, records } = await setUp();
  try {
    const stop = text('STOP');
    assert.equal((await inbound(stop, null)).status, 403, 'no signature');
    assert.equal((await inbound(stop, 'forged')).status, 403);
    assert.equal((await inbound(stop, twilioSignature('wrong-token', `${A.base}/api/twilio/inbound`, stop))).status, 403);
    assert.equal((await inbound({ ...stop, Body: 'START' }, twilioSignature('test-auth-token', `${A.base}/api/twilio/inbound`, stop))).status, 403, 'signed for other params');
    assert.equal((await alex()).smsConsent, true);
    assert.equal((await records()).length, 0);
    assert.equal((await inbound(stop)).status, 200, 'a valid signature works');
  } finally { await A.close(); }

  const B = await startApp({ sms: false });
  try {
    const url = `${B.base}/api/twilio/inbound`;
    const params = text('STOP');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('test-auth-token', url, params) }, body: new URLSearchParams(params) });
    assert.equal(r.status, 403, 'refused when Twilio isn’t set up, signed or not');
  } finally { await B.close(); }
});

test('after STOP no texts go out, even for a notification already on its way', async () => {
  const { A, inbound, alex } = await setUp();
  try {
    const mgr = jsonClient(A.base);
    await signIn(mgr.post, 'moe@demo.shiftboard');
    await A.settled();
    const before = A.twilio.calls.length; // the welcome text
    assert.equal(before, 1);
    assert.equal((await inbound(text('stop'))).status, 200);
    assert.equal((await alex()).smsConsent, false);
    const shift = { date: addDays(todayStr(), 20), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: 'usr_alexd', published: true };
    assert.equal((await mgr.post('/api/rpc/shifts.save', shift)).status, 200);
    await A.settled();
    assert.equal(A.twilio.calls.length, before, 'nothing after STOP');

    // START: texts again, but no new welcome (Twilio answers START itself).
    assert.equal((await inbound(text('START'))).status, 200);
    assert.equal((await mgr.post('/api/rpc/shifts.save', { ...shift, date: addDays(todayStr(), 21) })).status, 200);
    await A.settled();
    assert.equal(A.twilio.calls.length, before + 1);
    assert.match(A.twilio.texts().at(-1).Body, /New shift/);

    // A STOP that lands between picking the texts and sending them still wins: consent is checked right before
    // each send (deliver() syncs and re-checks), here with a text that was picked while texts were on.
    const channels = createChannels({ db: A.db, env: TWILIO_ENV, texter: createTexter(TWILIO_ENV, { fetchImpl: A.twilio.fetchImpl }), background: () => {}, appUrl: () => A.base, signedIn: () => null });
    await A.db.run((s) => s.update('users', 'usr_alexd', { smsConsent: false, smsStoppedAt: new Date().toISOString() }), { write: true });
    const r = await channels.deliver([], [{ userId: 'usr_alexd', to: PHONE, body: 'picked before the STOP' }]);
    assert.deepEqual([r.sent, r.skipped], [0, 1]);
    assert.equal(A.twilio.calls.length, before + 1);
  } finally { await A.close(); }
});
