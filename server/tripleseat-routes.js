// HTTP routes for the Tripleseat integration. Mounted by server/app.js.
//   GET  /api/tripleseat/status          managers: is Tripleseat configured (env names only, never values)
//   POST /api/tripleseat/sync            managers: one chunk of a sync run; the UI calls again with `next`
//   POST /api/tripleseat/webhook/:token  Tripleseat's webhook: a nudge to sync the one event it names.
//                                        :token is this restaurant's own (Settings shows the link to admins),
//                                        and X-Signature is checked when TRIPLESEAT_WEBHOOK_SECRET is set.
//   GET  /api/cron/tripleseat            Vercel Cron, daily. Requires Authorization: Bearer <CRON_SECRET>.
// On the platform each restaurant has its own host, so its webhook link and its data are its own.
import crypto from 'node:crypto';
import express from 'express';
import { canManageSchedule } from '../core/roles.js';
import { integration } from '../core/tripleseat.js';
import { createTripleseatClient, tripleseatConfig } from './tripleseat.js';
import { runTripleseatSync, syncOneEvent } from './tripleseat-sync.js';
import { cronAuthorized } from './toast-routes.js';

export const BUDGET_MS = 18_000; // leaves room inside the 30 s function limit for boot and the final write
export const NOT_CONNECTED = 'Tripleseat isn’t connected yet. Ask DubLow Digital to connect it.';
const SIGNATURE_TOLERANCE_S = 300;
const WEBHOOKS_PER_MINUTE = 120;
const CRON_RESUME_MS = 26 * 3_600_000;

const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
/** Constant-time string comparison (hashes first, so lengths don't leak). */
export const sameSecret = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));

/**
 * Tripleseat's webhook signature: X-Signature: t=<unix time>,v1=<hex HMAC-SHA256>, keyed with the
 * endpoint's signing key, over "<t>.<raw body>" (the timestamp is part of what's signed, so an old
 * delivery can't be replayed). Returns { ok, reason }. Compared in constant time; 5 minutes of clock skew.
 */
