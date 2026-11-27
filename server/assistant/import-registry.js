// Ask ShiftBoard's file imports: the one list of what an attached file can be imported as. Each target says how
// likely a document is to be one of its files (cheap, local), reads it into records with ShiftBoard's existing
// parsers (falling back to the same "Read it with AI" path the target's own import uses), previews it through the
// target's existing preview RPC (with its duplicate checks), and applies it through its existing apply RPC. Nothing
// here writes on its own: server/assistant/imports.js shows the preview as a card, and only the manager's tap applies.
//
//   registerImportTarget({
//     id, order,                       'menu', and where it's listed among the choices
//     label: { en, es },               what it is ("Menu", "Menú"); phrase: { en, es } in a sentence ("a menu", "un menú")
//     about,                           one line for the AI classifier ("a restaurant menu: dishes and drinks…")
//     wizard,                          the web wizard "Review & import" opens: 'smartImport' | 'beo' | 'floor' | 'schedule' | 'guests'
//     allowed(user, has),              the person may run it (role + plan + Roles & features)
//     detect(doc, { hint }) → 0–100,   local signals only (core/import-detect.js)
//     parse(doc, x, { part }) → { payload, done, part?, parts?, source, notes?, lowConfidence? }   x: { ctx, ai, lang, user }
//     preview(payload, x) → { counts, checks, problems, line, details }   the target's own preview (nothing saved)
//     apply(payload, x) → { line }      the target's own apply RPC, as the person, via: 'assistant'
//     importNow: true,                 "Import now" can be offered (when the preview has no checks and no problems)
//   })
//
// Smart-import targets (core/smart-import.js TARGETS: employees, menu, products, and any added later) register
// themselves below from their FIELDS and their <target>.importPreview / importApply RPCs, so a new smart-import target
// shows up here without code. A target with its own reader overrides it with registerImportTarget (same id).
// The availability sheet (core/availability.js) is one of them: its hints are below, and since its colour-coded
// workbook is read by its own wizard steps, "Review & import" hands that wizard the file itself (needsFile) and
// "Import now" isn't offered for it.
import { canManageSchedule, canManageEvents } from '../../core/roles.js';
import {
  TARGETS, FIELDS, findHeaderRow, autoMap, rowsToRecords, menuFromText, menuFromLabeledText, rosterFromText, looksTabular, textRows, MAX_ROWS,
} from '../../core/smart-import.js';
import { parseBeos, beoWarnings, cleanBeoEvent } from '../../core/beo-import.js';
import { dedupeBeos } from '../../core/beo-match.js';
import { parseSchedule, matchPeople } from '../../core/importer.js';
import { readFile as readGuestFile, readReservations, readReviews, mappingProblems, chunkItems } from '../../core/guest-csv.js';
import { readPlanCsv } from '../../core/floor-plan.js';
import { incomingFromCsv, incomingFromImage } from '../../core/floor-import.js';
import { parseCsv } from '../../core/adp-csv.js';
import { wordHits, headerHits, chunkText } from '../../core/import-detect.js';
import { readRecordsWithAi, readBeoWithAi, readFloorWithAi } from './import-ai.js';

const REGISTRY = new Map();
/** Add (or replace) an import target. */
export function registerImportTarget(def) {
  for (const k of ['id', 'label', 'detect', 'parse', 'preview', 'allowed']) if (!def?.[k]) throw new Error(`import target needs ${k}`);
  REGISTRY.set(def.id, { order: 50, importNow: false, wizard: null, about: '', ...def });
}
/** Every target, in order. */
export const importTargets = () => [...REGISTRY.values()].sort((a, b) => a.order - b.order);
export const importTarget = (id) => REGISTRY.get(id) || null;

const L = (lang, en, es) => (lang === 'es' ? es : en);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sheetText = (rows) => rows.map((r) => r.join('\t')).join('\n');

// ---------------------------------------------------------------- the preview's line

/** "6 updates, 43 new, 2 possible duplicates to check" in the person's language, from smart-import counts. */
export function countsLine(c, lang) {
  const parts = [];
  if (c.update) parts.push(L(lang, plural(c.update, 'update', 'updates'), plural(c.update, 'actualización', 'actualizaciones')));
  if (c.new) parts.push(L(lang, `${c.new} new`, plural(c.new, 'nuevo', 'nuevos')));
  if (c.unchanged) parts.push(L(lang, `${c.unchanged} unchanged`, plural(c.unchanged, 'sin cambios', 'sin cambios')));
  if (c.check) parts.push(L(lang, `${plural(c.check, 'possible duplicate', 'possible duplicates')} to check`, `${plural(c.check, 'posible duplicado', 'posibles duplicados')} por revisar`));
  if (c.problem) parts.push(L(lang, `${plural(c.problem, 'row', 'rows')} with problems`, `${plural(c.problem, 'fila', 'filas')} con problemas`));
  if (c.skip) parts.push(L(lang, `${c.skip} skipped`, plural(c.skip, 'omitido', 'omitidos')));
  return parts.join(', ') || L(lang, 'nothing to change', 'nada que cambiar');
}

