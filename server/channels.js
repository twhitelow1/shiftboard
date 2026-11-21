// Phone notifications (Web Push) and text messages (Twilio) for each new in-app notification.
// Like email (server/app.js), they're sent after the database commit. A failed or slow send never
// fails or slows the request: the work starts after the response is on its way, and every error
// is logged and dropped. Push subscriptions the push service says are gone (404/410) are removed,
// and a number Twilio reports as unsubscribed (it replied STOP) has its texts turned off.
import express from 'express';
import { createService } from '../core/service.js';
import { canChangeSettings } from '../core/roles.js';
import { normalizePhone, formatPhone, maskPhone, plainText, textMessage, welcomeText, linkFor, smsAllowed,
  replyKeyword, applyTextReply } from '../core/notify-prefs.js';
import { createPusher } from './push.js';
import { createTexter, UNSUBSCRIBED } from './sms.js';

const CONCURRENCY = 6; // sends in flight at once
const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
const hostOf = (url) => { try { return new URL(url).host; } catch { return '?'; } };

/**
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} o.env
 * @param {object} [o.pusher]   server/push.js sender (tests pass a fake)
 * @param {object} [o.texter]   server/sms.js sender (tests pass one with a fake fetch)
 * @param {Function} o.background  keeps work alive after the response (waitUntil on Vercel)
 * @param {Function} o.appUrl      (req) => the app's base URL, as emails use it
 * @param {Function} o.signedIn    (req) => the signed-in user or null
 */
