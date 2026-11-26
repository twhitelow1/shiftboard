// AI usage: every call metered, per restaurant.
//
// Two records of the same calls:
//   * The ledger, <schema>.ai_usage: one row per API call (restaurant, person id, purpose, model, tokens, estimated
//     cost, who pays, ok or the error's code). On the platform <schema> is `platform` (every restaurant's rows
//     together, tagged with the restaurant), on a single-restaurant install the restaurant's own schema, like
//     server/errors.js. The DubLow console reads it. Never a prompt, a reply or anything people typed.
//   * The meter, in the restaurant's own store (collection aiUsage): this month's totals (DubLow-paid and own-key
//     dollars, per person, per purpose, whether the 80% warning went out) and each person's messages today. It's
//     what the caps check (synchronously, from the synced store) and what Settings → Ask ShiftBoard shows.
import { todayStr } from '../../core/time.js';

export const METER = 'aiUsage';
const KEEP_DAYS = 3; // per-person day counters kept (today's is the one that counts)

const round6 = (v) => Math.round(Number(v || 0) * 1_000_000) / 1_000_000;
/** The restaurant's day and month (the process runs in the restaurant's time zone: server/tz.js). */
export const dayOf = (ms) => todayStr(new Date(ms));
export const monthOf = (ms) => dayOf(ms).slice(0, 7);

// ---------- the meter (restaurant store) ----------
const monthId = (month) => `month:${month}`;
const dayId = (day, userId) => `day:${day}:${userId}`;

/** This month's totals: { month, platformUsd, ownUsd, calls, errors, users: { id: { usd, calls, messages } }, purposes, warnedAt }. */
export function monthMeter(store, month) {
  const d = store.get(METER, monthId(month)) || {};
  return {
    month, platformUsd: round6(d.platformUsd), ownUsd: round6(d.ownUsd), calls: d.calls || 0, errors: d.errors || 0,
    users: d.users || {}, purposes: d.purposes || {}, warnedAt: d.warnedAt || null,
  };
}

/** Messages someone sent the assistant today. */
export const messagesToday = (store, day, userId) => store.get(METER, dayId(day, userId))?.messages || 0;

/** Add one API call to the month (inside a write). Returns the month as it is after. */
export function meterCall(store, { month, userId, purpose, usd, billedTo, ok }) {
  const cur = store.get(METER, monthId(month));
  const d = cur || { id: monthId(month), month, platformUsd: 0, ownUsd: 0, calls: 0, errors: 0, users: {}, purposes: {} };
  const key = billedTo === 'own' ? 'ownUsd' : 'platformUsd';
  const users = { ...d.users };
  if (userId) users[userId] = { usd: round6((users[userId]?.usd || 0) + usd), calls: (users[userId]?.calls || 0) + 1, messages: users[userId]?.messages || 0 };
  const patch = {
    [key]: round6((d[key] || 0) + usd), calls: (d.calls || 0) + 1, errors: (d.errors || 0) + (ok ? 0 : 1), users,
    purposes: { ...d.purposes, [purpose]: round6((d.purposes?.[purpose] || 0) + usd) },
  };
  if (cur) store.update(METER, d.id, patch); else store.insert(METER, { ...d, ...patch });
  return monthMeter(store, month);
}

/** Count one message from someone (inside a write); old day counters are dropped. */
export function meterMessage(store, { day, month, userId }) {
  const id = dayId(day, userId);
  const cur = store.get(METER, id);
  if (cur) store.update(METER, id, { messages: (cur.messages || 0) + 1 }); else store.insert(METER, { id, day, userId, messages: 1 });
  const m = store.get(METER, monthId(month));
  const users = { ...(m?.users || {}) };
  users[userId] = { usd: users[userId]?.usd || 0, calls: users[userId]?.calls || 0, messages: (users[userId]?.messages || 0) + 1 };
  if (m) store.update(METER, m.id, { users }); else store.insert(METER, { id: monthId(month), month, platformUsd: 0, ownUsd: 0, calls: 0, errors: 0, users, purposes: {} });
  const oldest = new Date(`${day}T12:00:00`);
  oldest.setDate(oldest.getDate() - KEEP_DAYS);
  const cutoff = todayStr(oldest);
  for (const old of store.list(METER, (x) => x.id.startsWith('day:') && x.day < cutoff)) store.remove(METER, old.id);
}

/** Mark this month's 80% warning as sent; false when it already was. */
export function markWarned(store, month, at) {
  const m = store.get(METER, monthId(month));
  if (!m || m.warnedAt) return false;
  store.update(METER, m.id, { warnedAt: at });
  return true;
}

