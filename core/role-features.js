// Roles & features (Settings → Roles & features): which parts of the app each role gets.
//
// The restaurant's plan decides what's possible (server/platform/plans.js); this decides who gets it.
// A person's effective features are plan ∩ their role's features (∩ nothing per person, except the
// Events & BEOs access switch, which still gives one person events when their role doesn't have them).
// Super Admins always have everything.
//
// Each feature has one cell per role:
//   true / false  a switch, with its default (the defaults are exactly how the app worked before this
//                 existed: test/role-features.test.js proves it against a fingerprint of the old code)
//   'on'          always on for that role (e.g. managers always see the schedule they build)
//   null          not something that role does (managers' tools for employees): the role's own permission
//                 checks apply, and the feature isn't restricted for them
//
// What's stored: settings.roleFeatures, only the cells that differ from the default ({ employee: { tips:
// false } }), so a feature added later follows its default until someone changes it. "Supervisors can approve
// requests" is the older settings.supervisorsCanApprove (the phone app and core/roles.js read it), shown here.
//
// The server applies it like the plan: every RPC of a feature a role doesn't have answers 403 "Your role
// doesn't include this" (featuresForMethod, in createService's call), and so do its routes (ROLE_ROUTES).
// app.bootstrap returns the effective features as `features`, so the web app and the phone app hide what's off.
import { ROLE_IDS, roleOf } from './roles.js';

export const ROLE_OFF = 'Your role doesn’t include this';
/** The roles the editor shows, lowest first. Super Admin is always everything. */
export const MATRIX_ROLES = ['employee', 'supervisor', 'manager', 'admin', 'super_admin'];
const EDITABLE = ['employee', 'supervisor', 'manager', 'admin'];

const ALL = (v) => ({ employee: v, supervisor: v, manager: v, admin: v });
const MGR = (v) => ({ employee: null, supervisor: null, manager: v, admin: v });

/**
 * key: the feature's name (the same names the plan and the phone app use where they overlap).
 * plan: the plan feature it needs (null: every plan has it). An unknown plan key counts as in the plan, so a
 *   feature another part of the app adds to plans.js later starts working here by itself.
 * staff: for roles where this feature is null, what the apps see for it follows this feature instead
 *   (employees see Forecast's projected covers only: the phone app shows them when `forecast` is on).
 * setting: stored in this settings field instead of roleFeatures.
 */
export const ROLE_FEATURES = [
  { key: 'schedule', group: 'feature', plan: null, cells: { employee: true, supervisor: true, manager: 'on', admin: 'on' } },
  { key: 'myShifts', group: 'feature', plan: null, cells: ALL(true) },
  { key: 'calendar', group: 'feature', plan: null, cells: ALL(true) },
  { key: 'trades', group: 'feature', plan: null, cells: ALL(true) },
  { key: 'timeOff', group: 'feature', plan: null, cells: ALL(true) },
  { key: 'events', group: 'feature', plan: 'events', cells: ALL(true) },
  { key: 'training', group: 'feature', plan: 'training', cells: ALL(true) },
  { key: 'tips', group: 'feature', plan: 'tips', cells: ALL(true) },
  { key: 'eightySix', group: 'feature', plan: 'eightySix', cells: ALL(true) },
  { key: 'forecast', group: 'feature', plan: 'forecast', cells: MGR(true), staff: 'coversForStaff' },
  { key: 'venue', group: 'feature', plan: 'venue', cells: ALL(true) },
  { key: 'team', group: 'feature', plan: null, cells: MGR(true) },
  // Everyone reads what's sent to them; sending stays managers and up (core/announcements.js canAnnounce).
  { key: 'announcements', group: 'feature', plan: 'announcements', cells: ALL(true) },
  { key: 'reports', group: 'feature', plan: 'reports', cells: MGR(true) }, // managers and up only (core/reports.js)
  { key: 'coversForStaff', group: 'feature', plan: 'forecast', cells: ALL(true) },
  // Ask ShiftBoard (server/assistant/): everyone by default; it acts with the person's own permissions anyway.
  { key: 'assistant', group: 'feature', plan: 'assistant', cells: ALL(true) },
  { key: 'coworkerContacts', group: 'feature', plan: null, cells: { employee: false, supervisor: true, manager: 'on', admin: 'on' } },
  { key: 'tradeRequests', group: 'capability', plan: null, cells: ALL(true) },
  { key: 'approve', group: 'capability', plan: null, cells: { employee: null, supervisor: true, manager: 'on', admin: 'on' }, setting: 'supervisorsCanApprove' },
];
export const ROLE_FEATURE_KEYS = ROLE_FEATURES.map((f) => f.key);
const DEF = Object.fromEntries(ROLE_FEATURES.map((f) => [f.key, f]));

