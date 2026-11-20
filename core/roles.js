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
  },
  {
    id: 'admin', label: 'Admin', rank: 4,
    summary: 'Runs the account: settings, managers and everything below.',
    can: ['Everything a Manager can do', 'Change restaurant settings and approval rules', 'Add and edit Admins, Managers, Supervisors and Employees'],
  },
  {
    id: 'manager', label: 'Manager', rank: 3,
    summary: 'Builds and publishes the schedule and approves requests.',
    can: ['Everything a Supervisor can do', 'Build, edit and publish schedules, see drafts', 'Forecasting, labor and pay rates', 'Create and edit events and BEOs', 'Add and edit Supervisors and Employees, manage job codes'],
  },
  {
    id: 'supervisor', label: 'Supervisor', rank: 2,
    summary: 'Shift lead. Approves requests on the floor; can’t edit the schedule.',
    can: ['Everything an Employee can do', 'Approve or deny trades, giveaways, pickups and time off (if allowed in Settings)', 'See coworkers’ phone and email to find coverage'],
  },
  {
    id: 'employee', label: 'Employee', rank: 1,
    summary: 'Sees the schedule, trades and picks up shifts, requests time off.',
    can: ['See their shifts and the published schedule', 'Trade, give away and pick up shifts (for their job codes)', 'Request time off, read BEOs and comment on events'],
  },
];

export const ROLE_IDS = ROLES.map((r) => r.id);
const BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));

/** The user's role id. Older data used 'events' (now an Employee with eventsAccess). */
export function roleOf(user) {
  const r = user?.role;
  return BY_ID[r] ? r : 'employee';
}
export const roleLabel = (userOrId) => BY_ID[typeof userOrId === 'string' ? userOrId : roleOf(userOrId)]?.label || 'Employee';
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
