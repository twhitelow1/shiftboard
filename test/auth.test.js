// Two-step sign-in: TOTP (RFC 6238, the ±1 window, no reuse), rate limits, recovery codes, setting up a second
// step at the first sign-in, password reset going through the second step, email sign-in links, passkeys (a
// software ES256 authenticator), the phone app's tokens, a manager's reset, and no secret ever in a response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hotp, totpAt, verifyTotp, stepAt, base32Encode, base32Decode, generateSecret } from '../server/totp.js';
import { createSecretBox } from '../server/secret-box.js';
import { passwordProblem } from '../core/auth-factors.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn, secondStep, nextCode, authenticatorOf } from './helpers/signin.js';
import { softPasskey } from './helpers/webauthn.js';

const decode = (jwtText) => JSON.parse(Buffer.from(String(jwtText).split('.')[1], 'base64url'));
async function signedIn(A, email, opts = {}) {
  const c = jsonClient(A.base);
  const r = await signIn(c.post, email, 'demo1234', opts);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...c, first: r, rpc: (m, a = {}) => c.post(`/api/rpc/${m}`, a), get: (p) => fetch(A.base + p, { headers: { Cookie: c.cookie() } }) };
}

// ---------- TOTP ----------

test('TOTP: RFC 6238 test vectors (SHA-1), base32, the ±1 step window and no reuse', () => {
  const key = Buffer.from('12345678901234567890');
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(hotp(key, Math.floor(t / 30)), code, `T=${t}`);
  }
  const secret = base32Encode(key);
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(secret), key);
  assert.equal(totpAt(secret, 59_000), '287082');
  assert.match(generateSecret(), /^[A-Z2-7]{32}$/);

  const now = 1_800_000_000_000;
  const step = stepAt(now);
  assert.equal(verifyTotp(secret, hotp(secret, step), { now }), step);
  assert.equal(verifyTotp(secret, hotp(secret, step - 1), { now }), step - 1, 'one step early (clock drift)');
  assert.equal(verifyTotp(secret, hotp(secret, step + 1), { now }), step + 1, 'one step late');
  assert.equal(verifyTotp(secret, hotp(secret, step - 2), { now }), null);
  assert.equal(verifyTotp(secret, hotp(secret, step + 2), { now }), null);
  assert.equal(verifyTotp(secret, hotp(secret, step), { now, afterStep: step }), null, 'a code already used in this step');
  assert.equal(verifyTotp(secret, hotp(secret, step - 1), { now, afterStep: step }), null, 'nor an older one');
  assert.equal(verifyTotp(secret, ` ${hotp(secret, step).slice(0, 3)} ${hotp(secret, step).slice(3)} `, { now }), step, 'spaces are fine');
  for (const bad of ['', '12345', '1234567', 'abcdef', null]) assert.equal(verifyTotp(secret, bad, { now }), null);
});

test('secrets at rest: sealed with PLATFORM_ENCRYPTION_KEY, else a key derived from the session secret; bound to their context', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const platform = createSecretBox({ env: { PLATFORM_ENCRYPTION_KEY: key }, sessionSecret: () => 's', scope: 'shiftboard' });
  const single = createSecretBox({ env: {}, sessionSecret: () => 'session-secret-1', scope: 'shiftboard' });
  assert.equal(platform.kind, 'platform');
  assert.equal(single.kind, 'session');
  const a = platform.seal('JBSWY3DPEHPK3PXP', 'totp:usr_1');
  const b = single.seal('JBSWY3DPEHPK3PXP', 'totp:usr_1');
  assert.match(a, /^k1\.v1\./);
  assert.match(b, /^s1\.v1\./);
  assert.ok(!a.includes('JBSWY3DPEHPK3PXP') && !b.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(platform.open(a, 'totp:usr_1'), 'JBSWY3DPEHPK3PXP');
  assert.equal(single.open(b, 'totp:usr_1'), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => platform.open(a, 'totp:usr_2'), 'another person’s context');
  assert.throws(() => createSecretBox({ env: {}, sessionSecret: () => 'other', scope: 'shiftboard' }).open(b, 'totp:usr_1'));
  // Adding the platform key later keeps older values readable.
  const both = createSecretBox({ env: { PLATFORM_ENCRYPTION_KEY: key }, sessionSecret: () => 'session-secret-1', scope: 'shiftboard' });
  assert.equal(both.open(b, 'totp:usr_1'), 'JBSWY3DPEHPK3PXP');
});

