// Time off, availability, trades and pickups, and (for approvers) approving them: timeOff.*, employees.setAvailability,
// swaps.*. Coworkers and managers are notified exactly as when it's done in the app.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { lookupOf, shiftOut, findPerson, dateArg, idArg, confirmArg } from './helpers.js';
import { resolveDate } from './dates.js';
import { canApprove, canManageSchedule } from '../../core/roles.js';
import { DOW_LONG } from '../../core/time.js';
import { AppError } from '../../core/service.js';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like 16:00');
const approver = (user, info) => canApprove(user, info.settings);
const dayOut = (name, a) => ({ day: name, ...(a?.available === false ? { available: false } : { available: true, ...(a?.from ? { from: a.from } : {}), ...(a?.to ? { to: a.to } : {}) }), ...(a?.note ? { note: a.note } : {}) });
const dayText = (d) => (d.available === false ? 'unavailable' : d.from || d.to ? `${d.from || 'open'}–${d.to || 'close'}` : 'any time') + (d.note ? ` (${d.note})` : '');

function requestOut(r, look) {
  return {
    id: r.id, type: r.type === 'drop' ? 'giveaway' : r.type === 'swap' ? 'trade' : 'pickup', status: r.status,
    from: look.people[r.requesterId]?.name || '', ...(r.pickupUserId ? { takenBy: look.people[r.pickupUserId]?.name || '' } : {}),
    ...(r.targetUserId ? { tradeWith: look.people[r.targetUserId]?.name || '' } : {}),
    shift: r.shift ? shiftOut(r.shift, look) : null, ...(r.targetShift ? { forShift: shiftOut(r.targetShift, look) } : {}),
    ...(r.note ? { note: r.note } : {}), ...(r.warnings?.length ? { warnings: r.warnings } : {}), ...(r.myConflicts?.length ? { yourConflicts: r.myConflicts } : {}),
    createdAt: r.createdAt, ...(r.resolution ? { resolution: r.resolution } : {}),
  };
}
const timeOffOut = (t, look) => ({ id: t.id, person: look.people[t.userId]?.name || '', from: t.startDate, to: t.endDate, status: t.status, ...(t.reason ? { reason: t.reason } : {}), ...(t.note ? { note: t.note } : {}) });

