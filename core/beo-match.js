// Duplicates, when BEOs come in (events.importBeos, core/service.js). Pure, so the server, the demo and the tests share it.
//
//   matchEvent(b, events)  is this BEO an event ShiftBoard already has?
//     1. Stable identifiers: the Tripleseat event id (or booking id), the BEO's INVOICE #, or a BEO this event was
//        imported from before (importKeys). A match here is confident: the import updates that event.
//     2. Otherwise a fuzzy match on the same date: the name, the time, the room and the guest count. Anything it
//        finds is a "possible duplicate", with its reasons and a confidence, for a manager to decide: update that
//        event, skip the BEO, or add it as a new event (never the default).
//   dedupeBeos(list)       the same BEO twice in one file (printed twice, or two versions in one export): one
//                          candidate, the newest (the later "Updated" stamp, else the later pages).
//   importKey(b)           what an event remembers about the BEO it came from, so importing it again is a no-op.
import { fingerprint } from './beo-sections.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => clean(s).toLowerCase();
const STOP = new Set(['the', 'and', 'a', 'an', 'of', 'for', 'at', 'with', 'to', 'in', 'on', 'by', 's', 'event', 'beo']);
/** "Ferreira/ Lund - Wedding Reception" → ['ferreira', 'lund', 'wedding', 'reception']. */
export function nameTokens(s) {
  return norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1) || (/^\d+$/.test(a) && a === b);
/**
 * How alike two event names are, 0–1: shared words (Dice), with a typo of one letter forgiven in longer words, and a
 * name that's all inside the other one ("Lund Wedding" in "Ferreira / Lund Wedding Reception") counted as close.
 */
export function nameSimilarity(a, b) {
  const A = [...new Set(nameTokens(a))], B = [...new Set(nameTokens(b))];
  if (!A.length || !B.length) return 0;
  const shared = A.filter((w) => B.some((x) => sameWord(w, x))).length;
  const dice = (2 * shared) / (A.length + B.length);
  const small = Math.min(A.length, B.length);
  const inside = shared === small && small >= 2 ? 0.85 : 0;
  return Math.max(dice, inside);
}