test('passwords: at least 10 characters, not the name or email, not a common one', () => {
  assert.match(passwordProblem('short', {}), /at least 10/);
  assert.match(passwordProblem('ana.lopez-123', { email: 'ana.lopez@rabbits.co', name: 'Ana López' }), /name or email/);
  assert.match(passwordProblem('Password123', {}), /too common/);
  assert.match(passwordProblem('aaaaaaaaaaaa', {}), /too common/);
  assert.equal(passwordProblem('blue-harbor-lantern', { email: 'ana@rabbits.co', name: 'Ana López' }), null);
});

// ---------- the sign-in flow ----------

test('first sign-in sets up the second step before any session; tickets are 10 minutes and never sessions', async () => {
  const A = await startApp();
  try {
    const c = jsonClient(A.base);
    assert.equal((await c.post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'wrong' })).status, 401);
    const first = await c.post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' });
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['mfa', 'ticket']);
    assert.equal(first.body.mfa, 'enroll');
    assert.equal(first.headers.get('set-cookie'), null, 'no session from the password alone');
    const claims = decode(first.body.ticket);
    assert.deepEqual([claims.p, claims.k, claims.sub, claims.v, claims.exp - claims.iat], ['mfa', 'enroll', 'usr_alexd', 0, 600]);
    // A ticket is not a session, as a cookie or a bearer token.
    assert.equal((await fetch(`${A.base}/api/rpc/app.bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${first.body.ticket}` } })).status, 401);
    assert.equal((await fetch(`${A.base}/api/rpc/app.bootstrap`, { method: 'POST', headers: { Cookie: `sb_session=${first.body.ticket}` } })).status, 401);
    // An enroll ticket can't be used to sign in, only to set something up.
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'totp', code: '123456' })).status, 401);
    const setup = await c.post('/api/auth/mfa/totp/setup', { ticket: first.body.ticket });
    assert.equal(setup.status, 200);
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
    assert.equal((await c.post('/api/auth/mfa/totp/confirm', { ticket: first.body.ticket, code: '000000' })).status, 401);
    const step = stepAt(Date.now());
    const conf = await c.post('/api/auth/mfa/totp/confirm', { ticket: first.body.ticket, code: hotp(setup.body.secret, step) });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.recoveryCodes.length, 10);
    assert.ok(conf.body.recoveryCodes.every((x) => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(x)));
    assert.match(conf.headers.get('set-cookie'), /sb_session=/);
    assert.equal((await c.post('/api/rpc/app.bootstrap')).status, 200);
    // Now there's a second step: the old enroll ticket can't add another app.
    assert.equal((await c.post('/api/auth/mfa/totp/setup', { ticket: first.body.ticket })).status, 403);
    const again = await c.post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' });
    assert.deepEqual([again.body.mfa, again.body.methods], ['verify', ['totp', 'recovery']]);
    assert.equal((await c.post('/api/auth/mfa/totp/setup', { ticket: again.body.ticket })).status, 403, 'a verify ticket can’t set up a factor');
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: again.body.ticket, method: 'totp', code: hotp(setup.body.secret, step) })).status, 401, 'the same code twice');
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: again.body.ticket, method: 'totp', code: hotp(setup.body.secret, step + 1) })).status, 200, 'the next step’s code (±1 window)');
    // A password change invalidates tickets made before it.
    const t3 = await c.post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' });
    assert.equal((await c.post('/api/rpc/employees.changePassword', { password: 'brand-new-passphrase' })).status, 200);
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: t3.body.ticket, method: 'recovery', code: conf.body.recoveryCodes[0] })).status, 401);
  } finally { await A.close(); }
});

