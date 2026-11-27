// Team availability: everyone's weekly availability side by side for one week, for the people who may see it (managers
// and up, and supervisors for employees when Roles & features turns on "Edit staff availability"). Read by
// availability.team.get (core/availability-api.js), Time Off → Availability → Team and Sheet on the web, the phone app's
// Team availability list, and the get_team_availability tool. Read only: nothing here changes anything.
//
//   availability.team.get { weekStart? } → {
//     weekStart, weekEnd, dates: [7 × 'YYYY-MM-DD'] (the restaurant's week, Monday first by default), today,
//     rooms: [{ room, color, positions: [{ jobCodeId, name, label }] }]   (the schedule's rooms, core/layout.js order)
//     people: [{ id, name, sheetName, legalName?, role, color, order, canEdit,
//                positions: [{ jobCodeId, name, rooms, primaryRoom }], room, jobCodeId   (primary room and position)
//                days: [7 × { date, dow, status: 'standing' | 'off' | 'partial' | 'open', from, to, note, requestedAt?,
//                             timeOff?: { id, status: 'approved' | 'pending', reason } }],
//                notes, maxHours, maxDays, effectiveFrom }],
//     counts: { standing: [7], off: [7], partial: [7], timeOff: [7] }   (per date, in `dates` order)
//   }
// The days are the availability that applies on each date (an import's effective date, core/availability.js
// availabilityOn). Dated time off (pending or approved) that touches the week is on the day it covers.
import { dayView, availabilityOn } from './availability.js';
import { addDays, dow as dowOf, weekStart as weekStartOf } from './time.js';
import { bannerColor, cleanArea, sameArea } from './areas.js';
import { entryRooms, homeRoom } from './layout.js';
import { offSchedule } from './roles.js';
import { legalNameOf, canSeeLegalName } from './names.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A day's status for the views: standing request off, unavailable, some hours, or open. */
export function dayStatus(raw) {
  const v = dayView(raw);
  if (!v.available) return { status: v.standing ? 'standing' : 'off', from: '', to: '', note: v.note, ...(v.standing && v.requestedAt ? { requestedAt: v.requestedAt } : {}) };
  return { status: v.from || v.to ? 'partial' : 'open', from: v.from, to: v.to, note: v.note };
}

/** A person's primary position and room: the primary job code entry (else the first), its primary room, else its first room, else the position's usual room. */
export function primaryOf(person, jobs, layout) {
  const list = (person?.jobCodes || []).filter((e) => jobs[e.jobCodeId]);
  const entry = list.find((e) => e.primary) || list[0];
  if (!entry) return { room: '', jobCodeId: '' };
  const job = jobs[entry.jobCodeId];
  const room = cleanArea(entry.primaryRoom) || entryRooms(entry, job)[0] || homeRoom(layout, job) || '';
  const named = (layout?.rooms || []).find((r) => sameArea(r.room, room));
  return { room: named?.room || room, jobCodeId: job.id };
}

/**
 * The answer of availability.team.get.
 *   actor     who asks
 *   people    the people they may see (already filtered)
 *   jobs      { id: jobCode }
 *   layout    { rooms } (core/layout.js)
 *   timeOff   every time-off request (only pending and approved ones in the week are used); null to leave them out
 *   canEdit   (person) → may the actor change theirs
 */
export function teamAvailability({ actor, people, jobs, layout, timeOff, settings = {}, today, weekStart, canEdit = () => false }) {
  const startDow = Number.isInteger(settings.weekStartDow) ? settings.weekStartDow : 1;
  const ws = weekStartOf(DATE.test(weekStart || '') ? weekStart : addDays(today, 7), startDow);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const we = dates[6];
  const rooms = (layout?.rooms || []).map((r, i) => ({
    room: r.room, color: bannerColor(settings, r.room, i),
    positions: (r.positions || []).filter((p) => !p.hidden && jobs[p.jobCodeId] && !jobs[p.jobCodeId].archived)
      .map((p) => ({ jobCodeId: p.jobCodeId, name: jobs[p.jobCodeId].name, ...(p.label ? { label: p.label } : {}) })),
  }));
  const offs = (timeOff || []).filter((t) => (t.status === 'approved' || t.status === 'pending') && t.startDate <= we && t.endDate >= ws);
  const counts = { standing: Array(7).fill(0), off: Array(7).fill(0), partial: Array(7).fill(0), timeOff: Array(7).fill(0) };
  const out = people.map((u) => {
    const prim = primaryOf(u, jobs, layout);
    const mine = offs.filter((t) => t.userId === u.id);
    const days = dates.map((date, i) => {
      const d = dowOf(date);
      const day = { date, dow: d, ...dayStatus(availabilityOn(u, date)[d]) };
      const to = mine.filter((t) => t.startDate <= date && t.endDate >= date).sort((a, b) => (a.status === 'approved' ? -1 : 1) - (b.status === 'approved' ? -1 : 1))[0];
      if (to) { day.timeOff = { id: to.id, status: to.status, reason: String(to.reason || '').slice(0, 200) }; counts.timeOff[i]++; }
      if (day.status !== 'open') counts[day.status][i]++;
      return day;
    });
    const legal = canSeeLegalName(actor, u) ? legalNameOf(u) : '';
    return {
      id: u.id, name: u.name, sheetName: u.sheetName || '', ...(legal && legal !== u.name ? { legalName: legal } : {}),
      role: u.role, color: u.color || null, order: u.order ?? null, canEdit: !!canEdit(u),
      positions: (u.jobCodes || []).filter((e) => jobs[e.jobCodeId] && !jobs[e.jobCodeId].archived).map((e) => ({
        jobCodeId: e.jobCodeId, name: jobs[e.jobCodeId].name, rooms: entryRooms(e, jobs[e.jobCodeId]), primaryRoom: cleanArea(e.primaryRoom) || '',
      })),
      room: prim.room, jobCodeId: prim.jobCodeId, days,
      notes: u.availabilityNotes || '', maxHours: u.maxHours ?? null, maxDays: u.maxDays ?? null,
      effectiveFrom: u.availabilityFrom && u.availabilityFrom > today ? u.availabilityFrom : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { weekStart: ws, weekEnd: we, dates, today, rooms, people: out, counts, timeOffShown: !!timeOff };
}

/** Who shows: active people on the schedule (not events-only or off-schedule ones). */
export const onTeamList = (u) => u.active !== false && !offSchedule(u);
