// The invite flow: a manager adds an employee → the invitation is emailed (never texted) → the link works once
// and expires → the wizard needs a password, a second step and the terms → after that the person signs in only
// with the second step. Partial progress survives a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, stepAt } from '../server/totp.js';
import { CONSENT_TEXT } from '../core/consent.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn, secondStep, nextCode, onboard } from './helpers/signin.js';
import { softPasskey } from './helpers/webauthn.js';

const tokenIn = (mail) => /#\/welcome\?token=([\w-]+)/.exec(mail.text)?.[1];

async function managerAdds(A, person) {
  const mgr = jsonClient(A.base);
  assert.equal((await signIn(mgr.post, 'moe@demo.shiftboard')).status, 200);
  const r = await mgr.post('/api/rpc/employees.save', { role: 'employee', invite: true, ...person });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { mgr, added: r.body.result };
}

test('add employee → invitation by email only → wizard (password, second step, terms) → signed in', async () => {
  const A = await startApp();
  try {
    const { mgr, added } = await managerAdds(A, { name: 'Nora Diaz', email: 'nora@rabbits.co' });
    assert.equal(added.invited, true);
    assert.equal(added.tempPassword, undefined, 'no temporary password: the wizard sets it');
    assert.equal(added.hasPassword, false);
    const mail = A.resend.emails().find((m) => m.to[0] === 'nora@rabbits.co');
    assert.equal(mail.subject, 'Set up your Our Restaurant schedule account');
    assert.match(mail.text, /This link works for 7 days and can be used once/);
    const token = tokenIn(mail);
    assert.ok(token);
    await A.settled();
    assert.equal(A.twilio.calls.length, 0, 'no text before consent, and invitations are never texted');
    // Team shows them as invited.
    const team = (await mgr.post('/api/rpc/app.bootstrap')).body.result.employees.find((e) => e.id === added.id);
    assert.ok(team.invitedAt);
    assert.deepEqual([team.twoStep, team.smsStatus, team.emailConsent], [false, 'off', false]);
    // Before the wizard is done there's no way in.
    assert.equal((await jsonClient(A.base).post('/api/auth/login', { email: 'nora@rabbits.co', password: '' })).status, 401);

    const nora = jsonClient(A.base);
    assert.equal((await nora.post('/api/onboarding/start', { token: 'not-a-real-token' })).status, 400);
    const start = await nora.post('/api/onboarding/start', { token });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.deepEqual(start.body.result.steps, { password: false, factor: null, recoverySaved: false, profile: false });
    assert.equal(start.body.result.sms, true);
    // Each step is required, in order.
    assert.equal((await nora.post('/api/onboarding/complete', { terms: true })).status, 400, 'no password yet');
    assert.equal((await nora.post('/api/onboarding/totp/setup', {})).status, 400, 'the password comes first');
    assert.match((await nora.post('/api/onboarding/password', { password: 'short' })).body.error, /at least 10/);
    assert.match((await nora.post('/api/onboarding/password', { password: 'nora-diaz-2026' })).body.error, /name or email/);
    assert.equal((await nora.post('/api/onboarding/password', { password: 'blue-harbor-lantern' })).status, 200);
    assert.match((await nora.post('/api/onboarding/complete', { terms: true })).body.error, /authenticator app or a passkey/);
    const setup = (await nora.post('/api/onboarding/totp/setup', {})).body.result;
    assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\/ShiftBoard:nora%40rabbits\.co\?secret=[A-Z2-7]{32}&issuer=ShiftBoard&algorithm=SHA1&digits=6&period=30$/);
    assert.equal((await nora.post('/api/onboarding/totp/confirm', { code: '000000' })).status, 401);
    const step = stepAt(Date.now());
    const conf = await nora.post('/api/onboarding/totp/confirm', { code: hotp(setup.secret, step) });
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.equal(conf.body.result.recoveryCodes.length, 10);
    assert.match((await nora.post('/api/onboarding/complete', { terms: true })).body.error, /recovery codes/);
    assert.equal((await nora.post('/api/onboarding/recovery/ack', {})).status, 400, '“I saved these” is required');

    // A reload (a new tab, no cookie): the same link picks up where it was.
    const again = jsonClient(A.base);
    const resumed = (await again.post('/api/onboarding/start', { token })).body.result;
    assert.deepEqual(resumed.steps, { password: true, factor: 'totp', recoverySaved: false, profile: false });
    const fresh = (await again.post('/api/onboarding/recovery/regenerate', {})).body.result.recoveryCodes;
    assert.equal(fresh.length, 10, 'codes shown again after a reload (new ones)');
    assert.equal((await again.post('/api/onboarding/recovery/ack', { saved: true })).status, 200);
    assert.equal((await again.post('/api/onboarding/profile', { name: 'Nora Díaz', phone: '(303) 555-0144' })).status, 200);
    // The pending password and app don't sign anyone in before the wizard is done.
    assert.equal((await jsonClient(A.base).post('/api/auth/login', { email: 'nora@rabbits.co', password: 'blue-harbor-lantern' })).status, 401);

    // Consent: the terms box is required and must be exactly true.
    for (const terms of [undefined, false, 'true']) assert.equal((await again.post('/api/onboarding/complete', { terms, email: true })).status, 400, String(terms));
    const done = await again.post('/api/onboarding/complete', { terms: true, sms: true, email: false, lang: 'en' }, { 'X-Forwarded-For': '198.51.100.23' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const me = (await again.post('/api/rpc/app.bootstrap')).body.result.me;
    assert.deepEqual([me.name, me.phone, me.smsConsent, me.smsPhone, me.emailConsent, me.needsTerms, me.security.on], ['Nora Díaz', '(303) 555-0144', true, '+13035550144', false, false, true]);
    await A.db.sync();
    const recs = A.db.store.list('consents', (c) => c.userId === added.id);
    assert.deepEqual(recs.map((c) => [c.channel, c.granted, c.source, c.ip]).sort(), [['email', false, 'onboarding', '198.51.100.23'], ['sms', true, 'onboarding', '198.51.100.23'], ['terms', true, 'onboarding', '198.51.100.23']]);
    assert.equal(recs.find((c) => c.channel === 'sms').text, CONSENT_TEXT.en.sms);
    // The one welcome text, after consent.
    await A.settled();
    assert.deepEqual(A.twilio.texts().map((t) => t.To), ['+13035550144']);

    // The link is used up.
    assert.equal((await jsonClient(A.base).post('/api/onboarding/start', { token })).status, 400);
    // From now on: the password alone never signs in; the second step does.
    const later = jsonClient(A.base);
    const first = await later.post('/api/auth/login', { email: 'nora@rabbits.co', password: 'blue-harbor-lantern' });
    assert.equal(first.status, 200);
    assert.equal(first.body.mfa, 'verify');
    assert.deepEqual(first.body.methods, ['totp', 'recovery']);
    assert.equal((await later.post('/api/rpc/app.bootstrap')).status, 401, 'no session yet');
    assert.equal((await later.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'totp', code: hotp(setup.secret, step) })).status, 401, 'the code used in the wizard can’t be used again');
    assert.equal((await later.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'recovery', code: conf.body.result.recoveryCodes[0] })).status, 401, 'codes replaced after the reload no longer work');
    assert.equal((await later.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'recovery', code: fresh[0] })).status, 200);
    assert.equal((await later.post('/api/rpc/app.bootstrap')).status, 200);
    // Team: joined, two-step on, texts on.
    const row = (await mgr.post('/api/rpc/app.bootstrap')).body.result.employees.find((e) => e.id === added.id);
    assert.deepEqual([!!row.onboardedAt, row.twoStep, row.smsStatus], [true, true, 'on']);
  } finally { await A.close(); }
});