test('rate limits: 5 wrong codes per ticket and per person in 15 minutes; recovery codes work once', async () => {
  const A = await startApp();
  try {
    const alex = await signedIn(A, 'alexd@demo.shiftboard');
    const codes = alex.first.body.recoveryCodes;
    const c = jsonClient(A.base);
    const login = () => c.post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' });
    // Recovery codes: once each, any case and spacing.
    let t = (await login()).body.ticket;
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: t, method: 'recovery', code: codes[0].toLowerCase().replace('-', ' ') })).status, 200);
    t = (await login()).body.ticket;
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: t, method: 'recovery', code: codes[0] })).status, 401, 'used already');
    assert.equal((await c.post('/api/rpc/app.bootstrap')).status, 200);
    await A.db.sync();
    const sec = await alex.get('/api/auth/security');
    assert.equal((await sec.json()).result.twoStep.recoveryLeft, 9);
    // Wrong codes: four more on this ticket (one above), then the fifth; then even a right code is refused.
    for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/auth/mfa/verify', { ticket: t, method: 'totp', code: '000000' })).status, 401);
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: t, method: 'totp', code: nextCode('alexd@demo.shiftboard') })).status, 429);
    // A new ticket doesn't reset it: the limit is per person too.
    const t2 = (await login()).body.ticket;
    assert.equal((await c.post('/api/auth/mfa/verify', { ticket: t2, method: 'recovery', code: codes[1] })).status, 429);
    // Other people are unaffected.
    assert.equal((await signIn(jsonClient(A.base).post, 'styves@demo.shiftboard')).status, 200);
  } finally { await A.close(); }
});

test('password reset goes through the second step; existing sessions elsewhere end, this one never starts without it', async () => {
  const A = await startApp();
  try {
    await A.db.run((s) => s.update('users', 'usr_styves', { email: 'styves@rabbits.co' }), { write: true });
    const old = await signedIn(A, 'styves@rabbits.co');
    const anon = jsonClient(A.base);
    await anon.post('/api/auth/forgot', { email: 'styves@rabbits.co' });
    await A.settled();
    const token = /#\/reset\?token=([\w-]+)/.exec(A.resend.emails().at(-1).text)[1];
    const r = await anon.post('/api/auth/reset', { token, password: 'quiet-river-stone' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.mfa, r.body.methods], ['verify', ['totp', 'recovery']]);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal((await anon.post('/api/rpc/app.bootstrap')).status, 401, 'not signed in by the reset');
    assert.equal((await old.rpc('app.bootstrap')).status, 401, 'other sessions end with the new password');
    assert.equal((await secondStep(anon.post, r, { email: 'styves@rabbits.co' })).status, 200);
    assert.equal((await anon.post('/api/rpc/app.bootstrap')).status, 200);
  } finally { await A.close(); }
});

