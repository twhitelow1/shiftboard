// What a proposed change says on its card ("Publish the week · Week: Mon, Dec 1"), in the person's language.
// The model's own words explain it above the card; the card states exactly what Confirm will do, from the tool's
// arguments (dates resolved the way the tool will resolve them).
import { prettyDate, fmtTime, dayName } from '../../core/time.js';
import { resolveDate, resolveWeek } from '../tools/dates.js';

const TITLES = {
  create_shift: ['Add a draft shift', 'Agregar un turno en borrador'],
  update_shift: ['Change a shift', 'Cambiar un turno'],
  delete_shift: ['Delete a shift', 'Borrar un turno'],
  publish_week: ['Publish the week', 'Publicar la semana'],
  request_time_off: ['Request time off', 'Pedir días libres'],
  set_availability: ['Change availability', 'Cambiar la disponibilidad'],
  offer_shift: ['Offer your shift', 'Ofrecer tu turno'],
  pick_up_shift: ['Pick up a shift', 'Recoger un turno'],
  cancel_request: ['Cancel a request', 'Cancelar una solicitud'],
  approve_request: ['Approve a request', 'Aprobar una solicitud'],
  deny_request: ['Deny a request', 'Rechazar una solicitud'],
  report_86_item: ['Report on the 86 List', 'Reportar en la Lista 86'],
  mark_back_in_stock: ['Mark back in stock', 'Marcar que ya hay'],
  save_event: ['Save an event', 'Guardar un evento'],
  save_menu_item: ['Save a menu item', 'Guardar un platillo del menú'],
  import_menu_items: ['Import menu items', 'Importar platillos al menú'],
  import_employees: ['Import people to the team', 'Importar personas al equipo'],
  create_stock_list: ['Create a stock list', 'Crear una lista de surtido'],
  add_product: ['Add a product to the catalog', 'Agregar un producto al catálogo'],
};
// A label that means something else for one tool (a product's category isn't a menu section).
const TOOL_LABELS = {
  add_product: { category: ['Category', 'Categoría'], createNew: ['Add even if it looks like a duplicate', 'Agregar aunque parezca duplicado'] },
  create_stock_list: { name: ['List', 'Lista'], template: ['Save as a template', 'Guardar como plantilla'] },
};

const LABELS = {
  date: ['Date', 'Fecha'], week: ['Week', 'Semana'], start: ['Start', 'Inicio'], end: ['End', 'Fin'], position: ['Position', 'Puesto'],
  room: ['Room', 'Salón'], person: ['Person', 'Persona'], tag: ['Tag', 'Etiqueta'], notes: ['Notes', 'Notas'], note: ['Note', 'Nota'],
  startDate: ['From', 'Desde'], endDate: ['To', 'Hasta'], reason: ['Reason', 'Motivo'], shiftId: ['Shift', 'Turno'],
  tradeForShiftId: ['For their shift', 'A cambio de su turno'], type: ['Type', 'Tipo'], requestId: ['Request', 'Solicitud'],
  timeOffId: ['Time off', 'Días libres'], item: ['Item', 'Artículo'], status: ['Status', 'Estado'], list: ['List', 'Lista'],
  count: ['Left', 'Quedan'], days: ['Days', 'Días'], name: ['Name', 'Nombre'], guestCount: ['Guests', 'Invitados'],
  eventId: ['Event', 'Evento'], captain: ['Captain', 'Capitán'], client: ['Client', 'Cliente'],
  items: ['Items', 'Platillos'], people: ['People', 'Personas'], decisions: ['Possible duplicates', 'Posibles duplicados'], category: ['Section', 'Sección'],
  description: ['Description', 'Descripción'], price: ['Price', 'Precio'], allergens: ['Allergens', 'Alérgenos'], dietary: ['Dietary', 'Dieta'], itemId: ['Item', 'Platillo'],
  createCategories: ['Create missing sections', 'Crear secciones que faltan'], createPositions: ['Create missing positions', 'Crear puestos que faltan'],
  sendInvitations: ['Send invitations now', 'Enviar invitaciones ahora'], createNew: ['Add as a separate item', 'Agregar como platillo aparte'],
  products: ['Products', 'Productos'], due: ['Due', 'Para las'], unit: ['Unit', 'Unidad'], size: ['Size', 'Tamaño'], location: ['Kept in', 'Se guarda en'],
  supplier: ['Supplier', 'Proveedor'],
};
const CATEGORY_VALUES = {
  spirits: ['Spirits', 'Licores'], beer: ['Beer', 'Cerveza'], wine: ['Wine', 'Vino'], mixers: ['Mixers', 'Mezcladores'], garnish: ['Garnish', 'Guarniciones'],
  glassware: ['Glassware', 'Cristalería'], smallwares: ['Smallwares', 'Utensilios'], paper: ['Paper & disposables', 'Papel y desechables'], cleaning: ['Cleaning', 'Limpieza'],
  dry: ['Kitchen dry goods', 'Abarrotes de cocina'], other: ['Other', 'Otros'],
};
const VALUES = {
  out: ['86’d (out)', 'Se acabó (86)'], low: ['Running low', 'Queda poco'], giveaway: ['Give away', 'Ceder'], trade: ['Trade', 'Intercambiar'],
  tentative: ['Tentative', 'Tentativo'], confirmed: ['Confirmed', 'Confirmado'], cancelled: ['Cancelled', 'Cancelado'],
};
const OPEN = ['Open shift', 'Turno disponible'];
const UNTIL_CLOSE = ['Until close', 'Hasta el cierre'];
const WEEK_OF = ['Week of {date}', 'Semana del {date}'];
const UNAVAILABLE = ['not available', 'no disponible'];
const YES_NO = [['Yes', 'Sí'], ['No', 'No']];
const DECIDED = { update: ['update', 'actualizar'], skip: ['skip', 'omitir'], new: ['new', 'nuevo'] };
const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const HIDDEN = new Set(['confirm']);

