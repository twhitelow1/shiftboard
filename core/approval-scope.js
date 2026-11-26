// "Approves for": which trades, giveaways, pickups (and time off) an approver decides, by position and room.
//
// A scope: { mode, positions: [jobCodeId], rooms: [room name], timeOff: boolean }
//   all       every position (how every approver worked before this existed: the default)
//   include   only shifts whose position is in `positions` or whose room is in `rooms` ("Bar positions")
//   exclude   every shift except those
//   none      nothing (an approver who only approves when nobody else can: see the fallback)
//   timeOff   true (default): time off follows the same scope, by the requester's positions; false: any approver
// Positions are job codes; rooms are the rooms of Settings → Rooms & positions (core/layout.js). A shift's room is its
// area, else its position's department (roomOfShift); a person's rooms for a position are the entry's areas, else the
// position's department (entryRooms).
//
// Where it comes from: the person's own (users.approvalScope, Team → person → "Approves for"), else their role's
// default (settings.approvalScopes.manager / .supervisor, Settings → Roles & features), else all. Admins and Super
// Admins always approve everything. Nothing stored = today's behaviour for everyone.
//
// The rules (core/service.js enforces them in swaps.approve, swaps.deny and timeOff.decide):
//   - A one-shift request (giveaway, pickup) is in scope when its shift is.
//   - A two-way trade is in scope when EITHER shift is. Both people are already trained for both positions (swaps.create
//     checks), so either side's approver can judge it, and a trade between two departments never waits on two people.
//     The approvers of both sides are notified, so the other side sees it too.
//   - Time off is in scope when ANY of the requester's positions is (a bartender who also serves is the bar manager's
//     and the floor manager's). Someone with no positions: in scope for "all except", not for "only these".
//   - Fallback: when no manager or supervisor (other than the people in the request) has it in scope, every manager can
//     decide it and is notified, so nothing gets stuck. Admins always can.
import { sameArea, cleanArea, uniqueAreas } from './areas.js';
import { roomOfShift, entryRooms } from './layout.js';
import { canChangeSettings, featureRoleOf, customRolesOf } from './roles.js';

export const SCOPE_MODES = ['all', 'include', 'exclude', 'none'];
export const SCOPE_ROLES = ['manager', 'supervisor']; // roles with a default in Settings (admins always approve everything)
export const ALL_SCOPE = Object.freeze({ mode: 'all', positions: [], rooms: [], timeOff: true });

/** A scope as a client sent it, checked against the positions and rooms that exist. Throws (fail) on anything else. */
export function cleanScope(raw, { jobExists = () => true, roomExists = () => true, fail }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Pick what they approve');
  const mode = SCOPE_MODES.includes(raw.mode) ? raw.mode : fail(400, 'Pick what they approve');
  const positions = [...new Set((Array.isArray(raw.positions) ? raw.positions : []).filter((id) => typeof id === 'string'))].slice(0, 200);
  const rooms = uniqueAreas((Array.isArray(raw.rooms) ? raw.rooms : []).map(cleanArea).filter(Boolean)).slice(0, 100);
  if (positions.some((id) => !jobExists(id))) fail(400, 'Pick positions from Rooms & positions');
  if (rooms.some((r) => !roomExists(r))) fail(400, 'Pick rooms from Rooms & positions');
  if ((mode === 'include' || mode === 'exclude') && !positions.length && !rooms.length) fail(400, 'Pick at least one position or room');
  return { mode, positions: mode === 'all' || mode === 'none' ? [] : positions, rooms: mode === 'all' || mode === 'none' ? [] : rooms, timeOff: raw.timeOff !== false };
}

/** The role defaults stored in settings: { manager?, supervisor? } (absent = all). */
export const roleScopes = (settings = {}) => (settings.approvalScopes && typeof settings.approvalScopes === 'object' ? settings.approvalScopes : {});

/** Where a person's scope comes from: 'admin' (always everything), 'person', 'role' or 'default' (all). */
export function scopeSource(user, settings = {}) {
  if (canChangeSettings(user)) return 'admin';
  if (user?.approvalScope?.mode) return 'person';
  return roleScopes(settings)[featureRoleOf(user, settings)]?.mode ? 'role' : 'default'; // a custom role's own default
}
/** The scope a person approves with. */
export function scopeOf(user, settings = {}) {
  const src = scopeSource(user, settings);
  if (src === 'person') return { ...ALL_SCOPE, ...user.approvalScope };
  if (src === 'role') return { ...ALL_SCOPE, ...roleScopes(settings)[featureRoleOf(user, settings)] };
  return ALL_SCOPE;
}
export const isAll = (scope) => !scope || scope.mode === 'all';

const listed = (scope, jobCodeId, rooms) => (scope.positions || []).includes(jobCodeId) || rooms.some((r) => (scope.rooms || []).some((x) => sameArea(x, r)));

/** Is this shift in scope? job: the shift's position (for its department when the shift has no room). */
export function coversShift(scope, shift, job) {
  if (isAll(scope)) return true;
  if (!shift || scope.mode === 'none') return false;
  const room = roomOfShift(shift, job);
  const hit = listed(scope, shift.jobCodeId, room ? [room] : []);
  return scope.mode === 'include' ? hit : !hit;
}

/** Is a trade, giveaway or pickup in scope? shifts: its shift and, for a two-way trade, the other one ("either"). */
export const coversRequest = (scope, shifts, jobOf) => isAll(scope) || shifts.filter(Boolean).some((s) => coversShift(scope, s, jobOf(s.jobCodeId)));

