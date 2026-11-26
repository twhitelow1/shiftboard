// Training: the menu study guide (what's in a dish, allergens, the recipe if your position may see it), the
// employee manual, and the manager on duty. menu.* already leaves out what a person's position may not see.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { dateArg } from './helpers.js';
import { resolveDate } from './dates.js';
import { canManageSchedule } from '../../core/roles.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (q) => norm(q).split(/\s+/).filter((w) => w.length > 1);
const hitScore = (text, ws) => ws.reduce((t, w) => t + (text.includes(w) ? 1 : 0), 0);
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

export default [
  defineTool({
    name: 'search_menu',
    title: 'Search the menu',
    description: 'Look up dishes and drinks in the menu study guide: description, key ingredients, allergens, dietary tags, whether it\'s 86\'d, selling notes, '
      + 'and the recipe and prep notes when your position may see them. Search by name, ingredient or category, and optionally leave out an allergen ("without nuts").',
    input: {
      query: z.string().max(80).optional().describe('Name, ingredient or category, e.g. "burrata" or "cocktails"'),
      withoutAllergen: z.string().max(40).optional().describe('Leave out items with this allergen, e.g. "tree-nuts", "gluten", "shellfish"'),
    },
    feature: 'training', consent: 'menu',
    async handler(user, args, ctx) {
      const m = await ctx.read('menu.list');
      const ws = words(args.query);
      const avoid = norm(args.withoutAllergen);
      const scored = m.items.map((it) => {
        const text = norm([it.name, it.es?.name, it.category, it.description, ...(it.keyIngredients || []), ...(it.dietary || [])].join(' '));
        return { it, score: ws.length ? hitScore(text, ws) + (norm(it.name).includes(norm(args.query)) ? 3 : 0) : 1 };
      }).filter((x) => x.score > 0 && (!avoid || !(x.it.allergens || []).some((a) => norm(a).includes(avoid) || avoid.includes(norm(a)))))
        .sort((a, b) => b.score - a.score).slice(0, 10);
      const items = scored.map(({ it }) => ({
        id: it.id, name: it.name, category: it.category, description: it.description, keyIngredients: it.keyIngredients, allergens: it.allergens, dietary: it.dietary,
        ...(it.eightySixed ? { eightySixed: true } : {}), ...(it.price != null ? { price: it.price } : {}),
        ...(it.selling && (it.selling.notes || it.selling.pairings) ? { selling: it.selling } : {}),
        ...(it.recipe ? { recipe: it.recipe } : {}), ...(it.prep?.notes ? { prep: it.prep } : {}),
      }));
      return { summary: `${items.length} menu item(s) found${args.query ? ` for “${args.query}”` : ''}.`, data: { items } };
    },
  }),
  defineTool({
    name: 'search_handbook',
    title: 'Search the employee manual',
    description: 'Search the restaurant\'s employee manual (policies, the call-out procedure, dress code…) and return the matching pages\' text.',
    input: { query: z.string().min(1).max(80).describe('What to look for, e.g. "call out" or "dress code"') },
    feature: 'training', consent: 'menu',
    async handler(user, args, ctx) {
      const list = await ctx.read('manual.list');
      const pages = list.sections.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));
      const bodies = pages.length ? await ctx.readAll(pages.map((p) => ['manual.get', { id: p.id }])) : [];
      const ws = words(args.query);
      const hits = bodies.map((p) => ({ p, score: hitScore(norm(`${p.title} ${p.sectionTitle}`), ws) * 3 + hitScore(norm(`${p.body} ${p.es?.body || ''}`), ws) + (p.isCallOut && /call|out|sick|late|falt|enferm/.test(norm(args.query)) ? 5 : 0) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4)
        .map(({ p }) => ({ id: p.id, section: p.sectionTitle, title: p.title, text: clip(p.body, 3000), ...(p.isCallOut ? { callOutProcedure: true } : {}), readByYou: !!p.my?.current }));
      return { summary: hits.length ? `${hits.length} manual page(s) match “${args.query}”.` : `Nothing in the manual matches “${args.query}”.`, data: { pages: hits } };
    },
  }),
  defineTool({
    name: 'get_manager_on_duty',
    title: 'Manager on duty',
    description: 'Who is in charge right now (or next today), with their phone number, plus the call-out line. Managers can ask about another date.',
    input: { date: dateArg('Managers: another day').optional() },
    feature: 'training', consent: 'read',
    async handler(user, args, ctx) {
      const date = args.date && canManageSchedule(user) ? resolveDate(args.date, ctx.today()) : undefined;
      const m = await ctx.read('mod.get', date ? { date } : {});
      const p = m.person;
      const data = { date: m.date, status: m.status, person: p ? { name: p.name, phone: p.phone || null, shift: p.shift } : null, callOutPhone: m.callOutPhone || null, alsoOn: (m.alsoOn || []).map((x) => x.name) };
      const word = { now: 'on duty now', next: 'on next today', planned: 'scheduled', override: 'in charge', none: '' }[m.status] || '';
      return { summary: p ? `${p.name} is ${word}${p.phone ? ` (${p.phone})` : ''}.` : 'No manager is on the schedule for that day.', data };
    },
  }),
];
