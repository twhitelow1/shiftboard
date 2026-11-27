// Smart import: one pipeline for employee rosters and menus. Pure functions, no I/O, so the browser (the web
// wizard, the demo), the server (core/import-api.js, the AI reader) and the Claude connector's tools all share them.
//
//   1. Read      readTable(text) (CSV, TSV, semicolons, pasted cells), readDocx(bytes), readXlsx(bytes),
//                pdfRows(items) (pdf.js text from web/src/pdf.js pdfToItems), textRows(text) for text that's a table
//   2. Interpret findHeaderRow(rows, target) + autoMap(header, target, { samples, remembered }): each column → a field,
//                with a confidence; rowsToRecords() turns rows into records { row, values: { field: text }, present }.
//                Text that isn't a table: menuFromText / rosterFromText (simple readers), or the AI reader
//                (server/import-routes.js), which returns the same records.
//   3. Normalize normalizeEmployee / normalizeMenuItem: names, emails, phones, dates, allergens, dietary tags…
//   4. Duplicates groupRows() merges rows of the file that are the same person or item (conflicting values kept for
//                the manager to pick); personMatch / menuMatch score an incoming row against an existing record.
//
// Matching rules (tuned with the tests in test/smart-import.test.js):
//   exact     equal after folding case, accents, spacing and punctuation: an email, an employee ID, a phone
//             number (+1, dots, dashes, spaces), a full name or legal name; a menu item's name in its section.
//             An exact match is used without asking (unless more than one record matches: then it's "check").
//   possible  everything else that looks alike is a "Possible duplicate — check" row, never merged on its own:
//             people: a Gmail-style email variant, first/last swapped, a middle initial, a nickname (core/impact.js
//             nicknamesOf) or legal vs common name (core/names.js aliasesOf), a one-letter typo in a name of 4+
//             letters, only a first name; menu: plural, "&" vs "and", a size or price on the end, a typo (edit
//             distance ≤ 15% of the length, names of 5+ letters), or the same name in another section.
//   never     two people whose emails (or employee IDs) both exist and differ are different people.
import { unzipSync, strFromU8 } from 'fflate';
import { parseCsv, headerKey as adpHeaderKey, parseDate, splitName } from './adp-csv.js';
import { nameKey, aliasesOf, legalNameOf } from './names.js';
import { nicknamesOf, fold } from './impact.js';
import { canonicalAllergen, MAJOR_ALLERGENS, DIETARY_TAGS } from './training.js';
import { normalizePhone } from './notify-prefs.js';
import { DAY_HEADER_NAMES, DAY_FIELDS, dayOfHeader } from './weekdays.js';

export { parseCsv };
// products: Stock lists' catalog (core/products.js); availability: each person's weekly availability (core/availability.js)
export const TARGETS = ['employees', 'menu', 'products', 'availability'];
export const MAX_ROWS = 1000; // per import
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // read in the browser
export const MAX_AI_CHARS = 40_000; // all of a document sent to the AI reader
export const AI_CHUNK_CHARS = 3500; // one AI call (Vercel's 30 s per request)
export const ROLES_IMPORTABLE = ['employee', 'supervisor', 'manager'];

const clean = (v) => String(v ?? '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();
const para = (v) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
/** A header or word for comparing: accents folded, lower case, letters and digits ("Teléfono #" → "telefono number"). */
export const headerKey = (h) => adpHeaderKey(fold(String(h ?? '').replace(/^\uFEFF/, '')));
/** A cell's value for comparing words: accents folded, lower case, letters and digits (unlike headerKey, "no" stays "no"). */
export const valueKey = (v) => fold(String(v ?? '')).replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------- fields

const F = (key, names, extra = {}) => ({ key, names, ...extra });
/** Each target's fields, with the column names that mean them (English and Spanish), most likely first. */
export const FIELDS = {
  employees: [
    F('name', ['name', 'full name', 'employee name', 'employee', 'preferred name', 'display name', 'goes by', 'nickname', 'nombre completo', 'empleado', 'apodo', 'staff', 'team member']),
    F('firstName', ['first', 'first name', 'given name', 'fname', 'nombre', 'nombres', 'primer nombre']),
    F('lastName', ['last', 'last name', 'surname', 'family name', 'lname', 'apellido', 'apellidos']),
    F('legalFirstName', ['legal first name', 'legal first', 'legal given name', 'nombre legal']),
    F('legalLastName', ['legal last name', 'legal last', 'legal surname', 'apellido legal', 'apellidos legales']),
    F('email', ['email', 'e mail', 'email address', 'mail', 'work email', 'personal email', 'correo', 'correo electronico', 'email personal']),
    F('phone', ['phone', 'phone number', 'cell', 'cell phone', 'cellphone', 'mobile', 'mobile phone', 'mobile number', 'telephone', 'tel', 'celular', 'telefono', 'movil', 'numero de telefono', 'numero celular', 'whatsapp']),
    F('positions', ['position', 'positions', 'role', 'roles', 'job', 'jobs', 'job title', 'title', 'job code', 'job codes', 'puesto', 'puestos', 'cargo', 'posicion', 'trabajo', 'rol']),
    F('role', ['access', 'access level', 'permission', 'permissions', 'app role', 'shiftboard role', 'user role', 'user type', 'account type', 'nivel de acceso', 'permisos', 'tipo de usuario']),
    F('hireDate', ['hire date', 'hired', 'date hired', 'hired on', 'start date', 'fecha de ingreso', 'fecha de contratacion', 'fecha de inicio', 'ingreso']),
    F('birthday', ['birthday', 'birth date', 'birthdate', 'date of birth', 'dob', 'cumpleanos', 'fecha de nacimiento']),
    F('employeeId', ['employee id', 'emp id', 'employee number', 'employee no', 'payroll id', 'file number', 'badge', 'badge number', 'employee code', 'clock number', 'id', 'numero de empleado', 'id de empleado', 'numero de nomina']),
    F('payRate', ['pay rate', 'rate', 'hourly rate', 'wage', 'hourly', 'pay', 'tarifa', 'sueldo por hora', 'pago por hora', 'salario por hora']),
    F('rooms', ['rooms', 'rooms worked', 'works in', 'areas', 'spaces', 'locations', 'salones', 'areas de trabajo']),
    F('primaryRoom', ['primary room', 'main room', 'home room', 'primary space', 'primary location', 'main space', 'room', 'space', 'location', 'salon principal', 'salon', 'area principal', 'ubicacion principal']),
    F('notes', ['notes', 'note', 'comments', 'comment', 'notas', 'nota', 'comentarios', 'observaciones']),
    F('active', ['active', 'status', 'employment status', 'activo', 'estado', 'estatus']),
  ],
  menu: [
    F('name', ['name', 'item', 'item name', 'dish', 'menu item', 'product', 'title', 'nombre', 'platillo', 'producto', 'articulo', 'plato', 'bebida']),
    F('category', ['category', 'section', 'menu section', 'type', 'course', 'group', 'categoria', 'seccion', 'tipo', 'grupo']),
    F('description', ['description', 'desc', 'details', 'menu description', 'descripcion', 'detalle']),
    F('ingredients', ['ingredients', 'key ingredients', 'components', 'ingredientes']),
    F('allergens', ['allergens', 'allergies', 'allergen', 'contains', 'alergenos', 'alergias', 'contiene']),
    F('dietary', ['dietary', 'diet', 'dietary tags', 'tags', 'labels', 'dieta', 'etiquetas']),
    F('price', ['price', 'cost', 'amount', 'precio', 'costo']),
    F('selling', ['selling notes', 'selling points', 'how to sell', 'upsell', 'talking points', 'notas de venta', 'como venderlo']),
    F('pairings', ['pairings', 'pairing', 'pairs with', 'maridaje', 'acompanar con']),
    F('recipe', ['recipe', 'steps', 'method', 'preparation', 'receta', 'preparacion', 'pasos']),
    F('prep', ['prep notes', 'prep', 'prep note', 'mise en place', 'notas de preparacion']),
    F('nameEs', ['spanish name', 'name es', 'name spanish', 'name in spanish', 'nombre en espanol', 'nombre es']),
    F('descriptionEs', ['spanish description', 'description es', 'description spanish', 'descripcion en espanol', 'descripcion es']),
    F('eightySixed', ['86', '86d', '86 d', 'eighty six', 'eighty sixed', 'sold out', 'out of stock', 'agotado']),
    F('available', ['available', 'in stock', 'availability', 'disponible', 'active', 'status', 'estado']),
  ],
  // The product catalog Stock lists and the 86 List share (core/products.js): an order guide or inventory sheet.
  products: [
    F('name', ['product', 'name', 'item', 'item name', 'product name', 'description', 'producto', 'nombre', 'articulo', 'artículo', 'insumo']),
    F('category', ['category', 'type', 'group', 'class', 'categoria', 'tipo', 'grupo']),
    F('unit', ['unit', 'uom', 'unit of measure', 'pack', 'count by', 'unidad', 'presentacion']),
    F('size', ['size', 'volume', 'pack size', 'bottle size', 'tamano', 'tamaño', 'volumen']),
    F('par', ['par', 'par level', 'on hand', 'stock level', 'nivel par', 'par minimo']),
    F('location', ['location', 'storage', 'stored', 'shelf', 'where', 'storage location', 'ubicacion', 'ubicación', 'almacen', 'almacén']),
    F('supplier', ['supplier', 'vendor', 'distributor', 'proveedor', 'distribuidor']),
    F('notes', ['notes', 'note', 'comments', 'notas', 'comentarios']),
  ],
  // Weekly availability (core/availability.js): one row per person, a column per weekday. People are only matched,
  // never made. The day columns are also found by dayOfHeader ("Mon 9/28", "Lunes"), see autoMap.
  availability: [
    F('name', ['name', 'full name', 'employee name', 'employee', 'preferred name', 'goes by', 'nickname', 'nombre', 'nombre completo', 'empleado', 'apodo', 'staff', 'team member', 'person', 'persona']),
    F('firstName', ['first', 'first name', 'given name', 'fname', 'primer nombre']),
    F('lastName', ['last', 'last name', 'surname', 'family name', 'lname', 'apellido', 'apellidos']),
    F('email', ['email', 'e mail', 'email address', 'mail', 'correo', 'correo electronico']),
    F('phone', ['phone', 'phone number', 'cell', 'cell phone', 'mobile', 'telephone', 'tel', 'celular', 'telefono']),
    F('employeeId', ['employee id', 'emp id', 'employee number', 'payroll id', 'file number', 'badge', 'id', 'numero de empleado', 'id de empleado']),
    ...DAY_FIELDS.map((k, d) => F(k, DAY_HEADER_NAMES[d])).slice(1), F('sun', DAY_HEADER_NAMES[0]), // Monday first, like the sheets
    F('notes', ['notes', 'note', 'comments', 'comment', 'availability notes', 'notas', 'nota', 'comentarios', 'observaciones']),
    F('maxHours', ['max hours', 'max hrs', 'maximum hours', 'hours max', 'max hours per week', 'max hours week', 'hours per week', 'max weekly hours', 'horas maximas', 'max horas', 'horas por semana']),
    F('maxDays', ['max days', 'maximum days', 'days max', 'max days per week', 'days per week', 'max shifts', 'shifts per week', 'dias maximos', 'max dias', 'dias por semana']),
    F('requestedOn', ['requested on', 'request date', 'date requested', 'requested', 'requested date', 'fecha de solicitud', 'pedido el', 'solicitado', 'fecha solicitada']),
  ],
};
export const fieldKeys = (target) => FIELDS[target].map((f) => f.key);
// Columns never imported, whatever the manager picks: identity and bank numbers have no place in ShiftBoard.
const SENSITIVE = /\b(ssn|social security|social|sin|itin|tax id|taxpayer|ein|bank|routing|account number|iban|swift|seguro social|curp|rfc|cuenta bancaria|clabe)\b/;
export const isSensitiveHeader = (h) => SENSITIVE.test(headerKey(h));

const ROLE_WORDS = {
  employee: ['employee', 'staff', 'team member', 'crew', 'hourly', 'empleado', 'empleada', 'personal', 'colaborador'],
  supervisor: ['supervisor', 'lead', 'shift lead', 'shift leader', 'team lead', 'captain', 'supervisora', 'lider', 'encargado', 'encargada'],
  manager: ['manager', 'gm', 'general manager', 'agm', 'assistant manager', 'gerente', 'administrador de turno'],
  admin: ['admin', 'administrator', 'administrador', 'administradora', 'super admin', 'superadmin', 'super administrator', 'owner', 'dueno', 'duena', 'propietario'],
};
/** A ShiftBoard role from a cell: 'employee' | 'supervisor' | 'manager' | 'admin' (never imported) | '' | null (unknown). */
export function parseRole(v) {
  const k = valueKey(v);
  if (!k) return '';
  for (const [role, words] of Object.entries(ROLE_WORDS)) if (words.includes(k)) return role;
  if (/\badmin|owner|super/.test(k)) return 'admin';
  if (/\bmanager|gerente/.test(k)) return 'manager';
  if (/\bsupervisor|\blead\b/.test(k)) return 'supervisor';
  return null;
}

// ---------------------------------------------------------------- reading

/** CSV, TSV, semicolon files and cells pasted from a spreadsheet → rows (arrays of cells), empty rows dropped. */
export function readTable(text) {
  return parseCsv(String(text ?? '')).filter((r) => r.some((c) => clean(c)));
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e.toLowerCase()] || m));
const zipFiles = (bytes, wanted) => unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { filter: (f) => wanted(f.name) });

