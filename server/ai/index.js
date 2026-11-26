// ShiftBoard's AI, for any feature that calls Claude: Ask ShiftBoard (server/assistant/), review replies, and
// whatever comes next. One way in, so every call is metered, capped and tied to its restaurant.
//
//   const ai = aiFor({ db, tenant, env, now });
//   if (!ai.available) show(aiMessage(ai.reason, lang));          // 'no_key' | 'off' | 'cap' | 'plan'
//   const { text, usage, stopReason } = await ai.complete({
//     purpose: 'review_reply', system: '…', messages: [{ role: 'user', content: '…' }], maxTokens: 600, user,
//   });
//
// aiFor() is synchronous: it reads the restaurant's store as of the request's last sync (call db.sync() first, as
// every route does). complete() and stream() check again before they call, so a restaurant that reached its cap a
// moment ago gets AiUnavailable { reason: 'cap' } instead of a call. Catch AiUnavailable and show error.message
// (or aiMessage(error.reason, lang)): a friendly sentence, never an error page.
//
// Keys: ANTHROPIC_API_KEY (platform-wide, DubLow pays; set in Vercel as Sensitive). A restaurant can bring its own
// key (Settings → Integrations → Anthropic, stored encrypted like Toast's and ADP's; tenant-env.js hands it over as
// ANTHROPIC_OWN_API_KEY): its calls are still metered, but don't count against DubLow's monthly cap.
//
// Caps: a monthly cap in USD per restaurant on DubLow's key (the plan's, plans.js aiMonthlyCapUsd, unless DubLow set
// one for the restaurant in the console), the admins' warning at 80% (an in-app notification, once a month), and
// a calls-per-minute limit per restaurant. The assistant adds a daily message limit per person (admit()).
// Nothing here logs a key, a prompt or a reply.
import Anthropic from '@anthropic-ai/sdk';
import { MODEL, tokensOf, costUsd } from './pricing.js';
import { aiMessage, aiMessageBoth } from './messages.js';
import { monthOf, dayOf, monthMeter, messagesToday, meterCall, meterMessage, markWarned, localUsageLog } from './usage.js';
import { planAiCap, DEFAULT_AI_CAP_USD } from '../platform/plans.js';
import { canChangeSettings } from '../../core/roles.js';
import { createService } from '../../core/service.js';
import { uid } from '../../core/store.js';

export { MODEL, PRICES, costUsd, tokensOf } from './pricing.js';
export { aiMessage } from './messages.js';

/** The plan features that use AI. A restaurant with none of them has no AI (reason 'plan'); a new AI feature adds its key. */
export const AI_FEATURES = ['assistant', 'reviews', 'events']; // plan features that use AI: Ask ShiftBoard; AI-drafted review replies (server/review-replies.js); "Read it with AI" for BEOs (server/beo-ai-routes.js)
export const DEFAULT_DAILY_MESSAGES = 50;
const DEFAULT_CALLS_PER_MINUTE = 120; // per restaurant, every feature together
const DEFAULT_MESSAGES_PER_MINUTE = 8; // per person (the assistant)
const WARN_AT = 0.8;

/** Why the AI didn't run, with a sentence for people. reason: no_key | off | cap | plan | daily | rate | busy | api. */
export class AiUnavailable extends Error {
  constructor(reason, { lang = 'en', params = {}, cause } = {}) {
    super(aiMessage(reason, lang, params));
    this.name = 'AiUnavailable';
    this.reason = reason;
    this.status = reason === 'api' || reason === 'busy' ? 503 : 429;
    if (cause) this.code = cause;
  }
}

// The Anthropic client for a key. Tests swap in a fake (setAiClientFactory, or aiFor({ client })).
const defaultFactory = ({ apiKey }) => new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
let clientFactory = defaultFactory;
export const setAiClientFactory = (fn) => { clientFactory = typeof fn === 'function' ? fn : defaultFactory; };

const num = (v, fallback) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

/** The restaurant's monthly cap on DubLow's key, in USD. */
export function capFor(tenant, env = process.env) {
  if (tenant) return num(tenant.ai?.capUsd, planAiCap(tenant.plan));
  return num(env.AI_MONTHLY_CAP_USD, DEFAULT_AI_CAP_USD);
}
/** Messages a person may send the assistant per day. */
export const dailyLimitFor = (tenant, env = process.env) => Math.round(num(tenant?.ai?.dailyMessages, num(env.AI_DAILY_MESSAGES, DEFAULT_DAILY_MESSAGES)));

