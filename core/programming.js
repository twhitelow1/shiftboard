// Regular programming and staffing pars (Settings → Programming): what normally runs in each room on each
// weekday ("Regular service", "Immersive dinner" in one room on Wednesdays and Saturdays, "DJ night" in the bar on
// weekends), with how many of each position it needs (its pars). Events override it, and so do one-off date
// exceptions. It shows on the calendar, fills the schedule's day-notes row, and gives managers coverage: scheduled
// vs par per day, room and position, with "Create open shifts for the gaps" (drafts only) and a warning when they
// publish a week with gaps.
//
// One document per item, collection 'programming':
//   { id, name, rooms: [room names] ([] = the whole venue), days: [0–6, Sunday 0], start: 'HH:MM', end: 'HH:MM' or ''
//     (until close), season: '' | a season key (core/seasons.js), from, to: '' | 'YYYY-MM-DD' (a date range),
//     repeat: 'weekly' | 'biweekly' (every other week, counted from `anchor`) | 'monthly' (the nth weekday of the month:
//     nth 1–4, or -1 for the last), color: '#rrggbb', notes (shown to staff), dayNote (the text for the schedule's
//     day-notes row; '' = its name and start time), pars: [{ jobCodeId, count, start?: 'HH:MM', room?: a room the
//     position is counted in (Hosts at the host stand) }], exceptions: { 'YYYY-MM-DD': { cancel?, start?, end?,
//     pars?, reason, at, by } }, order, active, createdAt, updatedAt, updatedBy }
//
// Rules, for one date (dayProgramming):
//   1. An item runs when its weekday, season, date range and repeat match, the item is active and the day isn't
//      closed in Settings (closed days show as closed).
//   2. Its date exception (if any): cancel ("Cancel DJ this Friday", "Closed for private event"), new times
//      ("Holiday hours") or new pars. Exceptions are kept on the item, shown, and removable (back to normal).
//   3. Events replace it: a confirmed event (manual, imported or from Tripleseat) in a room replaces that room's
//      programming for the time they overlap. A full buyout uses every room. When the event covers the item's whole
//      time (and all of its rooms) the item is replaced ("Replaced by <event>"); otherwise it's partly replaced and
//      keeps running in the rest (its time is cut to the part before or after the event). A whole-venue item is
//      replaced only by a full buyout. Tentative and cancelled events don't replace anything.
//   4. Staffing: an event's own staffing lines replace the pars of the programming it replaces. An event with none
//      asks: "Use the regular pars" (event.programmingPars = 'regular': the replaced items' pars, counted in its
//      rooms) or "Set pars for this event" (copies them into its staffing lines, which staffed x/y then counts).
//
// Coverage (managers and up by default: the staffingPars role feature): each par is filled by shifts that day with
// that position, in its room (any room for a whole-venue item), overlapping its time; each shift counts once. An
// event's lines count the shifts made for them (staffingLineId), exactly like the event's "staffed x/y".
// Assigned shifts count as scheduled; open ones are listed apart and creating open shifts for the gaps only adds
// what's still missing, as drafts.
import { uid } from './store.js';
import { addDays, dow, range, toMin, fmtTime, daysBetween, parseDate } from './time.js';
import { cleanArea, sameArea } from './areas.js';
import { seasonsOf, seasonOf } from './seasons.js';
import { effectiveShift } from './forecast.js';
import { eventStatus } from './beo.js';
import { roleAllows, ROLE_OFF } from './role-features.js';
import { canManageEvents } from './roles.js';
import { roomOfShift } from './layout.js';

export const PROG_COL = 'programming';
export const MAX_ITEMS = 100;
export const MAX_PARS = 30;
export const MAX_DAYS = 62;
export const REPEATS = ['weekly', 'biweekly', 'monthly'];
export const COLORS = ['#2563eb', '#9333ea', '#e11d48', '#d97706', '#16a34a', '#0f766e', '#475569', '#c026d3'];
// The audit log's actions (the restaurant's auditLog collection).
export const AUDIT = { saved: 'programming.saved', deleted: 'programming.deleted', override: 'programming.override', cleared: 'programming.overrideCleared',
  eventPars: 'programming.eventPars', fillGaps: 'programming.fillGaps' };

// The few words core writes (the apps translate everything else).
const WORDS = {
  en: { closed: 'CLOSED', guests: (n) => `${n} GUESTS` },
  es: { closed: 'CERRADO', guests: (n) => `${n} INVITADOS` },
};
const W = (lang) => WORDS[lang === 'es' ? 'es' : 'en'];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const initials = (s) => norm(s).split(' ').map((w) => w[0]).join('');

