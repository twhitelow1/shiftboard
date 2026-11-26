// Unpublish: move a published schedule back to draft so a manager can change it, and tell people what
// changed when it's posted again. Plugged into core/service.js (see unpublishApi below).
//
// shifts.unpublish({ start, end, scope: { area, jobCodeId }, keepEvents, notify, note, dryRun }) (managers and up):
//   - covers the published shifts from start to end, optionally only one room (area) and/or one position;
//   - shifts that already started stay published (history can't be unpublished): "kept";
//   - shifts from an event's BEO staffing go back to draft too (the whole week is the schedule), unless
//     keepEvents is set: then they stay posted, "keptEvents" (the event's own Publish posts them again);
//   - open and pending trades, give-aways and pickups on the shifts it pulls back are cancelled and the
//     people on them told (always: it's their own request); everyone who had a shift in it is told the
//     schedule was pulled back (with the manager's optional note), in their own language, through the usual
//     channels, unless the manager turned "Notify staff" off (notify: false; core/notify-choice.js);
//   - dryRun returns the same counts without changing anything (the confirmation dialog's numbers);
//   - it's recorded in the audit log: who, when, the range, the scope and the counts.
//
// Each unpublish keeps what everyone had seen (a `pullbacks` document: { id, start, end, scope, at, by,
// seen: { userId: [{ id, date, start, end, jobCodeId, area }] }, closedAt }). When shifts.publish next posts a
// range that covers it, each of those people gets one notification saying what changed for them (added,
// removed, moved) instead of the plain "schedule is posted", and the pullback is closed.

import { uid } from './store.js';
import { prettyDate, fmtTime } from './time.js';
import { sameArea, findArea, scheduleAreas } from './areas.js';
import { roomOfShift } from './layout.js';
import { msg } from './messages.js';
import { wantsNotify, staffNotifier } from './notify-choice.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;
const ACTIVE = ['open', 'pending_approval'];
const SHOWN_CHANGES = 3; // per notification; the rest are "(+N more)"
const snap = (s) => ({ id: s.id, date: s.date, start: s.start, end: s.end || null, jobCodeId: s.jobCodeId, area: s.area || '' });
const sameSlot = (a, b) => a.date === b.date && a.start === b.start && (a.end || null) === (b.end || null) && a.jobCodeId === b.jobCodeId && (a.area || '') === (b.area || '');

