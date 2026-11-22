// The platform console's API client: /api/platform/* (server/platform/console.js).
export class ConsoleError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/platform${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ConsoleError(res.status, data.error || `Request failed (${res.status})`, data.field);
  return data.result ?? data;
}

export const money = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
/** 'YYYY-MM-DD' for a date input, in local time. */
export const dateInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** End of that day, local time, as ISO. */
export const fromDateInput = (v) => (v ? new Date(`${v}T23:59:00`).toISOString() : null);
