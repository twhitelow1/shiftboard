// The automatic emails ShiftBoard sends, and how a restaurant edits them (Settings → Email notifications).
//
// Every in-app notification is also emailed to people who agreed to notification emails (core/consent.js).
// Those emails come in types (EMAIL_TYPES): the schedule posted, a shift changed, trade requests, a trade
// approved or denied, time off, events and BEOs, the 86 List, tips, training, and anything else. For each
// type an admin can turn it off, or write their own subject and body in English and Spanish with
// placeholders ({name}, {restaurant}, {week}, {shift}, {link}, {manager}…). The defaults live here in code;
// a restaurant's own versions are in settings.emailTemplates:
//
//   settings.emailTemplates = { [type]: { off?: true, en?: { subject, body }, es?: { subject, body } } }
//
// Templates are plain text the restaurant writes, never HTML: everything is escaped. A blank line starts a
// new paragraph, a single line break stays a line break, and a line that is only [Button text]({link}) (or an
// https:// address) becomes the button.
//
// Account and security emails are FIXED (not editable, never off): invitations, password resets, sign-in
// links, the two-step reset notice and the test email. They carry one-time links and security warnings whose
// exact words matter, and a restaurant switching them off would lock people out.
import { msg } from './messages.js';
import { emailLayout } from './email-layout.js';

/** Placeholders every type has. */
export const COMMON_VARS = ['name', 'restaurant', 'link', 'message'];

/**
 * The editable types, in the order Settings shows them. keys: the notification messages (core/messages.js)
 * that belong to the type; link: notifications from other modules, matched by their link; vars: the extra
 * placeholders the type fills in.
 */
export const EMAIL_TYPES = [
  { id: 'schedulePublished', keys: ['schedulePosted'], vars: ['week', 'manager'] },
  { id: 'eventShiftsPosted', keys: ['eventShiftsPosted'], vars: ['event', 'manager'] },
  { id: 'openShifts', keys: ['openShiftsPosted'], vars: ['count'] },
  { id: 'shiftChanged', keys: ['newShift', 'shiftChanged', 'addedTo', 'removedFrom', 'shiftRemoved', 'weekCleared'], vars: ['shift', 'week', 'manager'] },
  { id: 'tradeRequested', keys: ['wantsPickup', 'givingAway', 'wantsTrade'], vars: ['person', 'shift'] },
  { id: 'tradeUpdate', keys: ['tookYourShift', 'acceptedTrade', 'acceptedShift', 'approvalNeeded', 'declinedTrade', 'cancelledRequest', 'requestCancelled', 'requestFilled'], vars: ['person', 'shift', 'note'] },
  { id: 'tradeApproved', keys: ['approved'], vars: ['shift', 'manager'] },
  { id: 'tradeDenied', keys: ['denied'], vars: ['shift', 'note', 'manager'] },
  { id: 'timeOffRequested', keys: ['requestedOff'], vars: ['person', 'dates'] },
  { id: 'timeOffDecided', keys: ['timeOffDecided'], vars: ['dates', 'status', 'manager'] },
  { id: 'eventUpdated', keys: ['beoUpdated', 'tsBeoChanged', 'newEvent', 'eventCancelled', 'eventComment', 'tsCancelledStaffed', 'tsMovedStaffed'], vars: ['event', 'date', 'person'] },
  { id: 'eightySix', link: '#/86', vars: [] },
  { id: 'tips', keys: ['tipsFinal', 'tipsReopened'], link: '#/tips', vars: [] },
  { id: 'training', link: '#/training', vars: [] },
  { id: 'account', keys: ['roleNow', 'deletionRequested'], vars: ['person'] },
  { id: 'general', vars: [] },
];
const BY_ID = Object.fromEntries(EMAIL_TYPES.map((t) => [t.id, t]));
const BY_KEY = Object.fromEntries(EMAIL_TYPES.flatMap((t) => (t.keys || []).map((k) => [k, t.id])));

/** The emails nobody can edit or turn off, and why (shown in Settings). */
export const FIXED_EMAILS = ['invite', 'passwordReset', 'signInLink', 'securityNotice', 'testEmail'];

/** Which type a stored notification is: its message key, else its link, else 'general'. */
export function typeOfNote(note) {
  if (note?.kind && BY_KEY[note.kind]) return BY_KEY[note.kind];
  const link = String(note?.link || '');
  const hit = EMAIL_TYPES.find((t) => t.link && (link === t.link || link.startsWith(`${t.link}/`)));
  return hit ? hit.id : 'general';
}

