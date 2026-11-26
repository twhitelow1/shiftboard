// Floor plan imports that need the server (server/venue-import-routes.js): Toast's tables and the AI reading a
// picture. The demo build has no server, so both show as "works in the hosted app"; CSV imports work everywhere.
import { IS_DEMO, ApiError } from './api.js';
import { getLang } from './i18n/index.js';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-ShiftBoard-Language': getLang() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data.result;
}

/** { toast: { available, reason? }, ai: { available, reason? } }; reason 'demo' in the demo. */
export async function importStatus() {
  if (IS_DEMO) return { toast: { available: false, reason: 'demo' }, ai: { available: false, reason: 'demo' } };
  return request('/api/venue/import/status');
}

/** Toast's tables, service areas and revenue centers: { toast: { tables, serviceAreas, revenueCenters } }. */
export const readToast = () => request('/api/venue/import/toast', { method: 'POST', body: {} });

/** The AI's reading of a picture: { available, reason?, read: { width, height, items, notes } }. */
export const readPicture = ({ image, mediaType, width, height }) => request('/api/venue/import/image', { method: 'POST', body: { image, mediaType, width, height } });