// ---------------------------------------------------------------- smart import (menu, employees, products, …)

const ROLE_FEATURE = { menu: 'training', employees: 'team', products: 'stock', availability: 'team' };
const PLAN_FEATURE = { menu: 'training', products: 'stock' };
const SMART = {
  menu: {
    label: { en: 'Menu', es: 'Menú' }, phrase: { en: 'a menu', es: 'un menú' }, noun: [['dish', 'dishes'], ['platillo', 'platillos']], group: [['section', 'sections'], ['sección', 'secciones']], order: 10,
    about: 'menu items: dishes and drinks with descriptions, prices, allergens (a menu, a menu spreadsheet, a kitchen/FOH dish guide)',
    sheet: ['menu', 'food', 'drinks', 'cocktails', 'dinner', 'lunch', 'brunch', 'dessert', 'desserts', 'wine', 'carta', 'bebidas', 'comida', 'platillos'],
    words: ['appetizers', 'starters', 'entrees', 'mains', 'desserts', 'sides', 'cocktails', 'salads', 'menu', 'allergens', 'gluten free', 'vegan', 'entradas', 'postres', 'platos fuertes', 'bebidas'],
    hint: ['menu', 'menú', 'dishes', 'platillos', 'carta', 'food', 'drinks'],
    distinct: ['description', 'price', 'allergens', 'dietary', 'ingredients', 'pairings', 'recipe', 'selling', 'prep', 'nameEs', 'descriptionEs', 'eightySixed'],
    options: { createCategories: true },
  },
  employees: {
    label: { en: 'Team roster', es: 'Lista del equipo' }, phrase: { en: 'a team roster', es: 'una lista del equipo' }, noun: [['person', 'people'], ['persona', 'personas']], group: [['position', 'positions'], ['puesto', 'puestos']], order: 20,
    about: 'an employee roster: people with names, emails, phone numbers, positions, hire dates',
    sheet: ['roster', 'team', 'staff', 'employees', 'crew', 'people', 'personal', 'equipo', 'empleados', 'plantilla'],
    words: ['employee', 'email', 'phone', 'hire date', 'position', 'server', 'bartender', 'cook', 'empleado', 'correo', 'telefono', 'puesto'],
    hint: ['roster', 'team', 'staff', 'employees', 'people', 'equipo', 'empleados', 'personal'],
    distinct: ['email', 'phone', 'positions', 'role', 'hireDate', 'birthday', 'employeeId', 'payRate', 'firstName', 'lastName', 'legalFirstName', 'legalLastName'],
    options: { createPositions: false, invite: false },
  },
  products: {
    label: { en: 'Products & stock', es: 'Productos y surtido' }, phrase: { en: 'a product or stock list', es: 'una lista de productos o surtido' }, noun: [['product', 'products'], ['producto', 'productos']], group: [['category', 'categories'], ['categoría', 'categorías']], order: 30,
    about: 'a product or stock list: an order guide or inventory sheet (bottles, cases, supplies with units, sizes, pars, suppliers)',
    sheet: ['inventory', 'order guide', 'products', 'stock', 'par', 'pars', 'supplies', 'bar stock', 'inventario', 'pedido', 'productos', 'surtido'],
    words: ['par', 'case', 'bottle', 'supplier', 'vendor', 'inventory', 'order guide', 'proveedor', 'inventario'],
    hint: ['inventory', 'order guide', 'products', 'stock', 'supplies', 'inventario', 'productos', 'surtido'],
    distinct: ['unit', 'size', 'par', 'location', 'supplier'],
    options: {},
  },
  availability: {
    label: { en: 'Availability', es: 'Disponibilidad' }, phrase: { en: 'an availability sheet', es: 'una hoja de disponibilidad' },
    noun: [['person', 'people'], ['persona', 'personas']], order: 25,
    about: 'each person\'s weekly availability: one row per person and a column per weekday (a sheet, or a colour-coded workbook with a tab per week)',
    sheet: ['availability', 'avail', 'disponibilidad', 'house'],
    words: ['availability', 'available', 'unavailable', 'disponible', 'disponibilidad'],
    hint: ['availability', 'avail', 'disponibilidad'],
    distinct: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'maxHours', 'maxDays', 'requestedOn'],
    options: {}, importNow: false, needsFile: true,
    reviewNote: { en: 'Cell colours and the workbook’s tabs are read in Review & import.', es: 'Los colores de las celdas y las pestañas del libro se leen en Revisar e importar.' },
  },
};
const GENERIC = new Set(['name', 'category', 'notes', 'available', 'active']);