const pick = (pair, lang) => pair[lang === 'es' ? 1 : 0];
const clip = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The card for one proposed change: { title, details: [[label, value], …] }.
 * look: { today, weekStartDow, shift(id) → { date, start, end, position } | null } for friendlier values.
 */
export function describeAction(tool, args = {}, lang = 'en', look = {}) {
  const title = TITLES[tool.name] ? pick(TITLES[tool.name], lang) : tool.title;
  const today = look.today;
  const date = (v) => { try { const d = today ? resolveDate(v, today) : v; return prettyDate(d, { lang }); } catch { return clip(v); } };
  const time = (v) => (v ? fmtTime(v, lang) : pick(UNTIL_CLOSE, lang));
  const details = [];
  for (const [k, v] of Object.entries(args)) {
    if (HIDDEN.has(k) || v === undefined || v === '') continue;
    const own = TOOL_LABELS[tool.name]?.[k];
    const label = own ? pick(own, lang) : LABELS[k] ? pick(LABELS[k], lang) : k;
    let value;
    if (k === 'date' || k === 'startDate' || k === 'endDate') value = date(v);
    else if (k === 'week') {
      try { value = pick(WEEK_OF, lang).replace('{date}', prettyDate(resolveWeek(v, today, look.weekStartDow ?? 1), { lang })); } catch { value = clip(v); }
    } else if (k === 'start' || k === 'due') value = fmtTime(v, lang);
    else if (k === 'products' && Array.isArray(v)) value = clip(v.map((x) => `${x.qty ?? 1} × ${x.name}`).join(', '), 200); // a stock list's lines
    else if (k === 'category' && tool.name === 'add_product' && CATEGORY_VALUES[v]) value = pick(CATEGORY_VALUES[v], lang);
    else if (k === 'end') value = time(v);
    else if (k === 'person' && v === null) value = pick(OPEN, lang);
    else if ((k === 'shiftId' || k === 'tradeForShiftId') && look.shift?.(v)) {
      const s = look.shift(v);
      value = `${prettyDate(s.date, { lang })} ${fmtTime(s.start, lang)}${s.end ? `–${fmtTime(s.end, lang)}` : ''}${s.position ? ` · ${s.position}` : ''}`;
    } else if (k === 'days' && Array.isArray(v)) {
      value = v.map((d) => `${dayName(DAY_INDEX[d.day] ?? 0, 'short', lang)}: ${d.available === false ? pick(UNAVAILABLE, lang) : d.from || d.to ? `${fmtTime(d.from || '00:00', lang)}–${d.to ? fmtTime(d.to, lang) : '…'}` : '✓'}`).join(', ');
    } else if (k === 'staffing' && Array.isArray(v)) value = v.map((x) => `${x.count} ${x.position}`).join(', ');
    else if ((k === 'items' || k === 'people') && Array.isArray(v)) { // an import: how many, and the first names
      const names = v.map((x) => x?.name || [x?.firstName, x?.lastName].filter(Boolean).join(' ')).filter(Boolean);
      value = clip(`${v.length}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}`, 160);
    } else if (k === 'decisions' && Array.isArray(v)) value = clip(v.map((d) => `${d.row} ${pick(DECIDED[d.action] || [d.action, d.action], lang)}`).join(', '), 160);
    else if (typeof v === 'boolean') value = pick(YES_NO[v ? 0 : 1], lang);
    else if (typeof v === 'string' && VALUES[v]) value = pick(VALUES[v], lang);
    else if (typeof v === 'object' && v !== null) value = clip(JSON.stringify(v));
    else value = clip(v);
    details.push([label, value]);
  }
  return { title, details };
}

