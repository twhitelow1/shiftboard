// Each restaurant's integration settings (ADP, Toast, Tripleseat, the Twilio sender, the email From),
// saved by DubLow in the platform console or by the restaurant's own admins in Settings → Integrations.
// Both go through saveIntegrations(): the same checks (tenant-env.js cleanIntegrations), the same encrypted
// secrets (registry.setSecrets), the same audit log, and the restaurant's runtime is rebuilt with the new
// env on its next request. restaurantView() is what the restaurant's Settings page sees: per integration,
// whether it's connected and what's missing, the plain values, and only "set" + the last 4 of a secret.
import { INTEGRATION_FIELDS, PLAIN_KEYS, cleanIntegrations, tenantEnv, parseFrom } from './tenant-env.js';
import { NOT_IN_PLAN } from './plans.js';

/** The integrations in the order Settings shows them, and the plan feature each needs (email: every plan). */
export const GROUPS = ['adp', 'toast', 'tripleseat', 'twilio', 'email'];
export const GROUP_FEATURE = { adp: 'adp', toast: 'toast', tripleseat: 'tripleseat', twilio: 'sms', email: null };
export const groupAllowed = (group, resolved) => !GROUP_FEATURE[group] || !resolved || resolved[GROUP_FEATURE[group]] !== false;
/** The setting names a restaurant on this plan may change. */
export const allowedKeys = (resolved) => new Set(INTEGRATION_FIELDS.filter((f) => groupAllowed(f.group, resolved)).map((f) => f.key));

/**
 * Save settings for one restaurant. input: { KEY: value } with '' meaning clear and absent meaning keep.
 * allowed: the keys this caller may change (a restaurant: its plan's); anything else is a 403.
 * actor: { id, email } for the audit log (a console admin, or `user:<id>` for a restaurant's own admin).
 * Returns the names that changed (secrets as "KEY (set)" / "KEY (cleared)", never their values).
 */
export async function saveIntegrations(registry, tenant, input, { actor = null, allowed = null, details = {} } = {}) {
  const { plain, secrets } = cleanIntegrations(input || {});
  if (allowed) {
    for (const k of [...Object.keys(plain), ...Object.keys(secrets)]) {
      if (!allowed.has(k)) { const e = new Error(NOT_IN_PLAN); e.status = 403; throw e; }
    }
  }
  const changed = [];
  if (Object.keys(plain).length) {
    const next = { ...tenant.integrations };
    for (const k of PLAIN_KEYS) {
      if (!(k in plain)) continue;
      if ((next[k] || '') !== plain[k]) changed.push(k);
      if (plain[k]) next[k] = plain[k]; else delete next[k];
    }
    if (changed.length) await registry.updateTenant(tenant.id, { integrations: next });
  }
  if (Object.keys(secrets).length) {
    await registry.setSecrets(tenant.id, secrets);
    changed.push(...Object.entries(secrets).map(([k, v]) => `${k} (${v ? 'set' : 'cleared'})`));
  }
  if (changed.length) await registry.audit({ admin: actor, action: 'tenant.integrations', tenantId: tenant.id, details: { changed, ...details } });
  return changed;
}

// What each integration needs before it works: settings of the restaurant's, and the platform's own
// account where there is one (Twilio's account SID and token, the Resend key).
const NEEDS = {
  adp: (e) => ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM'].filter((k) => !e[k]),
  toast: (e) => ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID'].filter((k) => !e[k]),
  tripleseat: (e) => (e.TRIPLESEAT_PUBLIC_KEY && e.TRIPLESEAT_SECRET_KEY ? [] : ['TRIPLESEAT_CLIENT_ID', 'TRIPLESEAT_CLIENT_SECRET'].filter((k) => !e[k])),
  twilio: (e) => (e.TWILIO_MESSAGING_SERVICE_SID || e.TWILIO_FROM_NUMBER ? [] : ['TWILIO_MESSAGING_SERVICE_SID']),
  email: (e) => (parseFrom(e.EMAIL_FROM).address ? [] : ['EMAIL_FROM_ADDRESS']),
};
const ACCOUNT = { twilio: (e) => !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN), email: (e) => !!e.RESEND_API_KEY };

/**
 * What a restaurant's admins see in Settings → Integrations, for the integrations in its plan.
 * mode 'platform': editable (saved encrypted in the registry). mode 'env': a single-restaurant install,
 * read-only (everything comes from env vars). Never a secret's value: only set, last 4, and fromEnv
 * (the default restaurant's env fallback, or this install's env).
 */
export function restaurantView({ tenant, secretView = {}, env = process.env, mode = 'platform', encryption = true }) {
  const t = tenant || { id: 'local', is_default: true, integrations: {}, resolved: null };
  const resolved = t.resolved || null;
  const e = mode === 'env' ? env : tenantEnv(env, { ...t, resolved: null }, Object.fromEntries(Object.entries(secretView).filter(([, v]) => v?.set).map(([k]) => [k, 'set'])));
  const from = parseFrom(e.EMAIL_FROM);
  const envValue = (k) => (k === 'EMAIL_FROM_NAME' ? from.name : k === 'EMAIL_FROM_ADDRESS' ? from.address : e[k]);
  const groups = GROUPS.filter((g) => groupAllowed(g, resolved)).map((g) => {
    const fields = INTEGRATION_FIELDS.filter((f) => f.group === g).map((f) => {
      const own = f.secret ? !!secretView[f.key]?.set : !!t.integrations?.[f.key];
      return {
        key: f.key, secret: !!f.secret, multiline: !!f.multiline, placeholder: f.placeholder || '',
        ...(f.secret ? { set: own, last4: own ? secretView[f.key]?.last4 || '' : '' } : { value: String(t.integrations?.[f.key] || '') }),
        // Set on the server (env) instead: the default restaurant's fallback, or a single install's settings.
        fromEnv: !own && (mode === 'env' || t.is_default) && !!String(envValue(f.key) || '').trim(),
      };
    });
    const missing = NEEDS[g](e);
    const account = ACCOUNT[g] ? ACCOUNT[g](e) : true;
    const touched = fields.some((f) => f.set || f.value || f.fromEnv);
    return {
      key: g, status: !account ? 'noAccount' : !missing.length ? 'connected' : touched ? 'partial' : 'notSetUp', missing, fields,
      ...(g === 'email' && e.EMAIL_FROM ? { from: e.EMAIL_FROM } : {}), // what emails go out as (the platform's address, under the restaurant's name, until it has its own)
    };
  });
  return { mode, editable: mode === 'platform', encryption: mode === 'platform' && !!encryption, envFallback: mode === 'platform' && !!t.is_default, groups };
}
