// Signing in: password plus a required second step, passkeys, email sign-in links, password reset, and
// each person's sign-in settings. The contract the web app and the phone app use is in docs/auth.md.
//
//   POST /api/auth/login {email, password, client?}
//        → 401 on a wrong password; else { mfa: 'verify', ticket, methods } or { mfa: 'enroll', ticket }.
//          No session yet: the ticket (a signed token, purpose 'mfa', 10 minutes) is for the second step.
//   POST /api/auth/mfa/verify {ticket, method: 'totp'|'recovery', code, client?}      → session
//   POST /api/auth/mfa/totp/setup {ticket}          → { secret, otpauthUrl }
//   POST /api/auth/mfa/totp/confirm {ticket, code, client?}   → { recoveryCodes } + session
//   POST /api/auth/passkey/register/options {ticket?} / register/verify {ticket?, response, name?, client?}
//   POST /api/auth/passkey/login/options {email?} / login/verify {response, client?}  → session
//   POST /api/auth/link {email, code} → { ok: true } (always); POST /api/auth/link/consume {token, client?} → session
//   POST /api/auth/forgot {email}, POST /api/auth/reset {token, password} → the second step, like login
//   GET  /api/auth/security, and passkey rename/remove, authenticator remove, new recovery codes (signed in)
//   POST /api/users/:id/reset-2fa (managers): the recovery path when someone lost their phone
//   POST /api/auth/step-up/passkey/options (signed in): a passkey challenge (5 minutes) for an action that needs
//        the second step again, entered with the request (stepUp below: making yourself Super Admin)
//
// A session is a cookie (sb_session), or { token, expiresIn } for the phone app ({ client: 'mobile' }).
// Factors live in the authFactors collection (core/auth-factors.js); nothing secret is ever sent back.
// SMS is never used for sign-in codes.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { uid } from '../core/store.js';
import { canManageUser } from '../core/roles.js';
import { activeFactors, isActiveFactor, factorView, twoStepOf, passwordProblem } from '../core/auth-factors.js';
import { AppError } from '../core/service.js';
import { generateSecret, verifyTotp, otpauthUrl } from './totp.js';
import { createSecretBox } from './secret-box.js';
import { DocDb } from './db.js';
import { deliverable, resetEmail, signInLinkEmail, securityResetEmail } from './email.js';

export const TICKET_MINUTES = 10;
export const MAX_LOGIN_ATTEMPTS = 10; // wrong passwords, per IP + email, per 15 minutes
export const MAX_CODE_TRIES = 5; // wrong codes, per ticket and per person, per 15 minutes
const LINK_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

const hashKey = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Ten one-time recovery codes like 7KQ4M-X2DPA (50 bits each). */
export function newRecoveryCodes(n = RECOVERY_COUNT) {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % 32]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
const normalCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashRecovery = (salt, code) => crypto.createHash('sha256').update(`${salt}:${normalCode(code)}`).digest('hex');

/** A short name for a new passkey from the browser it was made in ('iPhone', 'Android phone', 'Mac'…). */
export function deviceName(ua = '') {
  const s = String(ua);
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Android/i.test(s)) return /Mobile/i.test(s) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/i.test(s)) return 'Mac';
  if (/Windows/i.test(s)) return 'Windows PC';
  if (/CrOS/i.test(s)) return 'Chromebook';
  if (/Linux/i.test(s)) return 'Linux';
  return 'Passkey';
}
const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * @param {object} d  what server/app.js shares: db, env, tenant, now, mailer, secret(), sign(user), session(store, token),
 *   sessionToken(req), cookie (name), cookieOpts, appUrl(req), restaurantName(), brandOf(req), langFor(user),
 *   background(promise), stamp(ids, field), hashPassword, afterCommit(changes, req)
 */
