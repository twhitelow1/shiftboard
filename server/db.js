// Postgres persistence (Supabase, Neon, or any Postgres 13+).
//
// ShiftBoard's business logic (core/service.js) is synchronous and works on an in-memory
// document store. On a long-running server that was enough: load everything at boot and
// write through. On Vercel there can be many short-lived instances at once, so each one
// keeps a cache that it brings up to date before every request:
//
//   * Every document is a row in shiftboard.docs with a global, ever-increasing `seq`.
//   * Before a request, the instance pulls rows with seq > the last one it saw (usually
//     zero rows: one cheap indexed query).
//   * Reads run against that fresh cache.
//   * Writes run inside one transaction that holds a single advisory lock. Under the
//     lock the instance syncs again, re-runs the operation, and upserts every change in
//     one statement. Because writers are serialized, seq order matches commit order, and
//     check-then-act operations (two people grabbing the same open shift) stay correct
//     across instances.
//
// The request runs against an OverlayStore, so a failed request never touches the cache.

import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { attachDatabasePool } from '@vercel/functions';
import { MemoryStore, OverlayStore } from '../core/store.js';

export const SCHEMA = 'shiftboard';
const SCHEMA_VERSION = '2';
const LOCK_KEY = 5_810_442_771; // any constant; identifies ShiftBoard's write lock

// The tables live in their own schema with row-level security on and no policies.
// ShiftBoard connects as the table owner (which bypasses RLS), while Supabase's public
// REST API roles (anon / authenticated) can't read anything, including password hashes.
const MIGRATIONS = [
  `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`,
  `CREATE SEQUENCE IF NOT EXISTS ${SCHEMA}.docs_seq`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA}.docs (
     col        text        NOT NULL,
     id         text        NOT NULL,
     data       jsonb,
     deleted    boolean     NOT NULL DEFAULT false,
     seq        bigint      NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (col, id)
   )`,
  `CREATE INDEX IF NOT EXISTS docs_seq_idx ON ${SCHEMA}.docs (seq)`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA}.meta (key text PRIMARY KEY, value text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA}.login_attempts (key text NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS login_attempts_key_at_idx ON ${SCHEMA}.login_attempts (key, at)`,
  // One-time links for setting/resetting a password. Only a hash of the token is stored.
  `CREATE TABLE IF NOT EXISTS ${SCHEMA}.auth_tokens (
     token_hash text        PRIMARY KEY,
     user_id    text        NOT NULL,
     purpose    text        NOT NULL,
     expires_at timestamptz NOT NULL,
     used_at    timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE ${SCHEMA}.docs ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${SCHEMA}.auth_tokens ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${SCHEMA}.meta ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${SCHEMA}.login_attempts ENABLE ROW LEVEL SECURITY`,
];

/**
 * Collections whose `data` field (an image's bytes, base64) stays in Postgres only. Every instance keeps
 * all documents in memory, so photos there would grow memory and cold starts with the photo library.
 * The cache keeps the rest of each document; routes read the bytes on demand with DocDb.lazyData.
 */
export const LAZY_DATA = ['menuPhotos', 'eightySixPhotos'];
const LAZY_SQL = `ARRAY[${LAZY_DATA.map((c) => `'${c}'`).join(',')}]::text[]`;

// A cached lazy document has no `data`; saving it again keeps the bytes already stored.
const UPSERT_DOCS = `
  INSERT INTO ${SCHEMA}.docs (col, id, data, deleted, seq, updated_at)
  SELECT t.c, t.i, t.d, t.x, nextval('${SCHEMA}.docs_seq'), now()
    FROM jsonb_to_recordset($1::text::jsonb) AS t(c text, i text, d jsonb, x boolean)
  ON CONFLICT (col, id) DO UPDATE
    SET data = CASE
          WHEN EXCLUDED.col = ANY(${LAZY_SQL}) AND NOT (EXCLUDED.data ? 'data') AND ${SCHEMA}.docs.data ? 'data'
            THEN EXCLUDED.data || jsonb_build_object('data', ${SCHEMA}.docs.data -> 'data')
          ELSE EXCLUDED.data END,
        deleted = EXCLUDED.deleted, seq = EXCLUDED.seq, updated_at = EXCLUDED.updated_at
  RETURNING col, id, seq`;

const docKey = (col, id) => `${col}\u0000${id}`;
// Postgres text can't hold NUL characters; drop them rather than fail the write.
const stripNul = (_k, v) => (typeof v === 'string' && v.includes('\u0000') ? v.replaceAll('\u0000', '') : v);

export class DocDb {
  /** @param conn anything with query(text, params) and connect() -> { query, release } (a pg.Pool, or the dev adapter) */
  constructor(conn) {
    this.conn = conn;
    this.store = new MemoryStore(); // committed state as of lastSeq; never holds uncommitted writes
    this.seqs = new Map(); // docKey -> seq of the version in the cache (tombstones included)
    this.lastSeq = 0;
  }

  query(text, params) {
    return this.conn.query(text, params);
  }

