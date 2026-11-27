// The schedule log: every change to the schedule, who made it, when, how (via) and before → after, as auditLog
// entries with action 'schedule.<what>' (one log for the restaurant: the connector's, imports' and View as entries are
// there too). Written by core/service.js and the modules it pulls in; read by Schedule log (managers) and My schedule
// changes (each person, only what affected them).
//
// An entry: { id, at, actorId, targetId, action: 'schedule.shift.edit', via, details: { kind, id, affected: [userIds],
//   date, weekStart?, jobCodeId?, room?, shift?: { date, start, end, jobCodeId, area, userId }, changes: [{ field,
//   before, after }], count?, extra… } }
// via: web · phone · import · connector · assistant · sync · cron. Never secrets; never the Feedback box (not logged).
// Kept: the whole auditLog is kept (at least the 2 years the owner asked for). A log write that fails never stops the
// change it describes (like server/errors.js's tracker): it's caught and reported on the console.
import { prettyDate, fmtTime, addDays } from './time.js';

export const PREFIX = 'schedule.';
export const VIAS = ['web', 'phone', 'import', 'connector', 'assistant', 'sync', 'cron'];
export const GROUPS = { shift: ['shift.create', 'shift.edit', 'shift.move', 'shift.delete', 'shifts.bulk'], week: ['week.clear', 'week.copy', 'drafts.clear', 'week.publish', 'week.unpublish', 'schedule.import'],
  request: ['request.create', 'request.accept', 'request.decline', 'request.approve', 'request.deny', 'request.cancel'],
  timeOff: ['timeOff.create', 'timeOff.add', 'timeOff.approve', 'timeOff.deny', 'timeOff.cancel', 'timeOff.standing'],
  availability: ['availability.change'], note: ['note.save'], mod: ['mod.set'], event: ['event.shifts'], layout: ['layout.move', 'rooms.change'], dayOff: ['dayOff.set', 'dayOff.clear'] };
const SHIFT_FIELDS = ['date', 'start', 'end', 'jobCodeId', 'area', 'userId', 'tag', 'notes'];

/** The fields of a shift that changed: [{ field, before, after }]. */
export function shiftChanges(before, after) {
  const out = [];
  for (const f of SHIFT_FIELDS) {
    const b = before?.[f] ?? '', a = after?.[f] ?? '';
    if (String(b) !== String(a)) out.push({ field: f, before: b, after: a });
  }
  return out;
}
const snap = (s) => (s ? { date: s.date, start: s.start, end: s.end || null, jobCodeId: s.jobCodeId, area: s.area || '', userId: s.userId || null } : null);

/** A writer bound to the service: log(actor, what, info). Never throws. */
export function scheduleLogger({ store, now, uid, via }) {
  return function log(actor, what, info = {}) {
    try {
      const s = info.shift || null;
      const affected = [...new Set([...(info.affected || []), s?.userId].filter(Boolean))];
      store.insert('auditLog', {
        id: uid('aud'), at: now().toISOString(), actorId: actor?.id || null, targetId: info.id || s?.id || null, action: PREFIX + what, via: info.via || via(),
        details: {
          kind: info.kind || (s ? 'shift' : what.split('.')[0]), id: info.id || s?.id || null, affected,
          date: info.date || s?.date || null, ...(info.weekStart ? { weekStart: info.weekStart } : {}),
          ...(s ? { shift: snap(s), jobCodeId: s.jobCodeId, room: s.area || '' } : {}), ...(info.jobCodeId ? { jobCodeId: info.jobCodeId } : {}),
          changes: info.changes || [], ...(info.extra || {}),
        },
      });
    } catch (e) {
      console.error('Schedule log entry not written:', e?.message || e); // the change itself goes ahead
    }
  };
}

// ---------------------------------------------------------------- reading it back

