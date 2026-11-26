// Reading guest data from spreadsheet exports: OpenTable's reservations and reviews (Guest Center →
// Reporting), and review exports from Google, Yelp or TripAdvisor. Pure functions, no I/O: the browser
// reads the file and sends only what's needed; the server (or the demo) checks it again and saves it.
//
// Privacy first. Guest names, phone numbers and email addresses are never needed to track positive
// impact or to forecast covers, so:
//   * phone and email columns are recognized only so they can be left out (and the preview says so);
//   * a guest or reviewer name is kept as a first name and last initial ("Dana K."), nothing more;
//   * phone numbers and email addresses typed inside notes or review text are blanked out;
//   * a row without an id gets a stable key from a one-way hash, so re-importing the same file never
//     double-counts, without keeping the full name the hash was made from.
//
// The column names below are what OpenTable's exports have been seen to use, plus common variants.
// OpenTable doesn't publish its export formats, so they're approximations: every column can be picked by
// hand in the import's column step, and the choice is remembered for the next file.
import { parseCsv, headerKey } from './adp-csv.js';
import { parseTime } from './tripleseat.js';

export { parseCsv, headerKey };

// ---------------------------------------------------------------- privacy

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// North American numbers ((303) 555-0100, 303.555.0100, +1 303 555 0100, 3035550100) and long international ones.
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{1,3}[\s.-]?\d[\d\s().-]{7,}\d/g;

/** Text with any email address or phone number blanked out ("[email]", "[phone]"), whitespace tidied, capped. */
export function scrub(text, max = 4000) {
  return String(text ?? '').replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max);
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/**
 * A guest's name as a first name and last initial: "Dana Kim" → "Dana K.", "KIM, DANA" → "Dana K.",
 * "dana" → "Dana". A one-word display name ("DinerDana", "OpenTable Diner") is kept as it is. Never an
 * email address or a number.
 */
export function shortName(full) {
  let s = String(full ?? '').replace(EMAIL_RE, '').replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^(opentable|google|yelp|tripadvisor|verified|a)\b/i.test(s)) return s.slice(0, 30);
  let parts;
  if (s.includes(',')) { const [last, first] = s.split(',').map((x) => x.trim()); parts = [...(first || '').split(' '), ...(last || '').split(' ')].filter(Boolean); }
  else parts = s.split(' ').filter(Boolean);
  const fix = (w) => (w === w.toUpperCase() || w === w.toLowerCase() ? cap(w.toLowerCase()) : w);
  if (parts.length < 2) return fix(parts[0] || '').slice(0, 30);
  const last = parts.at(-1).replace(/[^\p{L}]/gu, '');
  return `${fix(parts[0]).slice(0, 24)}${last ? ` ${last[0].toUpperCase()}.` : ''}`;
}

/** A short, stable, one-way key (cyrb53, base 36). The same input always gives the same key. */
export function hashKey(input) {
  const str = String(input ?? '');
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** An id from a file, safe as part of a document id ('' when there's none). */
export const cleanId = (v) => String(v ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(-40); // the end: ids that share a long prefix stay apart

// ---------------------------------------------------------------- dates, times, numbers

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dec: 12, dic: 12 };
const monthOf = (w) => MONTHS[fold(w).slice(0, 3)] || null;
function validDay(y, m, d) {
  const date = `${y}-${pad(m)}-${pad(d)}`;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date ? date : null;
}
const year4 = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));

/**
 * A date and maybe a time from an export cell: '09/19/2026', '9/19/26 7:30 PM', '2026-09-19', '2026-09-19T19:30:00',
 * 'Sat, Sep 19, 2026', 'September 19, 2026 at 7:30 PM', '19 sep 2026'. US order (month first) unless the first
 * number can't be a month. Returns { date: 'YYYY-MM-DD', time: 'HH:MM' | '' } or null.
 */
export function parseWhen(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?/);
  if (m) { const date = validDay(m[1], m[2], m[3]); return date ? { date, time: m[4] ? parseTime(m[4]) : '' } : null; }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:,?\s+(?:at\s+)?(.+))?$/i);
  if (m) {
    let [mo, d] = [Number(m[1]), Number(m[2])];
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    const date = validDay(year4(m[3]), mo, d);
    return date ? { date, time: m[4] ? parseTime(m[4].replace(/\s*(a|p)\.?m\.?$/i, ' $1M')) : '' } : null;
  }
  m = s.match(/^(?:[A-Za-zÀ-ÿ]{2,9}\.?,?\s+)?([A-Za-zÀ-ÿ]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(.+))?$/);
  if (m && monthOf(m[1])) { const date = validDay(m[3], monthOf(m[1]), m[2]); return date ? { date, time: m[4] ? parseTime(m[4]) : '' } : null; }
  m = s.match(/^(?:[A-Za-zÀ-ÿ]{2,9}\.?,?\s+)?(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ÿ]{3,10})\.?,?\s+(?:de\s+)?(\d{4})(?:,?\s+(.+))?$/);
  if (m && monthOf(m[2])) { const date = validDay(m[3], monthOf(m[2]), m[1]); return date ? { date, time: m[4] ? parseTime(m[4]) : '' } : null; }
  return null;
}
/** 'HH:MM' from '7:30 PM', '7:30pm', '19:30', '7 PM' ('' when it can't be read). */
export const parseClock = (v) => parseTime(String(v ?? '').trim().replace(/\s*(a|p)\.?\s*m\.?$/i, ' $1M'));

