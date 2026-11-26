// "Read it with AI" for a BEO PDF that isn't Tripleseat's layout (server/beo-ai-routes.js). The web app sends the
// PDF's text and gets back events in the BEO section model, already cleaned (money stripped) by the server; nothing
// is saved until the import preview's Import. Errors carry the AI's reason (no_key, off, plan, cap, busy…).
import { ApiError } from './api.js';
import { getLang } from './i18n/index.js';

export async function readBeoWithAi(text) {
  const res = await fetch('/api/events/read-beo', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() },
    body: JSON.stringify({ text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new ApiError(res.status, data.error || `Request failed (${res.status})`), { reason: data.reason || null });
  return data.events || [];
}