const T = {
  en: {
    open: 'an open', their: (n) => `${n}’s`, shiftOf: (who, what) => `${who} ${what} shift`,
    'shift.create': (a, s) => `${a} added ${s}`, 'shift.edit': (a, s, ch) => `${a} changed ${s}${ch ? `: ${ch}` : ''}`, 'shift.move': (a, s, ch) => `${a} moved ${s}${ch ? `: ${ch}` : ''}`,
    'dayOff.set': (a, p, d) => `${a} marked ${p} off on ${d} (day off)`, 'dayOff.clear': (a, p, d) => `${a} took back ${p} day off on ${d}`, 'shift.delete': (a, s) => `${a} deleted ${s}`,
    'shifts.bulk': (a, n) => `${a} added ${n} shifts`, 'week.clear': (a, n, w) => `${a} cleared the week of ${w} (${n} shifts)`, 'week.copy': (a, n, w) => `${a} copied ${n} shifts into the week of ${w}`,
    'drafts.clear': (a, n, w) => `${a} cleared ${n} draft shifts in the week of ${w}`, 'week.publish': (a, n, w) => `${a} published ${n} shifts (week of ${w})`,
    'week.unpublish': (a, n, w) => `${a} pulled the week of ${w} back to draft (${n} shifts)`, 'schedule.import': (a, n) => `${a} imported a schedule (${n} shifts)`,
    'request.create': (a, s, t) => `${a} asked to ${t} ${s}`, 'request.accept': (a, s) => `${a} accepted the request for ${s}`, 'request.decline': (a, s) => `${a} declined the trade for ${s}`,
    'request.approve': (a, s) => `${a} approved the request for ${s}`, 'request.deny': (a, s) => `${a} denied the request for ${s}`, 'request.cancel': (a, s) => `${a} cancelled the request for ${s}`,
    'timeOff.create': (a, p, d) => `${a} requested time off ${d}`, 'timeOff.add': (a, p, d, st) => `${a} added time off for ${p} ${d} (${st})`,
    'timeOff.approve': (a, p, d) => `${a} approved ${p} time off ${d}`, 'timeOff.deny': (a, p, d) => `${a} denied ${p} time off ${d}`, 'timeOff.cancel': (a, p, d) => `${a} cancelled ${p} time off ${d}`,
    'timeOff.standing': (a, p, d) => `${a} added a standing request off for ${p}: ${d}`,
    'availability.change': (a, p, n) => `${a} changed ${p} availability (${n} days)`, 'note.save': (a, d) => `${a} changed the note for ${d}`, 'mod.set': (a, d) => `${a} changed the manager on duty for ${d}`,
    'event.shifts': (a, n, e) => `${a} made ${n} shifts for the event ${e}`, 'layout.move': (a, n) => `${a} moved ${n} shifts to another section`, 'rooms.change': (a, p) => `${a} changed where ${p} works`,
    types: { swap: 'trade', drop: 'give away', pickup: 'pick up' }, statuses: { approved: 'approved', pending: 'pending' }, their2: 'their', someone: 'Someone', fields: { date: 'date', start: 'time', end: 'end', jobCodeId: 'position', area: 'room', userId: 'person', tag: 'tag', notes: 'note', rooms: 'rooms', status: 'status' }, none: 'none',
  },
  es: {
    open: 'un', their: (n) => `de ${n}`, shiftOf: (who, what) => (who === 'un' ? `un turno disponible ${what}` : `el turno ${what} ${who}`),
    'shift.create': (a, s) => `${a} agregó ${s}`, 'shift.edit': (a, s, ch) => `${a} cambió ${s}${ch ? `: ${ch}` : ''}`, 'shift.move': (a, s, ch) => `${a} movió ${s}${ch ? `: ${ch}` : ''}`,
    'dayOff.set': (a, p, d) => `${a} marcó a ${p} de descanso el ${d}`, 'dayOff.clear': (a, p, d) => `${a} quitó el día de descanso de ${p} del ${d}`, 'shift.delete': (a, s) => `${a} borró ${s}`,
    'shifts.bulk': (a, n) => `${a} agregó ${n} turnos`, 'week.clear': (a, n, w) => `${a} vació la semana del ${w} (${n} turnos)`, 'week.copy': (a, n, w) => `${a} copió ${n} turnos a la semana del ${w}`,
    'drafts.clear': (a, n, w) => `${a} quitó ${n} turnos en borrador de la semana del ${w}`, 'week.publish': (a, n, w) => `${a} publicó ${n} turnos (semana del ${w})`,
    'week.unpublish': (a, n, w) => `${a} regresó a borrador la semana del ${w} (${n} turnos)`, 'schedule.import': (a, n) => `${a} importó un horario (${n} turnos)`,
    'request.create': (a, s, t) => `${a} pidió ${t} ${s}`, 'request.accept': (a, s) => `${a} aceptó la solicitud de ${s}`, 'request.decline': (a, s) => `${a} rechazó el intercambio de ${s}`,
    'request.approve': (a, s) => `${a} aprobó la solicitud de ${s}`, 'request.deny': (a, s) => `${a} rechazó la solicitud de ${s}`, 'request.cancel': (a, s) => `${a} canceló la solicitud de ${s}`,
    'timeOff.create': (a, p, d) => `${a} pidió días libres ${d}`, 'timeOff.add': (a, p, d, st) => `${a} agregó días libres ${p} ${d} (${st})`,
    'timeOff.approve': (a, p, d) => `${a} aprobó los días libres ${p} ${d}`, 'timeOff.deny': (a, p, d) => `${a} rechazó los días libres ${p} ${d}`, 'timeOff.cancel': (a, p, d) => `${a} canceló los días libres ${p} ${d}`,
    'timeOff.standing': (a, p, d) => `${a} agregó un descanso fijo ${p}: ${d}`,
    'availability.change': (a, p, n) => `${a} cambió la disponibilidad ${p} (${n} días)`, 'note.save': (a, d) => `${a} cambió la nota del ${d}`, 'mod.set': (a, d) => `${a} cambió al gerente en turno del ${d}`,
    'event.shifts': (a, n, e) => `${a} creó ${n} turnos para el evento ${e}`, 'layout.move': (a, n) => `${a} pasó ${n} turnos a otra sección`, 'rooms.change': (a, p) => `${a} cambió dónde trabaja ${p}`,
    types: { swap: 'intercambiar', drop: 'ceder', pickup: 'recoger' }, statuses: { approved: 'aprobados', pending: 'pendientes' }, their2: 'sus', someone: 'Alguien', fields: { date: 'fecha', start: 'hora', end: 'fin', jobCodeId: 'puesto', area: 'salón', userId: 'persona', tag: 'etiqueta', notes: 'nota', rooms: 'salones', status: 'estado' }, none: 'nada',
  },
};