/** A party size: '4', '4 guests', 'Party of 4' → 4 (1–500), else null. */
export function parseCount(v) {
  const m = String(v ?? '').match(/\d+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
}

const WORD_STARS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
/** A star rating out of 5: '5', '4.5', '5/5', '5 stars', 'FIVE', '★★★★★', TripAdvisor's 50 (= 5.0), a 10-point 9 (= 4.5). */
export function parseRating(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^★+☆*$/.test(s)) return s.replace(/☆/g, '').length;
  const word = WORD_STARS[fold(s).split(' ')[0]];
  if (word) return word;
  const m = s.match(/(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?/);
  if (!m) return null;
  let n = Number(m[1].replace(',', '.'));
  const outOf = m[2] ? Number(m[2]) : null;
  if (outOf && outOf !== 5) n = (n / outOf) * 5;
  else if (!outOf && n > 5 && n <= 10) n /= 2;
  else if (!outOf && n > 10 && n <= 50) n /= 10;
  if (!Number.isFinite(n) || n < 0 || n > 5) return null;
  return Math.round(n * 10) / 10;
}

/** A reservation status in one word: booked, seated, done, cancelled or noShow. */
export function reservationStatus(v) {
  const s = fold(v);
  if (!s) return 'booked';
  if (/no ?show|noshow|no se presento/.test(s)) return 'noShow';
  if (/cancel|declin|reject|cancelad/.test(s)) return 'cancelled';
  if (/done|complet|finish|paid|closed|left|check|terminad|pagad/.test(s)) return 'done';
  if (/seat|arriv|sentad|lleg/.test(s)) return 'seated';
  return 'booked'; // booked, confirmed, pending, reserved, waitlist…
}

// ---------------------------------------------------------------- columns

// Field → column names seen in exports (lowercase words, as headerKey() writes them). Earlier names win.
export const COLUMNS = {
  reservations: {
    id: ['confirmation number', 'confirmation', 'conf number', 'conf', 'confirmation id', 'reservation id', 'reservation number', 'res id', 'res number', 'booking id', 'booking reference', 'reference', 'id'],
    createdAt: ['date made', 'date booked', 'booked on', 'booked date', 'made on', 'created', 'created date', 'created at', 'creation date', 'booking date', 'date created'],
    date: ['visit date', 'date', 'reservation date', 'res date', 'dining date', 'scheduled date', 'dine date', 'arrival date', 'day'],
    time: ['visit time', 'time', 'reservation time', 'res time', 'scheduled time', 'arrival time', 'seating time'],
    partySize: ['party size', 'covers', 'party', 'size', 'guests', 'number of guests', 'guest count', 'pax', 'people', 'num guests', 'cover count'],
    status: ['status', 'reservation status', 'state', 'visit status', 'res status'],
    guest: ['guest name', 'guest', 'name', 'diner name', 'diner', 'customer', 'customer name', 'full name'],
    firstName: ['first name', 'guest first name', 'diner first name'],
    lastName: ['last name', 'guest last name', 'diner last name', 'surname'],
    requestedServer: ['requested server', 'server request', 'server requested', 'preferred server', 'request server', 'requested staff', 'requested bartender'],
    notes: ['special requests', 'special request', 'guest request', 'guest requests', 'requests', 'request', 'reservation notes', 'res notes', 'visit notes', 'notes', 'guest notes', 'diner request', 'diner notes', 'comments', 'special instructions'],
    venueNotes: ['venue notes', 'visit notes', 'restaurant notes', 'internal notes', 'staff notes', 'host notes', 'opentable notes', 'reservation notes internal'],
    server: ['server', 'server name', 'assigned server', 'waiter'],
    table: ['table', 'table number', 'tables', 'table s'],
    area: ['area', 'section', 'table category', 'seating area', 'dining area', 'room'],
    phone: ['phone', 'phone number', 'guest phone', 'mobile', 'mobile phone', 'cell', 'telephone', 'tel'],
    email: ['email', 'email address', 'guest email', 'e mail'],
  },
  reviews: {
    id: ['review id', 'feedback id', 'id', 'review number', 'reviewid'],
    date: ['review date', 'date submitted', 'submitted', 'submitted date', 'submitted on', 'date posted', 'posted', 'published', 'published date', 'create time', 'created', 'created at', 'date', 'time'],
    diningDate: ['dined on', 'dining date', 'visit date', 'date of visit', 'dined', 'dine date', 'reservation date', 'date dined'],
    rating: ['overall', 'overall rating', 'rating', 'star rating', 'stars', 'score', 'review rating', 'rating overall', 'bubble rating'],
    food: ['food', 'food rating'],
    service: ['service', 'service rating'],
    ambience: ['ambience', 'ambiance', 'ambience rating', 'atmosphere'],
    value: ['value', 'value rating'],
    title: ['title', 'review title', 'headline'],
    text: ['review', 'review text', 'comments', 'comment', 'text', 'feedback', 'review comments', 'public review', 'content', 'review content', 'body', 'review body'],
    reviewer: ['diner name', 'reviewer', 'reviewer name', 'display name', 'author', 'author name', 'user', 'user name', 'username', 'guest name', 'diner', 'nickname', 'reviewer display name', 'name'],
    server: ['server', 'server name', 'assigned server', 'waiter'],
    source: ['source', 'site', 'platform', 'channel'],
    phone: ['phone', 'phone number', 'guest phone', 'mobile'],
    email: ['email', 'email address', 'guest email', 'diner email', 'e mail'],
  },
};
export const FIELDS = { reservations: Object.keys(COLUMNS.reservations), reviews: Object.keys(COLUMNS.reviews) };
// What a file must have.
const NEEDS = { reservations: [['date'], ['partySize']], reviews: [['date', 'diningDate'], ['rating']] };

/** Guess which column holds what: exact names first, then a name that starts with a known one ('Visit Date (local)'). */
export function detectColumns(header, kind) {
  const names = COLUMNS[kind];
  const keys = header.map(headerKey);
  const used = new Set();
  const out = Object.fromEntries(Object.keys(names).map((f) => [f, null]));
  for (const pass of ['exact', 'prefix']) {
    for (const [f, list] of Object.entries(names)) {
      if (out[f] != null) continue;
      for (const n of list) {
        const i = keys.findIndex((k, j) => k && !used.has(j) && (pass === 'exact' ? k === n : n.length > 3 && k.startsWith(`${n} `)));
        if (i >= 0) { used.add(i); out[f] = i; break; }
      }
    }
  }
  return out;
}

/** What's missing for the file to be read: ['date', 'partySize'] … (empty when it's fine). */
export function mappingProblems(mapping, kind) {
  return NEEDS[kind].filter((alts) => alts.every((f) => mapping[f] == null)).map((alts) => alts[0]);
}

/** The header row: the first of the top 25 rows that names at least two known columns (exports often start with title lines). */
export function findHeader(rows, kind) {
  let best = { i: 0, score: -1 };
  for (const [i, r] of rows.slice(0, 25).entries()) {
    const m = detectColumns(r, kind);
    const score = Object.values(m).filter((v) => v != null).length;
    if (score >= 2 && score > best.score) best = { i, score };
    if (score >= 5) break;
  }
  return best.score >= 2 ? best.i : 0;
}

/** A mapping by column index → by header name (what's remembered for the next file). */
export function mappingToNames(mapping, header) {
  return Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, i == null ? null : header[i] || null]));
}
/** A remembered mapping (by name) → indexes for this file's header, or null when a remembered column isn't there. */
export function mappingFromNames(names, header, kind) {
  if (!names) return null;
  const keys = header.map(headerKey);
  const out = {};
  for (const f of FIELDS[kind]) {
    if (!names[f]) { out[f] = null; continue; }
    const i = keys.indexOf(headerKey(names[f]));
    if (i < 0) return null;
    out[f] = i;
  }
  return mappingProblems(out, kind).length ? null : out;
}

