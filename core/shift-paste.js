// Copy & paste a shift on the schedule (web/src/pages/Schedule.jsx, ScheduleSheet.jsx): a manager copies one shift
// and pastes it into one or more person × day cells. Each paste is a NEW draft shift for THAT row's person on THAT
// column's day, keeping the copied start, end (or until close), tag and notes; or, over a shift already there and
// only when asked, it replaces that shift's times, tag and notes (the same id).
//
// shifts.pasteMany { fromId, from?, targets: [{ userId, date, jobCodeId?, area?, replaceId?, add? }], givePosition?, confirmOff? }
//   from: the copied shift as the browser remembers it, used when fromId is gone (deleted since it was copied).
//   A target's jobCodeId/area are the row's position and room (sheet, by room, by position sections); without them:
//   the copied position if the person holds it (in the copied room if they work there, else their room for it), else
//   their primary position. Nothing is written until every target is clear; otherwise the answer is
//   { done: false, needs: { position, occupied, off }, skipped } and the web app asks, then sends again with:
//     givePosition: true   the person gets the position in that room (like the shift editor's "will get position")
//     replaceId / add      per target: replace that shift, or add another next to it
//     confirmOff: true     paste anyway on a day off, approved time off or a day they're unavailable (a blocked day's
//                          shift is marked conflictOverride and logged like any override: core/schedule-conflicts.js)
//   Done: { done: true, items: [{ userId, date, status: 'created' | 'replaced', shift, before?, warnings }], created, replaced }
//   A cell whose person has a pending time off request that day is skipped (skipped: { reason: 'pending_request',
//   request }): the request has to be denied first (core/schedule-conflicts.js), confirmOff doesn't change that.
//   Each one is logged in the schedule log as 'shift.paste' (or 'shift.pasteReplace') "pasted from <person>'s <day> shift".
// New RPC only: no existing answer changes. Managers only (needMgr), like shifts.save.
import { holdsIn, roomOfShift, areaForRoom } from './layout.js';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const MAX = 62; // a column of a long roster, or a row of a few weeks
const OFF_CODES = ['dayOff', 'timeOffApproved', 'unavailable'];

/**
 * Where a pasted shift goes for this person: { jobCodeId, room } (pure, for the web app's preview too).
 *   row: the row's { jobCodeId, area } when the row is a position's section, else null.
 */
export function pastePosition({ person, src, row, jobs }) {
  if (row?.jobCodeId && jobs[row.jobCodeId]) return { jobCodeId: row.jobCodeId, room: row.area ?? roomOfShift({}, jobs[row.jobCodeId]) };
  const entries = person?.jobCodes || [];
  const srcJob = jobs[src.jobCodeId];
  const srcRoom = roomOfShift(src, srcJob);
  const has = entries.find((e) => e.jobCodeId === src.jobCodeId);
  if (has && srcJob) {
    if (!srcRoom || holdsIn(person, srcJob, srcRoom)) return { jobCodeId: src.jobCodeId, room: srcRoom };
    return { jobCodeId: src.jobCodeId, room: has.primaryRoom || has.areas?.[0] || roomOfShift({}, srcJob) };
  }
  const primary = entries.find((e) => e.primary && jobs[e.jobCodeId]) || entries.find((e) => jobs[e.jobCodeId]);
  if (primary) return { jobCodeId: primary.jobCodeId, room: primary.primaryRoom || primary.areas?.[0] || roomOfShift({}, jobs[primary.jobCodeId]) };
  return { jobCodeId: src.jobCodeId, room: srcRoom }; // holds nothing: the copied position, which they'd get (asked first)
}

