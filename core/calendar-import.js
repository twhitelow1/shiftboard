// "Import from a calendar page": a venue's public events calendar (read by server/calendar/web-calendar.js) turned into
// suggestions a manager reviews before anything is saved.
//
//   Recurring programming  the same show on the same weekday at about the same time on several weeks ("Quiz",
//                          Mondays 18:30–20:30), an iCal RRULE or a JSON-LD EventSeries; and a "slot": events of
//                          one category at the same time each week with a different act each time (a DJ on Fridays
//                          and Saturdays 23:00–02:00). Each: name, room, days, start/end, Start date = the first
//                          matched date, End date blank unless the calendar shows the series ending, how many dates
//                          matched. Pars are never invented: empty, unless a programming item with the same name
//                          already has pars (copied).
//   One-off events         everything else, as dated events (status confirmed, so in their room they replace the
//                          regular programming like any event). Events rather than one-date programming exceptions:
//                          an exception can only cancel or retime something that already runs, while a one-off show
//                          is a new thing with its own name, room and time, which is exactly an event.
//   Rooms                  matched to the venue's rooms (the schedule's rooms and Settings' event rooms) by name in
//                          the calendar's venue text, then the title, then the description ("Tango in Moon Rabbit",
//                          "… upstairs in the Moon Rabbit lounge"), then aliases the restaurant taught it (a room picked for
//                          a venue text is remembered). Unmatched: the manager picks one; nothing recurring is saved
//                          without a room (or "Whole venue").
//   Duplicates             a recurring suggestion with the name of a programming item, or the same room, a shared
//                          day and a start within an hour; a one-off with the date and name of an event, or already
//                          imported from this calendar (event.calendarKey). Duplicates start unticked.
//
// Collections: calendarImports (one per read, the reader's events; each person's own, a week at most) and
// calendarSources ('main': the remembered page { url, checkedAt, aliases }). RPCs (new only; programmingEdit):
//   programming.calendar.get    { id? } → the remembered page and the person's latest (or that) read, as suggestions
//   programming.calendar.apply  { id, selections?, dryRun? } → saves the ticked ones (programming through
//                               programming.save; events as confirmed events, no per-event notification); one audit entry (programming.calendarImport, with via) besides theirs
//   programming.calendar.forget → forgets the remembered page
import { uid } from './store.js';
import { addDays, dow, toMin, daysBetween } from './time.js';
import { cleanArea, sameArea } from './areas.js';
import { roleAllows, ROLE_OFF } from './role-features.js';
import { canManageEvents } from './roles.js';
import { COLORS, PROG_COL } from './programming.js';

export const IMPORTS = 'calendarImports';
export const SOURCES = 'calendarSources';
export const AUDIT_ACTION = 'programming.calendarImport';
const KEEP_DAYS = 7;
const KEEP_PER_PERSON = 5;
const MAX_ALIASES = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const roomWords = (r) => norm(r).replace(/^the /, '');

/** "Hip Hop Nights feat. Someone" → "Hip Hop Nights"; "Show Night 2" → "Show Night". */
export function cleanTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
    .replace(/\s+(?:feat\.?|ft\.?|featuring|w\/)\s+.*$/i, '')
    .replace(/\s+with\s+(?=[A-Z0-9]).*$/, '')
    .replace(/\s*[-–—|:,]\s*$/, '')
    .replace(/\s+#?\d{1,2}$/, '')
    .trim();
  return s || String(t || '').trim();
}

/** The venue room a text names (or an alias for one), with where in the text: { room, at } or null. */
export function roomIn(text, rooms, aliases = {}) {
  const t = ` ${norm(text)} `;
  if (!t.trim()) return null;
  let best = null;
  const consider = (phrase, room) => {
    const p = norm(phrase).replace(/^the /, '');
    if (!p || p.length < 3) return;
    const at = t.indexOf(` ${p} `);
    if (at >= 0 && (!best || at < best.at || (at === best.at && p.length > best.len))) best = { room, at, len: p.length };
  };
  for (const r of rooms) consider(r, r);
  for (const [alias, r] of Object.entries(aliases || {})) { const hit = rooms.find((x) => sameArea(x, r)); if (hit) consider(alias, hit); }
  return best ? { room: best.room, at: best.at } : null;
}

