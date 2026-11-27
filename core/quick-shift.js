// Quick shifts on the schedule (web/src/pages/ShiftDialog.jsx's quick mode): moving a shift, and days off.
//
// - shifts.move: change an existing shift's date, person, position or room (and its times, tag, notes) IN PLACE:
//   the same id, logged as 'schedule.shift.move' (not a delete and a new shift). Its people are told like an edit.
// - Days off: a manager marks someone off on a day on purpose. The sheet shows DAY OFF there (not the plain OFF of
//   "nobody scheduled them"), it never counts as a shift or hours, and a shift added on that day gets a "Day off"
//   warning (core/service.js conflictList), never a block. Stored in the daysOff collection, one per person and day:
//   { id: 'doff_<userId>_<date>', userId, date, by, at }. No notification: a day off isn't a shift; removing a
//   published shift to make it still tells that person, like any deleted shift.
//   schedule.dayOff.set { userId, date, removeShifts } · schedule.dayOff.clear { userId, date } · schedule.dayOff.list { start, end }
// New RPCs only: no existing answer changes.

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
export const dayOffId = (userId, date) => `doff_${userId}_${date}`;
const MOVE_FIELDS = ['date', 'start', 'end', 'jobCodeId', 'area', 'userId', 'tag', 'notes', 'breakMin', 'eventId', 'staffingLineId', 'listPerson'];

export function quickShiftApi({ store, api, fail, needAuth, needMgr, isMgr, now, slog, saveShift, roleAllows, settings }) {
  const userById = (id) => store.get('users', id);
  return {
    /** Move a shift (same id): only the fields given change. Answers like shifts.save, plus moved: true. */
    'shifts.move': (actor, a = {}) => {
      needMgr(actor);
      const cur = a.id && store.get('shifts', a.id);
      if (!cur) fail(404, 'Shift not found');
      const next = { ...cur, id: cur.id };
      for (const k of MOVE_FIELDS) if (k in a) next[k] = a[k];
      if (a.overrideConflict === true) next.overrideConflict = true; // onto a blocked day, confirmed (core/schedule-conflicts.js)
      const r = saveShift(actor, next, { editAction: 'shift.move' });
      return { ...r, moved: true };
    },

    'schedule.dayOff.list': (actor, { start, end } = {}) => {
      needAuth(actor);
      if (!isDate(start) || !isDate(end)) fail(400, 'Pick a week');
      const allows = roleAllows(actor, settings());
      const seen = (userId) => isMgr(actor) || allows.schedule || userId === actor.id;
      return store.list('daysOff', (d) => d.date >= start && d.date <= end && seen(d.userId))
        .map(({ id, userId, date, by, at }) => ({ id, userId, date, by, at }));
    },

    /** Mark someone off on a day; removeShifts also deletes their shifts that day (each logged and told like shifts.delete). */
    'schedule.dayOff.set': (actor, { userId, date, removeShifts = false } = {}) => {
      needMgr(actor);
      if (!isDate(date)) fail(400, 'Pick a date');
      if (!userId || !userById(userId)) fail(400, 'Unknown employee');
      let removed = 0;
      if (removeShifts) {
        for (const s of store.list('shifts', (x) => x.userId === userId && x.date === date)) { api['shifts.delete'](actor, { id: s.id }); removed++; }
      }
      const id = dayOffId(userId, date);
      const had = store.get('daysOff', id);
      const doc = had || store.insert('daysOff', { id, userId, date, by: actor.id, at: now().toISOString() });
      if (!had) slog(actor, 'dayOff.set', { kind: 'dayOff', id, date, affected: [userId], extra: { removed } });
      const left = store.list('shifts', (x) => x.userId === userId && x.date === date).length;
      return { dayOff: doc, removed, shiftsLeft: left };
    },

    'schedule.dayOff.clear': (actor, { userId, date } = {}) => {
      needMgr(actor);
      if (!isDate(date)) fail(400, 'Pick a date');
      const id = dayOffId(userId, date);
      if (!store.get('daysOff', id)) return { ok: true, cleared: false };
      store.remove('daysOff', id);
      slog(actor, 'dayOff.clear', { kind: 'dayOff', id, date, affected: [userId] });
      return { ok: true, cleared: true };
    },
  };
}
