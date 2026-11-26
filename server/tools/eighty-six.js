// The 86 List: what's out or running low, reporting it, marking it back, and (managers) the history.
// eightySix.* decides who may see and report on each list; marking something 86'd tells the people working today.
import { z } from 'zod';
import { defineTool } from './registry.js';
import { AppError } from '../../core/service.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const itemOut = (i) => ({ id: i.id, name: i.name, status: i.status, ...(i.count != null ? { count: i.count } : {}), ...(i.note ? { note: i.note } : {}), ...(i.area ? { area: i.area } : {}), reportedBy: i.updatedBy?.name || i.reportedBy?.name || '', at: i.updatedAt || i.reportedAt });

function listFor(board, { list, menuItemId }) {
  const lists = board.lists;
  if (list) {
    const hit = lists.filter((l) => norm(l.name).includes(norm(list)) || norm(l.nameEs).includes(norm(list)) || l.id === list);
    if (hit.length !== 1) throw new AppError(400, hit.length ? `More than one list matches “${list}”` : `No 86 list matches “${list}”. Lists: ${lists.map((l) => l.name).join(', ')}`);
    return hit[0];
  }
  const can = lists.filter((l) => l.canReport);
  return (menuItemId && can.find((l) => l.suggest.includes(menuItemId))) || can[0] || lists[0];
}

export default [
  defineTool({
    name: 'get_86_list',
    title: '86 List',
    description: 'What\'s 86\'d (out) or running low right now, on each 86 list you can see (e.g. Bar, Kitchen), and which lists you can report on.',
    feature: 'eightySix', consent: 'read',
    async handler(user, args, ctx) {
      const b = await ctx.read('eightySix.board.get');
      const lists = b.lists.map((l) => ({ id: l.id, name: l.name, canReport: l.canReport, items: l.items.map(itemOut) }));
      const out = lists.reduce((t, l) => t + l.items.filter((i) => i.status === 'out').length, 0);
      const low = lists.reduce((t, l) => t + l.items.filter((i) => i.status === 'low').length, 0);
      return { summary: `${out} item(s) 86'd and ${low} running low.`, data: { lists } };
    },
  }),
  defineTool({
    name: 'report_86_item',
    title: 'Report an 86',
    description: 'Report something as 86\'d (out) or running low on an 86 list. Menu items are matched by name; anything else is fine too ("lemons"). '
      + 'Marking something 86\'d notifies the people working today who can see that list. Reporting the same thing again updates it.',
    input: {
      item: z.string().min(1).max(80).describe('What\'s out, e.g. "Burrata salad" or "limes"'), status: z.enum(['out', 'low']).default('out').describe('"out" (86\'d) or "low" (running low)'),
      list: z.string().max(60).optional().describe('Which list, e.g. "Bar" or "Kitchen" (default: the one that fits the item)'),
      count: z.number().int().min(0).max(999).optional().describe('For running low: how many are left'), note: z.string().max(140).optional(),
    },
    write: true, feature: 'eightySix', consent: 'eightySix', idempotent: true,
    async handler(user, args, ctx) {
      const b = await ctx.read('eightySix.board.get');
      const menuId = Object.entries(b.menu || {}).find(([, m]) => norm(m.name) === norm(args.item) || norm(m.nameEs) === norm(args.item))?.[0] || null;
      const list = listFor(b, { list: args.list, menuItemId: menuId });
      const r = await ctx.write('eightySix.report', { listId: list.id, ...(menuId ? { menuItemId: menuId } : { name: args.item }), status: args.status, ...(args.count != null ? { count: args.count } : {}), note: args.note || '' });
      return { summary: `${r.item.name} marked ${args.status === 'out' ? '86\'d' : 'running low'} on ${list.name}${r.notified ? `; ${r.notified} people notified` : ''}.`, data: { list: list.name, item: itemOut(r.item), updated: r.updated, notified: r.notified } };
    },
  }),
  defineTool({
    name: 'mark_back_in_stock',
    title: 'Back in stock',
    description: 'Take something off the 86 list because it\'s back in stock (by its name, or its id from get_86_list).',
    input: { item: z.string().min(1).max(80).describe('The item\'s name or id'), list: z.string().max(60).optional() },
    write: true, feature: 'eightySix', consent: 'eightySix', destructive: false, idempotent: true,
    async handler(user, args, ctx) {
      const b = await ctx.read('eightySix.board.get');
      const lists = args.list ? [listFor(b, { list: args.list })] : b.lists;
      const hits = lists.flatMap((l) => l.items.filter((i) => i.id === args.item || norm(i.name) === norm(args.item) || norm(i.nameEs) === norm(args.item)).map((i) => ({ i, l })));
      const loose = hits.length ? hits : lists.flatMap((l) => l.items.filter((i) => norm(i.name).includes(norm(args.item))).map((i) => ({ i, l })));
      if (!loose.length) throw new AppError(404, `“${args.item}” isn’t on the 86 list`);
      if (loose.length > 1) throw new AppError(400, `More than one item matches “${args.item}”: ${loose.map((x) => `${x.i.name} (${x.l.name})`).join(', ')}`);
      const { i, l } = loose[0];
      await ctx.write('eightySix.clear', { id: i.id });
      return { summary: `${i.name} is back in stock (off the ${l.name} list).`, data: { item: i.name, list: l.name } };
    },
  }),
  defineTool({
    name: 'get_86_history',
    title: '86 history',
    description: 'Managers: what came off and went on the 86 lists over the last days (default 30), and what was 86\'d most often (useful for ordering).',
    input: { days: z.number().int().min(1).max(365).optional() },
    role: 'manager', feature: 'eightySix', consent: 'reports',
    async handler(user, args, ctx) {
      const h = await ctx.read('eightySix.history.get', { days: args.days || 30 });
      const entries = h.entries.slice(0, 60).map((e) => ({ name: e.name, list: e.listName, status: e.status, outAt: e.outAt, active: e.active, clearedAt: e.clearedAt, clearedBy: e.clearedBy?.name || null }));
      return { summary: `${h.entries.length} 86 entries in the last ${h.days} days; most often: ${h.top.slice(0, 3).map((t) => `${t.name} (${t.times})`).join(', ') || 'none'}.`, data: { days: h.days, top: h.top.map((t) => ({ name: t.name, times: t.times, lastAt: t.lastAt, lists: t.lists })), entries } };
    },
  }),
];
