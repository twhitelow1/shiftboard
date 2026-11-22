// Settings → Integrations: the restaurant's own connection settings (server/integrations-routes.js).
// The demo has no server, so every integration shows as "not in the demo".
import { IS_DEMO, ApiError } from './api.js';
import { getLang } from './i18n/index.js';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-ShiftBoard-Language': getLang() }, // errors come back in this language
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data.result;
}

const DEMO_GROUPS = ['adp', 'toast', 'tripleseat', 'twilio', 'email'];

/**
 * { mode: 'platform' | 'env' | 'demo', editable, encryption, envFallback,
 *   groups: [{ key, status, missing, fields: [{ key, secret, multiline, placeholder, set, last4, value, fromEnv }], from? }] }
 */
export async function getIntegrations() {
  if (IS_DEMO) return { mode: 'demo', editable: false, encryption: false, envFallback: false, groups: DEMO_GROUPS.map((key) => ({ key, status: 'demo', missing: [], fields: [] })) };
  return request('/api/integrations');
}

/** Save some fields ({ KEY: value }, '' clears a value). Returns the new view plus { changed }. */
export async function saveIntegrations(values) {
  if (IS_DEMO) throw new ApiError(400, 'Integrations work in the hosted app');
  return request('/api/integrations', { method: 'PUT', body: values });
}
