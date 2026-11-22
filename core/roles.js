// Roles and permissions. One source of truth for the server, the in-browser demo and the UI.
//
// Roles are a ladder: each one can do everything the roles below it can.
// Event/BEO editing is a separate per-user switch (eventsAccess), so an event
// coordinator can be a Supervisor or Employee and still run the BEO board.

export const ROLES = [
  {
    id: 'super_admin', label: 'Super Admin', rank: 5,
    summary: 'Full control, including other admins. The account owner.',
    can: ['Everything an Admin can do', 'Add, edit and remove Admins and other Super Admins'],
    es: { summary: 'Control total, incluidos otros administradores. Es el dueño de la cuenta.',
      can: ['Todo lo que puede hacer un administrador', 'Agregar, editar y quitar administradores y otros superadministradores'] },
  },
  {
    id: 'admin', label: 'Admin', rank: 4,
    summary: 'Runs the account: settings, managers and everything below.',
    can: ['Everything a Manager can do', 'Change restaurant settings and approval rules', 'Add and edit Admins, Managers, Supervisors and Employees'],
    es: { summary: 'Maneja la cuenta: la configuración, los gerentes y todo lo de abajo.',
      can: ['Todo lo que puede hacer un gerente', 'Cambiar la configuración del restaurante y las reglas de aprobación', 'Agregar y editar administradores, gerentes, supervisores y empleados'] },
  },
  {
    id: 'manager', label: 'Manager', rank: 3,
    summary: 'Builds and publishes the schedule and approves requests.',
    can: ['Everything a Supervisor can do', 'Build, edit and publish schedules, see drafts', 'Forecasting, labor and pay rates', 'Create and edit events and BEOs', 'Add and edit Supervisors and Employees, manage job codes'],
    es: { summary: 'Arma y publica el horario y aprueba las solicitudes.',
      can: ['Todo lo que puede hacer un supervisor', 'Armar, editar y publicar horarios, y ver los borradores', 'Pronósticos, mano de obra y tarifas de pago', 'Crear y editar eventos y BEO', 'Agregar y editar supervisores y empleados, y manejar los puestos'] },
  },
  {
    id: 'supervisor', label: 'Supervisor', rank: 2,
    summary: 'Shift lead. Approves requests on the floor; can’t edit the schedule.',
    can: ['Everything an Employee can do', 'Approve or deny trades, giveaways, pickups and time off (if allowed in Settings)', 'See coworkers’ phone and email to find coverage'],
    es: { summary: 'Encargado de turno. Aprueba solicitudes en el piso; no puede editar el horario.',
      can: ['Todo lo que puede hacer un empleado', 'Aprobar o rechazar intercambios, cesiones, turnos recogidos y días libres (si se permite en Configuración)', 'Ver el teléfono y el correo de sus compañeros para conseguir quién cubra'] },
  },
  {
    id: 'employee', label: 'Employee', rank: 1,
    summary: 'Sees the schedule, trades and picks up shifts, requests time off.',
    can: ['See their shifts and the published schedule', 'Trade, give away and pick up shifts (for their job codes)', 'Request time off, read BEOs and comment on events'],
    es: { summary: 'Ve el horario, intercambia y recoge turnos, y pide días libres.',
      can: ['Ver sus turnos y el horario publicado', 'Intercambiar, ceder y recoger turnos (de sus puestos)', 'Pedir días libres, leer los BEO y comentar en los eventos'] },
  },
];

export const ROLE_IDS = ROLES.map((r) => r.id);
/** A role's name, summary and list of what it can do, in a language. canApprove: the index of the line about approving (Settings can turn it off for supervisors). */
export const roleInfo = (r, lang = 'en') => ({ ...r, label: roleLabel(r.id, lang), ...(lang === 'es' && r.es ? r.es : {}) });
const BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));

/** The user's role id. Older data used 'events' (now an Employee with eventsAccess). */
export function roleOf(user) {
  const r = user?.role;
  return BY_ID[r] ? r : 'employee';
}
// Role names in Spanish (the same words the phone app uses), singular and plural.
const ROLE_ES = { super_admin: ['Superadministrador', 'Superadministradores'], admin: ['Administrador', 'Administradores'],
  manager: ['Gerente', 'Gerentes'], supervisor: ['Supervisor', 'Supervisores'], employee: ['Empleado', 'Empleados'] };
const roleId = (userOrId) => (typeof userOrId === 'string' ? (BY_ID[userOrId] ? userOrId : 'employee') : roleOf(userOrId));
/** 'Manager' · 'Gerente'. */
export const roleLabel = (userOrId, lang = 'en') => (lang === 'es' ? ROLE_ES[roleId(userOrId)][0] : BY_ID[roleId(userOrId)]?.label || 'Employee');
/** 'Managers' · 'Gerentes'. */
export const roleLabelPlural = (userOrId, lang = 'en') => (lang === 'es' ? ROLE_ES[roleId(userOrId)][1] : `${roleLabel(userOrId)}s`);
export const rankOf = (user) => (user ? BY_ID[roleOf(user)].rank : 0);
/** At least the given role (e.g. atLeast(u, 'manager') is true for managers, admins and super admins). */
export const atLeast = (user, role) => !!user && rankOf(user) >= BY_ID[role].rank;

// ----- permissions -----
export const canManageSchedule = (u) => atLeast(u, 'manager');
export const canChangeSettings = (u) => atLeast(u, 'admin');
export const canManageEvents = (u) => atLeast(u, 'manager') || !!u?.eventsAccess || u?.role === 'events';
export const canSeeContacts = (u) => atLeast(u, 'supervisor');
export const canApprove = (u, settings = {}) => atLeast(u, 'manager') || (roleOf(u) === 'supervisor' && settings.supervisorsCanApprove !== false);
/** Not on the schedule grid: office-only users (and the old 'events' role). */
export const offSchedule = (u) => u?.onSchedule === false || (u?.role === 'events' && u?.onSchedule !== true);

/** Roles the actor may give to other people. */
export function assignableRoles(actor, { superAdminExists = true } = {}) {
  const r = roleOf(actor);
  if (r === 'super_admin') return [...ROLE_IDS];
  // Until a Super Admin exists (older accounts), admins can create the first one.
  if (r === 'admin') return ROLE_IDS.filter((id) => id !== 'super_admin' || !superAdminExists);
  if (r === 'manager') return ['supervisor', 'employee'];
  return [];
}

/** Whether the actor may edit another user's profile, role, status and password. */
export function canManageUser(actor, target) {
  if (!actor || !target) return false;
  const a = roleOf(actor);
  const t = roleOf(target);
  if (a === 'super_admin') return true;
  if (a === 'admin') return t !== 'super_admin';
  if (a === 'manager') return t === 'supervisor' || t === 'employee';
  return false;
}
