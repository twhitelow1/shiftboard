// Availability conflicts on the schedule: a person × day the person can't work blocks that day.
//
// What blocks (a manager must confirm to schedule over it; the API answers 409 without overrideConflict: true):
//   standing     a standing request off on that weekday (users.availability[day] = { available: false, standing: true })
//   unavailable  availability off that weekday (users.availability[day] = { available: false })
//   timeOff      approved time off covering the date
// What refuses outright (never overridable): pending time off ("pending_request"): the request has to be denied (or
// approved, which then blocks like any approved time off) before the person can be scheduled that day. The 409's
// conflict says which request, when it came in, and whether the caller may deny it (approval scope) or who can.
// What only warns (never blocks): partial availability (the window, "window": shifts
// outside it keep their "Available from/until" warning), a day off the manager marked (core/quick-shift.js).
//
// The guard (core/service.js saveShift: shifts.save, shifts.move, shifts.pasteMany): a NEW shift, or a shift whose
// person or date changes, onto a blocked day needs overrideConflict: true, else 409 with the reason in words and
// `conflict: { userId, date, kind, weekday?, note?, timeOff? }` (timeOff: who approved it and when, for managers).
// A pending request: 409 `conflict: { userId, date, kind: 'pending_request', overridable: false, request, canDeny,
// deciders, position }` whatever overrideConflict says. With it, the shift is saved with conflictOverride: { reason, by, at }
// and its schedule log entry says "scheduled over a standing request off". Editing a shift that stays on its
// person and day (times, notes…) never asks, even when its day became blocked later (it shows the red marker).
// Conflict-free saves answer exactly as before.
//
// Publishing (shifts.publish): each published shift on a blocked day tells its person (in-app and their usual channels,
// following the Publish dialog's "Notify staff") who scheduled them over what, once: the shift remembers what it told
// (conflictNotice) so a republish of the same conflict says nothing again.
//
//   schedule.conflicts { start, end }  (managers) → { cells: [{ userId, date, block?, window?, pending?, request? }],
//                                                     shifts: [{ id, userId, date, kind, published, override? }] }
//   block.timeOff (kind timeOff): { id, startDate, endDate, requestedAt, approx, reason, decidedBy, decidedByName,
//   decidedAt, decisionNote }; request (a pending request that day, even under a block): the same without the decision,
//   plus canDeny / deciders / position for the caller.
// New RPC and optional fields only.
import { requestedOf } from './time-off.js';
import { availabilityOn } from './availability.js';
import { dow, addDays } from './time.js';

export const BLOCK_KINDS = ['standing', 'unavailable', 'timeOff'];
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

const WEEKDAYS = {
  en: ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'],
  es: ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'],
};
export const weekdayPlural = (d, lang = 'en') => (WEEKDAYS[lang] || WEEKDAYS.en)[d];

/**
 * What a person's day looks like for the schedule (pure).
 * timeOff: that person's time off rows. Returns { block: { kind, note?, weekday?, timeOffId? } | null,
 * window: { from, to } | null, pending: boolean }.
 */
export function dayConflict(user, date, timeOff = []) {
  const live = timeOff.filter((t) => t.userId === user?.id && t.startDate <= date && t.endDate >= date);
  const approved = live.find((t) => t.status === 'approved');
  const pending = live.some((t) => t.status === 'pending');
  const d = dow(date);
  const av = availabilityOn(user, date)[d];
  let block = null;
  if (av && av.available === false) block = { kind: av.standing ? 'standing' : 'unavailable', weekday: d, ...(av.note ? { note: av.note } : {}) };
  else if (approved) block = { kind: 'timeOff', timeOffId: approved.id, ...(approved.reason ? { note: String(approved.reason).slice(0, 80) } : {}) };
  const window = !block && av && av.available !== false && (av.from || av.to) ? { from: av.from || '', to: av.to || '' } : null;
  return { block, window, pending: !block && pending };
}

/** The 409's words (the API's; the web app writes its own in the person's language). */
export function blockText(name, block, date) {
  if (block.kind === 'pending_request') {
    const r = block.request;
    const dates = r.endDate && r.endDate !== r.startDate ? `${r.startDate} to ${r.endDate}` : r.startDate;
    return `${name} requested off ${dates}${r.requestedAt ? ` (requested ${r.requestedAt.slice(0, 10)})` : ''}. Deny the request before scheduling them.`;
  }
  if (block.kind === 'standing') return `${name} has a standing request off on ${weekdayPlural(block.weekday)}. Schedule anyway?`;
  if (block.kind === 'unavailable') return `${name} is unavailable on ${weekdayPlural(block.weekday)}. Schedule anyway?`;
  return `${name} has approved time off on ${date}. Schedule anyway?`;
}

