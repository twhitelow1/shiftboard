// The schedule: my shifts, the published schedule (drafts too for managers), open shifts, who's working, and
// for managers, building drafts and publishing. All through shifts.list / shifts.save / shifts.delete /
// shifts.publish, so staff never see drafts and every change notifies people the way the app does.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { lookupOf, shiftOut, byTime, findPerson, findPosition, dateArg, confirmArg, idArg } from './helpers.js';
import { resolveDate, resolveRange, resolveWeek } from './dates.js';
import { addDays, pad } from '../../core/time.js';
import { activeAt } from '../../core/forecast.js';
import { AppError } from '../../core/service.js';
import { canManageSchedule } from '../../core/roles.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like 16:00');

async function shiftsIn(ctx, from, to) {
  return ctx.read('shifts.list', { start: from, end: to });
}

export default [
  defineTool({
    name: 'get_my_shifts',
    title: 'My shifts',
    description: 'Your own shifts between two dates (default: today and the next 13 days), with position, room, start and end ("close" means until close), '
      + 'and any approved time off. Shows only the published schedule (managers also see their draft shifts, marked draft).',
    input: { from: dateArg('First day').optional(), to: dateArg('Last day').optional() },
    consent: 'read',
    async handler(user, args, ctx) {
      const today = ctx.today();
      const { from, to } = resolveRange(args, today, { days: 14 });
      const [look, list] = await Promise.all([lookupOf(ctx), shiftsIn(ctx, from, to)]);
      const shifts = list.shifts.filter((s) => s.userId === user.id).sort(byTime).map((s) => shiftOut(s, look, { mine: true }));
      const timeOff = list.timeOff.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, from: t.startDate, to: t.endDate, status: t.status }));
      const hours = Math.round(shifts.reduce((t, s) => t + (s.hours || 0), 0) * 10) / 10;
      return { summary: shifts.length ? `${shifts.length} shift(s) from ${from} to ${to}, about ${hours} hours.` : `No shifts from ${from} to ${to}.`, data: { from, to, shifts, timeOff } };
    },
  }),

  defineTool({
    name: 'get_schedule',
    title: 'Schedule',
    description: 'The schedule for one day or a whole week: who works when, by room and position. Filter by room (e.g. "Moon Rabbit") or position (e.g. "Server"). '
      + 'Everyone sees the published schedule; managers can add includeDrafts: true to see draft shifts that staff can\'t see yet. Also returns day notes and events.',
    input: {
      date: dateArg('A day').optional(),
      week: z.string().max(40).optional().describe('A whole week instead of one day: "this week", "next week", or any date in the week'),
      room: z.string().max(60).optional().describe('Only this room/area'),
      position: z.string().max(60).optional().describe('Only this position (job code), e.g. "Bartender"'),
      includeDrafts: z.boolean().optional().describe('Managers only: include draft (unpublished) shifts'),
    },
    consent: 'read',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const today = ctx.today();
      let from, to;
      if (args.week) { from = resolveWeek(args.week, today, look.settings.weekStartDow ?? 1); to = addDays(from, 6); } else { from = to = resolveDate(args.date, today); }
      const list = await shiftsIn(ctx, from, to);
      const drafts = !!args.includeDrafts && canManageSchedule(user); // staff never get drafts from shifts.list anyway
      const pos = args.position ? findPosition(look, args.position) : null;
      const shifts = list.shifts
        .filter((s) => (drafts ? true : s.published))
        .filter((s) => !args.room || norm(s.area).includes(norm(args.room)))
        .filter((s) => !pos || s.jobCodeId === pos.id)
        .sort(byTime).map((s) => shiftOut(s, look));
      const data = {
        from, to, shifts,
        notes: list.notes.map((n) => ({ date: n.date, kind: n.kind, text: n.text })),
        events: list.events.map((e) => ({ id: e.id, name: e.name, date: e.date, start: e.start, room: e.room, guests: e.guestCount, status: e.status })),
        ...(Object.keys(list.warnings || {}).length && drafts ? { warnings: list.warnings } : {}),
      };
      return { summary: `${shifts.length} shift(s) ${from === to ? `on ${from}` : `from ${from} to ${to}`}${drafts ? ', drafts included' : ''}.`, data };
    },
  }),

  defineTool({
    name: 'get_open_shifts',
    title: 'Open shifts',
    description: 'Published shifts nobody has yet (default: today and the next 13 days), and shifts coworkers are giving away. '
      + 'canPickUp says whether you\'re set up for the position. Use pick_up_shift to ask for one.',
    input: { from: dateArg('First day').optional(), to: dateArg('Last day').optional() },
    consent: 'read',
    async handler(user, args, ctx) {
      const today = ctx.today();
      const { from, to } = resolveRange(args, today, { days: 14 });
      const [look, list, swaps] = await Promise.all([lookupOf(ctx), shiftsIn(ctx, from, to), ctx.read('swaps.list')]);
      const mine = new Set((look.me.jobCodes || []).map((j) => j.jobCodeId));
      const open = list.shifts.filter((s) => s.published && !s.userId).sort(byTime).map((s) => ({ ...shiftOut(s, look), canPickUp: mine.has(s.jobCodeId) }));
      const givingAway = swaps.offers.filter((r) => r.type === 'drop' && r.shift).map((r) => ({ requestId: r.id, from: look.people[r.requesterId]?.name || '', note: r.note || '', shift: shiftOut(r.shift, look), yourConflicts: r.myConflicts || [] }));
      return { summary: `${open.length} open shift(s) and ${givingAway.length} shift(s) being given away.`, data: { from, to, open, givingAway } };
    },
  }),

  defineTool({
    name: 'who_is_working',
    title: 'Who is working',
    description: 'Who is on the published schedule: right now ("now"), today, or on another date. For "now", it lists people whose shift is on the floor at this moment.',
    input: { when: z.string().max(40).optional().describe(`"now" (default), "today", or a date: YYYY-MM-DD, "tomorrow", a weekday`) },
    consent: 'read',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const today = ctx.today();
      const now = norm(args.when || 'now') === 'now' || norm(args.when) === 'ahora';
      const date = now ? today : resolveDate(args.when, today);
      const list = await shiftsIn(ctx, addDays(date, -1), date);
      const n = new Date(ctx.now());
      const time = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
      const on = list.shifts.filter((s) => s.published && s.userId && (now ? activeAt(s, date, time, look.settings) : s.date === date)).sort(byTime).map((s) => shiftOut(s, look));
      return { summary: `${on.length} ${on.length === 1 ? 'person' : 'people'} ${now ? `working now (${time})` : `on ${date}`}.`, data: { date, ...(now ? { time } : {}), working: on } };
    },
  }),

  // ---------- managers: drafts and publishing ----------
  defineTool({
    name: 'create_shift',
    title: 'Add a draft shift',
    description: 'Managers: add a shift to the schedule as a DRAFT (staff don\'t see it and nobody is notified until the week is published with publish_week). '
      + 'Leave person empty for an open shift. Returns conflicts for the person (time off, availability, overtime, double booking, not trained).',
    input: {
      date: dateArg('The shift\'s date'), start: TIME.describe('Start, 24-hour HH:MM'), end: TIME.optional().describe('End, 24-hour HH:MM; leave out for "until close"'),
      position: z.string().min(1).max(60).describe('Position (job code) name or id, e.g. "Server"'),
      room: z.string().max(60).optional().describe('Room/area, e.g. "Restaurant"'), person: z.string().max(80).optional().describe('Who works it (name or id); empty for an open shift'),
      tag: z.string().max(20).optional(), notes: z.string().max(300).optional(),
    },
    write: true, role: 'manager', consent: 'drafts', idempotent: false,
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const today = ctx.today();
      const pos = findPosition(look, args.position);
      const who = args.person ? findPerson(look, args.person) : null;
      const doc = { date: resolveDate(args.date, today), start: args.start, end: args.end || null, jobCodeId: pos.id, userId: who?.id || null, area: args.room || '', tag: args.tag || '', notes: args.notes || '', published: false };
      const out = await ctx.write('shifts.save', doc);
      return { summary: `Draft shift added: ${pos.name} ${doc.date} ${doc.start}${doc.end ? `–${doc.end}` : '–close'}${who ? ` for ${who.name}` : ' (open)'}. Not published.`, data: { shift: shiftOut(out.shift, look), warnings: out.warnings } };
    },
  }),

  defineTool({
    name: 'update_shift',
    title: 'Change a shift',
    description: 'Managers: change a shift\'s date, times, position, room, person or notes. Draft shifts change quietly. '
      + 'If the shift is already PUBLISHED, the people on it are notified, so ask the user first and pass confirm: true.',
    input: {
      shiftId: idArg('The shift\'s id (from get_schedule)'), date: dateArg('New date').optional(), start: TIME.optional(), end: TIME.nullable().optional().describe('New end; null for "until close"'),
      position: z.string().max(60).optional(), room: z.string().max(60).optional(), person: z.string().max(80).nullable().optional().describe('New person; null to make it an open shift'),
      tag: z.string().max(20).optional(), notes: z.string().max(300).optional(), confirm: confirmArg,
    },
    write: true, role: 'manager', consent: 'drafts', idempotent: true,
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const today = ctx.today();
      const pos = args.position ? findPosition(look, args.position) : null;
      const who = args.person ? findPerson(look, args.person) : null;
      const out = await ctx.write((call, store) => {
        const cur = store.get('shifts', args.shiftId);
        if (!cur) throw new AppError(404, 'Shift not found');
        if (cur.published && args.confirm !== true) throw new AppError(409, 'That shift is published: changing it notifies the people on it. Ask the user, then call again with confirm: true.');
        const next = {
          ...cur, id: cur.id, date: args.date ? resolveDate(args.date, today) : cur.date, start: args.start || cur.start, end: args.end === undefined ? cur.end : args.end,
          jobCodeId: pos ? pos.id : cur.jobCodeId, area: args.room ?? cur.area, userId: args.person === null ? null : who ? who.id : cur.userId,
          tag: args.tag ?? cur.tag, notes: args.notes ?? cur.notes,
        };
        return { ...call('shifts.save', next), published: !!cur.published };
      });
      return { summary: `Shift updated${out.published ? ' (published: the people on it were notified)' : ' (draft)'}.`, data: { shift: shiftOut(out.shift, look), warnings: out.warnings } };
    },
  }),

  defineTool({
    name: 'delete_shift',
    title: 'Delete a shift',
    description: 'Managers: delete a shift. Draft shifts go quietly. If it is PUBLISHED, the person on it is notified and open trade requests on it are cancelled, '
      + 'so ask the user first and pass confirm: true.',
    input: { shiftId: idArg('The shift\'s id (from get_schedule)'), confirm: confirmArg },
    write: true, role: 'manager', consent: 'drafts', destructive: true, idempotent: true,
    async handler(user, args, ctx) {
      const out = await ctx.write((call, store) => {
        const cur = store.get('shifts', args.shiftId);
        if (!cur) throw new AppError(404, 'Shift not found');
        if (cur.published && args.confirm !== true) throw new AppError(409, 'That shift is published: deleting it notifies the person on it. Ask the user, then call again with confirm: true.');
        call('shifts.delete', { id: cur.id });
        return { date: cur.date, published: !!cur.published };
      });
      return { summary: `Shift on ${out.date} deleted${out.published ? ' (it was published; the person was notified)' : ''}.`, data: out };
    },
  }),

  defineTool({
    name: 'publish_week',
    title: 'Publish the week',
    description: 'Managers: publish every draft shift in a week, so staff see them and everyone scheduled is notified (and people trained for open shifts). '
      + 'This can\'t be undone quietly. ALWAYS ask the user first, say how many draft shifts will go out, and only then call with confirm: true.',
    input: { week: z.string().min(1).max(40).describe('The week: "this week", "next week", or any date in it'), confirm: confirmArg },
    write: true, role: 'manager', consent: 'publish', confirm: true, idempotent: true,
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const from = resolveWeek(args.week, ctx.today(), look.settings.weekStartDow ?? 1);
      const to = addDays(from, 6);
      const out = await ctx.write('shifts.publish', { start: from, end: to });
      return { summary: `Published ${out.published} draft shift(s) for ${from} to ${to}; ${out.notified} people notified.`, data: { from, to, ...out } };
    },
  }),
];
