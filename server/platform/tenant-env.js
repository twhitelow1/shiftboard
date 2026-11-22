// Each restaurant's settings for the integrations, as the env object server/app.js already reads.
//
// The app and its modules (email.js, sms.js, toast.js) are configured from an env object. On the
// platform each restaurant gets its own copy of the platform's env, with the restaurant-specific
// variables swapped for that restaurant's settings from the console:
//
//   * Toast: TOAST_CLIENT_ID, TOAST_CLIENT_SECRET (secrets), TOAST_RESTAURANT_GUID, TOAST_API_HOST.
//   * ADP: ADP_CLIENT_ID, ADP_CLIENT_SECRET, ADP_CERT_PEM, ADP_KEY_PEM (secrets), ADP_MANAGER_AOID.
//   * Tripleseat: TRIPLESEAT_CLIENT_ID, TRIPLESEAT_CLIENT_SECRET, TRIPLESEAT_PUBLIC_KEY, TRIPLESEAT_SECRET_KEY,
//     TRIPLESEAT_WEBHOOK_SECRET (secrets), TRIPLESEAT_SITE_ID, TRIPLESEAT_LOCATION_ID, TRIPLESEAT_API_HOST.
//   * Texts: the sender, TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER. The account SID and auth
//     token stay platform-wide (DubLow owns one Twilio account and registers each restaurant as a brand).
//   * Email: the From name and address and the reply-to. The Resend API key stays platform-wide.
//   * VAPID (web push) and Expo push stay platform-wide.
//
// The default restaurant (Chasing Rabbits) keeps the platform env as it is, with any console setting
// taking its place, so production keeps working unchanged. Any other restaurant never sees the default
// restaurant's variables (its admin account, its Toast credentials, its sender, its email From).
import crypto from 'node:crypto';