/** The best table in the document for a smart target: { sheet, header, score, mapped }. */
function bestTable(doc, target, hints) {
  let best = null;
  const distinct = hints.distinct || FIELDS[target].map((f) => f.key).filter((k) => !GENERIC.has(k));
  const tables = [...(doc.sheets || [])];
  if (!tables.length && doc.text) { const tr = textRows(doc.text); if (looksTabular(tr, target)) tables.push({ name: doc.name, rows: tr }); }
  for (const [i, s] of tables.entries()) {
    const h = findHeaderRow(s.rows, target, { min: 2 });
    if (h < 0) continue;
    const cols = autoMap(s.rows[h], target, { samples: s.rows.slice(h + 1, h + 20) });
    const sure = cols.filter((c) => c.field && (c.confidence === 'exact' || c.confidence === 'likely'));
    const hits = new Set(sure.map((c) => c.field).filter((f) => distinct.includes(f))).size;
    const named = sure.some((c) => ['name', 'firstName', 'lastName'].includes(c.field)); // a named column, not a guess
    let score = Math.min(95, hits * 22 + (named ? 15 : 0));
    if (!named) score = Math.min(score, 45); // no name column: not this target's file (a schedule grid has day columns too)
    if (hits && hints.sheet && wordHits(s.name, hints.sheet)) score += 12;
    if (s.rows.length - h < 2) score -= 20;
    if (!best || score > best.score) best = { index: i, sheet: s, header: h, score, rows: s.rows };
  }
  return best;
}

function smartTarget(id) {
  const h = SMART[id] || { label: { en: id[0].toUpperCase() + id.slice(1), es: id }, noun: [['row', 'rows'], ['fila', 'filas']], order: 60, about: `${id} records`, options: {} };
  const roleKey = ROLE_FEATURE[id] || 'team';
  return {
    id, order: h.order, label: h.label, ...(h.phrase ? { phrase: h.phrase } : {}), about: h.about, wizard: 'smartImport', importNow: h.importNow !== false, needsFile: !!h.needsFile, kind: 'smart',
    allowed: (user, has) => canManageSchedule(user) && (!PLAN_FEATURE[id] || has(PLAN_FEATURE[id])) && has(roleKey),
    detect(doc, { hint = '' } = {}) {
      const t = bestTable(doc, id, h);
      let score = t?.score || 0;
      if (!t && doc.text) {
        const lines = doc.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (id === 'menu') {
          if (menuFromLabeledText(lines)) score = 88;
          else {
            const found = menuFromText(doc.text).filter((r) => r.values.price).length;
            score = found >= 3 ? Math.min(70, 40 + found * 3) : 0;
          }
        } else if (id === 'employees') {
          const n = rosterFromText(doc.text).length;
          score = n >= 2 ? Math.min(75, 40 + n * 5) : 0;
        }
        if (h.words && score < 88) score = Math.min(72, score + Math.min(15, wordHits(doc.text.slice(0, 6000), h.words) * 3)); // text heuristics stay "medium"
      }
      if (h.hint && wordHits(`${hint} ${doc.name.replace(/[_.-]+/g, ' ')}`, h.hint)) score += score ? 15 : 35;
      return Math.max(0, Math.min(100, score));
    },
    async parse(doc, x, { part = 0 } = {}) {
      const t = bestTable(doc, id, h);
      if (t && t.score >= 30) {
        let remembered = null;
        try { remembered = (await x.ctx.read(`${id}.importMapping`, {})).columns || null; } catch { /* remembered columns are a nicety */ }
        const cols = autoMap(t.rows[t.header], id, { samples: t.rows.slice(t.header + 1, t.header + 30), remembered });
        const records = rowsToRecords(t.rows, t.header, cols);
        const unsure = cols.filter((c) => c.field && c.confidence === 'guess').map((c) => c.field);
        return { done: true, source: 'file', payload: { records, sheet: t.sheet.name, columns: cols.map(({ header, field, confidence }) => ({ header, field, confidence })), lowConfidence: unsure.length ? records.map(() => unsure) : [] } };
      }
      const lines = String(doc.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const labeled = id === 'menu' ? menuFromLabeledText(lines) : null;
      if (labeled) return { done: true, source: 'file', payload: { records: labeled } };
      // Not a table: the target's "Read it with AI", in parts (one per request), else the simple reader.
      if (x.ai?.available && (doc.text?.trim() || doc.image || doc.pdf)) {
        const r = await readRecordsWithAi(id, doc, x, { part });
        if (r) return r;
        if (part > 0) return { done: true, source: 'ai', payload: { records: [] }, notes: [x.aiNote] }; // the parts already read stay
      }
      const simple = id === 'menu' ? menuFromText(doc.text) : id === 'employees' ? rosterFromText(doc.text)
        : lines.map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim()).filter((l) => l && l.length <= 80).map((name, i) => ({ row: i + 1, values: { name }, present: ['name'] }));
      return { done: true, source: 'simple', payload: { records: simple.slice(0, MAX_ROWS) }, notes: [x.ai?.available ? null : x.aiNote].filter(Boolean) };
    },
    async preview(payload, x) {
      const p = await x.ctx.read(`${id}.importPreview`, { records: payload.records || [], options: h.options, decisions: {} });
      const c = p.counts;
      const recs = payload.records || [];
      const groups = id === 'menu' ? new Set(recs.map((r) => String(r.values?.category || '').trim().toLowerCase()).filter(Boolean)).size
        : id === 'products' ? new Set(recs.map((r) => String(r.values?.category || '').trim().toLowerCase()).filter(Boolean)).size : 0;
      const n = c.total ?? recs.length;
      const [one, many] = h.noun[x.lang === 'es' ? 1 : 0];
      const [g1, gn] = (h.group || [[], []])[x.lang === 'es' ? 1 : 0];
      const what = `${plural(n, one, many)}${groups && g1 ? ` ${L(x.lang, 'in', 'en')} ${plural(groups, g1, gn)}` : ''}`;
      const extra = [
        p.newCategories?.length ? L(x.lang, `new sections: ${p.newCategories.slice(0, 5).join(', ')}`, `secciones nuevas: ${p.newCategories.slice(0, 5).join(', ')}`) : '',
        p.newPositions?.length ? L(x.lang, `positions not in ShiftBoard yet: ${p.newPositions.slice(0, 5).join(', ')}`, `puestos que aún no están en ShiftBoard: ${p.newPositions.slice(0, 5).join(', ')}`) : '',
        h.reviewNote ? h.reviewNote[x.lang === 'es' ? 'es' : 'en'] : '',
      ].filter(Boolean);
      return {
        counts: { new: c.new || 0, update: c.update || 0, unchanged: c.unchanged || 0, check: c.check || 0, problem: c.problem || 0, skip: c.skip || 0, total: n },
        checks: c.check || 0, problems: c.problem || 0, line: `${h.label[x.lang === 'es' ? 'es' : 'en']}: ${what}; ${countsLine(c, x.lang)}`, details: extra,
        toImport: (c.new || 0) + (c.update || 0),
      };
    },
    async apply(payload, x) {
      const out = await x.write(`${id}.importApply`, { records: payload.records || [], options: h.options, decisions: {}, exclude: [], fileName: x.fileName, source: 'assistant', via: 'assistant' });
      return {
        line: L(x.lang, `Imported: ${out.created} new, ${out.updated} updated, ${out.unchanged} unchanged${out.failed?.length ? `, ${out.failed.length} failed` : ''}.`,
          `Importado: ${out.created} nuevos, ${out.updated} actualizados, ${out.unchanged} sin cambios${out.failed?.length ? `, ${out.failed.length} con error` : ''}.`),
        counts: { created: out.created, updated: out.updated, unchanged: out.unchanged, failed: out.failed?.length || 0 },
      };
    },
  };
}
for (const id of TARGETS) registerImportTarget(smartTarget(id));