export const varsOf = (type) => [...COMMON_VARS, ...(BY_ID[type]?.vars || [])];

/** The default subject and body (what every email said before templates). */
export function defaultTemplate(type, lang = 'en') {
  const E = msg(lang === 'es' ? 'es' : 'en').email;
  const hi = lang === 'es' ? 'Hola, {name}:' : 'Hi {name},';
  return { subject: '{message}', body: `${hi}\n\n{message}\n\n[${E.open}]({link})` };
}

/** The template a type uses in a language: the restaurant's own, else the default. */
export function templateFor(settings, type, lang = 'en') {
  const own = settings?.emailTemplates?.[type]?.[lang === 'es' ? 'es' : 'en'];
  return own?.subject && own?.body ? { ...own, custom: true } : { ...defaultTemplate(type, lang), custom: false };
}
/** Is this type of email on for the restaurant? */
export const typeOn = (settings, type) => settings?.emailTemplates?.[type]?.off !== true;

// ---------- checking what an admin wrote ----------
const PH = /\{([^{}\s]*)\}/g;
const BUTTON = /^\s*\[([^\]\n]{1,60})\]\(([^)\s]+)\)\s*$/;
const LIMITS = { subject: 200, body: 5000 };

/** The placeholders a text uses that its type doesn't have: ['wek']. */
export function unknownPlaceholders(text, type) {
  const ok = new Set(varsOf(type));
  return [...new Set([...String(text || '').matchAll(PH)].map((m) => m[1]).filter((k) => !ok.has(k)))];
}

/**
 * Problems with a template, as { field, code, values } (empty when it's fine). Codes: 'required',
 * 'tooLong', 'unknown' (values: the placeholder names), 'buttonLink' (a button that goes somewhere other than
 * {link} or an https:// address), 'newline' (a subject on several lines).
 */