// ---------- the ledger (SQL) ----------
const tables = (S) => [
  `CREATE TABLE IF NOT EXISTS ${S}.ai_usage (
     id                 bigserial     PRIMARY KEY,
     at                 timestamptz   NOT NULL,
     month              text          NOT NULL,
     tenant_id          text,
     user_id            text,
     purpose            text          NOT NULL,
     model              text          NOT NULL,
     input_tokens       integer       NOT NULL DEFAULT 0,
     output_tokens      integer       NOT NULL DEFAULT 0,
     cache_read_tokens  integer       NOT NULL DEFAULT 0,
     cache_write_tokens integer       NOT NULL DEFAULT 0,
     cost_usd           numeric(12,6) NOT NULL DEFAULT 0,
     billed_to          text          NOT NULL DEFAULT 'platform',
     ok                 boolean       NOT NULL DEFAULT true,
     error              text          NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS ai_usage_tenant_month_idx ON ${S}.ai_usage (tenant_id, month)`,
  `ALTER TABLE ${S}.ai_usage ENABLE ROW LEVEL SECURITY`,
];
const clean = (s, max) => String(s ?? '').replace(/[^\w.:-]/g, '').slice(0, max);

/**
 * The usage ledger on one schema ('platform', or a single install's own).
 * @param o.conn  pg.Pool or the PGlite adapter
 */
export class UsageLog {
  constructor({ conn, schema }) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Not a usable schema name: ${schema}`);
    this.conn = conn;
    this.schema = schema;
    this.S = `"${schema}"`;
    this.ready = null;
  }

  ensure() {
    this.ready ??= (async () => {
      const { rows } = await this.conn.query(`SELECT to_regclass('${this.schema}.ai_usage') AS t`);
      if (rows[0]?.t) return;
      const client = await this.conn.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shiftboard-ai-usage:${this.schema}`]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.S}`);
        for (const sql of tables(this.S)) await client.query(sql);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  /** One API call. row: { at, month, tenantId, userId, purpose, model, tokens, costUsd, billedTo, ok, error }. */
  async insert(row) {
    await this.ensure();
    const t = row.tokens || {};
    await this.conn.query(
      `INSERT INTO ${this.S}.ai_usage (at, month, tenant_id, user_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, billed_to, ok, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [row.at, row.month, row.tenantId ? clean(row.tenantId, 64) : null, row.userId ? clean(row.userId, 64) : null, clean(row.purpose, 40) || 'other',
        clean(row.model, 60), t.inputTokens || 0, t.outputTokens || 0, t.cacheReadTokens || 0, t.cacheWriteTokens || 0, round6(row.costUsd),
        row.billedTo === 'own' ? 'own' : 'platform', row.ok !== false, clean(row.error, 60)],
    );
  }

  /** Each restaurant's month: [{ tenantId, platformUsd, ownUsd, calls, errors, tokens }]. */
  async byTenant(month) {
    await this.ensure();
    const { rows } = await this.conn.query(
      `SELECT tenant_id,
              coalesce(sum(cost_usd) FILTER (WHERE billed_to = 'platform'), 0)::float8 AS platform_usd,
              coalesce(sum(cost_usd) FILTER (WHERE billed_to = 'own'), 0)::float8 AS own_usd,
              count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS errors,
              coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::float8 AS tokens
         FROM ${this.S}.ai_usage WHERE month = $1 GROUP BY tenant_id`, [month]);
    return rows.map((r) => ({ tenantId: r.tenant_id, platformUsd: round6(r.platform_usd), ownUsd: round6(r.own_usd), calls: r.calls, errors: r.errors, tokens: Number(r.tokens) }));
  }

  /** The rows of one restaurant's month, newest first (tests and support; no content is ever in them). */
  async rows({ tenantId = null, month = null, limit = 200 } = {}) {
    await this.ensure();
    const { rows } = await this.conn.query(
      `SELECT * FROM ${this.S}.ai_usage WHERE ($1::text IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR month = $2) ORDER BY id DESC LIMIT $3`,
      [tenantId, month, Math.min(1000, Number(limit) || 200)]);
    return rows.map((r) => ({ ...r, cost_usd: Number(r.cost_usd), at: new Date(r.at).toISOString() }));
  }

  /** A ledger for one restaurant: everything it records is tagged with it. */
  forTenant(tenant) {
    const tenantId = tenant?.id || null;
    return { log: this, tenantId, record: (row) => this.insert({ ...row, tenantId }), rows: (o = {}) => this.rows({ ...o, tenantId }) };
  }
}

// A single install's ledger, one per schema (several apps on one database in tests).
const local = new Map();
export function localUsageLog(db) {
  const key = db.schema;
  if (!local.has(key) || local.get(key).conn !== db.conn) local.set(key, new UsageLog({ conn: db.conn, schema: db.schema }).forTenant(null));
  return local.get(key);
}
