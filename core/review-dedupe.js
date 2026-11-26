// The same review arriving twice: a Google or Yelp review imported from a file (or pasted by hand) that later comes
// in from the API with another id or none, an export with cut-off text and then the full text, Yelp's excerpt and
// then the pasted review. Pure functions; core/impact.js (planReviews / applyReviews) uses them for every source.
//
// How two reviews are compared (compareReviews):
//   1. the same source (never Google against Yelp), and the same stars (different stars: at most "possible");
//   2. the author: first name and last initial ("Dana K." = "Dana Kimura"); a different first name or initial is
//      never the same review; an anonymous or missing name neither helps nor rules out;
//   3. the date, within a day either way (time zones and "posted" vs "exported" dates);
//   4. the text, normalised (accents, case, punctuation): one being the start of the other counts (an excerpt
//      cut with "…" or "...", at least 30 characters), else the share of words in common (Dice).
// Confident: same stars, a compatible author, and the text the same or one the start of the other (or ≥ 85% of
// words in common with a known author on both sides). Possible: anything else that's still close (≥ 50% of the
// words, or two rating-only reviews by the same author on the same day): it waits for a manager in Positive impact
// → Reviews ("Possible duplicate — check"), side by side, Merge or Keep both, and counts nowhere until then.
// Two different reviews on the same day by two people with the same first name and different words are neither.
import { shortName } from './guest-csv.js';
import { daysBetween } from './time.js';

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Text for comparing: no accents, case, punctuation or extra spaces, and no trailing "…" / "...". */
export const normText = (s) => fold(stripEllipsis(s)).replace(/[^a-z0-9ñ]+/g, ' ').trim();
export const stripEllipsis = (s) => String(s ?? '').trim().replace(/(\s*(\.{3}|…)\s*(read more)?)+$/i, '').trim();

/** The author as { first, initial } ('' when anonymous or missing). */
export function authorOf(reviewer) {
  const s = shortName(reviewer);
  if (!s || /^(opentable|google|yelp|tripadvisor|verified|a)\b/i.test(s)) return { first: '', initial: '' };
  const [first, last = ''] = s.split(' ');
  return { first: fold(first).replace(/[^a-z]/g, ''), initial: fold(last).replace(/[^a-z]/g, '').slice(0, 1) };
}
/** 'same' | 'unknown' | 'different'. */
export function authorMatch(a, b) {
  const x = authorOf(a), y = authorOf(b);
  if (!x.first || !y.first) return 'unknown';
  if (x.first !== y.first) return 'different';
  if (x.initial && y.initial && x.initial !== y.initial) return 'different';
  return 'same';
}

/** { score 0–1, prefix: one is the start of the other, empty: both empty }. */
export function textSimilarity(a, b) {
  const x = normText(a), y = normText(b);
  if (!x && !y) return { score: 1, prefix: false, empty: true };
  if (!x || !y) return { score: 0, prefix: false, empty: false };
  if (x === y) return { score: 1, prefix: false, empty: false };
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 30 && long.startsWith(short.replace(/\s+\S*$/, ''))) return { score: 1, prefix: true, empty: false }; // the last word may be cut mid-word
  const words = (s) => s.split(' ').filter((w) => w.length > 1);
  const wa = words(x), wb = words(y);
  if (!wa.length || !wb.length) return { score: 0, prefix: false, empty: false };
  const counts = new Map();
  for (const w of wa) counts.set(w, (counts.get(w) || 0) + 1);
  let common = 0;
  for (const w of wb) { const n = counts.get(w); if (n) { common++; counts.set(w, n - 1); } }
  return { score: (2 * common) / (wa.length + wb.length), prefix: false, empty: false };
}

/**
 * Whether an incoming review (item) and an existing one (doc) are the same: { level: 'confident' | 'possible' |
 * null, score }. Both have source, rating, date, reviewer, text.
 */
export function compareReviews(item, doc) {
  if (!item || !doc || item.source !== doc.source) return { level: null, score: 0 };
  if (!item.date || !doc.date || Math.abs(daysBetween(item.date, doc.date)) > 1) return { level: null, score: 0 };
  const who = authorMatch(item.reviewer, doc.reviewer);
  if (who === 'different') return { level: null, score: 0 };
  const sim = textSimilarity(item.text, doc.text);
  const stars = Math.round(Number(item.rating)) === Math.round(Number(doc.rating));
  if (sim.empty) return { level: stars && who === 'same' && item.date === doc.date ? 'possible' : null, score: 0.5 };
  const confident = stars && ((sim.score === 1 && (who === 'same' || normText(item.text).length >= 40)) || (sim.score >= 0.85 && who === 'same'));
  if (confident) return { level: 'confident', score: sim.score + (who === 'same' ? 0.1 : 0) };
  if (sim.score >= 0.5) return { level: 'possible', score: sim.score };
  return { level: null, score: sim.score };
}

/**
 * The best match among candidates: { level, doc } or { level: null }. Two equally confident candidates are only a
 * "possible" (the manager picks). skip(doc): candidates to leave out (already matched in this import, kept apart).
 */
export function findDuplicate(item, candidates, { skip = () => false } = {}) {
  let best = null;
  let ties = 0;
  for (const doc of candidates) {
    if (skip(doc)) continue;
    const c = compareReviews(item, doc);
    if (!c.level) continue;
    const rank = (c.level === 'confident' ? 10 : 0) + c.score;
    if (!best || rank > best.rank + 1e-9) { best = { ...c, doc, rank }; ties = 0; } else if (Math.abs(rank - best.rank) < 1e-9) ties++;
  }
  if (!best) return { level: null };
  return { level: best.level === 'confident' && ties ? 'possible' : best.level, doc: best.doc };
}

/**
 * A review pasted or imported from Yelp that Yelp's API showed as an excerpt (in the last 24 hours): the excerpt
 * is marked kept (it stops showing, the review stands for it) and returned, so the review doesn't alert again.
 */
export function claimExcerpt(store, review) {
  const x = store.list('yelpExcerpts').find((e) => compareReviews(review, { ...e, source: 'yelp' }).level);
  if (!x) return null;
  const cur = store.get('integrations', 'yelp');
  const kept = { ...(cur?.kept || {}), [x.ref]: review.id };
  if (cur) store.update('integrations', 'yelp', { kept }); else store.insert('integrations', { id: 'yelp', kept });
  return x;
}

/** The fuller of two texts (an excerpt never replaces the full review). */
export function fullerText(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  return stripEllipsis(y).length > stripEllipsis(x).length ? y : x;
}

/**
 * What a confident match writes on the existing review: the API's fields win over a file's (its id, date, stars,
 * author), the fuller text always; everything a manager did (staff matches, decisions, the reply) is untouched.
 */
export function mergeInto(existing, incoming, { incomingOrigin = 'csv' } = {}) {
  const apiWins = incomingOrigin === 'api' || existing.origin !== 'api';
  const base = apiWins ? { ...existing, ...incoming } : { ...incoming, ...existing };
  return { ...base, text: fullerText(existing.text, incoming.text), externalId: (apiWins ? incoming.externalId : existing.externalId) || existing.externalId || incoming.externalId || '' };
}
