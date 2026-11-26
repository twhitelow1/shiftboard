// Availability, the part that knows ShiftBoard's people: who may change whose, saving a change with its log entry and
// the person's notification, and reading it back. Merged into core/service.js (employees.setAvailability calls
// setFor; the availability import in core/import-api.js does too). The model and the log are core/availability.js.
//
//   employees.setAvailability { userId?, availability?, notes?, maxHours?, maxDays?, notify? }   (core/service.js)
//   availability.get          { userId? }  → the week, notes, limits, the effective date, and whether you can edit it
//   availability.history      { userId?, limit? } → the log, newest first (2 years)
//
// Who changes whose: everyone their own. Someone else's: managers and up (as before), and supervisors for employees
// when Settings → Roles & features turns on "Edit staff availability" (editAvailability) for them. Turning it off for
// managers leaves them their own only. Every change is logged with who, when, for whom and how (via), and the person
// is notified when someone else changed theirs (settings.notifyAvailabilityChanges, on unless turned off; an import
// notifies only when the manager ticks it).
import { roleOf, rankOf } from './roles.js';
import { roleAllows } from './role-features.js';
import { cleanAvailability, weekChanges, logChange, historyOf, viaOf, dayView, NOTE_MAX } from './availability.js';

const limit = (v, max) => (v === '' || v == null ? null : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : undefined);

export function availabilityApi({ store, now, today, fail, needAuth, settings, notify, say, userById, isMgr, via, view }) {
  /** May `actor` change `target`'s availability? */
  function canEditOf(actor, target) {
    if (!actor || !target) return false;
    if (actor.id === target.id) return true;
    if (roleAllows(actor, settings()).editAvailability === false) return false;
    if (isMgr(actor)) return true;
    return roleOf(actor) === 'supervisor' && rankOf(target) < rankOf(actor);
  }
  const canSee = (actor, target) => !!target && (actor.id === target.id || isMgr(actor) || canEditOf(actor, target));

  /**
   * Save a change to someone's availability, log it and tell them. patch: { availability?, notes?, maxHours?, maxDays?,
   * effectiveFrom? } (only what's sent changes). how: { via: 'app' | 'import' | …, notify?: boolean, fileName? }.
   * Returns { user, days, fields } (what changed).
   */
  function setFor(actor, target, patch, how = {}) {
    const u = userById(target.id);
    const next = {};
    const fields = [];
    let days = [];
    if (patch.availability !== undefined) {
      const av = cleanAvailability(patch.availability);
      days = weekChanges(u.availability, av);
      next.availability = av;
      const from = /^\d{4}-\d{2}-\d{2}$/.test(patch.effectiveFrom || '') && patch.effectiveFrom > today() ? patch.effectiveFrom : null;
      if (from && days.length) {
        // From a later date: shifts before it are still checked against what they had (core/service.js conflictList).
        next.availabilityFrom = from;
        next.availabilityBefore = u.availabilityFrom && u.availabilityFrom > today() && u.availabilityBefore ? u.availabilityBefore : (u.availability || {});
        if (u.availabilityFrom !== from) fields.push({ field: 'effectiveFrom', before: u.availabilityFrom || '', after: from });
      } else if (u.availabilityFrom && days.length) {
        next.availabilityFrom = null;
        next.availabilityBefore = null;
      }
    }
    if (patch.notes !== undefined) {
      const notes = String(patch.notes ?? '').replace(/\r/g, '').trim().slice(0, 500);
      if (notes !== (u.availabilityNotes || '')) { fields.push({ field: 'notes', before: u.availabilityNotes || '', after: notes }); next.availabilityNotes = notes; }
    }
    for (const [k, max] of [['maxHours', 80], ['maxDays', 7]]) {
      if (patch[k] === undefined) continue;
      const v = limit(patch[k], max);
      if (v === undefined) fail(400, k === 'maxHours' ? 'Max hours is a number from 0 to 80' : 'Max days is a number from 0 to 7');
      if ((u[k] ?? null) !== v) { fields.push({ field: k, before: u[k] ?? null, after: v }); next[k] = v; }
    }
    const saved = Object.keys(next).length ? store.update('users', u.id, next) : u;
    if (days.length || fields.length) {
      logChange(store, now, { userId: u.id, actorId: actor.id, via: how.via || viaOf(via), days, fields, fileName: how.fileName });
      const tell = how.notify ?? settings().notifyAvailabilityChanges !== false;
      if (actor.id !== u.id && tell) notify([u.id], say('availabilityChanged', userById(actor.id)?.name || ''), '#/timeoff/availability');
    }
    return { user: saved, days, fields };
  }

  const who = (actor, userId) => {
    const target = userId ? userById(userId) : userById(actor.id);
    if (!target) fail(404, 'User not found');
    if (!canSee(actor, target)) fail(403, 'You can only see your own availability');
    return target;
  };
  const nameOf = (id) => userById(id)?.name || '';

  return {
    canEditOf,
    setFor,
    methods: {
      'availability.get': (actor, { userId } = {}) => {
        needAuth(actor);
        const u = who(actor, userId);
        const st = settings();
        return {
          userId: u.id, name: u.name, availability: u.availability || {}, notes: u.availabilityNotes || '', maxHours: u.maxHours ?? null, maxDays: u.maxDays ?? null,
          effectiveFrom: u.availabilityFrom && u.availabilityFrom > today() ? u.availabilityFrom : null,
          previous: u.availabilityFrom && u.availabilityFrom > today() ? u.availabilityBefore || {} : null,
          canEdit: canEditOf(actor, u), notifies: actor.id !== u.id && st.notifyAvailabilityChanges !== false, noteMax: NOTE_MAX,
        };
      },
      'availability.history': (actor, { userId, limit: n } = {}) => {
        needAuth(actor);
        const u = who(actor, userId);
        return historyOf(store, now, u.id, { limit: Number(n) || 100 }).map((e) => ({
          id: e.id, at: e.at, via: e.via, actorId: e.actorId, actorName: e.actorId === u.id ? u.name : nameOf(e.actorId), self: e.actorId === u.id,
          days: e.days.map((d) => ({ day: d.day, before: dayView(d.before), after: dayView(d.after) })), fields: e.fields || [], ...(e.fileName ? { fileName: e.fileName } : {}),
        }));
      },
      /** The people whose availability this person may edit (the person picker): [{ id, name }]. */
      'availability.people': (actor) => {
        needAuth(actor);
        return store.list('users', (u) => u.active !== false && canEditOf(actor, u)).map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
    /** employees.setAvailability (core/service.js). */
    rpc(actor, { userId, availability, notes, maxHours, maxDays, effectiveFrom } = {}) {
      needAuth(actor);
      const id = userId || actor.id;
      const target = userById(id);
      if (id !== actor.id && !(target ? canEditOf(actor, target) : isMgr(actor))) fail(403, 'You can only edit your own availability');
      if (!target) fail(404, 'User not found');
      const out = setFor(actor, target, { availability, notes, maxHours, maxDays, effectiveFrom });
      return view(actor, out.user);
    },
  };
}
