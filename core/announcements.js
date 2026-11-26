// Announcements: a manager (or above) writes to the team once, and it goes out in the app, as a phone
// notification (web push and the phone app), and optionally by email and text. Plan feature `announcements`;
// texts also need the plan's `sms` feature and Twilio. Shared by the server and the in-browser demo.
//
//   compose     title + message, an optional Spanish version (Spanish speakers get the English when it's
//               blank), an optional link to a page in the app, an audience, email and/or text on top of
//               in-app + push, send now or schedule.
//   summary     before sending: how many people each channel reaches and why the others won't
//               ("Texts: 23 of 41 (18 haven't agreed to texts)").
//   release     when it goes out (now, or at its time): the audience is worked out, everyone gets an in-app
//               notification, and every person gets a delivery record per channel: queued, or skipped with
//               the reason. The server then sends the queued ones in batches (server/announcements.js) and
//               records sent / failed with the reason; the demo marks them sent.
//
// Texts (the strict part): only to people with smsConsent === true (core/consent.js), checked when the
// audience is worked out, again when a batch is picked up, and again right before each text. They go out
// under DubLow's registered "shift schedule alerts" campaign, so the composer asks the sender to confirm the
// text is about the schedule, keeps it to two segments, starts it with the restaurant's name and ends it with
// "Reply STOP to opt out". At most settings.announcements.smsDailyCap announcement texts per person per day
// (default 2), and none in quiet hours (default 10 pm–8 am, the restaurant's time zone): they wait until the
// quiet hours end, unless an admin marks the announcement urgent. Email needs the person's emailConsent.
//
// Data: announcements { id, title, body, titleEs, bodyEs, link, audience, email, sms, urgent, status, sendAt,
//   next, createdAt, createdBy, releasedAt, sentAt, cancelledAt, cancelledBy, recipients }
//   status: scheduled → queued (send now) → sending → sent; or cancelled (while scheduled).
//   next: when the server has work on it (its time, now, or when held texts may go), null when done.
//   recipients: { [userId]: { lang, push, email, sms, readAt } }, each channel { s, r, at, notBefore, n }:
//     s: queued | sending | sent | failed | skipped; r: the reason (skipped/failed) or the provider's error.
// Their in-app notifications carry announcementId, so the server's usual email/push/text copies of new
// notifications leave them alone (the announcement's own delivery covers them).
import { uid } from './store.js';
import { todayStr, addDays, weekStart } from './time.js';
import { langOf as langFor } from './i18n.js';
import { roleOf, canManageSchedule, canChangeSettings, ROLE_IDS } from './roles.js';
import { smsConsentOf, emailConsentOf } from './consent.js';
import { smsAllowed, plainText } from './notify-prefs.js';
import { deliverable } from './email-address.js';
import { entryRooms } from './layout.js';
import { cleanArea, sameArea } from './areas.js';

export const AUDIENCES = ['everyone', 'roles', 'positions', 'rooms', 'today', 'week', 'date', 'people'];
/** Pages an announcement can link to (the web app's routes; the phone app maps them in mobile/src/lib/links.ts). */
export const LINKS = ['#/my', '#/schedule', '#/calendar', '#/swaps', '#/timeoff', '#/training', '#/86', '#/events', '#/tips'];
export const ANNOUNCE_DEFAULTS = { smsDailyCap: 2, quietStart: '22:00', quietEnd: '08:00' };
export const TITLE_MAX = 80;
export const BODY_MAX = 1000;
export const SMS_MAX_SEGMENTS = 2;
export const SCHEDULE_MAX_DAYS = 90;
const CHANNELS = ['push', 'email', 'sms'];
const STALE_MS = 3 * 60 * 1000; // a batch claimed this long ago and never finished: its instance stopped
const MAX_ATTEMPTS = 3;

/** Who can send announcements (the role editor on another branch may widen this). */
export const canAnnounce = (u) => canManageSchedule(u);