// ---------------------------------------------------------------- BEOs (Events & BEOs)

const BEO_WORDS = ['banquet event order', 'beo', 'event order', 'guest count', 'guaranteed', 'event date', 'arrival', 'timeline', 'room setup', 'banquet', 'catering', 'orden de evento', 'invitados'];
registerImportTarget({
  id: 'beo', order: 40, label: { en: 'BEO / event order', es: 'BEO / orden de evento' }, phrase: { en: 'a BEO (banquet event order)', es: 'un BEO (orden de evento)' }, wizard: 'beo', importNow: true,
  about: 'a banquet event order (BEO) for a private event: date, times, guest count, rooms, menu, timeline, bar',
  allowed: (user, has) => canManageEvents(user) && has('events'),
  detect(doc, { hint = '' } = {}) {
    if (doc.items?.length && parseBeos(doc.items).length) return 96;
    const text = String(doc.text || '').slice(0, 8000);
    let score = Math.min(80, wordHits(text, BEO_WORDS) * 14);
    if (/banquet event order|\bBEO\b/i.test(text)) score += 15;
    if (wordHits(`${hint} ${doc.name.replace(/[_.-]+/g, ' ')}`, ['beo', 'banquet', 'event order', 'event', 'evento'])) score += score ? 10 : 30;
    if (doc.sheets?.length && doc.kind === 'table') score = Math.min(score, 30);
    return Math.min(100, score);
  },
  async parse(doc, x) {
    if (doc.items?.length) {
      const evs = parseBeos(doc.items);
      if (evs.length) return { done: true, source: 'file', payload: { events: dedupeBeos(evs).map(({ index: _i, ...ev }) => ({ ...cleanBeoEvent(ev), warnings: beoWarnings(ev) })) } };
    }
    if (x.ai?.available) {
      const r = await readBeoWithAi(doc, x);
      if (r) return r;
    }
    return { done: true, source: 'none', payload: { events: [] }, notes: [x.ai?.available ? null : x.aiNote].filter(Boolean) };
  },
  async preview(payload, x) {
    const events = payload.events || [];
    if (!events.length) return { counts: { total: 0 }, checks: 0, problems: 1, line: L(x.lang, 'BEO: no event found in it', 'BEO: no se encontró ningún evento'), details: [], toImport: 0 };
    const r = await x.ctx.read('events.importBeos', { events: events.map(toEventPayload), dryRun: true });
    const c = { new: 0, update: 0, same: 0, duplicate: 0, invalid: 0, older: 0, skipped: 0, merged: 0 };
    for (const e of r.events || []) c[e.status] = (c[e.status] || 0) + 1;
    const first = events[0];
    const what = events.length === 1 ? `${first.name || L(x.lang, 'an event', 'un evento')}${first.date ? `, ${first.date}` : ''}${first.guestCount ? `, ${L(x.lang, `${first.guestCount} guests`, `${first.guestCount} invitados`)}` : ''}`
      : L(x.lang, `${events.length} events`, `${events.length} eventos`);
    const parts = [
      c.new && L(x.lang, `${c.new} new`, `${c.new} nuevo${c.new === 1 ? '' : 's'}`), c.update && L(x.lang, `${c.update} to update`, `${c.update} por actualizar`),
      c.same && L(x.lang, `${c.same} unchanged`, `${c.same} sin cambios`), c.duplicate && L(x.lang, `${c.duplicate} possible duplicate${c.duplicate === 1 ? '' : 's'} to check`, `${c.duplicate} posible${c.duplicate === 1 ? '' : 's'} duplicado${c.duplicate === 1 ? '' : 's'} por revisar`),
      c.invalid && L(x.lang, `${c.invalid} missing a name or date`, `${c.invalid} sin nombre o fecha`), c.older && L(x.lang, `${c.older} older than what’s here`, `${c.older} más antiguo${c.older === 1 ? '' : 's'} que lo que ya hay`),
    ].filter(Boolean);
    return {
      counts: { new: c.new, update: c.update, unchanged: c.same, check: c.duplicate, problem: c.invalid + c.older, total: events.length },
      checks: c.duplicate, problems: c.invalid + c.older,
      line: `BEO: ${what}; ${parts.join(', ') || L(x.lang, 'nothing to change', 'nada que cambiar')}`, details: [], toImport: c.new + c.update,
    };
  },
  async apply(payload, x) {
    const r = await x.write('events.importBeos', { events: (payload.events || []).map(toEventPayload), dryRun: false });
    const done = (r.events || []).filter((e) => e.status === 'new' || e.status === 'update' || e.status === 'created' || e.status === 'updated').length;
    return { line: L(x.lang, `Imported ${plural(done, 'event', 'events')}. Staffing and open shifts are on each event’s page.`, `Se importaron ${plural(done, 'evento', 'eventos')}. El personal y los turnos disponibles están en la página de cada evento.`) };
  },
});
/** A parsed BEO → what events.importBeos takes (the room as the BEO writes it; the wizard lets a manager pick one). */
function toEventPayload(ev) {
  const { warnings: _w, pages: _p, via: _v, areas, ...rest } = ev;
  return { ...rest, room: rest.room || '', ...(areas ? { areas } : {}) };
}

