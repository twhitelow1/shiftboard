// The Claude connector's web calls (server/mcp/): the consent screen, Connected apps, and Settings → Claude connector.
// Hosted app only; the demo shows a note instead.
import { ApiError } from './api.js';
import { getLang } from './i18n/index.js';

async function send(path, body, { method = 'POST' } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new ApiError(res.status, data.error || `Request failed (${res.status})`), { code: data.code || null });
  return data.result ?? data;
}

/** What the consent screen shows for a signed authorization request (r from #/authorize?r=…). */
export const authRequest = (r) => send(`/api/oauth/request?r=${encodeURIComponent(r)}`, null, { method: 'GET' });
/** Allow or Deny: { redirect } back to Claude. */
export const decide = (r, allow, readOnly) => send('/api/oauth/decide', { r, allow, readOnly });

export const myConnections = () => send('/api/mcp/connections', null, { method: 'GET' });
export const revokeConnection = (id) => send(`/api/mcp/connections/${encodeURIComponent(id)}/revoke`, {});

export const connectorSettings = () => send('/api/mcp/settings', null, { method: 'GET' });
export const saveConnectorSettings = (patch) => send('/api/mcp/settings', patch);