/** Is a person's time off in scope? Any of their positions (in the rooms they work it). */
export function coversPerson(scope, person, jobOf) {
  if (isAll(scope) || scope.timeOff === false) return true;
  if (scope.mode === 'none') return false;
  const entries = (person?.jobCodes || []).filter((e) => jobOf(e.jobCodeId));
  if (!entries.length) return scope.mode === 'exclude';
  return entries.some((e) => {
    const hit = listed(scope, e.jobCodeId, entryRooms(e, jobOf(e.jobCodeId)));
    return scope.mode === 'include' ? hit : !hit;
  });
}

/**
 * "Bar positions", "All positions except Kitchen", "Nothing": a scope in words, for the apps and the tools.
 * names: { job(id) → name, lang }.
 */
export function describeScope(scope, { job = (id) => id, lang = 'en' } = {}) {
  const es = lang === 'es';
  if (isAll(scope)) return es ? 'Todos los puestos' : 'All positions';
  if (scope.mode === 'none') return es ? 'Ninguno (solo si nadie más puede)' : 'None (only when nobody else can)';
  const parts = [...(scope.rooms || []).map((r) => (es ? `puestos de ${r}` : `${r} positions`)), ...(scope.positions || []).map(job).filter(Boolean)];
  const list = parts.join(', ');
  return scope.mode === 'include' ? (es ? `Solo: ${list}` : `Only: ${list}`) : (es ? `Todo excepto: ${list}` : `All except: ${list}`);
}

/**
 * The RPCs: a person's "Approves for" (Team → person) and the role defaults (Settings → Roles & features).
 *   approvalScope.get       { userId? }              → { scope, own, roleDefault, source, label, canApprove, canSet }
 *   approvalScope.set       { userId, scope | null } managers and up for people they manage, admins for managers too.
 *                                                    null = back to the role's default. Never your own; never an admin's.
 *   approvalScope.roles     {}                       → { manager, supervisor } (admins)
 *   approvalScope.saveRoles { manager?, supervisor? } (admins; null = all positions)
 */
export function approvalScopeApi({ store, settings, putSettings, fail, needAuth, needMgr, needAdmin, userById, canApprove, canManageUser, layoutRooms, now, uid }) {
  const jobExists = (id) => !!store.get('jobCodes', id);
  const roomExists = (r) => layoutRooms().some((x) => sameArea(x, r));
  const check = (raw) => cleanScope(raw, { jobExists, roomExists, fail });
  const jobName = (id) => store.get('jobCodes', id)?.name || '';
  const canSet = (actor, target) => !!target && actor.id !== target.id && !canChangeSettings(target) && (canChangeSettings(actor) || canManageUser(actor, target));
  const audit = (actor, action, details) => store.insert('auditLog', { id: uid('aud'), at: now().toISOString(), actorId: actor.id, targetId: details.userId || null, action, via: 'app', details });
  const out = (actor, u) => {
    const st = settings();
    const scope = scopeOf(u, st);
    const role = roleScopes(st)[featureRoleOf(u, st)];
    return {
      userId: u.id, scope, own: u.approvalScope?.mode ? { ...ALL_SCOPE, ...u.approvalScope } : null, roleDefault: role ? { ...ALL_SCOPE, ...role } : ALL_SCOPE,
      source: scopeSource(u, st), canApprove: canApprove(u, st), canSet: canSet(actor, u),
      label: { en: describeScope(scope, { job: jobName, lang: 'en' }), es: describeScope(scope, { job: jobName, lang: 'es' }) },
    };
  };
  const api = {
    'approvalScope.get': (actor, { userId } = {}) => {
      needAuth(actor);
      const u = userById(userId || actor.id);
      if (!u) fail(404, 'User not found');
      if (u.id !== actor.id) needMgr(actor);
      return out(actor, u);
    },
    'approvalScope.set': (actor, { userId, scope } = {}) => {
      needMgr(actor);
      const u = userById(userId);
      if (!u) fail(404, 'User not found');
      if (canChangeSettings(u)) fail(400, 'Admins and Super Admins always approve everything');
      if (u.id === actor.id) fail(403, 'Ask another manager or an admin to change what you approve');
      if (!canSet(actor, u)) fail(403, 'Only a higher role can change what they approve');
      const next = scope == null ? null : check(scope);
      store.update('users', u.id, { approvalScope: next });
      audit(actor, 'approvalScope.set', { userId: u.id, scope: next });
      return out(actor, userById(u.id));
    },
    'approvalScope.roles': (actor) => {
      needAdmin(actor);
      const r = roleScopes(settings());
      return Object.fromEntries([...SCOPE_ROLES, ...customRolesOf(settings()).map((c) => c.id)].map((role) => [role, r[role] ? { ...ALL_SCOPE, ...r[role] } : ALL_SCOPE]));
    },
    'approvalScope.saveRoles': (actor, patch = {}) => {
      needAdmin(actor);
      const cur = { ...roleScopes(settings()) };
      for (const role of [...SCOPE_ROLES, ...customRolesOf(settings()).map((c) => c.id)]) {
        if (!(role in patch)) continue;
        const v = patch[role] == null ? null : check(patch[role]);
        if (!v || (isAll(v) && v.timeOff !== false)) delete cur[role]; else cur[role] = v;
      }
      putSettings({ approvalScopes: cur });
      audit(actor, 'approvalScope.roles', { approvalScopes: cur });
      return api['approvalScope.roles'](actor);
    },
  };
  return api;
}
