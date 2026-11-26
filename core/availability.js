// Weekly availability: the model, what a spreadsheet cell means, and the log of every change.
//
// The model (users.availability, unchanged in shape so older data needs no migration):
//   { [day 0 Sunday … 6 Saturday]: { available: false, note? } | { available: true, from?: 'HH:MM', to?: 'HH:MM', note? } }
//   A day that isn't there is "any time". from '' = from opening, to '' = until close. `note` is new (optional, ≤ 200
//   characters): what the person or the sheet said that the hours can't hold ("school until 2", "Requested off").
// Next to it, on the user (all optional, all new):
//   availabilityNotes   notes for the whole week (an import's Notes column, or the person's own)
//   maxDays             the most days a week they want (maxHours already existed: Team's "Max hours")
//   availabilityFrom    'YYYY-MM-DD': the availability applies from this date; shifts before it are checked against
//   availabilityBefore  the availability it replaced (core/service.js conflictList). Cleared by the next change.
//
// The log (collection availabilityLog), one entry per change of anyone's availability, whoever made it and however:
//   { id, userId (whose), actorId (who), at, via: 'app' | 'import' | 'connector' | 'assistant',
//     days: [{ day, before, after }] (only the days that changed), fields: [{ field, before, after }], fileName? }
// The person and whoever may edit theirs read it (availability.history). Entries are kept 2 years.
//
// Reading a cell (parseAvailabilityCell): see the rules on the function. Anything not fully understood keeps its text as
// the day's note and is flagged `review`, so the import's preview asks the manager about it.
import { fold } from './impact.js';
import { uid } from './store.js';

export const KEEP_DAYS = 730; // the log is kept 2 years
export const LOG = 'availabilityLog';
export const NOTE_MAX = 200;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// ---------------------------------------------------------------- the model

/** One day as the apps compare it: { available, from, to, note } with '' for none. */
export function dayView(a) {
  if (!a || typeof a !== 'object') return { available: true, from: '', to: '', note: '' };
  const note = clean(a.note).slice(0, NOTE_MAX);
  if (a.available === false) return { available: false, from: '', to: '', note };
  return { available: true, from: HHMM.test(a.from || '') ? a.from : '', to: HHMM.test(a.to || '') ? a.to : '', note };
}
/** Two days the same (any time = no entry = { available: true, from: '', to: '' }). */
export const sameDay = (a, b) => JSON.stringify(dayView(a)) === JSON.stringify(dayView(b));
/** A day as it's stored: null for "any time" with no note (the day is left out). */
export function storedDay(a) {
  const v = dayView(a);
  if (!v.available) return { available: false, ...(v.note ? { note: v.note } : {}) };
  if (!v.from && !v.to && !v.note) return null;
  return { available: true, ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}), ...(v.note ? { note: v.note } : {}) };
}

/**
 * Availability as a client sent it, checked: only days 0–6, only the fields above. Keeps the shape it came in
 * ({ available: true, from: '', to: '' } stays as it is: the apps send "any time" like that), so saving what was read
 * changes nothing. null/undefined stays as it is (it clears the week, as it always has).
 */
export function cleanAvailability(raw) {
  if (raw == null) return raw;
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (let d = 0; d < 7; d++) {
    const a = raw[d] ?? raw[String(d)];
    if (!a || typeof a !== 'object') continue;
    const note = clean(a.note).slice(0, NOTE_MAX);
    if (a.available === false) { out[d] = { available: false, ...(note ? { note } : {}) }; continue; }
    const day = { available: true };
    if ('from' in a) day.from = HHMM.test(a.from || '') ? a.from : '';
    if ('to' in a) day.to = HHMM.test(a.to || '') ? a.to : '';
    if (note) day.note = note;
    out[d] = day;
  }
  return out;
}

/** The days that differ between two weeks: [{ day, before, after }] (day views). */
export function weekChanges(before, after) {
  const out = [];
  for (let d = 0; d < 7; d++) {
    const b = before?.[d], a = after?.[d];
    if (!sameDay(b, a)) out.push({ day: d, before: dayView(b), after: dayView(a) });
  }
  return out;
}

/** The availability that applies on a date: the one before availabilityFrom for earlier dates (an import's effective date). */
export const availabilityOn = (user, date) => (user?.availabilityFrom && date && date < user.availabilityFrom && user.availabilityBefore ? user.availabilityBefore : user?.availability) || {};

// ---------------------------------------------------------------- reading a cell

const OFF = new Set(['off', 'x', 'xx', 'n a', 'na', 'unavailable', 'unavail', 'not available', 'not avail', 'no', 'none', 'nope', 'cant', 'can t', 'cannot',
  'busy', 'closed', 'no disponible', 'nada', 'descanso', 'libre', 'day off', 'dia libre', 'off all day', 'no puedo', 'not', 'n', '0']);