// ---------------------------------------------------------------- floor plans (Venue)

const FLOOR_HINT = ['floor plan', 'floor', 'layout', 'tables', 'seating', 'plano', 'mesas', 'distribucion', 'salon'];
registerImportTarget({
  id: 'floor', order: 50, label: { en: 'Floor plan', es: 'Plano del salón' }, phrase: { en: 'a floor plan', es: 'un plano del salón' }, wizard: 'floor', importNow: true,
  about: 'a restaurant floor plan or table layout (a POS table map screenshot, a drawn or printed plan, a photo of one, or a CSV of tables and seats)',
  allowed: (user, has) => canManageSchedule(user) && has('venue'),
  detect(doc, { hint = '' } = {}) {
    let score = 0;
    if (doc.kind === 'table' && doc.sheets?.[0]) {
      const r = readPlanCsv(doc.text, parseCsv);
      if (r.columns && r.columns.label >= 0 && r.rows.length && (r.columns.seats >= 0 || r.columns.room >= 0)) score = 82;
    }
    if (wordHits(`${hint} ${doc.name.replace(/[_.-]+/g, ' ')}`, FLOOR_HINT)) score += doc.kind === 'image' || doc.kind === 'pdf' ? 62 : 15;
    return Math.min(100, score);
  },
  async parse(doc, x) {
    const roomName = String(doc.name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 60) || L(x.lang, 'New room', 'Salón nuevo');
    if (doc.kind === 'table') {
      const r = readPlanCsv(doc.text, parseCsv);
      return { done: true, source: 'file', payload: { incoming: incomingFromCsv(r.rows, { roomName }), errors: r.errors.length } };
    }
    if (x.ai?.available && (doc.image || doc.pdf)) {
      const read = await readFloorWithAi(doc, x);
      if (read) return { done: true, source: 'ai', payload: { incoming: incomingFromImage(read, { roomName }), read } };
    }
    return { done: true, source: 'none', payload: { incoming: null }, notes: [x.ai?.available ? null : x.aiNote].filter(Boolean) };
  },
  async preview(payload, x) {
    const inc = payload.incoming;
    const tables = (inc?.rooms || []).reduce((n, r) => n + r.items.filter((i) => i.seats != null || ['table', 'booth', 'high-top', 'bar'].includes(i.type)).length, 0);
    if (!inc || !tables) return { counts: { total: 0 }, checks: 0, problems: 1, line: L(x.lang, 'Floor plan: no tables found in it', 'Plano: no se encontraron mesas'), details: [], toImport: 0 };
    const p = await x.ctx.read('venue.importPreview', { incoming: inc, decisions: {}, positions: 'keep' });
    const c = p.counts || {};
    const seats = (inc.rooms || []).reduce((n, r) => n + r.items.reduce((s, i) => s + (Number(i.seats) || 0), 0), 0);
    return {
      counts: { new: c.create || 0, update: c.update || 0, unchanged: c.same || 0, check: c.ambiguous || 0, problem: 0, total: tables },
      checks: c.ambiguous || 0, problems: (payload.errors || 0) + (p.rooms || []).filter((r) => r.error).length,
      line: L(x.lang, `Floor plan: ${plural(tables, 'table', 'tables')}, ${seats} seats; ${c.create || 0} new, ${c.update || 0} to update${c.ambiguous ? `, ${c.ambiguous} to check` : ''}`,
        `Plano: ${plural(tables, 'mesa', 'mesas')}, ${seats} lugares; ${c.create || 0} nuevas, ${c.update || 0} por actualizar${c.ambiguous ? `, ${c.ambiguous} por revisar` : ''}`),
      details: [], toImport: (c.create || 0) + (c.update || 0),
    };
  },
  async apply(payload, x) {
    const r = await x.write('venue.importApply', { incoming: payload.incoming, decisions: {}, positions: 'keep', fileName: x.fileName });
    return { line: L(x.lang, `Floor plan imported: ${r.counts?.create || 0} new, ${r.counts?.update || 0} updated. Venue shows it.`, `Plano importado: ${r.counts?.create || 0} nuevas, ${r.counts?.update || 0} actualizadas. Está en Salón.`) };
  },
});