/** '18:00' → '6PM' (English) · '6 PM' (Spanish): the schedule's day-notes style. */
export const noteTime = (t, lang = 'en') => (lang === 'es' ? fmtTime(t, 'es').toUpperCase() : `${fmtTime(t, 'en')}m`.toUpperCase());

// ---------- cleaning what's saved ----------

/** A par line, checked: { jobCodeId, count, start?, room? }. */
function cleanPar(p, { jobExists, roomOf, fail }) {
  if (!p || typeof p !== 'object') fail(400, 'That position doesn’t exist');
  const jobCodeId = String(p.jobCodeId || '');
  if (!jobExists(jobCodeId)) fail(400, 'That position doesn’t exist');
  const count = Number(p.count);
  if (!Number.isInteger(count) || count < 0 || count > 99) fail(400, 'A par is a whole number from 0 to 99');
  const out = { jobCodeId, count };
  if (p.start) { if (!TIME.test(String(p.start))) fail(400, 'Pick a time like 17:00'); out.start = String(p.start); }
  if (p.room) out.room = roomOf(p.room);
  return out;
}

/** Pars, checked: one line per (position, room), at most MAX_PARS. */
export function cleanPars(list, ctx) {
  if (list == null) return [];
  if (!Array.isArray(list)) ctx.fail(400, 'That position doesn’t exist');
  if (list.length > MAX_PARS) ctx.fail(400, 'Up to 30 positions per item');
  const out = [];
  for (const p of list) {
    const c = cleanPar(p, ctx);
    const same = out.find((x) => x.jobCodeId === c.jobCodeId && (x.room || '') === (c.room || ''));
    if (same) Object.assign(same, c); else out.push(c);
  }
  return out;
}

/**
 * An item from the editor, checked. raw: the fields; ctx: { rooms (names), jobExists(id), settings, fail }.
 * Returns the fields to store (not id, exceptions or the stamps).
 */
export function cleanItem(raw, { rooms, jobExists, settings, fail }) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const name = text(a.name, 60);
  if (!name) fail(400, 'Give it a name');
  const roomOf = (r) => { const hit = rooms.find((x) => sameArea(x, r)); if (!hit) fail(400, 'Pick one of the venue’s rooms'); return hit; };
  const roomList = Array.isArray(a.rooms) ? [...new Set(a.rooms.map(roomOf))] : [];
  const days = Array.isArray(a.days) ? [...new Set(a.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (!days.length) fail(400, 'Pick at least one day');
  if (!TIME.test(String(a.start || ''))) fail(400, 'Pick a time like 17:00');
  const end = a.end ? String(a.end) : '';
  if (end && !TIME.test(end)) fail(400, 'Pick a time like 17:00');
  const season = a.season ? String(a.season) : '';
  if (season && !seasonsOf(settings).some((s) => s.key === season)) fail(400, 'Unknown season');
  const from = a.from ? String(a.from) : '';
  const to = a.to ? String(a.to) : '';
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) fail(400, 'Pick a date');
  if (from && to && to < from) fail(400, 'The last day is before the first');
  const repeat = REPEATS.includes(a.repeat) ? a.repeat : 'weekly';
  const nth = repeat === 'monthly' ? Number(a.nth) : null;
  if (repeat === 'monthly' && ![1, 2, 3, 4, -1].includes(nth)) fail(400, 'Pick which week of the month');
  const anchor = repeat === 'biweekly' ? String(a.anchor || from || '') : '';
  if (repeat === 'biweekly' && !DATE.test(anchor)) fail(400, 'Pick a date');
  const color = /^#[0-9a-f]{6}$/i.test(String(a.color || '')) ? String(a.color).toLowerCase() : COLORS[0];
  const pars = cleanPars(a.pars, { jobExists, roomOf, fail });
  return {
    name, rooms: roomList, days, start: String(a.start), end, season, from, to, repeat,
    ...(repeat === 'monthly' ? { nth } : {}), ...(repeat === 'biweekly' ? { anchor } : {}),
    color, notes: String(a.notes ?? '').replace(/\r/g, '').trim().slice(0, 500), dayNote: text(a.dayNote, 80),
    pars, active: a.active !== false,
  };
}

// ---------- when an item runs ----------

