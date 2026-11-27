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
import { ROLE_IDS, roleOf, customRolesOf, featureRoleOf } from './roles.js';

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
  // Feedback box (core/feedback.js): everyone submits; reading is managers and up. Supervisors read only when an admin
  // turns that on in Settings → Feedback box, so their cell isn't here; Concern / report goes to Admins by default.
  { key: 'feedback', group: 'feature', plan: 'feedback', cells: ALL(true) },
  { key: 'feedbackInbox', group: 'feature', plan: 'feedback', cells: MGR(true) },
  // Stock lists (core/stock.js): everyone looks products up, sends quick lists to the people on duty, works the lists
  // sent to them and adds products; supervisors and up schedule lists and make templates (with manager and up: the
  // product catalog). stockManage is checked inside core/stock.js, not per RPC, so turning it off never refuses a method.
  { key: 'stock', group: 'feature', plan: 'stock', cells: ALL(true) },
  { key: 'stockManage', group: 'feature', plan: 'stock', cells: { employee: false, supervisor: true, manager: true, admin: 'on' } },
  // Regular programming (core/programming.js): everyone sees it on the calendar; pars and coverage, and editing it, are
  // managers and up by default. Both are checked inside core/programming.js, not per RPC, so turning them off never refuses a method.
  { key: 'staffingPars', group: 'feature', plan: null, cells: { employee: false, supervisor: false, manager: true, admin: 'on' } },
  { key: 'programmingEdit', group: 'feature', plan: null, cells: { employee: false, supervisor: false, manager: true, admin: 'on' } },
  { key: 'coworkerContacts', group: 'feature', plan: null, cells: { employee: false, supervisor: true, manager: 'on', admin: 'on' } },
  { key: 'tradeRequests', group: 'capability', plan: null, cells: ALL(true) },
  { key: 'approve', group: 'capability', plan: null, cells: { employee: null, supervisor: true, manager: 'on', admin: 'on' }, setting: 'supervisorsCanApprove' },
  // Editing other people's weekly availability (core/availability-api.js): managers and up as before; supervisors (for
  // employees) when turned on. Everyone always edits their own, so it's checked inside, never per RPC.
  { key: 'editAvailability', group: 'capability', plan: null, cells: { employee: null, supervisor: false, manager: true, admin: 'on' } },
];
export const ROLE_FEATURE_KEYS = ROLE_FEATURES.map((f) => f.key);
const DEF = Object.fromEntries(ROLE_FEATURES.map((f) => [f.key, f]));

// RPC namespaces and methods (core/service.js and the modules it pulls in) that belong to a role feature.
// A method can need several (asking for a trade needs Trades & pickups and the "can trade" capability).
const NAMESPACE_FEATURE = {
  swaps: 'trades', timeOff: 'timeOff', events: 'events',
  training: 'training', menu: 'training', quiz: 'training', leaderboard: 'training', manual: 'training', // mod.* (managers on duty) is for everyone
  tipPools: 'tips', tipEntries: 'tips', tips: 'tips', myTips: 'tips',
  eightySix: 'eightySix',
  forecast: 'forecast', sales: 'forecast', labor: 'forecast', clock: 'forecast', calibration: 'forecast',
  venue: 'venue', sections: 'venue',
  jobCodes: 'team',
  announcements: 'announcements',
  reports: 'reports', tradeStats: 'reports',
  feedback: 'feedback',
  stock: 'stock', products: 'stock', // the catalog is Stock lists' (the 86 List's report form reads it too)
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
  'availability.importMapping': ['team'], // the availability import (core/import-api.js)
  'availability.importPreview': ['team'],
  'availability.importApply': ['team'],
  // Feedback box: the readers' methods need the inbox (not submitting); its settings are admins' whatever their role has.
  ...Object.fromEntries(['feedback.inbox.list', 'feedback.inbox.get', 'feedback.setStatus', 'feedback.reply', 'feedback.note', 'feedback.share',
    'feedback.unshare', 'feedback.askName'].map((m) => [m, ['feedbackInbox']])),
  'feedback.settings.get': [],
  'feedback.settings.save': [],
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
  ['/api/stock', 'stock'], // product photos
  ['/api/venue', 'venue'], // floor plan imports (managers)
  ['/api/users', 'team'], // send a sign-in link, invite everyone, reset someone's two-step sign-in
];