const REQUESTED_OFF = /^(requested off|request off|req off|req|r o|ro|pto|vacation|vacaciones|pidio (el dia )?libre|pidio descanso|permiso|requested)$/;
const ANY = new Set(['available', 'avail', 'open', 'any', 'anytime', 'any time', 'all day', 'yes', 'y', 'ok', 'si', 'disponible', 'todo el dia', 'cualquier hora',
  'free', 'flexible', 'flex', 'open availability', 'whenever', '24 7', 'all', 'full', 'full day', 'ya', 'cualquiera', 'available all day', 'avail all day']);
const DOUBLES = new Set(['doubles', 'double', 'dbl', 'dbls', 'both', 'am pm', 'am and pm', 'am y pm', 'open close', 'open to close', 'open cl', 'op cl', 'dobles', 'doble',
  'turno doble', 'all shifts', 'am pm both', 'a p']);
const AM = new Set(['am', 'a', 'am only', 'mornings', 'morning', 'lunch', 'lunches', 'days', 'day', 'day shift', 'days only', 'manana', 'mananas', 'am shift', 'am shifts',
  'brunch', 'turno de manana', 'lunch only', 'mornings only', 'solo manana', 'opening', 'opener', 'open only']);
const PM = new Set(['pm', 'p', 'pm only', 'nights', 'night', 'evenings', 'evening', 'dinner', 'dinners', 'pm shift', 'pm shifts', 'noche', 'noches', 'tarde', 'tardes',
  'night shift', 'nights only', 'dinner only', 'solo noche', 'closing', 'close', 'closer', 'closing only']);
const REASON = /\b(school|class|classes|college|university|uni|work|job|2nd job|second job|other job|practice|kids|daycare|church|appointment|escuela|clases|clase|universidad|trabajo|otro trabajo|colegio|ninos|guarderia|iglesia|cita)\b/;

// A time in a cell: 4 · 4p · 4pm · 4:30 · 430 · 4.30pm · 11a · noon · midnight.
// "a"/"p" right before another number is Spanish "to" ("de 4 a 10"), not a.m.
const TIME_RE = /(\d{1,2})(?:[:.h](\d{2})|(\d{2})(?=\s*(?:a|p|am|pm)?\b))?(?:\s*(am|pm|a|p)\b(?!\s*\d))?|\b(noon|midday|mediodia|midnight|medianoche)\b/g;

/**
 * The PM boundary: when dinner starts (the restaurant's dayparts: one named dinner/pm/night/cena, else the last one),
 * '16:00' by default. "AM" is available until then; "PM" from then.
 */
export function pmStart(settings = {}) {
  const parts = Array.isArray(settings.dayparts) ? settings.dayparts.filter((p) => HHMM.test(p?.start || '')) : [];
  const dinner = parts.find((p) => /dinner|pm|night|evening|cena|noche/i.test(p.name || '')) || (parts.length > 1 ? parts[parts.length - 1] : null);
  return dinner?.start || '16:00';
}

/**
 * Hours written without am/pm, as restaurants mean them. role 'from' (after 4, the start of 4-10), 'to' (until 3, the
 * end of a range), 'start' (the start of a range). Returns { min, sure }: sure false when the guess could reasonably be
 * the other half of the day (7–10, and "until 11"/"until 12").
 */
function hourOf(h, m, mer, role, after = -1) {
  if (h > 23 || m > 59) return null;
  if (mer) {
    let hh = h % 12;
    if (mer[0] === 'p') hh += 12;
    return { min: hh * 60 + m, sure: true };
  }
  if (h >= 13) return { min: h * 60 + m, sure: true }; // 24-hour clock
  if (h === 0) return { min: m, sure: true };
  if (role === 'end') {
    // The end of a range: the first of h or h+12 after the start.
    const a = (h % 12) * 60 + m, b = a + 12 * 60;
    const min = a > after ? a : b <= 24 * 60 ? b : a;
    return { min: min >= 24 * 60 ? 24 * 60 : min, sure: true };
  }
  if (role === 'start') {
    if (h >= 7 && h <= 11) return { min: h * 60 + m, sure: true }; // 9-3, 11-3: a day shift
    if (h === 12) return { min: 12 * 60 + m, sure: true };
    return { min: (h + 12) * 60 + m, sure: true }; // 4-10: evening
  }
  if (h === 12) return { min: 12 * 60 + m, sure: role !== 'to' };
  if (h <= 6) return { min: (h + 12) * 60 + m, sure: true };
  if (h <= 10) return { min: (h + 12) * 60 + m, sure: false };
  return role === 'from' ? { min: 11 * 60 + m, sure: true } : { min: 23 * 60 + m, sure: false }; // after 11 (am), until 11 (pm)
}

