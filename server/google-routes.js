// Google Business Profile: connecting a restaurant, picking its location, syncing its reviews. Mounted by
// server/app.js (the plan's `reviews` feature gates /api/google).
//   GET  /api/google/status      managers: is the platform's OAuth client set up, is this restaurant connected,
//                                its location, the last sync (never a token)
//   POST /api/google/connect     admins: { url } of Google's consent page, with a signed state
//   GET  /api/google/callback    Google sends the admin back here: the state is checked (signed by this
//                                restaurant, minutes old, for the admin who started it, in the same browser),
//                                the code becomes a refresh token, sealed in the restaurant's own store
//   GET  /api/google/locations   admins: the Business Profile locations this Google account manages
//   POST /api/google/location    admins: { account, location } the one to read reviews from
//   POST /api/google/disconnect  admins: revoke at Google and forget the token
//   POST /api/google/sync        managers: one chunk of a sync; the page calls again with `next`
// The daily sync is app.locals.googleCron, run by /api/cron/reviews (with Yelp's).
// The redirect address is https://<the restaurant's host>/api/google/callback: it must be one of the OAuth
// client's authorized redirect URIs (docs/integrations/GOOGLE-YELP.md).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { canManageSchedule, canChangeSettings } from '../core/roles.js';
import { uid } from '../core/store.js';
import { integration, saveIntegration, googleView } from '../core/google-reviews.js';
import { createGoogleClient, googleConfig, GoogleError } from './google.js';
import { runGoogleSync } from './google-sync.js';
import { createSecretBox } from './secret-box.js';

export const BUDGET_MS = 18_000;
export const STATE_COOKIE = 'sb_google_oauth';
const STATE_MINUTES = 10;
const CRON_RESUME_MS = 26 * 3_600_000;
const TOKEN_CONTEXT = 'google:refresh';

/**
 * @param {import('express').Express} app
 * @param {object} o  { db, env, tenant, userOf, secret: () => string, appUrl: (req) => string, onCommit, makeClient, now }
 *   makeClient({ refreshToken }) → a server/google.js client (tests pass one that talks to a fake Google)
 */