/** The restaurant's limits: { smsDailyCap, quietStart, quietEnd }. */
export function announceSettings(settings) {
  const a = settings?.announcements || {};
  const time = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? v : d);
  const cap = Number.isFinite(Number(a.smsDailyCap)) && a.smsDailyCap !== '' && a.smsDailyCap != null ? Math.max(0, Math.min(10, Math.trunc(Number(a.smsDailyCap)))) : ANNOUNCE_DEFAULTS.smsDailyCap;
  return { smsDailyCap: cap, quietStart: time(a.quietStart, ANNOUNCE_DEFAULTS.quietStart), quietEnd: time(a.quietEnd, ANNOUNCE_DEFAULTS.quietEnd) };
}

// ---------- quiet hours ----------
const minutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
/** Is this moment (the restaurant's local time) inside quiet hours? */
export function inQuietHours(date, cfg = ANNOUNCE_DEFAULTS) {
  const m = date.getHours() * 60 + date.getMinutes();
  const s = minutes(cfg.quietStart);
  const e = minutes(cfg.quietEnd);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}
/** The next end of quiet hours after this moment (8:00 the same morning, or the next). */
export function quietEndAfter(date, cfg = ANNOUNCE_DEFAULTS) {
  const d = new Date(date);
  const e = minutes(cfg.quietEnd);
  d.setHours(Math.floor(e / 60), e % 60, 0, 0);
  if (d <= date) d.setDate(d.getDate() + 1);
  return d;
}

// ---------- texts: GSM-7, segments, the wording ----------
const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€');
/**
 * Text that stays in the GSM-7 alphabet (160 characters a segment instead of 70): plain quotes and dashes,
 * and accents GSM-7 lacks dropped (á → a; é, ñ, ü stay). Anything else stays as it is.
 */
export function gsmText(s) {
  return [...plainText(s)].map((c) => {
    if (GSM.has(c) || GSM_EXT.has(c)) return c;
    const bare = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return [...bare].every((x) => GSM.has(x)) ? bare : c;
  }).join('');
}
/** How a text is billed: { chars, segments, encoding: 'GSM-7' | 'UCS-2' }. */
export function smsSegments(text) {
  const s = String(text ?? '');
  const gsm = [...s].every((c) => GSM.has(c) || GSM_EXT.has(c));
  if (gsm) {
    const n = [...s].reduce((t, c) => t + (GSM_EXT.has(c) ? 2 : 1), 0);
    return { chars: n, segments: n <= 160 ? 1 : Math.ceil(n / 153), encoding: 'GSM-7' };
  }
  const n = s.length; // UTF-16 code units
  return { chars: n, segments: n <= 70 ? 1 : Math.ceil(n / 67), encoding: 'UCS-2' };
}
/** The words that end every announcement text. STOP stays in English in Spanish (carriers act on it). */
export const SMS_STOP = { en: 'Reply STOP to opt out', es: 'Responde STOP para cancelar' };
/**
 * An announcement as a text: "Our Restaurant: Title - message Reply STOP to opt out", at most two segments.
 * Too long: the message is cut ("...") and the link to the announcement goes in. Returns
 * { text, chars, segments, encoding, trimmed }.
 */
export function smsText({ restaurant, title, body, lang = 'en', url = '' }) {
  const head = `${gsmText(restaurant) || 'ShiftBoard'}: `;
  const stop = SMS_STOP[lang === 'es' ? 'es' : 'en'];
  const end = (s) => `${s}${/[.!?]$/.test(s) ? '' : '.'} ${stop}`;
  const main = `${gsmText(title)}${body ? ` - ${gsmText(body)}` : ''}`;
  let text = `${head}${end(main)}`;
  let trimmed = false;
  if (smsSegments(text).segments > SMS_MAX_SEGMENTS) {
    trimmed = true;
    const link = url ? ` ${url}` : '';
    let keep = main.length;
    for (let i = 0; i < 60; i++) {
      text = `${head}${main.slice(0, Math.max(keep, 10)).trimEnd()}...${link} ${stop}`;
      const c = smsSegments(text);
      if (c.segments <= SMS_MAX_SEGMENTS || keep <= 10) break;
      keep -= Math.max(1, c.chars - (c.encoding === 'GSM-7' ? 153 : 67) * SMS_MAX_SEGMENTS);
    }
  }
  return { text, ...smsSegments(text), trimmed };
}

