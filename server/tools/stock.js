// Stock lists (core/stock.js) and the product catalog they share with the 86 List (core/products.js).
//   get_stock_lists     my lists (what to bring, how many, where it's kept, what's done), or for managers every open
//                       list, the templates or the done ones
//   create_stock_list   managers (whoever may create lists): a list from catalog products, for a person, a position or
//                       a room on a date, with a due time. confirm: true (the people it's for are told)
//   add_product         anyone with Stock lists: the first call (no confirm) only checks for likely duplicates by the
//                       smart import's rules; the second (confirm: true) adds it, marked "Added by" them for review.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { AppError } from '../../core/service.js';
import { canManageLists } from '../../core/stock.js';
import { lookupOf, findPerson, findPosition, confirmArg } from './helpers.js';
import { resolveDate } from './dates.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const lineOut = (x) => ({ product: x.name, qty: x.qty, ...(x.unit ? { unit: x.unit } : {}), ...(x.size ? { size: x.size } : {}), ...(x.location ? { location: x.location } : {}),
  ...(x.note ? { note: x.note } : {}), state: x.state || 'to do', ...(x.state === 'short' ? { brought: x.brought } : {}), ...(x.by ? { by: x.by.name } : {}) });
const listOut = (l) => ({ id: l.id, name: l.name, ...(l.date ? { date: l.date } : {}), ...(l.due ? { due: l.due } : {}), status: l.status, for: l.assignLabel || null,
  progress: `${l.counts.done}/${l.counts.lines}`, ...(l.counts.short ? { short: l.counts.short } : {}), ...(l.counts.out ? { out: l.counts.out } : {}), ...(l.overdue ? { overdue: true } : {}) });
const productOut = (p) => ({ id: p.id, name: p.name, category: p.category, ...(p.unit ? { unit: p.unit } : {}), ...(p.size ? { size: p.size } : {}), ...(p.location ? { location: p.location } : {}),
  ...(p.review === 'new' ? { addedBy: p.addedBy?.name || null, waitingForReview: true } : {}), ...(p.score ? { likeness: p.score, why: p.reasons } : {}) });

const PRODUCT = {
  name: z.string().min(1).max(80).describe('The product, as people say it, e.g. "Harbor Light Silver Rum 1L" or "cocktail napkins"'),
  aliases: z.array(z.string().max(40)).max(10).optional().describe('What people also call it, e.g. ["Titos", "house vodka"]'),
  category: z.enum(['spirits', 'beer', 'wine', 'mixers', 'garnish', 'glassware', 'smallwares', 'paper', 'cleaning', 'dry', 'other']).optional()
    .describe('spirits, beer, wine, mixers, garnish, glassware, smallwares, paper (and disposables), cleaning, dry (kitchen dry goods) or other'),
  unit: z.string().max(20).optional().describe('How it\'s counted: bottle, case, sleeve, box, each, lb, bag, keg, can, gallon, roll, rack'),
  size: z.string().max(30).optional().describe('e.g. "1 L" or "750 ml"'),
  location: z.string().max(80).optional().describe('Where it\'s kept, e.g. "Walk-in, shelf 3" or "Liquor room"'),
  supplier: z.string().max(80).optional(), notes: z.string().max(300).optional(),
};