/**
 * An entry as a sentence in a language: "Moe changed Alex’s Sat 4:00 PM Bartender shift: time 4:00 PM → 5:00 PM".
 * names: { person(id) → name, job(id) → name, event(id) → name }.
 */
export function sentence(e, lang = 'en', names = {}) {
  const t = T[lang === 'es' ? 'es' : 'en'];
  const d = e.details || {};
  const raw = e.action.slice(PREFIX.length);
  const what = raw === 'unpublished' ? 'week.unpublish' : raw; // core/unpublish.js's own entry
  const actor = names.person?.(e.actorId) || t.someone;
  const person = (id) => (id ? names.person?.(id) || t.someone : '');
  const day = (date) => (date ? prettyDate(date, { lang }) : '');
  const shiftText = (s) => {
    if (!s) return '';
    const whatText = `${day(s.date)} ${fmtTime(s.start, lang)} ${names.job?.(s.jobCodeId) || ''}`.replace(/\s+/g, ' ').trim();
    const who = s.userId ? t.their(person(s.userId)) : t.open;
    return t.shiftOf(who, whatText) + (s.area ? ` (${s.area})` : '');
  };
  const val = (f, v) => (v === '' || v == null ? t.none : f === 'userId' ? person(v) : f === 'jobCodeId' ? names.job?.(v) || v : f === 'date' ? day(v) : f === 'start' || f === 'end' ? fmtTime(v, lang) : String(v));
  const changes = (d.changes || []).map((c) => `${c.position ? `${names.job?.(c.position) || ''} ` : ''}${t.fields[c.field] || c.field} ${val(c.field, c.before)} → ${val(c.field, c.after)}`).join(', ');
  const fn = t[what];
  if (!fn) return `${actor}: ${what}`;
  const week = day(d.weekStart || d.date || d.start);
  const pName = d.affected?.[0] ? (lang === 'es' ? `de ${person(d.affected[0])}` : `${person(d.affected[0])}’s`) : t.their2;
  const range = d.endDate && d.endDate !== d.date ? `${day(d.date)} – ${day(d.endDate)}` : day(d.date);
  switch (what) {
    case 'shift.create': case 'shift.delete': return fn(actor, shiftText(d.shift));
    case 'shift.edit': case 'shift.move': return fn(actor, shiftText(d.before || d.shift), changes);
    case 'dayOff.set': case 'dayOff.clear': return fn(actor, lang === 'es' ? person(d.affected?.[0]) : (what === 'dayOff.set' ? person(d.affected?.[0]) : `${person(d.affected?.[0])}’s`), day(d.date));
    case 'shifts.bulk': case 'schedule.import': case 'layout.move': return fn(actor, d.count || 0);
    case 'week.clear': case 'week.copy': case 'drafts.clear': case 'week.publish': case 'week.unpublish': return fn(actor, d.count ?? d.unpublished ?? 0, week);
    case 'request.create': return fn(actor, shiftText(d.shift), t.types[d.type] || d.type || '');
    case 'request.accept': case 'request.decline': case 'request.approve': case 'request.deny': case 'request.cancel': return fn(actor, shiftText(d.shift));
    case 'timeOff.create': return fn(actor, pName, range);
    case 'timeOff.add': return fn(actor, lang === 'es' ? `de ${person(d.affected?.[0])}` : person(d.affected?.[0]), range, t.statuses[d.status] || d.status || '');
    case 'timeOff.approve': case 'timeOff.deny': case 'timeOff.cancel': return fn(actor, pName, range);
    case 'timeOff.standing': return fn(actor, lang === 'es' ? `de ${person(d.affected?.[0])}` : person(d.affected?.[0]), d.daysText || '');
    case 'availability.change': return fn(actor, pName, d.days || 0);
    case 'note.save': case 'mod.set': return fn(actor, day(d.date));
    case 'event.shifts': return fn(actor, d.count || 0, names.event?.(d.eventId) || '');
    case 'rooms.change': return fn(actor, person(d.affected?.[0]));
    default: return fn(actor);
  }
}

