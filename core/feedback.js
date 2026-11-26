// Feedback box: anyone signed in leaves a suggestion, feedback, a concern / report or a shout-out, anonymously by
// default or signed with their name. Readers (managers and up; supervisors when an admin allows it; Concern / report
// to Admins and Super Admins only, by default) work through an inbox with statuses, a reply thread with the person
// who wrote it, internal notes, and can share an edited version on the team's "You said, we did" board.
// Plan feature `feedback` (every plan). Role features `feedback` (submit, My feedback, the board) and
// `feedbackInbox` (read) in core/role-features.js. Shared by the server and the in-browser demo.
//
// Anonymity is in the data, not only on screen (docs/features/FEEDBACK-BOX.md has the whole design and its limits):
//   - an anonymous entry keeps no user id, name, email, IP, user agent, device, push token or language, and no link
//     back to the person anywhere: no audit log entry, no `by` on the notifications it causes, the same readers are
//     told whoever wrote it (a reader who writes one is told too), and its ids are random (core/store.js uid() ends
//     with the clock, which would give away the time).
//   - the date only, never the time of day: entries and the submitter's own messages keep `date` (YYYY-MM-DD).
//     Readers' replies and notes keep their time: readers aren't anonymous.
//   - the rate limit counts per person per day without saying who: one document (feedbackLimits/today) holds
//     { day, counts: { HMAC(key, userId|day|what): n } }. key is a server secret (server/app.js passes it as
//     opts.feedbackKey). The counts are wiped by the first feedback call after the day ends, and never sit on an entry.
//   - following up anonymously: the person gets a follow-up code once (16 characters, 80 bits). The entry keeps only
//     its SHA-256. With the code they open the entry, read replies and write back, still anonymously. The apps keep
//     the codes on the device (localStorage on the web, the phone's storage in the app) to show "new reply" badges.
//   - signed entries keep the user id, readers see the name, and the person follows them up in My feedback.
//
// Data:
//   feedback        { id, kind, topic, message, date, signed, userId? (signed only), codeHash? (anonymous only),
//                     status, thread: [{ id, from: 'reader', byId, at, text } | { id, from: 'submitter', date, text }],
//                     notes: [{ id, byId, at, text }] (readers only), nameOk (signed: may the board show the name),
//                     shared: null | { text, reply, date, showName, byId } }
//   feedbackConfig  'main': { kinds: [{ id, en, es, on, adminsOnly, safety }], topics: [{ id, en, es }],
//                     supervisorsCanRead, safetyNote: { en, es } }
//   feedbackLimits  'today': { day, counts } (above)
//
// No AI reads entries, and the Claude connector and Ask ShiftBoard have no tools for them (server/tools/index.js).
import { roleOf } from './roles.js';
import { roleAllows } from './role-features.js';
import { sha256Hex, hmacHex } from './sha256.js';

export const STATUSES = ['new', 'seen', 'in_progress', 'done', 'wont_do'];
export const SUBMITS_PER_DAY = 5;
export const MESSAGES_PER_DAY = 30;
export const MAX_MESSAGE = 2000;
const MAX_THREAD = 100;

export const DEFAULT_KINDS = [
  { id: 'suggestion', en: 'Suggestion', es: 'Sugerencia', on: true, adminsOnly: false, safety: false },
  { id: 'feedback', en: 'Feedback', es: 'Comentario', on: true, adminsOnly: false, safety: false },
  { id: 'concern', en: 'Concern / report', es: 'Inquietud / reporte', on: true, adminsOnly: true, safety: true },
  { id: 'shoutout', en: 'Shout-out', es: 'Reconocimiento', on: true, adminsOnly: false, safety: false },
];
export const DEFAULT_TOPICS = [
  { id: 'schedule', en: 'Schedule', es: 'Horario' },
  { id: 'kitchen', en: 'Kitchen', es: 'Cocina' },
  { id: 'foh', en: 'Front of house', es: 'Salón' },
  { id: 'equipment', en: 'Equipment', es: 'Equipo y utensilios' },
  { id: 'management', en: 'Management', es: 'Gerencia' },
  { id: 'other', en: 'Other', es: 'Otro' },
];
export const DEFAULT_SAFETY_NOTE = {
  en: 'Urgent safety issues (someone hurt, a fire, gas, a threat) can’t wait for the Feedback box: tell the manager on duty in person, or call the call-out line, right now.',
  es: 'Los problemas urgentes de seguridad (alguien herido, un incendio, gas, una amenaza) no pueden esperar al buzón: avísale en persona al gerente de turno o llama a la línea para avisar, ahora mismo.',
};
export const DEFAULT_CONFIG = { kinds: DEFAULT_KINDS, topics: DEFAULT_TOPICS, supervisorsCanRead: false, safetyNote: DEFAULT_SAFETY_NOTE };