// Custom roles (core/custom-roles.js) get their own column: the cells of their base level (manager, supervisor or
// employee), starting as a copy of that column's values when the role is made, then their own switches. "Can approve
// requests" is a plain stored switch for them (not settings.supervisorsCanApprove), always kept, so core/roles.js
// canApprove reads it. With no custom roles everything below works exactly as before.
const BASE = new Map(); // custom id → base level
const baseOf = (role) => BASE.get(role) || role;
const learn = (settings) => { const list = customRolesOf(settings); for (const r of list) BASE.set(r.id, r.base); return list.map((r) => r.id); };
const isCustom = (role) => BASE.has(role) && !ROLE_IDS.includes(role);
/** The roles the editor shows, lowest first, each custom role right after its base level. */
export function matrixRoles(settings = {}) {
  const customs = customRolesOf(settings);
  learn(settings);
  return MATRIX_ROLES.flatMap((r) => [r, ...customs.filter((c) => c.base === r).map((c) => c.id)]);
}

/** A cell's fixed value ('on' → true) or its default; null when the feature isn't for that role. */
const defaultCell = (def, role) => {
  if (role === 'super_admin') return true;
  const c = def.cells[baseOf(role)];
  return c === 'on' ? true : c;
};
const editableCell = (def, role) => EDITABLE.includes(baseOf(role)) && typeof def.cells[baseOf(role)] === 'boolean';

/** The stored overrides, cleaned: only switch cells with true/false, only those that differ from the default. */
export function cleanRoleFeatures(raw, settings = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const customs = learn(settings);
  for (const role of [...EDITABLE, ...customs]) {
    const row = raw[role];
    if (!row || typeof row !== 'object') continue;
    const custom = isCustom(role);
    for (const def of ROLE_FEATURES) {
      if ((def.setting && !custom) || !editableCell(def, role) || typeof row[def.key] !== 'boolean') continue;
      if (row[def.key] !== def.cells[baseOf(role)] || (def.setting && custom)) (out[role] ??= {})[def.key] = row[def.key];
    }
  }
  return out;
}

/** The defaults: { employee: { schedule: true, …, forecast: null }, …, super_admin: { all true } }. */
export function defaultMatrix(settings = {}) {
  return Object.fromEntries(matrixRoles(settings).map((role) => [role, Object.fromEntries(ROLE_FEATURES.map((d) => [d.key, defaultCell(d, role)]))]));
}

/** Each role's features from the settings (role layer only, no plan): true, false, or null (not for that role). */
export function roleMatrix(settings = {}) {
  const stored = cleanRoleFeatures(settings?.roleFeatures, settings);
  const out = defaultMatrix(settings);
  for (const role of [...EDITABLE, ...customRolesOf(settings).map((c) => c.id)]) {
    for (const def of ROLE_FEATURES) {
      if (!editableCell(def, role)) continue;
      if (def.setting && !isCustom(role)) out[role][def.key] = settings?.[def.setting] !== false;
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
  const matrix = roleMatrix(settings);
  const row = matrix[featureRoleOf(user, settings)] || matrix[roleOf(user)]; // a custom role's own column
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
export function editableRoles(actor, settings = {}) {
  const r = roleOf(actor);
  const customs = customRolesOf(settings).map((c) => c.id); // all on manager level or below
  if (r === 'super_admin') return [...EDITABLE, ...customs];
  if (r === 'admin') return [...EDITABLE.filter((x) => x !== 'admin'), ...customs];
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
  const mine = editableRoles(actor, settings);
  const merged = roleMatrix(settings);
  for (const [role, row] of Object.entries(next)) {
    if (!ROLE_IDS.includes(role) && !current[role]) fail(400, 'Unknown role');
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
  const roleFeatures = cleanRoleFeatures(merged, settings);
  const approve = DEF.approve;
  return { roleFeatures, [approve.setting]: merged.supervisor.approve !== false };
}

/** A preview's draft (View as from the editor): cleaned the same way, never stored. */
export function cleanDraft(raw, settings = {}) {
  if (!raw || typeof raw !== 'object') return null;
  return { roleFeatures: cleanRoleFeatures(raw.roleFeatures, settings), supervisorsCanApprove: raw.supervisorsCanApprove !== false };
}

/** The editor's RPCs: roleFeatures.get and roleFeatures.save (Admins and Super Admins). */
export function roleFeatureApi({ settings, putSettings, fail, needAdmin, plan = null }) {
  const view = (actor) => {
    const st = settings();
    const roles = matrixRoles(st);
    return {
      roles,
      customRoles: customRolesOf(st), // names for the custom roles' columns
      features: ROLE_FEATURES.map(({ key, group, plan: p, cells }) => ({ key, group, plan: p, inPlan: inPlan(plan, p),
        cells: Object.fromEntries(roles.map((r) => { const b = baseOf(r); return [r, r === 'super_admin' ? 'on' : cells[b] === 'on' ? 'on' : cells[b] === null ? null : 'switch']; })) })),
      values: roleMatrix(st),
      defaults: defaultMatrix(st),
      editable: editableRoles(actor, st),
    };
  };
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
