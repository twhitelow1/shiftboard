// Announcements going out (the rules are in core/announcements.js). An announcement sent now is saved as
// "queued"; one scheduled for later as "scheduled". Then, in the background after the commit:
//
//   release   (one write) the audience is worked out, everyone gets the in-app notification, and each person
//             gets a delivery record per channel (queued, or skipped with the reason). These notifications
//             are written here, not in the request, so the usual email / push / text copies of new
//             notifications (server/app.js, channels.js, expo-push.js) never see them: the announcement's
//             own channels decide.
//   batches   (a write to claim up to 50 people, the sending, a write with the results) until nothing is left
//             or the time budget runs out. Phone notifications (web push and the phone app), then email
//             through Resend's batch API (at most 2 calls a second), then texts through Twilio (at most 5 a
//             second; the Messaging Service queues them to the campaign's throughput). Consent is checked
//             when a batch is claimed and, for texts, again on fresh data right before each one.
//   results   sent / failed (with the provider's reason, phone numbers masked) / skipped. A rate limit or the
//             end of the time budget puts a delivery back in the queue for the next run.
//
// What starts a run: any API request to the restaurant (kick, after the response's commit, kept alive with
// waitUntil on Vercel), and the Vercel Cron /api/cron/announcements (vercel.json, every 5 minutes), which
// sends scheduled announcements when their time comes and finishes big ones. Two instances never send the
// same delivery: claiming happens under the database's write lock.
import crypto from 'node:crypto';
import { createService } from '../core/service.js';
import { releaseDue, claimWork, applyResults, hasWork, pushContent, smsText, inLanguage, noteText } from '../core/announcements.js';
import { smsAllowed, applyTextReply } from '../core/notify-prefs.js';
import { announcementEmail, deliverable } from './email.js';
import { UNSUBSCRIBED } from './sms.js';
import { cronAuthorized } from './toast-routes.js';
import { validSchemaName } from './db.js';
import { isPaused } from './platform/plans.js';

const INSTANCE = crypto.randomBytes(4).toString('hex');
const BATCH = 50; // people per claimed batch
const EMAIL_GAP_MS = 600; // Resend: 2 requests a second per team (each request carries up to 100 emails)
const TEXT_GAP_MS = 200; // Twilio: at most 5 texts a second from here
const PUSH_CONCURRENCY = 6;
export const BUDGET_MS = 20_000; // inside the 30-second function limit
const MIN_LEFT_MS = 4_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
/** A provider's error for the record: short, with phone numbers and email addresses masked. */
const errorText = (e) => String(e?.message || e?.statusCode || e || 'error').replace(/\+?\d[\d\s().-]{6,}\d/g, '…').replace(/[^\s@]+@[^\s@]+/g, '…').slice(0, 200);

/**
 * Mount the cron route and the kick, and return what createService needs to know.
 * @returns {{ info: object, kick: Function, run: Function }}
 */