export function checkTemplate(type, { subject = '', body = '' } = {}) {
  const out = [];
  for (const [field, text] of [['subject', subject], ['body', body]]) {
    if (!String(text).trim()) { out.push({ field, code: 'required' }); continue; }
    if (String(text).length > LIMITS[field]) out.push({ field, code: 'tooLong', values: [LIMITS[field]] });
    const bad = unknownPlaceholders(text, type);
    if (bad.length) out.push({ field, code: 'unknown', values: bad });
  }
  if (/[\r\n]/.test(subject)) out.push({ field: 'subject', code: 'newline' });
  for (const line of String(body).split('\n')) {
    const m = line.match(BUTTON);
    if (m && m[2] !== '{link}' && !/^https:\/\/[^\s<>"']+$/i.test(m[2])) out.push({ field: 'body', code: 'buttonLink', values: [m[2]] });
  }
  return out;
}

// ---------- filling in ----------
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** Fill {placeholders}; unknown ones stay as typed. Values are plain text (escaped later). */
export const fill = (text, vars) => String(text || '').replace(PH, (m, k) => (Object.hasOwn(vars, k) && vars[k] != null ? String(vars[k]) : m));

/**
 * The placeholder values for a notification, from the message's own arguments (core/service.js keeps them,
 * in each language, on the notification as `args`).
 */
export function noteVars(note, lang = 'en') {
  const a = note?.args?.[lang] || note?.args?.en || [];
  const range = (from, to) => (to ? `${from} – ${to}` : from || '');
  switch (note?.kind) {
    case 'schedulePosted': return { week: lang === 'es' ? `${a[0]} al ${a[1]}` : `${a[0]} – ${a[1]}` };
    case 'eventShiftsPosted': return { event: a[0] };
    case 'openShiftsPosted': return { count: a[0] };
    case 'newShift': case 'shiftChanged': case 'addedTo': case 'removedFrom': case 'shiftRemoved': case 'requestFilled': return { shift: a[0] };
    case 'weekCleared': return { week: a[0] };
    case 'wantsPickup': case 'givingAway': case 'tookYourShift': return { person: a[0], shift: a[1] };
    case 'wantsTrade': return { person: a[0], shift: a[1] };
    case 'acceptedTrade': case 'acceptedShift': case 'declinedTrade': case 'cancelledRequest': case 'deletionRequested': return { person: a[0] };
    case 'approvalNeeded': return { shift: a[1], person: a[2] };
    case 'requestCancelled': return { note: a[0] };
    case 'approved': return { shift: a[1] };
    case 'denied': return { shift: a[0], note: a[1] || '' };
    case 'requestedOff': return { person: a[0], dates: range(a[1], a[2]) };
    case 'timeOffDecided': return { status: lang === 'es' ? (a[0] === 'approved' ? 'aprobado' : 'rechazado') : a[0], dates: range(a[1], a[2]) };
    case 'beoUpdated': case 'tsBeoChanged': case 'newEvent': case 'tsCancelledStaffed': case 'tsMovedStaffed': return { event: a[0], date: a[1] };
    case 'eventComment': return { person: a[0], event: a[1] };
    default: return {};
  }
}

/** Sample values for the preview and "Send me a test". */
export function sampleVars(type, lang = 'en', { restaurant = 'Our Restaurant', name = '', appUrl = 'https://app.example' } = {}) {
  const es = lang === 'es';
  const shift = es ? 'Server (Restaurant) vie, 4 de dic · 4 pm–cierre' : 'Server (Restaurant) Fri, Dec 4 4p–CL';
  const base = {
    name: firstName(name) || (es ? 'Ana' : 'Alex'), restaurant, link: `${appUrl}/#/my`,
    week: es ? '30 nov al 6 dic' : 'Nov 30 – Dec 6', shift, manager: es ? 'Jordan' : 'Jordan', person: 'Riley',
    event: es ? 'Cena de aniversario' : 'Anniversary Dinner', date: es ? 'sáb, 5 de dic' : 'Sat, Dec 5',
    dates: es ? 'lun, 7 de dic – mar, 8 de dic' : 'Mon, Dec 7 – Tue, Dec 8', status: es ? 'aprobado' : 'approved', count: 3,
    note: es ? 'Ya hay suficiente personal ese día' : 'We’re fully staffed that night',
  };
  const M = msg(es ? 'es' : 'en');
  const message = {
    schedulePublished: M.schedulePosted(es ? '30 nov' : 'Nov 30', es ? '6 dic' : 'Dec 6'),
    eventShiftsPosted: M.eventShiftsPosted(base.event),
    openShifts: M.openShiftsPosted(3),
    shiftChanged: M.shiftChanged(shift),
    tradeRequested: M.givingAway(base.person, shift),
    tradeUpdate: M.acceptedTrade(base.person),
    tradeApproved: M.approved('swap', shift),
    tradeDenied: M.denied(shift, base.note),
    timeOffRequested: M.requestedOff(base.person, es ? 'lun, 7 de dic' : 'Mon, Dec 7', es ? 'mar, 8 de dic' : 'Tue, Dec 8'),
    timeOffDecided: M.timeOffDecided('approved', es ? 'lun, 7 de dic' : 'Mon, Dec 7', es ? 'mar, 8 de dic' : 'Tue, Dec 8'),
    eventUpdated: M.beoUpdated(base.event, base.date),
    eightySix: es ? 'Bar: se acabó Mezcal' : 'Bar: 86 Mezcal',
    tips: M.tipsFinal(es ? '30 nov – 6 dic' : 'Nov 30 – Dec 6', '$412.50'),
    training: es ? 'Lee la página actualizada “Cómo reportar una ausencia” del manual del empleado.' : 'Please read the updated “Calling out” page in the employee manual.',
    account: M.roleNow(es ? 'Supervisor' : 'Supervisor'),
    general: es ? 'Hay novedades en ShiftBoard.' : 'There’s something new in ShiftBoard.',
  }[type] || '';
  return { ...base, message };
}

/**
 * An email from a template: { subject, html, text }.
 * @param {object} o
 * @param {{subject: string, body: string}} o.template
 * @param {object} o.vars     placeholder values (plain text)
 * @param {string} o.restaurant
 * @param {object} [o.brand]  { color, logoUrl }
 * @param {string} [o.lang]
 */
export function renderTemplate({ template, vars, restaurant, brand, lang = 'en' }) {
  const E = msg(lang === 'es' ? 'es' : 'en').email;
  const v = { ...vars };
  if (!v.name) v.name = lang === 'es' ? 'equipo' : E.there;
  let subject = fill(template.subject, v).replace(/\s+/g, ' ').trim();
  if (subject.length > 90) subject = `${subject.slice(0, 87)}…`;
  // Paragraphs and the button come from the template's own lines, so a value can never become a button.
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) blocks.push({ kind: 'p', lines: para }); para = []; };
  for (const raw of String(template.body || '').replace(/\r/g, '').split('\n')) {
    const b = raw.match(BUTTON);
    if (b) {
      flush();
      const url = b[2] === '{link}' ? v.link : b[2];
      if (/^https?:\/\/[^\s<>"']+$/i.test(url || '')) blocks.push({ kind: 'button', label: fill(b[1], v), url });
      continue;
    }
    if (!raw.trim()) { flush(); continue; }
    para.push(fill(raw, v));
  }
  flush();
  const { html, text } = emailLayout({ restaurant, brand, lang, blocks, footer: E.notificationFooter });
  return { subject: subject || restaurant, html, text };
}

/**
 * The email for a notification to one person.
 * @param {object} o  { note, user, settings, appUrl, brand, lang, by: the name of who made the change }
 */
export function notificationTemplateEmail({ note, user, settings, appUrl, brand, lang = 'en', by = '' }) {
  const type = typeOfNote(note);
  const template = templateFor(settings, type, lang);
  const restaurant = settings?.restaurantName || 'ShiftBoard';
  const vars = {
    ...noteVars(note, lang),
    name: firstName(user?.name), restaurant, link: `${appUrl}/${note.link || '#/my'}`, message: note.text || '', manager: by || '',
  };
  return { to: user.email, type, ...renderTemplate({ template, vars, restaurant, brand, lang }) };
}

// ---------- the restaurant's settings (Settings → Email notifications, admins) ----------
/**
 * emailTemplates.get / .save / .reset for core/service.js.
 * ctx: { store, settings, putSettings, needAdmin, fail }
 */
export function emailTemplateApi({ settings, putSettings, needAdmin, fail }) {
  const view = () => {
    const st = settings();
    return {
      types: EMAIL_TYPES.map((t) => ({
        id: t.id, vars: varsOf(t.id), on: typeOn(st, t.id),
        en: templateFor(st, t.id, 'en'), es: templateFor(st, t.id, 'es'),
        defaults: { en: defaultTemplate(t.id, 'en'), es: defaultTemplate(t.id, 'es') },
      })),
      fixed: FIXED_EMAILS,
      emailNotifications: st.emailNotifications !== false,
    };
  };
  const put = (type, fn) => {
    if (!BY_ID[type]) fail(400, 'Unknown email type');
    const all = { ...(settings().emailTemplates || {}) };
    const next = fn({ ...(all[type] || {}) });
    if (Object.keys(next).length) all[type] = next; else delete all[type];
    putSettings({ emailTemplates: all });
    return view();
  };
  return {
    'emailTemplates.get': (actor) => { needAdmin(actor); return view(); },
    /** Turn a type on or off, and/or save its subject and body in one language. */
    'emailTemplates.save': (actor, { type, on, lang, subject, body } = {}) => {
      needAdmin(actor);
      return put(type, (cur) => {
        if (typeof on === 'boolean') { if (on) delete cur.off; else cur.off = true; }
        if (subject !== undefined || body !== undefined) {
          if (lang !== 'en' && lang !== 'es') fail(400, 'Pick English or Spanish');
          const t = { subject: String(subject ?? '').trim(), body: String(body ?? '').replace(/\r/g, '').trim() };
          const problems = checkTemplate(type, t);
          const unknown = problems.find((p) => p.code === 'unknown');
          if (unknown) fail(400, `Unknown placeholder: {${unknown.values[0]}}`);
          if (problems.some((p) => p.code === 'required')) fail(400, 'Write a subject and a message');
          if (problems.some((p) => p.code === 'tooLong')) fail(400, 'That email is too long');
          if (problems.some((p) => p.code === 'buttonLink')) fail(400, 'A button can only go to {link} or an https:// address');
          if (problems.some((p) => p.code === 'newline')) fail(400, 'Keep the subject on one line');
          const def = defaultTemplate(type, lang);
          if (t.subject === def.subject && t.body === def.body) delete cur[lang]; else cur[lang] = t;
        }
        return cur;
      });
    },
    /** Back to the default words (one language, or both). */
    'emailTemplates.reset': (actor, { type, lang } = {}) => {
      needAdmin(actor);
      return put(type, (cur) => {
        for (const l of lang === 'en' || lang === 'es' ? [lang] : ['en', 'es']) delete cur[l];
        return cur;
      });
    },
  };
}