// ---------- the in-app words ----------
/** The announcement in a language: the Spanish version when there is one, else the English. */
export function inLanguage(ann, lang) {
  const es = lang === 'es' && (ann.titleEs || ann.bodyEs);
  return { title: es ? ann.titleEs || ann.title : ann.title, body: es ? ann.bodyEs || ann.body : ann.body, lang: es ? 'es' : 'en' };
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The notification line: "Title: message" (shortened). */
export const noteText = ({ title, body }) => clip(body ? `${title}: ${body.replace(/\s+/g, ' ')}` : title, 300);
/** A phone notification: { title, body }. */
export const pushContent = (ann, lang) => { const v = inLanguage(ann, lang); return { title: clip(v.title, 80), body: clip(v.body.replace(/\s+/g, ' '), 240) }; };

// ---------- the audience ----------
const strings = (v, max = 500) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, max) : []);
/** An audience as stored: { kind, roles, jobCodeIds, areas, date, userIds } (only the field its kind uses). */
export function cleanAudience(a, fail, { allowEmpty = false } = {}) {
  const kind = AUDIENCES.includes(a?.kind) ? a.kind : null;
  if (!kind) fail(400, 'Pick who gets the announcement');
  const out = { kind };
  if (kind === 'roles') out.roles = strings(a.roles).filter((r) => ROLE_IDS.includes(r));
  if (kind === 'positions') out.jobCodeIds = strings(a.jobCodeIds);
  if (kind === 'rooms') out.areas = strings(a.areas).map(cleanArea).filter(Boolean);
  if (kind === 'people') out.userIds = strings(a.userIds, 2000);
  if (kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''))) fail(400, 'Pick a date');
    out.date = a.date;
  }
  const list = out.roles || out.jobCodeIds || out.areas || out.userIds;
  if (list && !list.length && !allowEmpty) fail(400, 'Pick who gets the announcement');
  return out;
}

/** The people an audience means on a day (the sender left out): active people only. */
export function resolveAudience(store, audience, { settings, day, senderId }) {
  const people = store.list('users', (u) => u.active !== false && u.id !== senderId);
  const a = audience || { kind: 'everyone' };
  const working = (dates) => {
    const ids = new Set(store.list('shifts', (s) => s.userId && s.published && dates.includes(s.date)).map((s) => s.userId));
    return people.filter((u) => ids.has(u.id));
  };
  switch (a.kind) {
    case 'everyone': return people;
    case 'roles': return people.filter((u) => (a.roles || []).includes(roleOf(u)));
    case 'positions': return people.filter((u) => (u.jobCodes || []).some((e) => (a.jobCodeIds || []).includes(e.jobCodeId)));
    case 'rooms': {
      const jobs = new Map(store.list('jobCodes').map((j) => [j.id, j]));
      return people.filter((u) => (u.jobCodes || []).some((e) => entryRooms(e, jobs.get(e.jobCodeId)).some((r) => (a.areas || []).some((x) => sameArea(x, r)))));
    }
    case 'today': return working([day]);
    case 'week': { const ws = weekStart(day, settings?.weekStartDow ?? 1); return working(Array.from({ length: 7 }, (_, i) => addDays(ws, i))); }
    case 'date': return working([a.date]);
    case 'people': return people.filter((u) => (a.userIds || []).includes(u.id));
    default: return [];
  }
}

// ---------- who gets what ----------
const stamp = (d) => new Date(d).toISOString();

/** Announcement texts already planned or sent per person on a day (YYYY-MM-DD), for the daily cap. */
function textsPerPerson(store, day, exceptId) {
  const out = new Map();
  for (const a of store.list('announcements', (x) => x.recipients && x.id !== exceptId && x.releasedAt)) {
    for (const [userId, r] of Object.entries(a.recipients)) {
      const s = r.sms;
      if (!s || !['queued', 'sending', 'sent'].includes(s.s)) continue;
      const when = s.s === 'sent' ? s.at : s.notBefore || s.at || a.releasedAt;
      if (when && todayStr(new Date(when)) === day) out.set(userId, (out.get(userId) || 0) + 1);
    }
  }
  return out;
}

