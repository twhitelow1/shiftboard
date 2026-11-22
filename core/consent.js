// Consent: what people agreed to, in the exact words they were shown, per channel.
//
//   terms  "I agree to the Privacy Policy and Terms" (required to use ShiftBoard)
//   sms    shift schedule text messages (optional; gates every text, see smsAllowed in notify-prefs.js)
//   email  notification emails (optional; account emails such as invites and resets always go out)
//
// Data:
//   consents  append-only: { id, userId, channel, granted, version, lang, text, phone, ip, userAgent, source, at }
//             terms records also keep links: { privacy, terms }, the addresses the screen linked to
//             source: 'onboarding' | 'settings' | 'keyword' (STOP/START texts) | 'migration'
//             Never updated or removed. The newest record per user and channel is their current choice;
//             users.smsConsent and users.emailConsent mirror it for quick checks.
//   users.smsConsent     true only after the person agreed to texts themselves (gates every text)
//   users.emailConsent   true only after the person agreed to notification emails
//   users.smsWelcomedAt  when the one-time welcome text went out (the first opt-in ever; never again)
//
// The wording lives here, in English and Spanish, with a version per channel. Change the words → change
// the version, so every record says which words the person saw. STOP and HELP stay in English in Spanish:
// carriers only act on those keywords.
import { uid } from './store.js';
import { normalizePhone } from './notify-prefs.js'; // a function declaration: fine in the import cycle with notify-prefs.js

export const CHANNELS = ['terms', 'sms', 'email'];
export const SOURCES = ['onboarding', 'settings', 'keyword', 'migration'];

/** The version of each channel's wording. Bump it whenever the words below change. */
export const CONSENT_VERSION = { terms: 'terms-2026-11-22', sms: 'sms-2026-11-22', email: 'email-2026-11-22' };

/**
 * Where the Privacy Policy and Terms live. The server can override them with PRIVACY_URL and TERMS_URL
 * (legalLinks(env)) and hands them to the web app in /api/config, so the owner can move them without a
 * code change. Every terms consent record keeps the links that were shown.
 */