/**
 * A Word document's paragraphs and tables (word/document.xml): { blocks: [{ type: 'p', text } | { type: 'table', rows }],
 * tables: [rows…], text }. Tables nested in a table cell are read as that cell's text.
 */
export function readDocx(bytes) {
  const files = zipFiles(bytes, (n) => n === 'word/document.xml');
  if (!files['word/document.xml']) throw new Error('not a docx');
  const xml = strFromU8(files['word/document.xml']);
  const blocks = [];
  const tables = [];
  let depth = 0; // table nesting
  let row = null, cell = null, table = null, para = '';
  const re = /<(\/?)w:(tbl|tr|tc|p|t|tab|br|cr)\b([^>]*?)(\/?)>|([^<]+)/g;
  let inText = false;
  for (let m; (m = re.exec(xml));) {
    const [, close, tag, , self, txt] = m;
    if (txt !== undefined) { if (inText) para += unxml(txt); continue; }
    if (tag === 't') { inText = !close && !self; continue; }
    if (tag === 'tab' && !close) { para += '\t'; continue; }
    if ((tag === 'br' || tag === 'cr') && !close) { para += '\n'; continue; }
    if (tag === 'tbl') {
      if (!close) { depth++; if (depth === 1) table = []; } else { depth--; if (depth === 0 && table) { blocks.push({ type: 'table', rows: table }); tables.push(table); table = null; } }
      continue;
    }
    if (depth !== 1) {
      if (tag === 'p' && close) { if (depth === 0) { blocks.push({ type: 'p', text: para.replace(/[  ]+/g, ' ').trim() }); para = ''; } else para += '\n'; }
      continue;
    }
    if (tag === 'tr') { if (!close) row = []; else { if (row && row.some((c) => c)) table.push(row); row = null; } continue; }
    if (tag === 'tc') { if (!close) { cell = ''; para = ''; } else { row?.push(clean(`${cell} ${para}`)); cell = null; para = ''; } continue; }
    if (tag === 'p' && close && cell !== null) { cell = `${cell}${cell ? ' ' : ''}${para}`; para = ''; }
  }
  const text = blocks.map((b) => (b.type === 'p' ? b.text : b.rows.map((r) => r.join('\t')).join('\n'))).filter(Boolean).join('\n');
  return { blocks, tables, text };
}