export default [
  // ---------- time off ----------
  defineTool({
    name: 'get_time_off',
    title: 'Time off',
    description: 'Your time-off requests (pending, approved, denied) from the last 60 days on. Approvers can add everyone: true to see everyone\'s.',
    input: { everyone: z.boolean().optional().describe('Approvers only: everyone\'s requests, not just yours') },
    consent: 'read',
    async handler(user, args, ctx) {
      const [look, rows] = await Promise.all([lookupOf(ctx), ctx.read('timeOff.list')]);
      const list = rows.filter((t) => args.everyone || t.userId === user.id).map((t) => timeOffOut(t, look));
      return { summary: `${list.length} time-off request(s).`, data: { timeOff: list } };
    },
  }),
  defineTool({
    name: 'request_time_off',
    title: 'Request time off',
    description: 'Ask for time off (one day, or from startDate to endDate). It goes to the managers for approval, like in the app. '
      + 'Says how many of your shifts fall on those days (you still have to trade or give those away).',
    input: { startDate: dateArg('First day off'), endDate: dateArg('Last day off (default: the same day)').optional(), reason: z.string().max(300).optional() },
    write: true, consent: 'timeOff', idempotent: false,
    async handler(user, args, ctx) {
      const today = ctx.today();
      const startDate = resolveDate(args.startDate, today);
      const endDate = args.endDate ? resolveDate(args.endDate, today) : startDate;
      if (endDate < startDate) throw new AppError(400, 'The end date is before the start date');
      if (startDate < today) throw new AppError(400, 'Pick a day from today on');
      const t = await ctx.write('timeOff.create', { startDate, endDate, reason: args.reason || '' });
      return { summary: `Time off requested for ${startDate}${endDate !== startDate ? ` to ${endDate}` : ''}: ${t.status}.${t.clashes ? ` You have ${t.clashes} shift(s) on those days.` : ''}`, data: { id: t.id, from: t.startDate, to: t.endDate, status: t.status, shiftsOnThoseDays: t.clashes } };
    },
  }),

  // ---------- availability ----------
  // Everyone reads and changes their own; managers (and whoever Roles & features lets edit staff availability) someone
  // else's, with confirm: true. Every change is in that person's Availability history (via: connector or assistant),
  // and they're notified when it wasn't them (core/availability-api.js).
  defineTool({
    name: 'get_availability',
    title: 'Availability',
    description: 'Your weekly availability (days you can\'t work, or only between certain hours, with any note), your notes and limits. '
      + 'Managers can ask for someone else\'s with person.',
    input: { person: z.string().max(80).optional().describe('Managers: whose availability (name)') },
    consent: 'read',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const who = args.person && canManageSchedule(user) ? findPerson(look, args.person) : look.me;
      const a = await ctx.read('availability.get', { userId: who.id });
      const days = DOW_LONG.map((name, i) => dayOut(name, a.availability[i]));
      return {
        summary: `Availability for ${who.name}.`,
        data: { person: who.name, days, ...(a.notes ? { notes: a.notes } : {}), ...(a.maxHours != null ? { maxHours: a.maxHours } : {}), ...(a.maxDays != null ? { maxDays: a.maxDays } : {}),
          ...(a.effectiveFrom ? { effectiveFrom: a.effectiveFrom, before: DOW_LONG.map((name, i) => dayOut(name, a.previous?.[i])) } : {}) },
      };
    },
  }),
  defineTool({
    name: 'set_availability',
    title: 'Set availability',
    description: 'Change weekly availability for the days you list (other days stay as they are). For each day: available false (can\'t work), '
      + 'or available true with optional from/to hours, and an optional note. Yours by default. Managers can change someone else\'s with person: '
      + 'tell the user exactly what will change for whom, ask, and call again with confirm: true. That person is notified and the change is logged.',
    input: {
      days: z.array(z.object({
        day: z.enum(DAY_NAMES).describe('Weekday, lowercase English'), available: z.boolean(),
        from: TIME.optional().describe('Available from (24-hour)'), to: TIME.optional().describe('Available until (24-hour)'),
        note: z.string().max(200).optional().describe('A note for that day (e.g. "school until 2")'),
      })).min(1).max(7),
      person: z.string().max(80).optional().describe('Managers: whose availability (name or id). Leave out for your own.'),
      confirm: confirmArg,
    },
    write: true, consent: 'availability', idempotent: true,
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const who = args.person ? findPerson(look, args.person) : look.me;
      const other = who.id !== look.me.id;
      if (other && args.confirm !== true) {
        throw new AppError(409, `Not done: changing ${who.name}'s availability notifies them. Tell the user exactly what will change, ask, and call again with confirm: true.`);
      }
      const cur = await ctx.read('availability.get', { userId: who.id });
      const next = { ...(cur.availability || {}) };
      for (const d of args.days) {
        const i = DAY_NAMES.indexOf(d.day);
        const note = d.note ? { note: d.note } : {};
        if (!d.available) next[i] = { available: false, ...note };
        else if (d.from || d.to || d.note) next[i] = { available: true, ...(d.from ? { from: d.from } : {}), ...(d.to ? { to: d.to } : {}), ...note };
        else delete next[i];
      }
      await ctx.write('employees.setAvailability', { availability: next, ...(other ? { userId: who.id } : {}) });
      return { summary: `Availability saved for ${other ? `${who.name}: ` : ''}${args.days.map((d) => d.day).join(', ')}.${other ? ` ${who.name} was notified.` : ''}`, data: { person: who.name, availability: next } };
    },
  }),
  defineTool({
    name: 'get_availability_history',
    title: 'Availability history',
    description: 'Every change to someone\'s weekly availability in the last 2 years: who changed it, when, how (app, import, connector, assistant) '
      + 'and each day before → after. Yours by default; managers can ask for someone else\'s with person.',
    input: { person: z.string().max(80).optional().describe('Managers: whose history (name)'), limit: z.number().int().min(1).max(100).optional() },
    consent: 'read',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const who = args.person && canManageSchedule(user) ? findPerson(look, args.person) : look.me;
      const rows = await ctx.read('availability.history', { userId: who.id, limit: args.limit || 30 });
      const changes = rows.map((e) => ({
        at: e.at, by: e.actorName, via: e.via, ...(e.fileName ? { file: e.fileName } : {}),
        days: e.days.map((d) => ({ day: DOW_LONG[d.day], before: dayText(d.before), after: dayText(d.after) })),
        ...(e.fields.length ? { other: e.fields } : {}),
      }));
      return { summary: `${changes.length} change(s) to ${who.name}'s availability.`, data: { person: who.name, changes } };
    },
  }),

  // ---------- trades, giveaways, pickups ----------
  defineTool({
    name: 'get_trade_requests',
    title: 'Trades and pickups',
    description: 'Your shift trades, giveaways and pickup requests (and their status), shifts coworkers are offering you or giving away, '
      + 'and for approvers, the ones waiting on approval.',
    consent: 'read',
    async handler(user, args, ctx) {
      const [look, s] = await Promise.all([lookupOf(ctx), ctx.read('swaps.list')]);
      const data = {
        mine: s.mine.map((r) => requestOut(r, look)), offeredToMe: s.offers.map((r) => requestOut(r, look)),
        ...(s.approvals.length ? { waitingOnApproval: s.approvals.map((r) => requestOut(r, look)) } : {}),
      };
      return { summary: `${data.mine.length} of yours, ${data.offeredToMe.length} offered to you${data.waitingOnApproval ? `, ${data.waitingOnApproval.length} waiting on approval` : ''}.`, data };
    },
  }),
  defineTool({
    name: 'offer_shift',
    title: 'Give away or trade a shift',
    description: 'Offer one of your published, future shifts: type "giveaway" (everyone trained for it is notified and can take it) or "trade" '
      + '(for a coworker\'s shift: pass tradeForShiftId; that coworker is notified). A manager approves it after someone accepts, if the restaurant requires approval.',
    input: {
      shiftId: idArg('Your shift\'s id (from get_my_shifts)'), type: z.enum(['giveaway', 'trade']),
      tradeForShiftId: z.string().max(80).optional().describe('For a trade: the coworker\'s shift id (from get_schedule)'), note: z.string().max(300).optional(),
    },
    write: true, consent: 'trades', idempotent: false,
    async handler(user, args, ctx) {
      if (args.type === 'trade' && !args.tradeForShiftId) throw new AppError(400, 'Pick a coworker shift to trade for');
      const r = await ctx.write('swaps.create', { shiftId: args.shiftId, type: args.type === 'trade' ? 'swap' : 'drop', ...(args.type === 'trade' ? { targetShiftId: args.tradeForShiftId } : {}), note: args.note || '' });
      return { summary: args.type === 'trade' ? 'Trade offered; your coworker was notified.' : 'Shift offered; coworkers trained for it were notified.', data: { requestId: r.id, status: r.status } };
    },
  }),
  defineTool({
    name: 'pick_up_shift',
    title: 'Pick up a shift',
    description: 'Ask for an open shift (shiftId, from get_open_shifts), or accept a shift a coworker is giving away or a trade offered to you (requestId, from get_open_shifts or get_trade_requests). '
      + 'Managers approve it if the restaurant requires approval.',
    input: { shiftId: z.string().max(80).optional().describe('An open shift\'s id'), requestId: z.string().max(80).optional().describe('A giveaway or trade request\'s id'), note: z.string().max(300).optional() },
    write: true, consent: 'trades', idempotent: false,
    async handler(user, args, ctx) {
      if (!args.shiftId === !args.requestId) throw new AppError(400, 'Give either shiftId (an open shift) or requestId (a giveaway or trade)');
      const r = args.requestId ? await ctx.write('swaps.accept', { requestId: args.requestId }) : await ctx.write('swaps.create', { shiftId: args.shiftId, type: 'pickup', note: args.note || '' });
      const done = r.autoApproved ? 'It’s yours: no approval needed.' : 'Requested; a manager will approve it.';
      return { summary: done, data: { autoApproved: !!r.autoApproved, ...(r.id ? { requestId: r.id } : {}) } };
    },
  }),
  defineTool({
    name: 'cancel_request',
    title: 'Cancel a request',
    description: 'Cancel one of your own open requests: a trade, giveaway or pickup (requestId) or a time-off request (timeOffId).',
    input: { requestId: z.string().max(80).optional(), timeOffId: z.string().max(80).optional() },
    write: true, consent: 'trades', destructive: true, idempotent: true,
    async handler(user, args, ctx) {
      if (!args.requestId === !args.timeOffId) throw new AppError(400, 'Give either requestId or timeOffId');
      if (args.requestId) await ctx.write('swaps.cancel', { requestId: args.requestId });
      else await ctx.write('timeOff.cancel', { id: args.timeOffId });
      return { summary: 'Cancelled.', data: { ok: true } };
    },
  }),

  // ---------- approvals (managers, and supervisors when the restaurant allows it) ----------
  defineTool({
    name: 'get_pending_approvals',
    title: 'Waiting on approval',
    description: 'Trades, giveaways, pickups and time-off requests waiting on a manager\'s approval, with any conflicts (overtime, double booking, time off). '
      + 'You can\'t approve your own.',
    role: 'supervisor', can: approver, consent: 'read',
    async handler(user, args, ctx) {
      const [look, s, t] = await Promise.all([lookupOf(ctx), ctx.read('swaps.list'), ctx.read('timeOff.list')]);
      // Only what's in this person's "Approves for" scope (the app's "waiting on you").
      const data = { trades: s.approvals.map((r) => requestOut(r, look)), timeOff: t.filter((x) => x.status === 'pending' && !x.outOfScope).map((x) => timeOffOut(x, look)) };
      return { summary: `${data.trades.length} trade/pickup request(s) and ${data.timeOff.length} time-off request(s) waiting.`, data };
    },
  }),
  ...['approve', 'deny'].map((verb) => defineTool({
    name: `${verb}_request`,
    title: verb === 'approve' ? 'Approve a request' : 'Deny a request',
    description: `${verb === 'approve' ? 'Approve' : 'Deny'} a trade, giveaway or pickup (requestId) or a time-off request (timeOffId) that is waiting on approval. `
      + `The people involved are notified.${verb === 'approve' ? ' Check its warnings first (get_pending_approvals).' : ''} Not for your own requests.`,
    input: { requestId: z.string().max(80).optional(), timeOffId: z.string().max(80).optional(), note: z.string().max(300).optional().describe('Optional note to the people involved') },
    write: true, role: 'supervisor', can: approver, consent: 'approve', idempotent: true, destructive: verb === 'deny',
    async handler(user, args, ctx) {
      if (!args.requestId === !args.timeOffId) throw new AppError(400, 'Give either requestId or timeOffId');
      if (args.requestId) await ctx.write(`swaps.${verb}`, { requestId: args.requestId, note: args.note || '' });
      else await ctx.write('timeOff.decide', { id: args.timeOffId, status: verb === 'approve' ? 'approved' : 'denied', note: args.note || '' });
      return { summary: `${verb === 'approve' ? 'Approved' : 'Denied'}; the people involved were notified.`, data: { ok: true } };
    },
  })),
];