/**
 * Each person's delivery plan: { user, lang, push, email, sms } with { s: 'queued' | 'skipped', r, notBefore }.
 * channels: what's set up ({ push, appPush, email, sms, simulate }); when: the moment it goes out (a Date).
 */
export function planDelivery(store, ann, people, { settings, channels = {}, when, exceptId }) {
  const cfg = announceSettings(settings);
  const day = todayStr(when);
  const quiet = !ann.urgent && inQuietHours(when, cfg);
  const notBefore = quiet ? quietEndAfter(when, cfg) : null;
  const textDay = notBefore ? todayStr(notBefore) : day;
  const sent = ann.sms ? textsPerPerson(store, textDay, exceptId) : new Map();
  const subs = new Set(channels.push ? store.list('pushSubscriptions').map((s) => s.userId) : []);
  const devices = channels.appPush ? store.list('deviceTokens') : [];
  const skip = (r) => ({ s: 'skipped', r });
  return people.map((u) => {
    const app = devices.some((d) => d.userId === u.id && (d.v || 0) === (u.sessionVersion || 0));
    const push = !channels.push && !channels.appPush ? skip('notSetUp') : subs.has(u.id) || app ? { s: 'queued' } : skip('noDevice');
    let email;
    if (!ann.email) email = skip('notChosen');
    else if (!channels.email) email = skip('notSetUp');
    else if (settings.emailNotifications === false) email = skip('restaurantOff');
    else if (!(channels.simulate ? !!u.email : deliverable(u.email))) email = skip('noEmail');
    else if (!emailConsentOf(u)) email = skip('noConsent');
    else email = { s: 'queued' };
    let sms;
    if (!ann.sms) sms = skip('notChosen');
    else if (!channels.sms) sms = skip('notSetUp');
    else if (settings.smsNotifications === false) sms = skip('restaurantOff');
    else if (smsConsentOf(u) !== true) sms = skip(u.smsStoppedAt ? 'stopped' : 'noConsent');
    else if (!u.smsPhone) sms = skip('noPhone');
    else if ((sent.get(u.id) || 0) >= cfg.smsDailyCap) sms = skip('dailyCap');
    else {
      sms = { s: 'queued', ...(notBefore ? { notBefore: stamp(notBefore) } : {}) };
      sent.set(u.id, (sent.get(u.id) || 0) + 1);
    }
    return { user: u, lang: langFor(u, settings), push, email, sms };
  });
}

/** The before-you-send numbers: per channel, how many it reaches and why the others won't. */
export function summarize(plan, { quietUntil = null } = {}) {
  const out = { total: plan.length, spanish: 0, push: { reach: 0, skipped: {} }, email: { reach: 0, skipped: {} }, sms: { reach: 0, held: 0, skipped: {} }, quietUntil };
  for (const p of plan) {
    if (p.lang === 'es') out.spanish++;
    for (const ch of CHANNELS) {
      const d = p[ch];
      if (d.s === 'queued') { out[ch].reach++; if (d.notBefore) out[ch].held++; } else if (d.r !== 'notChosen') out[ch].skipped[d.r] = (out[ch].skipped[d.r] || 0) + 1;
    }
  }
  return out;
}

// ---------- counts for history ----------
/** { recipients, read, push|email|sms: { sent, failed, skipped, queued, held, reasons: { reason: n } } }. */
export function countsOf(ann, now = Date.now()) {
  const out = { recipients: 0, read: 0 };
  for (const ch of CHANNELS) out[ch] = { sent: 0, failed: 0, skipped: 0, queued: 0, held: 0, reasons: {} };
  for (const r of Object.values(ann.recipients || {})) {
    out.recipients++;
    if (r.readAt) out.read++;
    for (const ch of CHANNELS) {
      const d = r[ch];
      if (!d || d.r === 'notChosen') continue;
      const c = out[ch];
      if (d.s === 'sent') c.sent++;
      else if (d.s === 'failed') { c.failed++; c.reasons[d.r || 'error'] = (c.reasons[d.r || 'error'] || 0) + 1; } else if (d.s === 'skipped') { c.skipped++; c.reasons[d.r] = (c.reasons[d.r] || 0) + 1; } else if (d.notBefore && Date.parse(d.notBefore) > now) c.held++;
      else c.queued++;
    }
  }
  return out;
}