// ---------------------------------------------------------------- schedule grids (Schedule → Import)

function scheduleOf(doc) {
  const candidates = [doc.text, ...(doc.sheets || []).map((s) => sheetText(s.rows))].filter((t) => t && t.trim());
  let best = null;
  for (const text of candidates) {
    const p = parseSchedule(text);
    const shifts = p.mode === 'csv' ? p.csvRows.length : p.sections.reduce((n, s) => n + s.rows.reduce((k, r) => k + r.cells.filter((c) => c.parsed && !c.parsed.off && !c.parsed.timeOff).length, 0), 0);
    if (!best || shifts > best.shifts) best = { p, shifts, text };
  }
  return best;
}
registerImportTarget({
  id: 'schedule', order: 60, label: { en: 'Schedule grid', es: 'Horario (cuadrícula)' }, phrase: { en: 'a schedule grid', es: 'un horario en cuadrícula' }, wizard: 'schedule', importNow: false,
  about: 'a weekly staff schedule grid: names down the side, days of the week across the top, shift times in the cells',
  allowed: (user, has) => canManageSchedule(user) && has('schedule'),
  detect(doc, { hint = '' } = {}) {
    const s = scheduleOf(doc);
    let score = 0;
    if (s?.shifts >= 4) score = s.p.mode === 'csv' ? 80 : Math.min(92, 70 + s.shifts);
    if (wordHits(`${hint} ${doc.name.replace(/[_.-]+/g, ' ')}`, ['schedule', 'horario', 'shifts', 'turnos', 'week'])) score += score ? 8 : 20;
    return Math.min(100, score);
  },
  async parse(doc) {
    const s = scheduleOf(doc);
    return { done: true, source: 'file', payload: { text: s?.text || '' } };
  },
  async preview(payload, x) {
    const p = parseSchedule(payload.text || '');
    const names = new Set();
    let shifts = 0;
    if (p.mode === 'csv') for (const r of p.csvRows) { names.add(r.name); shifts++; }
    for (const sec of p.sections) for (const r of sec.rows) { names.add(r.name); shifts += r.cells.filter((c) => c.parsed && !c.parsed.off && !c.parsed.timeOff).length; }
    const team = x.ctx.store.list('users', (u) => u.active !== false);
    const matched = matchPeople([...names], team);
    const unknown = [...names].filter((n) => !matched.get(n) || matched.get(n).how === 'guess').length;
    return {
      counts: { total: shifts, new: shifts, check: unknown, problem: p.problems.length },
      checks: unknown, problems: p.problems.length,
      line: L(x.lang, `Schedule: ${plural(names.size, 'person', 'people')}, ${plural(shifts, 'shift', 'shifts')}${p.weekOf ? ` for the week of ${p.weekOf}` : ''}${unknown ? `; ${plural(unknown, 'name', 'names')} to match to the team` : ''}${p.problems.length ? `; ${plural(p.problems.length, 'cell', 'cells')} it couldn’t read` : ''}`,
        `Horario: ${plural(names.size, 'persona', 'personas')}, ${plural(shifts, 'turno', 'turnos')}${p.weekOf ? ` de la semana del ${p.weekOf}` : ''}${unknown ? `; ${plural(unknown, 'nombre', 'nombres')} por emparejar con el equipo` : ''}${p.problems.length ? `; ${plural(p.problems.length, 'celda', 'celdas')} que no pudo leer` : ''}`),
      details: [], toImport: shifts, weekOf: p.weekOf || null,
    };
  },
});