export const LEGAL_LINKS = { privacy: 'https://dublowdigital.com/privacy-policy/', terms: 'https://dublowdigital.com/terms' };
const httpsUrl = (v) => { try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
/** The legal links in use: PRIVACY_URL / TERMS_URL from env when they're https:// addresses, else LEGAL_LINKS. */
export const legalLinks = (env = {}) => ({ privacy: httpsUrl(env.PRIVACY_URL) || LEGAL_LINKS.privacy, terms: httpsUrl(env.TERMS_URL) || LEGAL_LINKS.terms });

/** The exact words on the consent screen (the checkbox labels). */
export const CONSENT_TEXT = {
  en: {
    terms: 'I agree to the Privacy Policy and Terms',
    sms: 'I agree to receive shift schedule text messages from DubLow Digital through ShiftBoard. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help. Consent is not a condition of employment.',
    email: 'I agree to receive email notifications from ShiftBoard about my schedule, shift trades and time off. I can turn them off anytime in My Shifts.',
  },
  es: {
    terms: 'Acepto la Política de privacidad y los Términos',
    sms: 'Acepto recibir mensajes de texto con mi horario de turnos de DubLow Digital a través de ShiftBoard. La frecuencia de los mensajes varía. Pueden aplicar tarifas de mensajes y datos. Responde STOP para cancelar o HELP para obtener ayuda. Dar tu consentimiento no es una condición para tu empleo.',
    email: 'Acepto recibir notificaciones por correo de ShiftBoard sobre mi horario, cambios de turno y días libres. Puedo apagarlas cuando quiera en Mis turnos.',
  },
};

/** The words inside the terms sentence that link to the documents (key: which link in LEGAL_LINKS). */
export const TERMS_LINK_WORDS = {
  en: [{ text: 'Privacy Policy', key: 'privacy' }, { text: 'Terms', key: 'terms' }],
  es: [{ text: 'Política de privacidad', key: 'privacy' }, { text: 'Términos', key: 'terms' }],
};

/** The one text sent on someone's first opt-in ever (exactly these words in English). */
export const WELCOME_TEXT = {
  en: "ShiftBoard by DubLow Digital: You're subscribed to shift schedule alerts. Msg freq varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.",
  es: 'ShiftBoard de DubLow Digital: Te suscribiste a las alertas de tu horario de turnos. La frecuencia de los mensajes varía. Pueden aplicar tarifas de mensajes y datos. Responde HELP para ayuda, STOP para cancelar.',
};

// What My Shifts said before this consent screen existed, for the migration records of people who had texts on.
const LEGACY_SMS_TEXT = 'Texts about your shifts, trades and time off go to this number. Msg & data rates may apply. Reply STOP to opt out.';

const langOk = (l) => (l === 'es' ? 'es' : 'en');
export const consentText = (channel, lang = 'en') => CONSENT_TEXT[langOk(lang)][channel];
export const welcomeSms = (lang = 'en') => WELCOME_TEXT[langOk(lang)];

/**
 * The terms sentence split into plain text and links, for the screen:
 * [{ text: 'I agree to the ' }, { text: 'Privacy Policy', href }, { text: ' and ' }, { text: 'Terms', href }]
 */
export function termsParts(lang = 'en', links = LEGAL_LINKS) {
  const l = langOk(lang);
  const parts = [];
  let rest = CONSENT_TEXT[l].terms;
  for (const link of TERMS_LINK_WORDS[l]) {
    const i = rest.indexOf(link.text);
    if (i < 0) continue;
    if (i > 0) parts.push({ text: rest.slice(0, i) });
    parts.push({ text: link.text, href: links?.[link.key] || LEGAL_LINKS[link.key] });
    rest = rest.slice(i + link.text.length);
  }
  if (rest) parts.push({ text: rest });
  return parts;
}

// ---------- reading the flags ----------

/** Has this person agreed to texts? (users.smsConsent; older records kept it in smsNotifications.) */
export const smsConsentOf = (u) => (typeof u?.smsConsent === 'boolean' ? u.smsConsent : u?.smsNotifications === true);
/** Has this person agreed to notification emails? People from before consent existed were migrated (migrateConsents). */
export const emailConsentOf = (u) => u?.emailConsent === true;
/** 'on' | 'off' | 'stopped' (replied STOP) for someone's texts. */
export const smsStatusOf = (u) => (smsConsentOf(u) ? 'on' : u?.smsStoppedAt ? 'stopped' : 'off');

/** Someone's records, newest first. */
export const consentsOf = (store, userId, channel) => store.list('consents', (c) => c.userId === userId && (!channel || c.channel === channel))
  .sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
/** Has this person ever agreed to the Privacy Policy and Terms? */
export const hasTerms = (store, userId) => store.list('consents', (c) => c.userId === userId && c.channel === 'terms' && c.granted === true).length > 0;

/** Where someone stands, for the app (no IPs or user agents). */
export function consentState(store, user) {
  return {
    terms: hasTerms(store, user.id),
    sms: smsConsentOf(user),
    email: emailConsentOf(user),
    smsStatus: smsStatusOf(user),
  };
}

// ---------- writing records ----------

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

/** Append one consent record. Never call update or remove on consents. */
export function recordConsent(store, { userId, channel, granted, lang = 'en', text, version, phone = null, ip = null, userAgent = null, source, at, links }) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown consent channel ${channel}`);
  if (!SOURCES.includes(source)) throw new Error(`Unknown consent source ${source}`);
  return store.insert('consents', {
    id: uid('cns'), userId, channel, granted: granted === true,
    version: version || CONSENT_VERSION[channel], lang: langOk(lang),
    text: text ?? consentText(channel, lang),
    phone: channel === 'sms' ? clip(phone, 20) : null,
    ip: clip(ip, 64), userAgent: clip(userAgent, 300), source, at,
    ...(channel === 'terms' ? { links: { privacy: links?.privacy || LEGAL_LINKS.privacy, terms: links?.terms || LEGAL_LINKS.terms } } : {}),
  });
}

/**
 * Apply what someone ticked on the consent screen (onboarding, or the one-time screen at sign-in).
 *   choices: { terms, sms, email, phone }. A box counts only when it's exactly true; false records a
 *            "no"; anything else (undefined: the box wasn't shown) changes nothing.
 *   ctx:     { lang, ip, userAgent, source, at, smsEnabled, requireTerms, links (the legal links shown) }
 * Returns the updated user. Throws { status: 400 } messages for missing terms or a missing phone.
 */
export function applyConsents(store, userId, choices = {}, ctx = {}) {
  const fail = (message) => { const e = new Error(message); e.status = 400; throw e; };
  const at = ctx.at || new Date().toISOString();
  const lang = langOk(ctx.lang);
  const base = { userId, lang, ip: ctx.ip, userAgent: ctx.userAgent, source: ctx.source || 'onboarding', at };
  let user = store.get('users', userId);
  if (!user) fail('User not found');
  if (ctx.requireTerms && choices.terms !== true && !hasTerms(store, userId)) fail('Tick the box to agree to the Privacy Policy and Terms');
  let phone = null;
  if (choices.sms === true) {
    if (!ctx.smsEnabled) fail('Text messages aren’t set up for this restaurant yet');
    phone = normalizePhone(choices.phone || user.smsPhone || user.phone);
    if (!phone) fail('Enter your mobile number to get texts');
  }
  if (choices.terms === true) recordConsent(store, { ...base, channel: 'terms', granted: true, links: ctx.links });
  if (typeof choices.sms === 'boolean') {
    recordConsent(store, { ...base, channel: 'sms', granted: choices.sms, phone: phone || user.smsPhone || null });
    user = store.update('users', userId, choices.sms
      ? { smsConsent: true, smsPhone: phone, smsConsentAt: at, smsStoppedAt: null, ...(user.smsWelcomedAt ? {} : { smsWelcomedAt: at }) }
      : { smsConsent: false });
  }
  if (typeof choices.email === 'boolean') {
    recordConsent(store, { ...base, channel: 'email', granted: choices.email });
    user = store.update('users', userId, { emailConsent: choices.email });
  }
  return user;
}

// ---------- people from before consent existed ----------

export const CONSENT_MIGRATION = 'consent-v1';

/**
 * Once per restaurant: everyone keeps what they had. Texts on (the old users.smsNotifications) becomes
 * smsConsent with a migration record; email copies on (the old default) becomes emailConsent. The old
 * fields are retired. Idempotent: a marker document says it's done. Returns how many people changed.
 */
export function migrateConsents(store, { at = new Date().toISOString(), langOf = () => 'en' } = {}) {
  if (store.get('migrations', CONSENT_MIGRATION)) return 0;
  let n = 0;
  for (const u of store.list('users')) {
    const { smsNotifications, emailNotifications, ...rest } = u;
    const sms = typeof u.smsConsent === 'boolean' ? u.smsConsent : smsNotifications === true;
    const email = typeof u.emailConsent === 'boolean' ? u.emailConsent : emailNotifications !== false;
    const next = { ...rest, smsConsent: sms, emailConsent: email };
    if (sms && !u.smsWelcomedAt) next.smsWelcomedAt = u.smsConsentAt || at; // they got the old welcome text
    store.insert('users', next); // replaces the document, without the retired fields
    if (sms && !store.list('consents', (c) => c.userId === u.id && c.channel === 'sms').length) {
      recordConsent(store, { userId: u.id, channel: 'sms', granted: true, lang: langOf(u), text: LEGACY_SMS_TEXT, version: 'legacy-my-shifts',
        phone: u.smsPhone || null, source: 'migration', at: u.smsConsentAt || at });
    }
    n++;
  }
  store.insert('migrations', { id: CONSENT_MIGRATION, at, users: n });
  return n;
}

// ---------- the admin's consent log (CSV) ----------

/** An IP with its last part hidden (203.0.113.x, 2001:db8:1::/48): the log never shows the full address. */
export function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '');
  if (!s) return '';
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}::/48`;
  return '';
}

// Cells that start with = + - @ (or a tab/return) could run as a formula in a spreadsheet.
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every consent record as CSV for carrier and Twilio audits, oldest first. IPs are masked. */
export function consentCsv(store) {
  const users = new Map(store.list('users').map((u) => [u.id, u]));
  const rows = store.list('consents').sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  const head = ['at', 'user_id', 'name', 'email', 'channel', 'granted', 'source', 'version', 'lang', 'phone', 'ip_masked', 'user_agent', 'text', 'links'];
  const lines = [head.join(',')];
  for (const c of rows) {
    const u = users.get(c.userId);
    lines.push([c.at, c.userId, u?.name || '', u?.email || '', c.channel, c.granted ? 'yes' : 'no', c.source, c.version, c.lang, c.phone || '',
      maskIp(c.ip), c.userAgent || '', c.text, c.links ? `${c.links.privacy} ${c.links.terms}` : ''].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