/** Why the restaurant can't use AI before even counting: 'plan', 'off', 'no_key', or null. */
function blockedBy(tenant, env) {
  if (tenant && !AI_FEATURES.some((f) => tenant.features?.[f] !== false)) return 'plan';
  if (String(env.AI_DISABLED || '').toLowerCase() === 'true' || tenant?.ai?.off === true) return 'off';
  if (!env.ANTHROPIC_OWN_API_KEY && !env.ANTHROPIC_API_KEY) return 'no_key';
  return null;
}

// What an API failure is called in the ledger (a code, never its message).
function errorCode(e) {
  if (e?.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (e instanceof Anthropic.RateLimitError) return 'rate_limit';
  if (e instanceof Anthropic.AuthenticationError) return 'auth';
  if (e instanceof Anthropic.PermissionDeniedError) return 'permission';
  if (e instanceof Anthropic.BadRequestError) return 'bad_request';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (e instanceof Anthropic.APIConnectionError) return 'connection';
  if (e instanceof Anthropic.InternalServerError) return `server_${e.status || 500}`;
  if (e instanceof Anthropic.APIError) return `api_${e.status || 0}`;
  return 'error';
}

/**
 * ShiftBoard's AI for one restaurant.
 * @param o.db      the restaurant's DocDb (server/db.js)
 * @param o.tenant  on the platform, the restaurant (server/platform/ tenantContext): { id, plan, features, ai, aiUsage }; null on a single install
 * @param o.env     the restaurant's env (tenant-env.js): ANTHROPIC_API_KEY, ANTHROPIC_OWN_API_KEY, AI_DISABLED, AI_MONTHLY_CAP_USD, AI_DAILY_MESSAGES
 * @param o.now     clock in ms
 * @param o.client  an Anthropic client to use (tests); else one is made for the key
 * @param o.lang    the language AiUnavailable messages are in (default the restaurant's)
 * @returns {{ available: boolean, reason?: 'no_key'|'off'|'cap'|'plan', model: string, billedTo: 'own'|'platform', capUsd: number,
 *   usage(): object, admit(o): Promise, complete(o): Promise<{ text, usage, stopReason, content }>, stream(o, on): Promise<…> }}
 */
export function aiFor({ db, tenant = null, env = process.env, now = () => Date.now(), client = null, lang = null }) {
  const usageLog = tenant?.aiUsage || localUsageLog(db);
  const settings = () => createService(db.store).settings();
  const langOfRestaurant = () => { try { return settings().language === 'es' ? 'es' : 'en'; } catch { return 'en'; } };
  const restaurant = () => { try { return settings().restaurantName || ''; } catch { return ''; } };
  const own = !!env.ANTHROPIC_OWN_API_KEY;
  const billedTo = own ? 'own' : 'platform';
  const capUsd = capFor(tenant, env);
  const iso = () => new Date(now()).toISOString();

  /** This month as the meter has it, with the cap: { month, usedUsd, ownUsd, capUsd, pct, calls, users, … }. */
  function usage() {
    const m = monthMeter(db.store, monthOf(now()));
    return { ...m, usedUsd: m.platformUsd, capUsd, pct: capUsd > 0 ? Math.min(100, Math.round((m.platformUsd / capUsd) * 100)) : 100, ownKey: own };
  }
  /** Why it can't run right now, or null (the cap only binds DubLow's key). */
  function reasonNow() {
    const why = blockedBy(tenant, env);
    if (why) return why;
    if (!own && usage().platformUsd >= capUsd) return 'cap';
    return null;
  }
  const unavailable = (reason, l) => new AiUnavailable(reason, { lang: l || lang || langOfRestaurant(), params: { restaurant: restaurant(), limit: dailyLimitFor(tenant, env) } });

  const reason = reasonNow();
  const ai = {
    available: !reason, ...(reason ? { reason } : {}), model: MODEL, billedTo, capUsd, usage,

    /**
     * One message from a person to an assistant: their daily limit and a per-minute limit. Counts the message.
     * Throws AiUnavailable 'daily' or 'rate' (and the reasons above).
     */
    async admit({ user, lang: l = null }) {
      await db.sync();
      const why = reasonNow();
      if (why) throw unavailable(why, l);
      const day = dayOf(now());
      if (messagesToday(db.store, day, user.id) >= dailyLimitFor(tenant, env)) throw unavailable('daily', l);
      const key = `ai|msg|${db.schema}|${user.id}`;
      if (await db.countAttempts(key, 1) >= num(env.AI_MESSAGES_PER_MINUTE, DEFAULT_MESSAGES_PER_MINUTE)) throw unavailable('rate', l);
      await db.recordAttempt(key);
      await db.run((s) => meterMessage(s, { day, month: monthOf(now()), userId: user.id }), { write: true });
    },

    /** A whole answer at once. See request() for the options. */
    complete: (o) => request(o, null),
    /** The same, streaming the text: on.text(delta) as it comes. Resolves with what complete() returns. */
    stream: (o, on = {}) => request(o, on),
  };

  /**
   * @param o.purpose    what it's for, in the ledger ('assistant', 'review_reply', …)
   * @param o.system     a string, or text blocks; a string is cached (prompt caching), blocks as they come
   * @param o.messages   Messages API messages
   * @param o.maxTokens  the reply's limit (thinking included)
   * @param o.user       the person it's for (their id goes in the ledger), or null
   * @param o.tools      Messages API tools (optional)
   * @param o.effort     'low' (default) … 'max'
   * @param o.cacheConversation  also cache the conversation so far (a tool loop's next round reads it from the cache)
   */
  async function request({ purpose, system, messages, maxTokens = 1024, user = null, tools = null, effort = 'low', cacheConversation = false, lang: l = null }, on) {
    if (!purpose || !Array.isArray(messages) || !messages.length) throw new Error('aiFor().complete needs a purpose and messages');
    await db.sync();
    const why = reasonNow();
    if (why) throw unavailable(why, l);
    const rateKey = `ai|calls|${db.schema}`;
    if (await db.countAttempts(rateKey, 1) >= num(env.AI_CALLS_PER_MINUTE, DEFAULT_CALLS_PER_MINUTE)) throw unavailable('busy', l);
    await db.recordAttempt(rateKey);

    const params = {
      model: MODEL,
      max_tokens: maxTokens,
      ...(system ? { system: typeof system === 'string' ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system } : {}),
      messages,
      ...(tools?.length ? { tools } : {}),
      output_config: { effort },
      ...(cacheConversation ? { cache_control: { type: 'ephemeral' } } : {}),
    };
    const anthropic = client || clientFactory({ apiKey: own ? env.ANTHROPIC_OWN_API_KEY : env.ANTHROPIC_API_KEY });
    let message;
    try {
      if (on) {
        const s = anthropic.messages.stream(params);
        for await (const ev of s) {
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) on.text?.(ev.delta.text);
        }
        message = await s.finalMessage();
      } else {
        message = await anthropic.messages.create(params);
      }
    } catch (e) {
      const code = errorCode(e);
      console.error(`AI call failed (${purpose}): ${code}`); // the code only: never the request or the key
      await record({ purpose, user, tokens: tokensOf({}), ok: false, error: code });
      throw Object.assign(unavailable(code === 'rate_limit' || code.startsWith('server_') || code === 'timeout' || code === 'connection' ? 'busy' : 'api', l), { code });
    }
    const tokens = tokensOf(message.usage);
    const cost = costUsd(tokens, message.model || MODEL);
    await record({ purpose, user, tokens, cost, ok: true, model: message.model || MODEL });
    const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, usage: { ...tokens, costUsd: cost, model: message.model || MODEL, billedTo }, stopReason: message.stop_reason, content: message.content || [] };
  }

  /** Meter one call (the restaurant's store) and add it to the ledger. Never throws. */
  async function record({ purpose, user, tokens, cost = 0, ok, error = '', model = MODEL }) {
    const at = iso();
    const month = monthOf(now());
    let after = null;
    try {
      after = await db.run((s) => meterCall(s, { month, userId: user?.id || null, purpose, usd: cost, billedTo, ok }), { write: true });
    } catch (e) { console.error('AI meter failed:', e.message); }
    try {
      await usageLog.record({ at, month, userId: user?.id || null, purpose, model, tokens, costUsd: cost, billedTo, ok, error });
    } catch (e) { console.error('AI usage ledger failed:', e.message); }
    if (after && !own && capUsd > 0 && after.platformUsd >= capUsd * WARN_AT && !after.warnedAt) {
      try { await warnAdmins(after); } catch (e) { console.error('AI warning failed:', e.message); }
    }
  }

  /** "Ask ShiftBoard has used 80% of this month's allowance": an in-app notification for each admin, once a month. */
  async function warnAdmins(m) {
    const at = iso();
    const pct = Math.min(100, Math.floor((m.platformUsd / capUsd) * 100));
    const params = { pct, used: m.platformUsd.toFixed(2), cap: capUsd.toFixed(2) };
    const i18n = aiMessageBoth('warn80', params);
    await db.run((s) => {
      if (!markWarned(s, m.month, at)) return;
      const st = createService(s).settings();
      for (const u of s.list('users', (x) => x.active !== false && canChangeSettings(x))) {
        const l = u.language === 'es' || u.language === 'en' ? u.language : st.language === 'es' ? 'es' : 'en';
        s.insert('notifications', { id: uid('ntf'), userId: u.id, text: i18n[l], i18n, link: '#/settings', read: false, at, kind: 'aiUsage' });
      }
    }, { write: true });
  }

  return ai;
}
