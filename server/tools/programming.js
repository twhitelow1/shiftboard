// Regular programming and staffing pars (core/programming.js).
//   get_programming                what's on each day (programming by room, events, what replaced what, one-off changes),
//                                  and for people with staffing pars: scheduled vs par per room and position
//   set_programming                (programmingEdit) add or change a programming item: first call previews (overlap
//                                  warnings included), confirm: true saves
//   override_programming_for_date  (programmingEdit) a one-off change on one date: cancel, new times, new pars, or back
//                                  to normal. Previews first; confirm: true saves (logged in the audit log)
//   get_staffing_gaps              (staffingPars) the days, rooms and positions scheduled below par
import { z } from 'zod';
import { defineTool } from './registry.js';
import { lookupOf, findPosition, dateArg, confirmArg } from './helpers.js';
import { resolveDate, resolveRange } from './dates.js';
import { AppError } from '../../core/service.js';
import { roleAllows } from '../../core/role-features.js';
import { cleanItem, overlapWarnings } from '../../core/programming.js';
import { DOW_LONG } from '../../core/time.js';

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like 18:00');
const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const DAY_WORDS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 };
const dayIndex = (d) => {
  if (typeof d === 'number') return d;
  const k = norm(d).slice(0, 3);
  if (k in DAY_WORDS) return DAY_WORDS[k];
  throw new AppError(400, `Unknown weekday “${d}”`);
};
const canEdit = (user, info) => roleAllows(user, info.settings || {}).programmingEdit === true;
const canPars = (user, info) => roleAllows(user, info.settings || {}).staffingPars === true;

const PAR = z.object({ position: z.string().max(60), count: z.number().int().min(0).max(99), start: TIME.optional().describe('When this position comes in, e.g. 17:00'),
  room: z.string().max(60).optional().describe('Count it in another room (e.g. Host at the host stand)') });

/** One day for the tools: compact, with "Bartender 2/3" lines when coverage is there. */
function dayOut(d, look) {
  const pos = (id) => look.jobs[id]?.name || '';
  return {
    date: d.date, day: DOW_LONG[new Date(`${d.date}T00:00:00Z`).getUTCDay()], ...(d.closed ? { closed: true } : {}), dayNote: d.note || null,
    ...(d.manualNote ? { manualDayNote: d.manualNote } : {}),
    programming: d.items.map((x) => ({
      id: x.id, name: x.name, rooms: x.rooms.length ? x.rooms : 'whole venue', start: x.start, end: x.end || 'close', status: x.status,
      ...(x.partStart ? { runs: `${x.partStart}–${x.partEnd}` } : {}), ...(x.roomsLeft ? { stillIn: x.roomsLeft } : {}),
      ...(x.replacedBy.length ? { replacedBy: x.replacedBy.map((r) => r.name || 'an event') } : {}),
      ...(x.exception ? { oneOffChange: { ...(x.exception.cancel ? { cancelled: true } : {}), ...(x.exception.start ? { start: x.exception.start, end: x.exception.end || 'close' } : {}),
        ...(x.exception.pars ? { pars: x.exception.pars.map((p) => `${pos(p.jobCodeId)} ${p.count}`) } : {}), ...(x.exception.reason ? { reason: x.exception.reason } : {}) } } : {}),
      ...(x.pars ? { pars: x.pars.map((p) => `${pos(p.jobCodeId)} ${p.count}${p.start ? ` (in at ${p.start})` : ''}`) } : {}),
      ...(x.notes ? { notes: x.notes } : {}),
    })),
    events: d.events.map((e) => ({ id: e.id, name: e.name, start: e.start, end: e.end, rooms: e.all ? 'full buyout' : e.rooms, guests: e.guestCount, ...(e.needsPars ? { needsPars: true } : {}) })),
    ...(d.coverage ? {
      coverage: d.coverage.map((c) => ({ for: c.name, kind: c.kind, room: c.all ? 'whole venue' : c.room, lines: c.lines.map((l) => `${pos(l.jobCodeId)} ${l.have}/${l.need}${l.open ? ` (+${l.open} open)` : ''}`) })),
      short: d.short,
    } : {}),
  };
}

