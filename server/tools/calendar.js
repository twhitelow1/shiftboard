// Import from a calendar page (core/calendar-import.js, server/calendar/): a venue's public events calendar turned
// into regular programming (shows that repeat each week) and dated events (one-offs). Managers with Edit programming.
//   read_events_calendar              reads the page (or the remembered one) and lists the suggestions; in Ask
//                                     ShiftBoard the person also gets a card with checkboxes and room pickers
//   import_programming_from_calendar  saves the ticked suggestions: without confirm it only shows what would be saved
import { z } from 'zod';
import { defineTool } from './registry.js';
import { confirmArg } from './helpers.js';
import { AppError } from '../../core/service.js';
import { canImportCalendar } from '../../core/calendar-import.js';
import { DOW_SHORT } from '../../core/time.js';

const can = (user, info) => canImportCalendar(user, info.settings || {});
const URL_ARG = z.string().max(2000).describe('The calendar page\'s address, e.g. https://venue.example/events (blank: the page Settings → Programming remembers)');

/** The suggestions, compact, for the model. */
function brief(imp) {
  const days = (d) => d.map((x) => DOW_SHORT[x]).join('/');
  return {
    importId: imp.id, url: imp.url, readFrom: imp.source, window: `${imp.from} to ${imp.to}`, eventsFound: imp.events,
    recurring: imp.recurring.map((r) => ({ key: r.key, name: r.name, room: r.room || 'NOT MATCHED: ask which room', ...(r.roomText ? { calendarSays: r.roomText } : {}),
      days: days(r.days), start: r.start, end: r.end || 'close', repeat: r.repeat, startDate: r.from, endDate: r.to || 'keeps running', datesMatched: r.count,
      ...(r.acts ? { actsVary: r.acts } : {}), ...(r.duplicateOf ? { duplicateOf: r.duplicateOf.name } : {}), ticked: r.include })),
    oneOffs: imp.oneOffs.slice(0, 60).map((o) => ({ key: o.key, name: o.name, date: o.date, start: o.start, end: o.end, room: o.room || 'not matched',
      ...(o.duplicateOf ? { duplicateOf: `${o.duplicateOf.name} (${o.duplicateOf.kind})` } : {}), ticked: o.include })),
  };
}

/** include/exclude/rooms from the model → the RPC's selections. */
function selectionsOf(imp, { include, exclude, rooms, changes }) {
  const sel = { recurring: {}, oneOffs: {} };
  const all = [...imp.recurring.map((x) => ['recurring', x]), ...imp.oneOffs.map((x) => ['oneOffs', x])];
  const find = (k) => all.find(([, x]) => x.key === k || x.name.toLowerCase() === String(k).toLowerCase());
  if (include?.length) for (const [kind, x] of all) sel[kind][x.key] = { include: false };
  for (const k of include || []) { const hit = find(k); if (!hit) throw new AppError(400, `No suggestion “${k}”`); sel[hit[0]][hit[1].key] = { include: true }; }
  for (const k of exclude || []) { const hit = find(k); if (hit) sel[hit[0]][hit[1].key] = { ...sel[hit[0]][hit[1].key], include: false }; }
  for (const r of rooms || []) { const hit = find(r.key); if (!hit) throw new AppError(400, `No suggestion “${r.key}”`); sel[hit[0]][hit[1].key] = { ...sel[hit[0]][hit[1].key], room: r.wholeVenue ? '*' : r.room || '' }; }
  for (const c of changes || []) {
    const hit = find(c.key);
    if (!hit || hit[0] !== 'recurring') throw new AppError(400, `No recurring suggestion “${c.key}”`);
    sel.recurring[hit[1].key] = { ...sel.recurring[hit[1].key], ...(c.name ? { name: c.name } : {}), ...(c.startDate !== undefined ? { from: c.startDate } : {}), ...(c.endDate !== undefined ? { to: c.endDate } : {}) };
  }
  return sel;
}
export { selectionsOf };

