// Consent gating: boxes start unticked, the terms are required, nobody gets a text without their own consent
// (notifications, the welcome text, the test text), every choice is a record with the exact words, the
// welcome text goes out once, notification emails need email consent, and older accounts keep what they had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { addDays, todayStr } from '../core/time.js';
import { CONSENT_TEXT, CONSENT_VERSION, WELCOME_TEXT, LEGAL_LINKS, legalLinks, migrateConsents, consentCsv, maskIp, termsParts, applyConsents, smsConsentOf } from '../core/consent.js';
import { smsAllowed } from '../core/notify-prefs.js';
import { consentBoxes, initialChoices, canSubmit, consentPayload } from '../web/src/consent-form.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';

const SMS_ON = { push: { enabled: false }, sms: { enabled: true } };
const WELCOME_EN = "ShiftBoard by DubLow Digital: You're subscribed to shift schedule alerts. Msg freq varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.";

async function person(A, email, headers = {}) {
  const c = jsonClient(A.base);
  const r = await signIn(c.post, email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...c, rpc: (m, args = {}, h = headers) => c.post(`/api/rpc/${m}`, args, h) };
}
const newShift = (mgr, userId, days = 20) => mgr.rpc('shifts.save', { date: addDays(todayStr(), days), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId, published: true });

// ---------- the wording and the screen's rules ----------

