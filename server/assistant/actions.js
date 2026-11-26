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
  set_availability: ['Change your availability', 'Cambiar tu disponibilidad'],
  offer_shift: ['Offer your shift', 'Ofrecer tu turno'],
  pick_up_shift: ['Pick up a shift', 'Recoger un turno'],
  cancel_request: ['Cancel a request', 'Cancelar una solicitud'],
  approve_request: ['Approve a request', 'Aprobar una solicitud'],
  deny_request: ['Deny a request', 'Rechazar una solicitud'],
  report_86_item: ['Report on the 86 List', 'Reportar en la Lista 86'],
  mark_back_in_stock: ['Mark back in stock', 'Marcar que ya hay'],
  save_event: ['Save an event', 'Guardar un evento'],
};

const LABELS = {
  date: ['Date', 'Fecha'], week: ['Week', 'Semana'], start: ['Start', 'Inicio'], end: ['End', 'Fin'], position: ['Position', 'Puesto'],
  room: ['Room', 'Salón'], person: ['Person', 'Persona'], tag: ['Tag', 'Etiqueta'], notes: ['Notes', 'Notas'], note: ['Note', 'Nota'],
  startDate: ['From', 'Desde'], endDate: ['To', 'Hasta'], reason: ['Reason', 'Motivo'], shiftId: ['Shift', 'Turno'],
  tradeForShiftId: ['For their shift', 'A cambio de su turno'], type: ['Type', 'Tipo'], requestId: ['Request', 'Solicitud'],
  timeOffId: ['Time off', 'Días libres'], item: ['Item', 'Artículo'], status: ['Status', 'Estado'], list: ['List', 'Lista'],
  count: ['Left', 'Quedan'], days: ['Days', 'Días'], name: ['Name', 'Nombre'], guestCount: ['Guests', 'Invitados'],
  eventId: ['Event', 'Evento'], captain: ['Captain', 'Capitán'], client: ['Client', 'Cliente'],
};
const VALUES = {
  out: ['86’d (out)', 'Se acabó (86)'], low: ['Running low', 'Queda poco'], giveaway: ['Give away', 'Ceder'], trade: ['Trade', 'Intercambiar'],
  tentative: ['Tentative', 'Tentativo'], confirmed: ['Confirmed', 'Confirmado'], cancelled: ['Cancelled', 'Cancelado'],
};
const OPEN = ['Open shift', 'Turno disponible'];
const UNTIL_CLOSE = ['Until close', 'Hasta el cierre'];
const WEEK_OF = ['Week of {date}', 'Semana del {date}'];
const UNAVAILABLE = ['not available', 'no disponible'];
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
    const label = LABELS[k] ? pick(LABELS[k], lang) : k;
    let value;
    if (k === 'date' || k === 'startDate' || k === 'endDate') value = date(v);
    else if (k === 'week') {
      try { value = pick(WEEK_OF, lang).replace('{date}', prettyDate(resolveWeek(v, today, look.weekStartDow ?? 1), { lang })); } catch { value = clip(v); }
    } else if (k === 'start') value = fmtTime(v, lang);
    else if (k === 'end') value = time(v);
    else if (k === 'person' && v === null) value = pick(OPEN, lang);
    else if ((k === 'shiftId' || k === 'tradeForShiftId') && look.shift?.(v)) {
      const s = look.shift(v);
      value = `${prettyDate(s.date, { lang })} ${fmtTime(s.start, lang)}${s.end ? `–${fmtTime(s.end, lang)}` : ''}${s.position ? ` · ${s.position}` : ''}`;
    } else if (k === 'days' && Array.isArray(v)) {
      value = v.map((d) => `${dayName(DAY_INDEX[d.day] ?? 0, 'short', lang)}: ${d.available === false ? pick(UNAVAILABLE, lang) : d.from || d.to ? `${fmtTime(d.from || '00:00', lang)}–${d.to ? fmtTime(d.to, lang) : '…'}` : '✓'}`).join(', ');
    } else if (k === 'staffing' && Array.isArray(v)) value = v.map((x) => `${x.count} ${x.position}`).join(', ');
    else if (typeof v === 'string' && VALUES[v]) value = pick(VALUES[v], lang);
    else if (typeof v === 'object' && v !== null) value = clip(JSON.stringify(v));
    else value = clip(v);
    details.push([label, value]);
  }
  return { title, details };
}

