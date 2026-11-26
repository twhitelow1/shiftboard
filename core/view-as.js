// View as: a Super Admin sees the app exactly as one person, or one role, sees it. Read-only.
//
// The server (server/view-as.js) and the in-browser demo (web/src/api.js) both use this: who may be viewed,
// the person the app is computed as (the real person, or a stand-in for a role with the positions and rooms
// picked), which RPCs are reads, and what's never shown (the person's sign-in details).
//
// How it stays read-only: only reads run (isViewRead), and they run on a throwaway copy of the data
// (an OverlayStore that's never saved), so even a read that tidies something up as it goes saves nothing.
import { rankOf, roleOf, roleLabel } from './roles.js';
import { addDays } from './time.js';
import { uid, OverlayStore } from './store.js';
import { AppError, createService } from './service.js';
import { cleanDraft } from './role-features.js';

export const VIEW_MINUTES = 45;
export const VIEW_ROLES = ['employee', 'supervisor', 'manager', 'admin'];
export const STAND_IN_ID = 'usr_view_as_role';
// The audit log's actions (the restaurant's auditLog collection).
export const AUDIT_START = 'viewAs.start';
export const AUDIT_STOP = 'viewAs.stop';

// Errors (Spanish in core/errors.js).
export const VIEW_READ_ONLY = 'Read-only while viewing as someone else. Exit the view to make changes.';
export const VIEW_SUPER_ONLY = 'Only a Super Admin can use View as';
export const VIEW_HIGHER = 'You can’t view as someone with a higher role';
export const VIEW_NOT_PHONE = 'View as isn’t available in the phone app';
export const VIEW_NOT_SUPPORT = 'View as isn’t available while DubLow Digital is signed in for support';
export const VIEW_HIDDEN = 'Not shown while viewing as someone else';

/** RPCs that only read (everything else is refused while viewing). Their writes, if any, are thrown away. */
const READ = /\.(list|get|week|summary|covers|eligible|suggestStaffing|publicKey)$/;
export const isViewRead = (method) => method === 'app.bootstrap' || READ.test(String(method || ''));

const fail = (status, message) => { throw new AppError(status, message); };
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The person a role preview is "typical" of: whoever of that role works most in the next two weeks (then the last one). */
export function typicalPerson(store, role, { today, exclude } = {}) {
  const from = addDays(today, -7);
  const to = addDays(today, 14);
  const count = new Map();
  for (const s of store.list('shifts', (x) => x.published && x.userId && x.date >= from && x.date <= to)) count.set(s.userId, (count.get(s.userId) || 0) + 1);
  const people = store.list('users', (u) => u.active !== false && roleOf(u) === role && u.id !== exclude && u.onSchedule !== false)
    .sort((a, b) => (count.get(b.id) || 0) - (count.get(a.id) || 0) || (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.name).localeCompare(String(b.name)));
  return people[0] || null;
}

/**
 * Check a request to start viewing and turn it into what the view token carries:
 *   { userId, typical? }                     a person (typical: the role they were picked for)
 *   { role, positions: [ids], rooms: [names] } a role, with no person attached
 * real: the signed-in person (must be an active Super Admin). ask: { userId } or { role, positions?, rooms?, typical? }.
 */
export function resolveTarget(store, real, ask = {}, { today } = {}) {
  if (!real || real.active === false || roleOf(real) !== 'super_admin') fail(403, VIEW_SUPER_ONLY);
  if (ask.userId) {
    const u = store.get('users', String(ask.userId));
    if (!u) fail(404, 'User not found');
    if (u.id === real.id) fail(400, 'That’s you. Pick someone else.');
    if (u.active === false) fail(400, 'This person is inactive');
    if (rankOf(u) > rankOf(real)) fail(403, VIEW_HIGHER);
    return { userId: u.id };
  }
  if (!VIEW_ROLES.includes(ask.role)) fail(400, 'Unknown role');
  if (ask.typical) {
    const u = typicalPerson(store, ask.role, { today, exclude: real.id });
    if (!u) fail(404, 'Nobody has this role yet');
    return { userId: u.id, typical: ask.role };
  }
  const jobs = new Set(store.list('jobCodes', (j) => !j.archived).map((j) => j.id));
  const positions = [...new Set((Array.isArray(ask.positions) ? ask.positions : []).map(String))].filter((id) => jobs.has(id)).slice(0, 12);
  const rooms = [...new Set((Array.isArray(ask.rooms) ? ask.rooms : []).map((r) => text(r, 60)).filter(Boolean))].slice(0, 12);
  return { role: ask.role, positions, rooms };
}