/** The times in a folded cell, with what's left between them: { text: 'after § ', times: [{ h, m, mer, word }] }. */
function pullTimes(s) {
  const times = [];
  const text = s.replace(TIME_RE, (all, h, m1, m2, mer, word) => {
    if (word) times.push({ h: /noon|midday|mediodia/.test(word) ? 12 : 0, m: 0, mer: /noon|midday|mediodia/.test(word) ? 'pm' : 'am', word: true });
    else times.push({ h: +h, m: +(m1 || m2 || 0), mer: mer || '' });
    return ' § ';
  });
  return { text: text.replace(/\s+/g, ' ').trim(), times };
}

const CLOSE = '(?:cl|close|closing|cierre|cerrar|end|late|lt)';
const TO = '(?:-|to|til|till|until|thru|through|hasta|a)';

/**
 * What a cell of an availability sheet means for that day.
 *   blank                                   available all day (kind 'blank')
 *   OFF · X · N/A · no · unavailable · Libre  unavailable
 *   Requested off · PTO · R/O                unavailable, the words kept as the day's note
 *   available · open · any · ✓ · yes        all day
 *   Doubles · AM/PM · open-close            all day
 *   AM · mornings · lunch                   until the PM boundary (dinner's start in Settings, 4 PM by default)
 *   PM · nights · dinner · close            from the PM boundary
 *   after 4 · from 4 · 4+ · 4pm-close · 4p-cl · desde las 4      from 4 PM
 *   until 3 · before 5 · by 3 · hasta las 3                    until 3 PM / 5 PM
 *   11-3 · 9a-3p · 4 to 10 · de 4 a 10                         those hours
 *   school until 2 · class 8-1 (a reason and its hours)        available after them; kept as a note and flagged
 * Hours without am/pm: 1–6 are PM, 11 is AM at the start and PM at the end; 7–10 (and "until 11/12") are PM but
 * flagged for review. Anything else: available all day, the text kept as the note, flagged.
 * @returns { available, from, to, note, review, kind }
 */