  async close() {
    await this.conn.end?.();
  }

  /** Create or upgrade the schema. Cheap when it's current (one SELECT). */
  async migrate() {
    try {
      const { rows } = await this.query(`SELECT value FROM ${SCHEMA}.meta WHERE key = 'schema_version'`);
      if (rows[0]?.value === SCHEMA_VERSION) return;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '3F000') throw e; // undefined table / schema: first run
    }
    await this.withLock(async (client) => {
      for (const sql of MIGRATIONS) await client.query(sql);
      await client.query(
        `INSERT INTO ${SCHEMA}.meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [SCHEMA_VERSION],
      );
    });
  }

  /** Read a meta value, creating it with make() if it doesn't exist yet (race-safe). */
  async ensureMeta(key, make) {
    const read = async () => (await this.query(`SELECT value FROM ${SCHEMA}.meta WHERE key = $1`, [key])).rows[0]?.value;
    const existing = await read();
    if (existing != null) return existing;
    await this.query(`INSERT INTO ${SCHEMA}.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, make()]);
    return read();
  }

  /** Pull every document changed since the last sync into the cache. */
  async sync(client = this.conn) {
    const since = this.lastSeq;
    const { rows } = await client.query(
      `SELECT col, id, CASE WHEN col = ANY(${LAZY_SQL}) THEN data - 'data' ELSE data END AS data, deleted, seq
         FROM ${SCHEMA}.docs WHERE seq > $1::bigint${since ? '' : ' AND NOT deleted'} ORDER BY seq`,
      [since],
    );
    let max = since;
    for (const r of rows) {
      const seq = Number(r.seq);
      this._apply(r.col, r.id, r.deleted ? null : r.data, seq);
      if (seq > max) max = seq;
    }
    if (max > this.lastSeq) this.lastSeq = max;
  }

  // Apply one committed version. Syncs can overlap within an instance, so only accept
  // a version newer than the one already cached.
  _apply(col, id, doc, seq) {
    const k = docKey(col, id);
    if (seq <= (this.seqs.get(k) || 0)) return;
    this.seqs.set(k, seq);
    if (doc && LAZY_DATA.includes(col) && 'data' in doc) { const { data: _bytes, ...rest } = doc; doc = rest; }
    if (doc) this.store.col(col).set(id, doc);
    else this.store.col(col).delete(id);
  }

  /** The `data` field of a lazy document (see LAZY_DATA), read straight from Postgres, or null. */
  async lazyData(col, id) {
    if (!LAZY_DATA.includes(col)) throw new Error(`${col} isn't a lazy collection`);
    const { rows } = await this.query(`SELECT data ->> 'data' AS d FROM ${SCHEMA}.docs WHERE col = $1 AND id = $2 AND NOT deleted`, [col, id]);
    return rows[0]?.d ?? null;
  }

  /** Run fn(client) in a transaction holding ShiftBoard's write lock. */
  async withLock(fn) {
    const client = await this.conn.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
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

  /** Upsert changes ({ col, id, doc|null }) inside a withLock transaction. Returns [{ col, id, seq }]. */
  async writeDocs(client, changes) {
    // A delete of something that was never stored (created and removed in one request) is a no-op.
    const rows = changes.filter((c) => c.doc || this.store.col(c.col).has(c.id));
    if (!rows.length) return [];
    const payload = JSON.stringify(rows.map((c) => ({ c: c.col, i: c.id, d: c.doc, x: !c.doc })), stripNul);
    return (await client.query(UPSERT_DOCS, [payload])).rows;
  }

  /**
   * Run fn(store) against an up-to-date view of the data and persist whatever it writes.
   *  write: false  -> try it without the lock first; if it turns out to write, redo it under the lock.
   *  write: true   -> go straight to the lock.
   *  synced: true  -> the caller already synced this request; skip the first sync.
   *  onCommit(changes) -> called once after a successful commit with every change
   *                       ({ col, id, doc, isNew }); use it for side effects such as email.
   * fn must be synchronous and free of side effects outside the store (it may run twice).
   */
  async run(fn, { write = false, synced = false, onCommit } = {}) {
    if (!write) {
      if (!synced) await this.sync();
      const view = new OverlayStore(this.store);
      const result = fn(view);
      if (!view.dirty) return result;
    }
    let changes = [];
    let written = [];
    const result = await this.withLock(async (client) => {
      await this.sync(client);
      const view = new OverlayStore(this.store);
      const out = fn(view);
      // isNew is decided here, while the cache still shows the state before this write.
      changes = view.changeList().map((c) => ({ ...c, isNew: !!c.doc && !this.store.col(c.col).has(c.id) }));
      written = await this.writeDocs(client, changes);
      return out;
    });
    // Committed: put the new versions in the cache. Writers are serialized and this one
    // synced under the lock, so every seq up to its last write is now in the cache.
    const seqOf = new Map(written.map((r) => [docKey(r.col, r.id), Number(r.seq)]));
    let max = 0;
    for (const c of changes) {
      const seq = seqOf.get(docKey(c.col, c.id));
      if (seq == null) continue;
      this._apply(c.col, c.id, c.doc, seq);
      if (seq > max) max = seq;
    }
    if (max > this.lastSeq) this.lastSeq = max;
    if (onCommit && changes.length) {
      try { onCommit(changes); } catch (e) { console.error('onCommit failed:', e); }
    }
    return result;
  }

  // ----- one-time password links (invite / reset) -----
  /** Create a link token for a user. Returns the raw token (only its hash is stored). */
  async createToken(userId, purpose, minutes) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await this.query(
      `INSERT INTO ${SCHEMA}.auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))`,
      [hash, userId, purpose, minutes],
    );
    await this.query(`DELETE FROM ${SCHEMA}.auth_tokens WHERE expires_at < now() - interval '7 days'`);
    return token;
  }