export function mountGoogle(app, { db, env, tenant = null, userOf, secret, appUrl, onCommit = () => {}, budgetMs = BUDGET_MS, makeClient, now = () => Date.now(), secure = false }) {
  const box = createSecretBox({ env, sessionSecret: secret, scope: db.schema || 'shiftboard' });
  const clientFor = (refreshToken = '') => (makeClient ? makeClient({ refreshToken }) : createGoogleClient({ env, refreshToken }));
  const redirectUri = (req) => `${appUrl(req)}/api/google/callback`;
  const tokenOf = (store) => { const enc = integration(store).refreshTokenEnc; return enc ? box.open(enc, TOKEN_CONTEXT) : ''; };
  const audit = (store, actorId, action, details = {}) => store.insert('auditLog', { id: uid('aud'), at: new Date(now()).toISOString(), actorId, targetId: null, action, details });

  const who = (check, label) => async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!check(u)) { res.status(403).json({ error: label }); return null; }
    res.set('Cache-Control', 'no-store');
    return u;
  };
  const manager = who(canManageSchedule, 'Managers only');
  const admin = who(canChangeSettings, 'Admins only');
  const fail = (res, e) => {
    if (!(e instanceof GoogleError)) console.error('Google:', e);
    res.status(e instanceof GoogleError ? (e.status >= 400 && e.status < 600 ? (e.status === 401 ? 409 : e.status) : 502) : 500)
      .json({ error: e instanceof GoogleError ? e.message : 'Something went wrong', ...(e?.code ? { code: e.code } : {}) });
  };

  app.get('/api/google/status', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const { configured, missing, cron } = googleConfig(env);
    res.json({ result: { configured, missing, cron, redirectUri: redirectUri(req), canEdit: canChangeSettings(u), ...googleView(db.store) } });
  });

  // ---------- connecting ----------
  app.post('/api/google/connect', async (req, res) => {
    const u = await admin(req, res);
    if (!u) return;
    const cfg = googleConfig(env);
    if (!cfg.configured) return res.status(400).json({ error: 'Google isn’t set up on this server yet. DubLow Digital adds the Google OAuth client first.' });
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = jwt.sign({ p: 'google-oauth', t: tenant?.id || null, sub: u.id, n: nonce }, secret(), { expiresIn: `${STATE_MINUTES}m` });
    res.cookie(STATE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure, maxAge: STATE_MINUTES * 60_000, path: '/api/google' });
    res.json({ result: { url: clientFor().authUrl({ state, redirectUri: redirectUri(req) }) } });
  });

  /** The state Google sends back, checked: { userId } or { error } (a short code for the page). */
  function checkState(req, user) {
    let claims;
    try { claims = jwt.verify(String(req.query.state || ''), secret()); } catch { return { error: 'state' }; }
    if (claims.p !== 'google-oauth') return { error: 'state' };
    if ((claims.t || null) !== (tenant?.id || null)) return { error: 'state' }; // another restaurant's
    const nonce = String(req.cookies?.[STATE_COOKIE] || '');
    if (!nonce || nonce.length !== String(claims.n || '').length || !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(String(claims.n)))) return { error: 'browser' };
    if (!user || user.id !== claims.sub) return { error: 'user' };
    if (!canChangeSettings(user)) return { error: 'user' };
    return { userId: claims.sub };
  }

  app.get('/api/google/callback', async (req, res) => {
    const back = (q) => { res.clearCookie(STATE_COOKIE, { path: '/api/google' }); res.redirect(302, `${appUrl(req)}/?${new URLSearchParams(q)}#/settings`); };
    try {
      await db.sync();
      const user = userOf(req);
      const st = checkState(req, user);
      if (st.error) return back({ google: 'error', why: st.error });
      if (req.query.error) return back({ google: 'error', why: req.query.error === 'access_denied' ? 'denied' : 'google' });
      const code = String(req.query.code || '');
      if (!code || code.length > 2000) return back({ google: 'error', why: 'google' });
      const google = clientFor();
      const tok = await google.exchangeCode(code, redirectUri(req));
      // One location only: pick it now (most restaurants). Several: the admin picks in Settings.
      let pick = null;
      try {
        const withToken = clientFor(tok.refreshToken);
        const accounts = await withToken.accounts();
        const all = [];
        for (const a of accounts.slice(0, 5)) for (const l of await withToken.locations(a.name)) all.push({ a, l });
        if (all.length === 1) pick = all[0];
      } catch (e) { if (!(e instanceof GoogleError)) throw e; } // listing can wait for the picker
      const at = new Date(now()).toISOString();
      await db.run((store) => {
        const prev = integration(store);
        saveIntegration(store, {
          refreshTokenEnc: box.seal(tok.refreshToken, TOKEN_CONTEXT), connectedAt: at, connectedBy: user.id, needsReconnect: false,
          accountId: pick ? pick.a.name : null, accountName: pick ? pick.a.accountName : '', locationId: pick ? pick.l.name : null,
          locationTitle: pick ? pick.l.title : '', locationAddress: pick ? pick.l.address : '',
          ...(prev.locationId && pick?.l.name !== prev.locationId ? { lastFullAt: null } : {}), // another location: read it all
        });
        audit(store, user.id, 'google.connected', { location: pick ? pick.l.title : null });
      }, { write: true });
      back({ google: pick ? 'connected' : 'pick' });
    } catch (e) {
      if (!(e instanceof GoogleError)) console.error('Google callback:', e);
      back({ google: 'error', why: e instanceof GoogleError ? e.code || 'google' : 'server' });
    }
  });

  async function listLocations() {
    const google = clientFor(tokenOf(db.store));
    const out = [];
    for (const a of (await google.accounts()).slice(0, 5)) {
      for (const l of await google.locations(a.name)) out.push({ account: a.name, accountName: a.accountName, location: l.name, title: l.title, address: l.address });
    }
    return out;
  }

  app.get('/api/google/locations', async (req, res) => {
    if (!(await admin(req, res))) return;
    if (!integration(db.store).refreshTokenEnc) return res.status(400).json({ error: 'Connect Google first' });
    try { res.json({ result: { locations: await listLocations() } }); } catch (e) { fail(res, e); }
  });

  app.post('/api/google/location', async (req, res) => {
    const u = await admin(req, res);
    if (!u) return;
    if (!integration(db.store).refreshTokenEnc) return res.status(400).json({ error: 'Connect Google first' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const found = (await listLocations()).find((l) => l.account === b.account && l.location === b.location);
      if (!found) return res.status(400).json({ error: 'That location isn’t one this Google account manages' });
      await db.run((store) => {
        const prev = integration(store);
        saveIntegration(store, { accountId: found.account, accountName: found.accountName, locationId: found.location, locationTitle: found.title, locationAddress: found.address,
          ...(prev.locationId !== found.location ? { lastFullAt: null, firstSyncAt: null } : {}) });
        audit(store, u.id, 'google.location', { location: found.title });
      }, { write: true });
      res.json({ result: googleView(db.store) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/google/disconnect', async (req, res) => {
    const u = await admin(req, res);
    if (!u) return;
    let token = '';
    try { token = tokenOf(db.store); } catch { token = ''; }
    const revoked = token ? await clientFor(token).revoke() : false;
    await db.run((store) => {
      saveIntegration(store, { refreshTokenEnc: null, accountId: null, accountName: '', locationId: null, locationTitle: '', locationAddress: '', connectedAt: null, connectedBy: null, needsReconnect: false, cronCursor: null });
      audit(store, u.id, 'google.disconnected', { revoked });
    }, { write: true });
    res.json({ result: { ...googleView(db.store), revoked } });
  });

  // ---------- syncing ----------
  const syncClient = () => clientFor(tokenOf(db.store));
  app.post('/api/google/sync', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    if (!googleConfig(env).configured) return res.status(400).json({ error: 'Google isn’t set up on this server yet. DubLow Digital adds the Google OAuth client first.' });
    const i = integration(db.store);
    if (!i.refreshTokenEnc) return res.status(400).json({ error: 'Connect Google first' });
    if (!i.locationId) return res.status(400).json({ error: 'Pick the Google Business Profile location first' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    let client;
    try { client = syncClient(); } catch { return res.status(409).json({ error: 'Connect Google again: ShiftBoard can’t read its saved access (the encryption key changed).' }); }
    const out = await runGoogleSync({ db, env, client, cursor: b.next || null, by: u.id, budgetMs, onCommit: (c) => onCommit(c, req) });
    if (!out.ok) return res.status(out.reconnect ? 409 : 502).json({ error: out.error, result: out });
    res.json({ result: out });
  });

  /** One restaurant's daily sync (the platform passes its address, for links in the alerts). */
  const googleCron = async ({ budgetMs: budget = budgetMs, base = '' } = {}) => {
    if (!googleConfig(env).configured) return { skipped: 'Google is not set up' };
    await db.sync();
    const i = integration(db.store);
    if (!i.refreshTokenEnc || !i.locationId) return { skipped: 'Google is not connected' };
    if (i.needsReconnect) return { skipped: 'Google needs to be connected again' };
    const saved = i.cronCursor;
    const resume = saved && now() - Date.parse(saved.savedAt) < CRON_RESUME_MS ? saved : null;
    const at = base ? new URL(base) : null;
    const linkReq = at ? { protocol: at.protocol.replace(':', ''), get: () => at.host } : null;
    let client;
    try { client = syncClient(); } catch (e) { return { ok: false, error: `Can’t read the saved Google access: ${e.message}` }; }
    const out = await runGoogleSync({ db, env, client, cursor: resume, by: 'cron', budgetMs: budget, onCommit: (c) => onCommit(c, linkReq) });
    return { ok: out.ok, finished: out.ok && !out.next, counts: out.counts, error: out.error || null };
  };
  app.locals.googleCron = googleCron; // the daily run: /api/cron/reviews (server/review-replies.js; the platform's in server/platform/index.js)

  return { clientFor, tokenOf: () => tokenOf(db.store), audit };
}
