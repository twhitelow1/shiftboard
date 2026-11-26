// An Admin making themselves Super Admin, and the restaurant's switch that allows it.
//
//   settings.adminsCanBecomeSuperAdmin   on unless it's false. It's only stored once someone changes it, so
//                                        restaurants that never touch it answer exactly as before (the
//                                        Roles & features parity test in test/role-features.test.js).
//   Who changes the switch               Super Admins (on or off), and DubLow from the platform console. Never
//                                        a plain Admin, a DubLow support session, View as, the Claude connector
//                                        or Ask ShiftBoard.
//   account.becomeSuperAdmin             an active Admin, while the switch is on, signed in as themselves on
//                                        the web, with a second step entered with the request (a code from
//                                        their authenticator app or a passkey). server/app.js checks the
//                                        second step and passes it in as createService's `freshStep`; without
//                                        it the call is refused, so nothing else (the demo, the tools) can do it.
//
// What promotion does: the role changes and nothing else (no sign-out), an audit entry, and every other Admin
// and Super Admin hears about it in the app and, with their email consent, by a security email (server/app.js).
import { uid } from './store.js';
import { roleOf } from './roles.js';

export const SETTING = 'adminsCanBecomeSuperAdmin';
/** The audit log's actions (the restaurant's auditLog collection). */
export const AUDIT_PROMOTE = 'role.selfSuperAdmin';
export const AUDIT_SETTING = 'settings.adminsCanBecomeSuperAdmin';
/** RPCs only a person may run, in the app, as themselves: never through the Claude connector or Ask ShiftBoard. */
export const HUMAN_ONLY = new Set(['account.becomeSuperAdmin', 'settings.adminsCanBecomeSuperAdmin']);

// Errors (Spanish in core/errors.js).
export const SA_OFF = 'Admins can’t make themselves Super Admin in this restaurant. Ask a Super Admin.';
export const SA_ADMINS_ONLY = 'Only an Admin can make themselves Super Admin';
export const SA_ALREADY = 'You’re already a Super Admin';
export const SA_STEP = 'Confirm it’s you with your authenticator app or a passkey first';
export const SA_NOT_HERE = 'Only you can do this, in ShiftBoard on the web. Claude can’t do it for you.';
export const SA_WEB_ONLY = 'Making yourself Super Admin is only on the web, in My settings';
export const SA_SUPER_ONLY = 'Only a Super Admin can change this';
export const SA_ON_OFF = 'Turn it on or off';

/** Is the switch on? Not set means on. */
export const selfPromotionOn = (settings) => settings?.[SETTING] !== false;

/** Why this person can't make themselves Super Admin right now (an error message), or null. */
export function selfPromotionRefusal(actor, settings) {
  if (!actor || actor.active === false) return 'Please sign in';
  const r = roleOf(actor);
  if (r === 'super_admin') return SA_ALREADY;
  if (r !== 'admin') return SA_ADMINS_ONLY;
  if (!selfPromotionOn(settings)) return SA_OFF;
  return null;
}

/**
 * Turn the switch on or off and log it in the restaurant's audit log. Used by the RPC (a Super Admin) and the
 * platform console (DubLow). by: { actorId } or { console: the DubLow admin's email }. Returns the new value.
 */
export function setSelfPromotion(store, on, { at, actorId = null, console: consoleBy = null } = {}) {
  const cur = store.get('settings', 'settings');
  const was = selfPromotionOn(cur);
  if (cur) store.update('settings', 'settings', { [SETTING]: on });
  else store.insert('settings', { id: 'settings', [SETTING]: on });
  if (was !== on) {
    store.insert('auditLog', { id: uid('aud'), at, actorId, targetId: null, action: AUDIT_SETTING,
      details: { from: was, to: on, ...(consoleBy ? { via: 'console', by: consoleBy } : {}) } });
  }
  return on;
}

/**
 * The RPCs (spread into core/service.js's api). d: { store, settings, putSettings, fail, needAuth, needAdmin,
 * notify, say, now, freshStep, via, view(user) }.
 */
export function superAdminApi(d) {
  const { store, fail, now } = d;
  return {
    // Settings → Roles & features: "Admins can make themselves Super Admin". { on: true | false }.
    'settings.adminsCanBecomeSuperAdmin': (actor, { on } = {}) => {
      d.needAdmin(actor);
      if (d.via) fail(403, SA_NOT_HERE);
      if (roleOf(actor) !== 'super_admin') fail(403, SA_SUPER_ONLY);
      if (typeof on !== 'boolean') fail(400, SA_ON_OFF);
      return { [SETTING]: setSelfPromotion(store, on, { at: now().toISOString(), actorId: actor.id }) };
    },

    // My settings → Become Super Admin. The second step was checked by the server (freshStep: { method }).
    'account.becomeSuperAdmin': (actor) => {
      d.needAuth(actor);
      if (d.via) fail(403, SA_NOT_HERE);
      const me = store.get('users', actor.id);
      const problem = selfPromotionRefusal(me, d.settings());
      if (problem) fail(403, problem);
      if (!d.freshStep?.method) fail(403, SA_STEP);
      const at = now().toISOString();
      const u = store.update('users', me.id, { role: 'super_admin', superAdminSince: at, superAdminBy: 'self' });
      store.insert('auditLog', { id: uid('aud'), at, actorId: me.id, targetId: me.id, action: AUDIT_PROMOTE,
        details: { from: 'admin', to: 'super_admin', step: d.freshStep.method, summary: `${me.name} made themselves Super Admin` } });
      // Every other active Admin and Super Admin: in the app (and push), and a security email from server/app.js.
      const told = store.list('users', (x) => x.id !== me.id && x.active !== false && ['admin', 'super_admin'].includes(roleOf(x))).map((x) => x.id);
      d.notify(told, d.say('madeSuperAdmin', me.name), '#/team', { security: true });
      return { ok: true, me: d.view(u), told: told.length };
    },
  };
}