  /** Use a token once. Returns { userId, purpose } or null if it's unknown, used or expired. */
  async consumeToken(token) {
    const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    const { rows } = await this.query(
      `UPDATE ${SCHEMA}.auth_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, purpose`,
      [hash],
    );
    return rows[0] ? { userId: rows[0].user_id, purpose: rows[0].purpose } : null;
  }

  /** Cancel a user's outstanding links (after a password change). */
  async revokeTokens(userId) {
    await this.query(`UPDATE ${SCHEMA}.auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  }

  // ----- login rate limiting (shared across instances) -----
  async countAttempts(key, minutes = 15) {
    const { rows } = await this.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.login_attempts WHERE key = $1 AND at > now() - make_interval(mins => $2::int)`,
      [key, minutes],
    );
    return Number(rows[0].n);
  }

  async recordAttempt(key) {
    await this.query(`INSERT INTO ${SCHEMA}.login_attempts (key) VALUES ($1)`, [key]);
    await this.query(`DELETE FROM ${SCHEMA}.login_attempts WHERE at < now() - interval '1 day'`);
  }

  async clearAttempts(key) {
    await this.query(`DELETE FROM ${SCHEMA}.login_attempts WHERE key = $1`, [key]);
  }
}

// ---------- connections ----------

/** The connection string from the environment. Vercel's Supabase integration sets POSTGRES_URL; Neon sets DATABASE_URL. */
export function databaseUrl(env = process.env) {
  return env.DATABASE_URL || env.POSTGRES_URL || '';
}

/**
 * pg options from a connection URL, with libpq's sslmode meaning:
 *   disable -> no TLS; require (the default for remote hosts) -> TLS without certificate checks;
 *   verify-ca / verify-full, or DATABASE_CA_CERT set -> TLS with certificate checks.
 * (pg alone treats sslmode=require as verify-full, which rejects Supabase's pooler certificate.)
 */
export function pgOptions(url, env = process.env) {
  const u = new URL(url);
  const mode = (u.searchParams.get('sslmode') || env.PGSSLMODE || '').toLowerCase();
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'uselibpqcompat', 'supa', 'pgbouncer', 'connection_limit']) {
    u.searchParams.delete(k);
  }
  const local = !u.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const ca = env.DATABASE_CA_CERT ? env.DATABASE_CA_CERT.replace(/\\n/g, '\n') : undefined;
  let ssl;
  if (mode === 'disable' || (!mode && local)) ssl = false;
  else if (ca || mode === 'verify-ca' || mode === 'verify-full') ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  else ssl = { rejectUnauthorized: false };
  return { connectionString: u.toString(), ssl };
}

function pgPool(url, env) {
  const pool = new pg.Pool({
    ...pgOptions(url, env),
    max: Number(env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (e) => console.error('Postgres connection error:', e.message));
  if (env.VERCEL) attachDatabasePool(pool); // close idle connections before Fluid compute suspends
  return pool;
}

// Local development without DATABASE_URL: an embedded Postgres (PGlite) stored in ./data/pglite.
function devPglite(dir) {
  let ready;
  const get = () => (ready ??= import('./pglite.js').then((m) => m.openPglite(dir)));
  return {
    query: async (text, params) => (await get()).query(text, params),
    connect: async () => (await get()).connect(),
    end: async () => { if (ready) await (await ready).end(); },
  };
}

// No database configured where one is required: fail every query with an actionable message.
function missingDatabase() {
  const err = () => Promise.reject(new Error(
    'No database configured. Set DATABASE_URL (or POSTGRES_URL) to a Postgres connection string. '
    + 'On Vercel: Project → Storage → connect a Supabase (or Neon) database, then redeploy.',
  ));
  return { query: err, connect: err, end: async () => {} };
}

export function openConnection(env = process.env) {
  const url = databaseUrl(env);
  if (url) return pgPool(url, env);
  if (env.VERCEL || env.NODE_ENV === 'production') return missingDatabase();
  const dir = env.PGLITE_DIR || path.join(env.DATA_DIR || 'data', 'pglite');
  console.log(`No DATABASE_URL set. Using the embedded development database in ${dir}`);
  return devPglite(dir);
}

export function createDatabase(env = process.env) {
  return new DocDb(openConnection(env));
}