export function unpublishApi({ store, api, fail, needMgr, notify, say, day, describe, settings, nameOf, jobName, isFuture, cancelRequestsForShift, now }) {
  /** A shift's day and time without its position: 'Tue, Sep 29 4p–10p' · 'mar, 29 de sep · 4 pm–cierre'. */
  const when = (s, lang) => {
    const st = settings().startTimesOnly;
    if (lang === 'en') return `${prettyDate(s.date)} ${fmtTime(s.start)}${s.end && !st ? '–' + fmtTime(s.end) : ''}`;
    const end = st ? '' : s.end ? `–${fmtTime(s.end, lang)}` : `–${msg(lang).untilClose}`;
    return `${prettyDate(s.date, { lang })} · ${fmtTime(s.start, lang)}${end}`;
  };

  function cleanScope(scope) {
    const typed = String(scope?.area || '').trim();
    const area = typed ? findArea(typed, scheduleAreas(settings())) || typed : ''; // its saved spelling, for the notification
    const jobCodeId = scope?.jobCodeId ? String(scope.jobCodeId) : '';
    if (jobCodeId && !store.get('jobCodes', jobCodeId)) fail(400, 'Choose a job code');
    return { ...(area ? { area } : {}), ...(jobCodeId ? { jobCodeId } : {}) };
  }
  const inScope = (s, scope) => (!scope.jobCodeId || s.jobCodeId === scope.jobCodeId) &&
    (!scope.area || sameArea(roomOfShift(s, store.get('jobCodes', s.jobCodeId)), scope.area));

  /** What an unpublish of this range and scope would do. */
  function plan({ start, end, scope, keepEvents }) {
    const all = store.list('shifts', (s) => s.published && s.date >= start && s.date <= end && inScope(s, scope));
    const pull = [], kept = [], keptEvents = [];
    for (const s of all) {
      if (!isFuture(s)) kept.push(s);
      else if (s.eventId && keepEvents) keptEvents.push(s);
      else pull.push(s);
    }
    const ids = new Set(pull.map((s) => s.id));
    const requests = store.list('requests', (r) => ACTIVE.includes(r.status) && (ids.has(r.shiftId) || ids.has(r.targetShiftId)));
    const people = [...new Set(pull.map((s) => s.userId).filter(Boolean))];
    return { pull, kept, keptEvents, requests, people };
  }

  api['shifts.unpublish'] = (actor, a) => {
    needMgr(actor);
    const { start, end } = a;
    if (!DATE.test(start || '') || !DATE.test(end || '') || end < start) fail(400, 'Pick a week');
    if ((Date.parse(end) - Date.parse(start)) / 86400000 >= MAX_DAYS) fail(400, 'Pick a week');
    const scope = cleanScope(a.scope);
    const keepEvents = !!a.keepEvents;
    const note = String(a.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const p = plan({ start, end, scope, keepEvents });
    const notifyStaff = staffNotifier(notify, a);
    // people: who has a shift in it; notified: who is told it was pulled back (none with "Notify staff" off).
    const counts = { unpublished: p.pull.length, kept: p.kept.length, keptEvents: p.keptEvents.length, requestsCancelled: p.requests.length,
      people: p.people.length, notify: wantsNotify(a), notified: wantsNotify(a) ? p.people.length : 0,
      eventShifts: p.keptEvents.length + p.pull.filter((s) => s.eventId).length }; // posted event shifts that haven't started (for the dialog's "keep them" choice)
    if (a.dryRun || !p.pull.length) return { ...counts, dryRun: !!a.dryRun };

    const at = now().toISOString();
    // What each person had seen, for the "what changed" notification when it's posted again.
    const seen = {};
    for (const s of p.pull) if (s.userId) (seen[s.userId] ||= []).push(snap(s));
    store.insert('pullbacks', { id: uid('pbk'), start, end, scope, keepEvents, notified: counts.notify, at, by: actor.id, seen, closedAt: null });
    for (const s of p.pull) {
      cancelRequestsForShift(s.id, 'reasonPulledBack');
      store.update('shifts', s.id, { published: false, unpublishedAt: at, unpublishedBy: actor.id });
    }
    const label = (lang) => [scope.area, scope.jobCodeId && jobName(scope.jobCodeId, lang)].filter(Boolean).join(' · ');
    notifyStaff(p.people, say('schedulePulledBack', day(start, { dow: false }), day(end, { dow: false }), label, note, nameOf(actor.id)), '#/my');
    store.insert('auditLog', { id: uid('aud'), at, actorId: actor.id, targetId: null, action: 'schedule.unpublished',
      details: { start, end, scope, keepEvents, ...counts, note } });
    return counts;
  };

  /**
   * Called by shifts.publish (a date range, not an event) after it posts `published` (the shifts it just
   * published). Each person in an open pullback inside start–end gets what changed for them since they last
   * saw it. Returns the people it covered (told, or not because `args.notify` is false), so publish doesn't send
   * them the plain "schedule is posted" too.
   */
  function republished({ start, end, published, args }) {
    const notifyStaff = staffNotifier(notify, args); // Publish's own "Notify staff" choice, when it has one
    const open = store.list('pullbacks', (p) => !p.closedAt && p.start >= start && p.end <= end).sort((x, y) => x.at.localeCompare(y.at));
    const told = new Set();
    if (!open.length) return told;
    const seen = new Map();
    for (const p of open) {
      for (const [userId, list] of Object.entries(p.seen || {})) {
        const m = seen.get(userId) || new Map();
        for (const x of list) m.set(x.id, x); // a later pullback has the newer view
        seen.set(userId, m);
      }
    }
    const from = day(start, { dow: false }), to = day(end, { dow: false });
    for (const [userId, had] of seen) {
      const changes = [];
      for (const old of had.values()) {
        const cur = store.get('shifts', old.id);
        if (!cur || !cur.published || cur.userId !== userId) changes.push(say('changeRemoved', (lang) => describe(old, lang)));
        else if (!sameSlot(old, cur)) {
          const same = old.jobCodeId === cur.jobCodeId && (old.area || '') === (cur.area || '');
          changes.push(say('changeMoved', (lang) => describe(old, lang), (lang) => (same ? when(cur, lang) : describe(cur, lang))));
        }
      }
      for (const s of published) if (s.userId === userId && !had.has(s.id)) changes.push(say('changeAdded', (lang) => describe(s, lang)));
      const list = (lang) => changes.slice(0, SHOWN_CHANGES).map((c) => c(lang)).join('; ') + (changes.length > SHOWN_CHANGES ? msg(lang).more(changes.length - SHOWN_CHANGES) : '');
      notifyStaff([userId], changes.length ? say('republishedChanges', from, to, list) : say('republishedSame', from, to), '#/my');
      told.add(userId);
    }
    const at = now().toISOString();
    for (const p of open) store.update('pullbacks', p.id, { closedAt: at });
    return told;
  }

  return { republished };
}
