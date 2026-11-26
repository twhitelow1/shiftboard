// Beta error tracking: errors from the server, the web app, the console and the phone app, and "Report a problem"
// reports, in one place DubLow Digital reads (the console's Errors & reports page, server/platform/errors-console.js).
//
//   <schema>.errors        one row per fingerprint (repeats are grouped): kind, status, a sample stack, the
//                          restaurants and people it hit (ids only), the app versions, count, first and last seen
//   <schema>.error_events  each occurrence (the last 200 per fingerprint): when, restaurant, user id, route,
//                          app version, page, device, and allowlisted context (a report's attached details)
//   <schema>.error_files   a report's screenshot (base64), one per occurrence
//
// On the platform <schema> is `platform` (every restaurant's errors together, tagged with the restaurant);
// a single-restaurant install keeps them in its own schema. Nothing here may break a request: recording runs
// after the response, every failure is logged and dropped, and a flood is capped per instance.
//
// What's kept is allowlisted and scrubbed (scrubText): no request bodies, passwords, tokens, secrets, cookies,
// email addresses or phone numbers; user ids, never emails or names. See docs/BETA-TESTING.md.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')}${path.sep}`; // this checkout
export const STATUSES = ['new', 'acknowledged', 'fixed', 'ignored'];
export const KINDS = ['server', 'browser', 'phone', 'report'];
export const SOURCES = ['rpc', 'route', 'cron', 'sync', 'window', 'promise', 'boundary', 'global', 'console', 'report'];

const EVENTS_KEPT = 200; // occurrences kept per fingerprint
const USERS_KEPT = 500; // distinct people counted per fingerprint
const VERSIONS_KEPT = 20;
const ALERT_EVERY_MS = 3_600_000; // at most one alert email per fingerprint per hour
const ALERTS_PER_HOUR = 20; // and at most this many alert emails an hour in all (the digest covers the rest)
const RECORDS_PER_MINUTE = 300; // per instance: a flood of errors can't flood the database
const KEEP_EVENTS_DAYS = 90;
const KEEP_FILES_DAYS = 60;

