// Phone notifications (Web Push) and text messages (Twilio): the rules, as pure JS shared by
// the server and the in-browser demo. The sending is in server/push.js and server/sms.js, and
// server/channels.js runs it after the commit, the same way email works.
//
// Data:
//   pushSubscriptions  one document per phone/browser: { userId, endpoint, keys: { p256dh, auth } }
//   users.smsPhone             the mobile number the person gave for texts (E.164, e.g. +13035550123)
//   users.smsConsent           true only after the person agreed to texts themselves (default off). It gates
//                              every text. (It was users.smsNotifications before consent records existed;
//                              core/consent.js migrates it, and smsConsentOf still reads the old field.)
//   users.smsConsentAt         when they turned texts on for that number
//   users.smsStoppedAt         when they replied STOP
//   users.smsWelcomedAt        when the one-time welcome text went out (first opt-in ever)
//   consents                   a record of every opt-in and opt-out (core/consent.js)
//   settings.smsNotifications  the restaurant-wide switch (on unless an admin turns it off)
import { uid } from './store.js';
import { msg } from './messages.js';
import { smsConsentOf, smsStatusOf, recordConsent, consentText, welcomeSms } from './consent.js';

// ---------- phone numbers ----------

/**
 * A phone number in E.164 (+13035550123), or null if it can't be one. Numbers without a country
 * code are taken as US/Canada (+1): "(303) 555-0123", "303.555.0123" and "1 303 555 0123" all work.
 */