/** An event's room: from its venue text, its title or its description. → { room, from, text } */
export function roomOfEvent(e, rooms, aliases = {}) {
  for (const [from, text] of [['venue', e.room], ['title', e.title], ['description', e.description]]) {
    const hit = roomIn(text, rooms, aliases);
    if (hit) return { room: hit.room, from, text: e.room || '' };
  }
  const exact = aliases[norm(e.room)] && rooms.find((x) => sameArea(x, aliases[norm(e.room)]));
  if (exact) return { room: exact, from: 'alias', text: e.room };
  return { room: '', from: '', text: e.room || '' };
}

/** "Quiz Night in The Rabbit Hole" → "Quiz Night" when the room came from the title. */
function withoutRoom(name, room) {
  if (!room) return name;
  const words = roomWords(room).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+');
  const out = name.replace(new RegExp(`\\s+(?:in|at|en)\\s+(?:the\\s+)?${words}\\b.*$`, 'i'), '').trim();
  return out.length >= 3 ? out : name;
}

const mode = (list) => {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
};
const mins = (t) => (TIME.test(String(t || '')) ? toMin(t) : null);
const near = (a, b, within) => a != null && b != null && Math.abs(a - b) <= within;

/** Group a list of dates (one weekday) into a repeat: weekly, every other week, or the nth weekday of the month. */
function repeatOf(byDay) {
  const lists = Object.values(byDay).map((ds) => [...ds].sort());
  const gaps = lists.map((ds) => ds.slice(1).map((d, i) => daysBetween(ds[i], d)));
  if (lists.every((ds, i) => ds.length >= 3 && gaps[i].every((g) => g === 14))) return { repeat: 'biweekly', anchor: lists.flat().sort()[0] };
  const nthOf = (d) => Math.ceil(Number(d.slice(8)) / 7);
  if (lists.every((ds, i) => ds.length >= 2 && gaps[i].every((g) => g === 28 || g === 35) && ds.every((d) => nthOf(d) === nthOf(ds[0]))) && lists.every((ds) => nthOf(ds[0]) === nthOf(lists[0][0]))) {
    return { repeat: 'monthly', nth: Math.min(4, nthOf(lists[0][0])) };
  }
  return { repeat: 'weekly' };
}

/**
 * Events → suggestions.
 * @param events  the reader's events
 * @param o       { rooms (venue room names), items (programming), existingEvents, aliases, windowTo: 'YYYY-MM-DD' }
 * @returns { recurring: [...], oneOffs: [...], unmatched: [venue texts with no room] }
 */