export default [
  defineTool({
    name: 'read_events_calendar',
    title: 'Read an events calendar page',
    description: 'Managers: read a venue\'s public events calendar web page (a "Schedule" or "Events" page, an iCal feed) and suggest regular programming '
      + 'from it: shows that repeat on the same weekday at about the same time (name, room, days, times, start date = first matched date, end date only when '
      + 'the calendar shows it ending) and one-off dated events. Rooms are matched to the venue\'s rooms; duplicates of existing programming or events are flagged '
      + 'and unticked. Nothing is saved. Use it when the user pastes a calendar or events page link, or asks to build programming from one. '
      + 'In the app the user gets a card to tick, pick rooms and import; summarize it in a sentence or two and ask about unmatched rooms.',
    input: { url: URL_ARG.optional() },
    can, consent: 'read',
    async handler(user, args, ctx) {
      if (!ctx.readCalendar) throw new AppError(400, 'Reading web pages isn’t available here');
      const out = await ctx.readCalendar(args.url || '');
      const imp = out.import;
      ctx.cards?.push({ calendarImportId: imp.id });
      const unmatched = imp.recurring.filter((r) => !r.room).length;
      return {
        summary: `Read ${imp.events} event(s) from ${imp.url} (${imp.source}): ${imp.recurring.length} recurring programming suggestion(s), ${imp.oneOffs.length} one-off event(s)`
          + `${unmatched ? `; ${unmatched} without a room (ask which room)` : ''}. Nothing saved.${ctx.cards ? ' The user sees a card with checkboxes, room pickers, Review & import and Import now.' : ' To save, call import_programming_from_calendar with importId.'}`,
        data: brief(imp),
      };
    },
  }),
  defineTool({
    name: 'import_programming_from_calendar',
    title: 'Import programming from a calendar page',
    description: 'Managers: save suggestions from read_events_calendar: the recurring ones as regular programming items (no staffing pars: managers set them) and '
      + 'the one-offs as confirmed events. Pass importId from read_events_calendar (or the page url to read it again). By default the ticked suggestions are '
      + 'saved; include: only these keys; exclude: leave these out; rooms: a room for a suggestion (every recurring one needs a room or wholeVenue). '
      + 'First call WITHOUT confirm: nothing is saved; you get what would be. Ask the user; call again with confirm: true only after they say yes.',
    input: {
      importId: z.string().max(80).optional(), url: URL_ARG.optional(),
      include: z.array(z.string().max(120)).max(200).optional().describe('Only these suggestion keys (or names)'),
      exclude: z.array(z.string().max(120)).max(200).optional().describe('Leave these out'),
      rooms: z.array(z.object({ key: z.string().max(120), room: z.string().max(60).optional(), wholeVenue: z.boolean().optional() })).max(200).optional(),
      changes: z.array(z.object({ key: z.string().max(120), name: z.string().max(60).optional(),
        startDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(), endDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional().describe('"" = keeps running') }))
        .max(100).optional().describe('A recurring suggestion\'s name, Start date or End date, changed'),
      confirm: confirmArg,
    },
    write: true, preview: true, idempotent: false, can, consent: 'programming',
    async handler(user, args, ctx) {
      let imp;
      if (args.importId) imp = (await ctx.read('programming.calendar.get', { id: args.importId })).import;
      else if (args.url && ctx.readCalendar) imp = (await ctx.readCalendar(args.url)).import;
      else imp = (await ctx.read('programming.calendar.get', {})).import;
      if (!imp) throw new AppError(404, 'Read the calendar page first (read_events_calendar)');
      const selections = selectionsOf(imp, args);
      if (args.confirm !== true) {
        const p = await ctx.read('programming.calendar.apply', { id: imp.id, selections, dryRun: true });
        return { summary: `Preview only, nothing saved: would add ${p.line} from ${imp.url}. Ask the user; call again with confirm: true to save.`, data: { importId: imp.id, ...p } };
      }
      const r = await ctx.write('programming.calendar.apply', { id: imp.id, selections });
      return { summary: `Added ${r.line} from ${imp.url}. Staffing pars are empty: set them in Settings → Programming.`, data: r };
    },
  }),
];