/** Does the item run on this date (weekday, season, date range, repeat, active)? Exceptions and events come later. */
export function occursOn(item, date, settings = {}) {
  if (!item || item.active === false) return false;
  if (!(item.days || []).includes(dow(date))) return false;
  if (item.from && date < item.from) return false;
  if (item.to && date > item.to) return false;
  if (item.season && seasonOf(date, settings).key !== item.season) return false;
  if (item.repeat === 'biweekly' && item.anchor) {
    const weeks = Math.floor(daysBetween(item.anchor, date) / 7);
    if (((weeks % 2) + 2) % 2 !== 0) return false;
  }
  if (item.repeat === 'monthly' && item.nth) {
    const d = parseDate(date).getUTCDate();
    if (item.nth === -1) { if (addDays(date, 7).slice(0, 7) === date.slice(0, 7)) return false; }
    else if (Math.ceil(d / 7) !== item.nth) return false;
  }
  return true;
}

/** Minutes from the date's midnight: [start, end), end after start (past midnight: + 1440). '' end = the day's close. */
export function windowOf({ start, end }, date, settings = {}) {
  const a = toMin(start || '00:00');
  let b;
  if (end) b = toMin(end);
  else {
    const close = settings.hours?.[dow(date)]?.close;
    b = close ? toMin(close) : a + 6 * 60;
  }
  if (b <= a) b += 1440;
  return [a, b];
}
const fromWindow = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

/** The rooms an event uses: { all: true } for a full buyout, else the room names its room text matches. */
export function eventRooms(event, roomNames = []) {
  const raw = String(event?.room || '');
  if (event?.fullBuyout || /full\s*buy-?out|buy-?out|whole venue|entire venue|todo el lugar/i.test(raw)) return { all: true, rooms: [...roomNames] };
  const out = [];
  const add = (r) => { if (r && !out.includes(r)) out.push(r); };
  for (const part of raw.split(/\s*(?:&|\/|,|\+|\band\b|\by\b)\s*/i).map(norm).filter(Boolean)) {
    add(roomNames.find((r) => norm(r) === part) || roomNames.find((r) => initials(r).length > 1 && initials(r) === part.replace(/[\s.]/g, ''))
      || (part.length >= 3 ? roomNames.find((r) => norm(r).startsWith(part)) : null));
  }
  for (const r of roomNames) if (norm(raw).includes(norm(r))) add(r);
  return { all: false, rooms: out };
}

/**
 * Overlap warnings: two items that can run on the same weekday, in the same room (a whole-venue item uses every
 * room), at overlapping times, with seasons and date ranges that meet. [{ a, b, room, days }] (room '' = venue).
 */
export function overlapWarnings(items, settings = {}) {
  const out = [];
  const live = items.filter((x) => x.active !== false);
  const rangesMeet = (x, y) => (!x.to || !y.from || y.from <= x.to) && (!y.to || !x.from || x.from <= y.to) && (!x.season || !y.season || x.season === y.season);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i], y = live[j];
      const days = (x.days || []).filter((d) => (y.days || []).includes(d));
      if (!days.length || !rangesMeet(x, y)) continue;
      const shared = !x.rooms?.length || !y.rooms?.length ? (x.rooms?.length ? x.rooms : y.rooms?.length ? y.rooms : ['']) : x.rooms.filter((r) => y.rooms.some((q) => sameArea(q, r)));
      if (!shared.length) continue;
      const [xa, xb] = windowOf(x, '2000-01-02', settings); // the time of day only (a Sunday with no hours: + 6 h for "until close")
      const [ya, yb] = windowOf(y, '2000-01-02', settings);
      if (xa < yb && ya < xb) out.push({ a: x.id, b: y.id, aName: x.name, bName: y.name, room: shared[0] || '', days });
    }
  }
  return out;
}

// ---------- one day ----------

/**
 * What runs on a date: { date, closed, items: [...], events: [...], noteLines, note }.
 * items: each item that would run, with status 'on' | 'cancelled' | 'replaced' | 'partial', its time that day,
 * the exception, and what replaced it. events: the confirmed events with the rooms they use.
 */
