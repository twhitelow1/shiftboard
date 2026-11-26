// Who's signed in, and the restaurant's basics (today's date, the week, what the plan includes).
import { defineTool, READ, WRITE } from './registry.js';
import { lookupOf } from './helpers.js';
import { roleLabel } from '../../core/roles.js';
import { dow, DOW_LONG, weekStart } from '../../core/time.js';
import { FEATURE_KEYS } from '../platform/plans.js';

export default [
  defineTool({
    name: 'whoami',
    title: 'Who am I in ShiftBoard',
    description: 'Who you are acting as in ShiftBoard (name, role, positions), the restaurant, today\'s date and weekday in the restaurant\'s time zone, '
      + 'the first day of its week, which features its plan includes, and whether this connection can make changes. Call this first to work out dates like "this Friday".',
    consent: 'read',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const today = ctx.today();
      const me = look.me;
      const features = FEATURE_KEYS.filter((f) => ctx.has(f));
      const data = {
        person: { id: me.id, name: me.name, role: roleLabel(me), positions: (me.jobCodes || []).map((j) => look.jobs[j.jobCodeId]?.name).filter(Boolean), language: ctx.lang() },
        restaurant: { name: look.settings.restaurantName, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekStartsOn: DOW_LONG[look.settings.weekStartDow ?? 1] },
        today, weekday: DOW_LONG[dow(today)], thisWeekStarts: weekStart(today, look.settings.weekStartDow ?? 1),
        features, access: ctx.scopes.includes(WRITE) ? 'read and change' : ctx.scopes.includes(READ) ? 'read only' : 'none',
      };
      return { summary: `${me.name} (${roleLabel(me)}) at ${look.settings.restaurantName}. Today is ${data.weekday} ${today}.`, data };
    },
  }),
];