// ---------- scrubbing ----------
const SECRET_WORDS = 'password|passwd|pwd|passcode|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|authorization|cookie|ticket|otp|totp|session|signature|private[_-]?key|client[_-]?secret|credential';
const RULES = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '[pem]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [new RegExp(`((?:${SECRET_WORDS})["']?\\s*[:=]\\s*["']?)[^\\s"'&,;)}\\]]+`, 'gi'), '$1[redacted]'],
  [/\b(password|passcode|passwd|pass|contraseña|clave|pin)\b(\s+(?:is|es|was|era|=)\s+)["']?[^\s"',;]+/gi, '$1$2[redacted]'],
  [/([?&#;](?:token|code|ticket|key|secret|password|sig|signature|auth|session|state|otp)=)[^&#\s"']+/gi, '$1[redacted]'],
  [/(\/api\/(?:ical\/[^/\s]+|tripleseat\/webhook)\/)[^/\s?#"')]+/g, '$1[redacted]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi, '[email]'],
  [/\b(?:sk|pk|rk|re|whsec|key|tok)_[A-Za-z0-9_]{12,}/g, '[key]'],
  [/\b(?:AC|SK|MG)[0-9a-f]{32}\b/g, '[key]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[long]'],
];
// Phone and card-like numbers: messages only (a stack's line:column numbers aren't personal).
const NUMBER_RULES = [
  [/(?<![\w:.])\+?\d[\d\s().-]{8,16}\d(?![\w:])/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[number]' : m)],
];

/** Text with secrets, tokens, emails and phone numbers taken out, cut to max. */
export function scrubText(s, max = 500, { numbers = true } = {}) {
  let out = String(s ?? '').replace(/\u0000/g, '');
  if (out.length > max * 4) out = out.slice(0, max * 4);
  for (const [re, to] of RULES) out = out.replace(re, to);
  if (numbers) for (const [re, to] of NUMBER_RULES) out = out.replace(re, to);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** A file in a stack frame without where it lives: repo-relative paths, no origin, no query, no build hash. */
export function cleanFile(file) {
  let f = String(file || '').trim();
  f = f.replace(/^address at /, '');
  let url = false;
  try { if (/^(https?|blob|webpack|app):\/\//i.test(f)) { f = new URL(f).pathname; url = true; } } catch { /* not a URL */ }
  f = f.replace(/^file:\/\//, '').replace(/[?#].*$/, '');
  if (url) f = f.replace(/^\/+/, '');
  else if (f.startsWith(ROOT)) f = f.slice(ROOT.length);
  else if (/^(\/|[A-Za-z]:\\)/.test(f)) {
    // Somewhere else on a server (/var/task/…): from the project's own folders on, else the last two parts.
    const m = /[/\\]((?:server|core|web|api|mobile|test|scripts|node_modules)[/\\].*)$/.exec(f.replace(/^.*?(?=[/\\](?:server|core|web|api|mobile|test|scripts|node_modules)[/\\])/, ''));
    f = m ? m[1] : f.split(/[/\\]/).slice(-2).join('/');
  }
  // index-B2x9Kq_a.js → index.js, entry-0123456789abcdef0123.js → entry.js
  f = f.replace(/[-.](?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{6,32}(?=\.(?:m?js|css|bundle)$)/, '');
  return f.slice(0, 160);
}

/** Stack frames: V8 ("at fn (file:1:2)"), Firefox and Safari ("fn@file:1:2"), Hermes ("at fn (address at file:1:2)"). */
export function parseFrames(stack) {
  const frames = [];
  for (const raw of String(stack || '').split('\n').slice(0, 60)) {
    const line = raw.trim();
    let m = /^at (?:(.+?) \()?(?:address at )?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) {
      const v = /^at (?:(.+?) \()?(?:address at )?([^()]+?)\)?$/.exec(line); // "at fn (native)", "at file"
      if (v) m = [line, v[1], v[2], '', ''];
    }
    if (!m) {
      const g = /^([^@\s]*)@(.+?):(\d+):(\d+)$/.exec(line);
      if (g) m = g;
    }
    if (m) frames.push({ fn: (m[1] || '').replace(/^async /, '').slice(0, 80), file: m[2], line: Number(m[3]) || 0, col: Number(m[4]) || 0 });
  }
  return frames;
}
const internal = (f) => /^(node:|internal\/)|\(?native\)?$|^\[native code\]$/.test(f.file) || f.file === 'native' || f.file === '<anonymous>';

/** The first frame that's ours (not Node's internals): { key for the fingerprint, text to show }. */
export function topFrame(stack) {
  const f = parseFrames(stack).find((x) => !internal(x));
  if (!f) return { key: '', text: '' };
  const file = cleanFile(f.file);
  const fn = f.fn || '<anonymous>';
  return { key: `${fn} (${file})`, text: `${fn} (${file}${f.line ? `:${f.line}${f.col ? `:${f.col}` : ''}` : ''})` };
}

/** A stack that's safe to keep: scrubbed, paths cleaned, at most 40 frames. */
export function cleanStack(stack, max = 6000) {
  const lines = String(stack || '').split('\n').slice(0, 45);
  const out = lines.map((l) => {
    const frame = /^(\s*at [^(]*\()(.+?)(:\d+:\d+)?(\))\s*$/.exec(l) || /^(\s*at )([^\s(][^()]*?)(:\d+:\d+)?()\s*$/.exec(l)
      || /^(\s*[^@\s]*@)(.+?)(:\d+:\d+)?()\s*$/.exec(l);
    if (frame && /[/\\:.]/.test(frame[2])) return scrubText(`${frame[1]}${cleanFile(frame[2])}${frame[3] || ''}${frame[4] || ''}`, 300, { numbers: false });
    return scrubText(l, 400);
  });
  const s = out.join('\n');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The message as grouped: ids, numbers and long values replaced, so "shift 42 not found" and "shift 43…" match. */
export function normalizeMessage(m) {
  return scrubText(m, 300)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[a-z]{2,8}_[A-Za-z0-9]{4,}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, '<date>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The fingerprint: the first 16 hex digits of sha256(kind | error name | normalized message | top frame), where
 * the top frame is "function (file)" without line and column, so a deploy that moves code doesn't start a new group.
 * Errors without a stack (sync and cron failures, HTTP 500s nothing explained) use their source and route instead.
 */
export function fingerprintOf({ kind, source = '', name = '', message = '', stack = '', route = '' }) {
  const top = topFrame(stack).key || `${source}:${route || ''}`;
  const fpMessage = normalizeMessage(message);
  const hash = crypto.createHash('sha256').update([kind, name || '', fpMessage, top].join('|')).digest('hex').slice(0, 16);
  return { fingerprint: hash, fpMessage, top };
}

/** A path without ids or tokens: /api/users/usr_x1/invite → /api/users/:id/invite; #/events/evt_1 → #/events/:id. */
export function cleanPath(p, max = 200) {
  let s = String(p || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const hash = s.indexOf('#');
  const [path, frag] = hash >= 0 ? [s.slice(0, hash), s.slice(hash + 1)] : [s, ''];
  const seg = (x) => x.split('?')[0].split('/').map((part) => {
    if (!part) return part;
    if (/^[a-z]{2,8}_[A-Za-z0-9_-]{3,}$/.test(part) || /\d/.test(part) && part.length >= 6 || part.length > 40 || /^\d+$/.test(part)) return ':id';
    return part.replace(/[^\w.:@-]/g, '').slice(0, 40);
  }).join('/');
  s = seg(path) + (hash >= 0 ? `#${seg(frag)}` : '');
  return s.slice(0, max);
}

/** "Chrome 131 · Android", "Safari 18 · iPhone", "ShiftBoard app 1.0.3 · iOS 18.1 · iPhone 15": no full user agent. */
export function deviceOf(ua = '', d = null) {
  const parts = [];
  if (d && typeof d === 'object') {
    const plat = { ios: 'iOS', android: 'Android', web: 'Browser' }[String(d.platform || '').toLowerCase()];
    if (plat) {
      parts.push(`${d.app === 'app-web' ? 'Phone app (browser)' : 'Phone app'}${/^[\w.+-]{1,24}$/.test(String(d.appVersion || '')) ? ` ${d.appVersion}` : ''}`);
      if (plat !== 'Browser') parts.push(`${plat}${/^[\w.]{1,16}$/.test(String(d.osVersion || '')) ? ` ${d.osVersion}` : ''}`);
      const model = String(d.model || '').replace(/[^\w ,.()+-]/g, '').trim().slice(0, 40);
      if (model) parts.push(model);
    }
  }
  const s = String(ua);
  if (s && (!parts.length || /^Phone app \(browser\)/.test(parts[0]))) {
    const b = /Edg\/(\d+)/.exec(s) ? `Edge ${/Edg\/(\d+)/.exec(s)[1]}`
      : /SamsungBrowser\/(\d+)/.exec(s) ? `Samsung Internet ${/SamsungBrowser\/(\d+)/.exec(s)[1]}`
        : /(?:Chrome|CriOS)\/(\d+)/.exec(s) ? `Chrome ${/(?:Chrome|CriOS)\/(\d+)/.exec(s)[1]}`
          : /(?:Firefox|FxiOS)\/(\d+)/.exec(s) ? `Firefox ${/(?:Firefox|FxiOS)\/(\d+)/.exec(s)[1]}`
            : /Version\/(\d+)[\d.]* .*Safari/.exec(s) ? `Safari ${/Version\/(\d+)/.exec(s)[1]}`
              : /okhttp|Expo|CFNetwork|Darwin/i.test(s) ? '' : 'Other browser';
    const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet')
      : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : '';
    for (const x of [b, os]) if (x) parts.push(x);
  }
  return parts.join(' · ').slice(0, 120);
}

export const versionOf = (env = process.env) => String(env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev';
const cleanVersion = (v) => (/^[\w.+-]{1,40}$/.test(String(v || '')) ? String(v) : '');

// ---------- storage ----------
const tables = (S) => [
  `CREATE TABLE IF NOT EXISTS ${S}.errors (
     id            text        PRIMARY KEY,
     fingerprint   text        NOT NULL UNIQUE,
     kind          text        NOT NULL,
     source        text        NOT NULL DEFAULT '',
     status        text        NOT NULL DEFAULT 'new',
     name          text        NOT NULL DEFAULT '',
     message       text        NOT NULL DEFAULT '',
     fp_message    text        NOT NULL DEFAULT '',
     top_frame     text        NOT NULL DEFAULT '',
     stack         text        NOT NULL DEFAULT '',
     route         text        NOT NULL DEFAULT '',
     method        text        NOT NULL DEFAULT '',
     http_status   integer,
     tenants       text[]      NOT NULL DEFAULT '{}',
     users         text[]      NOT NULL DEFAULT '{}',
     versions      text[]      NOT NULL DEFAULT '{}',
     last_version  text        NOT NULL DEFAULT '',
     count         integer     NOT NULL DEFAULT 0,
     first_seen    timestamptz NOT NULL,
     last_seen     timestamptz NOT NULL,
     last_alert_at timestamptz,
     alerts        integer     NOT NULL DEFAULT 0,
     status_at     timestamptz,
     status_by     text,
     fixed_in      text,
     report        jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS errors_last_seen_idx ON ${S}.errors (last_seen DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.error_events (
     id          bigserial   PRIMARY KEY,
     error_id    text        NOT NULL REFERENCES ${S}.errors(id) ON DELETE CASCADE,
     at          timestamptz NOT NULL,
     tenant_id   text,
     user_id     text,
     route       text        NOT NULL DEFAULT '',
     method      text        NOT NULL DEFAULT '',
     version     text        NOT NULL DEFAULT '',
     page        text        NOT NULL DEFAULT '',
     device      text        NOT NULL DEFAULT '',
     http_status integer,
     context     jsonb       NOT NULL DEFAULT '{}'::jsonb,
     has_file    boolean     NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS error_events_error_idx ON ${S}.error_events (error_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS error_events_at_idx ON ${S}.error_events (at)`,
  `CREATE TABLE IF NOT EXISTS ${S}.error_files (
     event_id   bigint      PRIMARY KEY REFERENCES ${S}.error_events(id) ON DELETE CASCADE,
     mime       text        NOT NULL,
     data       text        NOT NULL,
     created_at timestamptz NOT NULL
   )`,
  ...['errors', 'error_events', 'error_files'].map((t) => `ALTER TABLE ${S}.${t} ENABLE ROW LEVEL SECURITY`),
];

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND_LABEL = { server: 'Server', browser: 'Browser', phone: 'Phone app', report: 'Report' };

/**
 * The error log on one schema.
 * @param {object} o
 * @param o.conn      pg.Pool or the PGlite adapter
 * @param {string} o.schema  'platform', or a restaurant's schema on a single-restaurant install
 * @param {object} [o.env]   PLATFORM_ADMIN_EMAIL (alerts and the digest), PLATFORM_ALERT_PHONE (texts), VERCEL_GIT_COMMIT_SHA
 * @param {object} [o.mailer]  server/email.js mailer (From: PLATFORM_EMAIL_FROM)
 * @param {object} [o.texter]  server/sms.js texter
 * @param {Function} [o.now]   clock in ms
 * @param {Function} [o.consoleUrl]  (errorId?) => the console's page for it, for links in alerts
 * @param {Function} [o.tenantName]  (id) => the restaurant's name, for alerts and the digest
 * @param {Function} [o.background]  (promise) => keep the function alive for it (Vercel waitUntil)
 */
export class ErrorLog {
  constructor({ conn, schema, env = process.env, mailer = null, texter = null, now = () => Date.now(), consoleUrl = () => '', tenantName = (id) => id, background = null }) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Not a usable schema name: ${schema}`);
    this.conn = conn;
    this.S = `"${schema}"`;
    this.schema = schema;
    this.env = env;
    this.mailer = mailer;
    this.texter = texter;
    this.now = now;
    this.consoleUrl = consoleUrl;
    this.tenantName = tenantName;
    this.version = versionOf(env);
    this.pending = new Set();
    this.keepAlive = background;
    this.window = { at: 0, n: 0, dropped: 0 };
    this.ready = null;
  }

  /** Create the tables (once per instance; a cheap check after the first time on any instance). */
  ensure() {
    this.ready ??= (async () => {
      const { rows } = await this.conn.query(`SELECT to_regclass('${this.schema}.error_files') AS t`);
      if (rows[0]?.t) return;
      const client = await this.conn.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shiftboard-errors:${this.schema}`]);
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

  /** Work that finishes after the response; never rejects. */
  track(promise) {
    const p = Promise.resolve(promise).catch((e) => logQuietly('Error tracking failed:', e)).finally(() => this.pending.delete(p));
    this.pending.add(p);
    if (this.keepAlive) try { this.keepAlive(p); } catch { /* not on Vercel */ }
    return p;
  }
  /** For tests and shutdown: everything recorded so far is saved (and alerted). */
  async settled() { while (this.pending.size) await Promise.all([...this.pending]); }

  /** A recorder for one restaurant: everything it records is tagged with it. */
  forTenant(tenant) {
    const t = tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null;
    return {
      log: this,
      tenant: t,
      record: (ev) => this.capture({ ...ev, tenant: ev.tenant ?? t }),
      report: (ev) => this.report({ ...ev, tenant: ev.tenant ?? t }),
      settled: () => this.settled(),
    };
  }

  /** Record in the background (never throws, never waits): the usual way to log an error. */
  capture(ev) {
    const n = this.now();
    if (n - this.window.at > 60_000) {
      if (this.window.dropped) logQuietly(`Error tracking: dropped ${this.window.dropped} errors in a flood`);
      this.window = { at: n, n: 0, dropped: 0 };
    }
    if (++this.window.n > RECORDS_PER_MINUTE) { this.window.dropped++; return null; }
    return this.track(this.record(ev));
  }

  /**
   * Save one occurrence, grouped by fingerprint, and alert if it calls for one.
   * ev: { kind, source, name, message, stack, route, method, httpStatus, tenant: { id }, userId, version, page,
   *       device, context, report: { text, page }, file: { mime, data (base64) } }
   * Returns { id, inserted, status, alerted }.
   */
  async record(ev) {
    await this.ensure();
    const kind = KINDS.includes(ev.kind) ? ev.kind : 'server';
    const source = SOURCES.includes(ev.source) ? ev.source : '';
    const name = scrubText(ev.name || '', 60, { numbers: false }).replace(/[^\w$.: -]/g, '');
    const message = scrubText(ev.message || (kind === 'report' ? 'Report' : 'Unknown error'), 500);
    const stack = cleanStack(ev.stack || '');
    const route = cleanPath(ev.route || '', 120);
    const method = /^[A-Z]{3,7}$/.test(String(ev.method || '')) ? ev.method : '';
    const top = topFrame(ev.stack || '');
    const fp = ev.fingerprint ? { fingerprint: ev.fingerprint, fpMessage: normalizeMessage(message), top: top.key } : fingerprintOf({ kind, source, name, message, stack: ev.stack, route });
    const tenantId = ev.tenant?.id ? String(ev.tenant.id).slice(0, 64) : null;
    const userId = ev.userId ? String(ev.userId).replace(/[^\w-]/g, '').slice(0, 64) : null;
    const version = cleanVersion(ev.version) || this.version;
    const httpStatus = Number.isInteger(ev.httpStatus) ? ev.httpStatus : null;
    const at = new Date(this.now()).toISOString();
    const id = ev.fingerprint ? `rep_${fp.fingerprint.replace(/^report:/, '').slice(0, 16)}` : `err_${fp.fingerprint}`;
    const userKey = userId ? `${tenantId || '-'}:${userId}` : null;
    const S = this.S;

    const { rows } = await this.conn.query(
      `WITH prev AS (SELECT status, fixed_in FROM ${S}.errors WHERE fingerprint = $2)
       INSERT INTO ${S}.errors AS e (id, fingerprint, kind, source, name, message, fp_message, top_frame, stack, route, method, http_status,
                                     tenants, users, versions, last_version, count, first_seen, last_seen, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               CASE WHEN $13::text IS NULL THEN '{}'::text[] ELSE ARRAY[$13::text] END,
               CASE WHEN $14::text IS NULL THEN '{}'::text[] ELSE ARRAY[$14::text] END,
               ARRAY[$15::text], $15, 1, $16, $16, $17::jsonb)
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = e.count + 1, last_seen = GREATEST(e.last_seen, EXCLUDED.last_seen),
         message = EXCLUDED.message, stack = CASE WHEN EXCLUDED.stack <> '' THEN EXCLUDED.stack ELSE e.stack END,
         top_frame = CASE WHEN EXCLUDED.top_frame <> '' THEN EXCLUDED.top_frame ELSE e.top_frame END,
         route = EXCLUDED.route, method = EXCLUDED.method, http_status = EXCLUDED.http_status,
         tenants = CASE WHEN $13::text IS NULL OR $13::text = ANY(e.tenants) THEN e.tenants ELSE array_append(e.tenants, $13::text) END,
         users = CASE WHEN $14::text IS NULL OR $14::text = ANY(e.users) OR cardinality(e.users) >= ${USERS_KEPT} THEN e.users ELSE array_append(e.users, $14::text) END,
         versions = CASE WHEN $15::text = ANY(e.versions) THEN e.versions ELSE (array_append(e.versions, $15::text))[greatest(1, cardinality(e.versions) + 2 - ${VERSIONS_KEPT}):] END,
         last_version = $15,
         -- Fixed, and it happens again on a newer version: it's back.
         status = CASE WHEN e.status = 'fixed' AND $15::text IS DISTINCT FROM e.fixed_in THEN 'new' ELSE e.status END,
         status_at = CASE WHEN e.status = 'fixed' AND $15::text IS DISTINCT FROM e.fixed_in THEN EXCLUDED.last_seen ELSE e.status_at END,
         status_by = CASE WHEN e.status = 'fixed' AND $15::text IS DISTINCT FROM e.fixed_in THEN 'reopened' ELSE e.status_by END
       RETURNING e.id, e.status, e.count, e.kind, e.http_status, (SELECT status FROM prev) AS prev_status`,
      [id, fp.fingerprint, kind, source, name, message, fp.fpMessage, top.text, stack, route, method, httpStatus,
        tenantId, userKey, version, at, ev.report ? JSON.stringify({ text: scrubText(ev.report.text, 2000), page: scrubText(ev.report.page || '', 100) }) : null],
    );
    const row = rows[0];
    const ctx = ev.context && typeof ev.context === 'object' ? ev.context : {};
    const file = ev.file?.data ? ev.file : null;
    const inserted = await this.conn.query(
      `INSERT INTO ${S}.error_events (error_id, at, tenant_id, user_id, route, method, version, page, device, http_status, context, has_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12) RETURNING id`,
      [row.id, at, tenantId, userId, route, method, version, cleanPath(ev.page || '', 200), String(ev.device || '').slice(0, 120), httpStatus,
        JSON.stringify(ctx), !!file],
    );
    const eventId = inserted.rows[0].id;
    if (file) await this.conn.query(`INSERT INTO ${S}.error_files (event_id, mime, data, created_at) VALUES ($1, $2, $3, $4)`, [eventId, file.mime, file.data, at]);
    if (row.count > EVENTS_KEPT && row.count % 25 === 0) {
      await this.conn.query(`DELETE FROM ${S}.error_events WHERE error_id = $1 AND id < (SELECT min(id) FROM (SELECT id FROM ${S}.error_events WHERE error_id = $1 ORDER BY id DESC LIMIT ${EVENTS_KEPT}) k)`, [row.id]);
    }

    const isNew = row.prev_status == null;
    const reopened = row.prev_status === 'fixed' && row.status === 'new';
    // Alerts go out after the occurrence is saved, in the background (a slow email never holds anything up).
    if (row.status === 'new') this.track(this.alert(row.id, { isNew, reopened, tenantId }));
    // A text for a brand-new server error that answered 500 (optional; the admin's own phone, see docs/BETA-TESTING.md).
    if (isNew && kind === 'server' && httpStatus === 500) this.track(this.text(row.id, { message, route, tenantId }));
    return { id: row.id, eventId: String(eventId), inserted: isNew, reopened, status: row.status, count: row.count };
  }

  /** A "Report a problem" report: its own entry (never grouped), alerted right away. */
  async report(ev) {
    const key = crypto.randomBytes(8).toString('hex');
    return this.record({
      ...ev, kind: 'report', source: 'report', fingerprint: `report:${key}`,
      name: '', message: scrubText(String(ev.report?.text || '').replace(/\s+/g, ' '), 140) || 'Report',
    });
  }

  // ---------- alerts ----------
  get adminEmails() {
    return String(this.env.PLATFORM_ADMIN_EMAIL || '').split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  }

  /** Email the admin about a new (unacknowledged) error: at most once per fingerprint per hour, and 20 an hour in all. */
  async alert(id, { isNew, reopened, tenantId }) {
    if (!this.mailer?.enabled || !this.adminEmails.length) return false;
    const n = this.now();
    const S = this.S;
    const { rows } = await this.conn.query(
      `UPDATE ${S}.errors SET last_alert_at = $2, alerts = alerts + 1
        WHERE id = $1 AND status = 'new' AND (last_alert_at IS NULL OR last_alert_at <= $3)
          AND (SELECT count(*) FROM ${S}.errors WHERE last_alert_at > $3) < $4
        RETURNING *`,
      [id, new Date(n).toISOString(), new Date(n - ALERT_EVERY_MS).toISOString(), ALERTS_PER_HOUR],
    );
    if (!rows.length) return false;
    const e = rows[0];
    const ev = (await this.conn.query(`SELECT * FROM ${S}.error_events WHERE error_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0] || {};
    const mail = alertEmail({ e: { ...toItem(e), stack: e.stack }, ev: toEvent(ev), isNew, reopened, restaurant: tenantId ? this.tenantName(tenantId) : '', url: this.consoleUrl(id) });
    const bucket = Math.floor(n / ALERT_EVERY_MS);
    await this.mailAdmins(mail, `err-alert-${id}-${bucket}`);
    return true;
  }

  async mailAdmins(mail, key) {
    const to = this.adminEmails;
    for (let i = 0; i < to.length; i++) await this.mailer.send({ ...mail, to: to[i] }, { idempotencyKey: `${key}-${i}` });
  }

  async text(id, { message, route, tenantId }) {
    const to = String(this.env.PLATFORM_ALERT_PHONE || '').trim();
    if (!to || !this.texter?.enabled) return false;
    const where = tenantId ? ` at ${this.tenantName(tenantId)}` : '';
    const body = `ShiftBoard: new server error (500)${where}: ${message.slice(0, 70)}${route ? ` · ${route.slice(0, 40)}` : ''}. ${this.consoleUrl(id)}`.trim();
    try { await this.texter.send(to, body.slice(0, 300)); return true; } catch (e) { logQuietly('Error alert text failed:', e.message); return false; }
  }

  // ---------- reading (the console) ----------
  /**
   * The list, grouped by fingerprint. filters: { tenant, status ('open' = new + acknowledged), kind, since ('24h', '7d',
   * '30d', 'all'), q }. Each item has its count in the window too.
   */
  async list({ tenant = '', status = '', kind = '', since = '7d', q = '', limit = 200 } = {}) {
    await this.ensure();
    const S = this.S;
    const where = [];
    const params = [];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    const hours = { '24h': 24, '7d': 168, '30d': 720 }[since];
    const from = hours ? new Date(this.now() - hours * 3_600_000).toISOString() : null;
    if (from) where.push(`e.last_seen >= ${add(from)}`);
    if (tenant) where.push(`${add(String(tenant))} = ANY(e.tenants)`);
    if (status === 'open') where.push(`e.status IN ('new', 'acknowledged')`);
    else if (STATUSES.includes(status)) where.push(`e.status = ${add(status)}`);
    if (KINDS.includes(kind)) where.push(`e.kind = ${add(kind)}`);
    if (q) where.push(`(e.message ILIKE ${add(`%${String(q).slice(0, 80)}%`)} OR e.top_frame ILIKE $${params.length} OR e.route ILIKE $${params.length} OR e.fingerprint ILIKE $${params.length})`);
    const recent = from ? `(SELECT count(*) FROM ${S}.error_events v WHERE v.error_id = e.id AND v.at >= ${add(from)})` : 'e.count';
    const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const { rows } = await this.conn.query(
      `SELECT e.*, ${recent}::int AS recent, (SELECT bool_or(has_file) FROM ${S}.error_events v WHERE v.error_id = e.id) AS has_file
         FROM ${S}.errors e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE e.status WHEN 'new' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, e.last_seen DESC LIMIT ${n}`,
      params,
    );
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of (await this.conn.query(`SELECT status, count(*)::int AS n FROM ${S}.errors GROUP BY status`)).rows) counts[r.status] = r.n;
    return { items: rows.map((r) => ({ ...toItem(r), recent: Number(r.recent) || 0, hasScreenshot: !!r.has_file })), counts };
  }

  /** One fingerprint with its recent occurrences, people affected, restaurants and the issue text. */
  async get(id, { events = 50 } = {}) {
    await this.ensure();
    const S = this.S;
    const e = (await this.conn.query(`SELECT * FROM ${S}.errors WHERE id = $1`, [String(id)])).rows[0];
    if (!e) return null;
    const evs = (await this.conn.query(`SELECT * FROM ${S}.error_events WHERE error_id = $1 ORDER BY id DESC LIMIT ${Math.min(Number(events) || 50, 200)}`, [e.id])).rows;
    const byTenant = (await this.conn.query(`SELECT tenant_id, count(*)::int AS n, max(at) AS last FROM ${S}.error_events WHERE error_id = $1 GROUP BY tenant_id ORDER BY n DESC`, [e.id])).rows;
    const item = {
      ...toItem(e), stack: e.stack,
      events: evs.map(toEvent),
      byTenant: byTenant.map((r) => ({ tenantId: r.tenant_id, name: r.tenant_id ? this.tenantName(r.tenant_id) : '', count: r.n, last: iso(r.last) })),
    };
    item.issueText = issueMarkdown(item, (t) => this.tenantName(t));
    return item;
  }

  /** acknowledged / fixed / ignored (or back to new). Fixed remembers the version it was fixed after. */
  async setStatus(id, status, by = '') {
    if (!STATUSES.includes(status)) throw Object.assign(new Error('Unknown status'), { status: 400 });
    await this.ensure();
    const { rows } = await this.conn.query(
      `UPDATE ${this.S}.errors SET status = $2, status_at = $3, status_by = $4,
              fixed_in = CASE WHEN $2 = 'fixed' THEN last_version ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [String(id), status, new Date(this.now()).toISOString(), String(by).slice(0, 120)],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** A report's screenshot: { mime, data: Buffer } or null. */
  async file(id, eventId) {
    if (!/^\d{1,18}$/.test(String(eventId))) return null;
    await this.ensure();
    const { rows } = await this.conn.query(
      `SELECT f.mime, f.data FROM ${this.S}.error_files f JOIN ${this.S}.error_events v ON v.id = f.event_id WHERE f.event_id = $1 AND v.error_id = $2`,
      [String(eventId), String(id)],
    );
    return rows[0] ? { mime: rows[0].mime, data: Buffer.from(rows[0].data, 'base64') } : null;
  }

  // ---------- the daily digest ----------
  /** What happened in the last `hours`: occurrences by kind, new fingerprints, reports, the busiest, what's still new. */
  async digest({ hours = 24 } = {}) {
    await this.ensure();
    const S = this.S;
    const from = new Date(this.now() - hours * 3_600_000).toISOString();
    const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const r of (await this.conn.query(`SELECT e.kind, count(*)::int AS n FROM ${S}.error_events v JOIN ${S}.errors e ON e.id = v.error_id WHERE v.at >= $1 GROUP BY e.kind`, [from])).rows) byKind[r.kind] = r.n;
    const byTenant = (await this.conn.query(`SELECT tenant_id, count(*)::int AS n FROM ${S}.error_events WHERE at >= $1 GROUP BY tenant_id ORDER BY n DESC`, [from])).rows
      .map((r) => ({ tenantId: r.tenant_id, name: r.tenant_id ? this.tenantName(r.tenant_id) : 'No restaurant', count: r.n }));
    const fresh = (await this.conn.query(`SELECT * FROM ${S}.errors WHERE first_seen >= $1 AND kind <> 'report' ORDER BY count DESC LIMIT 15`, [from])).rows.map(toItem);
    const reports = (await this.conn.query(`SELECT * FROM ${S}.errors WHERE first_seen >= $1 AND kind = 'report' ORDER BY first_seen DESC LIMIT 15`, [from])).rows.map(toItem);
    const busiest = (await this.conn.query(
      `SELECT e.*, x.n AS recent FROM (SELECT error_id, count(*)::int AS n FROM ${S}.error_events WHERE at >= $1 GROUP BY error_id) x
         JOIN ${S}.errors e ON e.id = x.error_id WHERE e.kind <> 'report' AND e.status <> 'ignored' ORDER BY x.n DESC LIMIT 5`, [from])).rows
      .map((r) => ({ ...toItem(r), recent: r.recent }));
    const open = Object.fromEntries((await this.conn.query(`SELECT status, count(*)::int AS n FROM ${S}.errors WHERE status IN ('new', 'acknowledged') GROUP BY status`)).rows.map((r) => [r.status, r.n]));
    const total = Object.values(byKind).reduce((a, b) => a + b, 0);
    return { hours, from, total, byKind, byTenant, fresh, reports, busiest, open: { new: open.new || 0, acknowledged: open.acknowledged || 0 } };
  }

  /** The daily cron: email the digest (unless nothing happened and nothing is waiting), then trim old data. */
  async sendDigest({ hours = 24 } = {}) {
    const d = await this.digest({ hours });
    const pruned = await this.prune();
    if (!this.adminEmails.length) return { sent: false, skipped: 'PLATFORM_ADMIN_EMAIL is not set', digest: d, pruned };
    if (!this.mailer?.enabled) return { sent: false, skipped: 'Email is not set up (RESEND_API_KEY and PLATFORM_EMAIL_FROM)', digest: d, pruned };
    if (!d.total && !d.open.new) return { sent: false, skipped: 'Nothing to report', digest: d, pruned };
    const mail = digestEmail(d, this.consoleUrl());
    const day = new Date(this.now()).toISOString().slice(0, 10);
    await this.mailAdmins(mail, `err-digest-${this.schema}-${day}`);
    return { sent: true, digest: d, pruned };
  }

  /** Keep 90 days of occurrences and 60 days of screenshots; drop fixed or ignored groups nobody has seen in 180 days. */
  async prune() {
    await this.ensure();
    const S = this.S;
    const ago = (days) => new Date(this.now() - days * 86_400_000).toISOString();
    const files = await this.conn.query(`DELETE FROM ${S}.error_files WHERE created_at < $1`, [ago(KEEP_FILES_DAYS)]);
    const events = await this.conn.query(`DELETE FROM ${S}.error_events WHERE at < $1`, [ago(KEEP_EVENTS_DAYS)]);
    const groups = await this.conn.query(`DELETE FROM ${S}.errors WHERE status IN ('fixed', 'ignored') AND last_seen < $1`, [ago(180)]);
    return { files: files.rowCount ?? files.affectedRows ?? 0, events: events.rowCount ?? events.affectedRows ?? 0, groups: groups.rowCount ?? groups.affectedRows ?? 0 };
  }
}

function toItem(r) {
  return {
    id: r.id, fingerprint: r.fingerprint, kind: r.kind, source: r.source, status: r.status, name: r.name, message: r.message,
    fpMessage: r.fp_message, topFrame: r.top_frame, route: r.route, method: r.method, httpStatus: r.http_status,
    tenants: [...(r.tenants || [])], usersAffected: (r.users || []).length, versions: [...(r.versions || [])], lastVersion: r.last_version,
    count: Number(r.count) || 0, firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen), lastAlertAt: iso(r.last_alert_at),
    statusAt: iso(r.status_at), statusBy: r.status_by || '', fixedIn: r.fixed_in || '', report: r.report || null,
  };
}
function toEvent(v) {
  return {
    id: v.id == null ? null : String(v.id), at: iso(v.at), tenantId: v.tenant_id || null, userId: v.user_id || null, route: v.route || '', method: v.method || '',
    version: v.version || '', page: v.page || '', device: v.device || '', httpStatus: v.http_status ?? null, context: v.context || {}, hasFile: !!v.has_file,
  };
}

const utc = (s) => (s ? `${s.slice(0, 16).replace('T', ' ')} UTC` : '—');
const titleOf = (e) => (e.kind === 'report' ? `Report: ${e.message}` : `${e.name ? `${e.name}: ` : ''}${e.message}`);

/** A markdown summary of one fingerprint, ready to paste into a GitHub issue or a chat with Claude. No user ids. */
export function issueMarkdown(e, tenantName = (id) => id) {
  const lines = [];
  const where = [e.method, e.route].filter(Boolean).join(' ');
  lines.push(`## [${e.kind}${e.source && e.source !== 'report' ? ` · ${e.source}` : ''}] ${titleOf(e).slice(0, 200)}`, '');
  if (e.kind === 'report') {
    const ev = e.events?.[0] || {};
    lines.push('> ' + String(e.report?.text || e.message).replace(/\n/g, '\n> '), '');
    if (e.report?.page) lines.push(`- **Page (as they said):** ${e.report.page}`);
    if (ev.page) lines.push(`- **Page (where the app was):** \`${ev.page}\``);
  } else {
    lines.push(`- **Fingerprint:** \`${e.fingerprint}\` (${e.kind}${e.name ? ` · ${e.name}` : ''} · grouped as “${e.fpMessage}”${e.topFrame ? ` at \`${e.topFrame.replace(/:\d+(:\d+)?\)$/, ')')}\`` : ''})`);
    if (where) lines.push(`- **Where:** \`${where}\`${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}`);
  }
  const rest = (e.byTenant || []).filter((t) => t.tenantId).map((t) => `${t.name || (t.tenantId ? tenantName(t.tenantId) : 'no restaurant')} (${t.count})`);
  if (rest.length) lines.push(`- **Restaurants:** ${rest.join(', ')}`);
  else if (e.tenants?.length) lines.push(`- **Restaurants:** ${e.tenants.map(tenantName).join(', ')}`);
  if (e.kind !== 'report') lines.push(`- **Seen:** ${e.count} time${e.count === 1 ? '' : 's'} by ${e.usersAffected} signed-in ${e.usersAffected === 1 ? 'person' : 'people'}; first ${utc(e.firstSeen)}, last ${utc(e.lastSeen)}`);
  else lines.push(`- **Sent:** ${utc(e.firstSeen)}`);
  if (e.versions?.length) lines.push(`- **App versions:** ${e.versions.map((v) => `\`${v}\``).join(', ')}`);
  const devices = [...new Set((e.events || []).map((v) => v.device).filter(Boolean))].slice(0, 5);
  if (devices.length) lines.push(`- **Devices:** ${devices.join('; ')}`);
  lines.push(`- **Status:** ${e.status}${e.fixedIn ? ` (fixed after \`${e.fixedIn}\`)` : ''}`);
  if (e.stack) lines.push('', '### Stack', '```', e.stack, '```');
  const c = e.events?.[0]?.context || {};
  if (c.error?.message) lines.push('', '### The error on screen', '```', `${c.error.name ? `${c.error.name}: ` : ''}${c.error.message}${c.error.stack ? `\n${c.error.stack}` : ''}`, '```');
  if (c.componentStack) lines.push('', '### React component stack', '```', c.componentStack, '```');
  if (Array.isArray(c.errors) && c.errors.length) {
    lines.push('', '### Recent errors in the app before this');
    for (const x of c.errors) lines.push(`- ${x.at ? `${x.at.slice(11, 19)} ` : ''}${x.name ? `${x.name}: ` : ''}${x.message}${x.source ? ` (${x.source})` : ''}`);
  }
  if (Array.isArray(c.rpc) && c.rpc.length) {
    lines.push('', '### Last calls to the server (method and status only)');
    lines.push(c.rpc.map((r) => `\`${r.method}\` ${r.status}${r.ms != null ? ` ${r.ms}ms` : ''}`).join(' → '));
  }
  if (e.kind !== 'report' && e.events?.length) {
    lines.push('', '### Recent occurrences', '| When (UTC) | Restaurant | Route / page | Version | Device |', '|---|---|---|---|---|');
    for (const v of e.events.slice(0, 10)) {
      lines.push(`| ${utc(v.at)} | ${v.tenantId ? tenantName(v.tenantId) : '—'} | ${[v.method, v.route].filter(Boolean).join(' ') || v.page || '—'} | ${v.version || '—'} | ${v.device || '—'} |`);
    }
  }
  if (e.kind === 'report' && e.events?.[0]) {
    const v = e.events[0];
    lines.push('', `App version \`${v.version || '—'}\` · ${v.device || 'unknown device'}${v.context?.app ? ` · ${v.context.app}` : ''}${e.events[0].hasFile ? ' · screenshot attached in the console' : ''}`);
  }
  return lines.join('\n');
}

// ---------- emails (to DubLow Digital, in English) ----------
function adminLayout(heading, bodyHtml, bodyText, url) {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:20px 10px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0f172a;color:#ffffff;padding:14px 22px;font-weight:700;font-size:15px">ShiftBoard · Errors &amp; reports</td></tr>
<tr><td style="padding:20px 22px;font-size:14px;line-height:1.5">
<h1 style="margin:0 0 12px;font-size:18px;line-height:1.35">${esc(heading)}</h1>
${bodyHtml}
${url ? `<p style="margin:20px 0 4px"><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Open in the console</a></p>` : ''}
</td></tr>
<tr><td style="padding:12px 22px 18px;color:#64748b;font-size:12px;border-top:1px solid #e2e8f0">Beta error tracking. At most one email per error per hour; a daily summary covers the rest. User ids only, never names or emails.</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text: [heading, '', bodyText, url ? `\nOpen in the console: ${url}` : ''].join('\n').trim() };
}
const pre = (s) => `<pre style="margin:8px 0;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word">${esc(s)}</pre>`;
const dl = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;margin:6px 0">${rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="color:#64748b;padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('')}</table>`;

export function alertEmail({ e, ev = {}, isNew, reopened, restaurant, url }) {
  const what = e.kind === 'report' ? 'New report' : reopened ? 'Back again (was fixed)' : isNew ? `New ${KIND_LABEL[e.kind].toLowerCase()} error` : `Still happening (${e.count} times)`;
  const subject = `[ShiftBoard] ${what}${restaurant ? ` · ${restaurant}` : ''}: ${titleOf(e).replace(/^Report: /, '').slice(0, 90)}`;
  const rows = [
    ['Restaurant', restaurant], ['Where', [e.method, e.route].filter(Boolean).join(' ') || ev.page], ['Page', e.kind === 'report' ? (e.report?.page || ev.page) : ''],
    ['Device', ev.device], ['Version', ev.version], ['User id', ev.userId], ['Fingerprint', e.kind === 'report' ? '' : e.fingerprint], ['Top frame', e.topFrame],
    ['Count', e.kind === 'report' ? '' : String(e.count)],
  ];
  const main = e.kind === 'report' ? String(e.report?.text || e.message) : `${e.name ? `${e.name}: ` : ''}${e.message}`;
  const extra = e.kind === 'report' && ev.hasFile ? '<p style="margin:8px 0;color:#475569">A screenshot is attached in the console.</p>' : '';
  const stack = e.kind !== 'report' && e.stack ? pre(e.stack.split('\n').slice(0, 12).join('\n')) : '';
  const { html, text } = adminLayout(what, `${pre(main)}${dl(rows)}${extra}${stack}`, [main, '', ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].join('\n'), url);
  return { subject: subject.slice(0, 200), html, text };
}

export function digestEmail(d, url) {
  const kinds = KINDS.filter((k) => d.byKind[k]).map((k) => `${d.byKind[k]} ${KIND_LABEL[k].toLowerCase()}${k === 'report' ? (d.byKind[k] === 1 ? '' : 's') : ''}`);
  const subject = `[ShiftBoard] Daily errors: ${d.total} in the last ${d.hours} hours${d.fresh.length ? `, ${d.fresh.length} new` : ''}${d.reports.length ? `, ${d.reports.length} report${d.reports.length === 1 ? '' : 's'}` : ''}`;
  const list = (items, f) => (items.length ? `<ul style="margin:6px 0 14px;padding-left:18px">${items.map((x) => `<li style="margin:3px 0">${f(x)}</li>`).join('')}</ul>` : '<p style="color:#64748b;margin:6px 0 14px">None.</p>');
  const name = (x) => esc(titleOf(x).slice(0, 120));
  const html = [
    `<p style="margin:0 0 12px">${d.total ? esc(kinds.join(' · ')) : 'No errors.'} Still waiting for a look: <b>${d.open.new}</b> new, ${d.open.acknowledged} acknowledged.</p>`,
    d.byTenant.length ? `<p style="margin:0 0 12px;color:#475569">${esc(d.byTenant.map((t) => `${t.name}: ${t.count}`).join(' · '))}</p>` : '',
    '<h3 style="margin:14px 0 4px;font-size:14px">New this period</h3>', list(d.fresh, (x) => `${name(x)} <span style="color:#64748b">(${x.kind}, ${x.count}×)</span>`),
    '<h3 style="margin:14px 0 4px;font-size:14px">Reports</h3>', list(d.reports, (x) => `${esc(String(x.report?.text || x.message).slice(0, 160))}`),
    '<h3 style="margin:14px 0 4px;font-size:14px">Most frequent</h3>', list(d.busiest, (x) => `${name(x)} <span style="color:#64748b">(${x.recent}× · ${x.status})</span>`),
  ].join('\n');
  const text = [
    `${d.total ? kinds.join(' · ') : 'No errors.'} Still new: ${d.open.new}, acknowledged: ${d.open.acknowledged}.`,
    '', 'New this period:', ...(d.fresh.length ? d.fresh.map((x) => `- ${titleOf(x).slice(0, 120)} (${x.kind}, ${x.count}x)`) : ['- none']),
    '', 'Reports:', ...(d.reports.length ? d.reports.map((x) => `- ${String(x.report?.text || x.message).slice(0, 160)}`) : ['- none']),
    '', 'Most frequent:', ...(d.busiest.length ? d.busiest.map((x) => `- ${titleOf(x).slice(0, 120)} (${x.recent}x, ${x.status})`) : ['- none']),
  ].join('\n');
  const out = adminLayout(`The last ${d.hours} hours`, html, text, url);
  return { subject, ...out };
}

// Our own logging goes around the request-capture hook in errors-routes.js (it never records itself).
let rawError = console.error.bind(console);
export const setRawConsoleError = (fn) => { rawError = fn; };
export function logQuietly(...args) { try { rawError(...args); } catch { /* nothing left to do */ } }