export function dayProgramming({ date, items, events = [], settings = {}, roomNames = [], lang = 'en', today = '' }) {
  const closed = (settings.closedDays || []).includes(dow(date));
  const evs = events.filter((e) => e.date === date && e.status !== 'cancelled' && eventStatus(e, today || date) !== 'tentative')
    .map((e) => {
      const used = eventRooms(e, roomNames);
      const [a, b] = windowOf({ start: e.start || '00:00', end: e.end || '' }, date, settings);
      return { id: e.id, name: e.name, start: e.start || '', end: e.end || '', room: e.room || '', rooms: used.rooms, all: used.all, guestCount: Number(e.guestCount) || 0,
        window: [a, b], staffing: e.staffing || [], programmingPars: e.programmingPars || '' };
    });
  const out = [];
  if (!closed) {
    for (const it of items.filter((x) => occursOn(x, date, settings)).sort((x, y) => (x.start || '').localeCompare(y.start || '') || (x.order ?? 0) - (y.order ?? 0))) {
      const ex = it.exceptions?.[date] || null;
      const start = ex?.start || it.start;
      const end = ex?.start ? ex.end || '' : it.end;
      const pars = ex?.pars || it.pars || [];
      const row = { id: it.id, name: it.name, rooms: it.rooms || [], color: it.color, notes: it.notes || '', dayNote: it.dayNote || '', start, end, pars,
        status: ex?.cancel ? 'cancelled' : 'on', exception: ex, replacedBy: [], window: windowOf({ start, end }, date, settings) };
      if (row.status === 'on') {
        // Events in its rooms, at overlapping times.
        const hits = evs.filter((e) => e.window[0] < row.window[1] && row.window[0] < e.window[1]
          && (e.all || (row.rooms.length && row.rooms.some((r) => e.rooms.some((q) => sameArea(q, r))))));
        if (hits.length) {
          row.replacedBy = hits.map((e) => ({ id: e.id, name: e.name, start: e.start, end: e.end, all: e.all }));
          const roomsCovered = hits.some((e) => e.all) || row.rooms.every((r) => hits.some((e) => e.rooms.some((q) => sameArea(q, r))));
          const evStart = Math.min(...hits.map((e) => e.window[0]));
          const evEnd = Math.max(...hits.map((e) => e.window[1]));
          const timeCovered = evStart <= row.window[0] && evEnd >= row.window[1];
          if (roomsCovered && timeCovered) row.status = 'replaced';
          else {
            row.status = 'partial';
            if (roomsCovered) {
              // The part before the event, else the part after it.
              row.window = evStart > row.window[0] ? [row.window[0], evStart] : [evEnd, row.window[1]];
              row.partStart = fromWindow(row.window[0]);
              row.partEnd = fromWindow(row.window[1]);
            } else row.roomsLeft = row.rooms.filter((r) => !hits.some((e) => e.rooms.some((q) => sameArea(q, r))));
          }
        }
      }
      out.push(row);
    }
  }
  const noteLines = autoNoteLines({ closed, items: out, events: evs, lang, roomCount: roomNames.length });
  return { date, closed, items: out, events: evs, noteLines, note: noteLines.join('\n') };
}

/** The day-notes row's automatic lines: each item that runs ("REGULAR SERVICE", "MOON RABBIT: IMMERSIVE DINNER 6PM"), or CLOSED. */
export function autoNoteLines({ closed, items, events = [], lang = 'en', roomCount = 1 }) {
  if (closed) return events.length ? [] : [W(lang).closed];
  return items.filter((x) => x.status === 'on' || x.status === 'partial').map((x) => {
    if (x.dayNote) return x.dayNote.toUpperCase();
    const rooms = x.roomsLeft || x.rooms;
    const prefix = rooms.length && roomCount > 1 ? `${rooms.join(' & ')}: ` : '';
    return `${prefix}${x.name} ${noteTime(x.partStart || x.start, lang)}`.toUpperCase();
  });
}

/** An event's line for the notes when it's shown on its own (the tools, the phone): "WEDDING · 110 GUESTS". */
export const eventNote = (e, lang = 'en') => [e.name, e.guestCount ? W(lang).guests(e.guestCount) : ''].filter(Boolean).join(' · ').toUpperCase();

// ---------- coverage ----------

/**
 * Scheduled vs par for one day. day: dayProgramming's answer; shifts: that day's shifts; jobs: { id: job }.
 * Returns [{ key, kind: 'item' | 'event', id, name, color, room, start, end, lines: [{ jobCodeId, need, have, open, gap,
 * start, room, staffingLineId? }] }]. need: the par; have: assigned shifts counted; open: open shifts counted; gap: need − have.
 */