export default [
  defineTool({
    name: 'get_stock_lists',
    title: 'Stock lists',
    description: 'Stock lists (restock lists): what to bring up, how many, where each product is kept and what\'s done. '
      + 'scope "mine" (default): the lists assigned to me, with every product. Managers: "all" (every open list and its progress), "templates", or "history" (done lists, last 30 days, with shorts and outs).',
    input: { scope: z.enum(['mine', 'all', 'templates', 'history']).optional() },
    feature: 'stock', consent: 'read',
    async handler(user, args, ctx) {
      const scope = args.scope || 'mine';
      const r = await ctx.read('stock.lists.list', { scope });
      if (scope !== 'mine' && !r.canManage) throw new AppError(403, 'Supervisors and managers only');
      const detail = scope === 'mine' || r.lists.length <= 5 ? await ctx.readAll(r.lists.slice(0, 10).map((l) => ['stock.list.get', { id: l.id }])) : [];
      const lists = r.lists.map((l) => {
        const d = detail.find((x) => x.id === l.id);
        return { ...listOut(l), ...(d ? { products: d.lines.map(lineOut) } : {}) };
      });
      return { summary: `${lists.length} ${scope === 'templates' ? 'template' : 'stock list'}(s)${scope === 'mine' ? ' assigned to you' : ''}.`, data: { scope, lists } };
    },
  }),
  defineTool({
    name: 'create_stock_list',
    title: 'Create a stock list',
    description: 'Supervisors and managers: make a stock list (e.g. "Friday bar restock") from products in the catalog, each with how many, and assign it to a person, '
      + 'a position (everyone scheduled in it that day, e.g. all Barbacks) or a room (whoever is on shift there that day), with a date and a due time. '
      + 'Products must already be in the catalog (add_product first). Or save it as a template (no assignment) to reuse. The people it\'s for are notified: '
      + 'tell the user exactly what will be created and for whom, ask, and call with confirm: true only after they say yes.',
    input: {
      name: z.string().min(1).max(60),
      products: z.array(z.object({ name: z.string().min(1).max(80), qty: z.number().positive().max(9999).default(1), note: z.string().max(140).optional() })).min(1).max(150),
      template: z.boolean().optional().describe('true: save it as a reusable template (no date or assignment)'),
      date: z.string().max(40).optional().describe('The day (default today): YYYY-MM-DD, "today", "tomorrow" or a weekday'),
      due: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Due time, HH:MM 24-hour'),
      person: z.string().max(80).optional().describe('Assign to this person (name)'),
      position: z.string().max(60).optional().describe('Or to everyone in this position that day, e.g. "Barback"'),
      room: z.string().max(60).optional().describe('Or to whoever is on shift in this room that day'),
      notes: z.string().max(300).optional(),
      confirm: confirmArg,
    },
    write: true, confirm: true, feature: 'stock', consent: 'stockManage', role: 'supervisor',
    can: (user, info) => canManageLists(user, info.settings || {}),
    async handler(user, args, ctx) {
      const cat = await ctx.read('products.list');
      const lines = [];
      const unknown = [];
      for (const p of args.products) {
        const exact = cat.products.filter((x) => norm(x.name) === norm(p.name) || x.id === p.name);
        let hit = exact.length === 1 ? exact[0] : null;
        if (!hit) {
          const m = (await ctx.read('products.matches.get', { name: p.name })).matches;
          hit = m.length && m[0].score >= 85 && (m.length === 1 || m[1].score < m[0].score) ? m[0] : null;
        }
        if (hit) lines.push({ productId: hit.id, qty: p.qty, note: p.note || '' }); else unknown.push(p.name);
      }
      if (unknown.length) throw new AppError(400, `Not in the product catalog: ${unknown.join(', ')}. Add them with add_product first (or use the catalog's names).`);
      let assign = null;
      if (!args.template) {
        const look = await lookupOf(ctx);
        if (args.person) assign = { type: 'person', userId: findPerson(look, args.person).id };
        else if (args.position) assign = { type: 'position', jobCodeId: findPosition(look, args.position).id };
        else if (args.room) {
          const opts = await ctx.read('stock.options.get');
          const room = opts.rooms.find((r) => norm(r) === norm(args.room)) || opts.rooms.find((r) => norm(r).includes(norm(args.room)));
          if (!room) throw new AppError(404, `No room matches “${args.room}”. Rooms: ${opts.rooms.join(', ')}`);
          assign = { type: 'room', room };
        }
      }
      const date = args.template ? '' : resolveDate(args.date || 'today', ctx.today());
      const out = await ctx.write('stock.save', { kind: args.template ? 'template' : 'list', name: args.name, notes: args.notes || '', lines, ...(args.template ? {} : { date, due: args.due || '', assign }) });
      return {
        summary: args.template ? `Template “${out.name}” saved with ${out.lines.length} product(s).`
          : `Stock list “${out.name}” created for ${out.assignLabel || 'nobody yet'} on ${out.date}${out.due ? ` (due ${out.due})` : ''} with ${out.lines.length} product(s)${out.notified ? `; ${out.notified} people notified` : ''}.`,
        data: { id: out.id, name: out.name, date: out.date, due: out.due, for: out.assignLabel, assignees: out.assignees.map((a) => a.name), products: out.lines.map(lineOut) },
      };
    },
  }),
  defineTool({
    name: 'add_product',
    title: 'Add a product',
    description: 'Add a product to the catalog Stock lists and the 86 List share (anyone can; a manager reviews what staff add). '
      + 'First call WITHOUT confirm: nothing is saved; you get any likely duplicates already in the catalog (same name, a size on the end, a plural, "&"/"and", a typo). '
      + 'Show them to the user and suggest using the existing one. Only if they still want a new product, call again with confirm: true (and createNew: true when there were likely duplicates).',
    input: { ...PRODUCT, createNew: z.boolean().optional().describe('Add it even though likely duplicates exist (only if the user said so)'), confirm: confirmArg },
    write: true, preview: true, feature: 'stock', consent: 'stock', idempotent: false,
    async handler(user, args, ctx) {
      const { confirm, createNew, ...fields } = args;
      const m = (await ctx.read('products.matches.get', { name: fields.name })).matches;
      const exact = m.find((x) => x.score === 100);
      if (confirm !== true) {
        return {
          summary: m.length ? `Preview only, nothing saved: “${fields.name}” looks like ${m.map((x) => `“${x.name}” (${x.confidence})`).join(' or ')} already in the catalog. Suggest using that one; add it anyway only if the user says it's different (confirm: true, createNew: true).`
            : `Preview only, nothing saved: no likely duplicates of “${fields.name}”. To add it, call again with confirm: true.`,
          data: { product: fields, likelyDuplicates: m.map(productOut) },
        };
      }
      if (exact && !createNew) throw new AppError(409, `“${exact.name}” is already in the catalog. Use it instead.`);
      if (m.length && !createNew) throw new AppError(409, `Likely duplicates: ${m.map((x) => x.name).join(', ')}. Ask the user; call again with createNew: true only if it's a different product.`);
      const r = await ctx.write('products.add', { ...fields, force: true });
      return { summary: `Added “${r.product.name}” to the catalog${r.product.review === 'new' ? ' (a manager will review it)' : ''}.`, data: { product: productOut(r.product) } };
    },
  }),
];
