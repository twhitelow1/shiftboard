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

// ----- custom roles ("types of managers": Bar Manager, Kitchen Manager, Shift Lead…) -----
// A custom role is a name (and a Spanish name) on a base level: manager, supervisor or employee. A person with one keeps
// role = the base level, so every rank check (atLeast, canManageSchedule…) works as before, plus customRole = its id.
// Stored in settings.customRoles; the labels below use the list the service (or the web app) last set with
// useCustomRoles. None exist until an admin makes one (core/custom-roles.js).
export const CUSTOM_BASES = ['manager', 'supervisor', 'employee'];
let CUSTOM = new Map();
const validCustom = (r) => r && typeof r.id === 'string' && /^cr_[a-z0-9_]{2,40}$/i.test(r.id) && typeof r.name === 'string' && r.name.trim() && CUSTOM_BASES.includes(r.base);
/** The custom roles in settings, checked. */
export const customRolesOf = (settings = {}) => (Array.isArray(settings?.customRoles) ? settings.customRoles.filter(validCustom) : []);
/** Set the custom roles labels come from (the service on each call; the web app from bootstrap). */
export function useCustomRoles(list) { CUSTOM = new Map((Array.isArray(list) ? list : []).filter(validCustom).map((r) => [r.id, r])); }
export const knownCustomRoles = () => [...CUSTOM.values()];
/** A person's custom role (from settings when given, else the list set last), or null. */
export function customRoleOf(user, settings) {
  const id = user?.customRole;
  if (!id) return null;
  const r = settings ? customRolesOf(settings).find((x) => x.id === id) : CUSTOM.get(id);
  return r && r.base === roleOf(user) ? r : null;
}
/** The id of the role a person's features and approval default follow: their custom role, else their role. */
export const featureRoleOf = (user, settings) => customRoleOf(user, settings)?.id || roleOf(user);
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
const customOf = (userOrId) => (typeof userOrId === 'string' ? CUSTOM.get(userOrId) || null : customRoleOf(userOrId));
const customName = (c, lang) => (lang === 'es' && String(c.nameEs || '').trim() ? c.nameEs.trim() : c.name.trim());
/** 'Manager' · 'Gerente' (a custom role's own name: 'Bar Manager' · 'Gerente de bar'). */
export const roleLabel = (userOrId, lang = 'en') => {
  const c = customOf(userOrId);
  if (c) return customName(c, lang);
  return lang === 'es' ? ROLE_ES[roleId(userOrId)][0] : BY_ID[roleId(userOrId)]?.label || 'Employee';
};
/** 'Managers' · 'Gerentes' (a custom role's name as it is). */
export const roleLabelPlural = (userOrId, lang = 'en') => {
  const c = customOf(userOrId);
  if (c) return customName(c, lang);
  return lang === 'es' ? ROLE_ES[roleId(userOrId)][1] : `${roleLabel(userOrId)}s`;
};
export const rankOf = (user) => (user ? BY_ID[roleOf(user)].rank : 0);
/** At least the given role (e.g. atLeast(u, 'manager') is true for managers, admins and super admins). */
export const atLeast = (user, role) => !!user && rankOf(user) >= BY_ID[role].rank;

// ----- permissions -----
export const canManageSchedule = (u) => atLeast(u, 'manager');
export const canChangeSettings = (u) => atLeast(u, 'admin');
export const canManageEvents = (u) => atLeast(u, 'manager') || !!u?.eventsAccess || u?.role === 'events';
export const canSeeContacts = (u) => atLeast(u, 'supervisor');
export const canApprove = (u, settings = {}) => {
  if (atLeast(u, 'manager')) return true;
  if (roleOf(u) !== 'supervisor') return false;
  // A custom role on the supervisor level has its own "Can approve requests" switch (Roles & features).
  const c = customRoleOf(u, settings);
  if (c) return settings.roleFeatures?.[c.id]?.approve !== false; // copied from Supervisors when the role was made
  return settings.supervisorsCanApprove !== false;
};
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
