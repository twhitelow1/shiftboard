// The tool registry: ShiftBoard's actions as tools an AI can call, independent of how they're called.
//
// The Claude connector (server/mcp/) lists them over MCP; an in-app assistant can hand the same tools to Claude
// through the Messages API (toolJsonSchema gives the input_schema). Every tool:
//
//   name, title, description   what the model reads (English)
//   input                      a zod shape ({ date: z.string()… }); toolJsonSchema() turns it into JSON Schema
//   write                      false: only reads (shiftboard.read); true: changes something (shiftboard.write)
//   destructive, idempotent    hints for the client (MCP annotations)
//   confirm                    the call must carry confirm: true (the description tells the model to ask first)
//   preview                    a write tool that only reads unless called with confirm: true (an import: the first call
//                              shows what would change, the second does it). Without confirm it runs on a read-only
//                              connection too, and Ask ShiftBoard runs it like a read; with confirm it's a change.
//   role                       the lowest role that sees it ('employee' … 'admin'); can(user, info) for anything finer
//   feature                    the plan feature it needs (server/platform/plans.js), like the app's pages
//   consent                    the line on the consent screen it belongs to (web/src/i18n claude.can_<key>)
//   handler(user, args, ctx)   does the work through ctx.read / ctx.write, which call the same RPCs as the app
//                              (svc.call(user, method, args)): roles, plan features, privacy and contact
//                              visibility stay exactly as in the app. Returns { summary, data }.
//
// A person only sees the tools their role, their restaurant's plan and their connection's scopes allow
// (visibleTools); runTool checks all of it again before running one.
import * as z from 'zod';
import { createService, AppError } from '../../core/service.js';
import { atLeast } from '../../core/roles.js';
import { langOf } from '../../core/i18n.js';
import { uid } from '../../core/store.js';
import { featureForMethod, NOT_IN_PLAN } from '../platform/plans.js';
import { todayOf } from './dates.js';
import { toolError } from './errors.js';

export const READ = 'shiftboard.read';
export const WRITE = 'shiftboard.write';

/** Fill in a tool's defaults and check it's complete (a mistake here fails at startup, not in front of someone). */
export function defineTool(t) {
  for (const k of ['name', 'description', 'handler']) if (!t[k]) throw new Error(`Tool ${t.name || '?'} needs ${k}`);
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(t.name)) throw new Error(`Tool name ${t.name}: lowercase letters, digits and _`);
  const write = !!t.write;
  return Object.freeze({
    title: t.name, input: {}, role: 'employee', feature: null, can: null, consent: write ? 'changes' : 'read',
    destructive: false, idempotent: !write, confirm: false, preview: false, ...t, write, scope: write ? WRITE : READ,
  });
}

/**
 * Hook for role features (the role editor, when it merges): return false to hide a tool from a role that has its
 * feature switched off. Until then every role keeps what its rank allows.
 */
let roleFeatureCheck = (/* user, tool */) => true;
export const setRoleFeatureCheck = (fn) => { roleFeatureCheck = typeof fn === 'function' ? fn : () => true; };

/**
 * Can this person use this tool on this connection? info: { has(feature), scopes, settings }.
 * Mirrors what the app shows them (app.bootstrap's features, NAV's roles and plan features).
 */
export function toolAllowed(tool, user, info) {
  if (!user || user.active === false) return false;
  if (!atLeast(user, tool.role)) return false;
  if (tool.feature && !info.has(tool.feature)) return false;
  if (!(info.scopes || []).includes(tool.scope)) return false;
  if (tool.can && !tool.can(user, info)) return false;
  return roleFeatureCheck(user, tool) !== false;
}
export const visibleTools = (tools, user, info) => tools.filter((t) => toolAllowed(t, user, info));

/** The tool's input as a zod object (unknown keys are dropped). */
export const toolInputSchema = (tool) => z.object(tool.input);
/** The tool's input as JSON Schema, for the Claude Messages API's input_schema. */
export function toolJsonSchema(tool) {
  const { $schema: _s, ...schema } = z.toJSONSchema(toolInputSchema(tool), { io: 'input', unrepresentable: 'any' });
  return schema;
}
/** The tool for the Claude Messages API: { name, description, input_schema }. */
export const toClaudeTool = (tool) => ({ name: tool.name, description: tool.description, input_schema: toolJsonSchema(tool) });

// Long text in the audit log is cut short; nothing secret ever goes through a tool.
function auditArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = JSON.stringify(v).slice(0, 200);
  }
  return out;
}

/**
 * What a tool works with, for one person on one request. Transport-agnostic: the MCP server builds one per call,
 * and so can an in-app assistant.
 * @param o.db           the restaurant's DocDb
 * @param o.userId, o.v  who, and their sessionVersion when the connection was made (any change ends it)
 * @param o.has          (feature) => in the restaurant's plan
 * @param o.scopes       the connection's scopes
 * @param o.serviceOpts  createService options (hashPassword, channels, request, legal), as server/app.js uses
 * @param o.onCommit     (changes) => void: notifications by email, web push, the phone app and texts
 * @param o.via, o.client  for the audit log: 'claude' and the client's name
 * @param o.invite       (userIds, invitedBy) => Promise<{ sent, noEmail, failed }>: invitation emails for people an import made
 */
