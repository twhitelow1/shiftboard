// View as on the server: a Super Admin sees the web app exactly as one person (or one role) sees it, read-only.
//
//   POST /api/view-as/start { userId } | { role, positions?, rooms?, typical? } (+ draft: unsaved Roles & features)
//   POST /api/view-as/stop
//   GET  /api/view-as/options   the people (at or below the Super Admin), roles, positions and rooms to pick from
//
// The view is a second cookie, sb_view: a signed token (45 minutes) naming the real Super Admin, their session
// version and restaurant, and who they're viewing. It never replaces the session, and it's only honored next
// to that same Super Admin's cookie session: never with a bearer token (the phone app), never in a DubLow
// support session, never once they're no longer a Super Admin or the person now outranks them.
//
// One place enforces it (server/app.js calls these): the /api middleware below marks the request as a view
// (req.sbView) and refuses every write route and the routes that show someone's secrets; /api/rpc runs only
// reads, computed as the viewed person on a throwaway copy of the data (rpc below). Every start and stop goes in
// the restaurant's audit log (auditLog), including views that ran out.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createService, AppError } from '../core/service.js';
import { todayStr } from '../core/time.js';
import { scheduleAreas } from '../core/areas.js';
import { cleanDraft } from '../core/role-features.js';
import {
  VIEW_MINUTES, VIEW_READ_ONLY, VIEW_NOT_PHONE, VIEW_NOT_SUPPORT, VIEW_HIDDEN,
  isViewRead, resolveTarget, viewedPerson, viewCall, viewInfo, viewOptions, viewAudit, AUDIT_START, AUDIT_STOP,
} from '../core/view-as.js';

export const VIEW_COOKIE = 'sb_view';
// Reads that show someone's secrets (their sign-in details, consent records with IPs): never while viewing.
const HIDDEN_ROUTES = new Set(['/auth/security', '/consents.csv']);

/**
 * @param {object} d  db, tenant, now(), secret(), session(store, token), bearer(req), cookie (the session cookie's
 *   name), cookieOpts, langFor(user)
 */
