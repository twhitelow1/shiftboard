// Smart import from Claude: a manager pastes a menu or a roster into Claude (or the Ask ShiftBoard chat) and it goes
// through the same pipeline as the web wizard (core/import-api.js): the same validation, the same duplicate checks,
// the same audit log. The import tools preview first (no confirm: nothing is saved, it runs like a read) and apply on
// a second call with confirm: true and a decision for every possible duplicate.
//
//   save_menu_item     one item: a new one is saved at once; changing an existing one needs confirm: true
//   import_menu_items  many items: preview → confirm
//   import_employees   many people: preview → confirm; never sets anyone's consent; invitations only when asked
import { z } from 'zod';
import { defineTool } from './registry.js';
import { AppError } from '../../core/service.js';

const text = (n) => z.string().max(n);
const list = (n) => z.union([z.string().max(2000), z.array(z.string().max(n)).max(40)]);
const confirmArg = z.boolean().optional().describe('true only after the user saw the preview and said yes');
const decisionsArg = z.array(z.object({
  row: z.string().max(12).describe('The row key from the preview, e.g. "r3"'),
  action: z.enum(['update', 'skip', 'new']).describe('update the existing record (give its id), skip the row, or create it as new (only if the user said so)'),
  id: z.string().max(80).optional().describe('With update: the existing record (a candidate id from the preview)'),
  keep: z.array(z.string().max(40)).max(20).optional().describe('With update: fields that keep their current value'),
  values: z.record(z.string(), z.any()).optional().describe('Where rows of the file disagree: { field: the value the user picked }'),
})).max(400).optional().describe('One decision for every row the preview marked "check" (possible duplicates)');

const MENU_ITEM = z.object({
  name: text(80), category: text(40).optional().describe('Menu section, e.g. "Starters" or "Cocktails"'), description: text(1500).optional(),
  ingredients: list(60).optional(), allergens: list(40).optional().describe('e.g. "milk, tree nuts" (only what the menu states)'),
  dietary: list(30).optional().describe('e.g. "gluten-free, vegan" or GF, V, VG, DF'), price: z.union([z.number(), text(20)]).optional(),
  sellingNotes: text(3000).optional(), pairings: text(1000).optional(), recipe: z.union([text(6000), z.array(text(600)).max(40)]).optional().describe('Recipe steps'),
  prepNotes: text(3000).optional(), nameEs: text(80).optional().describe('Spanish name'), descriptionEs: text(1500).optional().describe('Spanish description'),
  eightySixed: z.boolean().optional().describe('true: sold out (86’d)'),
});
const PERSON = z.object({
  name: text(80).optional().describe('The name they go by'), firstName: text(60).optional(), lastName: text(60).optional(),
  legalFirstName: text(60).optional(), legalLastName: text(60).optional(), email: text(120).optional(), phone: text(30).optional(),
  positions: list(60).optional().describe('e.g. "Server, Bartender"'), role: z.enum(['employee', 'supervisor', 'manager']).optional(),
  hireDate: text(20).optional(), birthday: text(20).optional(), employeeId: text(40).optional().describe('Employee or payroll ID'),
  payRate: z.union([z.number(), text(20)]).optional().describe('Hourly pay rate'), notes: text(1000).optional(), active: z.boolean().optional(),
});

const joinList = (v, sep = ', ') => (Array.isArray(v) ? v.join(sep) : v);
/** A tool item → a record for the pipeline (core/smart-import.js field names). */
function menuRecord(it, i) {
  const values = {};
  const put = (k, v) => { if (v !== undefined && v !== null) values[k] = String(v); };
  put('name', it.name); put('category', it.category); put('description', it.description); put('ingredients', joinList(it.ingredients));
  put('allergens', joinList(it.allergens)); put('dietary', joinList(it.dietary)); put('price', it.price); put('selling', it.sellingNotes);
  put('pairings', it.pairings); put('recipe', joinList(it.recipe, '\n')); put('prep', it.prepNotes); put('nameEs', it.nameEs); put('descriptionEs', it.descriptionEs);
  if (it.eightySixed !== undefined) put('eightySixed', it.eightySixed ? 'yes' : 'no');
  return { row: i + 1, values, present: Object.keys(values) };
}
function personRecord(p, i) {
  const values = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && k !== 'active') values[k] = String(joinList(v));
  if (p.active !== undefined) values.active = p.active ? 'yes' : 'no';
  return { row: i + 1, values, present: Object.keys(values) };
}
const decisionMap = (list) => Object.fromEntries((list || []).map((d) => [d.row, { action: d.action, id: d.id, keep: d.keep || [], values: d.values || {} }]));