export function planFromEvents(events, { rooms = [], items = [], existingEvents = [], aliases = {}, windowTo = '' } = {}) {
  const list = (events || []).filter((e) => e && (DATE.test(e.date) || e.recurrence)).map((e, i) => ({ ...e, i, ...(() => { const r = roomOfEvent(e, rooms, aliases); return { matched: r.room, roomFrom: r.from }; })() }));
  const used = new Set();
  const recurring = [];
  const lastDate = list.reduce((m, e) => (e.date > m ? e.date : m), '');
  const endOf = (dates, until = '', step = 7) => {
    if (until) return until;
    const last = [...dates].sort().at(-1);
    // The calendar goes on (other events later) but this one doesn't come back when it should: it ends there.
    const due = last ? addDays(last, step) : '';
    return last && windowTo && daysBetween(due, windowTo) >= 7 && lastDate > due ? last : '';
  };
  const roomFor = (group) => {
    const matched = group.map((e) => e.matched).filter(Boolean);
    const room = mode(matched) || '';
    const from = room ? mode(group.filter((e) => e.matched === room).map((e) => e.roomFrom)) : '';
    const text = mode(group.map((e) => e.room).filter(Boolean)) || '';
    return { room, roomFrom: from, roomText: text };
  };
  const push = (kind, group, { name, days, start, end, until = '', rep = null, acts = [] }) => {
    const dates = [...new Set(group.map((e) => e.date).filter(Boolean))].sort();
    group.forEach((e) => used.add(e.i));
    const r = roomFor(group);
    const display = r.roomFrom === 'title' ? withoutRoom(name, r.room) : name;
    const how = rep || repeatOf(Object.fromEntries([...new Set(days)].map((d) => [d, dates.filter((x) => dow(x) === d)])));
    recurring.push({
      key: `r${recurring.length + 1}:${norm(display).slice(0, 40)}`, kind, name: display.slice(0, 60), ...r,
      days: [...new Set(days)].sort(), start, end, from: dates[0] || group[0]?.recurrence?.first || '',
      to: endOf(dates, until, how.repeat === 'biweekly' ? 14 : how.repeat === 'monthly' ? 35 : 7),
      ...how,
      dates, count: dates.length, ...(acts.length ? { acts: acts.slice(0, 8) } : {}),
      url: mode(group.map((e) => e.url).filter(Boolean)) || '',
    });
  };

  // 1. A calendar's own series (iCal RRULE, JSON-LD EventSeries).
  const series = new Map();
  for (const e of list) if (e.recurrence) { const k = e.uid || `${norm(e.title)}|${e.start}`; series.set(k, [...(series.get(k) || []), e]); }
  for (const group of series.values()) {
    const rec = group[0].recurrence;
    const e = group[0];
    push('series', group, { name: cleanTitle(e.title), days: rec.days, start: e.start, end: e.end, until: rec.until || '',
      rep: rec.interval === 2 ? { repeat: 'biweekly', anchor: rec.first || group.map((x) => x.date).sort()[0] } : { repeat: 'weekly' } });
  }

  // 2. The same title, at about the same time, on a weekday it comes back to.
  const byTitle = new Map();
  for (const e of list) {
    if (used.has(e.i) || !e.date) continue;
    const k = norm(cleanTitle(e.title));
    if (k) byTitle.set(k, [...(byTitle.get(k) || []), e]);
  }
  for (const group of byTitle.values()) {
    const clusters = [];
    for (const e of [...group].sort((a, b) => (mins(a.start) ?? -1) - (mins(b.start) ?? -1))) {
      const c = clusters.find((x) => (x.at == null && mins(e.start) == null) || near(x.at, mins(e.start), 45));
      if (c) c.list.push(e); else clusters.push({ at: mins(e.start), list: [e] });
    }
    for (const c of clusters) {
      const byDay = {};
      for (const e of c.list) (byDay[dow(e.date)] ||= new Set()).add(e.date);
      const days = Object.keys(byDay).map(Number).filter((d) => byDay[d].size >= 2);
      const hit = c.list.filter((e) => days.includes(dow(e.date)));
      const monthly = days.length && repeatOf(Object.fromEntries(days.map((d) => [d, [...byDay[d]]]))).repeat === 'monthly';
      if (!days.length || (new Set(hit.map((e) => e.date)).size < 3 && !monthly)) continue;
      push('title', hit, { name: cleanTitle(mode(hit.map((e) => e.title))), days, start: mode(hit.map((e) => e.start)) || '', end: mode(hit.map((e) => e.end)) || '' });
    }
  }

  // 3. A slot: one category at the same time each week, a different act each time.
  const slots = new Map();
  for (const e of list) {
    if (used.has(e.i) || !e.date || !e.start || !e.categories?.length) continue;
    const k = `${norm(e.categories[0])}|${e.start}|${e.end}`;
    slots.set(k, [...(slots.get(k) || []), e]);
  }
  for (const group of slots.values()) {
    const byDay = {};
    for (const e of group) (byDay[dow(e.date)] ||= new Set()).add(e.date);
    const days = Object.keys(byDay).map(Number).filter((d) => byDay[d].size >= 3);
    if (!days.length) continue;
    const hit = group.filter((e) => days.includes(dow(e.date)));
    push('slot', hit, { name: group[0].categories[0], days, start: group[0].start, end: group[0].end, acts: [...new Set(hit.map((e) => cleanTitle(e.title)))] });
  }

  // 4. Everything else: one-off events.
  const oneOffs = list.filter((e) => !used.has(e.i) && e.date).map((e, n) => ({
    key: `o${n + 1}:${eventKey(e)}`.slice(0, 120), eventKey: eventKey(e), name: String(e.title || '').slice(0, 80),
    date: e.date, start: e.start || '', end: e.end || '', room: e.matched, roomFrom: e.roomFrom, roomText: e.room || '', url: e.url || '', description: e.description || '',
  }));

  // Duplicates and what's already there.
  const live = items.filter((x) => x.active !== false);
  for (const r of recurring) {
    const byName = live.find((x) => norm(x.name) === norm(r.name) || (norm(r.name).length >= 4 && norm(x.name).length >= 4 && (norm(x.name).includes(norm(r.name)) || norm(r.name).includes(norm(x.name)))));
    const byTime = !byName && r.room && live.find((x) => (x.days || []).some((d) => r.days.includes(d)) && (!x.rooms?.length || x.rooms.some((q) => sameArea(q, r.room))) && near(mins(x.start), mins(r.start), 60));
    const dup = byName || byTime;
    r.duplicateOf = dup ? { id: dup.id, name: dup.name, why: byName ? 'name' : 'time' } : null;
    const same = items.find((x) => norm(x.name) === norm(r.name) && (x.pars || []).length);
    r.pars = same ? same.pars.map((p) => ({ ...p })) : [];
    if (same) r.parsFrom = same.name;
    r.include = !r.duplicateOf;
  }
  for (const o of oneOffs) {
    const ev = existingEvents.find((x) => x.calendarKey && x.calendarKey === o.eventKey)
      || existingEvents.find((x) => x.date === o.date && (norm(x.name) === norm(o.name) || (norm(o.name).length >= 4 && (norm(x.name).includes(norm(cleanTitle(o.name))) || norm(o.name).includes(norm(x.name))))));
    const prog = !ev && live.find((x) => norm(x.name) === norm(cleanTitle(o.name)));
    o.duplicateOf = ev ? { id: ev.id, name: ev.name, kind: 'event', why: ev.calendarKey === o.eventKey ? 'imported' : 'name' } : prog ? { id: prog.id, name: prog.name, kind: 'programming', why: 'name' } : null;
    o.include = !o.duplicateOf;
  }
  const unmatched = [...new Set([...recurring, ...oneOffs].filter((x) => !x.room).map((x) => x.roomText || ''))];
  return { recurring, oneOffs, unmatched };
}