test('the exact wording: the owner’s SMS sentence and welcome text, Spanish keeps STOP and HELP, legal links', () => {
  assert.equal(CONSENT_TEXT.en.sms, 'I agree to receive shift schedule text messages from DubLow Digital through ShiftBoard. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help. Consent is not a condition of employment.');
  assert.equal(CONSENT_TEXT.en.terms, 'I agree to the Privacy Policy and Terms');
  assert.equal(WELCOME_TEXT.en, WELCOME_EN);
  assert.match(CONSENT_TEXT.es.sms, /Responde STOP para cancelar o HELP/);
  assert.match(WELCOME_TEXT.es, /Responde HELP para ayuda, STOP para cancelar\.$/);
  assert.deepEqual(LEGAL_LINKS, { privacy: 'https://dublowdigital.com/privacy-policy/', terms: 'https://dublowdigital.com/terms' });
  assert.deepEqual(legalLinks({ PRIVACY_URL: 'https://example.com/p', TERMS_URL: 'javascript:alert(1)' }), { privacy: 'https://example.com/p', terms: LEGAL_LINKS.terms }, 'only https addresses');
  assert.deepEqual(termsParts('en').map((p) => p.href || p.text), ['I agree to the ', LEGAL_LINKS.privacy, ' and ', LEGAL_LINKS.terms]);
  assert.deepEqual(termsParts('es', { privacy: 'https://x.example/p', terms: 'https://x.example/t' }).filter((p) => p.href).map((p) => [p.text, p.href]),
    [['Política de privacidad', 'https://x.example/p'], ['Términos', 'https://x.example/t']]);
  assert.equal(maskIp('203.0.113.77'), '203.0.113.x');
  assert.equal(maskIp('::ffff:198.51.100.9'), '198.51.100.x');
  assert.equal(maskIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3::/48');
});

test('the consent screen: every box starts unticked; terms required; texts need a number; only shown boxes are sent', () => {
  assert.deepEqual(initialChoices(), { terms: false, sms: false, email: false });
  const fresh = consentBoxes({ consent: {}, sms: true });
  assert.deepEqual(fresh.map((b) => [b.channel, b.show, b.required]), [['terms', true, true], ['sms', true, false], ['email', true, false]]);
  assert.ok(fresh.every((b) => !b.on), 'nothing is pre-ticked');
  assert.equal(canSubmit(initialChoices(), ''), false, 'the terms are required');
  assert.equal(canSubmit({ terms: true, sms: false, email: false }, ''), true);
  assert.equal(canSubmit({ terms: true, sms: true, email: false }, ''), false, 'texts need a mobile number');
  assert.equal(canSubmit({ terms: true, sms: true, email: false }, '(303) 555-0142'), true);
  assert.deepEqual(consentPayload(fresh, { terms: true, sms: false, email: true }), { terms: true, sms: false, email: true });
  // An older account with texts already on: no SMS box ("Texts are on — change this in My Shifts"), nothing sent for it.
  const older = consentBoxes({ consent: { sms: true, email: false }, sms: true });
  assert.deepEqual(older.map((b) => [b.channel, b.show, b.on]), [['terms', true, false], ['sms', false, true], ['email', true, false]]);
  assert.deepEqual(consentPayload(older, { terms: true, sms: true, email: false }), { terms: true, email: false });
  // Texts not set up at this restaurant: no SMS box.
  assert.equal(consentBoxes({ consent: {}, sms: false })[1].show, false);
});

test('core: consent must be exactly true; the terms are required; texts need a number and texts set up', () => {
  const store = new MemoryStore();
  seedDemo(store);
  const ctx = { lang: 'en', ip: '198.51.100.7', userAgent: 'test', source: 'onboarding', at: '2026-11-22T10:00:00.000Z', smsEnabled: true, requireTerms: true };
  for (const terms of [undefined, false, 'true', 1, 'on']) {
    assert.throws(() => applyConsents(store, 'usr_alexd', { terms, email: true }, ctx), /Privacy Policy and Terms/, String(terms));
  }
  assert.equal(store.list('consents').length, 0, 'nothing recorded when the terms are missing');
  assert.throws(() => applyConsents(store, 'usr_alexd', { terms: true, sms: true }, ctx), /mobile number/);
  assert.throws(() => applyConsents(store, 'usr_alexd', { terms: true, sms: true, phone: '3035550142' }, { ...ctx, smsEnabled: false }), /aren’t set up/);
  applyConsents(store, 'usr_alexd', { terms: true, sms: 'yes', email: 1 }, ctx);
  const u = store.get('users', 'usr_alexd');
  assert.equal(smsConsentOf(u), false, 'a truthy value that isn’t true is not consent');
  assert.notEqual(u.emailConsent, true);
  assert.deepEqual(store.list('consents').map((c) => c.channel), ['terms'], 'non-boolean answers record nothing');
});

test('core: people from before consent records keep what they had (migration, once), old fields retired', () => {
  const store = new MemoryStore();
  seedDemo(store);
  store.update('users', 'usr_alexd', { smsNotifications: true, smsPhone: '+13035550142', smsConsentAt: '2026-10-01T12:00:00.000Z' });
  store.update('users', 'usr_styves', { smsNotifications: false, smsPhone: '+13035550143', smsStoppedAt: '2026-10-02T12:00:00.000Z', emailNotifications: false });
  assert.equal(smsAllowed(store.get('users', 'usr_alexd'), {}), true, 'the old field is read as a fallback');
  const n = migrateConsents(store, { at: '2026-11-22T00:00:00.000Z' });
  assert.ok(n > 10);
  const alex = store.get('users', 'usr_alexd');
  const styves = store.get('users', 'usr_styves');
  assert.equal(alex.smsConsent, true);
  assert.equal('smsNotifications' in alex, false, 'the old field is gone');
  assert.equal(alex.smsWelcomedAt, '2026-10-01T12:00:00.000Z', 'they had the old welcome text: no new one');
  assert.equal(styves.smsConsent, false);
  assert.equal(styves.emailConsent, false, 'email copies off stays off');
  assert.equal(store.get('users', 'usr_moe').emailConsent, true, 'email copies were on by default');
  const recs = store.list('consents');
  assert.deepEqual(recs.map((c) => [c.userId, c.channel, c.granted, c.source, c.phone, c.at]), [['usr_alexd', 'sms', true, 'migration', '+13035550142', '2026-10-01T12:00:00.000Z']]);
  assert.equal(migrateConsents(store), 0, 'only once');
  assert.equal(store.list('consents').length, 1);
});

// ---------- the server ----------

test('no text without the person’s own consent: notifications, the welcome text and the test text', async () => {
  const A = await startApp();
  try {
    const mgr = await person(A, 'moe@demo.shiftboard');
    // Alex has a number on file but never agreed (smsConsent missing), Styves said no (false).
    await A.db.run((s) => {
      s.update('users', 'usr_alexd', { smsPhone: '+13035550142' });
      s.update('users', 'usr_styves', { smsPhone: '+13035550143', smsConsent: false });
    }, { write: true });
    assert.equal((await newShift(mgr, 'usr_alexd')).status, 200);
    assert.equal((await newShift(mgr, 'usr_styves')).status, 200);
    await A.settled();
    assert.equal(A.twilio.calls.length, 0, 'no notification texts');
    // The test text: the admin's own number, only after they agreed to texts on it.
    assert.equal((await mgr.post('/api/sms/test', { phone: '(720) 555-0101' })).status, 400);
    assert.equal(A.twilio.calls.length, 0, 'no test text');
    // No welcome text without consent either (the box unticked = false).
    assert.equal((await mgr.rpc('sms.preferences', { on: true, phone: '7205550101' })).status, 400);
    assert.equal((await mgr.rpc('consent.accept', { terms: true, sms: false, email: false })).status, 200);
    await A.settled();
    assert.equal(A.twilio.calls.length, 0, 'nothing at all was texted');
  } finally { await A.close(); }
});

test('consent records: timestamp, version, IP, user agent, user id, the exact words; terms keep the links shown', async () => {
  const A = await startApp({ env: { PRIVACY_URL: 'https://dublowdigital.com/privacy-policy/', TERMS_URL: 'https://dublowdigital.com/terms-v2' } });
  try {
    const cfg = await (await fetch(`${A.base}/api/config`)).json();
    assert.deepEqual(cfg.legal, { privacy: 'https://dublowdigital.com/privacy-policy/', terms: 'https://dublowdigital.com/terms-v2' });
    const alex = await person(A, 'alexd@demo.shiftboard', { 'X-Forwarded-For': '203.0.113.77', 'User-Agent': 'TestPhone/1.0' });
    const boot = (await alex.rpc('app.bootstrap')).body.result;
    assert.equal(boot.me.needsTerms, true, 'the one-time consent screen');
    assert.equal((await alex.rpc('consent.accept', { sms: false, email: true })).status, 400, 'the terms are required');
    const r = await alex.rpc('consent.accept', { terms: true, sms: true, phone: '(303) 555-0142', email: false, lang: 'es' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.result, { terms: true, sms: true, email: false, smsStatus: 'on' });
    assert.equal((await alex.rpc('app.bootstrap')).body.result.me.needsTerms, false);
    await A.db.sync();
    const recs = A.db.store.list('consents', (c) => c.userId === 'usr_alexd').sort((a, b) => a.channel.localeCompare(b.channel));
    assert.deepEqual(recs.map((c) => [c.channel, c.granted]), [['email', false], ['sms', true], ['terms', true]]);
    for (const c of recs) {
      assert.equal(c.ip, '203.0.113.77');
      assert.equal(c.userAgent, 'TestPhone/1.0');
      assert.equal(c.lang, 'es');
      assert.equal(c.source, 'onboarding');
      assert.equal(c.version, CONSENT_VERSION[c.channel]);
      assert.equal(c.text, CONSENT_TEXT.es[c.channel], 'the Spanish words they saw');
      assert.ok(Date.parse(c.at) > Date.now() - 60_000);
    }
    assert.equal(recs.find((c) => c.channel === 'sms').phone, '+13035550142');
    assert.deepEqual(recs.find((c) => c.channel === 'terms').links, cfg.legal);
    // Turning texts off in My Shifts is a record too (source settings).
    await alex.rpc('sms.preferences', { on: false });
    await A.db.sync();
    const off = A.db.store.list('consents', (c) => c.userId === 'usr_alexd' && c.channel === 'sms' && c.source === 'settings');
    assert.equal(off.length, 1);
    assert.equal(off[0].granted, false);
    // The admin's CSV: every record, the IP masked, never the full address.
    const moe = await person(A, 'moe@demo.shiftboard');
    const csv = await fetch(`${A.base}/api/consents.csv`, { headers: { Cookie: moe.cookie() } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="consent-log-/);
    const text = await csv.text();
    assert.match(text, /203\.0\.113\.x/);
    assert.doesNotMatch(text, /203\.0\.113\.77/);
    assert.ok(text.includes('Dar tu consentimiento no es una condición para tu empleo.'));
    assert.equal((await fetch(`${A.base}/api/consents.csv`, { headers: { Cookie: alex.cookie() } })).status, 403, 'admins only');
    assert.equal(consentCsv(new MemoryStore()).trim(), 'at,user_id,name,email,channel,granted,source,version,lang,phone,ip_masked,user_agent,text,links');
  } finally { await A.close(); }
});

test('the welcome text: exactly once, on the first opt-in ever (not on re-opt-in, not on START), in their language', async () => {
  const A = await startApp();
  try {
    const alex = await person(A, 'alexd@demo.shiftboard');
    const opt = (on) => alex.rpc('sms.preferences', on ? { on: true, phone: '(303) 555-0142', consent: true } : { on: false });
    assert.equal((await opt(true)).status, 200);
    await A.settled();
    assert.deepEqual(A.twilio.texts().map((t) => [t.To, t.Body]), [['+13035550142', WELCOME_EN]]);
    await opt(false);
    await opt(true);
    await A.settled();
    assert.equal(A.twilio.calls.length, 1, 'no second welcome after opting in again');
    // Someone in Spanish gets the Spanish welcome.
    const styves = await person(A, 'styves@demo.shiftboard');
    await styves.rpc('account.preferences', { language: 'es' });
    await styves.rpc('consent.accept', { terms: true, sms: true, phone: '3035550143' });
    await A.settled();
    assert.equal(A.twilio.texts().at(-1).Body, WELCOME_TEXT.es);
    assert.equal(A.twilio.calls.length, 2);
  } finally { await A.close(); }
});

test('notification emails need email consent; account emails (invites, resets) always go out', async () => {
  const A = await startApp();
  try {
    await A.db.run((s) => { s.update('users', 'usr_styves', { email: 'styves@rabbits.co' }); s.update('users', 'usr_victor', { email: 'victor@rabbits.co' }); }, { write: true });
    const mgr = await person(A, 'moe@demo.shiftboard');
    const victor = await person(A, 'victor@rabbits.co');
    assert.equal((await victor.rpc('account.preferences', { emailConsent: false })).status, 200);
    await newShift(mgr, 'usr_styves');
    await newShift(mgr, 'usr_victor');
    await A.settled();
    assert.deepEqual(A.resend.emails().map((m) => m.to[0]), ['styves@rabbits.co'], 'Victor said no');
    // A new person hasn't agreed yet: no notification emails, but the invitation itself goes out.
    const added = await mgr.rpc('employees.save', { name: 'Nora New', email: 'nora@rabbits.co', role: 'employee', invite: true });
    assert.equal(added.body.result.invited, true);
    assert.equal(added.body.result.emailConsent, false);
    await newShift(mgr, added.body.result.id, 21);
    await A.settled();
    const toNora = A.resend.emails().filter((m) => m.to[0] === 'nora@rabbits.co');
    assert.deepEqual(toNora.map((m) => m.subject), ['Set up your Our Restaurant schedule account'], 'only the invitation');
    // Turning them back on is a consent record.
    assert.equal((await victor.rpc('account.preferences', { emailConsent: true })).status, 200);
    await A.db.sync();
    assert.deepEqual(A.db.store.list('consents', (c) => c.userId === 'usr_victor').map((c) => [c.channel, c.granted, c.source]), [['email', false, 'settings'], ['email', true, 'settings']]);
  } finally { await A.close(); }
});