// ---------- going out ----------
/**
 * Status and next work after a change to its deliveries: 'sending' while anything is queued and due or in a
 * batch; next = the earliest of the queued ones' time (held texts: when quiet hours end) and the time a batch
 * in flight would count as stopped. 'sent' (with sentAt) once nothing is left but texts waiting for morning.
 */
function settle(ann, nowIso) {
  let next = null;
  let active = false;
  for (const r of Object.values(ann.recipients || {})) {
    for (const ch of CHANNELS) {
      const d = r[ch];
      let at = null;
      if (d?.s === 'sending') {
        active = true;
        at = stamp(Date.parse(d.at) + STALE_MS);
      } else if (d?.s === 'queued') {
        at = d.notBefore || ann.releasedAt || nowIso;
        if (at <= nowIso) active = true;
      }
      if (at && (!next || at < next)) next = at;
    }
  }
  return { next, status: active ? 'sending' : 'sent', ...(active ? {} : { sentAt: ann.sentAt || nowIso }) };
}

/**
 * Release one announcement: work out its audience, give everyone the in-app notification, and record each
 * person's delivery plan. With channels.simulate (the demo) the queued ones are marked sent right away.
 */
export function releaseAnnouncement(store, ann, { settings, channels = {}, now }) {
  const when = now;
  const nowIso = stamp(when);
  const people = resolveAudience(store, ann.audience, { settings, day: todayStr(when), senderId: ann.createdBy });
  const plan = planDelivery(store, ann, people, { settings, channels, when, exceptId: ann.id });
  const recipients = {};
  const versions = { en: inLanguage(ann, 'en'), es: inLanguage(ann, 'es') };
  const i18n = { en: noteText(versions.en), es: noteText(versions.es) };
  for (const p of plan) {
    const entry = { lang: p.lang };
    for (const ch of CHANNELS) {
      const d = { ...p[ch] };
      if (channels.simulate && d.s === 'queued' && !d.notBefore) Object.assign(d, { s: 'sent', r: 'demo', at: nowIso });
      entry[ch] = d;
    }
    recipients[p.user.id] = entry;
    store.insert('notifications', { id: uid('ntf'), userId: p.user.id, text: i18n[p.lang === 'es' ? 'es' : 'en'], i18n,
      link: `#/announcements/${ann.id}`, read: false, at: nowIso, announcementId: ann.id });
  }
  const next = { ...ann, recipients, releasedAt: nowIso };
  return store.update('announcements', ann.id, { recipients, releasedAt: nowIso, ...settle(next, nowIso) });
}

/** Release every announcement that's due (sent now, or its time came). Returns their ids. */
export function releaseDue(store, ctx) {
  const nowIso = stamp(ctx.now);
  const due = store.list('announcements', (a) => (a.status === 'queued' || a.status === 'scheduled') && (a.sendAt || a.createdAt) <= nowIso)
    .sort((a, b) => String(a.sendAt || a.createdAt).localeCompare(String(b.sendAt || b.createdAt)));
  for (const a of due) releaseAnnouncement(store, a, ctx);
  return due.map((a) => a.id);
}

/** Is there anything for the server to do (in the cache, no copying)? */
export function hasWork(store, now = new Date()) {
  const nowIso = stamp(now);
  for (const a of store.col('announcements').values()) if (a.next && a.next <= nowIso && a.status !== 'cancelled') return true;
  return false;
}

/**
 * Claim a batch to send (inside a write): up to `max` people's queued deliveries of the oldest announcement
 * with work due, marked sending. Consent is checked again here on the latest data: a text for someone who
 * no longer allows texts (or changed their number) is skipped, as is an email for someone who turned emails
 * off. Deliveries claimed long ago by an instance that stopped are marked failed (never sent twice).
 * Returns { id, ann, claim, jobs: [{ userId, lang, name, email, to, channels }] } or null.
 */