/** The first sheet of an Excel workbook (.xlsx) → rows of cell text. */
export function readXlsx(bytes) {
  const files = zipFiles(bytes, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels');
  return readXlsxRaw(files).map((r) => r.text).filter((r) => r.some(Boolean));
}
/** The first sheet's rows: [{ text: [cells], fill: [fillOf(cell xml)] }] (empty rows kept, so callers can line fills up). */
function readXlsxRaw(files, fillOf = null) {
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of strFromU8(files['xl/sharedStrings.xml']).match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(unxml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  // The first sheet in the workbook's order (its relationship target), else the lowest-numbered file.
  let sheet = null;
  try {
    const first = strFromU8(files['xl/workbook.xml']).match(/<sheet\b[^>]*r:id="([^"]+)"/);
    const target = first && strFromU8(files['xl/_rels/workbook.xml.rels']).match(new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*Target="([^"]+)"`))
      || (first && strFromU8(files['xl/_rels/workbook.xml.rels']).match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${first[1]}"`)));
    if (target) sheet = `xl/${target[1].replace(/^\/?xl\//, '')}`;
  } catch { /* fall back below */ }
  if (!sheet || !files[sheet]) sheet = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10))[0];
  if (!sheet) throw new Error('not an xlsx');
  const col = (ref) => [...String(ref).replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rows = [];
  for (const r of strFromU8(files[sheet]).match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const out = [];
    const fill = [];
    for (const c of r.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = (c.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (c.match(/\bt="(\w+)"/) || [])[1];
      const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = '';
      if (type === 's') value = shared[+v] ?? '';
      else if (type === 'inlineStr') value = unxml((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      else if (v !== undefined) value = unxml(v);
      const at = ref ? col(ref) : out.length;
      out[at] = clean(value);
      if (fillOf) fill[at] = fillOf(c);
    }
    const width = Math.max(out.length, fill.length);
    rows.push({ text: Array.from({ length: width }, (_, i) => out[i] ?? ''), fill: Array.from({ length: width }, (_, i) => fill[i] ?? '') });
  }
  return rows;
}

// ---------------------------------------------------------------- cell colours (an Excel sheet's fills)

// The 64 indexed colours of the legacy palette (index 0–63), as Excel shows them.
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];
// Office's default theme (when the file has none): lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink, in the order the
// theme="n" attribute counts them (Excel swaps the first two pairs).
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

const toHsl = (hex) => {
  const n = parseInt(hex, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: sat, l };
};
const fromHsl = ({ h, s, l }) => {
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};
/** Excel's tint: towards white (tint > 0) or black (tint < 0), on the lightness. */
const tinted = (hex, tint) => {
  if (!tint) return hex;
  const c = toHsl(hex);
  c.l = tint < 0 ? c.l * (1 + tint) : c.l * (1 - tint) + tint;
  return fromHsl(c);
};

export const COLOR_FAMILIES = ['green', 'lightGreen', 'yellow', 'red', 'other', 'none'];
/**
 * A fill colour's family: green · lightGreen · yellow · red · other · none (no fill, white or grey). Tolerant ranges, so
 * a sheet's "green" is green whichever green it is: hue 70–170 is green; light green when it's pale (lightness ≥ 0.6, or
 * ≥ 0.5 leaning yellow-green, like Excel's 92D050). Yellow: hue 40–70 (and pale orange-yellows); red: hue < 15 or > 340.
 */
export function colorFamily(hex) {
  const h6 = String(hex || '').replace(/^#?(?:FF)?([0-9a-f]{6})$/i, '$1');
  if (!/^[0-9a-f]{6}$/i.test(h6)) return 'none';
  const { h, s, l } = toHsl(h6);
  if (l > 0.94 || s < 0.12) return 'none';
  if (h >= 70 && h <= 170) return l >= 0.78 ? 'lightGreen' : 'green'; // pale (a 80% tint) is light green
  if (h >= 40 && h < 70) return 'yellow';
  if (h < 15 || h > 340) return 'red';
  return 'other';
}

/** A workbook's styles: each cell style's fill ('#RRGGBB' or '') and whether its number format is a date or a time. */
function loadStyles(files) {
  const theme = [...DEFAULT_THEME];
  const themeFile = Object.keys(files).filter((n) => /^xl\/theme\/theme\d+\.xml$/.test(n)).sort()[0];
  if (themeFile) {
    const scheme = strFromU8(files[themeFile]).match(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/)?.[0] || '';
    const pick = (tag) => { const m = scheme.match(new RegExp(`<a:${tag}>[\\s\\S]*?(?:srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})")`)); return m ? (m[1] || m[2]).toUpperCase() : null; };
    ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].forEach((tag, i) => { const c = pick(tag); if (c) theme[i] = c; });
  }
  const colorOf = (attrs) => {
    if (!attrs) return '';
    const rgbM = attrs.match(/\brgb="([0-9A-Fa-f]{6,8})"/);
    const tint = Number((attrs.match(/\btint="(-?[\d.eE-]+)"/) || [])[1] || 0);
    let hex = null;
    if (rgbM) hex = rgbM[1].slice(-6);
    else if (/\btheme="(\d+)"/.test(attrs)) hex = theme[+attrs.match(/\btheme="(\d+)"/)[1]] || null;
    else if (/\bindexed="(\d+)"/.test(attrs)) { const i = +attrs.match(/\bindexed="(\d+)"/)[1]; hex = i < 64 ? INDEXED[i] : null; } // 64: the system colour
    return hex ? `#${tinted(hex.toUpperCase(), tint)}` : '';
  };
  const fills = [];
  const xfs = [];
  if (files['xl/styles.xml']) {
    const st = strFromU8(files['xl/styles.xml']);
    const custom = new Map();
    for (const m of (st.match(/<numFmts\b[\s\S]*?<\/numFmts>/)?.[0] || '').matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(+m[1], unxml(m[2]));
    const kindOf = (id) => {
      if ((id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 'date';
      if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return 'time';
      const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
      if (/[dy]/.test(code) || /m{3,}/.test(code)) return 'date';
      if (/h/.test(code) || /:mm|ss/.test(code) || /am\/pm/.test(code)) return 'time';
      return '';
    };
    for (const f of (st.match(/<fills\b[\s\S]*?<\/fills>/)?.[0] || '').match(/<fill>[\s\S]*?<\/fill>|<fill\/>/g) || []) {
      const pattern = f.match(/<patternFill\b([^>]*)>([\s\S]*?)<\/patternFill>|<patternFill\b([^>]*)\/>/);
      const type = ((pattern?.[1] || pattern?.[3] || '').match(/patternType="(\w+)"/) || [])[1] || 'none';
      const fg = (pattern?.[2] || '').match(/<fgColor\b([^>]*?)\/?>/)?.[1];
      const bg = (pattern?.[2] || '').match(/<bgColor\b([^>]*?)\/?>/)?.[1];
      fills.push(type === 'none' ? '' : colorOf(fg) || colorOf(bg));
    }
    for (const xf of (st.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] || '').match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || []) {
      xfs.push({ fill: fills[+(xf.match(/\bfillId="(\d+)"/) || [])[1] || 0] || '', kind: kindOf(+(xf.match(/\bnumFmtId="(\d+)"/) || [])[1] || 0) });
    }
  }
  return { styleOf: (s) => xfs[s] || { fill: '', kind: '' } };
}
const sharedStrings = (files) => (files['xl/sharedStrings.xml'] ? (strFromU8(files['xl/sharedStrings.xml']).match(/<si>[\s\S]*?<\/si>/g) || [])
  .map((si) => unxml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))) : []);
/** An Excel serial date → 'YYYY-MM-DD' (the 1900 system). */
export const excelDate = (n) => new Date(Math.round((Number(n) - 25569) * 864e5)).toISOString().slice(0, 10);
/** An Excel time (a day's fraction) → 'HH:MM'. */
export const excelTime = (n) => { const m = Math.round((Number(n) % 1) * 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/**
 * Every sheet of a workbook, in the workbook's order: [{ name, rows: [[{ text, fill, date?, time?, merged? }]] }].
 * Rows keep their sheet position (row 1 is rows[0], empty rows are empty arrays); text is what the cell shows (a date
 * cell as 'YYYY-MM-DD', a time as 'HH:MM'); fill is '#RRGGBB' or ''; merged marks a cell covered by a merge (not its
 * top-left), which has no text of its own.
 */
export function readWorkbook(bytes) {
  const files = zipFiles(bytes, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels'
    || n === 'xl/styles.xml' || /^xl\/theme\/theme\d+\.xml$/.test(n));
  const shared = sharedStrings(files);
  const { styleOf } = loadStyles(files);
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  const relTarget = (id) => { const m = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${id}"`)); return m ? `xl/${m[1].replace(/^\/?xl\//, '')}` : null; };
  let list = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: unxml((m[1].match(/\bname="([^"]*)"/) || [])[1] || ''), file: relTarget((m[1].match(/\br:id="([^"]+)"/) || [])[1]) }))
    .filter((x) => x.file && files[x.file]);
  if (!list.length) list = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort().map((file, i) => ({ name: `Sheet${i + 1}`, file }));
  if (!list.length) throw new Error('not an xlsx');
  const col = (ref) => [...String(ref).replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return list.map(({ name, file }) => {
    const xml = strFromU8(files[file]);
    const rows = [];
    for (const r of xml.match(/<row\b[^>]*?\/>|<row\b[^>]*?>[\s\S]*?<\/row>/g) || []) {
      const rn = +((r.match(/^<row\b[^>]*\br="(\d+)"/) || [])[1] || rows.length + 1) - 1;
      const out = [];
      for (const c of r.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/\br="([A-Z]+)\d+"/) || [])[1];
        const type = (c.match(/\bt="(\w+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const st = styleOf(+(c.match(/\bs="(\d+)"/) || [])[1] || 0);
        const cell = { text: '', fill: st.fill };
        if (type === 's') cell.text = clean(shared[+v] ?? '');
        else if (type === 'inlineStr') cell.text = clean(unxml((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || ''));
        else if (type === 'str' || type === 'e' || type === 'b') cell.text = clean(unxml(v ?? ''));
        else if (v !== undefined && v !== '') {
          const n = Number(v);
          if (st.kind === 'date' && n >= 1) { cell.date = excelDate(n); cell.text = cell.date; }
          else if (st.kind === 'time' || (st.kind === 'date' && n < 1)) { cell.time = excelTime(n); cell.text = cell.time; }
          else cell.text = clean(v);
        }
        out[ref ? col(ref) : out.length] = cell;
      }
      rows[rn] = Array.from(out, (x) => x || { text: '', fill: '' });
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    for (const m of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
      const c1 = col(m[1]), r1 = +m[2] - 1, c2 = col(m[3]), r2 = +m[4] - 1;
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        rows[r] = rows[r] || [];
        rows[r][c] = { ...(rows[r][c] || { text: '', fill: '' }), merged: true };
      }
    }
    return { name, rows };
  });
}

/** The first sheet with each cell's fill: { rows, fills } (empty rows dropped, rows and fills lined up). */
export function readXlsxStyled(bytes) {
  const [first] = readWorkbook(bytes);
  const keep = first.rows.filter((r) => r.some((c) => c?.text));
  return { rows: keep.map((r) => r.map((c) => c?.text || '')), fills: keep.map((r) => r.map((c) => c?.fill || '')) };
}

/**
 * pdf.js text ([{ page, str, x, y, w, h }], web/src/pdf.js pdfToItems) → visual lines, each split into cells where
 * the gap between words is wide: [{ page, y, cells: [{ text, x, x2 }] }].
 */
export function pdfLines(items) {
  const words = (items || []).filter((i) => clean(i.str)).map((i) => ({ ...i, str: clean(i.str), h: i.h || 8 }))
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && last.page === w.page && Math.abs(w.y - last.y) <= Math.max(2, w.h * 0.5)) last.words.push(w);
    else lines.push({ page: w.page, y: w.y, h: w.h, words: [w] });
  }
  return lines.map((l) => {
    const ws = l.words.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const w of ws) {
      const cur = cells[cells.length - 1];
      const gap = cur ? w.x - cur.x2 : Infinity;
      if (cur && gap < Math.max(6, w.h * 1.1)) { cur.text += (gap > w.h * 0.15 ? ' ' : '') + w.str; cur.x2 = w.x + (w.w || 0); } else cells.push({ text: w.str, x: w.x, x2: w.x + (w.w || 0) });
    }
    return { page: l.page, y: l.y, cells };
  });
}

/**
 * A PDF that's really a table → rows of cells, columns lined up under the header's words. Lines before the header
 * (titles) are dropped; a cell goes to the header column it starts under. Returns null when no header is found.
 */
export function pdfTable(items, target) {
  const lines = pdfLines(items);
  const asRows = lines.map((l) => l.cells.map((c) => c.text));
  const h = findHeaderRow(asRows, target, { min: 2 });
  if (h < 0) return null;
  const head = lines[h].cells;
  const columnOf = (x) => {
    let best = 0;
    for (let i = 0; i < head.length; i++) if (x >= head[i].x - 4) best = i;
    return best;
  };
  const rows = [head.map((c) => c.text)];
  for (const l of lines.slice(h + 1)) {
    if (l.cells.length === head.length && l.cells.every((c, i) => clean(c.text) === clean(head[i].text))) continue; // the header again on the next page
    const row = head.map(() => '');
    for (const c of l.cells) { const i = columnOf(c.x); row[i] = row[i] ? `${row[i]} ${c.text}` : c.text; }
    if (row.filter(Boolean).length) rows.push(row);
  }
  return rows;
}

/** Plain text (a Word document's paragraphs, a PDF's lines) that's laid out as a table: tabs, " | " or 2+ spaces between cells. */
export function textRows(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => (/\t/.test(l) ? l.split('\t') : / \| /.test(l) ? l.split(/\s*\|\s*/) : l.split(/\s{2,}/)).map(clean));
}

