// Custom roles ("types of managers"): Bar Manager, Kitchen Manager, Events Manager, Shift Lead…
//
// A custom role is { id: 'cr_…', name, nameEs, base: 'manager' | 'supervisor' | 'employee' } in settings.customRoles.
// People given one keep role = its base level (so every rank check works as before) and customRole = its id. The role
// gets its own column in Settings → Roles & features (a copy of its base level's column when it's made) and its own
// "Approves for" default (settings.approvalScopes[id], core/approval-scope.js). None exist until an admin makes one.
//
//   roles.custom.list    {}                          → [{ id, name, nameEs, base, people }] (everyone signed in: labels)
//   roles.custom.save    { id?, name, nameEs?, base } Admins and Super Admins: make or rename one (a new base level moves its people)
//   roles.custom.delete  { id, confirm? }            Admins and Super Admins; with people on it, first answers
//                                                    { needsConfirm, people } — confirm: true moves them to the base level
// Granting one (employees.save { customRole }) follows the base level: nobody grants a base level above their own.
import { CUSTOM_BASES, customRolesOf, useCustomRoles } from './roles.js';
import { roleMatrix, cleanRoleFeatures } from './role-features.js';

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const BUILT_IN = ['super admin', 'admin', 'manager', 'supervisor', 'employee', 'superadministrador', 'administrador', 'gerente', 'empleado'];

export function customRoleApi({ store, settings, putSettings, fail, needAuth, needAdmin, now, uid }) {
  const peopleOn = (id) => store.list('users', (u) => u.customRole === id);
  const audit = (actor, action, details) => store.insert('auditLog', { id: uid('aud'), at: now().toISOString(), actorId: actor.id, targetId: null, action, via: 'app', details });
  const list = () => customRolesOf(settings()).map((r) => ({ ...r, people: peopleOn(r.id).filter((u) => u.active !== false).length }));
  return {
    'roles.custom.list': (actor) => { needAuth(actor); return list(); },
    'roles.custom.save': (actor, a = {}) => {
      needAdmin(actor);
      const name = text(a.name, 40);
      const nameEs = text(a.nameEs, 40);
      if (!name) fail(400, 'Give the role a name');
      if (!CUSTOM_BASES.includes(a.base)) fail(400, 'Pick the level it’s based on: Manager, Supervisor or Employee');
      const st = settings();
      const roles = customRolesOf(st);
      const cur = a.id ? roles.find((r) => r.id === a.id) : null;
      if (a.id && !cur) fail(404, 'Role not found');
      const key = name.toLowerCase();
      if (BUILT_IN.includes(key) || roles.some((r) => r.id !== cur?.id && r.name.toLowerCase() === key)) fail(400, 'There’s already a role with that name');
      if (cur) {
        const next = roles.map((r) => (r.id === cur.id ? { ...r, name, nameEs, base: a.base } : r));
        putSettings({ customRoles: next });
        useCustomRoles(next); // labels in this same call (notifications) use the new name
        if (cur.base !== a.base) for (const u of peopleOn(cur.id)) store.update('users', u.id, { role: a.base }); // its people follow the new level
        audit(actor, 'roles.custom.save', { id: cur.id, name, base: a.base, ...(cur.name !== name ? { renamedFrom: cur.name } : {}) });
        return list().find((r) => r.id === cur.id);
      }
      if (roles.length >= 30) fail(400, 'Up to 30 custom roles');
      const id = uid('cr').replace(/[^a-z0-9_]/gi, '_');
      // Its Roles & features column starts as a copy of its base level's column (including "Can approve requests").
      const copy = { ...roleMatrix(st)[a.base] };
      const next = [...roles, { id, name, nameEs, base: a.base }];
      const roleFeatures = cleanRoleFeatures({ ...(st.roleFeatures || {}), [id]: copy }, { ...st, customRoles: next });
      putSettings({ customRoles: next, roleFeatures });
      useCustomRoles(next);
      audit(actor, 'roles.custom.create', { id, name, base: a.base });
      return list().find((r) => r.id === id);
    },
    'roles.custom.delete': (actor, { id, confirm } = {}) => {
      needAdmin(actor);
      const st = settings();
      const role = customRolesOf(st).find((r) => r.id === id);
      if (!role) fail(404, 'Role not found');
      const people = peopleOn(id);
      if (people.length && confirm !== true) return { needsConfirm: true, people: people.length, base: role.base };
      for (const u of people) store.update('users', u.id, { customRole: null, role: role.base });
      const { [id]: _f, ...roleFeatures } = st.roleFeatures || {};
      const { [id]: _s, ...approvalScopes } = st.approvalScopes || {};
      putSettings({ customRoles: customRolesOf(st).filter((r) => r.id !== id), roleFeatures, approvalScopes });
      audit(actor, 'roles.custom.delete', { id, name: role.name, base: role.base, moved: people.length });
      return { ok: true, moved: people.length, base: role.base };
    },
  };
}

/** employees.save's part: { role, customRole } from what was sent (a custom role sets the role to its base level). */
export function customRoleChoice(a, cur, settings, fail) {
  if (!('customRole' in a)) return { customRole: cur?.customRole || null, role: null };
  if (!a.customRole) return { customRole: null, role: null };
  const r = customRolesOf(settings).find((x) => x.id === a.customRole);
  if (!r) fail(400, 'Unknown role');
  return { customRole: r.id, role: r.base };
}