// ---------------------------------------------------------------- OpenTable exports and review exports (Kudos)

const OT_RES = ['visit date', 'visit time', 'conf', 'conf number', 'confirmation number', 'party size', 'guest name', 'special requests', 'visit notes', 'date made', 'covers'];
const OT_REV = ['dined on', 'overall', 'diner name', 'food', 'service', 'ambience', 'value', 'date submitted'];
const GOOGLE = ['star rating', 'create time', 'reviewer', 'comment', 'reply'];
const YELP = ['yelp', 'user name', 'review text', 'rating'];
function guestTable(doc, kind) {
  const s = doc.sheets?.[0];
  if (!s || doc.kind === 'docx') return null;
  const text = doc.kind === 'table' ? doc.text : s.rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  try {
    const r = readGuestFile(text, kind);
    if (!r.header.length || r.rows.length < 2 || mappingProblems(r.mapping, kind).length) return null;
    return r;
  } catch { return null; }
}
const otKindOf = (doc) => {
  const rows = doc.sheets?.[0]?.rows || [];
  const res = headerHits(rows, OT_RES).hits, rev = headerHits(rows, OT_REV).hits;
  return rev > res ? 'reviews' : 'reservations';
};
registerImportTarget({
  id: 'opentable', order: 70, label: { en: 'OpenTable export', es: 'Exportación de OpenTable' }, phrase: { en: 'an OpenTable export', es: 'una exportación de OpenTable' }, wizard: 'guests', importNow: true,
  about: 'an OpenTable export: reservations (visit date, party size, guest, special requests) or OpenTable reviews (dined on, overall rating)',
  allowed: (user, has) => canManageSchedule(user) && has('opentable'),
  detect(doc, { hint = '' } = {}) {
    const rows = doc.sheets?.[0]?.rows || [];
    if (!rows.length) return 0;
    const kind = otKindOf(doc);
    const t = guestTable(doc, kind);
    if (!t) return 0;
    const own = headerHits(rows, kind === 'reviews' ? OT_REV : OT_RES).hits;
    let score = 45 + own * 9;
    if (wordHits(`${hint} ${doc.name.replace(/[_.-]+/g, ' ')}`, ['opentable', 'open table', 'reservations', 'reservaciones'])) score += 20;
    if (kind === 'reviews' && headerHits(rows, GOOGLE).hits >= 2) score -= 30;
    return Math.max(0, Math.min(100, score));
  },
  async parse(doc) {
    const kind = otKindOf(doc);
    const t = guestTable(doc, kind);
    if (!t) return { done: true, source: 'file', payload: { kind, items: [] } };
    const r = kind === 'reviews' ? readReviews(t.rows, t.mapping, t.headerRow, { source: 'opentable' }) : readReservations(t.rows, t.mapping, t.headerRow);
    return { done: true, source: 'file', payload: { kind, items: r.items.map(({ row: _r, ...it }) => it), skipped: r.skipped.length } };
  },
  async preview(payload, x) {
    const items = payload.items || [];
    const total = { new: 0, updated: 0, same: 0, duplicate: 0, covers: 0 };
    for (const part of chunkItems(items)) {
      const p = await x.ctx.read('opentable.previewImport', { kind: payload.kind, items: part });
      for (const [k, v] of Object.entries(p.counts || {})) total[k] = (total[k] || 0) + (Number(v) || 0);
    }
    const res = payload.kind === 'reservations';
    return {
      counts: { new: total.new, update: total.updated, unchanged: total.same, check: 0, problem: payload.skipped || 0, total: items.length },
      checks: 0, problems: payload.skipped || 0,
      line: res ? L(x.lang, `OpenTable reservations: ${items.length} (${total.covers || 0} covers); ${total.new} new, ${total.updated} updated, ${total.same} already here${payload.skipped ? `, ${payload.skipped} rows it couldn’t read` : ''}`,
        `Reservaciones de OpenTable: ${items.length} (${total.covers || 0} cubiertos); ${total.new} nuevas, ${total.updated} actualizadas, ${total.same} ya estaban${payload.skipped ? `, ${payload.skipped} filas que no pudo leer` : ''}`)
        : L(x.lang, `OpenTable reviews: ${items.length}; ${total.new} new, ${total.same} already here${payload.skipped ? `, ${payload.skipped} rows it couldn’t read` : ''}`,
          `Reseñas de OpenTable: ${items.length}; ${total.new} nuevas, ${total.same} ya estaban${payload.skipped ? `, ${payload.skipped} filas que no pudo leer` : ''}`),
      details: [], toImport: total.new + total.updated,
    };
  },
  async apply(payload, x) {
    let importId = null;
    const counts = {};
    for (const part of chunkItems(payload.items || [])) {
      const r = await x.write('opentable.import', { kind: payload.kind, items: part, fileName: x.fileName, importId });
      importId = r.importId || importId;
      for (const [k, v] of Object.entries(r.counts || {})) counts[k] = (counts[k] || 0) + (Number(v) || 0);
    }
    return { line: L(x.lang, `Imported: ${counts.new || 0} new, ${counts.updated || 0} updated, ${counts.same || 0} already here.`, `Importado: ${counts.new || 0} nuevas, ${counts.updated || 0} actualizadas, ${counts.same || 0} ya estaban.`) };
  },
});