// RPC namespaces and methods (core/service.js and the modules it pulls in) that belong to a role feature.
// A method can need several (asking for a trade needs Trades & pickups and the "can trade" capability).
const NAMESPACE_FEATURE = {
  swaps: 'trades', timeOff: 'timeOff', events: 'events',
  training: 'training', menu: 'training', quiz: 'training', leaderboard: 'training', manual: 'training', mod: 'training',
  tipPools: 'tips', tipEntries: 'tips', tips: 'tips', myTips: 'tips',
  eightySix: 'eightySix',
  forecast: 'forecast', sales: 'forecast', labor: 'forecast', clock: 'forecast', calibration: 'forecast',
  venue: 'venue', sections: 'venue',
  jobCodes: 'team',
  announcements: 'announcements',
  reports: 'reports', tradeStats: 'reports',
};
const METHOD_FEATURES = {
  'swaps.create': ['trades', 'tradeRequests'],
  'swaps.accept': ['trades', 'tradeRequests'],
  'forecast.covers': ['coversForStaff'],
  'settings.laborRules': ['forecast'],
  'employees.save': ['team'],
  'employees.merge': ['team'],
  'employees.resetPassword': ['team'],
  'employees.importMapping': ['team'], // smart import (core/import-api.js)
  'employees.importPreview': ['team'],
  'employees.importApply': ['team'],
};

/** The role features an RPC method needs ([] when every role that may call it has it). */
export function featuresForMethod(method) {
  const m = String(method || '');
  if (METHOD_FEATURES[m]) return METHOD_FEATURES[m];
  const ns = NAMESPACE_FEATURE[m.split('.')[0]];
  return ns ? [ns] : [];
}

/** HTTP routes (server/app.js) that belong to a role feature, like the plan's ROUTE_FEATURES. */
export const ROLE_ROUTES = [
  ['/api/training', 'training'],
  ['/api/eighty-six', 'eightySix'],
  ['/api/users', 'team'], // send a sign-in link, invite everyone, reset someone's two-step sign-in
];

/** A cell's fixed value ('on' → true) or its default; null when the feature isn't for that role. */
const defaultCell = (def, role) => {
  if (role === 'super_admin') return true;
  const c = def.cells[role];
  return c === 'on' ? true : c;
};
const editableCell = (def, role) => EDITABLE.includes(role) && typeof def.cells[role] === 'boolean';

/** The stored overrides, cleaned: only switch cells with true/false, only those that differ from the default. */
export function cleanRoleFeatures(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const role of EDITABLE) {
    const row = raw[role];
    if (!row || typeof row !== 'object') continue;
    for (const def of ROLE_FEATURES) {
      if (def.setting || !editableCell(def, role) || typeof row[def.key] !== 'boolean') continue;
      if (row[def.key] !== def.cells[role]) (out[role] ??= {})[def.key] = row[def.key];
    }
  }
  return out;
}

/** The defaults: { employee: { schedule: true, …, forecast: null }, …, super_admin: { all true } }. */
export function defaultMatrix() {
  return Object.fromEntries(MATRIX_ROLES.map((role) => [role, Object.fromEntries(ROLE_FEATURES.map((d) => [d.key, defaultCell(d, role)]))]));
}

/** Each role's features from the settings (role layer only, no plan): true, false, or null (not for that role). */
export function roleMatrix(settings = {}) {
  const stored = cleanRoleFeatures(settings?.roleFeatures);
  const out = defaultMatrix();
  for (const role of EDITABLE) {
    for (const def of ROLE_FEATURES) {
      if (!editableCell(def, role)) continue;
      if (def.setting) out[role][def.key] = settings?.[def.setting] !== false;
      else if (typeof stored[role]?.[def.key] === 'boolean') out[role][def.key] = stored[role][def.key];
    }
  }
  return out;
}

/**
 * What one person's role lets them use: { schedule: true, tips: false, … }. Features that aren't for their role
 * are true (their own permission checks apply), except those that follow another feature for staff (forecast).
 * Events & BEOs access on the person gives them events whatever their role says.
 */