/** Whether rows look like a table: a header naming 2+ fields and most rows with 2+ cells. */
export function looksTabular(rows, target) {
  if (!rows?.length || rows.length < 2) return false;
  if (findHeaderRow(rows, target, { min: 2 }) < 0) return false;
  return rows.filter((r) => r.filter(Boolean).length >= 2).length >= rows.length * 0.6;
}

// ---------------------------------------------------------------- columns

/** How well a header names a field: 3 exact, 2 starts with / contains a name, 0 not at all. */
function headerScore(key, names) {
  if (!key) return 0;
  if (names.includes(key)) return 3;
  if (names.some((n) => n.length > 3 && (key.startsWith(`${n} `) || key.endsWith(` ${n}`) || key.includes(` ${n} `)))) return 2;
  return 0;
}

/** The header row: the first of the top 15 rows that names at least `min` fields of the target; -1 when none. */
export function findHeaderRow(rows, target, { min = 2 } = {}) {
  let best = { i: -1, score: 0 };
  for (const [i, r] of (rows || []).slice(0, 15).entries()) {
    const keys = r.map(headerKey);
    let score = FIELDS[target].filter((f) => keys.some((k) => headerScore(k, f.names) >= 2)).length;
    if (target === 'availability') score = Math.max(score, new Set(keys.map(dayOfHeader).filter((d) => d >= 0)).size + (keys.some((k) => headerScore(k, FIELDS.availability[0].names) >= 2) ? 1 : 0));
    if (score >= min && score > best.score) best = { i, score };
  }
  return best.i;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+(]?\d[\d\s().-]{6,}\d$/;
const PRICE = /^\$?\s?\d{1,4}([.,]\d{1,2})?$/;
/**
 * Guess each column's field. remembered: { headerKey: field | '' } from last time (wins, 'remembered'); then the
 * header's name ('exact' or 'likely'); then the values ('guess': emails, phone numbers, prices). A field is used once.
 * @returns [{ index, header, field: string | null, confidence: 'remembered' | 'exact' | 'likely' | 'guess' | null, sensitive? }]
 */
export function autoMap(header, target, { samples = [], remembered = null } = {}) {
  const fields = FIELDS[target];
  const used = new Set();
  const out = header.map((h, index) => ({ index, header: clean(h), field: null, confidence: null }));
  const colSamples = (i) => samples.map((r) => clean(r[i])).filter(Boolean).slice(0, 12);
  for (const c of out) {
    if (isSensitiveHeader(c.header)) { c.sensitive = true; c.confidence = 'exact'; }
  }
  if (remembered) {
    for (const c of out) {
      if (c.sensitive) continue;
      const k = headerKey(c.header);
      if (!(k in remembered)) continue;
      const f = remembered[k];
      if (f && fields.some((x) => x.key === f) && !used.has(f)) { c.field = f; used.add(f); c.confidence = 'remembered'; } else if (!f) c.confidence = 'remembered';
    }
  }
  for (const score of [3, 2]) {
    for (const c of out) {
      if (c.field || c.sensitive || c.confidence === 'remembered') continue;
      const k = headerKey(c.header);
      let hit = fields.find((f) => !used.has(f.key) && headerScore(k, f.names) >= score);
      // "Role" is a position (Server) unless its values are ShiftBoard roles (Manager, Employee), or another column is the positions.
      if (target === 'employees' && /^(role|roles|rol)$/.test(k) && !used.has('role')) {
        const vals = colSamples(c.index);
        const roles = vals.length && vals.filter((v) => parseRole(v)).length >= vals.length * 0.6;
        const positionsElsewhere = out.some((o) => o !== c && headerScore(headerKey(o.header), fields.find((f) => f.key === 'positions').names) === 3 && !/^(role|roles|rol)$/.test(headerKey(o.header)));
        if (roles || positionsElsewhere) hit = fields.find((f) => f.key === 'role');
      }
      if (hit) { c.field = hit.key; used.add(hit.key); c.confidence = score === 3 ? 'exact' : 'likely'; }
    }
  }
  for (const c of out) {
    if (c.field || c.sensitive || c.confidence === 'remembered') continue;
    const vals = colSamples(c.index);
    if (vals.length < 2) continue;
    const share = (re) => vals.filter((v) => re.test(v)).length / vals.length;
    const guess = share(EMAIL) >= 0.8 ? 'email' : target === 'employees' && share(PHONE) >= 0.8 ? 'phone' : target === 'menu' && share(PRICE) >= 0.8 ? 'price' : null;
    if (guess && fields.some((f) => f.key === guess) && !used.has(guess)) { c.field = guess; used.add(guess); c.confidence = 'guess'; }
  }
  // Availability: a header that names a weekday ("Mon 9/28", "Lunes") is that day; a sheet without a name header
  // ("" or "Week of …" over the names) has the people in its first column.
  if (target === 'availability') {
    for (const c of out) {
      if (c.field || c.sensitive || c.confidence === 'remembered') continue;
      const d = dayOfHeader(headerKey(c.header));
      if (d >= 0 && !used.has(DAY_FIELDS[d])) { c.field = DAY_FIELDS[d]; used.add(DAY_FIELDS[d]); c.confidence = 'likely'; }
    }
    if (!used.has('name') && !used.has('firstName') && !used.has('lastName') && used.size) {
      const first = out.find((c) => !c.field && !c.sensitive && c.confidence !== 'remembered' && colSamples(c.index).length);
      if (first && first.index < Math.min(...out.filter((c) => DAY_FIELDS.includes(c.field)).map((c) => c.index), Infinity)) { first.field = 'name'; used.add('name'); first.confidence = 'guess'; }
    }
  }
  // "Nombre" (or "First") with no last-name column and no name column: it's the whole name.
  if ((target === 'employees' || target === 'availability') && used.has('firstName') && !used.has('lastName') && !used.has('name')) {
    const c = out.find((x) => x.field === 'firstName' && x.confidence !== 'remembered');
    if (c) { c.field = 'name'; c.confidence = 'likely'; }
  }
  return out;
}

/** What to remember of a mapping: { headerKey: field or '' (ignored) }. Sensitive columns are never remembered. */
export function mappingToRemember(columns) {
  const out = {};
  for (const c of columns || []) {
    const k = headerKey(c.header);
    if (k && !c.sensitive && !isSensitiveHeader(c.header)) out[k] = c.field || '';
  }
  return out;
}

/**
 * Rows → records. Each record: { row (1-based line in the file), values: { field: text }, present: [fields mapped] }.
 * Several columns can't map to one field (autoMap uses each once; the wizard enforces it too).
 */
export function rowsToRecords(rows, headerRow, columns, { max = MAX_ROWS } = {}) {
  const mapped = (columns || []).filter((c) => c.field && !c.sensitive && !isSensitiveHeader(c.header));
  const present = [...new Set(mapped.map((c) => c.field))];
  const out = [];
  for (let i = headerRow + 1; i < rows.length && out.length < max; i++) {
    const r = rows[i];
    if (!r.some((x) => clean(x))) continue;
    const values = {};
    for (const c of mapped) values[c.field] = para(r[c.index]);
    if (!Object.values(values).some(Boolean)) continue;
    out.push({ row: i + 1, values, present });
  }
  return out;
}

// ---------------------------------------------------------------- simple readers for text that isn't a table

const PRICE_TAIL = /(?:\s*[.·…_-]{2,}\s*|\s+[-–—]\s+|\s+)\$?\s?(\d{1,4}(?:[.,]\d{2})?)\s*$/;
/**
 * A menu written as text (a PDF or Word menu without columns): SECTION headings (all capitals, or ending in ":"),
 * then "Item name ..... 14" lines, each with the lines under it as its description. Good enough to start from;
 * the AI reader does better with unusual layouts.
 */
export function menuFromText(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(clean).filter(Boolean);
  const labeled = menuFromLabeledText(lines);
  if (labeled) return labeled;
  const hasPrices = lines.filter((l) => PRICE_TAIL.test(l)).length >= 2;
  const out = [];
  let category = '';
  let cur = null;
  const heading = (l) => !PRICE_TAIL.test(l) && l.length <= 40 && l.split(' ').length <= 5 && (/:$/.test(l) || (l === l.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(l)));
  lines.forEach((l, i) => {
    if (heading(l)) { category = titleCase(l.replace(/:$/, '')); cur = null; return; }
    const m = l.match(PRICE_TAIL);
    if (hasPrices ? m : !cur || /[:–—]/.test(l)) {
      let name = m ? l.slice(0, m.index).trim() : l;
      let description = '';
      const split = name.match(/^(.{2,60}?)\s*[:–—]\s+(.+)$/) || name.match(/^(.{2,60}?)\s+-\s+(.+)$/);
      if (split) { name = split[1]; description = split[2]; }
      cur = { row: i + 1, values: { name: name.replace(/[.·…_]+$/, '').trim(), category, description, ...(m ? { price: m[1].replace(',', '.') } : {}) }, present: ['name', 'category', 'description', ...(hasPrices ? ['price'] : [])] };
      out.push(cur);
      return;
    }
    if (cur) cur.values.description = [cur.values.description, l].filter(Boolean).join(' ');
  });
  return out.filter((r) => r.values.name && r.values.name.length <= 80).slice(0, MAX_ROWS);
}

// A menu written as labeled blocks, one dish after another (a common kitchen/FOH document):
//   Dish name
//   Menu Price: $20.00
//   Description:            (the text on this line or the next ones)
//   Allergens: Egg, Wheat, Milk
//   Friendliness: Vegetarian, GF Possible
// with section headings (a short line on its own) between them. Labels in English or Spanish; any order.
const MENU_LABELS = [
  ['price', /^(?:menu\s+)?(?:price|precio)(?:\s+del\s+men[uú])?$/i],
  ['description', /^(?:description|descripci[oó]n|desc)$/i],
  ['allergens', /^(?:(?:major\s+)?allerg(?:ens?|ies|y)|al[eé]rgenos?|alergias?)$/i],
  ['dietary', /^(?:friendliness|dietary|diet|dieta|tags?)$/i],
  ['ingredients', /^(?:ingredients?|ingredientes?|key ingredients)$/i],
  ['recipe', /^(?:recipe|receta|build|spec|specs)$/i],
  ['prep', /^(?:prep(?:aration)?(?:\s+notes)?|preparaci[oó]n|kitchen notes)$/i],
  ['selling', /^(?:selling\s+notes?|server\s+notes?|notes?|notas?|talking points)$/i],
  ['pairings', /^(?:pairings?|maridaje|pair with)$/i],
  ['category', /^(?:category|section|course|categor[ií]a|secci[oó]n)$/i],
];
const labelOf = (line) => {
  const m = line.match(/^([^:]{2,30}):\s*(.*)$/);
  if (!m) return null;
  const hit = MENU_LABELS.find(([, re]) => re.test(m[1].trim()));
  return hit ? { field: hit[0], value: m[2].trim() } : null;
};
/** "GF Possible" / "DF possible" / "Treenut free possible": what a dish can be made, not what it is. */
const POSSIBLE = /\bpossible\b|\bon request\b|\ba pedido\b|\bopci[oó]n\b/i;
export function menuFromLabeledText(lines) {
  const labels = lines.map(labelOf);
  const count = labels.filter(Boolean).length;
  if (count < 4 || labels.filter((l) => l && (l.field === 'price' || l.field === 'allergens' || l.field === 'description')).length < 2) return null;
  // A dish starts at the line just before its first label (after a run of non-label lines).
  const out = [];
  let category = '';
  let cur = null;
  let last = null; // the field a following plain line continues (Description: then text below it)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lab = labels[i];
    if (lab) {
      if (!cur) continue; // a label before any dish name
      if (lab.field === 'category') { category = lab.value; cur.values.category = lab.value; last = null; continue; }
      const value = /^n\/?a\.?$/i.test(lab.value) ? '' : lab.value;
      cur.values[lab.field] = [cur.values[lab.field], value].filter(Boolean).join(' ');
      if (!cur.present.includes(lab.field)) cur.present.push(lab.field);
      last = lab.value ? null : lab.field; // "Description:" alone: its text is on the lines below
      continue;
    }
    // A plain line: a new dish when the next line is a label, a section heading when the line after it starts a dish,
    // otherwise more text for the label just above (Description:\n<text>).
    const next = labels[i + 1];
    // A new dish: the next line is a label and this isn't the text of an open label, or that label is already filled.
    if (next && (!last || !cur || cur.present.includes(next.field))) {
      cur = { row: i + 1, values: { name: line.replace(/[.·…_]+$/, '').trim(), category }, present: ['name', 'category'] };
      out.push(cur);
      last = null;
      continue;
    }
    const startsDishNext = i + 2 < lines.length && !labels[i + 1] && !!labels[i + 2];
    if (!last && (startsDishNext || !cur) && line.length <= 40 && line.split(' ').length <= 5) { category = titleCase(line.replace(/:$/, '')); cur = null; last = null; continue; }
    if (cur && last) cur.values[last] = [cur.values[last], line].filter(Boolean).join(last === 'recipe' ? '\n' : ' ');
  }
  // "GF Possible" → not a dietary tag, but a selling note; allergen details in brackets → a note too.
  for (const r of out) {
    const notes = [];
    if (r.values.allergens) r.values.allergens = r.values.allergens.replace(/\bsoy\s*beans?\b|\bsoybeans?\b/gi, 'soy').replace(/\btree\s*nuts?\b|\btreenuts?\b/gi, 'tree nuts');
    if (r.values.dietary) {
      const parts = splitList(r.values.dietary);
      const sure = parts.filter((t) => !POSSIBLE.test(t) && !/^n\/?a$/i.test(t));
      const maybe = parts.filter((t) => POSSIBLE.test(t)).map((t) => t.replace(POSSIBLE, '').trim()).filter(Boolean);
      r.values.dietary = sure.map((t) => t.replace(/\s*\(.*\)\s*$/, '')).join(', ');
      if (maybe.length) notes.push(`Can be made: ${parseDietary(maybe.join(', ')).join(', ') || maybe.join(', ')}`);
      const asides = parts.map((t) => t.match(/\((.+)\)/)?.[1]).filter(Boolean);
      if (asides.length) notes.push(`Dietary notes: ${asides.join('; ')}`);
    }
    if (r.values.allergens && /\(/.test(r.values.allergens)) {
      const asides = [...r.values.allergens.matchAll(/\(([^)]*)\)?/g)].map((m) => clean(m[1])).filter(Boolean);
      if (asides.length) notes.push(`Allergen notes: ${asides.join('; ')}`);
      r.values.allergens = r.values.allergens.replace(/\([^)]*\)?/g, ', ');
    }
    if (notes.length) {
      r.values.selling = [r.values.selling, ...notes].filter(Boolean).join('\n');
      if (!r.present.includes('selling')) r.present.push('selling');
    }
  }
  const rows = out.filter((r) => r.values.name && r.values.name.length <= 80);
  return rows.length >= 2 ? rows.slice(0, MAX_ROWS) : null;
}

