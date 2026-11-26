// What people read when ShiftBoard's AI can't answer right now, in English and Spanish ("tú"). Friendly sentences,
// never an error page: the assistant shows them as its reply, and other features (review replies) show them where
// the draft would have gone.
const TEXT = {
  en: {
    cap: 'Ask ShiftBoard has used this month’s AI allowance for {restaurant}. It starts again on the 1st. An admin can ask DubLow Digital for more, or add the restaurant’s own Anthropic key in Settings → Integrations.',
    daily: 'You’ve sent {limit} messages to Ask ShiftBoard today, the daily limit. It resets tomorrow. Everything is still in the app as usual.',
    rate: 'That’s a lot of questions at once. Wait a minute and try again.',
    no_key: 'Ask ShiftBoard isn’t set up yet. DubLow Digital is on it.',
    off: 'Ask ShiftBoard is turned off for {restaurant} right now.',
    plan: 'Ask ShiftBoard isn’t included in this restaurant’s plan.',
    staff: 'Your restaurant has Ask ShiftBoard for managers only right now.',
    role: 'Ask ShiftBoard isn’t part of your role. Ask an admin if you need it.',
    viewAs: 'You’re viewing ShiftBoard as someone else, so Ask ShiftBoard is off: it can’t act as them, and nothing is spent. Exit View as to use it yourself.',
    support: 'Ask ShiftBoard can look things up, but can’t make changes while DubLow Digital is signed in for support.',
    api: 'Ask ShiftBoard couldn’t answer just now. Try again in a minute.',
    busy: 'Ask ShiftBoard is busy right now. Try again in a minute.',
    long: 'That took too long to work out. Try asking about a shorter time span, or one thing at a time.',
    loop: 'I looked up quite a lot and couldn’t finish. Try asking something more specific.',
    refusal: 'I can’t help with that one. Ask me about shifts, the schedule, time off, the 86 List and the rest of ShiftBoard.',
    warn80: 'Ask ShiftBoard has used {pct}% of this month’s AI allowance (${used} of ${cap}). When it runs out, it stops until the 1st. Settings → Ask ShiftBoard has the details.',
  },
  es: {
    cap: 'Pregúntale a ShiftBoard ya usó la asignación de IA de este mes para {restaurant}. Vuelve a funcionar el día 1. Un administrador puede pedirle más a DubLow Digital o agregar la clave de Anthropic del restaurante en Configuración → Integraciones.',
    daily: 'Hoy ya enviaste {limit} mensajes a Pregúntale a ShiftBoard, el límite diario. Se reinicia mañana. Todo lo demás sigue en la app como siempre.',
    rate: 'Son muchas preguntas a la vez. Espera un minuto y vuelve a intentarlo.',
    no_key: 'Pregúntale a ShiftBoard todavía no está configurado. DubLow Digital se está encargando.',
    off: 'Pregúntale a ShiftBoard está desactivado en {restaurant} por ahora.',
    plan: 'Pregúntale a ShiftBoard no está incluido en el plan de este restaurante.',
    staff: 'Por ahora tu restaurante tiene Pregúntale a ShiftBoard solo para gerentes.',
    role: 'Pregúntale a ShiftBoard no forma parte de tu rol. Pídeselo a un administrador si lo necesitas.',
    viewAs: 'Estás viendo ShiftBoard como otra persona, así que Pregúntale a ShiftBoard está desactivado: no puede actuar como esa persona y no se gasta nada. Sal de Ver como para usarlo tú.',
    support: 'Pregúntale a ShiftBoard puede consultar, pero no hacer cambios mientras DubLow Digital tiene la sesión abierta para soporte.',
    api: 'Pregúntale a ShiftBoard no pudo responder en este momento. Inténtalo de nuevo en un minuto.',
    busy: 'Pregúntale a ShiftBoard está ocupado en este momento. Inténtalo de nuevo en un minuto.',
    long: 'Eso tardó demasiado. Pregunta por un periodo más corto, o una cosa a la vez.',
    loop: 'Consulté bastante y no pude terminar. Intenta con una pregunta más concreta.',
    refusal: 'Con eso no te puedo ayudar. Pregúntame sobre turnos, el horario, días libres, la Lista 86 y lo demás de ShiftBoard.',
    warn80: 'Pregúntale a ShiftBoard ya usó el {pct}% de la asignación de IA de este mes (${used} de ${cap}). Cuando se acabe, se detiene hasta el día 1. Los detalles están en Configuración → Pregúntale a ShiftBoard.',
  },
};

export const AI_MESSAGE_KEYS = Object.keys(TEXT.en);

/** A sentence for a reason ('cap', 'daily', …) in a language, with {params} filled in. */
export function aiMessage(key, lang = 'en', params = {}) {
  const table = TEXT[lang === 'es' ? 'es' : 'en'];
  const s = table[key] || table.api;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** Both languages, for a notification (core/service.js keeps { en, es } and shows each person theirs). */
export const aiMessageBoth = (key, params = {}) => ({ en: aiMessage(key, 'en', params), es: aiMessage(key, 'es', params) });