/** The integration settings the console edits. secret: encrypted in platform.tenant_secrets, never shown. */
export const INTEGRATION_FIELDS = [
  { key: 'TOAST_CLIENT_ID', group: 'toast', label: 'Client ID', secret: true },
  { key: 'TOAST_CLIENT_SECRET', group: 'toast', label: 'Client secret', secret: true },
  { key: 'TOAST_RESTAURANT_GUID', group: 'toast', label: 'Restaurant GUID', placeholder: '00000000-0000-0000-0000-000000000000' },
  { key: 'TOAST_API_HOST', group: 'toast', label: 'API host (only if Toast gave you another)', placeholder: 'https://ws-api.toasttab.com' },
  { key: 'ADP_CLIENT_ID', group: 'adp', label: 'Client ID (API Central project)', secret: true },
  { key: 'ADP_CLIENT_SECRET', group: 'adp', label: 'Client secret', secret: true },
  { key: 'ADP_CERT_PEM', group: 'adp', label: 'Certificate (the signed .pem ADP returned)', secret: true, multiline: true },
  { key: 'ADP_KEY_PEM', group: 'adp', label: 'Private key (the .key made with the CSR)', secret: true, multiline: true },
  { key: 'ADP_MANAGER_AOID', group: 'adp', label: 'Manager AOID (optional: reads the whole team in one call)', placeholder: 'G3ABC…' },
  { key: 'TRIPLESEAT_CLIENT_ID', group: 'tripleseat', label: 'Client ID (OAuth 2.0 application)', secret: true },
  { key: 'TRIPLESEAT_CLIENT_SECRET', group: 'tripleseat', label: 'Client secret', secret: true },
  { key: 'TRIPLESEAT_LOCATION_ID', group: 'tripleseat', label: 'Location ID (optional: only this venue’s events)', placeholder: '12345' },
  { key: 'TRIPLESEAT_SITE_ID', group: 'tripleseat', label: 'Site ID (optional: when the keys see several sites)', placeholder: '678' },
  { key: 'TRIPLESEAT_WEBHOOK_SECRET', group: 'tripleseat', label: 'Webhook signing key (optional)', secret: true },
  { key: 'TRIPLESEAT_PUBLIC_KEY', group: 'tripleseat', label: 'Old public key (OAuth 1.0, only if Tripleseat still takes it)', secret: true },
  { key: 'TRIPLESEAT_SECRET_KEY', group: 'tripleseat', label: 'Old secret key (OAuth 1.0)', secret: true },
  { key: 'TRIPLESEAT_API_HOST', group: 'tripleseat', label: 'API host (only if Tripleseat gave you another)', placeholder: 'https://api.tripleseat.com' },
  { key: 'TWILIO_MESSAGING_SERVICE_SID', group: 'twilio', label: 'Messaging Service SID (recommended)', placeholder: 'MG…' },
  { key: 'TWILIO_FROM_NUMBER', group: 'twilio', label: 'or From number', placeholder: '+17205550100' },
  { key: 'EMAIL_FROM_NAME', group: 'email', label: 'From name', placeholder: 'Bistro Schedule' },
  { key: 'EMAIL_FROM_ADDRESS', group: 'email', label: 'From address (domain verified in Resend)', placeholder: 'schedule@mail.bistro.com' },
  { key: 'EMAIL_REPLY_TO', group: 'email', label: 'Reply-to (optional)', placeholder: 'manager@bistro.com' },
];
export const SECRET_KEYS = INTEGRATION_FIELDS.filter((f) => f.secret).map((f) => f.key);
export const PLAIN_KEYS = INTEGRATION_FIELDS.filter((f) => !f.secret).map((f) => f.key);

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const CHECKS = {
  TOAST_CLIENT_ID: (v) => /^\S{4,200}$/.test(v) || 'The Toast client ID has no spaces',
  TOAST_CLIENT_SECRET: (v) => /^\S{8,400}$/.test(v) || 'The Toast client secret has no spaces',
  TOAST_RESTAURANT_GUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || 'The restaurant GUID looks like 8-4-4-4-12 hex digits',
  TOAST_API_HOST: (v) => /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(v) || 'The API host is an https:// address',
  ADP_CLIENT_ID: (v) => /^\S{4,200}$/.test(v) || 'The ADP client ID has no spaces',
  ADP_CLIENT_SECRET: (v) => /^\S{8,400}$/.test(v) || 'The ADP client secret has no spaces',
  ADP_CERT_PEM: (v) => (v.length <= 20000 && (/BEGIN CERTIFICATE/.test(v) || /^[A-Za-z0-9+/=\s]{200,}$/.test(v))) || 'Paste the whole certificate, from -----BEGIN CERTIFICATE----- to the end',
  ADP_KEY_PEM: (v) => (v.length <= 20000 && (/BEGIN (?:RSA |EC )?PRIVATE KEY/.test(v) || /^[A-Za-z0-9+/=\s]{200,}$/.test(v))) || 'Paste the whole private key, from -----BEGIN PRIVATE KEY----- to the end',
  ADP_MANAGER_AOID: (v) => /^[A-Za-z0-9]{6,40}$/.test(v) || 'The AOID is letters and numbers only',
  TRIPLESEAT_CLIENT_ID: (v) => /^\S{4,200}$/.test(v) || 'The Tripleseat client ID has no spaces',
  TRIPLESEAT_CLIENT_SECRET: (v) => /^\S{8,400}$/.test(v) || 'The Tripleseat client secret has no spaces',
  TRIPLESEAT_PUBLIC_KEY: (v) => /^\S{4,200}$/.test(v) || 'The Tripleseat public key has no spaces',
  TRIPLESEAT_SECRET_KEY: (v) => /^\S{8,400}$/.test(v) || 'The Tripleseat secret key has no spaces',
  TRIPLESEAT_WEBHOOK_SECRET: (v) => /^\S{8,400}$/.test(v) || 'The webhook signing key has no spaces',
  TRIPLESEAT_SITE_ID: (v) => /^\d{1,12}$/.test(v) || 'The site ID is a number',
  TRIPLESEAT_LOCATION_ID: (v) => /^\d{1,12}$/.test(v) || 'The location ID is a number',
  TRIPLESEAT_API_HOST: (v) => /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(v) || 'The API host is an https:// address',
  TWILIO_MESSAGING_SERVICE_SID: (v) => /^MG[0-9a-f]{32}$/i.test(v) || 'A Messaging Service SID starts with MG and has 34 characters',
  TWILIO_FROM_NUMBER: (v) => /^\+[1-9]\d{7,14}$/.test(v) || 'The From number is in +1… format, like +17205550100',
  EMAIL_FROM_NAME: (v) => (v.length <= 80 && !/[<>"\r\n]/.test(v)) || 'The From name can’t have < > or quotes',
  EMAIL_FROM_ADDRESS: (v) => EMAIL.test(v) || 'The From address isn’t an email address',
  EMAIL_REPLY_TO: (v) => EMAIL.test(v) || 'The reply-to isn’t an email address',
};

/** Trim and validate console input. Returns { plain, secrets } with '' meaning "clear"; throws a 400 on bad input. */
export function cleanIntegrations(input = {}) {
  const plain = {};
  const secrets = {};
  for (const f of INTEGRATION_FIELDS) {
    if (!(f.key in input) || input[f.key] === undefined) continue; // not sent: keep what's there
    const v = String(input[f.key] ?? '').trim();
    if (v) {
      const ok = CHECKS[f.key](v);
      if (ok !== true) { const e = new Error(ok); e.status = 400; throw e; }
    }
    (f.secret ? secrets : plain)[f.key] = v;
  }
  return { plain, secrets };
}

/** "Name <a@b.c>" → { name, address } */
export function parseFrom(from) {
  const s = String(from || '').trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2].trim() };
  return { name: '', address: s };
}
const formatFrom = (name, address) => (name ? `${name.replace(/["<>\r\n]/g, '')} <${address}>` : address);

const TRIPLESEAT_KEYS = INTEGRATION_FIELDS.filter((f) => f.group === 'tripleseat').map((f) => f.key);