/** Where an entry links to in the web app. */
export function linkOf(e) {
  const d = e.details || {};
  if (d.kind === 'request') return '#/swaps';
  if (d.kind === 'timeOff') return '#/timeoff';
  if (d.kind === 'availability') return '#/timeoff/availability';
  if (d.date) return `#/schedule/${d.weekStart || d.date}`;
  return '#/schedule';
}

/**
 * The RPCs: scheduleLog.list (managers and up, filters), scheduleLog.mine (anyone: what affected them), scheduleLog.csv.
 * filters: { from, to (YYYY-MM-DD, on the change's date or the schedule date), person (actor or affected), group
 * (GROUPS key), action, jobCodeId, room, via, limit }
 */
export function scheduleLogApi({ store, needAuth, needMgr, langOf, sameArea }) {
  const names = {
    person: (id) => store.get('users', id)?.name || '',
    job: (id) => store.get('jobCodes', id)?.name || '',
    event: (id) => store.get('events', id)?.name || '',
  };
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  function filtered(f = {}) {
    const actions = f.action ? [f.action] : f.group && GROUPS[f.group] ? GROUPS[f.group] : null;
    return store.list('auditLog', (e) => {
      if (!String(e.action || '').startsWith(PREFIX)) return false;
      const d = e.details || {};
      const what = e.action === 'schedule.unpublished' ? 'week.unpublish' : e.action.slice(PREFIX.length);
      if (actions && !actions.includes(what)) return false;
      if (f.via && e.via !== f.via) return false;
      if (f.person && e.actorId !== f.person && !(d.affected || []).includes(f.person)) return false;
      if (f.jobCodeId && d.jobCodeId !== f.jobCodeId) return false;
      if (f.room && !(d.room && sameArea(d.room, f.room))) return false;
      const when = d.date || d.start || e.at.slice(0, 10);
      const changed = e.at.slice(0, 10);
      if (isDate(f.from) && when < f.from && changed < f.from) return false;
      if (isDate(f.to) && when > addDays(f.to, 0) && changed > f.to) return false;
      return true;
    }).sort((a, b) => b.at.localeCompare(a.at));
  }
  const row = (e, lang, { mine = false } = {}) => ({
    id: e.id, at: e.at, via: e.via, action: e.action.slice(PREFIX.length), actorId: e.actorId, text: sentence(e, lang, names), link: linkOf(e),
    affected: mine ? undefined : e.details?.affected || [],
    // Staff see the fields of their own shift changing; never someone else's private notes or reasons.
    changes: (e.details?.changes || []).filter((c) => !mine || !['reason', 'note', 'notes'].includes(c.field)),
    date: e.details?.date || null,
  });
  const csvCell = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
  return {
    'scheduleLog.list': (actor, f = {}) => {
      needMgr(actor);
      const lang = langOf(actor);
      return filtered(f).slice(0, Math.min(Number(f.limit) || 200, 1000)).map((e) => row(e, lang));
    },
    'scheduleLog.mine': (actor, f = {}) => {
      needAuth(actor);
      const lang = langOf(actor);
      return filtered({ from: f.from, to: f.to }).filter((e) => (e.details?.affected || []).includes(actor.id))
        .slice(0, Math.min(Number(f.limit) || 100, 300)).map((e) => row(e, lang, { mine: true }));
    },
    'scheduleLog.csv': (actor, f = {}) => {
      needMgr(actor);
      const lang = langOf(actor);
      const head = lang === 'es' ? ['Cuándo', 'Quién', 'Vía', 'Qué', 'Fecha del horario', 'Cambios'] : ['When', 'Who', 'Via', 'What', 'Schedule date', 'Changes'];
      const lines = filtered(f).slice(0, 10000).map((e) => {
        const r = row(e, lang);
        return [r.at, names.person(r.actorId), r.via, r.text, r.date || '', r.changes.map((c) => `${c.field}: ${c.before ?? ''} → ${c.after ?? ''}`).join('; ')].map(csvCell).join(',');
      });
      return { csv: `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`, rows: lines.length };
    },
  };
}