test('email sign-in link: needs a current authenticator code, same answer for everyone, once, 15 minutes, rate-limited', async () => {
  const A = await startApp();
  try {
    await A.db.run((s) => s.update('users', 'usr_victor', { email: 'victor@rabbits.co' }), { write: true });
    await signedIn(A, 'victor@rabbits.co'); // sets up the app
    const anon = jsonClient(A.base);
    const sent = () => A.resend.emails().filter((m) => /sign-in link/.test(m.subject));
    assert.deepEqual((await anon.post('/api/auth/link', { email: 'nobody@rabbits.co', code: '123456' })).body, { ok: true });
    assert.deepEqual((await anon.post('/api/auth/link', { email: 'victor@rabbits.co', code: '000000' })).body, { ok: true });
    await A.settled();
    assert.equal(sent().length, 0, 'no account, or a wrong code: nothing is sent, and the answer is the same');
    const v = authenticatorOf('victor@rabbits.co');
    const code = nextCode('victor@rabbits.co');
    assert.deepEqual((await anon.post('/api/auth/link', { email: 'Victor@Rabbits.co', code })).body, { ok: true });
    await A.settled();
    assert.equal(sent().length, 1);
    const mail = sent()[0];
    assert.equal(mail.subject, 'Your Our Restaurant ShiftBoard sign-in link');
    const token = /#\/link\?token=([\w-]+)/.exec(mail.text)[1];
    // The code it used can't be used again for a password sign-in.
    const first = await anon.post('/api/auth/login', { email: 'victor@rabbits.co', password: 'demo1234' });
    assert.equal((await anon.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'totp', code })).status, 401);
    assert.ok(v.lastStep >= stepAt(Date.now()));
    // The link signs in once.
    const phone = jsonClient(A.base);
    const used = await phone.post('/api/auth/link/consume', { token, client: 'mobile' });
    assert.equal(used.status, 200);
    assert.ok(used.body.token, 'the phone app gets a token');
    assert.equal((await jsonClient(A.base).post('/api/auth/link/consume', { token })).status, 400, 'single use');
    // Expired after 15 minutes.
    await anon.post('/api/auth/link', { email: 'victor@rabbits.co', code: nextCode('victor@rabbits.co') });
    await A.settled();
    const t2 = /#\/link\?token=([\w-]+)/.exec(sent().at(-1).text)[1];
    const { rows } = await A.db.query(`SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS secs FROM shiftboard.auth_tokens WHERE purpose = 'signin-link' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(Number(rows[0].secs), 15 * 60);
    await A.db.query(`UPDATE shiftboard.auth_tokens SET expires_at = now() - interval '1 second' WHERE purpose = 'signin-link'`);
    assert.equal((await jsonClient(A.base).post('/api/auth/link/consume', { token: t2 })).status, 400, 'expired');
    // Rate limit per IP + email: 5 requests (3 above for Victor), then 429.
    await anon.post('/api/auth/link', { email: 'victor@rabbits.co', code: '111111' });
    await anon.post('/api/auth/link', { email: 'victor@rabbits.co', code: '111111' });
    assert.equal((await anon.post('/api/auth/link', { email: 'victor@rabbits.co', code: '111111' })).status, 429);
  } finally { await A.close(); }
});

test('passkeys: add one signed in, sign in without a password (user verification required), each challenge once', async () => {
  const A = await startApp();
  try {
    const alex = await signedIn(A, 'alexd@demo.shiftboard');
    const key = softPasskey();
    const { options } = (await alex.post('/api/auth/passkey/register/options', {})).body;
    assert.equal(options.rp.id, '127.0.0.1');
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.notEqual(options.user.id, Buffer.from('usr_alexd').toString('base64url'), 'not the internal id');
    const reg = await alex.post('/api/auth/passkey/register/verify', { response: key.register(options, A.base), name: '' });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.deepEqual(Object.keys(reg.body.passkey).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'type']);
    assert.equal(reg.body.passkey.name, 'Passkey', 'named after the device (Node’s fetch has no phone in its user agent)');
    assert.deepEqual(reg.body.recoveryCodes, [], 'they already have recovery codes');
    // The same registration again (replayed challenge) is refused.
    assert.equal((await alex.post('/api/auth/passkey/register/verify', { response: key.register(options, A.base) })).status, 400);

    const signInWithKey = async (sign, client) => {
      const c = jsonClient(A.base);
      const o = (await c.post('/api/auth/passkey/login/options', { email: 'alexd@demo.shiftboard' })).body.options;
      assert.deepEqual(o.allowCredentials || [], [], 'discoverable: the answer doesn’t depend on the email');
      assert.equal(o.userVerification, 'required');
      const response = sign(o);
      return { c, o, response, r: await c.post('/api/auth/passkey/login/verify', { response, ...(client ? { client } : {}) }) };
    };
    const ok = await signInWithKey((o) => key.sign(o, A.base));
    assert.equal(ok.r.status, 200, JSON.stringify(ok.r.body));
    assert.equal((await ok.c.post('/api/rpc/app.bootstrap')).body.result.me.id, 'usr_alexd');
    assert.equal((await ok.c.post('/api/auth/passkey/login/verify', { response: ok.response })).status, 401, 'an assertion works once');
    assert.equal((await signInWithKey((o) => key.sign(o, A.base, { verified: false }))).r.status, 401, 'user verification is required');
    assert.equal((await signInWithKey((o) => key.sign(o, 'https://evil.example'))).r.status, 401, 'another origin');
    assert.equal((await signInWithKey((o) => key.sign(o, A.base, { rpId: 'evil.example' }))).r.status, 401, 'another RP ID');
    assert.equal((await signInWithKey((o) => softPasskey().sign(o, A.base))).r.status, 401, 'an unknown passkey');
    const mobile = await signInWithKey((o) => key.sign(o, A.base), 'mobile');
    assert.equal(mobile.r.status, 200);
    assert.equal(decode(mobile.r.body.token).sub, 'usr_alexd');
    assert.equal(mobile.r.body.expiresIn, 30 * 24 * 3600);

    // My settings: rename, and never remove the last way in.
    const sec = async () => (await (await alex.get('/api/auth/security')).json()).result;
    const pk = (await sec()).factors.find((f) => f.type === 'passkey');
    assert.equal((await alex.post('/api/auth/passkey/rename', { id: pk.id, name: 'Work phone' })).status, 200);
    assert.equal((await sec()).factors.find((f) => f.type === 'passkey').name, 'Work phone');
    assert.equal((await alex.post('/api/auth/mfa/totp/remove', {})).status, 200, 'the passkey is still there');
    assert.equal((await alex.post('/api/auth/passkey/remove', { id: pk.id })).status, 400, 'the last second step stays');
    const login = await jsonClient(A.base).post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' });
    assert.deepEqual(login.body.methods, ['recovery', 'passkey']);
    const fresh = await alex.post('/api/auth/mfa/recovery/regenerate', {});
    assert.equal(fresh.body.result.recoveryCodes.length, 10);
    assert.equal(fresh.body.result.twoStep.recoveryLeft, 10);
  } finally { await A.close(); }
});

test('a manager resets someone’s second step: sessions end, a security notice, the audit log, set up again at sign-in', async () => {
  const A = await startApp();
  try {
    await A.db.run((s) => s.update('users', 'usr_alexd', { email: 'alex@rabbits.co' }), { write: true });
    const alex = await signedIn(A, 'alex@rabbits.co');
    const kelly = await signedIn(A, 'kelly@demo.shiftboard'); // a manager
    const styves = await signedIn(A, 'styves@demo.shiftboard');
    assert.equal((await styves.post('/api/users/usr_alexd/reset-2fa', {})).status, 403, 'employees can’t');
    assert.equal((await kelly.post('/api/users/usr_moe/reset-2fa', {})).status, 403, 'not someone above them');
    assert.equal((await kelly.post('/api/users/usr_kelly/reset-2fa', {})).status, 400, 'not themselves');
    const r = await kelly.post('/api/users/usr_alexd/reset-2fa', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.result.emailed, true);
    assert.equal((await alex.rpc('app.bootstrap')).status, 401, 'signed out everywhere');
    await A.settled();
    const notice = A.resend.emails().at(-1);
    assert.equal(notice.to[0], 'alex@rabbits.co');
    assert.match(notice.text, /Kelly.* reset the second step/);
    await A.db.sync();
    const log = A.db.store.list('auditLog', (x) => x.action === 'security.reset2fa');
    assert.deepEqual(log.map((x) => [x.actorId, x.targetId]), [['usr_kelly', 'usr_alexd']]);
    assert.equal(A.db.store.list('authFactors', (x) => x.userId === 'usr_alexd').length, 0);
    assert.equal((await jsonClient(A.base).post('/api/auth/login', { email: 'alex@rabbits.co', password: 'demo1234' })).body.mfa, 'enroll');
    const team = (await kelly.rpc('app.bootstrap')).body.result.employees.find((e) => e.id === 'usr_alexd');
    assert.equal(team.twoStep, false);
  } finally { await A.close(); }
});

test('no RPC or route returns a secret, hash, public key, ticket or consent IP to anyone else', async () => {
  const A = await startApp();
  try {
    const IP = '203.0.113.77';
    const alex = await signedIn(A, 'alexd@demo.shiftboard');
    await alex.post('/api/rpc/consent.accept', { terms: true, sms: true, phone: '(303) 555-0142', email: true }, { 'X-Forwarded-For': IP });
    const key = softPasskey();
    const { options } = (await alex.post('/api/auth/passkey/register/options', {})).body;
    await alex.post('/api/auth/passkey/register/verify', { response: key.register(options, A.base) });
    const ticket = (await jsonClient(A.base).post('/api/auth/login', { email: 'alexd@demo.shiftboard', password: 'demo1234' })).body.ticket;
    await A.db.sync();
    const factors = A.db.store.list('authFactors', (f) => f.userId === 'usr_alexd');
    const secrets = [
      authenticatorOf('alexd@demo.shiftboard').secret, ticket, IP, A.db.store.get('users', 'usr_alexd').passwordHash,
      ...factors.flatMap((f) => [f.secretEnc, f.publicKey, ...(f.codes || []).flatMap((c) => [c.hash, c.salt])]),
      ...(authenticatorOf('alexd@demo.shiftboard').recovery || []),
    ].filter(Boolean);
    assert.ok(secrets.length > 20);
    const leaks = (label, text) => {
      for (const s of secrets) assert.ok(!String(text).includes(s), `${label} leaks ${s.slice(0, 12)}…`);
      assert.doesNotMatch(String(text), /passwordHash|secretEnc|credentialPublicKey|"codes"|"salt"|"lastStep"/, label);
    };
    const moe = await signedIn(A, 'moe@demo.shiftboard');
    const styves = await signedIn(A, 'styves@demo.shiftboard');
    const methods = Object.keys((await import('../core/service.js')).createService(A.db.store).api);
    const reads = methods.filter((m) => /\.(bootstrap|list|get|eligible|week|summary|suggestStaffing|covers|publicKey|board)$/.test(m) || m.startsWith('labor.'));
    assert.ok(reads.length > 20, reads.join());
    for (const who of [moe, styves]) {
      for (const m of reads) for (const args of [{ weekStart: '2026-09-28', start: '2026-09-28', end: '2026-10-04' }, { userId: 'usr_alexd', id: 'usr_alexd', weekStart: '2026-09-28' }]) leaks(m, JSON.stringify((await who.rpc(m, args)).body));
      leaks('security', await (await who.get('/api/auth/security')).text());
      leaks('config', await (await who.get('/api/config')).text());
    }
    // Managers editing Alex get Alex's view back, never the secret parts.
    leaks('employees.save', JSON.stringify((await moe.rpc('employees.save', { ...(await moe.rpc('app.bootstrap')).body.result.employees.find((e) => e.id === 'usr_alexd') })).body));
    leaks('setAvailability', JSON.stringify((await moe.rpc('employees.setAvailability', { userId: 'usr_alexd', availability: {} })).body));
    leaks('consent CSV', await (await moe.get('/api/consents.csv')).text());
    // Not even Alex's own views carry them (they're shown once, when made).
    leaks('own bootstrap', JSON.stringify((await alex.rpc('app.bootstrap')).body));
    leaks('own security', await (await alex.get('/api/auth/security')).text());
  } finally { await A.close(); }
});