const STATUS_WORDS = {
  en: { new: 'New', seen: 'Seen', in_progress: 'In progress', done: 'Done', wont_do: 'Won’t do' },
  es: { new: 'Nuevo', seen: 'Visto', in_progress: 'En proceso', done: 'Hecho', wont_do: 'No se hará' },
};
export const statusLabel = (s, lang = 'en') => (STATUS_WORDS[lang] || STATUS_WORDS.en)[s] || s;

// ---------- random ids and follow-up codes (never Math.random or the clock) ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters: no 0/O, 1/I
function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
/** A random id with no time in it. */
export const randomId = (prefix) => `${prefix}_${Array.from(randomBytes(9), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14)}`;
/** A new follow-up code: XXXX-XXXX-XXXX-XXXX, 80 random bits. */
export function newCode() {
  const chars = Array.from(randomBytes(16), (b) => CODE_ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g).join('-');
}
/** A code as typed (spaces, dashes, lowercase) → its canonical 16 characters, or '' when it can't be one. */
export function normalizeCode(code) {
  const c = String(code || '').toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{16}$/.test(c) ? c : '';
}
export const codeHash = (code) => sha256Hex(`shiftboard-feedback-code:${normalizeCode(code)}`);

// A fallback rate-limit key for the demo and tests (one per process). The server always passes opts.feedbackKey.
let processKey = null;
const fallbackKey = () => (processKey ??= Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join(''));

// ---------- config ----------
const str = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

/** The stored config with defaults filled in. */
export function configOf(store) {
  const c = store.get('feedbackConfig', 'main') || {};
  return {
    kinds: Array.isArray(c.kinds) && c.kinds.length ? c.kinds : DEFAULT_KINDS,
    topics: Array.isArray(c.topics) ? c.topics : DEFAULT_TOPICS,
    supervisorsCanRead: c.supervisorsCanRead === true,
    safetyNote: { en: c.safetyNote?.en || DEFAULT_SAFETY_NOTE.en, es: c.safetyNote?.es || DEFAULT_SAFETY_NOTE.es },
  };
}

/** Check what an admin sends from Settings → Feedback box. Kinds can be renamed, added and turned off (not deleted). */
export function cleanConfig(next, current, fail) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) fail(400, 'Send the Feedback box settings');
  const out = { ...current };
  if ('kinds' in next) {
    if (!Array.isArray(next.kinds) || next.kinds.length > 12) fail(400, 'Send up to 12 kinds');
    const seen = new Set();
    const kinds = next.kinds.map((k) => {
      const en = str(k?.en, 40);
      if (!en) fail(400, 'Every kind needs a name');
      let id = str(k?.id, 30) || slug(en) || 'kind';
      if (!/^[a-z0-9_]{1,30}$/.test(id)) id = slug(id) || 'kind';
      while (seen.has(id)) id = `${id}_2`.slice(-30);
      seen.add(id);
      return { id, en, es: str(k?.es, 40), on: k?.on !== false, adminsOnly: k?.adminsOnly === true, safety: k?.safety === true };
    });
    // A kind that's in use can't disappear: it stays, turned off.
    for (const old of current.kinds) if (!seen.has(old.id)) kinds.push({ ...old, on: false });
    if (!kinds.some((k) => k.on)) fail(400, 'Keep at least one kind on');
    out.kinds = kinds;
  }
  if ('topics' in next) {
    if (!Array.isArray(next.topics) || next.topics.length > 20) fail(400, 'Send up to 20 topics');
    const seen = new Set();
    out.topics = next.topics.map((x) => {
      const en = str(x?.en, 40);
      if (!en) fail(400, 'Every topic needs a name');
      let id = str(x?.id, 30) || slug(en) || 'topic';
      if (!/^[a-z0-9_]{1,30}$/.test(id)) id = slug(id) || 'topic';
      while (seen.has(id)) id = `${id}_2`.slice(-30);
      seen.add(id);
      return { id, en, es: str(x?.es, 40) };
    });
  }
  if ('supervisorsCanRead' in next) out.supervisorsCanRead = next.supervisorsCanRead === true;
  if ('safetyNote' in next) {
    const n = next.safetyNote || {};
    out.safetyNote = { en: str(n.en, 600) || DEFAULT_SAFETY_NOTE.en, es: str(n.es, 600) || DEFAULT_SAFETY_NOTE.es };
  }
  return out;
}

