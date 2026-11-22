// The tenant registry: the `platform` schema, shared by every restaurant on this deployment.
//
//   platform.tenants         one row per restaurant: slug, name, its Postgres schema, status, plan,
//                            feature overrides, domains, owner, trial end, notes, integration settings
//                            (non-secret) and billing (phase 2: Stripe ids, see server/billing.js)
//   platform.tenant_secrets  per-restaurant secrets, AES-256-GCM encrypted (secrets.js)
//   platform.admins          DubLow staff who can use the platform console
//   platform.audit_log       every platform action
//   platform.support_grants  one-time "Sign in as owner" links
//   platform.login_attempts  console sign-in rate limiting
//   platform.meta            schema version, console signing secret
//
// Creating this schema and registering the default restaurant only adds rows here: the default
// restaurant's own schema (shiftboard) is read, never changed.
import crypto from 'node:crypto';
import { lockKeyFor } from '../db.js';
import { encrypt, decrypt, encryptionKey, lastFour } from './secrets.js';
import { resolveFeatures, cleanOverrides, STATUSES } from './plans.js';
import { SECRET_KEYS } from './tenant-env.js';

const P = 'platform';
const VERSION = '1';
const LOCK = lockKeyFor('platform:registry');
export const DEFAULT_TENANT_ID = 'default';
const GRANT_MINUTES = 3; // how long a "Sign in as owner" link can be opened

const MIGRATIONS = [
  `CREATE SCHEMA IF NOT EXISTS ${P}`,
  `CREATE TABLE IF NOT EXISTS ${P}.meta (key text PRIMARY KEY, value text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${P}.tenants (
     id            text        PRIMARY KEY,
     slug          text        NOT NULL UNIQUE,
     name          text        NOT NULL,
     schema_name   text        NOT NULL UNIQUE,
     status        text        NOT NULL DEFAULT 'trialing' CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})),
     plan          text        NOT NULL DEFAULT 'starter',
     features      jsonb       NOT NULL DEFAULT '{}'::jsonb,
     domains       text[]      NOT NULL DEFAULT '{}',
     owner_email   text,
     owner_name    text,
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now(),
     version       integer     NOT NULL DEFAULT 1,
     trial_ends_at timestamptz,
     notes         text        NOT NULL DEFAULT '',
     billing       jsonb       NOT NULL DEFAULT '{}'::jsonb,
     integrations  jsonb       NOT NULL DEFAULT '{}'::jsonb,
     is_default    boolean     NOT NULL DEFAULT false
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_default ON ${P}.tenants (is_default) WHERE is_default`,
  `CREATE TABLE IF NOT EXISTS ${P}.tenant_secrets (
     tenant_id  text        NOT NULL REFERENCES ${P}.tenants(id) ON DELETE CASCADE,
     key        text        NOT NULL,
     value_enc  text        NOT NULL,
     last4      text        NOT NULL DEFAULT '',
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS ${P}.admins (
     id              text        PRIMARY KEY,
     email           text        NOT NULL UNIQUE,
     name            text        NOT NULL DEFAULT '',
     password_hash   text        NOT NULL,
     session_version integer     NOT NULL DEFAULT 0,
     created_at      timestamptz NOT NULL DEFAULT now(),
     last_login_at   timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS ${P}.audit_log (
     id          bigserial   PRIMARY KEY,
     at          timestamptz NOT NULL DEFAULT now(),
     admin_id    text,
     admin_email text,
     action      text        NOT NULL,
     tenant_id   text,
     details     jsonb       NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS audit_log_at_idx ON ${P}.audit_log (at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON ${P}.audit_log (tenant_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${P}.support_grants (
     token_hash      text        PRIMARY KEY,
     tenant_id       text        NOT NULL,
     user_id         text        NOT NULL,
     admin_id        text        NOT NULL,
     admin_email     text        NOT NULL,
     session_minutes integer     NOT NULL,
     created_at      timestamptz NOT NULL DEFAULT now(),
     expires_at      timestamptz NOT NULL,
     used_at         timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS ${P}.login_attempts (key text NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS platform_login_attempts_idx ON ${P}.login_attempts (key, at)`,
  ...['meta', 'tenants', 'tenant_secrets', 'admins', 'audit_log', 'support_grants', 'login_attempts']
    .map((t) => `ALTER TABLE ${P}.${t} ENABLE ROW LEVEL SECURITY`),
];

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const titleCase = (slug) => String(slug).split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** A registry row as the rest of the server uses it. */
export function toTenant(r) {
  const features = cleanOverrides(r.features || {});
  return {
    id: r.id, slug: r.slug, name: r.name, schema_name: r.schema_name, status: r.status, plan: r.plan,
    features, resolved: resolveFeatures(r.plan, features),
    domains: [...(r.domains || [])], owner_email: r.owner_email || '', owner_name: r.owner_name || '',
    created_at: iso(r.created_at), updated_at: iso(r.updated_at), version: Number(r.version || 1),
    trial_ends_at: iso(r.trial_ends_at), notes: r.notes || '', billing: r.billing || {}, integrations: r.integrations || {},
    is_default: !!r.is_default,
  };
}