export function claimWork(store, { settings, now, by, max = 50 }) {
  const nowIso = stamp(now);
  const staleIso = stamp(new Date(now.getTime() - STALE_MS));
  const list = store.list('announcements', (a) => a.next && a.next <= nowIso && a.recipients && a.status !== 'cancelled')
    .sort((a, b) => String(a.next).localeCompare(String(b.next)));
  for (const ann of list) {
    const recipients = { ...ann.recipients };
    const jobs = [];
    let changed = false;
    for (const [userId, cur] of Object.entries(recipients)) {
      const r = { ...cur };
      const job = { userId, lang: r.lang, channels: [] };
      let u;
      let touched = false;
      const set = (ch, d) => { r[ch] = d; touched = true; };
      for (const ch of CHANNELS) {
        const d = r[ch];
        if (!d) continue;
        if (d.s === 'sending' && d.at && d.at <= staleIso) { set(ch, { s: 'failed', r: 'interrupted', at: nowIso }); continue; }
        if (d.s !== 'queued' || (d.notBefore && d.notBefore > nowIso) || jobs.length >= max) continue;
        if (u === undefined) u = store.get('users', userId);
        if (!u || u.active === false) set(ch, { s: 'skipped', r: 'inactive', at: nowIso });
        else if (ch === 'sms' && !smsAllowed(u, settings)) set(ch, { s: 'skipped', r: 'consentWithdrawn', at: nowIso });
        else if (ch === 'email' && !emailConsentOf(u)) set(ch, { s: 'skipped', r: 'consentWithdrawn', at: nowIso });
        else {
          set(ch, { ...d, s: 'sending', at: nowIso, by });
          job.channels.push(ch);
          job.name = u.name;
          if (ch === 'email') job.email = u.email;
          if (ch === 'sms') job.to = u.smsPhone;
        }
      }
      if (touched) { recipients[userId] = r; changed = true; }
      if (job.channels.length) jobs.push(job);
    }
    if (!changed) continue;
    store.update('announcements', ann.id, { recipients, ...settle({ ...ann, recipients }, nowIso) });
    if (jobs.length) {
      const { recipients: _r, ...rest } = ann;
      return { id: ann.id, ann: rest, claim: nowIso, jobs };
    }
  }
  return null;
}

/**
 * Record a batch's results (inside a write): [{ userId, channel, s: 'sent' | 'failed' | 'queued', r }].
 * 'queued' puts it back for the next run (rate limited), up to MAX_ATTEMPTS tries.
 */
export function applyResults(store, id, results, { now }) {
  const ann = store.get('announcements', id);
  if (!ann) return null;
  const nowIso = stamp(now);
  const recipients = { ...ann.recipients };
  for (const x of results) {
    const r = recipients[x.userId];
    if (!r?.[x.channel]) continue;
    const prev = r[x.channel];
    const tries = (prev.n || 0) + (x.r === 'outOfTime' ? 0 : 1); // the run's time ran out: not a try
    const d = x.s === 'queued' && tries >= MAX_ATTEMPTS ? { s: 'failed', r: x.r || 'rateLimited', at: nowIso, n: tries }
      : x.s === 'queued' ? { s: 'queued', n: tries, ...(prev.notBefore ? { notBefore: prev.notBefore } : {}) }
        : { s: x.s, ...(x.r ? { r: String(x.r).slice(0, 200) } : {}), at: nowIso, ...(tries > 1 ? { n: tries } : {}) };
    recipients[x.userId] = { ...r, [x.channel]: d };
  }
  const next = { ...ann, recipients };
  return store.update('announcements', id, { recipients, ...settle(next, nowIso) });
}

// ---------- RPC methods (merged into core/service.js) ----------

/**
 * @param deps.channels  what's set up to send: { push, appPush, email, sms, simulate } (server/announcements.js;
 *                       the demo passes { simulate: true, … } and everything goes out at once).
 */