export function createChannels({ db, env = process.env, pusher = createPusher(env), texter = createTexter(env), background, appUrl, signedIn }) {
  const settings = () => createService(db.store).settings();
  const restaurant = () => settings().restaurantName || 'ShiftBoard';

  /** Send pushes and texts; never rejects. Returns { sent, failed, removed }. */
  async function deliver(pushes, texts) {
    await new Promise((r) => setImmediate(r)); // let the response go out first
    const gone = [];
    const stopped = new Set();
    let sent = 0;
    let failed = 0;
    const jobs = [...pushes.map((job) => ({ kind: 'push', job })), ...texts.map((job) => ({ kind: 'text', job }))];
    await eachLimited(jobs, CONCURRENCY, async ({ kind, job }) => {
      try {
        if (kind === 'push') {
          const r = await pusher.send(job.sub, job.message);
          if (r?.gone) { gone.push(job.sub); return; }
        } else {
          await texter.send(job.to, job.body);
        }
        sent++;
      } catch (e) {
        failed++;
        if (kind === 'text' && e?.code === UNSUBSCRIBED) stopped.add(job.to);
        const what = kind === 'push' ? `Phone notification (${hostOf(job.sub.endpoint)})` : `Text to ${maskPhone(job.to)}`;
        console.error(`${what} failed:`, e?.message || e?.statusCode || e);
      }
    });
    if (gone.length || stopped.size) {
      try {
        await db.run((s) => {
          for (const sub of gone) {
            const cur = s.get('pushSubscriptions', sub.id);
            if (cur && cur.endpoint === sub.endpoint) s.remove('pushSubscriptions', sub.id);
          }
          for (const phone of stopped) applyTextReply(s, { from: phone, action: 'stop' });
        }, { write: true });
      } catch (e) {
        console.error('Could not clean up phone notification settings:', e.message);
      }
    }
    return { sent, failed, removed: gone.length };
  }

  const pushMessage = (title, body, link) => ({ title, body, url: `/${String(link || '').startsWith('#') ? link : ''}` });
  // Just turned texts on (this request): their consent was recorded a moment ago.
  const justOptedIn = (u) => u?.smsNotifications === true && u.smsPhone && Date.now() - Date.parse(u.smsConsentAt || 0) < 60_000;

  /** After a commit: push and text each new notification (one message per person per change). Never throws. */
  function afterCommit(changes, req) {
    try {
      if (!pusher.enabled && !texter.enabled) return;
      const notes = changes.filter((c) => c.col === 'notifications' && c.isNew && c.doc).map((c) => c.doc);
      const optIns = req?.params?.method === 'sms.preferences'
        ? changes.filter((c) => c.col === 'users' && justOptedIn(c.doc)).map((c) => c.doc) : [];
      if (!notes.length && !optIns.length) return;
      const st = settings();
      const name = st.restaurantName || 'ShiftBoard';
      const url = appUrl(req);
      const byUser = new Map();
      for (const n of notes) byUser.set(n.userId, [...(byUser.get(n.userId) || []), n]);

      const pushes = [];
      const texts = [];
      for (const [userId, list] of byUser) {
        const u = db.store.get('users', userId);
        if (!u || u.active === false) continue;
        const [first] = list;
        const more = list.length - 1;
        if (pusher.enabled) {
          const message = pushMessage(name, more ? `${first.text} (+${more} more)` : first.text, first.link);
          for (const sub of db.store.list('pushSubscriptions', (s) => s.userId === userId)) pushes.push({ sub, message });
        }
        if (texter.enabled && smsAllowed(u, st)) {
          texts.push({ to: u.smsPhone, body: textMessage({ restaurant: name, text: first.text, url: linkFor(url, first.link), more }) });
        }
      }
      if (texter.enabled && st.smsNotifications !== false) {
        for (const u of optIns) texts.push({ to: u.smsPhone, body: welcomeText({ restaurant: name, url }) });
      }
      if (pushes.length || texts.length) background(deliver(pushes, texts));
    } catch (e) {
      console.error('Phone notifications failed:', e.message);
    }
  }

  function routes(app) {
    // My Shifts → Phone notifications → Send me a test: every phone I turned them on for.
    app.post('/api/push/test', async (req, res) => {
      await db.sync();
      const u = signedIn(req);
      if (!u) return res.status(401).json({ error: 'Please sign in' });
      if (!pusher.enabled) return res.status(400).json({ error: 'Phone notifications aren’t set up yet' });
      const subs = db.store.list('pushSubscriptions', (s) => s.userId === u.id);
      if (!subs.length) return res.status(400).json({ error: 'Turn on phone notifications first' });
      const message = pushMessage(restaurant(), 'Test: phone notifications are working.', '#/my');
      const r = await deliver(subs.map((sub) => ({ sub, message })), []);
      if (!r.sent) {
        return res.status(502).json({ error: r.removed ? 'This phone’s sign-up expired. Turn notifications on again.' : 'The notification could not be sent. Try again in a minute.' });
      }
      res.json({ result: r });
    });

    // Settings → Text messages → Send me a test text (admins).
    app.post('/api/sms/test', async (req, res) => {
      await db.sync();
      const u = signedIn(req);
      if (!u) return res.status(401).json({ error: 'Please sign in' });
      if (!canChangeSettings(u)) return res.status(403).json({ error: 'Admins only' });
      if (!texter.enabled) return res.status(400).json({ error: 'Text messages aren’t set up yet. Add the TWILIO_ settings in Vercel, then redeploy.' });
      const to = normalizePhone(req.body?.phone || u.smsPhone || u.phone);
      if (!to) return res.status(400).json({ error: 'Enter your mobile number, like (303) 555-0123' });
      try {
        await texter.send(to, plainText(`${restaurant()}: Test text from ShiftBoard. Texts are working. Reply STOP to opt out.`));
        res.json({ result: { ok: true, to: formatPhone(to) } });
      } catch (e) {
        res.status(502).json({ error: e.message }); // Twilio's reason (unverified number, 10DLC…) helps the admin fix setup
      }
    });

    // Twilio calls this when someone texts the restaurant's number. STOP turns that number's texts
    // off and START turns them back on. Twilio itself sends the compliance reply and blocks texts to
    // numbers that replied STOP, so the answer is an empty TwiML response.
    app.post('/api/twilio/inbound', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
      const params = req.body && typeof req.body === 'object' ? { ...req.body } : {};
      const urls = [env.TWILIO_WEBHOOK_URL, `${appUrl(req)}${req.originalUrl}`, `${req.protocol}://${req.get('host')}${req.originalUrl}`];
      if (!texter.enabled || !texter.validRequest(req.get('X-Twilio-Signature'), urls, params)) {
        return res.status(403).type('text/plain').send('Forbidden');
      }
      const action = replyKeyword(params.Body, params.OptOutType);
      if (action) {
        try {
          await db.run((s) => applyTextReply(s, { from: params.From, action }), { write: true });
        } catch (e) {
          console.error('Text reply could not be saved:', e.message);
          return res.status(500).type('text/plain').send('Try again');
        }
      }
      res.type('text/xml').send(TWIML_OK);
    });
  }

  return {
    /** For createService: what's set up (the demo passes nothing). */
    info: { push: { enabled: pusher.enabled, publicKey: pusher.publicKey }, sms: { enabled: texter.enabled } },
    /** For /api/config. */
    config: () => ({ push: pusher.enabled, sms: texter.enabled, smsFrom: texter.from ? formatPhone(texter.from) : null }),
    afterCommit,
    routes,
    deliver,
  };
}