/** The stand-in for a role preview: someone of that role with the positions (in the rooms) picked. */
export function standIn(target, lang = 'en') {
  return {
    id: STAND_IN_ID, name: lang === 'es' ? `${roleLabel(target.role, lang)} de muestra` : `Sample ${roleLabel(target.role, lang)}`, sheetName: '', role: target.role,
    email: '', phone: '', active: true, onSchedule: false, eventsAccess: false, availability: {}, color: null,
    jobCodes: (target.positions || []).map((jobCodeId, i) => ({ jobCodeId, rate: null, primary: i === 0, ...(target.rooms?.length ? { areas: [...target.rooms] } : {}) })),
    passwordHash: null, smsConsent: false, emailConsent: false, standIn: true,
  };
}

/**
 * Who the app is computed as right now, or null when the view no longer holds (the person left, was
 * deactivated, or now outranks the viewer). Checked on every request, not only when the view started.
 */
export function viewedPerson(store, real, target, lang = 'en') {
  if (!target || !real || roleOf(real) !== 'super_admin' || real.active === false) return null;
  if (target.role && !target.userId) return VIEW_ROLES.includes(target.role) ? standIn(target, lang) : null;
  const u = store.get('users', target.userId);
  if (!u || u.active === false || u.id === real.id || rankOf(u) > rankOf(real)) return null;
  return u;
}

/**
 * Get a throwaway store ready to compute as the viewed person: the role stand-in joins the team for this one
 * request, and a preview from Roles & features uses its unsaved settings. Returns the actor.
 */
export function prepareView(view, actor, draft) {
  if (actor.standIn) view.insert('users', actor);
  const d = cleanDraft(draft);
  if (d) {
    if (view.get('settings', 'settings')) view.update('settings', 'settings', d);
    else view.insert('settings', { id: 'settings', ...d });
  }
  return view.get('users', actor.id) || actor;
}

/** What View as never shows: the person's sign-in details (two-step, passkeys, recovery codes). */
export function hideSecrets(method, result) {
  if (method !== 'app.bootstrap' || !result?.me) return result;
  return { ...result, me: { ...result.me, security: null, hidden: true } };
}

/**
 * One RPC while viewing, on the server and in the demo alike: reads only, computed as the viewed person on a
 * throwaway copy of `base` that's never saved. view: { real, target, actor, draft, until, lang }.
 */
export function viewCall(base, view, method, args, serviceOpts = {}) {
  if (!isViewRead(method)) fail(403, VIEW_READ_ONLY);
  const store = new OverlayStore(base);
  const actor = prepareView(store, view.actor, view.draft);
  const result = hideSecrets(method, createService(store, serviceOpts).call(actor, method, structuredClone(args ?? {})));
  if (method !== 'app.bootstrap' || !result) return result;
  return { ...result, viewAs: viewInfo(base, view.real, view.target, { until: view.until, draft: view.draft, lang: view.lang }) };
}

/** What the app shows about the view (the banner): bootstrap's `viewAs`. */
export function viewInfo(store, real, target, { until, draft, lang = 'en' } = {}) {
  const actor = viewedPerson(store, real, target, lang);
  const jobs = Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j.name]));
  return {
    by: { id: real.id, name: real.name, language: real.language || '' },
    kind: target.userId ? 'person' : 'role',
    userId: target.userId || null,
    name: actor?.name || '',
    role: actor ? roleOf(actor) : target.role,
    typical: target.typical || null,
    positions: (target.positions || []).map((id) => jobs[id]).filter(Boolean),
    rooms: target.rooms || [],
    draft: !!draft,
    until: until ? new Date(until).toISOString() : null,
  };
}

/** For the picker: the people a Super Admin may view (anyone at or below them, but themselves), the roles, positions and rooms. */
export function viewOptions(store, real, { areas = [] } = {}) {
  if (!real || roleOf(real) !== 'super_admin') fail(403, VIEW_SUPER_ONLY);
  const jobs = store.list('jobCodes', (j) => !j.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const jobName = Object.fromEntries(jobs.map((j) => [j.id, j.name]));
  const people = store.list('users', (u) => u.active !== false && u.id !== real.id && rankOf(u) <= rankOf(real))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((u) => ({ id: u.id, name: u.name, role: roleOf(u), photoId: u.photoId || null, color: u.color || null,
      positions: (u.jobCodes || []).map((j) => jobName[j.jobCodeId]).filter(Boolean) }));
  return { people, roles: VIEW_ROLES, positions: jobs.map((j) => ({ id: j.id, name: j.name })), rooms: areas, minutes: VIEW_MINUTES };
}

/** The audit log entry for a view starting or stopping (the restaurant's auditLog collection). */
export function viewAudit(store, { action, real, target, at, details = {} }) {
  const who = target?.userId ? store.get('users', target.userId) : null;
  return store.insert('auditLog', {
    id: uid('aud'), at, actorId: real.id, targetId: target?.userId || null, action,
    details: { by: real.name, ...(who ? { name: who.name, role: roleOf(who) } : {}), ...(target?.role && !target.userId ? { role: target.role, positions: target.positions || [], rooms: target.rooms || [] } : {}),
      ...(target?.typical ? { typical: target.typical } : {}), ...details },
  });
}