export function createAuth(d) {
  const { db, env, tenant, now, mailer } = d;
  const box = createSecretBox({ env, sessionSecret: d.secret, scope: db.schema });
  const tenantClaim = tenant ? { t: tenant.id } : {};
  const fail = (status, message) => { throw new AppError(status, message); };

  // ---------- sessions ----------
  /** Sign the person in: a cookie, or { token, expiresIn } for the phone app. Their unused invitations end. */
  async function sendSession(req, res, user, extra = {}) {
    await d.stamp([user.id], 'lastLoginAt');
    await db.revokeTokens(user.id, 'invite');
    const u = db.store.get('users', user.id) || user;
    if (req.body?.client === 'mobile') return res.json({ ok: true, ...extra, token: d.sign(u), expiresIn: 30 * 24 * 60 * 60 });
    res.cookie(d.cookie, d.sign(u), d.cookieOpts).json({ ok: true, ...extra });
  }

  // ---------- tickets: the step between the password and the session ----------
  const ticketFor = (u, kind) => jwt.sign({ p: 'mfa', k: kind, sub: u.id, v: u.sessionVersion || 0, ...tenantClaim }, d.secret(),
    { expiresIn: `${TICKET_MINUTES}m`, jwtid: crypto.randomBytes(12).toString('base64url') });

  /** A ticket's person and claims, or null (expired, another restaurant's, password changed since…). */
  function readTicket(ticket) {
    try {
      const c = jwt.verify(String(ticket || ''), d.secret());
      if (c.p !== 'mfa' || !['verify', 'enroll'].includes(c.k)) return null;
      if (tenant && c.t !== tenant.id) return null;
      const u = db.store.get('users', c.sub);
      if (!u || u.active === false || (u.sessionVersion || 0) !== (c.v || 0)) return null;
      return { user: u, claims: c };
    } catch {
      return null;
    }
  }

  /** After the password (or a reset): the second step, or setting one up when they have none. */
  function secondStep(user) {
    const s = twoStepOf(db.store, user.id);
    if (!s.on) return { mfa: 'enroll', ticket: ticketFor(user, 'enroll') };
    const methods = [...(s.totp ? ['totp'] : []), ...(s.recoveryLeft ? ['recovery'] : []), ...(s.passkeys ? ['passkey'] : [])];
    return { mfa: 'verify', ticket: ticketFor(user, 'verify'), methods };
  }

  /**
   * Who may set up a factor on this request: an enroll ticket (only while they have no second factor), or a
   * signed-in session (not a support session). Returns { user, via: 'ticket'|'session' }.
   */
  async function authorizeSetup(req) {
    await db.sync();
    if (req.body?.ticket) {
      const t = readTicket(req.body.ticket);
      if (!t) fail(401, 'That sign-in step expired. Sign in again.');
      if (t.claims.k !== 'enroll' || twoStepOf(db.store, t.user.id).on) fail(403, 'Two-step sign-in is already set up. Sign in with it.');
      return { user: t.user, via: 'ticket', claims: t.claims };
    }
    const s = d.session(db.store, d.sessionToken(req));
    if (!s) fail(401, 'Please sign in');
    if (s.claims.sup) fail(403, 'Not available while DubLow Digital is signed in for support');
    return { user: s.user, via: 'session', claims: s.claims };
  }

  // ---------- rate limits (shared across instances; keys are hashed) ----------
  const codeKeys = (userId, jti) => [hashKey('mfa-u', db.schema, userId), ...(jti ? [hashKey('mfa-t', jti)] : [])];
  async function tooManyCodes(userId, jti) {
    const counts = await Promise.all(codeKeys(userId, jti).map((k) => db.countAttempts(k)));
    return counts.some((n) => n >= MAX_CODE_TRIES);
  }
  const wrongCode = (userId, jti) => Promise.all(codeKeys(userId, jti).map((k) => db.recordAttempt(k)));

  // ---------- authenticator app (TOTP) ----------
  const sealCtx = (userId) => `totp:${userId}`;
  /** Check a current code against the person's confirmed app (or the one being set up); marks the step used. */
  async function useTotp(userId, code, { unconfirmed = false, pending = null } = {}) {
    return db.run((s) => {
      const f = s.list('authFactors', (x) => x.userId === userId && x.type === 'totp'
        && (unconfirmed ? x.unconfirmed && (x.pending || null) === pending : isActiveFactor(x)))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (!f) return null;
      let secret;
      try { secret = box.open(f.secretEnc, sealCtx(userId)); } catch (e) { console.error('Authenticator secret could not be opened:', e.message); return null; }
      const step = verifyTotp(secret, code, { now: now(), afterStep: f.lastStep ?? -1 });
      if (step == null) return null;
      const at = new Date(now()).toISOString();
      s.update('authFactors', f.id, { lastStep: step, lastUsedAt: at, ...(unconfirmed ? { unconfirmed: false, confirmedAt: at } : {}) });
      return f.id;
    }, { write: true });
  }

  /** Start setting up an authenticator app: a new secret, kept unconfirmed until a code matches. */
  async function startTotp(user, { pending = null } = {}) {
    const secret = generateSecret();
    await db.run((s) => {
      for (const old of s.list('authFactors', (x) => x.userId === user.id && x.type === 'totp' && x.unconfirmed)) s.remove('authFactors', old.id);
      s.insert('authFactors', { id: uid('fac'), userId: user.id, type: 'totp', secretEnc: box.seal(secret, sealCtx(user.id)), unconfirmed: true,
        ...(pending ? { pending } : {}), createdAt: new Date(now()).toISOString() });
    }, { write: true });
    const name = String(d.restaurantName() || '').replace(/:/g, '').trim();
    const issuer = name && name !== 'Our Restaurant' ? `${name} ShiftBoard` : 'ShiftBoard';
    return { secret, otpauthUrl: otpauthUrl({ secret, account: user.email || user.name, issuer }) };
  }

  /** Make (or replace) someone's recovery codes; returns the codes in plain text, once. */
  async function makeRecoveryCodes(userId, { pending = null } = {}) {
    const codes = newRecoveryCodes();
    await db.run((s) => {
      for (const old of s.list('authFactors', (x) => x.userId === userId && x.type === 'recovery' && (x.pending || null) === pending)) s.remove('authFactors', old.id);
      const hashed = codes.map((c) => { const salt = crypto.randomBytes(16).toString('base64url'); return { salt, hash: hashRecovery(salt, c), usedAt: null }; });
      s.insert('authFactors', { id: uid('fac'), userId, type: 'recovery', codes: hashed, ...(pending ? { pending } : {}), createdAt: new Date(now()).toISOString() });
    }, { write: true });
    return codes;
  }
  const hasRecovery = (userId, pending = null) => db.store.list('authFactors', (x) => x.userId === userId && x.type === 'recovery' && (x.pending || null) === pending
    && (x.codes || []).some((c) => !c.usedAt)).length > 0;

  /** Confirm the app being set up; the older app (if any) is replaced. Returns new recovery codes when they had none. */
  async function confirmTotp(user, code, { pending = null } = {}) {
    const id = await useTotp(user.id, code, { unconfirmed: true, pending });
    if (!id) return null;
    await db.run((s) => {
      for (const old of s.list('authFactors', (x) => x.userId === user.id && x.type === 'totp' && x.id !== id && !x.unconfirmed && (x.pending || null) === pending)) s.remove('authFactors', old.id);
      if (!pending) audit(s, user.id, user.id, 'security.totpAdded');
    }, { write: true });
    return { recoveryCodes: hasRecovery(user.id, pending) ? null : await makeRecoveryCodes(user.id, { pending }) };
  }

  /** Use one recovery code (each works once). */
  async function useRecovery(userId, code) {
    if (normalCode(code).length !== 10) return false;
    return db.run((s) => {
      const f = s.list('authFactors', (x) => x.userId === userId && x.type === 'recovery' && isActiveFactor(x))[0];
      if (!f) return false;
      const codes = (f.codes || []).map((c) => ({ ...c }));
      const hit = codes.find((c) => !c.usedAt && crypto.timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(hashRecovery(c.salt, code), 'hex')));
      if (!hit) return false;
      hit.usedAt = new Date(now()).toISOString();
      s.update('authFactors', f.id, { codes });
      audit(s, userId, userId, 'security.recoveryCodeUsed', { left: codes.filter((c) => !c.usedAt).length });
      return true;
    }, { write: true });
  }

  // ---------- passkeys (WebAuthn) ----------
  // Passkeys belong to the address they were made on: rpID is this request's hostname, and the expected origin
  // is the app's address (APP_URL, else this request's). A restaurant that moves to a new domain re-adds them.
  const rpIdFor = (req) => req.hostname;
  function originsFor(req) {
    const rp = rpIdFor(req);
    const list = [...new Set([d.appUrl(req), `${req.protocol}://${req.get('host')}`].filter(Boolean))];
    const same = list.filter((o) => { try { return new URL(o).hostname === rp; } catch { return false; } });
    return same.length ? same : list;
  }
  // A stable WebAuthn user handle that isn't the internal id.
  const userHandle = (userId) => new Uint8Array(crypto.createHmac('sha256', d.secret()).update(`webauthn-user:${userId}`).digest().subarray(0, 16));
  const challengeFor = (token) => new Uint8Array(Buffer.from(token, 'utf8'));
  /** The challenge in clientData is base64url of the token's bytes: use it once, for its purpose (and person). */
  const consumeChallenge = (purpose, userId) => async (challenge) => {
    const token = Buffer.from(String(challenge || ''), 'base64url').toString('utf8');
    const t = await db.consumeTokenHash(DocDb.tokenHash(token), purpose);
    return !!t && (userId == null || t.userId === userId);
  };
  const passkeysOf = (userId, { pending } = {}) => db.store.list('authFactors', (x) => x.userId === userId && x.type === 'passkey'
    && (isActiveFactor(x) || (pending && x.pending === pending)));

  async function passkeyRegistrationOptions(req, user, { pending = null } = {}) {
    const token = await db.createToken(user.id, 'webauthn-reg', CHALLENGE_MINUTES);
    const name = String(d.restaurantName() || '');
    return generateRegistrationOptions({
      rpName: name && name !== 'Our Restaurant' ? `${name} · ShiftBoard` : 'ShiftBoard',
      rpID: rpIdFor(req),
      userName: user.email || user.name,
      userDisplayName: user.name || user.email || '',
      userID: userHandle(user.id),
      challenge: challengeFor(token),
      attestationType: 'none',
      excludeCredentials: passkeysOf(user.id, { pending }).map((p) => ({ id: p.credentialId, transports: p.transports || undefined })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    });
  }

  /** Verify a new passkey and keep it. Returns { passkey, recoveryCodes } or null. */
  async function passkeyRegister(req, user, response, name, { pending = null } = {}) {
    let v;
    try {
      v = await verifyRegistrationResponse({
        response, expectedChallenge: consumeChallenge('webauthn-reg', user.id), expectedOrigin: originsFor(req), expectedRPID: rpIdFor(req),
        requireUserVerification: true, supportedAlgorithmIDs: [-7, -257],
      });
    } catch (e) {
      console.error('Passkey registration failed:', e.message);
      return null;
    }
    if (!v?.verified) return null;
    const cred = v.registrationInfo.credential;
    const at = new Date(now()).toISOString();
    const passkey = await db.run((s) => {
      if (s.list('authFactors', (x) => x.type === 'passkey' && x.credentialId === cred.id).length) fail(400, 'That passkey is already set up');
      const doc = s.insert('authFactors', {
        id: uid('fac'), userId: user.id, type: 'passkey', credentialId: cred.id, publicKey: b64u(cred.publicKey), counter: cred.counter || 0,
        transports: Array.isArray(cred.transports) ? cred.transports.slice(0, 6) : [], rpId: rpIdFor(req),
        name: cleanName(name) || deviceName(req.get('user-agent')), createdAt: at, ...(pending ? { pending } : {}),
      });
      if (!pending) audit(s, user.id, user.id, 'security.passkeyAdded', { name: doc.name });
      return doc;
    }, { write: true });
    return { passkey: factorView(passkey), recoveryCodes: hasRecovery(user.id, pending) ? null : await makeRecoveryCodes(user.id, { pending }) };
  }

  // ---------- the second step again, for one sensitive action (stepUp) ----------
  // The person types a current authenticator code, or uses a passkey, WITH the request: { code } or { passkey }
  // (an assertion for a challenge from /api/auth/step-up/passkey/options, made in the last 5 minutes, for them
  // only, used once). Recovery codes don't count. Wrong codes and passkeys count toward the same limit as
  // sign-in codes (5 per 15 minutes). A code that worked can't be used again (lastStep), here or to sign in.
  // Returns { method: 'totp' | 'passkey' } or throws.
  async function stepUp(req, user) {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (!b.code && !b.passkey) fail(403, 'Confirm it’s you with your authenticator app or a passkey first');
    if (await tooManyCodes(user.id)) fail(429, 'Too many tries. Try again in 15 minutes.');
    if (b.passkey) {
      const response = b.passkey;
      const f = passkeysOf(user.id).find((x) => x.credentialId === String(response?.id || ''));
      let v = null;
      if (f) {
        try {
          v = await verifyAuthenticationResponse({
            response, expectedChallenge: consumeChallenge('webauthn-step', user.id), expectedOrigin: originsFor(req), expectedRPID: rpIdFor(req),
            credential: { id: f.credentialId, publicKey: new Uint8Array(Buffer.from(f.publicKey, 'base64url')), counter: f.counter || 0, transports: f.transports || [] },
            requireUserVerification: true,
          });
        } catch (e) {
          console.error('Passkey step-up failed:', e.message);
        }
      }
      const handle = response?.response?.userHandle;
      if (!v?.verified || !v.authenticationInfo.userVerified || (handle && handle !== b64u(userHandle(user.id)))) {
        await wrongCode(user.id);
        fail(403, 'That passkey didn’t work. Try again, or use your authenticator app.');
      }
      await db.run((s) => s.update('authFactors', f.id, { counter: v.authenticationInfo.newCounter, lastUsedAt: new Date(now()).toISOString() }), { write: true });
      return { method: 'passkey' };
    }
    if (!(await useTotp(user.id, String(b.code)))) {
      await wrongCode(user.id);
      fail(403, 'That code didn’t work. Check your authenticator app and try again.');
    }
    return { method: 'totp' };
  }

  // ---------- the audit log (restaurant-wide security events; append-only, never sent to the apps) ----------
  function audit(s, actorId, targetId, action, details = {}) {
    s.insert('auditLog', { id: uid('aud'), at: new Date(now()).toISOString(), actorId, targetId, action, details });
  }

  // ---------- routes ----------
  function routes(app) {
    const wrap = (label, fn) => async (req, res) => {
      try { await fn(req, res); } catch (e) {
        const status = e instanceof AppError ? e.status : 500;
        if (status === 500) console.error(label, e);
        if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
      }
    };

    app.post('/api/auth/login', wrap('login', async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      // Hashed so the rate-limit table doesn't hold IPs or emails.
      const key = hashKey(req.ip, email);
      const [attempts] = await Promise.all([db.countAttempts(key), db.sync()]);
      if (attempts >= MAX_LOGIN_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const u = db.store.list('users', (x) => x.email === email)[0];
      if (!u || u.active === false || !(await bcrypt.compare(password, u.passwordHash || ''))) {
        await db.recordAttempt(key);
        return res.status(401).json({ error: 'Wrong email or password' });
      }
      await db.clearAttempts(key);
      res.json(secondStep(u)); // never a session here: the second step (or setting one up) comes first
    }));

    app.post('/api/auth/logout', (req, res) => {
      res.clearCookie(d.cookie, { ...d.cookieOpts, maxAge: undefined }).json({ ok: true });
    });

    // The second step: a code from the authenticator app, or a recovery code.
    app.post('/api/auth/mfa/verify', wrap('mfa', async (req, res) => {
      await db.sync();
      const t = readTicket(req.body?.ticket);
      if (!t || t.claims.k !== 'verify') return res.status(401).json({ error: 'That sign-in step expired. Sign in again.' });
      const method = req.body?.method;
      if (!['totp', 'recovery'].includes(method)) return res.status(400).json({ error: 'Pick how to confirm it’s you' });
      if (await tooManyCodes(t.user.id, t.claims.jti)) return res.status(429).json({ error: 'Too many tries. Try again in 15 minutes.' });
      const ok = method === 'totp' ? await useTotp(t.user.id, req.body?.code) : await useRecovery(t.user.id, req.body?.code);
      if (!ok) {
        await wrongCode(t.user.id, t.claims.jti);
        return res.status(401).json({ error: method === 'totp' ? 'That code didn’t work. Check your authenticator app and try again.' : 'That recovery code didn’t work' });
      }
      await sendSession(req, res, t.user);
    }));

    // Set up an authenticator app: with an enroll ticket (first sign-in) or signed in (My settings).
    app.post('/api/auth/mfa/totp/setup', wrap('totp-setup', async (req, res) => {
      const { user } = await authorizeSetup(req);
      res.json(await startTotp(user));
    }));

    app.post('/api/auth/mfa/totp/confirm', wrap('totp-confirm', async (req, res) => {
      const { user, via, claims } = await authorizeSetup(req);
      if (!db.store.list('authFactors', (x) => x.userId === user.id && x.type === 'totp' && x.unconfirmed && !x.pending).length) fail(400, 'Set up your authenticator app first');
      if (await tooManyCodes(user.id, claims.jti)) return res.status(429).json({ error: 'Too many tries. Try again in 15 minutes.' });
      const out = await confirmTotp(user, req.body?.code);
      if (!out) {
        await wrongCode(user.id, claims.jti);
        return res.status(401).json({ error: 'That code didn’t work. Check your authenticator app and try again.' });
      }
      if (via === 'ticket') return sendSession(req, res, user, { recoveryCodes: out.recoveryCodes || [] });
      res.json({ ok: true, recoveryCodes: out.recoveryCodes || [] });
    }));

    // Passkeys: add one (enroll ticket or signed in), or sign in with one (no password; it counts as both steps).
    app.post('/api/auth/passkey/register/options', wrap('passkey-reg', async (req, res) => {
      const { user } = await authorizeSetup(req);
      res.json({ options: await passkeyRegistrationOptions(req, user) });
    }));

    app.post('/api/auth/passkey/register/verify', wrap('passkey-reg', async (req, res) => {
      const { user, via } = await authorizeSetup(req);
      const out = await passkeyRegister(req, user, req.body?.response, req.body?.name);
      if (!out) return res.status(400).json({ error: 'That passkey couldn’t be set up. Try again.' });
      if (via === 'ticket') return sendSession(req, res, user, { recoveryCodes: out.recoveryCodes || [] });
      res.json({ ok: true, passkey: out.passkey, recoveryCodes: out.recoveryCodes || [] });
    }));

    app.post('/api/auth/passkey/login/options', wrap('passkey-login', async (req, res) => {
      // Discoverable passkeys only, so the answer never depends on whether an email has passkeys (email is ignored).
      const key = hashKey('pk-opt', req.ip);
      if ((await db.countAttempts(key)) >= 60) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
      await db.recordAttempt(key);
      const token = await db.createToken('', 'webauthn-auth', CHALLENGE_MINUTES);
      res.json({ options: await generateAuthenticationOptions({ rpID: rpIdFor(req), challenge: challengeFor(token), userVerification: 'required', allowCredentials: [] }) });
    }));

    app.post('/api/auth/passkey/login/verify', wrap('passkey-login', async (req, res) => {
      const key = hashKey('pk', req.ip);
      const [attempts] = await Promise.all([db.countAttempts(key), db.sync()]);
      if (attempts >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const response = req.body?.response;
      const bad = async () => { await db.recordAttempt(key); res.status(401).json({ error: 'That passkey didn’t work. Try again, or sign in with your password.' }); };
      const f = db.store.list('authFactors', (x) => x.type === 'passkey' && isActiveFactor(x) && x.credentialId === String(response?.id || ''))[0];
      const user = f && db.store.get('users', f.userId);
      if (!f || !user || user.active === false) return bad();
      let v;
      try {
        v = await verifyAuthenticationResponse({
          response, expectedChallenge: consumeChallenge('webauthn-auth', null), expectedOrigin: originsFor(req), expectedRPID: rpIdFor(req),
          credential: { id: f.credentialId, publicKey: new Uint8Array(Buffer.from(f.publicKey, 'base64url')), counter: f.counter || 0, transports: f.transports || [] },
          requireUserVerification: true,
        });
      } catch (e) {
        console.error('Passkey sign-in failed:', e.message);
        return bad();
      }
      if (!v?.verified || !v.authenticationInfo.userVerified) return bad();
      const handle = response?.response?.userHandle;
      if (handle && handle !== b64u(userHandle(user.id))) return bad();
      await db.run((s) => s.update('authFactors', f.id, { counter: v.authenticationInfo.newCounter, lastUsedAt: new Date(now()).toISOString() }), { write: true });
      await sendSession(req, res, user);
    }));

    // Email me a sign-in link: email + a current authenticator code → a one-time link (15 minutes) by email.
    // The answer is the same whether or not the account exists; the work happens after it.
    app.post('/api/auth/link', wrap('link', async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const code = String(req.body?.code || '');
      if (!mailer.enabled) return res.status(400).json({ error: 'Email sign-in links aren’t set up here. Sign in with your password.' });
      const key = hashKey('link', req.ip, email);
      const [attempts] = await Promise.all([db.countAttempts(key), db.sync()]);
      if (attempts >= 5) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
      await db.recordAttempt(key);
      const u = db.store.list('users', (x) => x.email === email)[0];
      if (u && u.active !== false && deliverable(u.email)) {
        d.background((async () => {
          if (await tooManyCodes(u.id)) return;
          if (!(await useTotp(u.id, code))) { await wrongCode(u.id); return; }
          const token = await db.createToken(u.id, 'signin-link', LINK_MINUTES);
          await mailer.send(signInLinkEmail({ user: u, link: `${d.appUrl(req)}/#/link?token=${token}`, restaurant: d.restaurantName(), brand: d.brandOf(req), lang: d.langFor(u) }));
        })());
      }
      res.json({ ok: true });
    }));

    app.post('/api/auth/link/consume', wrap('link', async (req, res) => {
      const t = await db.consumeTokenHash(DocDb.tokenHash(req.body?.token), 'signin-link');
      await db.sync();
      const u = t && db.store.get('users', t.userId);
      if (!u || u.active === false) return res.status(400).json({ error: 'This sign-in link has expired or was already used. Ask for a new one.' });
      await sendSession(req, res, u);
    }));

    // ---------- forgotten password ----------
    app.post('/api/auth/forgot', wrap('forgot', async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!mailer.enabled) return res.status(400).json({ error: 'Password reset by email isn’t set up. Ask a manager to reset it.' });
      const key = hashKey(`forgot|${req.ip}|${email}`);
      const [attempts] = await Promise.all([db.countAttempts(key), db.sync()]);
      if (attempts >= 5) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
      await db.recordAttempt(key);
      const u = db.store.list('users', (x) => x.email === email)[0];
      if (u && u.active !== false && deliverable(u.email)) {
        // Sent in the background so the reply takes the same time whether or not the account exists.
        d.background((async () => {
          const token = await db.createToken(u.id, 'reset', 60);
          await mailer.send(resetEmail({ user: u, link: `${d.appUrl(req)}/#/reset?token=${token}`, restaurant: d.restaurantName(), brand: d.brandOf(req), lang: d.langFor(u) }));
        })());
      }
      res.json({ ok: true }); // same answer either way, so this can't be used to find accounts
    }));

    // A reset link (or an invitation from before the welcome wizard) sets a new password, then goes through the
    // second step like a sign-in: it never signs in by itself.
    app.post('/api/auth/reset', wrap('reset', async (req, res) => {
      const hash = DocDb.tokenHash(req.body?.token);
      const peek = await db.peekTokenHash(hash);
      await db.sync();
      const cur = peek && ['reset', 'invite'].includes(peek.purpose) ? db.store.get('users', peek.userId) : null;
      if (!cur) fail(400, 'This link has expired or was already used. Ask for a new one.');
      if (cur.active === false) fail(400, 'This account is inactive. Ask a manager.');
      const problem = passwordProblem(req.body?.password, { email: cur.email, name: cur.name });
      if (problem) fail(400, problem); // the link still works
      if (!(await db.consumeTokenHash(hash, peek.purpose))) fail(400, 'This link has expired or was already used. Ask for a new one.');
      const user = await db.run((store) => {
        const u = store.get('users', cur.id);
        return store.update('users', u.id, { passwordHash: d.hashPassword(String(req.body.password)), sessionVersion: (u.sessionVersion || 0) + 1, passwordChangedAt: new Date(now()).toISOString() });
      }, { write: true });
      await db.revokeTokens(user.id);
      res.json(secondStep(user));
    }));

    // ---------- my sign-in settings (My settings → Sign-in & security) ----------
    const signedIn = async (req) => {
      await db.sync();
      const s = d.session(db.store, d.sessionToken(req));
      if (!s) fail(401, 'Please sign in');
      return s;
    };
    const mine = async (req) => {
      const s = await signedIn(req);
      if (s.claims.sup) fail(403, 'Not available while DubLow Digital is signed in for support');
      return s.user;
    };
    const securityView = (userId) => ({
      twoStep: twoStepOf(db.store, userId),
      factors: activeFactors(db.store, userId).map(factorView).filter(Boolean)
        .sort((a, b) => a.type.localeCompare(b.type) || String(a.createdAt).localeCompare(String(b.createdAt))),
    });

    app.get('/api/auth/security', wrap('security', async (req, res) => {
      const s = await signedIn(req);
      res.json({ result: securityView(s.user.id) });
    }));

    app.post('/api/auth/passkey/rename', wrap('security', async (req, res) => {
      const user = await mine(req);
      const name = cleanName(req.body?.name);
      if (!name) fail(400, 'Give your passkey a name');
      await db.run((s) => {
        const f = s.get('authFactors', String(req.body?.id || ''));
        if (!f || f.userId !== user.id || f.type !== 'passkey' || !isActiveFactor(f)) fail(404, 'Passkey not found');
        s.update('authFactors', f.id, { name });
      }, { write: true });
      res.json({ result: securityView(user.id) });
    }));

    // Removing a passkey or the authenticator app: never the last second step (add another first).
    const removeFactor = (type) => wrap('security', async (req, res) => {
      const user = await mine(req);
      await db.run((s) => {
        const list = activeFactors(s, user.id);
        const f = type === 'totp' ? list.find((x) => x.type === 'totp') : list.find((x) => x.id === String(req.body?.id || '') && x.type === 'passkey');
        if (!f) fail(404, type === 'totp' ? 'Your authenticator app isn’t set up' : 'Passkey not found');
        if (list.filter((x) => (x.type === 'totp' || x.type === 'passkey') && x.id !== f.id).length === 0) fail(400, 'Add another way to sign in first');
        s.remove('authFactors', f.id);
        audit(s, user.id, user.id, type === 'totp' ? 'security.totpRemoved' : 'security.passkeyRemoved', type === 'totp' ? {} : { name: f.name });
      }, { write: true });
      res.json({ result: securityView(user.id) });
    });
    app.post('/api/auth/passkey/remove', removeFactor('passkey'));
    app.post('/api/auth/mfa/totp/remove', removeFactor('totp'));

    app.post('/api/auth/mfa/recovery/regenerate', wrap('security', async (req, res) => {
      const user = await mine(req);
      if (!twoStepOf(db.store, user.id).on) fail(400, 'Set up your authenticator app or a passkey first');
      const codes = await makeRecoveryCodes(user.id);
      await db.run((s) => audit(s, user.id, user.id, 'security.recoveryRegenerated'), { write: true });
      res.json({ result: { recoveryCodes: codes, ...securityView(user.id) } });
    }));

    // A passkey challenge for stepUp: this person's own passkeys only, 5 minutes, once. Not in a support session.
    app.post('/api/auth/step-up/passkey/options', wrap('step-up', async (req, res) => {
      const user = await mine(req);
      const keys = passkeysOf(user.id);
      if (!keys.length) fail(400, 'You don’t have a passkey yet. Use your authenticator app.');
      const token = await db.createToken(user.id, 'webauthn-step', CHALLENGE_MINUTES);
      res.json({ options: await generateAuthenticationOptions({ rpID: rpIdFor(req), challenge: challengeFor(token), userVerification: 'required',
        allowCredentials: keys.map((p) => ({ id: p.credentialId, transports: p.transports || undefined })) }) });
    }));

    // ---------- the recovery path: a manager or admin resets someone's second step ----------
    // Their authenticator app, passkeys and recovery codes are removed, every session ends (sessionVersion),
    // they get a security notice by email, and it's in the audit log. They set up a new one at their next sign-in.
    app.post('/api/users/:id/reset-2fa', wrap('reset-2fa', async (req, res) => {
      const s = await signedIn(req);
      const actor = s.user;
      const target = db.store.get('users', req.params.id);
      if (!target) fail(404, 'User not found');
      if (target.id === actor.id) fail(400, 'You can’t reset your own two-step sign-in here. Use My settings.');
      if (!canManageUser(actor, target)) fail(403, 'You can’t reset this person’s two-step sign-in');
      const removed = await db.run((st) => {
        const list = st.list('authFactors', (x) => x.userId === target.id && x.type !== 'onboarding');
        for (const f of list) st.remove('authFactors', f.id);
        const u = st.get('users', target.id);
        st.update('users', u.id, { sessionVersion: (u.sessionVersion || 0) + 1, twoStepResetAt: new Date(now()).toISOString(), twoStepResetBy: actor.id });
        audit(st, actor.id, target.id, 'security.reset2fa', { removed: list.length, ...(s.claims.sup ? { support: s.claims.sup.by } : {}) });
        return list.length;
      }, { write: true });
      const emailed = mailer.enabled && deliverable(target.email);
      if (emailed) {
        d.background(mailer.send(securityResetEmail({ user: target, restaurant: d.restaurantName(), brand: d.brandOf(req), by: actor.name,
          appUrl: d.appUrl(req), lang: d.langFor(target) })));
      }
      res.json({ result: { ok: true, removed, emailed } });
    }));
  }

  return {
    routes, box, sendSession, secondStep, ticketFor, readTicket, stepUp,
    // for the invite wizard (server/onboarding.js)
    startTotp, confirmTotp, makeRecoveryCodes, hasRecovery, passkeyRegistrationOptions, passkeyRegister, passkeysOf, audit, tooManyCodes, wrongCode,
  };
}