export function normalizePhone(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 32 || /[^\d\s().+-]/.test(s)) return null;
  const intl = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  if (!intl) {
    if (digits.length === 10) digits = `1${digits}`;
    else if (!(digits.length === 11 && digits.startsWith('1'))) return null;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // US/Canada: 10 digits after the 1, and neither the area code nor the exchange starts with 0 or 1.
  if (digits.startsWith('1') && !/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+${digits}`;
}

/** +13035550123 -> (303) 555-0123; other countries stay in E.164. */
export function formatPhone(e164) {
  const m = String(e164 || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || '');
}

/** For logs: the last 4 digits only. */
export const maskPhone = (e164) => (e164 ? `…${String(e164).slice(-4)}` : '');

// ---------- texts ----------

// Curly quotes, dashes and odd spaces turn a text into UCS-2, which fits 70 characters per
// message instead of 160 (and costs more). Swap them for plain ones.
const PLAIN = { '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '−': '-', '…': '...', '•': '*', '·': '-', ' ': ' ', ' ': ' ', ' ': ' ', '​': '' };
export const plainText = (s) => String(s ?? '').replace(/[‘’‚“”„–—−…•·   ​]/g, (c) => PLAIN[c]).replace(/\s+/g, ' ').trim();

/** The link for a notification: the app's address plus its route (#/my), or just the app. */
export function linkFor(appUrl, link) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  const l = String(link || '');
  return l.startsWith('#') ? `${base}/${l}` : base || '/';
}

const SMS_LIMIT = 160;
/** "Chasing Rabbits: New shift: Server Tue, Sep 29 4p-10p https://…/#/my", kept to one text when it can be. */
export function textMessage({ restaurant, text, url, more = 0, lang = 'en' }) {
  const name = plainText(restaurant) || 'ShiftBoard';
  const extra = more > 0 ? msg(lang).more(more) : '';
  let body = plainText(text);
  const room = SMS_LIMIT - name.length - 2 - extra.length - (url ? url.length + 1 : 0);
  const max = Math.max(room, 60);
  if (body.length > max) body = `${body.slice(0, max - 3).trimEnd()}...`;
  return `${name}: ${body}${extra}${url ? ` ${url}` : ''}`;
}

/**
 * The text sent on someone's first opt-in ever (carriers expect one), in their language: exactly the words in
 * core/consent.js (WELCOME_TEXT). The STOP and HELP keywords stay in English in Spanish too.
 */
export const welcomeText = ({ lang = 'en' } = {}) => welcomeSms(lang);
/** The test text from Settings, in the admin's language. */
export const testText = ({ restaurant, lang = 'en' }) => plainText(msg(lang).smsTest(restaurant || 'ShiftBoard'));

/** May this person get texts right now? Their own consent (smsConsent === true), a number, and the restaurant's switch. */
export function smsAllowed(user, settings) {
  return !!(user && user.active !== false && smsConsentOf(user) === true && user.smsPhone
    && settings?.smsNotifications !== false);
}

// Twilio's standard opt-out and opt-in words, plus OPTOUT and REVOKE as extra stop words.
export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'];
export const START_WORDS = ['START', 'YES', 'UNSTOP'];
const STOPS = new Set(STOP_WORDS);
const STARTS = new Set(START_WORDS);
/** The keyword in an incoming text ('STOP', ' unsubscribe ', 'Stop.' → 'STOP', 'UNSUBSCRIBE'), or ''. */
export const keywordOf = (body) => String(body || '').toUpperCase().replace(/[^A-Z]/g, '');
/** 'stop', 'start' or null for an incoming text. Twilio's own OptOutType wins when it's there. */
export function replyKeyword(body, optOutType) {
  const t = String(optOutType || '').trim().toUpperCase();
  if (t === 'STOP' || t === 'START') return t.toLowerCase();
  const word = keywordOf(body);
  if (STOPS.has(word)) return 'stop';
  if (STARTS.has(word)) return 'start';
  return null;
}

/**
 * Apply a STOP or START from a phone number to everyone who gave that number, with a consent record each
 * (source 'keyword', version 'keyword:STOP', the text they sent, the request's IP). STOP turns their texts
 * off; START turns them back on (no welcome text: Twilio answers START itself). Returns how many people changed.
 */
export function applyTextReply(store, { from, action, word, body, ip = null, userAgent = null, at = new Date().toISOString() }) {
  const phone = normalizePhone(from);
  if (!phone || !action) return 0;
  const kw = keywordOf(word || body);
  const keyword = (action === 'stop' ? STOPS : STARTS).has(kw) ? kw : action.toUpperCase();
  let n = 0;
  for (const u of store.list('users', (x) => x.smsPhone === phone)) {
    const on = smsConsentOf(u);
    if (action === 'stop' && (on || !u.smsStoppedAt)) {
      store.update('users', u.id, { smsConsent: false, smsStoppedAt: at });
    } else if (action === 'start' && !on) {
      store.update('users', u.id, { smsConsent: true, smsStoppedAt: null, smsConsentAt: at });
    } else continue;
    recordConsent(store, { userId: u.id, channel: 'sms', granted: action === 'start', lang: u.language === 'es' ? 'es' : 'en',
      text: String(body ?? keyword).trim().slice(0, 160) || keyword, version: `keyword:${keyword}`, phone, ip, userAgent, source: 'keyword', at });
    n++;
  }
  return n;
}

// ---------- push subscriptions ----------

// The browsers' push services. The server only ever sends to these, so a subscription can't
// be used to make the server call some other address.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export const MAX_DEVICES = 10;

/** A browser's PushSubscription (as JSON), checked and trimmed to what's stored; throws a message if it isn't one. */
export function cleanSubscription(sub) {
  const endpoint = String(sub?.endpoint || '');
  let url = null;
  try { url = new URL(endpoint); } catch { /* checked below */ }
  if (!url || url.protocol !== 'https:' || endpoint.length > 2000) throw new Error('That isn’t a push subscription');
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) throw new Error('This browser’s push service isn’t supported');
  const key = (v, min, max) => {
    const s = String(v || '');
    return s.length >= min && s.length <= max && /^[A-Za-z0-9_\-+/]+=*$/.test(s) ? s : null;
  };
  const p256dh = key(sub?.keys?.p256dh, 80, 100);
  const auth = key(sub?.keys?.auth, 16, 32);
  if (!p256dh || !auth) throw new Error('That push subscription is missing its keys');
  return { endpoint, keys: { p256dh, auth } };
}

// ---------- RPC methods (merged into core/service.js) ----------

/**
 * @param {object} deps  from createService: store, fail, needAuth, needAdmin, settings, now
 * @param {object} [deps.channels]  what the server has set up: { push: { enabled, publicKey }, sms: { enabled } }.
 *                                  The demo passes nothing, so both are off there.
 */
export function channelApi({ store, fail, needAuth, needAdmin, settings, now, channels, request, langOf }) {
  const push = channels?.push || { enabled: false, publicKey: '' };
  const sms = channels?.sms || { enabled: false };
  const myDevices = (actor) => store.list('pushSubscriptions', (s) => s.userId === actor.id);
  const saveSettings = (patch) => (store.get('settings', 'settings')
    ? store.update('settings', 'settings', patch) : store.insert('settings', { ...settings(), ...patch, id: 'settings' }));
  const smsView = (u) => ({ smsConsent: smsConsentOf(u), smsPhone: u.smsPhone || '', smsStatus: smsStatusOf(u) });
  const lang = (actor, l) => (l === 'en' || l === 'es' ? l : langOf ? langOf(actor) : 'en');
  const record = (actor, a, granted, phone) => recordConsent(store, { userId: actor.id, channel: 'sms', granted, lang: lang(actor, a.lang),
    text: consentText('sms', lang(actor, a.lang)), phone, ip: request?.ip, userAgent: request?.userAgent, source: 'settings', at: now().toISOString() });

  return {
    // ----- phone notifications (Web Push) -----
    // The key the browser subscribes with, and whether this phone (endpoint) is already signed up for me.
    'push.publicKey': (actor, { endpoint } = {}) => {
      needAuth(actor);
      const mine = myDevices(actor);
      return {
        enabled: !!push.enabled,
        publicKey: push.enabled ? push.publicKey : null,
        devices: mine.length,
        thisDevice: !!endpoint && mine.some((s) => s.endpoint === endpoint),
      };
    },
    'push.subscribe': (actor, { subscription } = {}) => {
      needAuth(actor);
      if (!push.enabled) fail(400, 'Phone notifications aren’t set up for this restaurant yet');
      let sub;
      try { sub = cleanSubscription(subscription); } catch (e) { fail(400, e.message); }
      const at = now().toISOString();
      // One document per phone. A phone someone else signed up on (a shared device) moves to me.
      const same = store.list('pushSubscriptions', (s) => s.endpoint === sub.endpoint);
      for (const s of same.slice(1)) store.remove('pushSubscriptions', s.id);
      if (same[0]) store.update('pushSubscriptions', same[0].id, { ...sub, userId: actor.id, updatedAt: at });
      else store.insert('pushSubscriptions', { id: uid('psub'), userId: actor.id, ...sub, createdAt: at });
      // Keep the newest few per person.
      const mine = myDevices(actor).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      for (const old of mine.slice(MAX_DEVICES)) store.remove('pushSubscriptions', old.id);
      return { ok: true, devices: Math.min(mine.length, MAX_DEVICES) };
    },
    // Stop notifications on one phone (endpoint), or on all of mine when no endpoint is given.
    'push.unsubscribe': (actor, { endpoint } = {}) => {
      needAuth(actor);
      let removed = 0;
      for (const s of myDevices(actor)) {
        if (endpoint && s.endpoint !== endpoint) continue;
        store.remove('pushSubscriptions', s.id);
        removed++;
      }
      return { ok: true, removed, devices: myDevices(actor).length };
    },

    // ----- text messages (Twilio) -----
    // Only the person can turn their own texts on, with their own mobile number, by ticking the consent box
    // (consent: true; never pre-ticked). Each change is a consent record (source 'settings').
    'sms.preferences': (actor, a = {}) => {
      needAuth(actor);
      const { on, phone } = a;
      const me = store.get('users', actor.id);
      if (on === false) {
        if (smsConsentOf(me)) record(actor, a, false, me.smsPhone || null);
        return smsView(store.update('users', me.id, { smsConsent: false }));
      }
      if (!sms.enabled) fail(400, 'Text messages aren’t set up for this restaurant yet');
      if (settings().smsNotifications === false) fail(400, 'Your restaurant has text messages turned off');
      const number = normalizePhone(phone ?? me.smsPhone);
      if (!number) fail(400, 'Enter your mobile number, like (303) 555-0123');
      if (smsConsentOf(me) && me.smsPhone === number) return smsView(me); // already on for this number
      if (a.consent !== true) fail(400, 'Tick the box to agree to text messages');
      const at = now().toISOString();
      record(actor, a, true, number);
      return smsView(store.update('users', me.id, {
        smsConsent: true, smsPhone: number, smsStoppedAt: null, smsConsentAt: at,
        ...(me.smsWelcomedAt ? {} : { smsWelcomedAt: at }), // the welcome text goes out once, on the first opt-in ever
      }));
    },
    // The restaurant-wide switch (Settings → Text messages).
    'sms.setRestaurant': (actor, { on } = {}) => {
      needAdmin(actor);
      saveSettings({ smsNotifications: on !== false });
      return { smsNotifications: on !== false };
    },
  };
}
