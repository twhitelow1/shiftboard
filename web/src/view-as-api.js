// View as, for the web app: start, stop, and the people/roles/positions/rooms to pick from. The hosted app asks
// the server (server/view-as.js, which keeps the view in its own short-lived cookie); the demo does the same in
// the browser with the same rules (core/view-as.js), on its in-memory data.
import { IS_DEMO, ApiError, demoData, DEMO_NOW } from './api.js';
import { resolveTarget, viewOptions, viewInfo, viewAudit, VIEW_MINUTES, AUDIT_START, AUDIT_STOP } from '../../core/view-as.js';
import { cleanDraft } from '../../core/role-features.js';
import { scheduleAreas } from '../../core/areas.js';
import { createService } from '../../core/service.js';
import { todayStr } from '../../core/time.js';
import { getLang, translateError } from './i18n/index.js';

async function send(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || translateError(`Request failed (${res.status})`));
  return data.result ?? data;
}

/** In the demo: run it, with the server's errors (translated like the demo's other calls). */
function demo(fn) {
  const d = demoData();
  try {
    return Promise.resolve(JSON.parse(JSON.stringify(fn(d, d.store.get('users', d.userId)) ?? null)));
  } catch (e) {
    return Promise.reject(new ApiError(e.status || 500, translateError(e.message)));
  }
}
const areasOf = (store) => { const st = createService(store).settings(); return st.areas?.length ? st.areas : scheduleAreas(st); };

/** { people, roles, positions, rooms, minutes } */
export const viewAsOptions = () => (IS_DEMO
  ? demo((d, real) => viewOptions(d.store, real, { areas: areasOf(d.store) }))
  : send('GET', '/api/view-as/options'));

/** ask: { userId } or { role, positions?, rooms?, typical? }, plus draft (unsaved Roles & features) for a preview. */
export const startViewAs = (ask) => (IS_DEMO
  ? demo((d, real) => {
    const target = resolveTarget(d.store, real, ask, { today: todayStr(DEMO_NOW) });
    const draft = ask.draft ? cleanDraft(ask.draft) : null;
    const until = Date.now() + VIEW_MINUTES * 60_000;
    d.view = { target, draft, until };
    viewAudit(d.store, { action: AUDIT_START, real, target, at: new Date().toISOString(), details: { until: new Date(until).toISOString(), draft: !!draft } });
    return viewInfo(d.store, real, target, { until, draft, lang: getLang() });
  })
  : send('POST', '/api/view-as/start', ask));

export const stopViewAs = () => (IS_DEMO
  ? demo((d, real) => {
    if (d.view) viewAudit(d.store, { action: AUDIT_STOP, real, target: d.view.target, at: new Date().toISOString(), details: { reason: 'exit' } });
    d.view = null;
    return { ok: true };
  })
  : send('POST', '/api/view-as/stop', {}));

// Where Exit view goes back to, and a Roles & features draft waiting for its editor (this tab only).
const KEY = 'sb.viewAs';
export function rememberReturn(hash, draft = null) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ hash, draft })); } catch { /* private mode: Exit goes home */ }
}
export function takeReturn() {
  try { const v = JSON.parse(sessionStorage.getItem(KEY) || 'null'); sessionStorage.removeItem(KEY); return v; } catch { return null; }
}
export function peekDraft() {
  try { return JSON.parse(sessionStorage.getItem(`${KEY}.draft`) || 'null'); } catch { return null; }
}
export function keepDraft(draft) {
  try { if (draft) sessionStorage.setItem(`${KEY}.draft`, JSON.stringify(draft)); else sessionStorage.removeItem(`${KEY}.draft`); } catch { /* not kept */ }
}