export function roleAllows(user, settings = {}) {
  const role = roleOf(user);
  const row = roleMatrix(settings)[role];
  const out = {};
  for (const def of ROLE_FEATURES) out[def.key] = row[def.key] === null ? true : row[def.key];
  for (const def of ROLE_FEATURES) if (row[def.key] === null && def.staff) out[def.key] = out[def.staff];
  if (user?.eventsAccess || user?.role === 'events') out.events = true;
  return out;
}

/** Is a plan feature in the restaurant's plan? plan: { training: true, … } or null (no plan: everything). */
const inPlan = (plan, key) => !key || !plan || plan[key] !== false;

/**
 * The features the apps see for one person: the plan's (every key it has, as it is) with each role feature as
 * plan ∩ role. plan null (a restaurant on its own deployment, the demo): the role layer alone.
 */
export function effectiveFeatures(user, { settings = {}, plan = null } = {}) {
  const role = roleAllows(user, settings);
  const out = {};
  if (plan) for (const [k, v] of Object.entries(plan)) out[k] = v !== false;
  for (const def of ROLE_FEATURES) out[def.key] = !!role[def.key] && inPlan(plan, def.plan);
  return out;
}

/** The first role feature this person's role is missing for a method, or null. */
export function roleRefusal(user, method, settings = {}) {
  const need = featuresForMethod(method);
  if (!need.length || !user) return null;
  const allows = roleAllows(user, settings);
  return need.find((k) => allows[k] === false) || null;
}

/** Roles an actor may change in the editor: Super Admins every role below them; Admins the roles below Admin. */
export function editableRoles(actor) {
  const r = roleOf(actor);
  if (r === 'super_admin') return [...EDITABLE];
  if (r === 'admin') return EDITABLE.filter((x) => x !== 'admin');
  return [];
}

/**
 * Check a new set of role features from the editor against the current one and return what to store.
 * next: { employee: { tips: false, … }, … } (any subset). Throws (fail) on anything that isn't allowed.
 * Returns { roleFeatures, supervisorsCanApprove }.
 */
export function validateRoleFeatures(next, { actor, settings = {}, plan = null, fail }) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) fail(400, 'Send the roles and their features');
  const current = roleMatrix(settings);
  const mine = editableRoles(actor);
  const merged = roleMatrix(settings);
  for (const [role, row] of Object.entries(next)) {
    if (!ROLE_IDS.includes(role)) fail(400, 'Unknown role');
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(400, 'Send the roles and their features');
    for (const [key, value] of Object.entries(row)) {
      const def = DEF[key];
      if (!def) fail(400, 'Unknown feature');
      if (typeof value !== 'boolean') fail(400, 'Each feature is either on or off');
      if (value === current[role][key]) continue; // unchanged (including fixed cells sent as they are)
      if (role === 'super_admin') fail(400, 'A Super Admin always has everything');
      if (!editableCell(def, role)) fail(400, 'That can’t be changed for this role');
      if (!mine.includes(role)) fail(403, 'Only a Super Admin can change what Admins can do');
      if (!inPlan(plan, def.plan)) fail(400, 'Not included in your plan');
      merged[role][key] = value;
    }
  }
  const roleFeatures = cleanRoleFeatures(merged);
  const approve = DEF.approve;
  return { roleFeatures, [approve.setting]: merged.supervisor.approve !== false };
}

/** A preview's draft (View as from the editor): cleaned the same way, never stored. */
export function cleanDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { roleFeatures: cleanRoleFeatures(raw.roleFeatures), supervisorsCanApprove: raw.supervisorsCanApprove !== false };
}

/** The editor's RPCs: roleFeatures.get and roleFeatures.save (Admins and Super Admins). */
export function roleFeatureApi({ settings, putSettings, fail, needAdmin, plan = null }) {
  const view = (actor) => ({
    roles: MATRIX_ROLES,
    features: ROLE_FEATURES.map(({ key, group, plan: p, cells }) => ({ key, group, plan: p, inPlan: inPlan(plan, p),
      cells: Object.fromEntries(MATRIX_ROLES.map((r) => [r, r === 'super_admin' ? 'on' : cells[r] === 'on' ? 'on' : cells[r] === null ? null : 'switch'])) })),
    values: roleMatrix(settings()),
    defaults: defaultMatrix(),
    editable: editableRoles(actor),
  });
  return {
    'roleFeatures.get': (actor) => {
      needAdmin(actor);
      return view(actor);
    },
    'roleFeatures.save': (actor, { roleFeatures } = {}) => {
      needAdmin(actor);
      putSettings(validateRoleFeatures(roleFeatures, { actor, settings: settings(), plan, fail }));
      return view(actor);
    },
  };
}