/** A preview, small enough for the model: counts, then each row's status, what changes and what needs a decision. */
function compact(p) {
  return {
    counts: p.counts,
    ...(p.checks ? { possibleDuplicates: p.checks } : {}),
    ...(p.newPositions?.length ? { newPositions: p.newPositions } : {}), ...(p.newCategories?.length ? { newCategories: p.newCategories } : {}),
    rows: p.rows.slice(0, 150).map((r) => ({
      row: r.key, status: r.status, name: r.label,
      ...(r.match ? { matches: { id: r.match.id, name: r.match.name, by: r.match.by } } : {}),
      ...(r.changes.length ? { changes: r.changes.map((c) => `${c.field}: ${c.before || '—'} → ${c.after || '—'}`) } : {}),
      ...(r.problems.length ? { problems: r.problems.map((x) => [x.code, ...Object.values(x.params || {})].join(': ')) } : {}),
      ...(r.notes.length ? { notes: r.notes.map((x) => [x.code, ...Object.values(x.params || {})].join(': ')) } : {}),
      ...(r.status === 'check' ? {
        why: r.why,
        ...(r.candidates ? { candidates: r.candidates.map((c) => ({ id: c.id, name: c.name, ...(c.email ? { email: c.email } : {}), ...(c.category ? { category: c.category } : {}), confidence: c.confidence, reasons: c.reasons })) } : {}),
        ...(r.openConflicts ? { disagreeingRows: Object.fromEntries(r.openConflicts.map((f) => [f, r.conflicts[f]])) } : {}),
      } : {}),
    })),
  };
}
const checkRows = (p) => p.rows.filter((r) => r.status === 'check').map((r) => r.key);
const needDecisions = (p) => new AppError(409, `Not imported: ${checkRows(p).length} possible duplicate(s) need a decision (rows ${checkRows(p).join(', ')}). `
  + 'Show each one to the user with the existing record, ask, and call again with confirm: true and decisions: [{ row, action: "update" (with id) | "skip" | "new" }].');
const countsLine = (c) => `${c.new} new, ${c.update} to update, ${c.unchanged} unchanged${c.check ? `, ${c.check} possible duplicate(s) to check` : ''}${c.problem ? `, ${c.problem} with problems` : ''}${c.skip ? `, ${c.skip} skipped` : ''}`;