export function mountAnnouncements(app, { db, env, mailer, channels, expoPush, background, appUrl, has, brandOf, now = () => Date.now() }) {
  const { pusher, texter } = channels.senders;
  // What can go out here: the composer's summary shows the rest as "not set up". Texts need the plan's sms too.
  const info = { push: !!pusher.enabled, appPush: !!expoPush.enabled, email: !!mailer.enabled, sms: !!texter.enabled && has('sms') };
  const settingsOf = (store) => createService(store).settings();
  const ctx = (store) => ({ settings: settingsOf(store), channels: info, now: new Date(now()) });
  let running = null;
  let again = false;
  let lastBase = ''; // the restaurant's address from its last request, for links sent from a cron run
  const paced = { email: 0, text: 0 };
  const pace = async (kind, gap) => {
    const wait = paced[kind] + gap - Date.now();
    if (wait > 0) await sleep(wait);
    paced[kind] = Date.now();
  };

  /** After a request: start a run when something is due (one at a time per instance; a busy run goes round again). */
  function kick(req) {
    try {
      if (!has('announcements')) return;
      if (req) lastBase = appUrl(req) || lastBase;
      if (running) { again = true; return; }
      if (!hasWork(db.store, new Date(now()))) return;
      running = run(req).finally(() => { running = null; });
      background(running);
    } catch (e) {
      console.error('Announcements could not start:', e.message);
    }
  }

  /** Release what's due, then send batches until nothing is left or the budget runs out. Never rejects. */
  async function run(req, { budgetMs = BUDGET_MS, base } = {}) {
    const started = Date.now();
    const left = () => budgetMs - (Date.now() - started);
    const out = { released: 0, batches: 0, sent: 0, failed: 0 };
    const link = (id) => `${base || (req ? appUrl(req) : '') || lastBase}/#/announcements/${id}`;
    try {
      for (let round = 0; round < 3; round++) {
        again = false;
        out.released += (await db.run((s) => releaseDue(s, ctx(s)), { write: true })).length;
        while (left() > MIN_LEFT_MS) {
          const work = await db.run((s) => claimWork(s, { ...ctx(s), by: INSTANCE, max: BATCH }), { write: true });
          if (!work) break;
          const { results, cleanup } = await send(work, req, link(work.id), left);
          await db.run((s) => { applyResults(s, work.id, results, ctx(s)); tidy(s, cleanup); }, { write: true });
          out.batches++;
          for (const r of results) { if (r.s === 'sent') out.sent++; else if (r.s === 'failed') out.failed++; }
        }
        if (!again || left() <= MIN_LEFT_MS) break;
      }
    } catch (e) {
      console.error('Announcements run failed:', e.message);
      out.error = e.message;
    }
    return out;
  }

  /** Send one claimed batch. Returns { results: [{ userId, channel, s, r }], cleanup }. */
  async function send(work, req, link, left) {
    const st = settingsOf(db.store);
    const restaurant = st.restaurantName || 'ShiftBoard';
    const results = [];
    const cleanup = { subs: [], tokens: [], tickets: [], stopped: [] };
    const result = (userId, channel, s, r) => results.push({ userId, channel, s, ...(r ? { r } : {}) });
    const jobsFor = (ch) => work.jobs.filter((j) => j.channels.includes(ch));
    const route = `#/announcements/${work.id}`;

    // Phone notifications: every browser (web push) and phone (the app) the person turned them on for. Sent when one took it.
    const pushJobs = jobsFor('push');
    if (pushJobs.length) {
      const ok = new Set();
      const errors = new Map();
      const web = [];
      const appMsgs = [];
      for (const j of pushJobs) {
        const content = pushContent(work.ann, j.lang);
        if (pusher.enabled) for (const sub of db.store.list('pushSubscriptions', (x) => x.userId === j.userId)) web.push({ userId: j.userId, sub, message: { ...content, url: `/${route}` } });
        if (expoPush.enabled) {
          const u = db.store.get('users', j.userId);
          for (const d of db.store.list('deviceTokens', (x) => x.userId === j.userId && (x.v || 0) === (u?.sessionVersion || 0))) {
            appMsgs.push({ userId: j.userId, message: { to: d.token, title: restaurant, body: noteText(inLanguage(work.ann, j.lang)), sound: 'default', priority: 'high', channelId: 'default', data: { link: route, announcementId: work.id } } });
          }
        }
      }
      await eachLimited(web, PUSH_CONCURRENCY, async ({ userId, sub, message }) => {
        try {
          const r = await pusher.send(sub, message);
          if (r?.gone) { cleanup.subs.push(sub); if (!errors.has(userId)) errors.set(userId, 'expired'); } else ok.add(userId);
        } catch (e) { errors.set(userId, errorText(e)); }
      });
      if (appMsgs.length) {
        try {
          const { tickets, unregistered } = await expoPush.send(appMsgs.map((m) => m.message));
          const took = new Set(tickets.map((t) => t.token));
          for (const m of appMsgs) {
            if (took.has(m.message.to)) ok.add(m.userId);
            else if (!errors.has(m.userId)) errors.set(m.userId, unregistered.includes(m.message.to) ? 'expired' : 'error');
          }
          cleanup.tokens.push(...unregistered);
          cleanup.tickets.push(...tickets);
        } catch (e) { for (const m of appMsgs) if (!ok.has(m.userId)) errors.set(m.userId, errorText(e)); }
      }
      for (const j of pushJobs) {
        if (ok.has(j.userId)) result(j.userId, 'push', 'sent');
        else if (errors.has(j.userId)) result(j.userId, 'push', 'failed', errors.get(j.userId));
        else result(j.userId, 'push', 'skipped', 'noDevice');
      }
    }

    // Email: Resend's batch API, up to 100 a call, calls spaced out for its rate limit.
    const emailJobs = jobsFor('email');
    for (let i = 0; i < emailJobs.length; i += 100) {
      const chunk = emailJobs.slice(i, i + 100);
      if (left() < 2500) { for (const j of chunk) result(j.userId, 'email', 'queued', 'outOfTime'); continue; }
      const sendable = chunk.filter((j) => deliverable(j.email));
      for (const j of chunk) if (!deliverable(j.email)) result(j.userId, 'email', 'skipped', 'noEmail');
      if (!sendable.length) continue;
      const messages = sendable.map((j) => {
        const v = inLanguage(work.ann, j.lang);
        const user = db.store.get('users', j.userId) || { name: j.name, email: j.email };
        return announcementEmail({ user: { ...user, email: j.email }, title: v.title, body: v.body, link, restaurant, brand: brandOf(req), lang: j.lang });
      });
      try {
        await pace('email', EMAIL_GAP_MS);
        await mailer.sendMany(messages, { idempotencyKey: `ann-${work.id}-${work.claim}-${i}` });
        for (const j of sendable) result(j.userId, 'email', 'sent');
      } catch (e) {
        const limited = /\b429\b/.test(String(e?.message));
        for (const j of sendable) result(j.userId, 'email', limited ? 'queued' : 'failed', limited ? 'rateLimited' : errorText(e));
      }
    }

    // Texts: one at a time, paced; consent looked at again on fresh data right before each one.
    for (const j of jobsFor('sms')) {
      if (left() < 2000) { result(j.userId, 'sms', 'queued', 'outOfTime'); continue; }
      try { await db.sync(); } catch (e) { result(j.userId, 'sms', 'queued', 'outOfTime'); continue; }
      const u = db.store.get('users', j.userId);
      if (!u || !smsAllowed(u, settingsOf(db.store)) || u.smsPhone !== j.to) { result(j.userId, 'sms', 'skipped', 'consentWithdrawn'); continue; }
      const v = inLanguage(work.ann, j.lang);
      const { text } = smsText({ restaurant, title: v.title, body: v.body, lang: j.lang, url: link });
      try {
        await pace('text', TEXT_GAP_MS);
        await texter.send(j.to, text);
        result(j.userId, 'sms', 'sent');
      } catch (e) {
        if (e?.code === UNSUBSCRIBED) { cleanup.stopped.push(j.to); result(j.userId, 'sms', 'failed', 'stopped'); } else if (e?.status === 429 || e?.code === 20429) result(j.userId, 'sms', 'queued', 'rateLimited');
        else result(j.userId, 'sms', 'failed', errorText(e));
      }
    }
    return { results, cleanup };
  }

  /** After a batch: phones and browsers that are gone, the phone app's tickets (checked later), numbers that replied STOP. */
  function tidy(s, { subs, tokens, tickets, stopped }) {
    const at = new Date(now()).toISOString();
    for (const sub of subs) { const cur = s.get('pushSubscriptions', sub.id); if (cur && cur.endpoint === sub.endpoint) s.remove('pushSubscriptions', sub.id); }
    if (tokens.length) for (const d of s.list('deviceTokens', (x) => tokens.includes(x.token))) s.remove('deviceTokens', d.id);
    for (const k of tickets) s.insert('pushTickets', { id: k.id, token: k.token, at }); // server/expo-push.js checks their receipts
    for (const phone of stopped) applyTextReply(s, { from: phone, action: 'stop', word: 'STOP', body: 'Twilio error 21610: the number replied STOP' });
  }

  // Every API request may start a run, just before its response goes out (so waitUntil keeps it alive on Vercel).
  app.use('/api/rpc', (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => { kick(req); return json(body); };
    next();
  });
  // The Vercel Cron (one restaurant; the platform runs every restaurant's from server/platform/index.js).
  app.get('/api/cron/announcements', async (req, res) => {
    if (!cronAuthorized(req.get('authorization'), env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    if (!has('announcements')) return res.json({ result: { skipped: 'Not in plan' } });
    await db.sync();
    res.json({ result: await run(null) });
  });
  app.locals.announcementsCron = async ({ budgetMs, base } = {}) => { await db.sync(); return run(null, { budgetMs, base }); };
  app.locals.announcementsSettled = () => running || Promise.resolve();

  return { info, kick, run };
}

/**
 * The platform's cron: every active restaurant with announcements in its plan that has something due (one
 * cheap query per restaurant; its runtime only opens when there's work), each within the time left.
 */
export async function announcementsCronAll({ registry, runtime, cache, conn, env, base = () => '' }) {
  const budget = Number(env.CRON_BUDGET_MS) || 18_000;
  const started = Date.now();
  const snap = await registry.snapshot({ fresh: true });
  const nowIso = new Date().toISOString();
  const tenants = [];
  for (const t of snap.list.filter((x) => !isPaused(x.status) && x.resolved?.announcements)) {
    const left = budget - (Date.now() - started);
    if (left < MIN_LEFT_MS) { tenants.push({ slug: t.slug, skipped: 'Out of time; the next run picks it up' }); continue; }
    if (!validSchemaName(t.schema_name)) continue;
    try {
      const { rows } = await conn.query(`SELECT 1 FROM "${t.schema_name}".docs WHERE col = 'announcements' AND NOT deleted AND data->>'next' IS NOT NULL AND data->>'next' <= $1 LIMIT 1`, [nowIso]);
      if (!rows.length) continue;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '3F000') tenants.push({ slug: t.slug, ok: false, error: e.message });
      continue;
    }
    let rt;
    try { rt = await runtime(t); } catch (e) { tenants.push({ slug: t.slug, ok: false, error: e.message }); continue; }
    const release = cache.hold(rt);
    try {
      const r = await rt.app.locals.announcementsCron({ budgetMs: Math.min(left - 1000, BUDGET_MS), base: base(t) });
      tenants.push({ slug: t.slug, ok: !r.error, ...r });
    } catch (e) {
      tenants.push({ slug: t.slug, ok: false, error: e.message });
    } finally { release(); }
  }
  return { tenants, ms: Date.now() - started };
}