/** A programming item by id or name (from programming.list). */
function findItem(list, query) {
  const byId = list.items.find((x) => x.id === query);
  if (byId) return byId;
  const hits = list.items.filter((x) => norm(x.name) === norm(query));
  const some = hits.length ? hits : list.items.filter((x) => norm(x.name).includes(norm(query)));
  if (some.length === 1) return some[0];
  if (!some.length) throw new AppError(404, `No programming matches “${query}”. Programming: ${list.items.map((x) => x.name).join(', ') || 'none yet'}`);
  throw new AppError(400, `More than one programming item matches “${query}”: ${some.map((x) => x.name).join(', ')}`);
}

export default [
  defineTool({
    name: 'get_programming',
    title: 'Regular programming',
    description: 'What\'s on each day between two dates (default: the next 7 days): the regular programming by room (e.g. "Regular service", '
      + '"Immersive dinner", "DJ night") with its times, events and what they replaced ("Replaced by <event>"), one-off changes (cancelled, new hours, new pars), '
      + 'the schedule\'s day note, and for managers the staffing coverage: scheduled vs par per room and position ("Bartender 2/3").',
    input: { from: dateArg('First day').optional(), to: dateArg('Last day').optional() },
    consent: 'read',
    async handler(user, args, ctx) {
      const { from, to } = resolveRange(args, ctx.today(), { days: 7, max: 31 });
      const [look, r] = await Promise.all([lookupOf(ctx), ctx.read('programming.days.list', { start: from, end: to })]);
      const days = r.days.map((d) => dayOut(d, look));
      const short = r.canPars ? days.reduce((t, d) => t + (d.short || 0), 0) : null;
      return { summary: `Programming from ${from} to ${to}${short != null ? `; ${short} shift(s) short of par` : ''}.`, data: { from, to, days } };
    },
  }),
  defineTool({
    name: 'set_programming',
    title: 'Set regular programming',
    description: 'Managers: add a regular programming item, or change one (by id or its exact name; only the fields you pass change). '
      + 'An item: a name, the rooms it uses (or wholeVenue), weekdays, start and end times (no end = until close), optionally a season or a date range, '
      + 'every other week or the nth weekday of the month, a color, notes for staff, and staffing pars per position (e.g. Bartender 3, Barback 2 in at 17:00). '
      + 'First call WITHOUT confirm: nothing is saved; you get what would be saved and any overlap warnings (two items in one room at the same time). '
      + 'Tell the user, ask, and call again with confirm: true only after they say yes.',
    input: {
      id: z.string().max(80).optional().describe('The item to change (or give its name)'),
      name: z.string().min(1).max(60).optional(),
      rooms: z.array(z.string().max(60)).max(20).optional(), wholeVenue: z.boolean().optional(),
      days: z.array(z.union([z.string().max(12), z.number().int().min(0).max(6)])).max(7).optional().describe('Weekdays, e.g. ["wed", "sat"] (0 = Sunday)'),
      start: TIME.optional(), end: z.string().max(5).optional().describe('HH:MM, or "" for until close'),
      season: z.string().max(30).optional().describe('A season key from Settings → Seasons (e.g. "winter"), or "" for all year'),
      from: dateArg('First date it runs').optional(), to: dateArg('Last date it runs').optional(),
      repeat: z.enum(['weekly', 'biweekly', 'monthly']).optional(), nth: z.number().int().min(-1).max(4).optional().describe('monthly: 1–4, or -1 for the last'),
      anchor: dateArg('biweekly: a date it runs').optional(), color: z.string().max(7).optional(), notes: z.string().max(500).optional(),
      dayNote: z.string().max(80).optional().describe('What the schedule\'s day-notes row says (default: its name and start time)'),
      pars: z.array(PAR).max(30).optional().describe('Replaces the pars'), active: z.boolean().optional(),
      confirm: confirmArg,
    },
    write: true, preview: true, idempotent: false, can: canEdit, consent: 'programming',
    async handler(user, args, ctx) {
      const [look, list] = await Promise.all([lookupOf(ctx), ctx.read('programming.list')]);
      if (!list.canEdit) throw new AppError(403, 'Your role doesn’t include this');
      const cur = args.id ? findItem(list, args.id) : args.name ? list.items.find((x) => norm(x.name) === norm(args.name)) || null : null;
      if (!cur && (!args.name || !args.days || !args.start)) throw new AppError(400, 'A new programming item needs a name, days and a start time');
      const next = { ...(cur || {}) };
      for (const k of ['name', 'start', 'end', 'season', 'repeat', 'nth', 'color', 'notes', 'dayNote', 'active']) if (args[k] !== undefined) next[k] = args[k];
      if (args.wholeVenue) next.rooms = []; else if (args.rooms) next.rooms = args.rooms.map((r) => list.rooms.find((x) => norm(x) === norm(r)) || r);
      if (args.days) next.days = args.days.map(dayIndex);
      for (const k of ['from', 'to', 'anchor']) if (args[k] !== undefined) next[k] = args[k] ? resolveDate(args[k], ctx.today()) : '';
      if (args.pars) next.pars = args.pars.map((p) => ({ jobCodeId: findPosition(look, p.position).id, count: p.count, ...(p.start ? { start: p.start } : {}), ...(p.room ? { room: p.room } : {}) }));
      const fail = (status, message) => { throw new AppError(status, message); };
      const doc = cleanItem(next, { rooms: list.rooms, jobExists: (id) => !!look.jobs[id], settings: { ...look.settings, seasons: look.settings.seasons }, fail });
      const show = { ...doc, days: doc.days.map((d) => DOW_LONG[d]), rooms: doc.rooms.length ? doc.rooms : 'whole venue',
        pars: doc.pars.map((p) => `${look.jobs[p.jobCodeId]?.name} ${p.count}${p.start ? ` (in at ${p.start})` : ''}`) };
      const warnings = overlapWarnings([...list.items.filter((x) => x.id !== cur?.id), { ...doc, id: cur?.id || 'new' }], look.settings)
        .filter((w) => w.a === (cur?.id || 'new') || w.b === (cur?.id || 'new')).map((w) => `Overlaps ${w.a === (cur?.id || 'new') ? w.bName : w.aName}${w.room ? ` in ${w.room}` : ''} on ${w.days.map((d) => DOW_LONG[d]).join(', ')}`);
      if (args.confirm !== true) {
        return { summary: `Preview only, nothing saved: ${cur ? `change “${cur.name}”` : `add “${doc.name}”`}.${warnings.length ? ` Warning: ${warnings.join('; ')}.` : ''} Ask the user; call again with confirm: true to save.`,
          data: { item: show, warnings } };
      }
      const { pars: newPars, ...rest } = doc; // pars change only when given (an item's pars stay as they are otherwise)
      const r = await ctx.write('programming.save', { ...rest, ...(args.pars || !cur ? { pars: newPars } : {}), ...(cur ? { id: cur.id } : {}) });
      return { summary: `${cur ? 'Changed' : 'Added'} “${r.item.name}”.${warnings.length ? ` Warning: ${warnings.join('; ')}.` : ''}`, data: { id: r.item.id, item: show, warnings } };
    },
  }),
  defineTool({
    name: 'override_programming_for_date',
    title: 'Change programming for one date',
    description: 'Managers: a one-off change to the regular programming on one date, without an event: cancel it ("Cancel DJ this Friday"; programming "all" '
      + 'for "Closed for private event"), change its times ("Holiday hours"), change its pars for that day, or clear the change (back to the regular programming). '
      + 'It shows on the calendar and is logged. First call WITHOUT confirm only shows what would change; call again with confirm: true after the user says yes.',
    input: {
      programming: z.string().min(1).max(80).describe('The item\'s name or id, or "all" for everything that runs that day'),
      date: dateArg('The date'),
      action: z.enum(['cancel', 'retime', 'repar', 'clear']),
      start: TIME.optional(), end: z.string().max(5).optional().describe('retime: HH:MM, or "" for until close'),
      pars: z.array(PAR).max(30).optional().describe('repar: that day\'s pars'),
      reason: z.string().max(120).optional().describe('Shown with the change, e.g. "Closed for private event"'),
      confirm: confirmArg,
    },
    write: true, preview: true, idempotent: false, can: canEdit, consent: 'programming',
    async handler(user, args, ctx) {
      const date = resolveDate(args.date, ctx.today());
      const [look, list, day] = await Promise.all([lookupOf(ctx), ctx.read('programming.list'), ctx.read('programming.days.list', { start: date, end: date })]);
      if (!list.canEdit) throw new AppError(403, 'Your role doesn’t include this');
      const all = norm(args.programming) === 'all';
      const item = all ? null : findItem(list, args.programming);
      const on = day.days[0].items.filter((x) => all || x.id === item.id);
      if (all && !on.length) throw new AppError(404, `Nothing runs on ${date}`);
      if (args.action === 'retime' && !args.start) throw new AppError(400, 'Pick a time like 17:00');
      const pars = args.pars ? args.pars.map((p) => ({ jobCodeId: findPosition(look, p.position).id, count: p.count, ...(p.start ? { start: p.start } : {}), ...(p.room ? { room: p.room } : {}) })) : undefined;
      if (args.action === 'repar' && !pars) throw new AppError(400, 'Give the pars for that day');
      const what = { cancel: 'cancel', retime: `run ${args.start}–${args.end || 'close'}`, repar: 'use new pars', clear: 'go back to the regular programming' }[args.action];
      const names = all ? on.map((x) => x.name).join(', ') : item.name;
      if (args.confirm !== true) {
        return { summary: `Preview only, nothing saved: on ${date}, ${names} would ${what}${args.reason ? ` (“${args.reason}”)` : ''}. Ask the user; call again with confirm: true to do it.`,
          data: { date, programming: on.map((x) => ({ id: x.id, name: x.name, status: x.status, start: x.start, end: x.end || 'close' })), action: args.action } };
      }
      const r = await ctx.write('programming.override', { id: all ? 'all' : item.id, date, action: args.action, start: args.start, end: args.end, pars, reason: args.reason });
      return { summary: `On ${date}, ${r.items.map((x) => x.name).join(', ')}: ${args.action === 'clear' ? 'back to the regular programming' : what}.`, data: r };
    },
  }),
  defineTool({
    name: 'get_staffing_gaps',
    title: 'Staffing gaps',
    description: 'Managers: the days, rooms and positions scheduled below their staffing par between two dates (default: the next 7 days), '
      + 'from the regular programming and from events\' own staffing, e.g. "Sat, Moon Rabbit, Immersive dinner: Cocktail server 2/4". Open shifts are listed apart.',
    input: { from: dateArg('First day').optional(), to: dateArg('Last day').optional() },
    can: canPars, consent: 'read',
    async handler(user, args, ctx) {
      const { from, to } = resolveRange(args, ctx.today(), { days: 7, max: 62 });
      const [look, r] = await Promise.all([lookupOf(ctx), ctx.read('programming.gaps.list', { start: from, end: to })]);
      const days = r.days.map((d) => ({ date: d.date, short: d.short, gaps: d.rooms.map((c) => ({ for: c.name, kind: c.kind, room: c.all ? 'whole venue' : c.room,
        positions: c.lines.map((l) => `${look.jobs[l.jobCodeId]?.name || ''} ${l.have}/${l.need}${l.open ? ` (+${l.open} open)` : ''}`) })) }));
      return { summary: r.short ? `${r.short} shift(s) short of par from ${from} to ${to}, on ${days.length} day(s).` : `Every par is covered from ${from} to ${to}.`, data: { from, to, short: r.short, days } };
    },
  }),
];
