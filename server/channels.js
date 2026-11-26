// Phone notifications (Web Push) and text messages (Twilio) for each new in-app notification.
// Like email (server/app.js), they're sent after the database commit. A failed or slow send never
// fails or slows the request: the work starts after the response is on its way, and every error
// is logged and dropped. Push subscriptions the push service says are gone (404/410) are removed,
// and a number Twilio reports as unsubscribed (it replied STOP) has its texts turned off.
//
// Texts need the person's own consent (users.smsConsent, core/consent.js), checked when the texts are picked
// and again right before each one is sent, so a STOP that arrived in between always wins.
import express from 'express';
import { createService } from '../core/service.js';
import { canChangeSettings } from '../core/roles.js';
import { normalizePhone, formatPhone, maskPhone, textMessage, welcomeText, testText, linkFor, smsAllowed,
  replyKeyword, applyTextReply } from '../core/notify-prefs.js';
import { langOf } from '../core/i18n.js';
import { msg } from '../core/messages.js';
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

  /** Is this text still allowed? The latest data (a STOP may have just come in on another instance). */
  function stillAllowed(job) {
    const u = job.userId ? db.store.get('users', job.userId) : null; // every text is for one person who agreed to texts
    return !!u && smsAllowed(u, settings()) && u.smsPhone === job.to;
  }

  /** Send pushes and texts; never rejects. Returns { sent, failed, removed, skipped }. */
  async function deliver(pushes, texts) {
    await new Promise((r) => setImmediate(r)); // let the response go out first
    const gone = [];
    const stopped = new Set();
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    if (texts.length) { try { await db.sync(); } catch (e) { console.error('Could not re-check text consent:', e.message); texts = []; } }
    const jobs = [...pushes.map((job) => ({ kind: 'push', job })), ...texts.map((job) => ({ kind: 'text', job }))];
    await eachLimited(jobs, CONCURRENCY, async ({ kind, job }) => {
      try {
        if (kind === 'push') {
          const r = await pusher.send(job.sub, job.message);
          if (r?.gone) { gone.push(job.sub); return; }
        } else {
          if (!stillAllowed(job)) { skipped++; return; } // consent re-checked right before sending
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
          for (const phone of stopped) applyTextReply(s, { from: phone, action: 'stop', word: 'STOP', body: 'Twilio error 21610: the number replied STOP' });
        }, { write: true });
      } catch (e) {
        console.error('Could not clean up phone notification settings:', e.message);
      }
    }
    return { sent, failed, removed: gone.length, skipped };
  }

  const pushMessage = (title, body, link) => ({ title, body, url: `/${String(link || '').startsWith('#') ? link : ''}` });
  // The first opt-in ever: core stamps smsWelcomedAt once (consent screen, My Shifts); never on START or a re-opt-in.
  const welcomeDue = (c) => c.col === 'users' && c.doc?.smsWelcomedAt && c.doc.smsWelcomedAt !== c.prev?.smsWelcomedAt;

  /** After a commit: push and text each new notification (one message per person per change). Never throws. */
  function afterCommit(changes, req) {
    try {
      if (!pusher.enabled && !texter.enabled) return;
      const notes = changes.filter((c) => c.col === 'notifications' && c.isNew && c.doc).map((c) => c.doc);
      const optIns = changes.filter(welcomeDue).map((c) => c.doc);
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
        const lang = langOf(u, st); // each notification's text is already in the person's language
        if (pusher.enabled) {
          const message = pushMessage(name, more ? `${first.text}${msg(lang).more(more)}` : first.text, first.link);
          for (const sub of db.store.list('pushSubscriptions', (s) => s.userId === userId)) pushes.push({ sub, message });
        }
        // Some notifications are never texted (noText: the Feedback box, core/feedback.js).
        const textable = list.filter((n) => !n.noText);
        if (textable.length && texter.enabled && smsAllowed(u, st)) {
          const [t1] = textable;
          texts.push({ userId, to: u.smsPhone, body: textMessage({ restaurant: name, text: t1.text, url: linkFor(url, t1.link), more: textable.length - 1, lang }) });
        }
      }
      if (texter.enabled) {
        // The welcome goes first, and only to someone texts are allowed for right now.
        for (const u of optIns) if (smsAllowed(u, st)) texts.unshift({ userId: u.id, to: u.smsPhone, body: welcomeText({ lang: langOf(u, st) }) });
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
      const message = pushMessage(restaurant(), msg(langOf(u, settings())).pushTest, '#/my');
      const r = await deliver(subs.map((sub) => ({ sub, message })), []);
      if (!r.sent) {
        return res.status(502).json({ error: r.removed ? 'This phone’s sign-up expired. Turn notifications on again.' : 'The notification could not be sent. Try again in a minute.' });
      }
      res.json({ result: r });
    });

    // Settings → Text messages → Send me a test text (admins): only to the admin's own number, and only once
    // they've agreed to texts on it themselves (My Shifts → Text messages).
    app.post('/api/sms/test', async (req, res) => {
      await db.sync();
      const u = signedIn(req);
      if (!u) return res.status(401).json({ error: 'Please sign in' });
      if (!canChangeSettings(u)) return res.status(403).json({ error: 'Admins only' });
      if (!texter.enabled) return res.status(400).json({ error: 'Text messages aren’t set up yet. Add the TWILIO_ settings in Vercel, then redeploy.' });
      const to = normalizePhone(req.body?.phone || u.smsPhone || u.phone);
      if (!to) return res.status(400).json({ error: 'Enter your mobile number, like (303) 555-0123' });
      const me = db.store.get('users', u.id);
      if (!smsAllowed(me, settings()) || me.smsPhone !== to) {
        return res.status(400).json({ error: 'Turn on texts for this number in My Shifts first (you have to agree to texts yourself).' });
      }
      try {
        await texter.send(to, testText({ restaurant: restaurant(), lang: langOf(u, settings()) }));
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
          // A consent record per person: source 'keyword', version 'keyword:STOP', Twilio's IP (trust proxy).
          await db.run((s) => applyTextReply(s, { from: params.From, action, body: params.Body, word: params.Body, ip: req.ip,
            userAgent: req.get('user-agent') || null, at: new Date().toISOString() }), { write: true });
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
    /** The senders themselves, for announcements (server/announcements.js). */
    senders: { pusher, texter },
    /** For /api/config. */
    config: () => ({ push: pusher.enabled, sms: texter.enabled, smsFrom: texter.from ? formatPhone(texter.from) : null }),
    afterCommit,
    routes,
    deliver,
  };
}