const EMAIL_IN = /[^\s@<>,;()]+@[^\s@<>,;()]+\.[a-z]{2,}/i;
const PHONE_IN = /(?:\+?\(?\d[\d\s().-]{8,}\d)/;
/** A roster written as text: every line with an email or a phone number is a person (the rest of the line their name, then positions). */
export function rosterFromText(text) {
  const out = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    const l = clean(line);
    const email = (l.match(EMAIL_IN) || [])[0] || '';
    const phone = (l.replace(email, ' ').match(PHONE_IN) || [])[0] || '';
    if (!email && !phone) return;
    const rest = l.replace(email, ' ').replace(phone, ' ').split(/\s*[,;|\t]\s*|\s{2,}|\s[-–—]\s/).map(clean).filter((x) => x && /[a-zà-ÿ]/i.test(x));
    if (!rest.length) return;
    out.push({ row: i + 1, values: { name: rest[0], email, phone, positions: rest.slice(1).join(', ') }, present: ['name', 'email', 'phone', 'positions'] });
  });
  return out.slice(0, MAX_ROWS);
}

const titleCase = (s) => clean(s).toLowerCase().replace(/(^|[\s/&(-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());

// ---------------------------------------------------------------- values

const YES = new Set(['yes', 'y', 'true', '1', 'x', 'si', 's', 'active', 'activo', 'activa', 'available', 'disponible', 'on', 'ok', 'current', 'employed']);
const NO = new Set(['no', 'n', 'false', '0', 'inactive', 'inactivo', 'inactiva', 'terminated', 'termed', 'baja', 'dado de baja', 'off', 'unavailable', 'no disponible', 'left', 'former', 'separated', 'on leave']);
/** A yes/no cell: true, false, or null (empty or unknown). */
export function yesNo(v) {
  const k = valueKey(v);
  if (!k) return null;
  if (YES.has(k) || /^(yes|si)\b/.test(k)) return true;
  if (NO.has(k) || /^no\b/.test(k)) return false;
  return null;
}

/** A date cell → 'YYYY-MM-DD'; a birthday without a year → 'MM-DD'; null when it isn't a date. */
export function parseDay(v, { yearOptional = false } = {}) {
  const s = clean(v);
  if (!s) return null;
  const full = parseDate(s);
  if (full) return full;
  if (yearOptional) {
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    let m = s.match(/^(\d{1,2})[/.-](\d{1,2})$/);
    let mo = null, d = null;
    if (m) { mo = +m[1]; d = +m[2]; } else if ((m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/i)) && MONTHS.includes(m[1].toLowerCase())) { mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; d = +m[2]; }
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** A money cell ("$15.50", "15,50", "15") → 15.5, or null. */
export function parseMoney(v) {
  const s = clean(v).replace(/[$€£\s]|usd|mxn/gi, '');
  if (!s) return null;
  const n = Number(/^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}

const splitList = (v) => String(v ?? '').split(/\s*(?:[,;/|\n•·]|\band\b|\by\b|&)\s*/i).map(clean).filter(Boolean);
/** Emails compare in lower case without spaces. */
export const normEmail = (v) => clean(v).toLowerCase().replace(/\s+/g, '').replace(/^mailto:/, '');
/** Gmail ignores dots and anything after "+": the same mailbox written differently (a possible duplicate, not exact). */
export function emailVariantKey(v) {
  const e = normEmail(v);
  const [local, domain] = e.split('@');
  if (!domain) return e;
  return `${local.replace(/\+.*$/, '').replace(/\./g, '')}@${domain.replace(/^googlemail\.com$/, 'gmail.com')}`;
}
/** A phone number for comparing: +1 and the formatting don't matter ('(555) 201-3344', '+1 555.201.3344' → '+15552013344'). */
export function phoneKey(v) {
  const s = clean(v);
  if (!s) return '';
  const n = normalizePhone(s.replace(/\s*(ext|x)\.?\s*\d+$/i, ''));
  if (n) return n;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 ? digits.replace(/^1(?=\d{10}$)/, '') : '';
}
/** An employee or payroll ID for comparing: letters and digits, no leading zeros ('00123' = '123'). */
export const idKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');

/**
 * An employee record's values, cleaned. Returns { data: { name, legalFirstName, …, positions: [names] }, issues: [{ code, params }] }.
 * Fields not in the file are left out of data (an empty cell is '' or null).
 */
export function normalizeEmployee(values = {}) {
  const v = (k) => clean(values[k]);
  const data = {};
  const issues = [];
  const first = v('firstName'), last = v('lastName');
  let name = v('name');
  if (!name && (first || last)) name = [first, last].filter(Boolean).join(' ');
  if (name.includes(',') && !first && !last) name = splitName(name).display; // "Rivera, Ana" → "Ana Rivera"
  data.name = name.slice(0, 80);
  if ('legalFirstName' in values) data.legalFirstName = v('legalFirstName').slice(0, 60);
  if ('legalLastName' in values) data.legalLastName = v('legalLastName').slice(0, 60);
  if ('email' in values) {
    data.email = normEmail(values.email);
    if (data.email && !EMAIL.test(data.email)) { issues.push({ code: 'badEmail', params: { value: v('email') } }); data.email = ''; }
  }
  if ('phone' in values) {
    data.phone = v('phone').slice(0, 30);
    if (data.phone && !phoneKey(data.phone)) issues.push({ code: 'badPhone', params: { value: data.phone } });
  }
  if ('positions' in values) data.positions = [...new Set(splitList(values.positions).map((p) => p.slice(0, 60)))].slice(0, 12);
  if ('role' in values) {
    const r = parseRole(values.role);
    data.role = r || '';
    if (r === null) issues.push({ code: 'unknownRole', params: { value: v('role') } });
  }
  if ('hireDate' in values) { data.hireDate = parseDay(values.hireDate) || ''; if (v('hireDate') && !data.hireDate) issues.push({ code: 'badDate', params: { value: v('hireDate') } }); }
  if ('birthday' in values) { data.birthday = parseDay(values.birthday, { yearOptional: true }) || ''; if (v('birthday') && !data.birthday) issues.push({ code: 'badDate', params: { value: v('birthday') } }); }
  if ('employeeId' in values) data.employeeId = v('employeeId').slice(0, 40);
  if ('payRate' in values) { data.payRate = parseMoney(values.payRate); if (v('payRate') && data.payRate == null) issues.push({ code: 'badRate', params: { value: v('payRate') } }); }
  if ('notes' in values) data.notes = para(values.notes).slice(0, 1000);
  if ('primaryRoom' in values) data.primaryRoom = v('primaryRoom').slice(0, 60);
  if ('rooms' in values) data.rooms = [...new Set(splitList(values.rooms).map((r) => r.slice(0, 60)))].slice(0, 12);
  if ('active' in values) data.active = yesNo(values.active);
  return { data, issues };
}

const DIET = [
  ['gluten-free', ['gf', 'gluten free', 'glutenfree', 'sin gluten', 'libre de gluten', 'celiac']],
  ['vegan', ['vg', 'vegan', 'vegano', 'vegana', 'plant based']],
  ['vegetarian', ['v', 'veg', 'vegetarian', 'vegetariano', 'vegetariana', 'veggie']],
  ['dairy-free', ['df', 'dairy free', 'sin lacteos', 'sin lactosa', 'lactose free']],
  ['spicy', ['spicy', 'hot', 'picante', 'enchilado']],
];
/** 'GF, V' → ['gluten-free', 'vegetarian']; unknown tags are kept in lower case. */
export function parseDietary(v) {
  return [...new Set(splitList(v).map((t) => {
    const k = valueKey(t);
    const hit = DIET.find(([, words]) => words.includes(k));
    return hit ? hit[0] : k.slice(0, 30);
  }).filter(Boolean))];
}
/** 'Contains nuts, dairy & gluten' → ['tree nuts', 'milk', 'gluten'] (the 9 majors by their id, anything else as written). */
export function parseAllergens(v) {
  const words = splitList(String(v ?? '').replace(/\b(may contain|contains|contiene|puede contener|allergens?|alergenos?)\s*:?/gi, ' '));
  const out = [];
  for (const w of words) {
    const k = valueKey(w);
    if (!k || ['none', 'n a', 'na', 'ninguno', 'no'].includes(k)) continue;
    const id = k === 'nut' ? 'tree nuts' : k === 'gluten' ? 'gluten' : canonicalAllergen(w.replace(/[.]$/, ''));
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 20);
}
export const isMajorAllergen = (a) => MAJOR_ALLERGENS.some((m) => m.id === a);
export { DIETARY_TAGS };

/** A menu record's values, cleaned → { data, issues }. Fields not in the file are left out. */
export function normalizeMenuItem(values = {}) {
  const v = (k) => clean(values[k]);
  const data = { name: v('name').slice(0, 80) };
  const issues = [];
  if ('category' in values) data.category = titleCaseIfShouting(v('category')).slice(0, 40);
  if ('description' in values) data.description = para(values.description).slice(0, 1500);
  if ('ingredients' in values) data.keyIngredients = [...new Set(splitList(values.ingredients).map((x) => x.slice(0, 60)))].slice(0, 30);
  if ('allergens' in values) data.allergens = parseAllergens(values.allergens);
  if ('dietary' in values) data.dietary = parseDietary(values.dietary);
  if ('price' in values) {
    data.price = parseMoney(values.price);
    if (v('price') && data.price == null) issues.push({ code: 'badPrice', params: { value: v('price') } });
  }
  if ('selling' in values) data.sellingNotes = para(values.selling).slice(0, 3000);
  if ('pairings' in values) data.pairings = para(values.pairings).slice(0, 1000);
  if ('recipe' in values) data.recipeSteps = para(values.recipe).split(/\n|(?<=\.)\s+(?=\d+[.)]\s)/).map((s) => clean(s).replace(/^\d+[.)]\s*/, '')).filter(Boolean).slice(0, 40);
  if ('prep' in values) data.prepNotes = para(values.prep).slice(0, 3000);
  if ('nameEs' in values) data.nameEs = v('nameEs').slice(0, 80);
  if ('descriptionEs' in values) data.descriptionEs = para(values.descriptionEs).slice(0, 1500);
  const out86 = 'eightySixed' in values ? yesNo(values.eightySixed) : null;
  const avail = 'available' in values ? yesNo(values.available) : null;
  if ('eightySixed' in values || 'available' in values) data.eightySixed = out86 != null ? out86 : avail != null ? !avail : null;
  return { data, issues };
}
/** A product row (Stock lists' catalog): its name, category (a catalog id when the words say one), unit, size, par… */
const PRODUCT_CATEGORY_WORDS = [
  ['spirits', /spirit|liquor|licor|vodka|gin\b|rum\b|ron\b|tequila|mezcal|whisk|bourbon|scotch|brandy|cognac|liqueur/],
  ['beer', /beer|cerveza|lager|ipa\b|ale\b|keg|draft|cider|seltzer/], ['wine', /wine|vino|champagne|prosecco|cava|ros[eé]/],
  ['mixers', /mixer|soda|juice|jugo|syrup|jarabe|tonic|refresco/], ['garnish', /garnish|produce|fruit|fruta|guarnici/],
  ['glassware', /glass|cristal|vaso|copa/], ['smallwares', /smallware|utensil|tool|bar tool/], ['paper', /paper|papel|disposable|desechable|to go|napkin|servillet/],
  ['cleaning', /clean|limpieza|chemical|quimic|sanit/], ['dry', /dry|abarrote|pantry|kitchen/],
];
export function normalizeProduct(values = {}) {
  const issues = [];
  const data = {};
  const name = titleCaseIfShouting(clean(values.name)).slice(0, 80);
  if (name) data.name = name;
  if ('category' in values) {
    const k = valueKey(values.category);
    const hit = k ? PRODUCT_CATEGORY_WORDS.find(([, re]) => re.test(k)) : null;
    data.category = hit ? hit[0] : k ? 'other' : '';
    if (k && !hit) issues.push({ code: 'categoryOther', params: { name: clean(values.category) } });
  }
  for (const f of ['unit', 'size', 'location', 'supplier', 'notes']) if (f in values) data[f] = clean(values[f]).slice(0, f === 'notes' ? 300 : 80);
  if ('par' in values && clean(values.par)) {
    const n = Number(clean(values.par).replace(',', '.'));
    if (Number.isFinite(n) && n >= 0 && n <= 9999) data.par = n; else issues.push({ code: 'badPar', params: { value: clean(values.par) } });
  }
  return { data, issues };
}
const titleCaseIfShouting = (s) => (s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s) ? titleCase(s) : s);

/**
 * An availability row's values, cleaned: { data: { name, email?, phone?, employeeId?, mon … sun (the cell's text, as
 * written: core/availability.js reads it), notes?, maxHours?, maxDays? }, issues }. Days not in the file are left out.
 */
export function normalizeAvailabilityRow(values = {}) {
  const v = (k) => clean(values[k]);
  const data = {};
  const first = v('firstName'), last = v('lastName');
  let name = v('name');
  if (!name && (first || last)) name = [first, last].filter(Boolean).join(' ');
  if (name.includes(',') && !first && !last) name = splitName(name).display;
  data.name = name.slice(0, 80);
  if ('email' in values) { data.email = normEmail(values.email); if (data.email && !EMAIL.test(data.email)) data.email = ''; }
  if ('phone' in values) data.phone = v('phone').slice(0, 30);
  if ('employeeId' in values) data.employeeId = v('employeeId').slice(0, 40);
  for (const k of DAY_FIELDS) if (k in values) data[k] = v(k).slice(0, 200);
  if ('notes' in values) data.notes = para(values.notes).slice(0, 500);
  if ('maxHours' in values) data.maxHours = v('maxHours');
  if ('maxDays' in values) data.maxDays = v('maxDays');
  if ('requestedOn' in values) data.requestedOn = v('requestedOn');
  return { data, issues: [] };
}

// ---------------------------------------------------------------- likeness

/** Levenshtein distance, stopping early past `max`. */
export function editDistance(a, b, max = 99) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Typos allowed between two names: 15% of the length, at least 1, only for names of `minLen`+ letters. */
export const typoBudget = (s, minLen = 5) => (s.length >= minLen ? Math.max(1, Math.floor(s.length * 0.15)) : 0);

/** The confidence a likeness score stands for. */
export const confidenceOf = (score) => (score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low');
export const POSSIBLE_AT = 45; // below this, two records aren't the same

const tokens = (s) => nameKey(s).split(' ').filter(Boolean);
const sameNick = (a, b) => a === b || nicknamesOf(a).includes(b);
/**
 * How alike an incoming person is to an existing one, by name only (the callers check emails, IDs and phones first).
 * @returns { score: 0–100, reason } — reason: 'swapped' | 'middleInitial' | 'nickname' | 'legalName' | 'typo' | 'firstNameOnly'
 */
export function nameLikeness(incoming, existingName) {
  const a = tokens(incoming), b = tokens(existingName);
  if (!a.length || !b.length) return { score: 0 };
  const ja = a.join(' '), jb = b.join(' ');
  if (ja === jb) return { score: 100, reason: 'exact' };
  if (a.length > 1 && a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')) return { score: 85, reason: 'swapped' };
  const noInitials = (t) => t.filter((x) => x.length > 1);
  const na = noInitials(a), nb = noInitials(b);
  if (na.length >= 2 && na.join(' ') === nb.join(' ')) return { score: 85, reason: 'middleInitial' };
  // first and last: the first word and the last word (middle names aside)
  const fa = na[0] || a[0], la = na.length > 1 ? na[na.length - 1] : '';
  const fb = nb[0] || b[0], lb = nb.length > 1 ? nb[nb.length - 1] : '';
  if (la && lb) {
    const swappedLast = la === fb && lb === fa;
    if (swappedLast) return { score: 85, reason: 'swapped' };
    if (la === lb && fa !== fb && sameNick(fa, fb)) return { score: 75, reason: 'nickname' };
    if (la === lb && fa !== fb && fa.length >= 3 && fb.length >= 3 && (fa.startsWith(fb) || fb.startsWith(fa))) return { score: 65, reason: 'nickname' }; // Chris / Christopher not in the list
    // A one-letter slip in the last name (Lopez / Lopes). Not in first names: Maria and Mario are two people.
    const lastTypo = la !== lb && la.length >= 4 && la[0] === lb[0] && editDistance(la, lb, 1) <= 1;
    if ((fa === fb || sameNick(fa, fb)) && lastTypo) return { score: 60, reason: 'typo' };
    return { score: 0 };
  }
  // Only a first name on one side ("Alex" and "Alex Moreno"): the weakest kind.
  if ((!la || !lb) && fa && fb && (fa === fb || sameNick(fa, fb))) return { score: 45, reason: 'firstNameOnly' };
  return { score: 0 };
}

/**
 * An incoming person against an existing one. Exact matches (email, employee ID, phone, full or legal name) are
 * found by the caller; this scores the rest. Different emails or IDs on both sides: never the same person.
 * @param d    normalizeEmployee(…).data
 * @param u    a ShiftBoard user
 * @returns { score, confidence, reasons: [codes] } (score 0 = not alike)
 */
export function personLikeness(d, u) {
  const e1 = normEmail(d.email), e2 = normEmail(u.email);
  const sameVariant = e1 && e2 && e1 !== e2 && emailVariantKey(e1) === emailVariantKey(e2);
  if (e1 && e2 && e1 !== e2 && !sameVariant) return { score: 0, reasons: [] };
  const i1 = idKey(d.employeeId), i2s = [u.employeeId, u.adpId].map(idKey).filter(Boolean);
  if (i1 && i2s.length && !i2s.includes(i1)) return { score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  if (sameVariant) { score = 90; reasons.push('emailVariant'); }
  // Names: the common name against every name they answer to (common, legal first, legal full, the name on the schedule).
  let best = { score: 0 };
  const theirs = [...aliasesOf(u), u.sheetName].filter(Boolean);
  for (const n of theirs) {
    const r = nameLikeness(d.name, n);
    if (r.score > best.score) best = { ...r, reason: n === u.name || n === u.sheetName ? r.reason : r.reason === 'exact' ? 'legalName' : r.reason };
  }
  if (d.legalFirstName || d.legalLastName) {
    const r = nameLikeness([d.legalFirstName, d.legalLastName].filter(Boolean).join(' '), legalNameOf(u) || u.name);
    if (r.score > best.score) best = { ...r, reason: r.reason === 'exact' ? 'legalName' : r.reason };
  }
  if (best.score) {
    const s = best.score === 100 ? 70 : best.score; // the same name with nothing else to go on (another email, say) is a check
    if (s > score) score = s;
    reasons.push(best.reason === 'exact' ? 'sameName' : best.reason);
  }
  if (!score) return { score: 0, reasons: [] };
  // Supporting evidence: the same birthday or hire date.
  if (d.birthday && u.birthday && d.birthday.slice(-5) === String(u.birthday).slice(-5)) { score = Math.min(99, score + 10); reasons.push('sameBirthday'); }
  if (d.hireDate && u.hireDate && d.hireDate === u.hireDate) { score = Math.min(99, score + 5); reasons.push('sameHireDate'); }
  return { score, confidence: confidenceOf(score), reasons };
}

/** A menu item's name for exact comparing: accents, case, spacing and punctuation folded ("Crème Brûlée!" = "creme brulee"). */
export const itemKey = (s) => fold(s).replace(/[^a-z0-9]/g, '');
const SIZE_TAIL = /\s*(\((?:[^)]*)\)|\[[^\]]*\]|[-–—,]?\s*\$?\d+(?:[.,]\d+)?\s*(?:oz|ml|cl|l|lb|g|kg|in|inch|"|pc|pcs|piece|pieces|ct|onzas)?\.?|[-–—,]?\s*(?:small|medium|large|half|full|glass|bottle|carafe|pint|chico|mediano|grande|copa|botella))\s*$/i;
const singular = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 4 && /(ches|shes|sses|xes|zes|oes)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** A menu item's name with the things that don't make it another item taken off: a size or price on the end, plurals, "&". */
export function looseItemKey(s) {
  let t = fold(s).replace(/&/g, ' and ').replace(/\+/g, ' and ');
  for (let i = 0; i < 3 && SIZE_TAIL.test(t); i++) t = t.replace(SIZE_TAIL, '');
  return t.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !['the', 'el', 'la', 'los', 'las'].includes(w)).map(singular).join('');
}

/**
 * An incoming menu item against an existing one (exact: same name in the same section, found by the caller).
 * @returns { score, confidence, reasons }
 */
export function menuLikeness(d, it) {
  const sameCat = !d.category || itemKey(d.category) === itemKey(it.category);
  const reasons = [];
  let score = 0;
  if (itemKey(d.name) === itemKey(it.name)) { score = sameCat ? 100 : 65; reasons.push(sameCat ? 'sameName' : 'otherCategory'); }
  else {
    const la = looseItemKey(d.name), lb = looseItemKey(it.name);
    if (la && la === lb) {
      score = sameCat ? 85 : 60;
      const sized = (s) => SIZE_TAIL.test(fold(s));
      const amp = (s) => /&|\+/.test(s), and = (s) => /\b(and|y)\b/.test(fold(s));
      reasons.push(sized(d.name) || sized(it.name) ? 'sizeOrPrice' : amp(d.name) !== amp(it.name) || and(d.name) !== and(it.name) ? 'andSign' : 'plural');
      if (!sameCat) reasons.push('otherCategory');
    } else if (la && lb && la[0] === lb[0]) { // a slip, not another first letter (Coffee / Toffee)
      const budget = Math.min(typoBudget(la), typoBudget(lb));
      if (budget && editDistance(la, lb, budget) <= budget) { score = sameCat ? 70 : 50; reasons.push('typo'); if (!sameCat) reasons.push('otherCategory'); }
    }
  }
  if (it.es?.name && d.nameEs && itemKey(it.es.name) === itemKey(d.nameEs) && score) { score = Math.min(99, score + 10); reasons.push('sameSpanishName'); }
  return score ? { score, confidence: confidenceOf(score), reasons } : { score: 0, reasons: [] };
}

/**
 * An incoming product (Stock lists' catalog, core/products.js) against an existing one, by name: the menu's rules
 * without sections. exact 100 · a size on the end, plural or "&"/"and" 85 ("Bacardi Superior 1L" is "Bacardi
 * Superior") · a typo 70 (same first letter, ≤ 15% of 5+ letters). Never another first letter or another word
 * ("Bacardi Gold" isn't "Bacardi Superior", "Diet Coke" isn't "Coke"). A size on both that differs isn't the same.
 * @returns { score, confidence, reasons }
 */
// A product's size on the end ("1L", "750 ml", "(black)"): unlike a menu item's, "glass" or "bottle" is the product itself.
const PRODUCT_SIZE_TAIL = /\s*(\((?:[^)]*)\)|\[[^\]]*\]|[-–—,]?\s*\$?\d+(?:[.,]\d+)?\s*(?:oz|fl oz|ml|cl|l|lt|ltr|lb|lbs|g|kg|gal|qt|in|inch|"|pc|pcs|piece|pieces|ct|count|pk|pack|onzas)?\.?)\s*$/i;
/** A product's name with what doesn't make it another product taken off: a size on the end, plurals, "&". */
export function productLooseKey(s) {
  let t = fold(s).replace(/&/g, ' and ').replace(/\+/g, ' and ');
  for (let i = 0; i < 3 && PRODUCT_SIZE_TAIL.test(t); i++) t = t.replace(PRODUCT_SIZE_TAIL, '');
  return t.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !['the', 'el', 'la', 'los', 'las'].includes(w)).map(singular).join('');
}
export function productLikeness(name, other) {
  const sizeOf = (s) => (fold(s).match(/(\d+(?:[.,]\d+)?)\s*(oz|ml|cl|l|lb|g|kg|ct|pc|pcs)\.?\s*$/) || []).slice(1).join('');
  if (!itemKey(name) || !itemKey(other)) return { score: 0, reasons: [] };
  if (itemKey(name) === itemKey(other)) return { score: 100, confidence: 'high', reasons: ['sameName'] };
  const sa = sizeOf(name), sb = sizeOf(other);
  if (sa && sb && sa !== sb) return { score: 0, reasons: [] }; // a liter and a 750 ml are two products
  const la = productLooseKey(name), lb = productLooseKey(other);
  if (la && la === lb) {
    const sized = (s) => PRODUCT_SIZE_TAIL.test(fold(s));
    const amp = (s) => /&|\+/.test(s), and = (s) => /\b(and|y)\b/.test(fold(s));
    const reason = sized(name) || sized(other) ? 'sizeOrPrice' : amp(name) !== amp(other) || and(name) !== and(other) ? 'andSign' : 'plural';
    return { score: 85, confidence: 'high', reasons: [reason] };
  }
  if (la && lb && la[0] === lb[0]) {
    const budget = Math.min(typoBudget(la), typoBudget(lb));
    if (budget && editDistance(la, lb, budget) <= budget) return { score: 70, confidence: 'medium', reasons: ['typo'] };
  }
  return { score: 0, reasons: [] };
}

// ---------------------------------------------------------------- duplicates inside the file

/** The keys that make two rows of a roster the same person (any one in common, and none that disagree). */
function personKeys(d) {
  return { email: normEmail(d.email), id: idKey(d.employeeId), phone: phoneKey(d.phone), name: nameKey(d.name) };
}
/** The key that makes two rows of a menu the same item: its name, in its section when it has one. */
const itemRowKey = (d) => itemKey(d.name);

/**
 * Rows of the file that are the same person or item, merged: [{ rows: [records], data, conflicts: { field: [values] } }].
 * People: the same email, ID or phone, or the same full name with no email, ID or phone that disagrees.
 * Menu items: the same name in the same section (or one of them without a section).
 * Values that agree (or are empty in one row) merge; values that differ are conflicts for the manager to pick.
 */
export function groupRows(normalized, target) {
  const groups = [];
  for (const rec of normalized) {
    const d = rec.data;
    let into = null;
    if (target === 'employees' || target === 'availability') {
      const k = personKeys(d);
      into = groups.find((g) => {
        const o = personKeys(g.data);
        const disagree = ['email', 'id'].some((f) => k[f] && o[f] && k[f] !== o[f]);
        if (disagree) return false;
        if (['email', 'id', 'phone'].some((f) => k[f] && k[f] === o[f])) return true;
        return !!k.name && k.name === o.name && !(k.phone && o.phone && k.phone !== o.phone);
      });
    } else {
      const k = itemRowKey(d);
      into = k ? groups.find((g) => itemRowKey(g.data) === k && (!d.category || !g.data.category || itemKey(d.category) === itemKey(g.data.category))) : null;
    }
    if (!into) { groups.push({ rows: [rec], data: { ...d }, conflicts: {}, present: [...(rec.present || [])] }); continue; }
    into.rows.push(rec);
    into.present = [...new Set([...into.present, ...(rec.present || [])])];
    for (const [f, val] of Object.entries(d)) {
      if (isEmptyValue(val)) continue;
      const cur = into.data[f];
      if (isEmptyValue(cur)) { into.data[f] = val; continue; }
      if (sameField(target, f, cur, val)) continue;
      const opts = into.conflicts[f] || [cur];
      if (!opts.some((o) => sameField(target, f, o, val))) opts.push(val);
      into.conflicts[f] = opts;
    }
  }
  return groups;
}
/** Two values of one field the same? Names by their folded spelling, emails and phones as they compare, the rest as written. */
export function sameField(target, f, a, b) {
  if (f === 'name' || f === 'category' || f === 'nameEs' || f === 'legalFirstName' || f === 'legalLastName') return target !== 'employees' && target !== 'availability' ? itemKey(a) === itemKey(b) : nameKey(a) === nameKey(b);
  if (f === 'email') return normEmail(a) === normEmail(b);
  if (f === 'phone') return phoneKey(a) === phoneKey(b) && (!!phoneKey(a) || clean(a) === clean(b));
  if (f === 'employeeId') return idKey(a) === idKey(b);
  return sameValue(a, b);
}
export const isEmptyValue = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = (Array.isArray(a) ? a : [a]).map((s) => fold(s)).sort();
    const y = (Array.isArray(b) ? b : [b]).map((s) => fold(s)).sort();
    return x.join('|') === y.join('|');
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return clean(a) === clean(b);
}

// ---------------------------------------------------------------- templates

const TEMPLATES = {
  employees: [
    ['Name', 'Legal first name', 'Legal last name', 'Email', 'Phone', 'Positions', 'Role', 'Hire date', 'Birthday', 'Employee ID', 'Pay rate', 'Notes', 'Active'],
    ['Jamie Rivers', '', '', 'jamie.rivers@example.com', '(555) 010-2030', 'Server, Bartender', 'Employee', '2026-03-15', '04-12', 'E1001', '12.50', '', 'Yes'],
    ['Sam Okafor', 'Samuel', 'Okafor', 'sam.okafor@example.com', '555-010-4050', 'Host', 'Supervisor', '2025-11-01', '', 'E1002', '', 'Trains new hosts', 'Yes'],
  ],
  menu: [
    ['Name', 'Category', 'Description', 'Ingredients', 'Allergens', 'Dietary', 'Price', 'Selling notes', 'Recipe', 'Prep notes', 'Spanish name', 'Spanish description', 'Available'],
    ['Charred Carrots', 'Starters', 'Honey-glazed carrots with whipped feta', 'carrots, honey, feta, pistachio', 'milk, tree nuts', 'vegetarian, gluten-free', '11', 'Great to share; pairs with the rosé', '', 'Roast carrots ahead; glaze to order', 'Zanahorias asadas', 'Zanahorias glaseadas con miel y feta batido', 'Yes'],
    ['Garden Spritz', 'Cocktails', 'Elderflower, cucumber and soda', 'elderflower liqueur, cucumber, soda', '', 'vegan', '12', '', '1. Build over ice\n2. Top with soda', '', '', '', 'Yes'],
  ],
  availability: [
    ['Name', 'Email', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Notes', 'Max hours'],
    ['Jamie Rivers', 'jamie.rivers@example.com', '', 'OFF', 'after 4', 'after 4', '4p-cl', 'Doubles', 'AM', 'School until 2 on weekdays', '32'],
    ['Sam Okafor', 'sam.okafor@example.com', '11-3', '11-3', 'OFF', '', '', 'until 3', 'Requested off', '', ''],
  ],
  products: [
    ['Name', 'Category', 'Unit', 'Size', 'Par', 'Location', 'Supplier', 'Notes'],
    ['Silver rum', 'Spirits', 'bottle', '1 L', '6', 'Liquor room, shelf 2', 'Sample Beverage Co.', ''],
    ['Cocktail napkins', 'Paper', 'sleeve', '', '4', 'Dry storage, shelf 4', '', 'Black ones for the bar'],
  ],
};
const csvCell = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
/** A CSV template to fill in (invented sample rows), with a byte-order mark so Excel opens accents right. */
export const templateCsv = (target) => `\uFEFF${TEMPLATES[target].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
