// Notifications, my tips, and for managers: the team, the forecast and labor.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { lookupOf } from './helpers.js';
import { resolveWeek } from './dates.js';
import { roleLabel, canSeeContacts } from '../../core/roles.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const weekArg = z.string().max(40).optional().describe('"this week" (default), "next week", "last week", or any date in the week');

export default [
  defineTool({
    name: 'get_notifications',
    title: 'My notifications',
    description: 'Your latest ShiftBoard notifications (schedule posted, shift changes, trade requests, approvals, event updates…), newest first. Doesn\'t mark them read.',
    input: { unreadOnly: z.boolean().optional(), limit: z.number().int().min(1).max(60).optional() },
    consent: 'read',
    async handler(user, args, ctx) {
      const list = await ctx.read('notifications.list');
      const items = list.filter((n) => !args.unreadOnly || !n.read).slice(0, args.limit || 20).map((n) => ({ text: n.text, at: n.at, read: !!n.read }));
      return { summary: `${items.length} notification(s), ${list.filter((n) => !n.read).length} unread.`, data: { notifications: items } };
    },
  }),
  defineTool({
    name: 'get_my_tips',
    title: 'My tips',
    description: 'Your own tip-pool share for a week and how it was worked out (hours, points, the pool). Never a coworker\'s amount. '
      + 'Before the week is finalized, amounts can be estimates or not shown yet.',
    input: { week: weekArg },
    feature: 'tips', consent: 'tips',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const weekStart = resolveWeek(args.week, ctx.today(), look.settings.weekStartDow ?? 1);
      const t = await ctx.read('myTips.week', { weekStart });
      const items = (t.items || []).map((i) => ({ pool: i.poolName, period: i.label, amount: i.me.amount, estimated: !!i.me.estimated, hours: Math.round((i.me.minutes || 0) / 6) / 10, sharePct: i.me.sharePct, explained: i.lines }));
      const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      return { summary: items.length ? `Tips for the week of ${weekStart}: ${items.length} share(s).` : `No tip share for the week of ${weekStart} yet.`, data: { weekStart, locked: !!t.locked, items, total, ...(t.waiting?.length ? { notReadyYet: t.waiting } : {}) } };
    },
  }),
  defineTool({
    name: 'get_team',
    title: 'Team',
    description: 'Managers: the team (name, role, positions, active or not), optionally filtered by name or position. '
      + 'Phone and email are included only where ShiftBoard shows them to you.',
    input: { query: z.string().max(60).optional().describe('Part of a name or a position'), includeInactive: z.boolean().optional() },
    role: 'manager', consent: 'team',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const q = norm(args.query);
      const people = look.employees.filter((e) => args.includeInactive || e.active !== false).map((e) => ({
        id: e.id, name: e.name, role: roleLabel(e), active: e.active !== false, positions: (e.jobCodes || []).map((j) => look.jobs[j.jobCodeId]?.name).filter(Boolean),
        ...(canSeeContacts(user) && (e.email || e.phone) ? { email: e.email || null, phone: e.phone || null } : {}),
      })).filter((p) => !q || norm(p.name).includes(q) || p.positions.some((x) => norm(x).includes(q)));
      return { summary: `${people.length} ${people.length === 1 ? 'person' : 'people'}.`, data: { people } };
    },
  }),
  defineTool({
    name: 'get_forecast',
    title: 'Forecast',
    description: 'Managers: the week\'s forecast by day: covers (with event guests), sales, scheduled hours, labor cost and labor % against the target.',
    input: { week: weekArg },
    role: 'manager', feature: 'forecast', consent: 'reports',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const weekStart = resolveWeek(args.week, ctx.today(), look.settings.weekStartDow ?? 1);
      const f = await ctx.read('forecast.summary', { weekStart });
      return { summary: `Week of ${weekStart}: ${f.totals.covers} covers, $${Math.round(f.totals.sales)} sales, labor ${f.totals.laborPct ?? '—'}% (target ${f.targetLaborPct}%).`, data: { weekStart, ...f } };
    },
  }),
  defineTool({
    name: 'get_labor_summary',
    title: 'Labor summary',
    description: 'Managers: scheduled vs. worked hours and labor cost for a week (default: last week), from the time clock (ADP or Toast) when connected, '
      + 'with overtime and people who worked without a shift or missed one.',
    input: { week: z.string().max(40).optional().describe('"last week" (default), "this week", or any date in the week') },
    role: 'manager', feature: 'forecast', consent: 'reports',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const weekStart = resolveWeek(args.week || 'last week', ctx.today(), look.settings.weekStartDow ?? 1);
      const r = await ctx.read('labor.week', { weekStart });
      const { toast: _t, adp: _a, clock, people, days, ...rest } = r;
      const data = { weekStart, clockSource: clock?.source || null, ...rest, days, people: (people || []).slice(0, 80) };
      return { summary: `Labor for the week of ${weekStart}${r.anyEntries ? '' : ' (no clock-ins yet: scheduled hours only)'}.`, data };
    },
  }),
];
