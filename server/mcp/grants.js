// Connections (OAuth grants) and the restaurant's connector settings, in the restaurant's own document store.
//
// mcpGrants: one document per connection (a person + a client), created on Allow:
//   { id, userId, clientId, clientName, clientKind: 'claude'|'loopback', redirectUri, scope: [...], resource,
//     v (the person's sessionVersion when they allowed it), status: 'pending'|'active'|'revoked'|'failed',
//     codeHash, codeExpiresAt, codeChallenge, codeUsedAt,
//     refreshHash, refreshExpiresAt, rotatedAt, oldRefreshHashes: [...],
//     createdAt, connectedAt, lastUsedAt, revokedAt, revokedReason }
// Only hashes of codes and refresh tokens are stored. A connection stops working when the person's sessionVersion
// changes (password change or reset, second step reset), when they're deactivated, or when it's revoked.
//
// mcpConfig/main: { enabled (default true), staffReadOnly (default false), updatedAt, updatedBy }.
import { uid } from '../../core/store.js';
import { atLeast } from '../../core/roles.js';
import { SCOPES } from './tokens.js';

export const GRANTS = 'mcpGrants';
export const CONFIG = 'mcpConfig';
const KEEP_OLD_REFRESH = 10; // rotated refresh tokens remembered for reuse detection

export function configOf(store) {
  const c = store.get(CONFIG, 'main') || {};
  return { enabled: c.enabled !== false, staffReadOnly: !!c.staffReadOnly, updatedAt: c.updatedAt || null };
}

export function saveConfig(store, patch, actorId, at) {
  const doc = { ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}), ...(typeof patch.staffReadOnly === 'boolean' ? { staffReadOnly: patch.staffReadOnly } : {}), updatedAt: at, updatedBy: actorId };
  if (store.get(CONFIG, 'main')) store.update(CONFIG, 'main', doc); else store.insert(CONFIG, { id: 'main', ...doc });
  return configOf(store);
}

/** Staff (below manager) get read-only connections when the restaurant chose that. */
export const forcedReadOnly = (store, user) => configOf(store).staffReadOnly && !atLeast(user, 'manager');

/** Why a grant can't be used right now (null when it can). */
export function grantProblem(store, grant, nowIso) {
  if (!grant) return 'unknown';
  if (grant.status !== 'active') return grant.status === 'revoked' ? 'revoked' : 'inactive';
  const u = store.get('users', grant.userId);
  if (!u || u.active === false) return 'deactivated';
  if ((u.sessionVersion || 0) !== (grant.v || 0)) return 'signedOut'; // password changed or reset, two-step reset…
  if (grant.refreshExpiresAt && grant.refreshExpiresAt < nowIso) return 'expired';
  return null;
}

export const findByCode = (store, hash) => store.list(GRANTS, (g) => g.codeHash === hash)[0] || null;
export const findByRefresh = (store, hash) => store.list(GRANTS, (g) => g.refreshHash === hash)[0] || null;
export const findByOldRefresh = (store, hash) => store.list(GRANTS, (g) => (g.oldRefreshHashes || []).includes(hash))[0] || null;

export function createPending(store, { user, client, label, redirectUri, scope, resource, codeHash, codeExpiresAt, codeChallenge, at }) {
  return store.insert(GRANTS, {
    id: uid('mcg'), userId: user.id, clientId: client.clientId, clientName: label.name, clientKind: label.kind, redirectUri,
    scope, resource, v: user.sessionVersion || 0, status: 'pending', codeHash, codeExpiresAt, codeChallenge, createdAt: at,
  });
}

export function activate(store, grant, { refreshHash, refreshExpiresAt, at }) {
  return store.update(GRANTS, grant.id, { status: 'active', codeUsedAt: at, connectedAt: at, lastUsedAt: at, refreshHash, refreshExpiresAt, rotatedAt: at, oldRefreshHashes: [] });
}

export function rotate(store, grant, { refreshHash, refreshExpiresAt, at }) {
  const old = [grant.refreshHash, ...(grant.oldRefreshHashes || [])].filter(Boolean).slice(0, KEEP_OLD_REFRESH);
  return store.update(GRANTS, grant.id, { refreshHash, refreshExpiresAt, rotatedAt: at, lastUsedAt: at, oldRefreshHashes: old });
}

export function revoke(store, grant, reason, at) {
  if (grant.status === 'revoked') return grant;
  return store.update(GRANTS, grant.id, { status: 'revoked', revokedAt: at, revokedReason: reason, refreshHash: null, codeHash: grant.codeHash || null });
}

/** Drop what nobody can use anymore: codes never exchanged, and connections revoked or expired over a week ago. */
export function prune(store, nowMs) {
  const hourAgo = new Date(nowMs - 3600_000).toISOString();
  const weekAgo = new Date(nowMs - 7 * 86400_000).toISOString();
  for (const g of store.list(GRANTS)) {
    const dead = (g.status === 'pending' && g.codeExpiresAt < hourAgo)
      || (g.status === 'failed' && (g.codeUsedAt || g.createdAt) < hourAgo)
      || (g.status === 'revoked' && (g.revokedAt || '') < weekAgo)
      || (g.status === 'active' && g.refreshExpiresAt && g.refreshExpiresAt < weekAgo);
    if (dead) store.remove(GRANTS, g.id);
  }
}

/** What the person sees in My settings → Connected apps (their own working connections). */
export function connectionsOf(store, userId, nowIso) {
  return store.list(GRANTS, (g) => g.userId === userId && !grantProblem(store, g, nowIso))
    .sort((a, b) => String(b.connectedAt).localeCompare(String(a.connectedAt)))
    .map((g) => ({ id: g.id, name: g.clientName, kind: g.clientKind, readOnly: !g.scope.includes(SCOPES.write), connectedAt: g.connectedAt, lastUsedAt: g.lastUsedAt || g.connectedAt }));
}

export const activeCount = (store, nowIso) => store.list(GRANTS, (g) => !grantProblem(store, g, nowIso)).length;