export default [
  defineTool({
    name: 'save_menu_item',
    title: 'Save a menu item',
    description: 'Managers: add a dish or drink to the menu study guide (Training → Menu), or update one. A new item is saved at once. '
      + 'If an item with that name (or a likely duplicate) is already on the menu, nothing is saved: you get it back to show the user. To change an existing item, '
      + 'pass its itemId and confirm: true after the user agrees; to add it as a separate item anyway, pass createNew: true. Empty fields keep what\'s there.',
    input: { itemId: z.string().max(80).optional().describe('The existing item to change (from search_menu or a previous answer)'), ...MENU_ITEM.shape, createNew: z.boolean().optional(), confirm: confirmArg },
    write: true, role: 'manager', feature: 'training', consent: 'menuEdit', idempotent: true,
    async handler(user, args, ctx) {
      const { itemId, createNew, confirm, ...item } = args;
      const rec = { ...menuRecord(item, 0), ...(itemId ? { id: itemId } : {}) };
      const p = await ctx.read('menu.importPreview', { records: [rec], options: { createCategories: true } });
      const r = p.rows[0];
      if (itemId && r.match?.id !== itemId) throw new AppError(404, 'Menu item not found');
      if (r.status === 'problem') return { summary: `Not saved: ${r.problems.map((x) => x.code).join(', ')}.`, data: compact(p) };
      if (r.status === 'check' && !createNew) {
        return { summary: `Not saved: “${item.name}” looks like ${r.candidates.map((c) => `“${c.name}” (${c.category}, ${c.confidence})`).join(' or ')} already on the menu. Ask the user: update that one (call again with its itemId and confirm: true) or add a separate item (createNew: true).`, data: compact(p) };
      }
      if (r.status === 'unchanged') return { summary: `“${r.label}” is already on the menu with these details. Nothing to change.`, data: compact(p) };
      if (r.status === 'update' && confirm !== true) throw new AppError(409, `That changes “${r.match.name}” (${r.changes.map((c) => c.field).join(', ')}). Ask the user, then call again with confirm: true.`);
      const decisions = r.status === 'check' ? { [r.key]: { action: 'new' } } : {};
      const out = await ctx.write('menu.importApply', { records: [rec], options: { createCategories: true }, decisions, via: ctx.via, source: 'claude' });
      const done = out.ids[0];
      return { summary: done?.status === 'update' ? `Updated “${r.label}”.` : `Added “${item.name}” to the menu${item.category ? ` under ${item.category}` : ''}.`, data: { itemId: done?.id || null, changes: r.changes } };
    },
  }),
  defineTool({
    name: 'import_menu_items',
    title: 'Import menu items',
    description: 'Managers: import many dishes and drinks into the menu study guide at once (e.g. a menu the user pasted). '
      + 'First call WITHOUT confirm: you get a preview (new, update with field-by-field changes, unchanged, problems, and possible duplicates of items already on the menu). Nothing is saved. '
      + 'Show the user the preview, especially every "check" row with the existing item next to the new one, and ask. Then call again with the same items, confirm: true, '
      + 'and a decision for every check row (update the existing one, skip, or new only if the user says it\'s a different item). Empty fields keep what\'s there. Missing menu sections are created.',
    input: {
      items: z.array(MENU_ITEM).min(1).max(150), createCategories: z.boolean().optional().describe('Create menu sections that don\'t exist yet (default true)'),
      decisions: decisionsArg, confirm: confirmArg,
    },
    write: true, preview: true, role: 'manager', feature: 'training', consent: 'menuEdit', idempotent: true,
    async handler(user, args, ctx) {
      const records = args.items.map(menuRecord);
      const options = { createCategories: args.createCategories !== false };
      const decisions = decisionMap(args.decisions);
      const p = await ctx.read('menu.importPreview', { records, options, decisions });
      if (args.confirm !== true) {
        return { summary: `Preview only, nothing saved: ${countsLine(p.counts)}. Show it to the user; to import, call again with confirm: true${p.checks ? ' and a decision for each possible duplicate' : ''}.`, data: compact(p) };
      }
      if (p.checks) throw needDecisions(p);
      const out = await ctx.write('menu.importApply', { records, options, decisions, via: ctx.via, source: 'claude' });
      return { summary: `Menu import done: ${out.created} added, ${out.updated} updated, ${out.unchanged} unchanged, ${out.skipped} skipped${out.failed.length ? `, ${out.failed.length} failed` : ''}.`, data: { ...out, ids: undefined } };
    },
  }),
  defineTool({
    name: 'import_employees',
    title: 'Import people',
    description: 'Managers: add people to the team or update them, many at once (e.g. a roster the user pasted). Matches people by email, employee ID, phone, then name. '
      + 'First call WITHOUT confirm: you get a preview (new, update with field-by-field changes, unchanged, problems, possible duplicates). Nothing is saved. Show it to the user, '
      + 'especially every "check" row with the existing person next to the new one, and ask. Then call again with the same people, confirm: true and a decision for every check row. '
      + 'Never imports Admin roles and never sets anyone\'s text or email consent (people choose that themselves). New people sign in through an invitation email: '
      + 'set sendInvitations: true only if the user asks to send them now. Empty fields keep what\'s there; positions are added, never removed.',
    input: {
      people: z.array(PERSON).min(1).max(150), createPositions: z.boolean().optional().describe('Create positions that don\'t exist yet (default false: they\'re problems)'),
      sendInvitations: z.boolean().optional().describe('Email new people their invitation now (only if the user asked)'), decisions: decisionsArg, confirm: confirmArg,
    },
    write: true, preview: true, role: 'manager', consent: 'teamEdit', idempotent: true,
    async handler(user, args, ctx) {
      const records = args.people.map(personRecord);
      const options = { createPositions: args.createPositions === true, invite: args.sendInvitations === true };
      const decisions = decisionMap(args.decisions);
      const p = await ctx.read('employees.importPreview', { records, options, decisions });
      if (args.confirm !== true) {
        return { summary: `Preview only, nothing saved: ${countsLine(p.counts)}. Show it to the user; to import, call again with confirm: true${p.checks ? ' and a decision for each possible duplicate' : ''}.`, data: compact(p) };
      }
      if (p.checks) throw needDecisions(p);
      const out = await ctx.write('employees.importApply', { records, options, decisions, via: ctx.via, source: 'claude' });
      let invited = null;
      if (options.invite && out.invite?.length) invited = ctx.invite ? await ctx.invite(out.invite) : { sent: 0, noEmail: out.invite.length, failed: 0 };
      return {
        summary: `Team import done: ${out.created} added, ${out.updated} updated, ${out.unchanged} unchanged, ${out.skipped} skipped${out.failed.length ? `, ${out.failed.length} failed` : ''}`
          + `${invited ? `; ${invited.sent} invitation(s) sent` : options.invite ? '' : '; no invitations sent (Team → Invite when ready)'}.`,
        data: { ...out, ids: undefined, ...(invited ? { invited } : {}) },
      };
    },
  }),
];
