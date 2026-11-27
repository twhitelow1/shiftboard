// Ratings and skill mix (core/ratings.js), for managers only: employees never get these tools, and the RPCs behind
// them refuse anyone without the ratingsView role feature anyway.
//   get_skill_mix   a week's skill-mix rules, how each day does against them (and why a rule fails), who could be added
//                   or swapped in for each failing rule, and (includeRatings) ratings by position: what the schedule
//                   generator will read
//   set_rating      (ratingsEdit) set or clear one person's rating in one position. Previews first; confirm: true saves
import { z } from 'zod';
import { defineTool } from './registry.js';
import { lookupOf, findPerson, findPosition, confirmArg } from './helpers.js';
import { resolveWeek } from './dates.js';
import { AppError } from '../../core/service.js';
import { roleAllows } from '../../core/role-features.js';
import { atLeast } from '../../core/roles.js';
import { DOW_LONG, dow } from '../../core/time.js';

const canView = (user, info) => atLeast(user, 'supervisor') && roleAllows(user, info.settings || {}).ratingsView === true;
const canEdit = (user, info) => canView(user, info) && roleAllows(user, info.settings || {}).ratingsEdit === true;

/** A rule in words: "Server, Fri & Sat, Dinner: at least 2 rated 5+". */
export function ruleText(r, look) {
  const pos = look.jobs[r.jobCodeId]?.name || 'position';
  const when = [r.days?.length ? r.days.map((d) => DOW_LONG[d].slice(0, 3)).join(' & ') : '', r.daypart, r.room].filter(Boolean).join(', ');
  const what = r.type === 'atLeast' ? `at least ${r.count} rated ${r.rating}+` : r.type === 'atMost' ? `at most ${r.count} rated ${r.rating} or below` : `average rating ${r.avg}+`;
  return `${pos}${when ? `, ${when}` : ''}: ${what}`;
}

/** Why a result fails, in words. */
const why = (res, r) => (r.type === 'minAvg' ? `average ${res.avg ?? '—'} (needs ${r.avg})` : r.type === 'atLeast' ? `${res.have} scheduled rated ${r.rating}+ (needs ${r.count})` : `${res.have} scheduled rated ${r.rating} or below (max ${r.count})`);

export default [
  defineTool({
    name: 'get_skill_mix',
    title: 'Skill mix',
    description: 'Managers: for a week, the skill-mix rules (e.g. "Servers, Fri & Sat dinner: at least 2 rated 5"), each day\'s result per rule (ok, '
      + 'or failing and why, with who is scheduled and their ratings), and for failing rules who could be added as a draft shift or swapped in '
      + '(people who are available, not on time off or a day off, not already working then, under their max hours and days). With includeRatings: '
      + 'every person\'s rating per position. Ratings are confidential: never share them with staff.',
    input: {
      week: z.string().min(1).max(40).optional().describe('The week: "this week", "next week", or any date in it (default: this week)'),
      includeRatings: z.boolean().optional().describe('Also list ratings by position'),
      suggest: z.boolean().optional().describe('Include suggestions for failing rules (default true)'),
    },
    can: canView, consent: 'read',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const ws = resolveWeek(args.week || 'this week', ctx.today(), look.settings.weekStartDow ?? 1);
      const w = await ctx.read('skillMix.week', { weekStart: ws, includeRatings: !!args.includeRatings });
      const rules = Object.fromEntries(w.rules.map((r) => [r.id, r]));
      const days = [];
      for (const d of w.days) {
        const results = [];
        for (const res of d.results) {
          const r = rules[res.ruleId];
          const row = { rule: ruleText(r, look), ruleId: r.id, status: res.status, ...(res.status === 'fail' ? { why: why(res, r) } : {}),
            scheduled: res.people.map((p) => `${p.name}${p.hidden ? '' : p.rating == null ? ' (unrated)' : ` (${p.rating})`}`) };
          if (res.status === 'fail' && args.suggest !== false) {
            const s = await ctx.read('skillMix.suggestions.list', { date: d.date, ruleId: r.id });
            row.suggestions = s.candidates.map((c) => ({ name: c.name, rating: c.rating, weekHours: c.weekHours,
              ...(c.add ? { add: `${c.add.start}${c.add.end ? `–${c.add.end}` : ''}${c.add.area ? ` in ${c.add.area}` : ''}` } : {}),
              ...(c.swap ? { swapWith: `${c.swap.name} (${c.swap.rating ?? 'unrated'})` } : {}), ...(c.warnings.length ? { warnings: c.warnings } : {}) }));
          }
          results.push(row);
        }
        days.push({ date: d.date, day: DOW_LONG[dow(d.date)], results });
      }
      const data = { week: ws, scale: w.scale, rules: w.rules.map((r) => ({ id: r.id, rule: ruleText(r, look) })), days, failing: w.failing };
      if (w.ratingsByPosition) data.ratingsByPosition = Object.fromEntries(Object.entries(w.ratingsByPosition).map(([id, l]) => [look.jobs[id]?.name || id, l.map((p) => ({ name: p.name, rating: p.rating }))]));
      return { summary: `Skill mix for the week of ${ws}: ${w.rules.length} rule(s), ${w.failing} failing. Ratings are confidential.`, data };
    },
  }),
  defineTool({
    name: 'set_rating',
    title: 'Set a rating',
    description: 'Managers: set (or clear, with rating null) one person\'s rating in one of their positions, on the restaurant\'s scale, with an optional note '
      + 'for the history. First call WITHOUT confirm: nothing is saved; you get the current rating and what it would become. Ask the user, then call again '
      + 'with confirm: true. Ratings are confidential: never share them with staff.',
    input: {
      person: z.string().min(1).max(80).describe('Their name or id'),
      position: z.string().min(1).max(60).describe('The position (job code) name'),
      rating: z.number().int().min(0).max(10).nullable().describe('The new rating, or null to clear it (unrated)'),
      note: z.string().max(200).optional(),
      confirm: confirmArg,
    },
    write: true, preview: true, idempotent: true, can: canEdit, consent: 'ratings',
    async handler(user, args, ctx) {
      const look = await lookupOf(ctx);
      const who = findPerson(look, args.person);
      const job = findPosition(look, args.position);
      const cur = await ctx.read('ratings.person.get', { userId: who.id });
      const line = cur.positions.find((p) => p.jobCodeId === job.id);
      if (!line) throw new AppError(400, `${who.name} doesn’t work ${job.name}`);
      const scale = cur.scale;
      if (args.rating != null && (args.rating < scale.min || args.rating > scale.max)) throw new AppError(400, `The scale is ${scale.min}–${scale.max}`);
      const show = (v) => (v == null ? 'unrated' : `${v}${scale.labels?.[v] ? ` (${scale.labels[v]})` : ''}`);
      if (args.confirm !== true) {
        return { summary: `Preview only, nothing saved: ${who.name} as ${job.name}: ${show(line.value)} → ${show(args.rating)}. Ask the user; call again with confirm: true to save.`,
          data: { person: who.name, position: job.name, from: line.value, to: args.rating, scale } };
      }
      const r = await ctx.write('ratings.set', { userId: who.id, jobCodeId: job.id, value: args.rating, note: args.note || '' });
      return { summary: r.changed ? `${who.name} as ${job.name} is now ${show(r.value)}.` : 'Nothing changed.', data: { person: who.name, position: job.name, from: line.value, to: r.value } };
    },
  }),
];