export function verifySignature(header, rawBody, secret, { now = Date.now(), toleranceS = SIGNATURE_TOLERANCE_S } = {}) {
  if (!secret) return { ok: false, reason: 'no secret' };
  const parts = {};
  for (const p of String(header || '').split(',')) {
    const i = p.indexOf('=');
    if (i < 1) continue;
    const k = p.slice(0, i).trim();
    (parts[k] ||= []).push(p.slice(i + 1).trim());
  }
  const t = Number(parts.t?.[0]);
  const sigs = (parts.v1 || []).filter((v) => /^[0-9a-f]{64}$/i.test(v));
  if (!Number.isFinite(t) || !sigs.length) return { ok: false, reason: 'missing' };
  const secs = t > 1e12 ? t / 1000 : t;
  if (Math.abs(now / 1000 - secs) > toleranceS) return { ok: false, reason: 'stale' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const want = crypto.createHmac('sha256', String(secret)).update(`${parts.t[0]}.`).update(body).digest();
  const ok = sigs.some((v) => { const got = Buffer.from(v.toLowerCase(), 'hex'); return got.length === want.length && crypto.timingSafeEqual(got, want); });
  return ok ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** The Tripleseat event ids a webhook names: its event, or a booking's events (at most 5). */
export function webhookEventIds(body) {
  const ok = (v) => (v != null && /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) ? String(v) : null);
  const one = ok(body?.event?.id ?? body?.event_id ?? body?.data?.event?.id);
  if (one) return [one];
  const list = body?.booking?.events || body?.data?.booking?.events;
  return Array.isArray(list) ? [...new Set(list.map((e) => ok(e?.id ?? e)).filter(Boolean))].slice(0, 5) : [];
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} o.env
 * @param {(req) => object|null} o.userOf  the signed-in user for a request (after db.sync)
 * @param {(changes, req) => void} [o.onCommit]  sends the notifications a sync writes (email, push, texts)
 * @param {boolean} [o.managed]  a restaurant on the platform whose keys DubLow sets in the platform console
 */
export function mountTripleseat(app, { db, env, userOf, onCommit = () => {}, managed = false, budgetMs = BUDGET_MS, makeClient = () => createTripleseatClient({ env }), now = () => Date.now() }) {
  const manager = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canManageSchedule(u)) { res.status(403).json({ error: 'Managers only' }); return null; }
    return u;
  };
  const notReady = (cfg) => (managed ? NOT_CONNECTED : `Tripleseat isn’t set up yet. Add ${cfg.missing.join(', ')} in Vercel, then redeploy.`);

  app.get('/api/tripleseat/status', async (req, res) => {
    if (!(await manager(req, res))) return;
    const { configured, auth, missing, present, host, siteId, locationId, webhookSecret, cron } = tripleseatConfig(env);
    res.json({ result: { configured, auth, missing, present, host, siteId, locationId, webhookSecret, cron } });
  });

  app.post('/api/tripleseat/sync', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const cfg = tripleseatConfig(env);
    if (!cfg.configured) return res.status(400).json({ error: notReady(cfg) });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await runTripleseatSync({ db, env, client: makeClient(), cursor: b.next || null, by: u.id, budgetMs, onCommit: (c) => onCommit(c, req) });
    if (!out.ok) return res.status(502).json({ error: out.error, result: out });
    res.json({ result: out });
  });

  // Webhooks: Tripleseat posts JSON; keep the exact bytes for the signature (server/app.js's JSON parser
  // keeps them too, as req.rawBody, when it got there first).
  let window = { start: 0, n: 0 };
  app.post('/api/tripleseat/webhook/:token', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const cfg = tripleseatConfig(env);
    if (!cfg.configured) return res.status(404).json({ error: 'Not found' });
    await db.sync();
    if (!sameSecret(req.params.token, integration(db.store).webhookToken)) return res.status(404).json({ error: 'Not found' });
    const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
    if (cfg.webhookSecret) {
      const v = verifySignature(req.get('x-signature'), raw, env.TRIPLESEAT_WEBHOOK_SECRET, { now: now() });
      if (!v.ok) {
        console.warn(`Tripleseat webhook refused: signature ${v.reason}`); // never the body or the header
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    const t = now();
    if (t - window.start > 60_000) window = { start: t, n: 0 };
    if (++window.n > WEBHOOKS_PER_MINUTE) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    const ids = webhookEventIds(body);
    const trigger = String(body?.webhook_trigger_type || body?.trigger || '').slice(0, 60);
    if (!ids.length) return res.json({ result: { ignored: true } }); // leads and the like: nothing for the schedule
    const client = makeClient();
    const results = [];
    for (const id of ids) results.push(await syncOneEvent({ db, env, client, eventId: id, trigger, onCommit: (c) => onCommit(c, req) }));
    // Always 200 once it's authentic: a failed sync is retried by the daily one, not by Tripleseat resending.
    res.json({ result: { ok: results.every((r) => r.ok), events: results.map((r) => ({ id: r.eventId, action: r.action })) } });
  });

  // One restaurant's daily sync; on the platform, server/platform/index.js runs it for every restaurant
  // and passes its address (base), so links in the emails it sends point at the restaurant.
  const tripleseatCron = async ({ budgetMs: budget = budgetMs, base = '' } = {}) => {
    const cfg = tripleseatConfig(env);
    if (!cfg.configured) return { skipped: 'Tripleseat is not set up' };
    await db.sync();
    const saved = integration(db.store).cronCursor;
    const resume = saved && now() - Date.parse(saved.savedAt) < CRON_RESUME_MS ? saved : null;
    const at = base ? new URL(base) : null;
    const linkReq = at ? { protocol: at.protocol.replace(':', ''), get: () => at.host } : null;
    const out = await runTripleseatSync({ db, env, client: makeClient(), cursor: resume, by: 'cron', budgetMs: budget, onCommit: (c) => onCommit(c, linkReq) });
    return { ok: out.ok, finished: out.ok && !out.next, counts: out.counts, error: out.error || null, ...(out.warnings ? { warnings: out.warnings } : {}) };
  };
  app.locals.tripleseatCron = tripleseatCron;

  app.get('/api/cron/tripleseat', async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    const result = await tripleseatCron();
    res.status(result.ok === false ? 502 : 200).json({ result });
  });
}