export function shiftPasteApi({ store, fail, needMgr, saveShift, conflictList, canManageUser, settings, pendingOf = () => null }) {
  const jobsMap = () => Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  return {
    'shifts.pasteMany': (actor, a = {}) => {
      needMgr(actor);
      const live = a.fromId ? store.get('shifts', a.fromId) : null;
      const src = live || a.from;
      if (!src || !/^\d{2}:\d{2}$/.test(src.start || '') || (src.end && !/^\d{2}:\d{2}$/.test(src.end))) fail(400, 'Copy a shift first');
      const list = Array.isArray(a.targets) ? a.targets : [];
      if (!list.length) fail(400, 'Pick a cell to paste into');
      if (list.length > MAX) fail(400, `Paste into at most ${MAX} cells at a time`);
      const jobs = jobsMap();
      const seen = new Set();
      const plan = [];
      const needs = { position: [], occupied: [], off: [] };
      const skipped = [];
      for (const t of list) {
        const person = t?.userId && store.get('users', t.userId);
        if (!person) fail(400, 'Unknown employee');
        if (!isDate(t.date)) fail(400, 'Pick a date');
        const key = `${t.userId}|${t.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const where = { userId: t.userId, date: t.date };
        const there = store.list('shifts', (s) => s.userId === t.userId && s.date === t.date);
        const replace = t.replaceId ? there.find((s) => s.id === t.replaceId) : null;
        if (t.replaceId && !replace) fail(400, 'That shift is no longer there');
        const pend = !replace && pendingOf(actor, t.userId, t.date); // deny the request first (never pasted over)
        if (pend) { skipped.push({ ...where, reason: 'pending_request', request: pend }); continue; }
        const pos = replace ? { jobCodeId: replace.jobCodeId, room: roomOfShift(replace, jobs[replace.jobCodeId]) } : pastePosition({ person, src, row: t.jobCodeId ? { jobCodeId: t.jobCodeId, area: t.area } : null, jobs });
        const job = jobs[pos.jobCodeId];
        if (!job) fail(400, 'Choose a job code');
        const doc = replace
          ? { ...replace, start: src.start, end: src.end || null, tag: src.tag || '', notes: src.notes || '' }
          : { date: t.date, start: src.start, end: src.end || null, tag: src.tag || '', notes: src.notes || '', breakMin: src.breakMin || 0,
            jobCodeId: pos.jobCodeId, area: areaForRoom(pos.room, job, settings()), userId: t.userId };
        const item = { ...where, jobCodeId: pos.jobCodeId, room: pos.room, replaceId: replace?.id || null, doc };
        const lacks = !replace && (pos.room ? !holdsIn(person, job, pos.room) : !(person.jobCodes || []).some((e) => e.jobCodeId === pos.jobCodeId));
        if (lacks) {
          if (!(person.id === actor.id || canManageUser(actor, person))) { skipped.push({ ...where, reason: 'position', jobCodeId: pos.jobCodeId, room: pos.room }); continue; }
          item.give = true;
          if (!a.givePosition) needs.position.push({ ...where, jobCodeId: pos.jobCodeId, room: pos.room });
        }
        if (!replace && there.length && !t.add) needs.occupied.push({ ...where, shifts: there.map((s) => ({ id: s.id, start: s.start, end: s.end || null, tag: s.tag || '', jobCodeId: s.jobCodeId, area: s.area || '' })) });
        const off = conflictList(t.userId, { ...doc, id: replace?.id }, []).filter((c) => OFF_CODES.includes(c.code)).map((c) => c.code);
        if (off.length && !a.confirmOff) needs.off.push({ ...where, codes: off });
        plan.push(item);
      }
      if (needs.position.length || needs.occupied.length || needs.off.length) return { done: false, needs, skipped, items: [] };
      const pastedFrom = { userId: src.userId || null, date: src.date || null, shiftId: live?.id || src.id || null };
      const items = [];
      for (const p of plan) {
        if (p.replaceId) {
          const before = store.get('shifts', p.replaceId);
          const r = saveShift(actor, { ...p.doc, id: p.replaceId }, { editAction: 'shift.pasteReplace', logExtra: { pastedFrom } });
          items.push({ userId: p.userId, date: p.date, status: 'replaced', shift: r.shift, before, warnings: r.warnings });
        } else {
          const r = saveShift(actor, { ...p.doc, published: false, listPerson: !!p.give, overrideConflict: !!a.confirmOff }, { createAction: 'shift.paste', logExtra: { pastedFrom } });
          items.push({ userId: p.userId, date: p.date, status: 'created', shift: r.shift, warnings: r.warnings, gavePosition: !!p.give });
        }
      }
      return { done: true, items, skipped, created: items.filter((x) => x.status === 'created').length, replaced: items.filter((x) => x.status === 'replaced').length };
    },
  };
}