/** A stable key for one dated event of a calendar (re-reads find what was imported). */
export const eventKey = (e) => `${e.uid || norm(e.title).slice(0, 60)}|${e.date}`;

/** Is the person allowed (Roles & features → Edit programming)? */
export const canImportCalendar = (user, settings) => !!user && roleAllows(user, settings || {}).programmingEdit === true;

/** Keep what the reader read, for this person (inside a write). Returns the import's id. */
export function keepCalendarRead(store, actor, { read, remember = false, at }) {
  const cutoff = new Date(Date.parse(at) - KEEP_DAYS * 86_400_000).toISOString();
  const mine = store.list(IMPORTS, (x) => x.userId === actor.id).sort((a, b) => b.at.localeCompare(a.at));
  mine.forEach((x, i) => { if (i >= KEEP_PER_PERSON - 1 || x.at < cutoff) store.remove(IMPORTS, x.id); });
  const doc = store.insert(IMPORTS, { id: uid('cal'), userId: actor.id, at, url: read.url, source: read.source, from: read.from, to: read.to, events: read.events, notes: read.notes || [] });
  if (remember) {
    const cur = store.get(SOURCES, 'main');
    const patch = { url: read.url, checkedAt: at, checkedBy: actor.id };
    if (cur) store.update(SOURCES, 'main', patch); else store.insert(SOURCES, { id: 'main', ...patch, aliases: {} });
  } else {
    const cur = store.get(SOURCES, 'main');
    if (cur?.url === read.url) store.update(SOURCES, 'main', { checkedAt: at, checkedBy: actor.id });
  }
  return doc.id;
}

