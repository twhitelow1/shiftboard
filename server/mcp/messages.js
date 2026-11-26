// What the Claude connector says to people when something stops it, in English and Spanish ("tú", neutral
// Latin American; docs/i18n/GLOSSARY.md). Errors from the business logic (core/) are translated with
// core/errors.js like everywhere else; these are the connector's own.

const MSG = {
  en: {
    signInAgain: 'Your ShiftBoard connection has ended (you signed out everywhere, changed your password, or it was disconnected). Reconnect ShiftBoard in Claude: Settings → Connectors.',
    noToken: 'Sign in to ShiftBoard to use it from Claude.',
    notInPlan: 'The Claude connector isn’t included in this restaurant’s ShiftBoard plan.',
    turnedOff: 'An admin turned off the Claude connector for this restaurant.',
    paused: 'This restaurant’s ShiftBoard account is paused. Contact DubLow Digital.',
    rateLimited: 'Too many requests from Claude right now. Wait a minute and try again.',
    readOnly: 'This connection is read-only, so Claude can look things up but can’t make changes. To allow changes, disconnect and connect ShiftBoard again with changes allowed.',
    unavailable: 'That isn’t available to you in ShiftBoard.',
    failed: 'Something went wrong in ShiftBoard. Try again in a minute.',
    badInput: 'Some of the details weren’t right: {details}',
  },
  es: {
    signInAgain: 'Tu conexión con ShiftBoard terminó (cerraste sesión en todos lados, cambiaste tu contraseña o se desconectó). Vuelve a conectar ShiftBoard en Claude: Configuración → Conectores.',
    noToken: 'Inicia sesión en ShiftBoard para usarlo desde Claude.',
    notInPlan: 'El conector de Claude no está incluido en el plan de ShiftBoard de este restaurante.',
    turnedOff: 'Un administrador apagó el conector de Claude para este restaurante.',
    paused: 'La cuenta de ShiftBoard de este restaurante está en pausa. Comunícate con DubLow Digital.',
    rateLimited: 'Claude está mandando demasiadas solicitudes en este momento. Espera un minuto y vuelve a intentarlo.',
    readOnly: 'Esta conexión es de solo lectura: Claude puede consultar, pero no hacer cambios. Para permitir cambios, desconecta ShiftBoard y vuelve a conectarlo permitiendo cambios.',
    unavailable: 'Eso no está disponible para ti en ShiftBoard.',
    failed: 'Algo salió mal en ShiftBoard. Inténtalo de nuevo en un minuto.',
    badInput: 'Algunos datos no estaban bien: {details}',
  },
};

/** The connector's own message in a language ('en' or 'es'). */
export function say(key, lang = 'en', params = {}) {
  const s = (MSG[lang] || MSG.en)[key] || MSG.en[key] || key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// The plain page /oauth/authorize shows when the request can't even be sent back to the app (unknown client,
// redirect URI not allowed): both languages, like the "restaurant not found" page.
const PAGE = {
  badClient: ['This connection link isn’t valid for this restaurant. Start again from Claude: Settings → Connectors.', 'Este enlace de conexión no es válido para este restaurante. Vuelve a empezar desde Claude: Configuración → Conectores.'],
  badRedirect: ['This app isn’t allowed to connect to ShiftBoard.', 'Esta aplicación no tiene permiso para conectarse a ShiftBoard.'],
  notInPlan: [MSG.en.notInPlan, MSG.es.notInPlan],
  turnedOff: [MSG.en.turnedOff, MSG.es.turnedOff],
  paused: [MSG.en.paused, MSG.es.paused],
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function errorPage(key) {
  const [en, es] = PAGE[key] || PAGE.badClient;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ShiftBoard</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#0f172a}
main{max-width:420px;padding:28px 20px;text-align:center}h1{font-size:21px;margin:0 0 10px}p{color:#475569;margin:8px 0}</style></head>
<body><main><h1>ShiftBoard</h1><p>${esc(en)}</p><p lang="es">${esc(es)}</p></main></body></html>`;
}