export function dayCoverage({ day, shifts, jobs = {}, settings = {}, layoutRooms = null }) {
  const date = day.date;
  const used = new Set();
  const out = [];
  const spanOf = (s) => {
    const e = effectiveShift(s, settings);
    let a = toMin(e.start), b = toMin(e.end || e.start);
    if (b <= a) b += 1440;
    return [a, b];
  };
  const take = (match, need, win) => {
    let have = 0, open = 0;
    const pool = shifts.filter((s) => !used.has(s.id) && match(s) && (() => { const [a, b] = spanOf(s); return a < win[1] && win[0] < b; })())
      .sort((x, y) => (x.userId ? 0 : 1) - (y.userId ? 0 : 1) || x.start.localeCompare(y.start));
    for (const s of pool) {
      if (s.userId) { if (have < need) { have++; used.add(s.id); } } else if (have + open < need) { open++; used.add(s.id); }
    }
    return { have, open };
  };
  // A position that none of the rooms lists (a Manager, a Host at the host stand) counts wherever it's worked.
  const listedIn = (jobCodeId, rooms) => !layoutRooms || layoutRooms.some((r) => rooms.some((x) => sameArea(x, r.room)) && (r.positions || []).some((p) => p.jobCodeId === jobCodeId));
  const inRooms = (s, rooms) => {
    if (!rooms.length || !listedIn(s.jobCodeId, rooms)) return true;
    const r = roomOfShift(s, jobs[s.jobCodeId]);
    return rooms.some((x) => sameArea(x, r));
  };
  // Events first: their own lines count the shifts made for them, like the event's staffed x/y.
  for (const e of day.events) {
    const lines = [];
    if (e.staffing.length) {
      for (const l of e.staffing) {
        const mine = shifts.filter((s) => s.staffingLineId === l.id);
        mine.forEach((s) => used.add(s.id));
        const have = mine.filter((s) => s.userId).length;
        const need = Number(l.count) || 0;
        lines.push({ jobCodeId: l.jobCodeId, need, have, open: mine.length - have, gap: Math.max(0, need - have), start: l.start || e.start, room: e.rooms[0] || '', staffingLineId: l.id });
      }
    } else if (e.programmingPars === 'regular') {
      for (const it of day.items.filter((x) => x.replacedBy.some((r) => r.id === e.id))) {
        for (const p of it.pars) {
          const rooms = p.room ? [p.room] : it.rooms.length ? it.rooms : e.rooms;
          const got = take((s) => s.jobCodeId === p.jobCodeId && (!s.eventId || s.eventId === e.id) && inRooms(s, rooms), p.count, e.window);
          lines.push({ jobCodeId: p.jobCodeId, need: p.count, ...got, gap: Math.max(0, p.count - got.have), start: p.start || e.start, room: rooms[0] || '' });
        }
      }
    }
    if (lines.length) out.push({ key: `event:${e.id}`, kind: 'event', id: e.id, name: e.name, color: '', room: e.all ? '' : e.rooms.join(' & '), all: e.all, start: e.start, end: e.end, lines });
  }
  for (const it of day.items.filter((x) => x.status === 'on' || x.status === 'partial')) {
    const lines = [];
    for (const p of it.pars) {
      if (!p.count) continue;
      const rooms = p.room ? [p.room] : it.roomsLeft || it.rooms;
      // A par's own start ("Barbacks in at 5") stretches its window back to then.
      let ps = p.start ? toMin(p.start) : it.window[0];
      if (ps < it.window[0] - 720) ps += 1440;
      const win = [Math.min(ps, it.window[0]), it.window[1]];
      const got = take((s) => s.jobCodeId === p.jobCodeId && !s.eventId && inRooms(s, rooms), p.count, win);
      lines.push({ jobCodeId: p.jobCodeId, need: p.count, ...got, gap: Math.max(0, p.count - got.have), start: p.start || it.partStart || it.start, room: rooms.length === 1 ? rooms[0] : '' });
    }
    if (lines.length) out.push({ key: `item:${it.id}`, kind: 'item', id: it.id, name: it.name, color: it.color, room: (it.roomsLeft || it.rooms).join(' & '), all: !it.rooms.length,
      start: it.partStart || it.start, end: it.partEnd || it.end, lines });
  }
  return out;
}

// ---------- the API ----------

/**
 * programming.* RPCs. deps: { store, settings, fail, needAuth, needMgr, isMgr, now, today, layouts, langOf, homeRoom(job) }.
 *   programming.list       the items (pars only with staffingPars), overlap warnings, rooms, seasons, recent changes
 *   programming.days.list  { start, end }: each day's programming, events, auto note, and (staffingPars) coverage
 *   programming.gaps.list  { start, end }: the understaffed days, rooms and positions (the publish check, the tools)
 *   programming.save       an item (programmingEdit)            programming.delete  { id }
 *   programming.override   { id | 'all', date, action: cancel | retime | repar | clear, start, end, pars, reason }
 *   programming.eventPars  { eventId, mode: 'regular' | 'copy' | '' } (managers and the events team)
 *   programming.fillGaps   { start, end, room?, dryRun? }: open shifts for the gaps, as drafts (managers with staffingPars)
 */