export function announcementApi({ store, now, settings, fail, needAuth, needAdmin, langOf, channels = {} }) {
  const needAnnouncer = (a) => { needAuth(a); if (!canAnnounce(a)) fail(403, 'Managers only'); };
  const nameOf = (id) => store.get('users', id)?.name || '';
  const text = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

  /** A draft from the composer. loose: for the summary while it's being written (no title or message yet is fine). */
  function draftOf(actor, a = {}, { loose = false } = {}) {
    const d = {
      title: text(a.title, TITLE_MAX).replace(/\n/g, ' '), body: text(a.body, BODY_MAX),
      titleEs: text(a.titleEs, TITLE_MAX).replace(/\n/g, ' '), bodyEs: text(a.bodyEs, BODY_MAX),
      link: LINKS.includes(a.link) ? a.link : '',
      audience: cleanAudience(a.audience, fail, { allowEmpty: loose }),
      email: a.email === true, sms: a.sms === true, urgent: a.urgent === true && canChangeSettings(actor),
    };
    if (loose) return d;
    if (!d.title) fail(400, 'Add a title');
    if (!d.body) fail(400, 'Write the message');
    if (a.urgent === true && !canChangeSettings(actor)) fail(403, 'Only admins can mark an announcement urgent');
    return d;
  }
  function whenOf(a) {
    if (!a.sendAt) return null;
    const t = Date.parse(a.sendAt);
    if (!Number.isFinite(t)) fail(400, 'Pick a time in the future');
    if (t < now().getTime() + 60_000) fail(400, 'Pick a time in the future');
    if (t > now().getTime() + SCHEDULE_MAX_DAYS * 86400000) fail(400, 'Schedule it within 90 days');
    return new Date(t);
  }

  const view = (a) => {
    const { recipients, ...rest } = a;
    return { ...rest, createdByName: nameOf(a.createdBy), cancelledByName: a.cancelledBy ? nameOf(a.cancelledBy) : '', counts: countsOf(a, now().getTime()) };
  };
  /** What a recipient sees, in their language. */
  const mine = (a, userId, lang) => {
    const v = inLanguage(a, lang);
    return { id: a.id, title: v.title, body: v.body, lang: v.lang, link: a.link || '', at: a.releasedAt, from: nameOf(a.createdBy), urgent: !!a.urgent, read: !!a.recipients?.[userId]?.readAt };
  };
  const detail = (a) => ({
    ...view(a),
    rows: Object.entries(a.recipients || {}).map(([userId, r]) => ({ userId, name: nameOf(userId) || '—', lang: r.lang, push: r.push, email: r.email, sms: r.sms, readAt: r.readAt || null }))
      .sort((x, y) => x.name.localeCompare(y.name)),
  });
  const forReader = (actor, a) => {
    const recipient = !!a.recipients?.[actor.id];
    if (!recipient && !canAnnounce(actor)) fail(404, 'Announcement not found');
    return { mine: recipient ? mine(a, actor.id, langOf(actor)) : null, manage: canAnnounce(actor) ? detail(a) : null };
  };

  return {
    // Before sending: who it reaches on each channel, the Spanish speakers, quiet hours, and the texts as they'll read.
    'announcements.summary': (actor, a = {}) => {
      needAnnouncer(actor);
      const st = settings();
      const d = draftOf(actor, a, { loose: true });
      const when = a.sendAt && Number.isFinite(Date.parse(a.sendAt)) ? new Date(Date.parse(a.sendAt)) : now();
      const people = resolveAudience(store, d.audience, { settings: st, day: todayStr(when), senderId: actor.id });
      const plan = planDelivery(store, d, people, { settings: st, channels, when });
      const cfg = announceSettings(st);
      const quiet = inQuietHours(when, cfg);
      const out = summarize(plan, { quietUntil: d.sms && quiet && !d.urgent ? stamp(quietEndAfter(when, cfg)) : null });
      const restaurant = st.restaurantName || 'ShiftBoard';
      const sample = (lang) => { const v = inLanguage(d, lang); return smsText({ restaurant, title: v.title, body: v.body, lang, url: 'https://…/#/announcements/…' }); };
      return {
        ...out, quiet, cfg, channels: { push: !!(channels.push || channels.appPush), email: !!channels.email, sms: !!channels.sms },
        spanishVersion: !!(d.titleEs || d.bodyEs),
        sms: { ...out.sms, text: { en: sample('en'), es: sample('es') } },
        names: plan.slice(0, 400).map((p) => ({ id: p.user.id, name: p.user.name })),
      };
    },
    // Send now, or schedule (sendAt). The server sends it after the commit; the demo right away.
    'announcements.send': (actor, a = {}) => {
      needAnnouncer(actor);
      const d = draftOf(actor, a);
      if (d.sms && a.scheduleRelated !== true) fail(400, 'Confirm that the text is about the schedule');
      const when = whenOf(a);
      const at = now().toISOString();
      if (!when) {
        const st = settings();
        if (!resolveAudience(store, d.audience, { settings: st, day: todayStr(now()), senderId: actor.id }).length) fail(400, 'Nobody is in this audience');
      }
      const doc = store.insert('announcements', { id: uid('ann'), ...d, status: when ? 'scheduled' : 'queued', sendAt: when ? stamp(when) : null,
        next: when ? stamp(when) : at, createdAt: at, createdBy: actor.id });
      if (!when && channels.simulate) return view(releaseAnnouncement(store, doc, { settings: settings(), channels, now: now() }));
      return view(doc);
    },
    'announcements.cancel': (actor, { id } = {}) => {
      needAnnouncer(actor);
      const a = store.get('announcements', id);
      if (!a) fail(404, 'Announcement not found');
      if (a.status !== 'scheduled') fail(409, 'Only scheduled announcements can be cancelled');
      return view(store.update('announcements', id, { status: 'cancelled', next: null, cancelledAt: now().toISOString(), cancelledBy: actor.id }));
    },
    // scope 'sent' (managers: everything sent and scheduled, newest first) or 'mine' (what I received).
    'announcements.list': (actor, { scope } = {}) => {
      needAuth(actor);
      if (scope !== 'mine' && canAnnounce(actor)) {
        return store.list('announcements').sort((a, b) => String(b.sendAt || b.createdAt).localeCompare(String(a.sendAt || a.createdAt))).slice(0, 100).map(view);
      }
      const lang = langOf(actor);
      return store.list('announcements', (a) => !!a.recipients?.[actor.id]).sort((a, b) => String(b.releasedAt).localeCompare(String(a.releasedAt)))
        .slice(0, 50).map((a) => mine(a, actor.id, lang));
    },
    // { mine: what I received (null if I'm not a recipient), manage: the delivery details (managers) }.
    'announcements.get': (actor, { id } = {}) => {
      needAuth(actor);
      const a = store.get('announcements', id);
      if (!a) fail(404, 'Announcement not found');
      return forReader(actor, a);
    },
    // Opening it in the app: the read receipt managers see, and its notification marked read.
    'announcements.open': (actor, { id } = {}) => {
      needAuth(actor);
      let a = store.get('announcements', id);
      if (!a) fail(404, 'Announcement not found');
      const r = a.recipients?.[actor.id];
      if (r && !r.readAt) {
        a = store.update('announcements', id, { recipients: { ...a.recipients, [actor.id]: { ...r, readAt: now().toISOString() } } });
        for (const n of store.list('notifications', (x) => x.userId === actor.id && x.announcementId === id && !x.read)) store.update('notifications', n.id, { read: true });
      }
      return forReader(actor, a);
    },
    // Settings → Announcements (admins): texts per person per day, quiet hours.
    'announcements.saveSettings': (actor, a = {}) => {
      needAdmin(actor);
      const cap = Number(a.smsDailyCap);
      if (!Number.isInteger(cap) || cap < 0 || cap > 10) fail(400, 'Texts per person per day is a number from 0 to 10');
      const ok = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
      if (!ok(a.quietStart) || !ok(a.quietEnd)) fail(400, 'Quiet hours need a start and an end time');
      const clean = { smsDailyCap: cap, quietStart: a.quietStart, quietEnd: a.quietEnd };
      if (store.get('settings', 'settings')) store.update('settings', 'settings', { announcements: clean });
      else store.insert('settings', { ...settings(), id: 'settings', announcements: clean });
      return announceSettings({ announcements: clean });
    },
  };
}