export function createViewAs(d) {
  const { db, tenant, now } = d;
  const iso = (ms) => new Date(ms).toISOString();
  const clear = (res) => res.clearCookie(VIEW_COOKIE, { ...d.cookieOpts, maxAge: undefined });

  /** Write a stop to the audit log once per view (a view's requests can race to notice it ran out). */
  const auditStop = (real, claims, reason) => db.run((s) => {
    if (s.list('auditLog', (x) => x.action === AUDIT_STOP && x.details?.jti === claims.jti).length) return;
    viewAudit(s, { action: AUDIT_STOP, real, target: claims.va, at: iso(now()), details: { reason, jti: claims.jti, startedAt: iso(claims.iat * 1000) } });
  }, { write: true });

  /** The view this request is in, or null (and the cookie cleared when it's over or no longer holds). */
  async function current(req, res) {
    let claims;
    try { claims = jwt.verify(String(req.cookies[VIEW_COOKIE]), d.secret(), { ignoreExpiration: true }); } catch { clear(res); return null; }
    const sess = d.session(db.store, req.cookies[d.cookie]); // the real session, from its cookie only
    const real = sess?.user;
    if (claims.p !== 'view' || !real || real.id !== claims.sub || (tenant && claims.t !== tenant.id)) { clear(res); return null; }
    if (sess.claims.sup || (real.sessionVersion || 0) !== (claims.v || 0)) { clear(res); await auditStop(real, claims, 'ended'); return null; }
    if (claims.exp * 1000 <= now()) { clear(res); await auditStop(real, claims, 'expired'); return null; }
    const actor = viewedPerson(db.store, real, claims.va, d.langFor(real));
    if (!actor) { clear(res); await auditStop(real, claims, 'ended'); return null; }
    return { real, claims, target: claims.va, draft: claims.d || null, actor, until: claims.exp * 1000 };
  }

  /** /api middleware: mark a view, and refuse anything but reads while in one. */
  async function middleware(req, res, next) {
    if (!req.cookies?.[VIEW_COOKIE] || d.bearer(req)) return next(); // the phone app is never in a view
    try {
      await db.sync();
      req.sbView = await current(req, res);
    } catch (e) {
      return next(e);
    }
    if (!req.sbView || req.path.startsWith('/view-as/') || req.path.startsWith('/rpc/')) return next(); // RPCs: rpc() below
    if (HIDDEN_ROUTES.has(req.path)) return res.status(403).json({ error: VIEW_HIDDEN, viewAs: true });
    if (req.method === 'GET' || req.method === 'HEAD') return next(); // photos, statuses: as the viewed person (whoIs in app.js)
    res.status(403).json({ error: VIEW_READ_ONLY, viewAs: true }); // every write: sign-out, password, consent, push, texts…
  }

  /** An RPC while viewing: reads only, computed as the viewed person on a copy of the data that's never saved. */
  async function rpc(view, method, body, serviceOpts) {
    if (!isViewRead(method)) throw new AppError(403, VIEW_READ_ONLY); // before touching the database
    await db.sync();
    return viewCall(db.store, { ...view, lang: d.langFor(view.real) }, method, body, serviceOpts);
  }

  function routes(app) {
    const wrap = (fn) => async (req, res) => {
      try { await fn(req, res); } catch (e) {
        const status = e instanceof AppError ? e.status : 500;
        if (status === 500) console.error('View as:', e);
        if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.message });
      }
    };
    /** The Super Admin behind the request (cookie session only): their user, or a refusal. */
    const realOf = async (req) => {
      if (d.bearer(req) || req.body?.client === 'mobile') throw new AppError(403, VIEW_NOT_PHONE);
      await db.sync();
      const sess = d.session(db.store, req.cookies[d.cookie]);
      if (!sess) throw new AppError(401, 'Please sign in');
      if (sess.claims.sup) throw new AppError(403, VIEW_NOT_SUPPORT);
      return sess.user;
    };

    app.get('/api/view-as/options', wrap(async (req, res) => {
      const real = await realOf(req);
      const st = createService(db.store).settings();
      res.set('Cache-Control', 'no-store');
      res.json({ result: viewOptions(db.store, real, { areas: st.areas?.length ? st.areas : scheduleAreas(st) }) });
    }));

    app.post('/api/view-as/start', wrap(async (req, res) => {
      const real = await realOf(req);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const target = resolveTarget(db.store, real, body, { today: todayStr(new Date(now())) });
      const draft = body.draft ? cleanDraft(body.draft) : null;
      if (req.sbView) await auditStop(real, req.sbView.claims, 'switched'); // straight from another view
      const iat = Math.floor(now() / 1000);
      const claims = { p: 'view', sub: real.id, v: real.sessionVersion || 0, ...(tenant ? { t: tenant.id } : {}), va: target, ...(draft ? { d: draft } : {}),
        iat, exp: iat + VIEW_MINUTES * 60, jti: crypto.randomBytes(12).toString('base64url') };
      const until = claims.exp * 1000;
      await db.run((s) => viewAudit(s, { action: AUDIT_START, real, target, at: iso(now()), details: { jti: claims.jti, until: iso(until), draft: !!draft } }), { write: true });
      res.cookie(VIEW_COOKIE, jwt.sign(claims, d.secret()), { ...d.cookieOpts, maxAge: VIEW_MINUTES * 60_000 });
      res.json({ result: viewInfo(db.store, real, target, { until, draft, lang: d.langFor(real) }) });
    }));

    // Exit view: always allowed (the middleware lets /view-as/ through).
    app.post('/api/view-as/stop', wrap(async (req, res) => {
      const view = req.sbView;
      clear(res);
      if (view) await auditStop(view.real, view.claims, 'exit');
      res.json({ result: { ok: true } });
    }));
  }

  return { middleware, rpc, routes };
}