export function createToolContext({ db, userId, v = 0, has = () => true, scopes = [READ], serviceOpts = {}, onCommit, via = 'claude', client = '', now = () => Date.now(), invite = null }) {
  const fresh = (store) => {
    const u = store.get('users', userId);
    if (!u || u.active === false || (u.sessionVersion || 0) !== v) throw new AppError(401, 'Please sign in');
    return u;
  };
  const svcOf = (store) => createService(store, serviceOpts);
  const plan = (method) => { const f = featureForMethod(method); if (f && !has(f)) throw new AppError(403, NOT_IN_PLAN); };
  const ctx = {
    has, scopes, via, client, now,
    /** Send invitation emails to people an import made (after the save). Null where email can't go out (tests, no server). */
    invite: invite ? (ids) => invite(ids, fresh(db.store).name) : null,
    get store() { return db.store; },
    /** The person as of now (after a sync). */
    user: () => fresh(db.store),
    settings: () => svcOf(db.store).settings(),
    lang: () => langOf(db.store.get('users', userId), svcOf(db.store).settings()),
    today: () => todayOf(now()),
    /** Read through an RPC (one fresh, consistent view). */
    async read(method, args = {}) {
      plan(method);
      return db.run((store) => svcOf(store).call(fresh(store), method, structuredClone(args)));
    },
    /** Several reads on one view: [[method, args], …] → [result, …]. */
    async readAll(calls) {
      for (const [m] of calls) plan(m);
      return db.run((store) => { const a = fresh(store); const svc = svcOf(store); return calls.map(([m, args]) => svc.call(a, m, structuredClone(args || {}))); });
    },
    /**
     * Change something through an RPC, in one transaction with its audit log entry. Or pass a function
     * fn(call, store, actor) to read and write on one view (call(method, args) is svc.call as this person).
     */
    async write(methodOrFn, args = {}) {
      const self = this || ctx; // the per-call context runTool made (it knows the tool and its arguments)
      if (!scopes.includes(WRITE)) throw new AppError(403, 'read-only');
      if (typeof methodOrFn === 'string') plan(methodOrFn);
      return db.run((store) => {
        const actor = fresh(store);
        const svc = svcOf(store);
        const called = [];
        const call = (m, a = {}) => { plan(m); called.push(m); return svc.call(actor, m, structuredClone(a)); };
        const result = typeof methodOrFn === 'function' ? methodOrFn(call, store, actor) : call(methodOrFn, args);
        if (store.dirty) {
          store.insert('auditLog', { id: uid('aud'), at: new Date(now()).toISOString(), actorId: actor.id, targetId: null, action: `${via}.${self.tool || 'tool'}`,
            via, client, details: { via, client, tool: self.tool || null, methods: [...new Set(called)], args: auditArgs(self.args) } });
        }
        return result;
      }, { write: true, onCommit });
    },
  };
  return ctx;
}

/** Whether this call of a tool only looks (a preview tool called without confirm: true). */
export const isPreviewCall = (tool, args) => !!tool?.preview && args?.confirm !== true;

/**
 * Run a tool for a person: checks it's allowed (role, plan, scope), validates the input, asks for confirm: true
 * where the tool needs it, and turns errors into a sentence in the person's language.
 * Returns { ok: true, summary, data } or { ok: false, error, status }.
 */
export async function runTool(tool, rawArgs, ctx) {
  let lang = 'en';
  try {
    lang = ctx.lang();
    const user = ctx.user();
    const info = { has: ctx.has, scopes: ctx.scopes, settings: ctx.settings() };
    if (!toolAllowed(tool, user, { ...info, scopes: [READ, WRITE] })) return { ok: false, status: 403, error: toolError('unavailable', lang) };
    const parsed = toolInputSchema(tool).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return { ok: false, status: 400, error: toolError('badInput', lang, { details }) };
    }
    const args = parsed.data;
    // A preview tool without confirm only reads (it never calls ctx.write, which refuses on a read-only connection anyway).
    if (!ctx.scopes.includes(tool.scope) && !(isPreviewCall(tool, args) && ctx.scopes.includes(READ))) return { ok: false, status: 403, error: toolError('read-only', lang) };
    if (tool.confirm && args.confirm !== true) {
      return { ok: false, status: 409, error: `Not done: ${tool.name} needs confirm: true. Tell the user exactly what will happen, ask them, and call again with confirm: true only if they say yes.` };
    }
    const scoped = Object.create(ctx);
    scoped.tool = tool.name;
    scoped.args = args;
    const out = await tool.handler(user, args, scoped);
    return { ok: true, summary: out?.summary || 'Done.', data: out?.data ?? null };
  } catch (e) {
    if (e instanceof AppError) {
      if (e.status === 401) return { ok: false, status: 401, error: toolError('signInAgain', lang) };
      if (e.message === 'read-only') return { ok: false, status: 403, error: toolError('read-only', lang) };
      return { ok: false, status: e.status, error: toolError(e.message, lang) };
    }
    console.error(`Tool ${tool.name} failed:`, e);
    return { ok: false, status: 500, error: toolError('failed', lang) };
  }
}