const labelIn = (item, lang) => (item ? (lang === 'es' && item.es ? item.es : item.en) : '');

// ---------- who reads ----------
const READER_ROLES = ['supervisor', 'manager', 'admin', 'super_admin'];
const ADMIN_ROLES = ['admin', 'super_admin'];

/** Can this person read the Feedback inbox at all? Role (managers and up; supervisors by the setting) ∩ Roles & features. */
export function canRead(user, cfg, settings) {
  const role = roleOf(user);
  if (!user || user.active === false || !READER_ROLES.includes(role)) return false;
  if (role === 'supervisor' && !cfg.supervisorsCanRead) return false;
  return roleAllows(user, settings).feedbackInbox !== false;
}
/** Can this reader read entries of this kind? Admins-only kinds (Concern / report by default) go to Admins and Super Admins. */
export function canReadKind(user, cfg, settings, kindId) {
  if (!canRead(user, cfg, settings)) return false;
  const kind = cfg.kinds.find((k) => k.id === kindId);
  return !kind?.adminsOnly || ADMIN_ROLES.includes(roleOf(user));
}

/**
 * The Feedback box's RPCs.
 * @param {object} o
 * @param {string} [o.key]      the rate limit's HMAC key (server secret); a per-process one when missing (demo, tests)
 * @param {Function} o.notify   the service's notify(userIds, text, link, extra): for notifications that may say who acted
 * @param {Function} [o.modToday]  (actor) => { callOutPhone, managers: [{ name, phone }] } for the safety note
 */