/** Read a file: { rows, header, headerRow, mapping, remembered } with the remembered columns when they fit. */
export function readFile(text, kind, { remembered } = {}) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  const headerRow = findHeader(rows, kind);
  const header = rows[headerRow] || [];
  const fromNames = mappingFromNames(remembered, header, kind);
  return { rows, header, headerRow, mapping: fromNames || detectColumns(header, kind), remembered: !!fromNames };
}

// ---------------------------------------------------------------- rows → items

const cell = (r, i) => (i == null ? '' : String(r[i] ?? '').trim());

/**
 * Reservations from the rows. Each item: { key, externalId, date, time, partySize, status, guest, notes,
 * requestedServer, server, table, area, createdAt } — never a phone number or an email address.
 * Returns { items, skipped: [{ row, reason, text }], dropped: ['phone', 'email'] (columns left out) }.
 */
export function readReservations(rows, mapping, headerRow = 0) {
  const items = [];
  const skipped = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some(Boolean)) continue;
    const when = parseWhen(cell(row, mapping.date));
    if (!when) { skipped.push({ row: r + 1, reason: 'date', text: cell(row, mapping.date).slice(0, 40) }); continue; }
    const partySize = parseCount(cell(row, mapping.partySize));
    if (!partySize) { skipped.push({ row: r + 1, reason: 'partySize', text: cell(row, mapping.partySize).slice(0, 40) }); continue; }
    const time = parseClock(cell(row, mapping.time)) || when.time || '';
    const full = cell(row, mapping.guest) || [cell(row, mapping.firstName), cell(row, mapping.lastName)].filter(Boolean).join(' ');
    const externalId = cleanId(cell(row, mapping.id));
    const notes = [cell(row, mapping.notes), cell(row, mapping.venueNotes)].filter(Boolean).join('\n');
    const made = parseWhen(cell(row, mapping.createdAt));
    items.push({
      row: r + 1,
      // The same booking always gets the same key: its confirmation number, else a hash of who and when.
      key: externalId ? `c_${externalId}` : `h_${hashKey(`${when.date}|${time}|${fold(full) || `${partySize}|${fold(notes)}`}`)}`,
      externalId, date: when.date, time, partySize, status: reservationStatus(cell(row, mapping.status)),
      guest: shortName(full), notes: scrub(notes, 600), requestedServer: scrub(cell(row, mapping.requestedServer), 60),
      server: scrub(cell(row, mapping.server), 60), table: cell(row, mapping.table).slice(0, 20), area: cell(row, mapping.area).slice(0, 40),
      createdAt: made?.date || '',
    });
  }
  return { items, skipped, dropped: ['phone', 'email'].filter((f) => mapping[f] != null) };
}