/** The earliest-requested pending request covering the day (pure), or null. */
export function pendingOn(userId, date, timeOff = []) {
  const live = timeOff.filter((t) => t.userId === userId && t.status === 'pending' && t.startDate <= date && t.endDate >= date);
  return live.sort((a, b) => String(requestedOf(a).at || '9').localeCompare(String(requestedOf(b).at || '9')) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

/**
 * decideInfo(actor, timeOff) → { canDeny, deciders: [name], position }: whether the caller may deny it, and who can
 * (core/service.js, from the approval scope).
 */
export function scheduleConflicts({ store, fail, needMgr, now, notify, say, desc, decideInfo = () => ({ canDeny: false, deciders: [], position: '' }) }) {
  const timeOffOf = (userId) => store.list('timeOff', (t) => t.userId === userId && (t.status === 'approved' || t.status === 'pending'));
  const blockOf = (userId, date) => {
    const u = userId && store.get('users', userId);
    return u ? dayConflict(u, date, timeOffOf(userId)).block : null;
  };
  const nameOf = (id) => (id && store.get('users', id)?.name) || '';
  /** A request's details for managers (never sent to staff: schedule.conflicts and the 409 are manager-only). */
  const requestDetails = (t) => {
    const r = requestedOf(t);
    return { id: t.id, startDate: t.startDate, endDate: t.endDate, requestedAt: r.at, approx: r.approx, reason: t.reason ? String(t.reason).slice(0, 200) : '' };
  };
  const approvedDetails = (t) => ({ ...requestDetails(t), decidedBy: t.decidedBy || null, decidedByName: nameOf(t.decidedBy), decidedAt: t.decidedAt || null,
    decisionNote: t.note ? String(t.note).slice(0, 200) : '' });
  /** The block with its time off's details (approved by whom, when). */
  const withDetails = (block) => {
    if (block?.kind !== 'timeOff' || !block.timeOffId) return block;
    const t = store.get('timeOff', block.timeOffId);
    return t ? { ...block, timeOff: approvedDetails(t) } : block;
  };
  const pendingInfo = (actor, t) => ({ ...requestDetails(t), ...decideInfo(actor, t) });
  /** The pending request blocking a person's day, or null. */
  const pendingOf = (actor, userId, date) => {
    const t = userId ? pendingOn(userId, date, timeOffOf(userId)) : null;
    return t ? pendingInfo(actor, t) : null;
  };
  /** The 409 for a pending request (never overridable). */
  const failPending = (userId, date, request) => {
    const block = { kind: 'pending_request', request };
    try { fail(409, blockText(nameOf(userId), block, date)); } catch (err) { err.conflict = { userId, date, kind: 'pending_request', overridable: false, request }; throw err; }
  };

  /**
   * Before saving a shift (core/service.js saveShift). a: what was sent; doc: the cleaned shift; cur: the shift before
   * (edits). Throws 409 when it needs confirming; returns the fields to store and what to log.
   */
  function guard(actor, a, doc, cur) {
    if (!doc.userId) return cur?.conflictOverride ? { set: { conflictOverride: null }, log: null } : { set: {}, log: null };
    const moved = !cur || cur.userId !== doc.userId || cur.date !== doc.date;
    if (!moved) return { set: {}, log: null };
    const pend = pendingOf(actor, doc.userId, doc.date); // deny it first: overrideConflict doesn't skip this one
    if (pend) failPending(doc.userId, doc.date, pend);
    const block = withDetails(blockOf(doc.userId, doc.date));
    if (!block) return cur?.conflictOverride ? { set: { conflictOverride: null }, log: null } : { set: {}, log: null };
    if (a.overrideConflict !== true) {
      const name = store.get('users', doc.userId)?.name || '';
      try { fail(409, blockText(name, block, doc.date)); } catch (err) { err.conflict = { userId: doc.userId, date: doc.date, ...block }; throw err; }
    }
    return { set: { conflictOverride: { reason: block.kind, by: actor.id, at: now().toISOString() } }, log: block.kind };
  }

  /** After a publish: tell each person scheduled over a blocked day, once per conflict. Returns how many were told. */
  function onPublish(actor, shifts, tell) {
    if (tell === false) return 0;
    const byName = store.get('users', actor.id)?.name || '';
    let told = 0;
    for (const s of shifts) {
      if (!s.userId) continue;
      const block = blockOf(s.userId, s.date);
      if (!block) continue;
      const key = `${s.userId}|${s.date}|${block.kind}`;
      const cur = store.get('shifts', s.id);
      if (!cur || cur.conflictNotice === key) continue;
      store.update('shifts', s.id, { conflictNotice: key });
      notify([s.userId], say('scheduledOverConflict', byName, desc(cur), say(`overReason_${block.kind}`)), '#/my');
      told++;
    }
    return told;
  }

  const methods = {
    'schedule.conflicts': (actor, { start, end } = {}) => {
      needMgr(actor);
      if (!isDate(start) || !isDate(end) || end < start) fail(400, 'Pick a week');
      if (addDays(start, 62) < end) fail(400, 'Pick a week');
      const people = store.list('users', (u) => u.active !== false);
      const tos = store.list('timeOff', (t) => (t.status === 'approved' || t.status === 'pending') && t.endDate >= start && t.startDate <= end);
      const cells = [];
      const blocked = new Map();
      for (const u of people) {
        const mine = tos.filter((t) => t.userId === u.id);
        for (let d = start; d <= end; d = addDays(d, 1)) {
          const c = dayConflict(u, d, mine);
          const req = pendingOn(u.id, d, mine);
          if (!c.block && !c.window && !c.pending && !req) continue;
          cells.push({ userId: u.id, date: d, ...(c.block ? { block: withDetails(c.block) } : {}), ...(c.window ? { window: c.window } : {}), ...(c.pending ? { pending: true } : {}),
            ...(req ? { request: pendingInfo(actor, req) } : {}) });
          if (c.block) blocked.set(`${u.id}|${d}`, c.block);
        }
      }
      const shifts = store.list('shifts', (s) => s.userId && s.date >= start && s.date <= end && blocked.has(`${s.userId}|${s.date}`))
        .map((s) => ({ id: s.id, userId: s.userId, date: s.date, start: s.start, jobCodeId: s.jobCodeId, kind: blocked.get(`${s.userId}|${s.date}`).kind, published: !!s.published,
          ...(s.conflictOverride ? { override: s.conflictOverride } : {}) }));
      return { cells, shifts };
    },
  };
  return { guard, onPublish, blockOf, pendingOf, methods };
}