const reviewSource = (doc, hint) => {
  const s = `${hint} ${doc.name}`.toLowerCase();
  if (/google/.test(s) || headerHits(doc.sheets?.[0]?.rows || [], GOOGLE).hits >= 2) return 'google';
  if (/yelp/.test(s) || headerHits(doc.sheets?.[0]?.rows || [], YELP).hits >= 3) return 'yelp';
  if (/tripadvisor/.test(s)) return 'tripadvisor';
  if (/facebook/.test(s)) return 'facebook';
  return 'other';
};
registerImportTarget({
  id: 'reviews', order: 80, label: { en: 'Review export', es: 'Exportación de reseñas' }, phrase: { en: 'a review export', es: 'una exportación de reseñas' }, wizard: 'guests', importNow: true,
  about: 'guest reviews exported from Google, Yelp, TripAdvisor or similar: reviewer, star rating, review text, date',
  allowed: (user, has) => canManageSchedule(user) && has('impact') && has('reviews'),
  detect(doc, { hint = '' } = {}) {
    const rows = doc.sheets?.[0]?.rows || [];
    if (!rows.length || !guestTable(doc, 'reviews')) return 0;
    let score = 60 + headerHits(rows, GOOGLE).hits * 8;
    if (headerHits(rows, OT_REV).hits >= 3) score -= 25;
    if (wordHits(`${hint} ${doc.name.replace(/[_.-]+/g, ' ')}`, ['reviews', 'google', 'yelp', 'tripadvisor', 'resenas'])) score += 15;
    return Math.max(0, Math.min(100, score));
  },
  async parse(doc, x) {
    const t = guestTable(doc, 'reviews');
    const source = reviewSource(doc, x.hint || '');
    if (!t) return { done: true, source: 'file', payload: { source, items: [] } };
    const r = readReviews(t.rows, t.mapping, t.headerRow, { source });
    return { done: true, source: 'file', payload: { source, items: r.items.map(({ row: _r, ...it }) => it), skipped: r.skipped.length } };
  },
  async preview(payload, x) {
    const items = payload.items || [];
    const total = {};
    for (const part of chunkItems(items)) {
      const p = await x.ctx.read('impact.previewReviews', { source: payload.source, items: part });
      for (const [k, v] of Object.entries(p.counts || {})) total[k] = (total[k] || 0) + (Number(v) || 0);
    }
    const fresh = total.new || 0, same = total.same || total.duplicate || 0;
    return {
      counts: { new: fresh, update: total.updated || 0, unchanged: same, check: total.possibleDuplicate || 0, problem: payload.skipped || 0, total: items.length },
      checks: total.possibleDuplicate || 0, problems: payload.skipped || 0,
      line: L(x.lang, `Reviews (${payload.source}): ${items.length}; ${fresh} new, ${same} already here${total.possibleDuplicate ? `, ${total.possibleDuplicate} possible duplicates to check` : ''}${payload.skipped ? `, ${payload.skipped} rows it couldn’t read` : ''}`,
        `Reseñas (${payload.source}): ${items.length}; ${fresh} nuevas, ${same} ya estaban${total.possibleDuplicate ? `, ${total.possibleDuplicate} posibles duplicados por revisar` : ''}${payload.skipped ? `, ${payload.skipped} filas que no pudo leer` : ''}`),
      details: [], toImport: fresh + (total.updated || 0),
    };
  },
  async apply(payload, x) {
    const parts = chunkItems(payload.items || []);
    const counts = {};
    for (const [i, part] of parts.entries()) {
      const r = await x.write('impact.importReviews', { source: payload.source, items: part, fileName: x.fileName, final: i === parts.length - 1 });
      for (const [k, v] of Object.entries(r.counts || {})) counts[k] = (counts[k] || 0) + (Number(v) || 0);
    }
    return { line: L(x.lang, `Imported: ${counts.new || 0} new reviews.`, `Importado: ${counts.new || 0} reseñas nuevas.`) };
  },
});

export { chunkText };