/**
 * Reviews from the rows. Each item: { key, externalId, date, diningDate, rating, food, service, ambience, value,
 * text, reviewer, server, source }. A review needs a date (posted or dined) and a star rating.
 */
export function readReviews(rows, mapping, headerRow = 0, { source = '' } = {}) {
  const items = [];
  const skipped = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some(Boolean)) continue;
    const posted = parseWhen(cell(row, mapping.date));
    const dined = parseWhen(cell(row, mapping.diningDate));
    if (!posted && !dined) { skipped.push({ row: r + 1, reason: 'date', text: cell(row, mapping.date ?? mapping.diningDate).slice(0, 40) }); continue; }
    const rating = parseRating(cell(row, mapping.rating));
    if (rating == null) { skipped.push({ row: r + 1, reason: 'rating', text: cell(row, mapping.rating).slice(0, 40) }); continue; }
    const title = cell(row, mapping.title);
    const body = cell(row, mapping.text);
    const text = scrub(title && body && !body.startsWith(title) ? `${title}\n${body}` : title || body, 4000);
    const fullName = cell(row, mapping.reviewer);
    const externalId = cleanId(cell(row, mapping.id));
    const date = posted?.date || dined.date;
    items.push({
      row: r + 1,
      key: externalId ? `i_${externalId}` : `h_${hashKey(`${date}|${fold(fullName)}|${fold(text).slice(0, 300)}|${rating}`)}`,
      externalId, date, diningDate: dined?.date || '', rating,
      food: parseRating(cell(row, mapping.food)), service: parseRating(cell(row, mapping.service)), ambience: parseRating(cell(row, mapping.ambience)), value: parseRating(cell(row, mapping.value)),
      text, reviewer: shortName(fullName), server: scrub(cell(row, mapping.server), 60),
      source: fold(cell(row, mapping.source)).split(' ')[0] || source || '',
    });
  }
  return { items, skipped, dropped: ['phone', 'email'].filter((f) => mapping[f] != null) };
}

/** A fingerprint that survives a missing id (the same review imported from a file and later from the API). */
export const reviewPrint = (r) => hashKey(`${r.date}|${fold(r.text).slice(0, 300)}|${r.rating}`);

/** Split items into chunks small enough for one request (the API takes about 2 MB). */
export function chunkItems(items, maxBytes = 900_000) {
  const out = [];
  let cur = [];
  let size = 2;
  for (const it of items) {
    const n = JSON.stringify(it).length + 1;
    if (cur.length && size + n > maxBytes) { out.push(cur); cur = []; size = 2; }
    cur.push(it); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
