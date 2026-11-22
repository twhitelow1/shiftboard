// Industry-standard banquet staffing ratios used to suggest BEO staffing.
// Ratios are guests per staff member by service style.
// es: the style's name in Spanish (styleLabel picks it).
export const SERVICE_STYLES = {
  plated: { label: 'Plated dinner', es: 'Cena servida a la mesa', server: 20, bartender: 75, runner: 40, busser: 50 },
  family: { label: 'Family style', es: 'Estilo familiar', server: 25, bartender: 75, runner: 35, busser: 50 },
  buffet: { label: 'Buffet', es: 'Bufé', server: 35, bartender: 75, runner: 60, busser: 45 },
  stations: { label: 'Stations', es: 'Estaciones', server: 40, bartender: 60, runner: 60, busser: 45 },
  reception: { label: 'Reception / passed apps', es: 'Recepción / bocadillos pasados', server: 30, bartender: 50, runner: 50, busser: 60 },
  cocktail: { label: 'Bar / cocktail only', es: 'Solo barra / cóctel', server: 50, bartender: 50, runner: 0, busser: 75 },
};
/** A service style's name in a language. */
export const styleLabel = (style, lang = 'en') => (style ? (lang === 'es' && style.es) || style.label : '');

const ROLE_MATCHERS = {
  captain: /captain|\bbc\b/i,
  server: /^server|cocktail server|^server$/i,
  bartender: /bartend|^bar\b|\bbar$/i,
  runner: /runner/i,
  busser: /busser|barback/i,
  host: /host|door/i,
};

function findJob(jobCodes, role) {
  const re = ROLE_MATCHERS[role];
  // Prefer job codes flagged for events, then any matching.
  const active = jobCodes.filter((j) => !j.archived);
  return (
    active.find((j) => j.eventRole && re.test(j.name)) ||
    active.find((j) => re.test(j.name)) ||
    null
  );
}

/** Suggest staffing lines for an event. Returns [{jobCodeId, count, start, end, notes}]; notes in `lang`. */
export function suggestStaffing(event, jobCodes, lang = 'en') {
  const es = lang === 'es';
  const guests = Number(event.guestCount) || 0;
  const style = SERVICE_STYLES[event.serviceStyle] || SERVICE_STYLES.plated;
  if (!guests) return [];
  // Staff arrive 1 hour before guests for setup; stay 1 hour after for breakdown.
  const [sh, sm] = (event.start || '17:00').split(':').map(Number);
  const [eh, em] = (event.end || '22:00').split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const callTime = `${pad((sh + 23) % 24)}:${pad(sm)}`;
  const outTime = `${pad((eh + 1) % 24)}:${pad(em)}`;

  const lines = [];
  const push = (role, count, notes) => {
    const jc = findJob(jobCodes, role);
    if (jc && count > 0) lines.push({ jobCodeId: jc.id, count, start: callTime, end: outTime, notes });
  };
  const per = (n) => (es ? `1 por cada ${n} invitados` : `1 per ${n} guests`);
  if (guests >= 30 || event.serviceStyle === 'plated') push('captain', guests >= 150 ? 2 : 1, es ? 'Dirige el salón y los tiempos; contacto con el cliente' : 'Runs the floor & timeline, client point of contact');
  push('server', style.server ? Math.ceil(guests / style.server) : 0, `${per(style.server)} (${styleLabel(style, lang)})`);
  push('bartender', style.bartender ? Math.ceil(guests / style.bartender) : 0, per(style.bartender));
  push('runner', style.runner ? Math.ceil(guests / style.runner) : 0, per(style.runner));
  push('busser', style.busser ? Math.ceil(guests / style.busser) : 0, per(style.busser));
  if (guests >= 100) push('host', 1, es ? 'Puerta / registro de invitados' : 'Door / check-in');
  return lines;
}