const minutes = (t) => (/^\d{2}:\d{2}$/.test(t || '') ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
/** 'same' (start within 30 min), 'overlap' (the times overlap), 'different' (they don't), 'unknown'. */
export function timeRelation(a, b) {
  const as = minutes(a.start), bs = minutes(b.start);
  if (as == null || bs == null) return 'unknown';
  if (Math.abs(as - bs) <= 30) return 'same';
  const end = (s, e) => { const m = minutes(e); return m == null ? s + 180 : m <= s ? m + 1440 : m; }; // no end: about three hours
  const ae = end(as, a.end), be = end(bs, b.end);
  return as < be && bs < ae ? 'overlap' : 'different';
}
/** 'same', 'different' or 'unknown': the linked room, else the room's name, else the BEO's areas naming the event's room. */
export function roomRelation(b, e) {
  if (b.roomId && e.roomId) return b.roomId === e.roomId ? 'same' : 'different';
  const br = norm(b.room), er = norm(e.room);
  if (br && er) return br === er ? 'same' : norm(b.areas).includes(er) ? 'same' : 'different';
  if (er && norm(b.areas).includes(er)) return 'same';
  return 'unknown';
}
const guestRelation = (a, b) => (!a || !b ? 'unknown' : Math.min(a, b) / Math.max(a, b) >= 0.8 ? 'same' : 'different');

/** What an event remembers about a BEO it was imported from: the invoice number, else its name and date. */
export function importKey(b) {
  if (b?.invoiceNumber) return `inv:${b.invoiceNumber}`;
  return b?.name && b?.date ? `beo:${fingerprint(`${nameTokens(b.name).join(' ')}|${b.date}`)}` : '';
}

// The weights and thresholds, tuned on invented cases (test/beo-duplicates.test.js): the name matters most,
// then the time, then the room; a different time is a different event unless the name is the same.
const WEIGHTS = { name: 0.55, time: 0.25, room: 0.15, guests: 0.05 };
const TIME_SCORE = { same: 1, overlap: 0.6, unknown: 0.4, different: 0 };
const ROOM_SCORE = { same: 1, unknown: 0.4, different: 0 };
const GUEST_SCORE = { same: 1, unknown: 0.5, different: 0.2 };
export const MIN_SCORE = 0.5;
const confidenceOf = (score) => (score >= 0.8 ? 'high' : score >= 0.65 ? 'medium' : 'low');

/** One event against a BEO: { score, confidence, reasons } or null when it isn't a possible duplicate. */
export function compareEvents(b, e) {
  if (!b?.date || !e?.date || b.date !== e.date) return null; // another day is another event (a recurring one too)
  // Two invoice numbers that differ are two different BEOs.
  if (b.invoiceNumber && e.invoiceNumber && b.invoiceNumber !== e.invoiceNumber) return null;
  const name = nameSimilarity(b.name, e.name);
  const time = timeRelation(b, e);
  const room = roomRelation(b, e);
  const guests = guestRelation(Number(b.guestCount) || 0, Number(e.guestCount) || 0);
  // Same room, same day, different times: two events, unless they have the same name.
  if (time === 'different' && name < 0.9) return null;
  if (name < 0.34 && !(time === 'same' && room === 'same')) return null; // nothing in common but the day
  const score = +(WEIGHTS.name * name + WEIGHTS.time * TIME_SCORE[time] + WEIGHTS.room * ROOM_SCORE[room] + WEIGHTS.guests * GUEST_SCORE[guests]).toFixed(3);
  // Below the line, unless it's the same room at the same time (one room holds one event): then a maybe.
  if (score < MIN_SCORE && !(time === 'same' && room === 'same')) return null;
  const reasons = ['sameDate',
    name >= 0.99 ? 'sameName' : name >= 0.6 ? 'similarName' : 'differentName',
    { same: 'sameTime', overlap: 'overlappingTime', different: 'differentTime', unknown: '' }[time],
    { same: 'sameRoom', different: 'differentRoom', unknown: '' }[room],
    { same: 'sameGuests', different: 'differentGuests', unknown: '' }[guests],
    e.source === 'tripleseat' ? 'fromTripleseat' : e.source === 'beo-pdf' ? 'fromPdf' : 'typedIn',
  ].filter(Boolean);
  // A different time is never more than a maybe (two seatings of one dinner have the same name).
  return { score, confidence: time === 'different' ? 'low' : confidenceOf(score), reasons };
}

/**
 * Is this (cleaned) BEO an event already here? events: the restaurant's events.
 * → { how: 'tripleseat'|'invoice'|'previousImport', event } for a confident match, or
 *   { candidates: [{ event, score, confidence, reasons }] } (best first, at most 3; empty when it's new).
 */
export function matchEvent(b, events) {
  const list = (events || []).filter(Boolean);
  const ts = b.tripleseatId;
  if (ts) {
    const hit = list.find((e) => e.source === 'tripleseat' && (String(e.externalId) === ts || String(e.tripleseat?.id || '') === ts));
    if (hit) return { how: 'tripleseat', event: hit };
  }
  if (b.invoiceNumber) {
    const hit = list.find((e) => e.invoiceNumber === b.invoiceNumber);
    if (hit) return { how: 'invoice', event: hit };
    // A Tripleseat BEO's invoice number can be its event or booking id.
    const tsHit = list.find((e) => e.source === 'tripleseat' && (String(e.externalId) === b.invoiceNumber || String(e.tripleseat?.bookingId || '') === b.invoiceNumber));
    if (tsHit) return { how: 'tripleseat', event: tsHit };
  }
  const key = importKey(b);
  if (key) {
    const hit = list.find((e) => (e.importKeys || []).includes(key));
    if (hit) return { how: 'previousImport', event: hit };
  }
  const candidates = list.map((e) => ({ event: e, ...compareEvents(b, e) })).filter((c) => c.score)
    .sort((x, y) => y.score - x.score).slice(0, 3);
  return { candidates };
}

/** The key two BEOs in one file share when they're the same event: the invoice number, else the name and date. */
const sameBeoKey = (b) => (b.invoiceNumber ? `inv:${b.invoiceNumber}` : b.name && b.date ? `nd:${nameTokens(b.name).join(' ')}|${b.date}` : '');
const newer = (a, b) => ((a.beoUpdatedAt || '') !== (b.beoUpdatedAt || '') ? (a.beoUpdatedAt || '') > (b.beoUpdatedAt || '') : (a.pages?.[0] ?? a.index ?? 0) > (b.pages?.[0] ?? b.index ?? 0));

/**
 * The same BEO more than once in one file → one candidate, the newest. Each one kept gets `merged`: the copies
 * left out ([{ pages, beoUpdatedAt, index }]), for the preview to say so. Order: where each kept one appears.
 */
export function dedupeBeos(list) {
  const groups = new Map();
  const out = [];
  (list || []).forEach((b, index) => {
    const key = sameBeoKey(b);
    const entry = { ...b, index: b.index ?? index };
    if (!key) { out.push(entry); return; }
    const g = groups.get(key);
    if (!g) { const slot = { best: entry, others: [] }; groups.set(key, slot); out.push(slot); return; }
    if (newer(entry, g.best)) { g.others.push(g.best); g.best = entry; } else g.others.push(entry);
  });
  return out.map((x) => {
    if (!x.best) return x;
    const { best, others } = x;
    if (!others.length) return best;
    // A decision made on any copy (update, skip, new) holds for the one kept.
    const decision = best.decision || others.find((o) => o.decision)?.decision;
    return { ...best, ...(decision ? { decision } : {}), merged: others.map((o) => ({ index: o.index, pages: o.pages || null, beoUpdatedAt: o.beoUpdatedAt || '' })) };
  });
}