test('the invitation expires after 7 days, a newer one replaces older progress, and without email nothing is sent', async () => {
  const A = await startApp();
  try {
    const { mgr, added } = await managerAdds(A, { name: 'Omar Reyes', email: 'omar@rabbits.co' });
    const token = tokenIn(A.resend.emails().find((m) => m.to[0] === 'omar@rabbits.co'));
    const { rows } = await A.db.query(`SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS secs FROM shiftboard.auth_tokens WHERE purpose = 'invite' AND user_id = $1`, [added.id]);
    assert.equal(Number(rows[0].secs), 7 * 24 * 3600, 'an invitation lasts 7 days');
    const omar = jsonClient(A.base);
    assert.equal((await omar.post('/api/onboarding/start', { token })).status, 200);
    assert.equal((await omar.post('/api/onboarding/password', { password: 'green-valley-road' })).status, 200);
    // Expired: the link and the wizard both stop working.
    await A.db.query(`UPDATE shiftboard.auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [added.id]);
    assert.equal((await omar.post('/api/onboarding/state', {})).status, 400);
    assert.equal((await jsonClient(A.base).post('/api/onboarding/start', { token })).status, 400);
    // The manager resends: a new link starts over.
    assert.equal((await mgr.post(`/api/users/${added.id}/invite`)).status, 200);
    const token2 = tokenIn(A.resend.emails().filter((m) => m.to[0] === 'omar@rabbits.co').at(-1));
    assert.notEqual(token2, token);
    const st = (await omar.post('/api/onboarding/start', { token: token2 })).body.result;
    assert.equal(st.steps.password, false, 'progress from the old link is dropped');
    // Passkey instead of an app works for the second step too.
    assert.equal((await omar.post('/api/onboarding/password', { password: 'green-valley-road' })).status, 200);
    const key = softPasskey();
    const { options } = (await omar.post('/api/onboarding/passkey/options', {})).body.result;
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    const reg = await omar.post('/api/onboarding/passkey/verify', { response: key.register(options, A.base), name: 'Omar’s phone' });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.equal(reg.body.result.steps.factor, 'passkey');
    await omar.post('/api/onboarding/recovery/ack', { saved: true });
    assert.equal((await omar.post('/api/onboarding/complete', { terms: true, sms: false, email: false })).status, 200);
    await A.settled();
    assert.equal(A.twilio.calls.length, 0, 'no texts: they didn’t tick texts');
  } finally { await A.close(); }

  const B = await startApp({ email: false });
  try {
    const { added } = await managerAdds(B, { name: 'Pia Lane', email: 'pia@rabbits.co' });
    assert.equal(added.invited, false);
    assert.match(added.inviteError, /Email isn’t set up yet, so no invitation went out/);
    assert.equal(B.resend.calls.length, 0);
    await B.settled();
    assert.equal(B.twilio.calls.length, 0, 'never a text instead');
  } finally { await B.close(); }
});

test('the helper’s full wizard: owner-style accept, then sign-in with the second step', async () => {
  const A = await startApp();
  try {
    await managerAdds(A, { name: 'Quinn Park', email: 'quinn@rabbits.co' });
    const q = jsonClient(A.base);
    const token = tokenIn(A.resend.emails().find((m) => m.to[0] === 'quinn@rabbits.co'));
    assert.equal((await onboard(q.post, token, { password: 'silver-maple-street', consent: { email: true } })).status, 200);
    const back = jsonClient(A.base);
    const first = await back.post('/api/auth/login', { email: 'quinn@rabbits.co', password: 'silver-maple-street' });
    assert.equal(first.body.mfa, 'verify');
    const code = nextCode('quinn@rabbits.co');
    assert.equal((await back.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'totp', code })).status, 200);
    const s = await secondStep(back.post, await back.post('/api/auth/login', { email: 'quinn@rabbits.co', password: 'silver-maple-street' }), { email: 'quinn@rabbits.co' });
    assert.equal(s.status, 200);
  } finally { await A.close(); }
});