/** Variables that belong to one restaurant: another restaurant never inherits them from the platform env. */
const DEFAULT_RESTAURANT_ONLY = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'SEED_DEMO', 'DEMO_PASSWORD', 'EMAIL_FROM', 'EMAIL_REPLY_TO',
  'APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID', 'TOAST_API_HOST',
  'ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM', 'ADP_MANAGER_AOID', ...TRIPLESEAT_KEYS, 'TRIPLESEAT_TOKEN_URL',
  'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_FROM_NUMBER', 'TWILIO_WEBHOOK_URL'];

/** The signing secret for a restaurant other than the default: derived from JWT_SECRET, so it differs per restaurant. */
export const tenantJwtSecret = (jwtSecret, tenantId) => crypto.createHmac('sha256', jwtSecret).update(`shiftboard-tenant:${tenantId}`).digest('hex');

/**
 * @param {object} env      the platform's env (process.env)
 * @param {object} tenant   a registry tenant (registry.js toTenant)
 * @param {object} secrets  decrypted secrets for this tenant ({ TOAST_CLIENT_SECRET: '…' })
 */
export function tenantEnv(env, tenant, secrets = {}) {
  const out = { ...env };
  const plain = tenant.integrations || {};
  const val = (k) => String((SECRET_KEYS.includes(k) ? secrets[k] : plain[k]) || '').trim();

  if (!tenant.is_default) {
    for (const k of DEFAULT_RESTAURANT_ONLY) delete out[k];
    // Without JWT_SECRET each restaurant's schema generates and keeps its own (like the default one does).
    if (env.JWT_SECRET) out.JWT_SECRET = tenantJwtSecret(env.JWT_SECRET, tenant.id);
    else delete out.JWT_SECRET;
  }

  for (const k of ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID', 'TOAST_API_HOST']) if (val(k)) out[k] = val(k);
  for (const k of ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM', 'ADP_MANAGER_AOID']) if (val(k)) out[k] = val(k);
  for (const k of TRIPLESEAT_KEYS) if (val(k)) out[k] = val(k);

  // The sender: a console setting replaces both env values, so the env's Messaging Service can't win over it.
  if (val('TWILIO_MESSAGING_SERVICE_SID') || val('TWILIO_FROM_NUMBER')) {
    out.TWILIO_MESSAGING_SERVICE_SID = val('TWILIO_MESSAGING_SERVICE_SID');
    out.TWILIO_FROM_NUMBER = val('TWILIO_FROM_NUMBER');
  }

  // Email From: the restaurant's address, else (other restaurants) the platform's address under the restaurant's name.
  const current = parseFrom(out.EMAIL_FROM);
  const platformFrom = parseFrom(env.PLATFORM_EMAIL_FROM);
  const address = val('EMAIL_FROM_ADDRESS') || current.address || (tenant.is_default ? '' : platformFrom.address);
  const name = val('EMAIL_FROM_NAME') || current.name || (tenant.is_default ? '' : tenant.name);
  if (address) out.EMAIL_FROM = formatFrom(name, address);
  if (val('EMAIL_REPLY_TO')) out.EMAIL_REPLY_TO = val('EMAIL_REPLY_TO');

  // Features the restaurant doesn't have are switched off at the source too.
  if (tenant.resolved && !tenant.resolved.toast) for (const k of Object.keys(out)) if (k.startsWith('TOAST_')) delete out[k];
  if (tenant.resolved && !tenant.resolved.adp) for (const k of Object.keys(out)) if (k.startsWith('ADP_')) delete out[k];
  if (tenant.resolved && !tenant.resolved.tripleseat) for (const k of Object.keys(out)) if (k.startsWith('TRIPLESEAT_')) delete out[k];
  if (tenant.resolved && !tenant.resolved.sms) for (const k of Object.keys(out)) if (k.startsWith('TWILIO_')) delete out[k];
  return out;
}

/** What the console shows for a restaurant's integrations: plain values, and only set/last-4 for secrets. */
export function integrationsView(tenant, secretView, env = process.env) {
  const fields = INTEGRATION_FIELDS.map((f) => (f.secret
    ? { ...f, set: !!secretView[f.key]?.set, last4: secretView[f.key]?.last4 || '' }
    : { ...f, value: String(tenant.integrations?.[f.key] || '') }));
  // What the restaurant actually uses (names of env fallbacks only, never values).
  const e = tenantEnv(env, { ...tenant, resolved: { toast: true, adp: true, tripleseat: true, sms: true } },
    Object.fromEntries(SECRET_KEYS.filter((k) => secretView[k]?.set).map((k) => [k, 'set'])));
  return {
    fields,
    effective: {
      toast: ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID'].every((k) => e[k]),
      adp: ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM'].every((k) => e[k]),
      tripleseat: ['TRIPLESEAT_CLIENT_ID', 'TRIPLESEAT_CLIENT_SECRET'].every((k) => e[k]) || ['TRIPLESEAT_PUBLIC_KEY', 'TRIPLESEAT_SECRET_KEY'].every((k) => e[k]),
      sms: !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_MESSAGING_SERVICE_SID || e.TWILIO_FROM_NUMBER)),
      smsAccount: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
      email: !!(env.RESEND_API_KEY && e.EMAIL_FROM),
      emailFrom: e.EMAIL_FROM || '',
      envFallback: !!tenant.is_default,
    },
  };
}