export class Registry {
  /**
   * @param o.conn  the shared connection (pg.Pool or the PGlite adapter)
   * @param o.env
   * @param o.ttlMs how long the tenant list is trusted before re-reading it (changes made on another
   *                instance show up within this time; changes made here show up at once)
   */
  constructor({ conn, env = process.env, ttlMs = Number(env.TENANT_REGISTRY_TTL_MS) || 5000 }) {
    this.conn = conn;
    this.env = env;
    this.ttlMs = ttlMs;
    this.cache = null; // { at, rows: tenant[], byId, bySlug, byDomain, defaultTenant }
    this.loading = null;
  }

  query(text, params) { return this.conn.query(text, params); }

  async withLock(fn) {
    const client = await this.conn.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw e;
    } finally {
      client.release(broken || undefined);
    }
  }

  /** Create or upgrade the platform schema. Additive only; cheap when current. */
  async migrate() {
    try {
      const { rows } = await this.query(`SELECT value FROM ${P}.meta WHERE key = 'schema_version'`);
      if (rows[0]?.value === VERSION) return;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '3F000') throw e;
    }
    await this.withLock(async (c) => {
      for (const sql of MIGRATIONS) await c.query(sql);
      await c.query(`INSERT INTO ${P}.meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [VERSION]);
    });
  }

  async ensureMeta(key, make) {
    const read = async () => (await this.query(`SELECT value FROM ${P}.meta WHERE key = $1`, [key])).rows[0]?.value;
    const v = await read();
    if (v != null) return v;
    await this.query(`INSERT INTO ${P}.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, make()]);
    return read();
  }

  /**
   * Register the first restaurant (Chasing Rabbits) with its existing schema, shiftboard, if it isn't
   * registered yet. Only reads the shiftboard schema (for its name); never writes to it.
   */
  async ensureDefaultTenant() {
    const { rows } = await this.query(`SELECT id FROM ${P}.tenants WHERE is_default`);
    if (rows.length) return;
    const slug = String(this.env.DEFAULT_TENANT_SLUG || 'chasing-rabbits').trim().toLowerCase();
    let name = String(this.env.DEFAULT_TENANT_NAME || '').trim();
    if (!name) {
      try {
        const r = await this.query(`SELECT data ->> 'restaurantName' AS n FROM shiftboard.docs WHERE col = 'settings' AND id = 'settings' AND NOT deleted`);
        const n = r.rows[0]?.n;
        if (n && n !== 'Our Restaurant') name = n;
      } catch { /* no shiftboard schema yet: a fresh install */ }
    }
    await this.query(
      `INSERT INTO ${P}.tenants (id, slug, name, schema_name, status, plan, owner_email, is_default, notes)
       VALUES ($1, $2, $3, 'shiftboard', 'active', 'beta', $4, true, $5)
       ON CONFLICT DO NOTHING`,
      [DEFAULT_TENANT_ID, slug, name || titleCase(slug) || 'Default restaurant', String(this.env.ADMIN_EMAIL || '').trim().toLowerCase() || null,
        'The first restaurant: schema shiftboard, its existing data, env integrations as the fallback.'],
    );
    this.invalidate();
  }

  // ---------- tenants ----------
  invalidate() { this.cache = null; }

  /** Every restaurant, from a short-lived cache (see ttlMs). */
  async snapshot({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache;
    this.loading ??= (async () => {
      const { rows } = await this.query(`SELECT * FROM ${P}.tenants ORDER BY created_at, slug`);
      const list = rows.map(toTenant);
      const snap = {
        at: Date.now(), list,
        byId: new Map(list.map((t) => [t.id, t])),
        bySlug: new Map(list.map((t) => [t.slug, t])),
        byDomain: new Map(list.flatMap((t) => t.domains.map((d) => [d, t]))),
        defaultTenant: list.find((t) => t.is_default) || null,
      };
      this.cache = snap;
      return snap;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async get(id) {
    const { rows } = await this.query(`SELECT * FROM ${P}.tenants WHERE id = $1`, [id]);
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async insertTenant(t) {
    const { rows } = await this.query(
      `INSERT INTO ${P}.tenants (id, slug, name, schema_name, status, plan, features, domains, owner_email, owner_name, trial_ends_at, notes, billing)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text[], $9, $10, $11, $12, $13::text::jsonb) RETURNING *`,
      [t.id, t.slug, t.name, t.schema_name, t.status, t.plan, JSON.stringify(t.features || {}), t.domains || [], t.owner_email || null,
        t.owner_name || null, t.trial_ends_at || null, t.notes || '', JSON.stringify(t.billing || {})],
    );
    this.invalidate();
    return toTenant(rows[0]);
  }

  /** Remove a registry row (only used to undo a restaurant whose setup failed). */
  async deleteTenantRow(id) {
    await this.query(`DELETE FROM ${P}.tenants WHERE id = $1 AND NOT is_default`, [id]);
    this.invalidate();
  }

  /**
   * Update a restaurant. patch: any of name, status, plan, features, domains, notes, trial_ends_at,
   * owner_email, owner_name, integrations, billing. Domains must not belong to another restaurant.
   */
  async updateTenant(id, patch) {
    const cols = { name: 'text', status: 'text', plan: 'text', features: 'jsonb', domains: 'text[]', notes: 'text', trial_ends_at: 'timestamptz',
      owner_email: 'text', owner_name: 'text', integrations: 'jsonb', billing: 'jsonb' };
    const sets = [];
    const params = [id];
    for (const [k, type] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      const v = patch[k];
      params.push(type === 'jsonb' ? JSON.stringify(v ?? {}) : v ?? null);
      sets.push(`${k} = $${params.length}::${type === 'jsonb' ? 'text::jsonb' : type}`);
    }
    const out = await this.withLock(async (c) => {
      if (patch.domains?.length) {
        const clash = await c.query(`SELECT slug, d FROM ${P}.tenants, unnest(domains) AS d WHERE id <> $1 AND d = ANY($2::text[])`, [id, patch.domains]);
        if (clash.rows.length) {
          const e = new Error(`${clash.rows[0].d} already belongs to ${clash.rows[0].slug}`);
          e.status = 409;
          throw e;
        }
      }
      const { rows } = await c.query(
        `UPDATE ${P}.tenants SET ${[...sets, 'updated_at = now()', 'version = version + 1'].join(', ')} WHERE id = $1 RETURNING *`, params);
      return rows[0] ? toTenant(rows[0]) : null;
    });
    this.invalidate();
    return out;
  }

  /** Bump a restaurant's version so every instance rebuilds it (after its secrets change). */
  async touch(id) {
    await this.query(`UPDATE ${P}.tenants SET updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
    this.invalidate();
  }

  // ---------- secrets ----------
  key() { return encryptionKey(this.env); }

  /** Decrypted secrets for building a restaurant's runtime: { TOAST_CLIENT_SECRET: '…' }. Server-side only. */
  async secretValues(tenantId) {
    const { rows } = await this.query(`SELECT key, value_enc FROM ${P}.tenant_secrets WHERE tenant_id = $1`, [tenantId]);
    if (!rows.length) return {};
    let key;
    try { key = this.key(); } catch (e) { console.error(e.message); return {}; }
    const out = {};
    for (const r of rows) {
      try { out[r.key] = decrypt(key, r.value_enc, `${tenantId}:${r.key}`); } catch { console.error(`Secret ${r.key} of ${tenantId} could not be decrypted (wrong PLATFORM_ENCRYPTION_KEY?)`); }
    }
    return out;
  }

  /** What the console sees: { KEY: { set, last4, updatedAt } } and never the values. */
  async secretView(tenantId) {
    const { rows } = await this.query(`SELECT key, last4, updated_at FROM ${P}.tenant_secrets WHERE tenant_id = $1`, [tenantId]);
    const out = {};
    for (const k of SECRET_KEYS) out[k] = { set: false, last4: '' };
    for (const r of rows) out[r.key] = { set: true, last4: r.last4, updatedAt: iso(r.updated_at) };
    return out;
  }

  /** Set (string) or clear (null / '') secrets. Needs PLATFORM_ENCRYPTION_KEY to set. */
  async setSecrets(tenantId, values) {
    const entries = Object.entries(values).filter(([k]) => SECRET_KEYS.includes(k));
    if (!entries.length) return;
    const key = entries.some(([, v]) => v) ? this.key() : null;
    if (entries.some(([, v]) => v) && !key) {
      const e = new Error('Set PLATFORM_ENCRYPTION_KEY on the server before saving secrets');
      e.status = 400;
      throw e;
    }
    for (const [k, v] of entries) {
      if (v) {
        await this.query(
          `INSERT INTO ${P}.tenant_secrets (tenant_id, key, value_enc, last4) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, last4 = EXCLUDED.last4, updated_at = now()`,
          [tenantId, k, encrypt(key, v, `${tenantId}:${k}`), lastFour(v)],
        );
      } else {
        await this.query(`DELETE FROM ${P}.tenant_secrets WHERE tenant_id = $1 AND key = $2`, [tenantId, k]);
      }
    }
    await this.touch(tenantId);
  }

  // ---------- audit log ----------
  async audit({ admin = null, action, tenantId = null, details = {} }) {
    await this.query(`INSERT INTO ${P}.audit_log (admin_id, admin_email, action, tenant_id, details) VALUES ($1, $2, $3, $4, $5::text::jsonb)`,
      [admin?.id || null, admin?.email || null, action, tenantId, JSON.stringify(details)]);
  }

  async auditLog({ tenantId = null, limit = 100 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const { rows } = tenantId
      ? await this.query(`SELECT * FROM ${P}.audit_log WHERE tenant_id = $1 ORDER BY at DESC, id DESC LIMIT ${n}`, [tenantId])
      : await this.query(`SELECT * FROM ${P}.audit_log ORDER BY at DESC, id DESC LIMIT ${n}`);
    return rows.map((r) => ({ id: Number(r.id), at: iso(r.at), adminEmail: r.admin_email, action: r.action, tenantId: r.tenant_id, details: r.details || {} }));
  }

  // ---------- platform admins ----------
  async adminCount() {
    return Number((await this.query(`SELECT count(*)::int AS n FROM ${P}.admins`)).rows[0].n);
  }

  async adminByEmail(email) {
    return (await this.query(`SELECT * FROM ${P}.admins WHERE email = $1`, [String(email || '').trim().toLowerCase()])).rows[0] || null;
  }

  async adminById(id) {
    return (await this.query(`SELECT * FROM ${P}.admins WHERE id = $1`, [id])).rows[0] || null;
  }

  async admins() {
    const { rows } = await this.query(`SELECT id, email, name, created_at, last_login_at FROM ${P}.admins ORDER BY created_at`);
    return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, createdAt: iso(r.created_at), lastLoginAt: iso(r.last_login_at) }));
  }

  async createAdmin({ email, name = '', passwordHash }) {
    const id = `adm_${crypto.randomBytes(6).toString('hex')}`;
    await this.query(`INSERT INTO ${P}.admins (id, email, name, password_hash) VALUES ($1, $2, $3, $4)`,
      [id, String(email).trim().toLowerCase(), name, passwordHash]);
    return this.adminById(id);
  }

  async setAdminPassword(id, passwordHash) {
    await this.query(`UPDATE ${P}.admins SET password_hash = $2, session_version = session_version + 1 WHERE id = $1`, [id, passwordHash]);
  }

  async stampAdminLogin(id) {
    await this.query(`UPDATE ${P}.admins SET last_login_at = now() WHERE id = $1`, [id]);
  }

  /** The first platform admin from PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD, while there are none. */
  async ensureFirstAdmin(hashPassword) {
    const email = String(this.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(this.env.PLATFORM_ADMIN_PASSWORD || '');
    if (!email || !password || (await this.adminCount())) return;
    await this.query(`INSERT INTO ${P}.admins (id, email, name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
      [`adm_${crypto.randomBytes(6).toString('hex')}`, email, String(this.env.PLATFORM_ADMIN_NAME || 'DubLow Digital'), hashPassword(password)]);
    console.log(`Created platform admin ${email} (from PLATFORM_ADMIN_PASSWORD)`);
  }

  // ---------- console sign-in rate limiting ----------
  async countAttempts(key, minutes = 15) {
    const { rows } = await this.query(`SELECT count(*)::int AS n FROM ${P}.login_attempts WHERE key = $1 AND at > now() - make_interval(mins => $2::int)`, [key, minutes]);
    return Number(rows[0].n);
  }

  async recordAttempt(key) {
    await this.query(`INSERT INTO ${P}.login_attempts (key) VALUES ($1)`, [key]);
    await this.query(`DELETE FROM ${P}.login_attempts WHERE at < now() - interval '1 day'`);
  }

  async clearAttempts(key) {
    await this.query(`DELETE FROM ${P}.login_attempts WHERE key = $1`, [key]);
  }

  // ---------- "Sign in as owner" ----------
  /** A one-time link token for a support session. Only its hash is stored; the link works for a few minutes. */
  async createSupportGrant({ tenantId, userId, admin, sessionMinutes }) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.query(
      `INSERT INTO ${P}.support_grants (token_hash, tenant_id, user_id, admin_id, admin_email, session_minutes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int))`,
      [sha256(token), tenantId, userId, admin.id, admin.email, sessionMinutes, GRANT_MINUTES],
    );
    await this.query(`DELETE FROM ${P}.support_grants WHERE expires_at < now() - interval '7 days'`);
    return { token, linkMinutes: GRANT_MINUTES };
  }

  /** Use a support link once, for this restaurant only. Returns { userId, adminEmail, sessionMinutes } or null. */
  async consumeSupportGrant(token, tenantId) {
    const { rows } = await this.query(
      `UPDATE ${P}.support_grants SET used_at = now()
        WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id, admin_id, admin_email, session_minutes`,
      [sha256(token || ''), tenantId],
    );
    const g = rows[0];
    if (!g) return null;
    await this.audit({ admin: { id: g.admin_id, email: g.admin_email }, action: 'support.signin', tenantId, details: { userId: g.user_id, minutes: g.session_minutes } });
    return { userId: g.user_id, adminEmail: g.admin_email, sessionMinutes: Number(g.session_minutes) };
  }

  // ---------- numbers for the console ----------
  /** Active staff and the time of the last change, from the restaurant's own schema (read-only). */
  async tenantStats(t) {
    const S = `"${t.schema_name}"`;
    try {
      const [staff, last] = await Promise.all([
        this.query(`SELECT count(*)::int AS n FROM ${S}.docs WHERE col = 'users' AND NOT deleted AND coalesce(data ->> 'active', 'true') <> 'false'`),
        this.query(`SELECT updated_at FROM ${S}.docs ORDER BY seq DESC LIMIT 1`),
      ]);
      return { staff: Number(staff.rows[0].n), lastActivity: iso(last.rows[0]?.updated_at) };
    } catch (e) {
      if (e.code === '42P01' || e.code === '3F000') return { staff: 0, lastActivity: null }; // not created yet
      throw e;
    }
  }
}
