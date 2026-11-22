// The invitation wizard (/#/welcome?token=…): a new person sets a password, secures their account (a passkey or
// an authenticator app, then 10 recovery codes), fills in their profile and answers the consent screen.
//
//   POST /api/onboarding/start {token}        checks the invitation (not used up), starts a short onboarding
//                                             session (cookie sb_onboard, 1 hour) and says what's done
//   POST /api/onboarding/state
//   POST /api/onboarding/password {password}
//   POST /api/onboarding/totp/setup · /totp/confirm {code}
//   POST /api/onboarding/passkey/options · /passkey/verify {response, name?}
//   POST /api/onboarding/recovery/regenerate · /recovery/ack
//   POST /api/onboarding/profile {name, phone} · /photo {dataUrl}
//   POST /api/onboarding/complete {terms, sms, email, phone, lang}   → signed in (cookie)
//
// Progress is kept on the server (authFactors onb_<userId>), so a reload picks up where it was. The password
// and the factors made here stay pending (they don't work for signing in) until the wizard completes, which
// needs a password, a second step, the recovery codes saved and the terms ticked. Only then is the invitation
// used up (single use, 7 days) and the person signed in. Opening a newer invitation starts over.
import jwt from 'jsonwebtoken';
import { isActiveFactor, passwordProblem } from '../core/auth-factors.js';
import { applyConsents, consentState, legalLinks } from '../core/consent.js';
import { normalizePhone, formatPhone } from '../core/notify-prefs.js';
import { createService, AppError } from '../core/service.js';
import { DocDb } from './db.js';

const COOKIE = 'sb_onboard';
const MINUTES = 60;

/**
 * @param {object} d  db, env, tenant, now, secret(), cookieOpts, hashPassword, auth (server/auth.js), channels (createChannels), langFor
 */
