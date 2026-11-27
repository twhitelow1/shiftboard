// "Import from a calendar page", the part that needs the network (server/calendar/web-calendar.js reads the page);
// what it becomes and the import itself are RPCs (core/calendar-import.js: programming.calendar.get / apply / forget).
//
//   POST /api/programming/calendar/read  { url?, remember? } → { source, rooms, import }: the page read now, kept as
//        the person's latest read, with its suggestions. No url: the remembered page ("Check for new events").
//        Managers with Edit programming (Roles & features) only; nothing is saved besides the read itself (and, with
//        remember, the page's address).
// The same reading is what Ask ShiftBoard's read_events_calendar tool uses (createCalendarReading().read), with the AI
// as the last resort for a page with no feed or structured data (purpose 'import_calendar', the restaurant's cap).
//
// Test-only: createApp({ calendarReader: { transport, lookup, allowHosts } }) swaps the network for a fake, or lets a
// local stub host through the private-address guard. Never read from the environment or a request.
import { createService } from '../../core/service.js';
import { langOf } from '../../core/i18n.js';
import { ROLE_OFF } from '../../core/role-features.js';
import { translateError } from '../../core/errors.js';
import { keepCalendarRead, canImportCalendar, SOURCES } from '../../core/calendar-import.js';
import { todayOf } from '../tools/dates.js';
import { aiFor } from '../ai/index.js';
import { readCalendarPage, CalendarError, calendarErrorText } from './web-calendar.js';

const NOTES = {
  ai_cap: ['This month’s AI allowance is used up, so only calendars with a feed or structured data can be read.', 'Ya se usó la asignación de IA de este mes, así que solo se pueden leer calendarios con feed o datos estructurados.'],
  ai_off: ['AI reading isn’t set up, so only calendars with a feed or structured data can be read.', 'La lectura con IA no está configurada, así que solo se pueden leer calendarios con feed o datos estructurados.'],
};

/**
 * @param o { db, env, tenant, now, aiClient?, reader? (test-only: { transport, lookup, allowHosts }) }
 * @returns { read(user, { url, remember, lang, ai }) → { source, rooms, import } }  (throws CalendarError / AppError)
 */
export function createCalendarReading({ db, env, tenant = null, now = () => Date.now(), aiClient = null, reader = {} }) {
  const aiOf = (lang) => {
    try { return aiFor({ db, tenant, env, now, lang, ...(aiClient ? { client: aiClient({ apiKey: env.ANTHROPIC_OWN_API_KEY || env.ANTHROPIC_API_KEY }) } : {}) }); } catch { return null; }
  };
  const allowHosts = reader.allowHosts ? new Set([...reader.allowHosts].map((h) => String(h).toLowerCase())) : null;
  async function read(user, { url = '', remember = false, lang = 'en', ai = true } = {}) {
    await db.sync();
    const target = String(url || '').trim() || db.store.get(SOURCES, 'main')?.url || '';
    if (!target) throw new CalendarError('noUrl', calendarErrorText('noUrl', lang));
    let r;
    try {
      r = await readCalendarPage(target, { today: todayOf(now()), ai: ai ? aiOf(lang) : null, user, transport: reader.transport, lookup: reader.lookup, allowHosts });
    } catch (e) {
      if (e instanceof CalendarError) {
        const note = (e.notes || []).find((n) => NOTES[n]);
        throw Object.assign(new CalendarError(e.code, `${calendarErrorText(e.code, lang)}${note ? ` ${NOTES[note][lang === 'es' ? 1 : 0]}` : ''}`), { notes: e.notes || [] });
      }
      throw e;
    }
    const at = new Date(now()).toISOString();
    return db.run((store) => {
      const actor = store.get('users', user.id);
      const svc = createService(store);
      if (!actor || !canImportCalendar(actor, svc.settings())) throw Object.assign(new Error(ROLE_OFF), { status: 403 });
      const id = keepCalendarRead(store, actor, { read: r, remember, at });
      return svc.call(actor, 'programming.calendar.get', { id });
    }, { write: true });
  }
  return { read };
}

/** The route. d: { db, calendar (createCalendarReading), userOf(req) } */
export function mountCalendarImport(app, { db, calendar, userOf }) {
  app.post('/api/programming/calendar/read', async (req, res) => {
    let lang = 'en';
    try {
      if (req.sbView) return res.status(403).json({ error: 'View as is read-only', viewAs: true });
      await db.sync();
      const u = userOf(req);
      if (!u) return res.status(401).json({ error: 'Please sign in' });
      const settings = createService(db.store).settings();
      lang = langOf(u, settings);
      if (!canImportCalendar(u, settings)) return res.status(403).json({ error: translateError(ROLE_OFF, lang) });
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await calendar.read(u, { url: typeof b.url === 'string' ? b.url.slice(0, 2000) : '', remember: b.remember === true, lang });
      res.set('Cache-Control', 'no-store').json({ result: out });
    } catch (e) {
      if (e instanceof CalendarError) return res.status(400).json({ error: e.message, reason: e.code });
      if (e.status && e.status < 500) return res.status(e.status).json({ error: translateError(e.message, lang) });
      console.error('Calendar page import failed:', e.message);
      res.status(500).json({ error: 'Something went wrong' });
    }
  });
}
