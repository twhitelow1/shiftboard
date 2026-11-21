// Phone notifications (Web Push) and text messages (Twilio): the rules, as pure JS shared by
// the server and the in-browser demo. The sending is in server/push.js and server/sms.js, and
// server/channels.js runs it after the commit, the same way email works.
//
// Data:
//   pushSubscriptions  one document per phone/browser: { userId, endpoint, keys: { p256dh, auth } }
//   users.smsPhone             the mobile number the person gave for texts (E.164, e.g. +13035550123)
//   users.smsNotifications     true only after the person turns texts on themselves (default off)
//   users.smsConsentAt         when they turned texts on for that number (their consent record)
//   users.smsStoppedAt         when they replied STOP
//   settings.smsNotifications  the restaurant-wide switch (on unless an admin turns it off)
import { uid } from './store.js';

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
export function textMessage({ restaurant, text, url, more = 0 }) {
  const name = plainText(restaurant) || 'ShiftBoard';
  const extra = more > 0 ? ` (+${more} more)` : '';
  let body = plainText(text);
  const room = SMS_LIMIT - name.length - 2 - extra.length - (url ? url.length + 1 : 0);
  const max = Math.max(room, 60);
  if (body.length > max) body = `${body.slice(0, max - 3).trimEnd()}...`;
  return `${name}: ${body}${extra}${url ? ` ${url}` : ''}`;
}

/** The text sent right after someone turns texts on (carriers expect one). */
export const welcomeText = ({ restaurant, url }) => plainText(
  `${restaurant || 'ShiftBoard'}: You'll get texts about your schedule, trades and time off. Msg & data rates may apply. Reply STOP to opt out, HELP for help.${url ? ` ${url}` : ''}`,
);

/** May this person get texts right now? */
export function smsAllowed(user, settings) {
  return !!(user && user.active !== false && user.smsNotifications === true && user.smsPhone
    && settings?.smsNotifications !== false);
}

// Twilio's standard opt-out and opt-in words.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);
/** 'stop', 'start' or null for an incoming text. Twilio's own OptOutType wins when it's there. */
export function replyKeyword(body, optOutType) {
  const t = String(optOutType || '').toUpperCase();
  if (t === 'STOP' || t === 'START') return t.toLowerCase();
  const word = String(body || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Apply a STOP or START from a phone number to everyone who gave that number.
 * STOP turns their texts off; START turns them back on. Returns how many people changed.
 */
export function applyTextReply(store, { from, action, at = new Date().toISOString() }) {
  const phone = normalizePhone(from);
  if (!phone || !action) return 0;
  let n = 0;
  for (const u of store.list('users', (x) => x.smsPhone === phone)) {
    if (action === 'stop' && u.smsNotifications !== false) {
      store.update('users', u.id, { smsNotifications: false, smsStoppedAt: at });
      n++;
    } else if (action === 'start' && u.smsNotifications !== true) {
      store.update('users', u.id, { smsNotifications: true, smsStoppedAt: null, smsConsentAt: at });
      n++;
    }
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
export function channelApi({ store, fail, needAuth, needAdmin, settings, now, channels }) {
  const push = channels?.push || { enabled: false, publicKey: '' };
  const sms = channels?.sms || { enabled: false };
  const myDevices = (actor) => store.list('pushSubscriptions', (s) => s.userId === actor.id);
  const saveSettings = (patch) => (store.get('settings', 'settings')
    ? store.update('settings', 'settings', patch) : store.insert('settings', { ...settings(), ...patch, id: 'settings' }));
  const smsView = (u) => ({ smsNotifications: u.smsNotifications === true, smsPhone: u.smsPhone || '' });

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
    // Only the person can turn their own texts on, with their own mobile number.
    'sms.preferences': (actor, { on, phone } = {}) => {
      needAuth(actor);
      const me = store.get('users', actor.id);
      if (on === false) return smsView(store.update('users', me.id, { smsNotifications: false }));
      if (!sms.enabled) fail(400, 'Text messages aren’t set up for this restaurant yet');
      if (settings().smsNotifications === false) fail(400, 'Your restaurant has text messages turned off');
      const number = normalizePhone(phone ?? me.smsPhone);
      if (!number) fail(400, 'Enter your mobile number, like (303) 555-0123');
      const fresh = me.smsNotifications !== true || me.smsPhone !== number;
      return smsView(store.update('users', me.id, {
        smsNotifications: true, smsPhone: number, smsStoppedAt: null,
        ...(fresh ? { smsConsentAt: now().toISOString() } : {}),
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
