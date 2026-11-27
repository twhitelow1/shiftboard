// Time off: when each request came in, and who asked first.
//
// requestedAt: when the person asked. New requests store it (their own: the moment they asked; added by a manager: the
// date they give, "requested by email on Nov 3", never in the future; from an import: the import time, or the sheet's
// "requested on" column). It never changes when a manager edits, approves or denies it. Older requests don't have it:
// their createdAt is the same moment (exact); without one, the decision time stands in, marked approximate.
// enteredAt / enteredBy / source: who typed it in, when, and how it came in (app · email · text · phone · in_person ·
// sheet · import · other).
//
// First come, first served: requests (pending or approved) that cover the same day are in line by requestedAt, ties
// broken by the exact time and then the id. Each request's place is shown for its most contested day.
import { addDays } from './time.js';

export const SOURCES = ['app', 'email', 'text', 'phone', 'in_person', 'sheet', 'import', 'other'];
const live = (t) => t.status === 'pending' || t.status === 'approved';

/** { at, approx } — when the request came in (see above); at null when nothing records it. */
export function requestedOf(t) {
  if (t?.requestedAt) return { at: t.requestedAt, approx: !!t.requestedApprox };
  if (t?.createdAt) return { at: t.createdAt, approx: false };
  if (t?.decidedAt) return { at: t.decidedAt, approx: true };
  return { at: null, approx: true };
}
const order = (a, b) => {
  const x = requestedOf(a).at || '9999', y = requestedOf(b).at || '9999';
  return x.localeCompare(y) || String(a.id).localeCompare(String(b.id));
};
const daysOf = (t) => {
  const out = [];
  for (let d = t.startDate; d <= t.endDate && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * The line for each request: { [id]: { requestedAt, approx, source, enteredBy, enteredAt, date, place, of, others? } }.
 * rows: the requests the reader may see. all: every time-off request (the line counts everyone). withNames: the
 * others in line (people who approve); without it, only the reader's own place.
 */
export function timeOffQueue(rows, all, { withNames = false, nameOf = () => '' } = {}) {
  const byDay = new Map();
  for (const t of all.filter(live)) for (const d of daysOf(t)) byDay.set(d, [...(byDay.get(d) || []), t]);
  for (const list of byDay.values()) list.sort(order);
  const out = {};
  for (const t of rows) {
    const r = requestedOf(t);
    const info = { requestedAt: r.at, approx: r.approx, source: t.source || (t.enteredBy ? 'other' : 'app'), ...(t.enteredBy ? { enteredBy: t.enteredBy, enteredByName: nameOf(t.enteredBy), enteredAt: t.enteredAt || null } : {}) };
    if (live(t)) {
      let best = null;
      for (const d of daysOf(t)) {
        const list = byDay.get(d) || [];
        if (!best || list.length > best.list.length) best = { d, list };
      }
      if (best && best.list.length > 1) {
        info.date = best.d;
        info.place = best.list.findIndex((x) => x.id === t.id) + 1;
        info.of = best.list.length;
        if (withNames) info.others = best.list.filter((x) => x.id !== t.id).map((x) => ({ id: x.id, userId: x.userId, name: nameOf(x.userId), requestedAt: requestedOf(x).at, approx: requestedOf(x).approx, status: x.status, place: best.list.indexOf(x) + 1 }));
      }
    }
    out[t.id] = info;
  }
  return out;
}

/** A requested-on time a manager typed: an ISO time or a date, not in the future; null when it isn't one. */
export function cleanRequestedAt(v, now) {
  if (!v) return null;
  const s = String(v);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T12:00:00`) : Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  if (ms > now().getTime() + 60_000) return undefined;
  return new Date(ms).toISOString();
}