export function mountOnboarding(app, d) {
  const { db, auth, tenant, now } = d;
  const fail = (status, message) => { throw new AppError(status, message); };
  const cookieOpts = { ...d.cookieOpts, maxAge: MINUTES * 60_000, path: '/api/onboarding' };
  const docId = (userId) => `onb_${userId}`;
  const th = (hash) => hash.slice(0, 24); // the invitation, as factors made here remember it

  const wrap = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if (status === 500) console.error(label, e);
      if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
    }
  };

  const EXPIRED = 'This invitation link has expired or was already used. Ask your manager for a new one.';

  /** The onboarding session: { user, hash, doc }. The invitation must still be unused and unexpired. */
  async function current(req) {
    let c;
    try { c = jwt.verify(String(req.cookies?.[COOKIE] || ''), d.secret()); } catch { fail(401, 'Your setup timed out. Open the invitation link again.'); }
    if (c.p !== 'onboard' || (tenant && c.t !== tenant.id)) fail(401, 'Your setup timed out. Open the invitation link again.');
    const [peek] = await Promise.all([db.peekTokenHash(c.h), db.sync()]);
    if (!peek || peek.purpose !== 'invite' || peek.userId !== c.sub) fail(400, EXPIRED);
    const user = db.store.get('users', c.sub);
    if (!user || user.active === false) fail(400, 'This account is inactive. Ask a manager.');
    const doc = db.store.get('authFactors', docId(user.id));
    if (!doc || doc.th !== th(c.h)) fail(401, 'Your setup timed out. Open the invitation link again.');
    return { user, hash: c.h, doc, pending: doc.th };
  }

  /** What's done so far (never any secret). */
  function state(user, doc, extra = {}) {
    const factors = db.store.list('authFactors', (x) => x.userId === user.id && (isActiveFactor(x) || (x.pending === doc.th && !x.unconfirmed)));
    const factor = factors.some((x) => x.type === 'passkey') ? 'passkey' : factors.some((x) => x.type === 'totp') ? 'totp' : null;
    const st = createService(db.store).settings();
    return {
      name: user.name, email: user.email, lang: d.langFor(user), restaurant: st.restaurantName,
      steps: { password: !!doc.passwordHash, factor, recoverySaved: !!doc.recoveryAckAt, profile: !!doc.profileAt },
      profile: { name: user.name, phone: user.phone || '', photoId: user.photoId || null },
      consent: consentState(db.store, user),
      sms: !!(d.channels.info.sms.enabled && st.smsNotifications !== false && (!tenant || tenant.features?.sms !== false)),
      legal: legalLinks(d.env),
      ...extra,
    };
  }
  const touch = (id, patch) => db.run((s) => s.update('authFactors', id, { ...patch, updatedAt: new Date(now()).toISOString() }), { write: true });

  app.post('/api/onboarding/start', wrap('onboarding', async (req, res) => {
    const hash = DocDb.tokenHash(req.body?.token);
    const [peek] = await Promise.all([db.peekTokenHash(hash), db.sync()]);
    if (!peek || peek.purpose !== 'invite') fail(400, EXPIRED);
    const user = db.store.get('users', peek.userId);
    if (!user || user.active === false) fail(400, 'This account is inactive. Ask a manager.');
    // A newer invitation starts over: progress and pending factors from an older one are dropped.
    const doc = await db.run((s) => {
      const cur = s.get('authFactors', docId(user.id));
      if (cur && cur.th === th(hash)) return cur;
      for (const f of s.list('authFactors', (x) => x.userId === user.id && x.pending)) s.remove('authFactors', f.id);
      return s.insert('authFactors', { id: docId(user.id), userId: user.id, type: 'onboarding', th: th(hash), startedAt: new Date(now()).toISOString() });
    }, { write: true });
    const session = jwt.sign({ p: 'onboard', sub: user.id, h: hash, ...(tenant ? { t: tenant.id } : {}) }, d.secret(), { expiresIn: `${MINUTES}m` });
    res.cookie(COOKIE, session, cookieOpts).json({ result: state(user, doc, { expiresAt: peek.expiresAt }) });
  }));

  app.post('/api/onboarding/state', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    res.json({ result: state(user, doc) });
  }));

  // a) the password: kept with the wizard's progress until it completes (it doesn't sign in before then).
  app.post('/api/onboarding/password', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    const problem = passwordProblem(req.body?.password, { email: user.email, name: user.name });
    if (problem) fail(400, problem);
    await touch(doc.id, { passwordHash: d.hashPassword(String(req.body.password)) });
    res.json({ result: state(user, db.store.get('authFactors', doc.id)) });
  }));

  // b) a passkey or an authenticator app, then the recovery codes.
  const needPassword = (doc) => { if (!doc.passwordHash) fail(400, 'Choose your password first'); };
  app.post('/api/onboarding/totp/setup', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    needPassword(doc);
    res.json({ result: await auth.startTotp(user, { pending: doc.th }) });
  }));
  app.post('/api/onboarding/totp/confirm', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    if (await auth.tooManyCodes(user.id)) return res.status(429).json({ error: 'Too many tries. Try again in 15 minutes.' });
    const out = await auth.confirmTotp(user, req.body?.code, { pending: doc.th });
    if (!out) {
      await auth.wrongCode(user.id);
      return res.status(401).json({ error: 'That code didn’t work. Check your authenticator app and try again.' });
    }
    res.json({ result: { recoveryCodes: out.recoveryCodes || await auth.makeRecoveryCodes(user.id, { pending: doc.th }), ...state(user, doc) } });
  }));
  app.post('/api/onboarding/passkey/options', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    needPassword(doc);
    res.json({ result: { options: await auth.passkeyRegistrationOptions(req, user, { pending: doc.th }) } });
  }));
  app.post('/api/onboarding/passkey/verify', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    const out = await auth.passkeyRegister(req, user, req.body?.response, req.body?.name, { pending: doc.th });
    if (!out) return res.status(400).json({ error: 'That passkey couldn’t be set up. Try again.' });
    res.json({ result: { recoveryCodes: out.recoveryCodes || await auth.makeRecoveryCodes(user.id, { pending: doc.th }), ...state(user, doc) } });
  }));
  // After a reload on the codes screen the old codes are gone: new ones replace them.
  app.post('/api/onboarding/recovery/regenerate', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    if (!state(user, doc).steps.factor) fail(400, 'Set up your authenticator app or a passkey first');
    res.json({ result: { recoveryCodes: await auth.makeRecoveryCodes(user.id, { pending: doc.th }), ...state(user, doc) } });
  }));
  app.post('/api/onboarding/recovery/ack', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    if (!state(user, doc).steps.factor) fail(400, 'Set up your authenticator app or a passkey first');
    if (req.body?.saved !== true) fail(400, 'Save your recovery codes first');
    await touch(doc.id, { recoveryAckAt: new Date(now()).toISOString() });
    res.json({ result: state(user, db.store.get('authFactors', doc.id)) });
  }));

  // c) the profile: name, mobile number (needed only for texts), photo.
  app.post('/api/onboarding/profile', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    const name = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) fail(400, 'Name is required');
    const raw = String(req.body?.phone ?? '').trim();
    if (raw && !normalizePhone(raw)) fail(400, 'Enter your mobile number, like (303) 555-0123');
    await db.run((s) => {
      s.update('users', user.id, { name, phone: raw ? formatPhone(normalizePhone(raw)) : '' });
      s.update('authFactors', doc.id, { profileAt: new Date(now()).toISOString() });
    }, { write: true });
    res.json({ result: state(db.store.get('users', user.id), db.store.get('authFactors', doc.id)) });
  }));
  app.post('/api/onboarding/photo', wrap('onboarding', async (req, res) => {
    const { user, doc } = await current(req);
    const out = await db.run((s) => createService(s).call(s.get('users', user.id), req.body?.remove ? 'profile.removePhoto' : 'profile.setPhoto', { dataUrl: req.body?.dataUrl }), { write: true });
    res.json({ result: { ...state(db.store.get('users', user.id), doc), photoId: out.photoId } });
  }));

  // d) consent, then done: everything is saved at once, the invitation is used up, and they're signed in.
  app.post('/api/onboarding/complete', wrap('onboarding', async (req, res) => {
    const { user, hash, doc } = await current(req);
    const now0 = state(user, doc);
    if (!doc.passwordHash) fail(400, 'Choose your password first');
    if (!now0.steps.factor) fail(400, 'Set up your authenticator app or a passkey first');
    if (!doc.recoveryAckAt) fail(400, 'Save your recovery codes first');
    const b = req.body || {};
    const lang = b.lang === 'en' || b.lang === 'es' ? b.lang : d.langFor(user);
    const done = await db.run((s) => {
      const cur = s.get('authFactors', doc.id);
      if (!cur || cur.th !== doc.th) fail(400, EXPIRED);
      const at = new Date(now()).toISOString();
      try {
        applyConsents(s, user.id, { terms: b.terms, sms: b.sms, email: b.email, phone: b.phone }, {
          lang, ip: req.ip, userAgent: req.get('user-agent'), source: 'onboarding', at, smsEnabled: now0.sms, requireTerms: true, links: now0.legal,
        });
      } catch (e) { fail(e.status || 400, e.message); }
      for (const f of s.list('authFactors', (x) => x.userId === user.id && x.pending)) {
        if (f.pending === doc.th && !f.unconfirmed) { const { pending: _p, ...rest } = f; s.insert('authFactors', rest); } else s.remove('authFactors', f.id);
      }
      s.remove('authFactors', doc.id);
      const u = s.get('users', user.id);
      return s.update('users', user.id, { passwordHash: cur.passwordHash, sessionVersion: (u.sessionVersion || 0) + 1, onboardedAt: at, passwordChangedAt: at });
    }, { write: true, onCommit: (changes) => d.channels.afterCommit(changes, req) });
    if (!(await db.consumeTokenHash(hash, 'invite'))) fail(400, EXPIRED); // used once, now
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
    await auth.sendSession(req, res, done);
  }));
}
