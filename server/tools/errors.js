// The tools' messages to people, in English or Spanish ("tú"). Errors from core/ go through core/errors.js like
// everywhere else; the tools' own sentences are below (the model reads them and passes them on).
import { translateError } from '../../core/errors.js';

const KEYS = {
  en: {
    unavailable: 'That isn’t available to you in ShiftBoard.',
    'read-only': 'This connection is read-only, so Claude can look things up but can’t make changes. To allow changes, disconnect and connect ShiftBoard again with changes allowed.',
    badInput: 'Some of the details weren’t right: {details}',
    signInAgain: 'Your ShiftBoard connection has ended (you signed out everywhere, changed your password, or it was disconnected). Reconnect ShiftBoard in Claude: Settings → Connectors.',
    failed: 'Something went wrong in ShiftBoard. Try again in a minute.',
  },
  es: {
    unavailable: 'Eso no está disponible para ti en ShiftBoard.',
    'read-only': 'Esta conexión es de solo lectura: Claude puede consultar, pero no hacer cambios. Para permitir cambios, desconecta ShiftBoard y vuelve a conectarlo permitiendo cambios.',
    badInput: 'Algunos datos no estaban bien: {details}',
    signInAgain: 'Tu conexión con ShiftBoard terminó (cerraste sesión en todos lados, cambiaste tu contraseña o se desconectó). Vuelve a conectar ShiftBoard en Claude: Configuración → Conectores.',
    failed: 'Algo salió mal en ShiftBoard. Inténtalo de nuevo en un minuto.',
  },
};

// The tools' own errors (English as the code writes them) in Spanish.
const ES = {
  'The end date is before the start date': 'La fecha final es anterior a la fecha de inicio',
  'Pick a day from today on': 'Elige un día de hoy en adelante',
  'Give either shiftId (an open shift) or requestId (a giveaway or trade)': 'Indica shiftId (un turno libre) o requestId (un turno cedido o un intercambio), no los dos',
  'Give either requestId or timeOffId': 'Indica requestId o timeOffId, no los dos',
  'Give eventId or name': 'Indica eventId o el nombre del evento',
  'A new event needs a name and a date': 'Un evento nuevo necesita nombre y fecha',
  'Give a guest count or an event': 'Indica el número de invitados o un evento',
  'Shift not found': 'No se encontró el turno',
  'That shift is published: changing it notifies the people on it. Ask the user, then call again with confirm: true.': 'Ese turno ya está publicado: si lo cambias, se avisa a quienes están en él. Pregúntale al usuario y vuelve a llamar con confirm: true.',
  'That shift is published: deleting it notifies the person on it. Ask the user, then call again with confirm: true.': 'Ese turno ya está publicado: si lo borras, se le avisa a quien lo tiene. Pregúntale al usuario y vuelve a llamar con confirm: true.',
};
const PATTERNS = [
  [/^Use a date like (\S+), “today”, “tomorrow” or a weekday$/, (m) => `Usa una fecha como ${m[1]}, “hoy”, “mañana” o un día de la semana`],
  [/^No (person|position) matches “(.+)”$/, (m) => `${m[1] === 'person' ? 'Ninguna persona' : 'Ningún puesto'} coincide con “${m[2]}”`],
  [/^More than one (?:person|position|item|list|event) matches “(.+?)”(?:: (.+))?$/, (m) => `Hay más de una coincidencia para “${m[1]}”${m[2] ? `: ${m[2]}` : ''}`],
  [/^No 86 list matches “(.+)”\. Lists: (.+)$/, (m) => `Ninguna lista del 86 coincide con “${m[1]}”. Listas: ${m[2]}`],
  [/^“(.+)” isn’t on the 86 list$/, (m) => `“${m[1]}” no está en la lista del 86`],
];

/** A key above (with {params}) or an error message, in the person's language. */
export function toolError(keyOrMessage, lang = 'en', params = {}) {
  const msg = String(keyOrMessage ?? '');
  if (Object.prototype.hasOwnProperty.call(KEYS.en, msg)) {
    return ((KEYS[lang] || KEYS.en)[msg] || KEYS.en[msg]).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  }
  if (lang !== 'es') return msg;
  if (ES[msg]) return ES[msg];
  for (const [re, make] of PATTERNS) { const m = msg.match(re); if (m) return make(m); }
  return translateError(msg, lang);
}