const WORDS = {
  en: { line: (i, e) => `${i} programming item${i === 1 ? '' : 's'} and ${e} event${e === 1 ? '' : 's'}`, pickRoom: (n) => `Pick a room for “${n}”`, nothing: 'Tick at least one to import' },
  es: { line: (i, e) => `${i} programación${i === 1 ? '' : 'es'} y ${e} evento${e === 1 ? '' : 's'}`, pickRoom: (n) => `Elige un salón para “${n}”`, nothing: 'Marca al menos uno para importar' },
};

/**
 * The RPCs. d: { store, settings(), fail, needAuth, now, layouts, api (to call programming.save / events.save), langOf, logVia }.
 */
export function calendarImportApi({ store, settings, fail, needAuth, now, layouts, api, langOf, logVia }) {
  const needEdit = (a) => { needAuth(a); if (!canImportCalendar(a, settings())) fail(403, ROLE_OFF); };
  const W = (a) => WORDS[langOf(a) === 'es' ? 'es' : 'en'];
  const roomNames = () => {
    const out = (layouts.current().rooms || []).map((r) => r.room).filter(Boolean);
    for (const r of settings().rooms || []) if (!/buy-?out/i.test(r) && !out.some((x) => sameArea(x, r))) out.push(cleanArea(r));
    return out;
  };
  const source = () => { const s = store.get(SOURCES, 'main'); return s?.url ? { url: s.url, checkedAt: s.checkedAt || null } : null; };
  const importOf = (actor, id) => {
    const imp = id ? store.get(IMPORTS, String(id)) : store.list(IMPORTS, (x) => x.userId === actor.id).sort((a, b) => b.at.localeCompare(a.at))[0];
    return imp && imp.userId === actor.id ? imp : null;
  };
  const planOf = (imp) => planFromEvents(imp.events, {
    rooms: roomNames(), items: store.list(PROG_COL), aliases: store.get(SOURCES, 'main')?.aliases || {},
    existingEvents: store.list('events', (e) => e.date >= imp.from && e.date <= addDays(imp.to, 1)), windowTo: imp.to,
  });
  const view = (imp) => {
    const p = planOf(imp);
    return { id: imp.id, url: imp.url, source: imp.source, from: imp.from, to: imp.to, at: imp.at, events: imp.events.length, notes: imp.notes || [],
      recurring: p.recurring, oneOffs: p.oneOffs, unmatched: p.unmatched, rooms: roomNames() };
  };

  /** The plan with the manager's choices on top: { key: { include, name, room, from, to, start, end, days } }. */
  function chosen(actor, imp, selections = {}) {
    const p = planOf(imp);
    const rs = selections.recurring || {};
    const os = selections.oneOffs || {};
    const rooms = roomNames();
    const pickRoom = (v, fallback) => {
      if (v === undefined) return fallback;
      if (v === '*' || v === '') return v;
      const hit = rooms.find((r) => sameArea(r, v));
      if (!hit) fail(400, 'Pick one of the venue’s rooms');
      return hit;
    };
    const items = p.recurring.map((r) => {
      const s = rs[r.key] || {};
      const x = { ...r, include: s.include ?? r.include, room: pickRoom(s.room, r.room) };
      if (typeof s.name === 'string' && s.name.trim()) x.name = s.name.trim().slice(0, 60);
      for (const k of ['from', 'to']) if (typeof s[k] === 'string' && (s[k] === '' || DATE.test(s[k]))) x[k] = s[k];
      for (const k of ['start', 'end']) if (typeof s[k] === 'string' && (TIME.test(s[k]) || (k === 'end' && s[k] === ''))) x[k] = s[k];
      if (Array.isArray(s.days) && s.days.length) x.days = [...new Set(s.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      return x;
    }).filter((x) => x.include);
    const events = p.oneOffs.map((o) => { const s = os[o.key] || {}; return { ...o, include: s.include ?? o.include, room: pickRoom(s.room, o.room) }; }).filter((x) => x.include);
    for (const x of items) if (!x.room) fail(400, W(actor).pickRoom(x.name));
    if (!items.length && !events.length) fail(400, W(actor).nothing);
    return { items, events };
  }

  return {
    'programming.calendar.get': (actor, { id } = {}) => {
      needEdit(actor);
      const imp = importOf(actor, id);
      if (id && !imp) fail(404, 'Not found');
      return { source: source(), rooms: roomNames(), import: imp ? view(imp) : null };
    },
    'programming.calendar.forget': (actor) => {
      needEdit(actor);
      if (store.get(SOURCES, 'main')) store.update(SOURCES, 'main', { url: '', checkedAt: null });
      return { source: null };
    },
    'programming.calendar.apply': (actor, { id, selections = {}, dryRun = false } = {}) => {
      needEdit(actor);
      const imp = importOf(actor, id);
      if (!imp) fail(404, 'That calendar read is gone. Read the page again.');
      const { items, events } = chosen(actor, imp, selections);
      const line = W(actor).line(items.length, events.length);
      if (dryRun) {
        return { dryRun: true, line, items: items.map(({ key, name, room, days, start, end, from, to, repeat }) => ({ key, name, room, days, start, end, from, to, repeat })),
          events: events.map(({ key, name, date, start, end, room }) => ({ key, name, date, start, end, room })) };
      }
      const at = now().toISOString();
      const created = { items: [], events: [] };
      const used = store.list(PROG_COL).length;
      items.forEach((x, n) => {
        const r = api['programming.save'](actor, {
          name: x.name, rooms: x.room === '*' ? [] : [x.room], days: x.days, start: x.start, end: x.end || '', from: x.from || '', to: x.to || '',
          repeat: x.repeat, ...(x.repeat === 'monthly' ? { nth: x.nth } : {}), ...(x.repeat === 'biweekly' ? { anchor: x.anchor || x.from } : {}),
          color: COLORS[(used + n) % COLORS.length], notes: [x.acts?.length ? x.acts.join(', ') : '', x.url || imp.url].filter(Boolean).join('\n').slice(0, 500),
          pars: x.pars || [],
        });
        created.items.push(r.item.id);
      });
      if (events.length && !canManageEvents(actor)) fail(403, 'Events team or managers only');
      for (const e of events) {
        // Like events.save, without a "new event" notification per event (one import, one audit entry below).
        const ev = store.insert('events', {
          id: uid('evt'), name: e.name, date: e.date, start: e.start || '', end: e.end || '', room: e.room === '*' ? 'Full buyout' : e.room || '',
          guestCount: 0, type: 'Public event', status: 'confirmed', staffing: [], notes: [e.description, e.url].filter(Boolean).join('\n').slice(0, 1000),
          calendarKey: e.eventKey, calendarUrl: imp.url, source: 'calendar', createdAt: at, createdBy: actor.id, updatedAt: at, updatedBy: actor.id,
        });
        created.events.push(ev.id);
      }
      // A room picked for a venue text the calendar used is remembered for next time.
      const src = store.get(SOURCES, 'main');
      const aliases = { ...(src?.aliases || {}) };
      for (const x of [...items, ...events]) if (x.roomText && x.room && x.room !== '*' && !x.roomFrom && Object.keys(aliases).length < MAX_ALIASES) aliases[norm(x.roomText).slice(0, 80)] = x.room;
      if (src) store.update(SOURCES, 'main', { aliases }); else if (Object.keys(aliases).length) store.insert(SOURCES, { id: 'main', url: '', checkedAt: null, aliases });
      store.update(IMPORTS, imp.id, { appliedAt: at });
      store.insert('auditLog', { id: uid('aud'), at, actorId: actor.id, targetId: null, action: AUDIT_ACTION, via: logVia(),
        details: { url: imp.url, source: imp.source, items: created.items.length, events: created.events.length, via: logVia() } });
      return { line, items: created.items, events: created.events };
    },
  };
}