export function parseAvailabilityCell(value, settings = {}) {
  const raw = clean(value);
  const out = (available, from = '', to = '', extra = {}) => ({ available, from, to, note: '', review: false, ...extra });
  if (!raw) return out(true, '', '', { kind: 'blank' });
  const keep = raw.slice(0, NOTE_MAX);
  const pm = pmStart(settings);
  const s = fold(raw).replace(/\b([ap])\.\s?m\b\.?/g, '$1m').replace(/[–—−]/g, '-').replace(/[✓✔√☑✅]/g, ' yes ').replace(/[✗✘×❌]/g, ' x ');
  // Words only: "4p-cl", "4pm–close", "after 4:30pm", "R/O", "N/A".
  const words = s.replace(/[^a-z0-9:+\-.& ]/g, ' ').replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  const flat = words.replace(/[-+.:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat && /yes/.test(s)) return out(true, '', '', { kind: 'any' });
  if (REQUESTED_OFF.test(flat)) return out(false, '', '', { kind: 'off', note: keep });
  if (OFF.has(flat)) return out(false, '', '', { kind: 'off' });
  if (ANY.has(flat) || DOUBLES.has(flat)) return out(true, '', '', { kind: 'any' });
  if (AM.has(flat)) return out(true, '', pm, { kind: 'am' });
  if (PM.has(flat)) return out(true, pm, '', { kind: 'pm' });

  const { text, times } = pullTimes(words.replace(/\b(de|desde|a partir de|despues de|antes de|hasta)\s+las?\b/g, '$1'));
  const t0 = times[0], t1 = times[1];
  const mk = (t, role, after) => (t ? hourOf(t.h, t.m, t.mer, role, after) : null);
  const result = (from, to, sure, kind, extra = {}) => {
    const f = from == null ? '' : hhmm(from), e = to == null || to >= 24 * 60 ? '' : hhmm(to);
    return out(true, f, e, { kind, ...(sure ? {} : { review: true, note: keep }), ...extra });
  };
  const test = (re) => new RegExp(`^${re}$`).test(text);

  if (times.length === 1) {
    // after 4 · from 4 · 4+ · 4 on · 4-close · 4p-cl · starting 4 · desde 4
    if (test(`(?:after|aft|from|starting|starting at|start|start at|starts|available after|avail after|any ?time after|not before|no earlier than|desde|despues de|a partir de|de)? ?§ ?(?:\\+|on|onward|onwards|and later|or later|and after|${TO} ?${CLOSE})?`)) {
      const f = mk(t0, 'from');
      if (!f) return unknown();
      const bare = text === '§'; // a time alone: most likely "from"
      return result(f.min, null, f.sure && !bare, bare ? 'from?' : 'from');
    }
    // until 3 · before 5 · by 3 · til 3 · open-3 · hasta 3
    if (test(`(?:until|till|til|to|before|by|up to|available until|avail until|available before|done by|out by|off by|not after|no later than|hasta|antes de|open ?${TO}|opening ?${TO}) ?§`)) {
      const e = mk(t0, 'to');
      if (!e) return unknown();
      return result(null, e.min, e.sure, 'to');
    }
    // am until 3 / pm after 5 written with a reason: school until 2 → busy until 2
    if (REASON.test(text) && /\b(until|till|til|hasta|to|-)\s*§/.test(text)) {
      const e = mk(t0, 'to');
      if (!e) return unknown();
      return result(e.min, null, false, 'reason');
    }
    if (REASON.test(text) && /\b(after|from|desde|despues de)\s*§/.test(text)) {
      const f = mk(t0, 'from');
      if (!f) return unknown();
      return result(null, f.min, false, 'reason');
    }
  }
  if (times.length === 2) {
    // 11-3 · 9a-3p · 4 to 10 · de 4 a 10 · from 11 until 3 · available 11-3
    if (test(`(?:from|de|desde|available|avail|only)? ?§ ?${TO} ?§(?: only)?`)) {
      const a = mk(t0, 'start');
      const b = a && mk(t1, 'end', a.min);
      if (!a || !b || b.min <= a.min) return unknown();
      const ambiguous = !t0.mer && !t1.mer && t0.h >= 7 && t0.h <= 10 && b.min <= 12 * 60;
      return result(a.min, b.min, !ambiguous, 'range');
    }
    // school 8-2 · class 9 to 1: busy then. A morning reason → after it; an evening one → until it.
    if (REASON.test(text) && /§ ?(?:-|to|til|till|until|hasta|a) ?§/.test(text)) {
      const a = mk(t0, 'start');
      const b = a && mk(t1, 'end', a.min);
      if (!a || !b) return unknown();
      return a.min < hhmmMin(pm) ? result(b.min, null, false, 'reason') : result(null, a.min, false, 'reason');
    }
  }
  return unknown();

  function unknown() {
    // Some words we know in a longer text: a guess, always flagged.
    if (!times.length && (OFF.has(flat.split(' ')[0]) || /\b(off|unavailable|no disponible|cant|cannot|libre)\b/.test(flat))) return out(false, '', '', { kind: 'guess', review: true, note: keep });
    return out(true, '', '', { kind: 'unknown', review: true, note: keep });
  }
}
const hhmmMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

/** A parsed cell as a stored day (or null for any time). */
export const cellDay = (p) => storedDay({ available: p.available, from: p.from, to: p.to, note: p.note });

/** A max hours / max days cell: a number (≤ 80 hours, ≤ 7 days), null for blank, NaN when it isn't one. */
export function parseLimit(v, max) {
  const s = clean(v).toLowerCase().replace(/(hours|hrs|hr|h|days|day|d|horas|dias|shifts|turnos)\.?$/, '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
  if (!m) return NaN;
  const n = Number(m[2] || m[1]);
  return n >= 0 && n <= max ? n : NaN;
}

// ---------------------------------------------------------------- the log

const cutoff = (now) => new Date(now().getTime() - KEEP_DAYS * 864e5).toISOString();

/**
 * Write one log entry (when something changed) and drop that person's entries older than 2 years.
 * entry: { userId, actorId, via, days, fields, fileName? }
 */
export function logChange(store, now, entry) {
  if (!entry.days?.length && !entry.fields?.length) return null;
  const at = now().toISOString();
  const doc = store.insert(LOG, {
    id: uid('avl'), userId: entry.userId, actorId: entry.actorId || null, at,
    via: ['app', 'import', 'connector', 'assistant'].includes(entry.via) ? entry.via : 'app',
    days: entry.days || [], fields: entry.fields || [], ...(entry.fileName ? { fileName: clean(entry.fileName).slice(0, 120) } : {}),
  });
  const old = cutoff(now);
  for (const e of store.list(LOG, (x) => x.userId === entry.userId && x.at < old)) store.remove(LOG, e.id);
  return doc;
}

/** A person's history, newest first, within the 2 years. */
export function historyOf(store, now, userId, { limit = 100 } = {}) {
  const old = cutoff(now);
  return store.list(LOG, (x) => x.userId === userId && x.at >= old).sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.max(1, Math.min(500, limit)));
}

/** 'claude' (the Claude connector) and 'assistant' (Ask ShiftBoard) as the log writes them. */
export const viaOf = (serviceVia) => (serviceVia === 'claude' ? 'connector' : serviceVia === 'assistant' ? 'assistant' : 'app');
