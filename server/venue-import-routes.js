// Importing a floor plan, the parts that need the network: Toast's tables and the AI reading a picture.
// Mounted by server/app.js; the plan's `venue` feature gates /api/venue (ROUTE_FEATURES), and Roles & features too.
// Neither route saves anything: each answers with what it read, and the browser previews and applies it with
// the venue.importPreview and venue.importApply RPCs (core/floor-import.js), which write the audit log entry.
//   GET  /api/venue/import/status  managers: { toast: { available, reason? }, ai: { available, reason? } }
//   POST /api/venue/import/toast   managers: Toast's tables, service areas and revenue centers (server/toast.js floorConfig)
//   POST /api/venue/import/image   managers: { image (base64), mediaType, width, height } → { available, read }
//                                  read: { width, height, items, notes } in plan units (core/floor-import.js readAiPlan)
// Toast can't take a floor plan from another app (no write API): docs/integrations/TOAST-FLOOR-PLAN.md.
import { canManageSchedule } from '../core/roles.js';
import { uid } from '../core/store.js';
import { readAiPlan, AI_SCHEMA } from '../core/floor-import.js';
import { createToastClient, toastConfig, ToastError } from './toast.js';
import { aiFor, AiUnavailable } from './ai/index.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_CHARS = 1_900_000; // base64; the browser shrinks pictures well under this (and the JSON limit is 2 MB)

/** What the AI is told. It answers with JSON only; coordinates 0–1000 across the picture, each axis on its own. */
export const FLOOR_SYSTEM = [
  'You read restaurant floor plans: screenshots of a POS table layout (such as Toast), printed or hand-drawn plans, and photos of them.',
  'Find every table, booth, high-top and bar, and the room\'s walls, dividers, doors and fixtures (host stand, kitchen door, restroom, stage, dance floor, DJ booth).',
  'Coordinates: the picture is a 0–1000 grid across its width and a separate 0–1000 grid down its height. x and y are the top-left of each thing\'s box, w and h its size, all on that grid.',
  'Tables: kind "table" with shape round, square or rectangle; "booth" for booths and banquettes; "high-top" for high-top or cocktail tables; "bar" for a bar counter, with seats = the stools along it (never list stools one by one).',
  'label is the table number or name exactly as written ("12", "T4", "B2"); "" if none. seats: chairs you can count or a number written on it; null if you can\'t tell.',
  'Walls: one item per straight wall segment. Text in the picture that names a place ("Patio", "Kitchen") is a "label" item unless it marks a fixture.',
  'Answer with one JSON object and nothing else: { "room": ' + AI_SCHEMA.room + ', "items": ' + AI_SCHEMA.items + ', "notes": ' + AI_SCHEMA.notes + ' }.',
].join('\n');

/**
 * @param {import('express').Express} app
 * @param {object} o  { db, env, tenant, has(feature), userOf(req), now, aiClient? ({ apiKey }) => Anthropic client (tests), toastFetch? }
 */
export function mountVenueImport(app, { db, env, tenant = null, has = () => true, userOf, now = () => Date.now(), aiClient = null, toastFetch = null }) {
  const iso = () => new Date(now()).toISOString();
  const manager = async (req, res) => {
    await db.sync();
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canManageSchedule(u)) { res.status(403).json({ error: 'Managers only' }); return null; }
    res.set('Cache-Control', 'no-store');
    return u;
  };
  const audit = (actorId, action, details) => db.run((s) => s.insert('auditLog', { id: uid('aud'), at: iso(), actorId, targetId: null, action, details }), { write: true }).catch(() => {});
  const ai = (lang) => aiFor({ db, tenant, env, now, lang, ...(aiClient ? { client: aiClient({ apiKey: env.ANTHROPIC_OWN_API_KEY || env.ANTHROPIC_API_KEY }) } : {}) });
  const toastState = () => {
    if (!has('toast')) return { available: false, reason: 'plan' };
    return toastConfig(env).configured ? { available: true } : { available: false, reason: 'notConnected' };
  };

  app.get('/api/venue/import/status', async (req, res) => {
    if (!(await manager(req, res))) return;
    let a;
    try { a = ai(); } catch { a = { available: false, reason: 'off' }; }
    res.json({ result: { toast: toastState(), ai: { available: !!a.available, ...(a.available ? {} : { reason: a.reason || 'off' }) } } });
  });

  app.post('/api/venue/import/toast', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const st = toastState();
    if (!st.available) {
      return res.status(400).json({ error: st.reason === 'plan' ? 'Not included in your plan' : 'Toast isn’t connected yet. Connect it in Settings → Integrations, or import a picture or CSV instead.' });
    }
    try {
      const toast = await createToastClient({ env, ...(toastFetch ? { fetch: toastFetch } : {}) }).floorConfig();
      await audit(u.id, 'venue.importRead', { source: 'toast', tables: toast.tables.length, serviceAreas: toast.serviceAreas.length });
      res.json({ result: { toast } });
    } catch (e) {
      if (!(e instanceof ToastError)) console.error('Toast floor plan read failed:', e);
      res.status(502).json({ error: e instanceof ToastError ? e.message : 'Toast didn’t answer. Try again in a minute.' });
    }
  });

  app.post('/api/venue/import/image', async (req, res) => {
    const u = await manager(req, res);
    if (!u) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const mediaType = String(b.mediaType || '');
    const data = String(b.image || '').replace(/^data:[^;]+;base64,/, '');
    if (![...IMAGE_TYPES, 'application/pdf'].includes(mediaType) || !data || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) {
      return res.status(400).json({ error: 'Pick a picture (PNG, JPG, WebP) or a PDF of the floor plan' });
    }
    if (data.length > MAX_IMAGE_CHARS) return res.status(413).json({ error: 'That picture is too large. Try a smaller one or a screenshot.' });
    const lang = u.language === 'es' ? 'es' : 'en';
    const a = ai(lang);
    if (!a.available) return res.json({ result: { available: false, reason: a.reason || 'off' } });
    const block = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    try {
      const r = await a.complete({
        purpose: 'floor_plan_import', system: FLOOR_SYSTEM, maxTokens: 12000, effort: 'medium', user: { id: u.id },
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Read this floor plan. JSON only.' }] }],
      });
      const read = readAiPlan(r.text, { imageWidth: Number(b.width) || 1000, imageHeight: Number(b.height) || 700 });
      await audit(u.id, 'venue.importRead', { source: 'image', items: read?.items.length || 0, stopReason: r.stopReason || null });
      if (!read) return res.status(502).json({ error: 'The AI couldn’t read a floor plan in that picture. Try a clearer one, or a CSV.' });
      res.json({ result: { available: true, read, truncated: r.stopReason === 'max_tokens' } });
    } catch (e) {
      if (e instanceof AiUnavailable && ['no_key', 'off', 'cap', 'plan'].includes(e.reason)) {
        return res.json({ result: { available: false, reason: e.reason, message: e.message } });
      }
      if (e instanceof AiUnavailable) return res.status(e.status || 503).json({ error: e.message });
      console.error('Floor plan picture import failed:', e);
      res.status(502).json({ error: 'The AI couldn’t read that picture. Try again, or import a CSV.' });
    }
  });
}