export function programmingApi({ store, settings, fail, needAuth, needMgr, isMgr, now, today, layouts, langOf, homeRoom }) {
  const canPars = (a) => !!a && roleAllows(a, settings()).staffingPars === true;
  const canEdit = (a) => !!a && roleAllows(a, settings()).programmingEdit === true;
  const needEdit = (a) => { needAuth(a); if (!canEdit(a)) fail(403, ROLE_OFF); };
  const needPars = (a) => { needAuth(a); if (!canPars(a)) fail(403, ROLE_OFF); };
  const jobs = () => Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  /** The rooms programming can use: the schedule's rooms (Rooms & positions), then the event rooms in Settings (no buyouts). */
  const roomNames = () => {
    const out = (layouts.current().rooms || []).map((r) => r.room).filter(Boolean);
    for (const r of settings().rooms || []) if (!/buy-?out/i.test(r) && !out.some((x) => sameArea(x, r))) out.push(cleanArea(r));
    return out;
  };
  const items = () => store.list(PROG_COL).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const audit = (actor, action, targetId, details) => store.insert('auditLog', { id: uid('aud'), at: now().toISOString(), actorId: actor.id, targetId, action, details });
  const range62 = (start, end) => {
    if (!DATE.test(String(start || '')) || !DATE.test(String(end || ''))) fail(400, 'Pick a date');
    const n = daysBetween(start, end) + 1;
    if (n < 1 || n > MAX_DAYS) fail(400, 'Pick up to 62 days');
    return range(start, n);
  };
  const strip = (it, pars) => {
    const { exceptions, ...rest } = it;
    const ex = Object.fromEntries(Object.entries(exceptions || {}).map(([d, e]) => [d, pars ? e : (({ pars: _p, ...x }) => x)(e)]));
    return pars ? { ...rest, exceptions: ex } : { ...(({ pars: _p, ...x }) => x)(rest), exceptions: ex };
  };
  const eventsBetween = (start, end) => store.list('events', (e) => e.date >= start && e.date <= end);

  /** Each day's programming, and with pars its coverage. */
  function days(actor, start, end, as = null) {
    const st = settings();
    const lang = as === 'en' || as === 'es' ? as : langOf(actor); // the PDF can be printed in another language
    const all = items();
    const rooms = roomNames();
    const evs = eventsBetween(start, end);
    const pars = canPars(actor);
    const allowsEvents = roleAllows(actor, st).events !== false;
    const js = jobs();
    const layoutRooms = layouts.current().rooms || [];
    const shifts = pars ? store.list('shifts', (s) => s.date >= start && s.date <= end) : [];
    const manual = Object.fromEntries(store.list('notes', (n) => n.kind === 'day' && n.date >= start && n.date <= end && n.text).map((n) => [n.date, n.text]));
    return range62(start, end).map((date) => {
      const d = dayProgramming({ date, items: all, events: evs, settings: st, roomNames: rooms, lang, today: today() });
      const coverage = pars ? dayCoverage({ day: d, shifts: shifts.filter((s) => s.date === date), jobs: js, settings: st, layoutRooms }) : null;
      const view = {
        date, closed: d.closed, autoNote: d.note, manualNote: manual[date] || '', note: manual[date] || d.note,
        items: d.items.map(({ window: _w, pars: p, exception, ...x }) => ({ ...x, ...(pars ? { pars: p } : {}),
          exception: exception ? (pars ? exception : (({ pars: _p, ...e }) => e)(exception)) : null,
          replacedBy: allowsEvents ? x.replacedBy : x.replacedBy.map(() => ({ id: null, name: '' })) })),
        events: allowsEvents ? d.events.map(({ window: _w, staffing, ...e }) => ({ ...e, hasStaffing: staffing.length > 0, needsPars: pars && !staffing.length && !e.programmingPars && d.items.some((x) => x.replacedBy.some((r) => r.id === e.id) && x.pars.length) })) : [],
      };
      if (coverage) {
        view.coverage = coverage;
        view.short = coverage.reduce((t, c) => t + c.lines.reduce((u, l) => u + l.gap, 0), 0);
      }
      return view;
    });
  }

  return {
    'programming.list': (actor) => {
      needAuth(actor);
      const st = settings();
      const pars = canPars(actor);
      const all = items();
      const edit = canEdit(actor);
      const log = edit ? store.list('auditLog', (x) => String(x.action || '').startsWith('programming.')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
        .map((x) => ({ at: x.at, action: x.action, by: store.get('users', x.actorId)?.name || '', targetId: x.targetId, details: x.details || {} })) : [];
      return {
        items: all.map((it) => strip(it, pars)), rooms: roomNames(), warnings: overlapWarnings(all, st),
        seasons: seasonsOf(st).map((s) => ({ key: s.key, label: s.label || '' })), closedDays: st.closedDays || [],
        canEdit: edit, canPars: pars, colors: COLORS, log,
      };
    },
    'programming.days.list': (actor, { start, end, lang = null } = {}) => {
      needAuth(actor);
      return { canPars: canPars(actor), canEdit: canEdit(actor), rooms: roomNames(), days: days(actor, start, end, lang) };
    },
    'programming.gaps.list': (actor, { start, end } = {}) => {
      needPars(actor);
      const out = days(actor, start, end).filter((d) => d.short > 0).map((d) => ({
        date: d.date, short: d.short,
        rooms: d.coverage.filter((c) => c.lines.some((l) => l.gap)).map((c) => ({ kind: c.kind, id: c.id, name: c.name, room: c.room, all: c.all, start: c.start,
          lines: c.lines.filter((l) => l.gap).map(({ jobCodeId, need, have, open, gap, start: s }) => ({ jobCodeId, need, have, open, gap, start: s })) })),
      }));
      return { start, end, short: out.reduce((t, d) => t + d.short, 0), days: out };
    },
    'programming.save': (actor, a = {}) => {
      needEdit(actor);
      const st = settings();
      const js = jobs();
      const doc = cleanItem(a, { rooms: roomNames(), jobExists: (id) => !!js[id] && !js[id].archived, settings: st, fail });
      const at = now().toISOString();
      let saved;
      if (a.id) {
        const cur = store.get(PROG_COL, String(a.id));
        if (!cur) fail(404, 'Programming not found');
        // Pars change only when sent by someone who sees them; otherwise they stay as they were.
        if (!Array.isArray(a.pars) || !canPars(actor)) doc.pars = cur.pars || [];
        saved = store.update(PROG_COL, cur.id, { ...doc, updatedAt: at, updatedBy: actor.id });
      } else {
        if (!canPars(actor)) doc.pars = [];
        if (store.list(PROG_COL).length >= MAX_ITEMS) fail(400, 'Up to 100 programming items');
        saved = store.insert(PROG_COL, { id: uid('prg'), ...doc, exceptions: {}, order: store.list(PROG_COL).length, createdAt: at, createdBy: actor.id, updatedAt: at, updatedBy: actor.id });
      }
      audit(actor, AUDIT.saved, saved.id, { name: saved.name, created: !a.id });
      return { item: saved, warnings: overlapWarnings(items(), st).filter((w) => w.a === saved.id || w.b === saved.id) };
    },
    'programming.delete': (actor, { id } = {}) => {
      needEdit(actor);
      const cur = store.get(PROG_COL, String(id || ''));
      if (!cur) fail(404, 'Programming not found');
      store.remove(PROG_COL, cur.id);
      audit(actor, AUDIT.deleted, cur.id, { name: cur.name });
      return { ok: true };
    },
    // A one-off change on one date: cancel it, change its times or its pars, or clear the change (back to normal).
    // id 'all': every item that runs that day (closed for a private event, holiday hours).
    'programming.override': (actor, { id, date, action, start, end, pars, reason } = {}) => {
      needEdit(actor);
      if (!DATE.test(String(date || ''))) fail(400, 'Pick a date');
      if (!['cancel', 'retime', 'repar', 'clear'].includes(action)) fail(400, 'Pick what changes');
      const st = settings();
      const targets = id === 'all' ? items().filter((x) => occursOn(x, date, st) || x.exceptions?.[date]) : [store.get(PROG_COL, String(id || ''))];
      if (!targets.length || !targets[0]) fail(404, 'Programming not found');
      const js = jobs();
      const why = text(reason, 120);
      const at = now().toISOString();
      const out = [];
      for (const it of targets) {
        const ex = { ...(it.exceptions || {}) };
        const before = ex[date] || null;
        if (action === 'clear') delete ex[date];
        else {
          const next = { ...(before || {}), reason: why || before?.reason || '', at, by: actor.id };
          if (action === 'cancel') next.cancel = true;
          if (action === 'retime') {
            if (!TIME.test(String(start || ''))) fail(400, 'Pick a time like 17:00');
            if (end && !TIME.test(String(end))) fail(400, 'Pick a time like 17:00');
            delete next.cancel;
            next.start = String(start); next.end = end ? String(end) : '';
          }
          if (action === 'repar') {
            delete next.cancel;
            next.pars = cleanPars(pars, { jobExists: (x) => !!js[x], roomOf: (r) => { const hit = roomNames().find((x) => sameArea(x, r)); if (!hit) fail(400, 'Pick one of the venue’s rooms'); return hit; }, fail });
          }
          ex[date] = next;
        }
        store.update(PROG_COL, it.id, { exceptions: ex });
        audit(actor, action === 'clear' ? AUDIT.cleared : AUDIT.override, it.id, { name: it.name, date, action, reason: why, before, after: ex[date] || null });
        out.push({ id: it.id, name: it.name, exception: ex[date] || null });
      }
      return { date, items: out };
    },
    // An event with no staffing of its own: count the regular pars of what it replaces ('regular'), copy them into the
    // event's staffing lines ('copy', which staffed x/y then counts), or ask again ('').
    'programming.eventPars': (actor, { eventId, mode } = {}) => {
      needAuth(actor);
      if (!canManageEvents(actor)) fail(403, 'Events team or managers only');
      const e = store.get('events', String(eventId || ''));
      if (!e) fail(404, 'Event not found');
      if (!['regular', 'copy', ''].includes(mode ?? '')) fail(400, 'Pick what changes');
      const st = settings();
      const d = dayProgramming({ date: e.date, items: items(), events: [e], settings: st, roomNames: roomNames(), today: today() });
      const replaced = d.items.filter((x) => x.replacedBy.some((r) => r.id === e.id));
      let patch;
      if (mode === 'copy') {
        if ((e.staffing || []).length) fail(400, 'This event already has its own staffing');
        const lines = [];
        for (const it of replaced) for (const p of it.pars) {
          if (!p.count) continue;
          const same = lines.find((l) => l.jobCodeId === p.jobCodeId);
          if (same) same.count += p.count;
          else lines.push({ id: uid('stf'), jobCodeId: p.jobCodeId, count: p.count, start: p.start || e.start || it.start, end: e.end || '', notes: '' });
        }
        patch = { staffing: lines, programmingPars: '' };
      } else patch = { programmingPars: mode || '' };
      const saved = store.update('events', e.id, { ...patch, updatedAt: now().toISOString(), updatedBy: actor.id });
      audit(actor, AUDIT.eventPars, e.id, { name: e.name, date: e.date, mode: mode || '', replaced: replaced.map((x) => x.id) });
      return { id: saved.id, programmingPars: saved.programmingPars || '', staffing: saved.staffing || [] };
    },
    // Open shifts for what's still missing (par − assigned − open), at each par's start time, as drafts. Never published.
    'programming.fillGaps': (actor, { start, end, room = '', dryRun = false } = {}) => {
      needMgr(actor);
      needPars(actor);
      const js = jobs();
      const list = days(actor, start, end);
      const make = [];
      for (const d of list) {
        for (const c of d.coverage || []) {
          if (room && !(c.all || String(c.room).split(' & ').some((r) => sameArea(r, room)))) continue;
          for (const l of c.lines) {
            const missing = l.need - l.have - l.open;
            for (let i = 0; i < missing; i++) {
              make.push({ date: d.date, start: l.start || c.start, end: c.end || null, jobCodeId: l.jobCodeId, userId: null,
                area: cleanArea(l.room || (c.room && !c.room.includes(' & ') ? c.room : '') || homeRoom(js[l.jobCodeId]) || ''), tag: '', notes: c.name, breakMin: 0,
                eventId: c.kind === 'event' ? c.id : null, staffingLineId: l.staffingLineId || null, programmingId: c.kind === 'item' ? c.id : null });
            }
          }
        }
      }
      if (dryRun) return { created: 0, wouldCreate: make.length, shifts: make };
      const at = now().toISOString();
      const created = make.map((s) => store.insert('shifts', { id: uid('shf'), ...s, published: false, createdAt: at, createdBy: actor.id }));
      if (created.length) audit(actor, AUDIT.fillGaps, null, { start, end, room: room || '', created: created.length });
      return { created: created.length, shifts: created };
    },
  };
}
