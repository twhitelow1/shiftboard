// Events and BEOs: the list, one BEO (client details only for managers and the events team: events.get leaves them
// out for everyone else), and for the events team, creating or updating a BEO and suggesting its staffing.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { lookupOf, findPerson, findPosition, dateArg } from './helpers.js';
import { resolveDate, resolveRange } from './dates.js';
import { canManageEvents } from '../../core/roles.js';
import { AppError } from '../../core/service.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like 18:00');
const eventsTeam = (user) => canManageEvents(user);

async function findEvent(ctx, { eventId, name }) {
  if (eventId) return eventId;
  const list = await ctx.read('events.list', { start: '2000-01-01' });
  const hits = list.filter((e) => norm(e.name).includes(norm(name)));
  if (!hits.length) throw new AppError(404, 'Event not found');
  if (hits.length > 1) {
    const ahead = hits.filter((e) => e.date >= ctx.today());
    if (ahead.length === 1) return ahead[0].id;
    throw new AppError(400, `More than one event matches “${name}”: ${hits.slice(0, 6).map((e) => `${e.name} (${e.date})`).join(', ')}`);
  }
  return hits[0].id;
}

export default [
  defineTool({
    name: 'get_events',
    title: 'Events',
    description: 'Events and banquets (BEOs) between two dates (default: the next 30 days): name, date, times, room, guests, status and how many staff are booked of how many needed.',
    input: { from: dateArg('First day').optional(), to: dateArg('Last day').optional() },
    feature: 'events', consent: 'read',
    async handler(user, args, ctx) {
      const { from, to } = resolveRange(args, ctx.today(), { days: 30, max: 120 });
      const list = await ctx.read('events.list', { start: from, end: to });
      const events = list.map((e) => ({ id: e.id, name: e.name, date: e.date, start: e.start, end: e.end, room: e.room, guests: e.guestCount, status: e.status, type: e.type, staffed: `${e.filled}/${e.needed}`, ...(e.client ? { client: e.client } : {}) }));
      return { summary: `${events.length} event(s) from ${from} to ${to}.`, data: { from, to, events } };
    },
  }),
  defineTool({
    name: 'get_event',
    title: 'Event BEO',
    description: 'One event\'s full BEO: menu, special drinks, timeline, setup and dietary notes, staffing and who is booked, and comments. '
      + 'Client and contact details are included only for managers and the events team.',
    input: { eventId: z.string().max(80).optional(), name: z.string().max(120).optional().describe('Or part of its name') },
    feature: 'events', consent: 'read',
    async handler(user, args, ctx) {
      if (!args.eventId && !args.name) throw new AppError(400, 'Give eventId or name');
      const id = await findEvent(ctx, args);
      const [look, e] = await Promise.all([lookupOf(ctx), ctx.read('events.get', { id })]);
      const { shifts = [], comments = [], ...rest } = e;
      const data = {
        ...rest, captain: e.captainId ? look.people[e.captainId]?.name || null : null,
        staffing: (e.staffing || []).map((l) => ({ position: look.jobs[l.jobCodeId]?.name || '', count: l.count, start: l.start, booked: l.filled })),
        staff: shifts.filter((s) => s.userId).map((s) => ({ name: look.people[s.userId]?.name || '', position: look.jobs[s.jobCodeId]?.name || '', start: s.start })),
        comments: comments.slice(-10).map((c) => ({ by: c.userName, at: c.at, text: c.text })),
      };
      return { summary: `${e.name} on ${e.date} (${e.guestCount} guests, ${e.status}).`, data };
    },
  }),
  defineTool({
    name: 'save_event',
    title: 'Create or update a BEO',
    description: 'Managers and the events team: create an event (BEO) or update one (eventId). Only the fields you pass change. '
      + 'Staff booked on an existing event are notified that the BEO changed. New events start as tentative unless status says otherwise.',
    input: {
      eventId: z.string().max(80).optional().describe('To update an existing event'),
      name: z.string().max(120).optional(), date: dateArg('The event\'s date').optional(), start: TIME.optional(), end: TIME.optional(),
      room: z.string().max(60).optional(), guestCount: z.number().int().min(0).max(5000).optional(),
      status: z.enum(['tentative', 'confirmed', 'cancelled']).optional(), type: z.string().max(60).optional(),
      serviceStyle: z.string().max(40).optional().describe('e.g. plated, buffet, family, cocktail'),
      captain: z.string().max(80).optional().describe('Banquet captain\'s name'),
      setupNotes: z.string().max(2000).optional(), dietaryNotes: z.string().max(2000).optional(), notes: z.string().max(2000).optional(),
      client: z.string().max(120).optional(), contactName: z.string().max(120).optional(), contactPhone: z.string().max(40).optional(), contactEmail: z.string().max(120).optional(),
      staffing: z.array(z.object({ position: z.string().max(60), count: z.number().int().min(0).max(100), start: TIME.optional() })).max(30).optional()
        .describe('Replaces the staffing lines: how many of each position'),
    },
    write: true, feature: 'events', can: eventsTeam, consent: 'events', idempotent: false,
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const cur = args.eventId ? await ctx.read('events.get', { id: args.eventId }) : null;
      if (!cur && (!args.name || !args.date)) throw new AppError(400, 'A new event needs a name and a date');
      const patch = {};
      for (const k of ['name', 'start', 'end', 'room', 'guestCount', 'status', 'type', 'serviceStyle', 'setupNotes', 'dietaryNotes', 'notes', 'client', 'contactName', 'contactPhone', 'contactEmail']) if (args[k] !== undefined) patch[k] = args[k];
      if (args.date) patch.date = resolveDate(args.date, ctx.today());
      if (args.captain) patch.captainId = findPerson(look, args.captain).id;
      if (args.staffing) patch.staffing = args.staffing.map((l) => ({ jobCodeId: findPosition(look, l.position).id, count: l.count, start: l.start || args.start || cur?.start || '' }));
      const base = cur ? (({ shifts: _s, comments: _c, needed: _n, filled: _f, autoConfirmed: _a, ...e }) => ({ ...e, staffing: (e.staffing || []).map(({ created: _x, filled: _y, ...l }) => l) }))(cur) : {};
      const saved = await ctx.write('events.save', { ...base, ...patch, ...(cur ? { id: cur.id } : {}) });
      return { summary: `${cur ? 'Updated' : 'Created'} ${saved.name} on ${saved.date} (${saved.status}).`, data: { id: saved.id, name: saved.name, date: saved.date, status: saved.status, guests: saved.guestCount, staffing: saved.staffing?.map((l) => ({ position: look.jobs[l.jobCodeId]?.name || '', count: l.count })) } };
    },
  }),
  defineTool({
    name: 'suggest_event_staffing',
    title: 'Suggest event staffing',
    description: 'Managers and the events team: suggested staffing for an event from its guest count and service style (standard banquet ratios). '
      + 'Doesn\'t change anything; use save_event with staffing to apply it.',
    input: { eventId: z.string().max(80).optional(), guestCount: z.number().int().min(1).max(5000).optional(), serviceStyle: z.string().max(40).optional() },
    feature: 'events', can: eventsTeam, consent: 'events',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const e = args.eventId ? await ctx.read('events.get', { id: args.eventId }) : {};
      const input = { ...e, guestCount: args.guestCount ?? e.guestCount, serviceStyle: args.serviceStyle ?? e.serviceStyle };
      if (!input.guestCount) throw new AppError(400, 'Give a guest count or an event');
      const lines = await ctx.read('events.suggestStaffing', input);
      const out = (lines || []).map((l) => ({ position: look.jobs[l.jobCodeId]?.name || l.name || '', count: l.count, start: l.start, end: l.end, why: l.notes }));
      return { summary: `Suggested ${out.reduce((t, l) => t + (l.count || 0), 0)} staff for ${input.guestCount} guests.`, data: { guestCount: input.guestCount, serviceStyle: input.serviceStyle || null, staffing: out } };
    },
  }),
];