export function feedbackApi({ store, now, today, settings, fail, needAuth, needAdmin, langOf, notify, key, modToday }) {
  const cfg = () => configOf(store);
  const userById = (id) => store.get('users', id);
  const kindOf = (c, id) => c.kinds.find((k) => k.id === id);
  const topicOf = (c, id) => c.topics.find((x) => x.id === id);
  const mustRead = (actor, c = cfg()) => { needAuth(actor); if (!canRead(actor, c, settings())) fail(403, 'Only the people who read the Feedback box can do this'); };
  const entryFor = (actor, id, c = cfg()) => {
    mustRead(actor, c);
    const e = typeof id === 'string' ? store.get('feedback', id) : null;
    if (!e || !canReadKind(actor, c, settings(), e.kind)) fail(404, 'That entry isn’t here');
    return e;
  };
  const text = (v, max = MAX_MESSAGE) => {
    const t = str(v, max + 1);
    if (!t) fail(400, 'Write a message first');
    if (t.length > max) fail(400, 'That message is too long');
    return t;
  };

  // ----- the rate limit: one document, counts by HMAC, wiped when the day changes -----
  const hkey = key || fallbackKey();
  function limits() {
    const day = today();
    const doc = store.get('feedbackLimits', 'today');
    if (!doc) return store.insert('feedbackLimits', { id: 'today', day, counts: {} });
    if (doc.day !== day) return store.update('feedbackLimits', 'today', { day, counts: {} });
    return doc;
  }
  /** Count one use of `what` for this person today; refuse past the cap. */
  function take(actor, what, cap, message) {
    const doc = limits();
    const k = hmacHex(hkey, `${actor.id}|${doc.day}|${what}`);
    const n = doc.counts?.[k] || 0;
    if (n >= cap) fail(429, message);
    store.update('feedbackLimits', 'today', { counts: { ...doc.counts, [k]: n + 1 } });
  }
  const purge = () => { const doc = store.get('feedbackLimits', 'today'); if (doc && doc.day !== today()) limits(); };

  // ----- notifications -----
  /** Readers of a kind, worked out the same way whoever wrote the entry (the writer included, if they read). */
  const readersOf = (c, kindId) => store.list('users', (u) => u.active !== false && canReadKind(u, c, settings(), kindId)).map((u) => u.id);
  /**
   * Tell readers about an entry: the kind and topic only, never the message. Written here rather than with the
   * service's notify(), which adds who made the change (`by`). noText: never texted (server/channels.js).
   */
  function tellReaders(c, entry, words) {
    const at = now().toISOString();
    const head = (lang) => [labelIn(kindOf(c, entry.kind), lang) || entry.kind, labelIn(topicOf(c, entry.topic), lang)].filter(Boolean).join(' · ');
    const i18n = { en: words.en(head('en')), es: words.es(head('es')) };
    for (const id of new Set(readersOf(c, entry.kind))) {
      const lang = langOf(userById(id));
      store.insert('notifications', { id: randomId('ntf'), userId: id, text: i18n[lang] || i18n.en, i18n, link: '#/feedback-inbox', read: false, at, noText: true, feedback: true });
    }
  }
  const NEW_WORDS = { en: (h) => `New in the Feedback box: ${h}`, es: (h) => `Nuevo en el buzón de sugerencias: ${h}` };
  const MSG_WORDS = { en: (h) => `New message in the Feedback box: ${h}`, es: (h) => `Nuevo mensaje en el buzón de sugerencias: ${h}` };
  /** Tell a signed entry's writer (normal notification, never a text). */
  function tellSigner(c, entry, words, link = '#/feedback/mine') {
    if (!entry.signed || !entry.userId || !userById(entry.userId) || userById(entry.userId).active === false) return;
    const kind = (lang) => labelIn(kindOf(c, entry.kind), lang) || entry.kind;
    notify([entry.userId], { en: words.en(kind('en')), es: words.es(kind('es')) }, link, { noText: true, feedback: true });
  }

  // ----- views -----
  const nameOf = (id) => userById(id)?.name || '';
  const threadFor = (entry) => (entry.thread || []).map((m) => (m.from === 'reader'
    ? { id: m.id, from: 'reader', name: nameOf(m.byId), at: m.at, text: m.text }
    : { id: m.id, from: 'submitter', date: m.date, text: m.text }));
  const base = (c, e, lang) => ({
    kind: e.kind, kindLabel: labelIn(kindOf(c, e.kind), lang) || e.kind, topic: e.topic || '', topicLabel: labelIn(topicOf(c, e.topic), lang),
    message: e.message, date: e.date, status: e.status, statusLabel: statusLabel(e.status, lang), signed: !!e.signed,
    replies: (e.thread || []).filter((m) => m.from === 'reader').length,
  });
  const sharedView = (e) => (e.shared ? { text: e.shared.text, reply: e.shared.reply || '', date: e.shared.date, showName: !!e.shared.showName } : null);
  /** What the person who wrote it sees (by code or in My feedback): never internal notes or who read it. */
  const submitterView = (c, e, lang) => ({ ...base(c, e, lang), ...(e.signed ? { id: e.id, nameOk: !!e.nameOk } : {}), thread: threadFor(e), shared: sharedView(e) });
  /** What readers see: the writer's name only when they signed it. */
  const readerView = (c, e, lang, { full = false } = {}) => ({
    id: e.id, ...base(c, e, lang), author: e.signed ? { id: e.userId, name: nameOf(e.userId) || '' } : null, nameOk: e.signed ? !!e.nameOk : false,
    shared: sharedView(e), adminsOnly: !!kindOf(c, e.kind)?.adminsOnly,
    ...(full ? {
      thread: threadFor(e), notes: (e.notes || []).map((n) => ({ id: n.id, name: nameOf(n.byId), at: n.at, text: n.text })),
      statuses: STATUSES.map((s) => ({ id: s, label: statusLabel(s, lang) })),
    } : {}),
  });
  const formView = (actor, c, lang) => ({
    kinds: c.kinds.filter((k) => k.on).map((k) => ({ id: k.id, label: labelIn(k, lang), safety: !!k.safety, adminsOnly: !!k.adminsOnly })),
    topics: c.topics.map((x) => ({ id: x.id, label: labelIn(x, lang) })),
    safetyNote: c.safetyNote[lang] || c.safetyNote.en,
    canRead: canRead(actor, c, settings()),
    supervisorsCanRead: c.supervisorsCanRead,
  });

  const api = {
    // The form: kinds, topics, the safety note with the call-out line and today's managers, and whether I read.
    'feedback.form.get': (actor) => {
      needAuth(actor);
      purge();
      const c = cfg();
      let safety = { callOutPhone: '', managers: [] };
      try {
        const m = modToday ? modToday(actor) : null;
        if (m) safety = { callOutPhone: m.callOutPhone || '', managers: (m.managers || []).map((x) => ({ name: x.name, phone: x.phone || '' })) };
      } catch { /* the note shows without them */ }
      return { ...formView(actor, c, langOf(actor)), ...safety };
    },

    // Leave an entry. Anonymous (the default) stores no link to the person and answers with the follow-up code, once.
    'feedback.submit': (actor, { kind, topic, message, signed } = {}) => {
      needAuth(actor);
      const c = cfg();
      const k = kindOf(c, kind);
      if (!k || !k.on) fail(400, 'Pick what kind of entry this is');
      if (topic && !topicOf(c, topic)) fail(400, 'Pick a topic from the list');
      const body = text(message);
      take(actor, 'submit', SUBMITS_PER_DAY, 'That’s the most entries for one day. Try again tomorrow.');
      const isSigned = signed === true;
      const code = isSigned ? null : newCode();
      const entry = {
        id: randomId('fbk'), kind: k.id, topic: topic || '', message: body, date: today(), signed: isSigned,
        ...(isSigned ? { userId: actor.id, nameOk: false } : { codeHash: codeHash(code) }),
        status: 'new', thread: [], notes: [], shared: null,
      };
      store.insert('feedback', entry);
      tellReaders(c, entry, NEW_WORDS);
      return isSigned ? { ok: true, signed: true, id: entry.id, date: entry.date } : { ok: true, signed: false, code, date: entry.date };
    },

    // ----- the person who wrote it -----
    // My signed entries (anonymous ones are only reachable by their code).
    'feedback.mine.list': (actor) => {
      needAuth(actor);
      const c = cfg();
      const lang = langOf(actor);
      return store.list('feedback', (e) => e.signed && e.userId === actor.id)
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).map((e) => submitterView(c, e, lang));
    },
    'feedback.mine.get': (actor, { id } = {}) => {
      needAuth(actor);
      const e = typeof id === 'string' ? store.get('feedback', id) : null;
      if (!e || !e.signed || e.userId !== actor.id) fail(404, 'That entry isn’t here');
      return submitterView(cfg(), e, langOf(actor));
    },
    'feedback.mine.reply': (actor, { id, text: t } = {}) => {
      needAuth(actor);
      const e = typeof id === 'string' ? store.get('feedback', id) : null;
      if (!e || !e.signed || e.userId !== actor.id) fail(404, 'That entry isn’t here');
      return writeBack(actor, e, t);
    },
    // May the "You said, we did" board show my name with this entry? (Readers can only share it anonymously otherwise.)
    'feedback.mine.nameOk': (actor, { id, ok } = {}) => {
      needAuth(actor);
      const e = typeof id === 'string' ? store.get('feedback', id) : null;
      if (!e || !e.signed || e.userId !== actor.id) fail(404, 'That entry isn’t here');
      const patch = { nameOk: ok === true, ...(ok !== true && e.shared?.showName ? { shared: { ...e.shared, showName: false } } : {}) };
      return submitterView(cfg(), store.update('feedback', e.id, patch), langOf(actor));
    },
    // Open an anonymous entry with its follow-up code.
    'feedback.byCode.get': (actor, { code } = {}) => {
      needAuth(actor);
      return submitterView(cfg(), byCode(code), langOf(actor));
    },
    'feedback.byCode.reply': (actor, { code, text: t } = {}) => {
      needAuth(actor);
      return writeBack(actor, byCode(code), t);
    },
    // The codes saved on this device: has anyone replied? (Nothing is written: the device keeps what it has seen.)
    'feedback.codes.summary': (actor, { codes } = {}) => {
      needAuth(actor);
      if (!Array.isArray(codes)) fail(400, 'Send the codes');
      const c = cfg();
      const lang = langOf(actor);
      return codes.slice(0, 50).map((code) => {
        const h = normalizeCode(code) ? codeHash(code) : null;
        const e = h ? store.list('feedback', (x) => !x.signed && x.codeHash === h)[0] : null;
        if (!e) return { found: false };
        const b = base(c, e, lang);
        return { found: true, kind: b.kind, kindLabel: b.kindLabel, topicLabel: b.topicLabel, date: b.date, status: b.status, statusLabel: b.statusLabel, replies: b.replies };
      });
    },

    // ----- the board everyone sees -----
    'feedback.board.list': (actor) => {
      needAuth(actor);
      const c = cfg();
      const lang = langOf(actor);
      return store.list('feedback', (e) => !!e.shared).sort((a, b) => b.shared.date.localeCompare(a.shared.date) || a.id.localeCompare(b.id))
        .map((e) => ({ id: e.id, kindLabel: labelIn(kindOf(c, e.kind), lang) || e.kind, topicLabel: labelIn(topicOf(c, e.topic), lang), text: e.shared.text,
          reply: e.shared.reply || '', date: e.shared.date, name: e.shared.showName && e.signed && e.nameOk ? nameOf(e.userId) : '' }));
    },

    // ----- readers -----
    'feedback.inbox.list': (actor, { kind, topic, status, signed, from, to } = {}) => {
      const c = cfg();
      mustRead(actor, c);
      const st = settings();
      const lang = langOf(actor);
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      const mine = store.list('feedback', (e) => canReadKind(actor, c, st, e.kind));
      const items = mine.filter((e) => (!kind || e.kind === kind) && (!topic || e.topic === topic) && (!status || e.status === status)
        && (signed !== 'signed' || e.signed) && (signed !== 'anonymous' || !e.signed)
        && (!DATE.test(from || '') || e.date >= from) && (!DATE.test(to || '') || e.date <= to))
        // Newest day first; within a day by the random id, so the order never tells who wrote first.
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).map((e) => readerView(c, e, lang));
      const counts = Object.fromEntries(STATUSES.map((s) => [s, mine.filter((e) => e.status === s).length]));
      return {
        items, counts,
        kinds: c.kinds.filter((k) => !k.adminsOnly || ADMIN_ROLES.includes(roleOf(actor))).map((k) => ({ id: k.id, label: labelIn(k, lang), on: k.on })),
        topics: c.topics.map((x) => ({ id: x.id, label: labelIn(x, lang) })),
        statuses: STATUSES.map((s) => ({ id: s, label: statusLabel(s, lang) })),
      };
    },
    'feedback.inbox.get': (actor, { id } = {}) => {
      const c = cfg();
      return readerView(c, entryFor(actor, id, c), langOf(actor), { full: true });
    },
    'feedback.setStatus': (actor, { id, status } = {}) => {
      const c = cfg();
      const e = entryFor(actor, id, c);
      if (!STATUSES.includes(status)) fail(400, 'Pick a status');
      if (e.status === status) return readerView(c, e, langOf(actor), { full: true });
      const next = store.update('feedback', e.id, { status });
      // Marking it seen when a reader opens it isn't news; the rest is.
      if (status !== 'seen' && status !== 'new') {
        tellSigner(c, next, { en: (k) => `Your feedback (${k}) is now: ${statusLabel(status, 'en')}`, es: (k) => `Tu comentario (${k}) ahora está: ${statusLabel(status, 'es')}` });
      }
      return readerView(c, next, langOf(actor), { full: true });
    },
    // A reply to the person who wrote it (anonymous: they read it with their code).
    'feedback.reply': (actor, { id, text: t } = {}) => {
      const c = cfg();
      const e = entryFor(actor, id, c);
      const body = text(t);
      if ((e.thread || []).length >= MAX_THREAD) fail(400, 'This conversation is full');
      const next = store.update('feedback', e.id, {
        thread: [...(e.thread || []), { id: randomId('fbm'), from: 'reader', byId: actor.id, at: now().toISOString(), text: body }],
        ...(e.status === 'new' ? { status: 'seen' } : {}),
      });
      tellSigner(c, next, { en: (k) => `${actor.name} replied to your feedback (${k})`, es: (k) => `${actor.name} respondió a tu comentario (${k})` });
      return readerView(c, next, langOf(actor), { full: true });
    },
    // A note only readers see.
    'feedback.note': (actor, { id, text: t } = {}) => {
      const c = cfg();
      const e = entryFor(actor, id, c);
      const body = text(t, 1000);
      if ((e.notes || []).length >= MAX_THREAD) fail(400, 'This conversation is full');
      const next = store.update('feedback', e.id, { notes: [...(e.notes || []), { id: randomId('fbn'), byId: actor.id, at: now().toISOString(), text: body }] });
      return readerView(c, next, langOf(actor), { full: true });
    },
    // Share an edited version (and what was done) on the board. Never by default; a name only with the signer's OK.
    'feedback.share': (actor, { id, text: t, reply, showName } = {}) => {
      const c = cfg();
      const e = entryFor(actor, id, c);
      const body = text(t, 1000);
      const r = str(reply, 1001);
      if (r.length > 1000) fail(400, 'That message is too long');
      if (showName === true && !(e.signed && e.nameOk)) fail(400, 'They haven’t agreed to show their name');
      const next = store.update('feedback', e.id, { shared: { text: body, reply: r, date: today(), showName: showName === true, byId: actor.id } });
      tellSigner(c, next, { en: (k) => `Your feedback (${k}) is on the “You said, we did” board`, es: (k) => `Tu comentario (${k}) está en el tablero “Lo dijiste, lo hicimos”` });
      return readerView(c, next, langOf(actor), { full: true });
    },
    'feedback.unshare': (actor, { id } = {}) => {
      const c = cfg();
      const e = entryFor(actor, id, c);
      return readerView(c, store.update('feedback', e.id, { shared: null }), langOf(actor), { full: true });
    },
    // Ask a signed entry's writer whether the board may show their name.
    'feedback.askName': (actor, { id } = {}) => {
      const c = cfg();
      const e = entryFor(actor, id, c);
      if (!e.signed) fail(400, 'Anonymous entries are only ever shared without a name');
      tellSigner(c, e, {
        en: (k) => `${actor.name} would like to share your feedback (${k}) on the “You said, we did” board with your name. Open My feedback to say yes or no.`,
        es: (k) => `${actor.name} quiere compartir tu comentario (${k}) en el tablero “Lo dijiste, lo hicimos” con tu nombre. Abre Mis comentarios para decir sí o no.`,
      });
      return { ok: true };
    },

    // ----- Settings → Feedback box (admins) -----
    'feedback.settings.get': (actor) => {
      needAdmin(actor);
      return cfg();
    },
    'feedback.settings.save': (actor, next) => {
      needAdmin(actor);
      purge();
      const out = cleanConfig(next, cfg(), fail);
      if (store.get('feedbackConfig', 'main')) store.update('feedbackConfig', 'main', out); else store.insert('feedbackConfig', { id: 'main', ...out });
      return cfg();
    },
  };

  function byCode(code) {
    if (!normalizeCode(code)) fail(404, 'No entry has that code');
    const h = codeHash(code);
    const e = store.list('feedback', (x) => !x.signed && x.codeHash === h)[0];
    if (!e) fail(404, 'No entry has that code');
    return e;
  }
  /** The writer's follow-up message: the date only, and no id for an anonymous entry. */
  function writeBack(actor, e, t) {
    const body = text(t);
    if ((e.thread || []).length >= MAX_THREAD) fail(400, 'This conversation is full');
    take(actor, 'message', MESSAGES_PER_DAY, 'That’s the most messages for one day. Try again tomorrow.');
    const c = cfg();
    const next = store.update('feedback', e.id, { thread: [...(e.thread || []), { id: randomId('fbm'), from: 'submitter', date: today(), text: body }] });
    tellReaders(c, next, MSG_WORDS);
    return submitterView(c, next, langOf(actor));
  }

  return api;
}
