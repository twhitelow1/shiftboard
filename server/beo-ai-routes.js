// "Read it with AI": a BEO that isn't laid out like Tripleseat's (core/beo-import.js finds no structure in it).
//
//   POST /api/events/read-beo   { text, fileName? } → { events: [cleaned BEO] }, or { error, reason } when the AI can't run
//
// The web app sends the PDF's text (core/beo-import.js beoText), the AI answers strict JSON in the BEO section model
// (core/beo-sections.js), and every event goes through cleanBeoEvent, the same validation a PDF import gets: known
// fields only, money stripped again. Nothing is saved here: the events go back to the import preview, which runs the
// same duplicate checks (events.importBeos dryRun) before anyone imports. Managers and the events team only, on a
// plan with Events & BEOs; metered and capped per restaurant like every AI call (server/ai/).
import { canManageEvents } from '../core/roles.js';
import { roleAllows } from '../core/role-features.js';
import { createService } from '../core/service.js';
import { cleanBeoEvent, beoWarnings } from '../core/beo-import.js';
import { SECTION_KEYS, SECTION_KINDS } from '../core/beo-sections.js';
import { SERVICE_STYLES } from '../core/beo.js';
import { aiFor, AiUnavailable } from './ai/index.js';

const MAX_TEXT = 60_000;
const FIELD_SECTIONS = ['timeline', 'menu']; // these have their own fields

export const BEO_SYSTEM = `You read Banquet Event Orders (BEOs) for a restaurant's events team and return them as strict JSON.

Return ONLY a JSON object, no prose and no code fences:
{"events":[{ ...one object per event in the document... }]}

Each event object may have these fields; leave out anything the document doesn't say (never guess, never invent):
- "name": the event's name. "date": "YYYY-MM-DD". "start", "end": guest arrival and end, "HH:MM" 24-hour.
- "guestCount" and "guaranteed": whole numbers. "type": the event type as written. "serviceStyle": one of ${Object.keys(SERVICE_STYLES).join(', ')} when the food service clearly is one.
- "areas": the rooms or spaces as written. "location": the venue as written.
- "client", "contactName", "contactPhone", "contactEmail": the client and their contact. "salesManager", "eventManager".
- "invoiceNumber" (letters, digits, dashes), "tripleseatId" (only if the document shows a Tripleseat event id), "beoUpdatedAt" ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", the document's last-updated stamp).
- "menu": [{"course","item","notes","qty","dietary":["GF","V",...]}] in the order written; "notes" is the item's description and serving notes.
- "beverage": {"package","bar","notes"}; "specialDrinks": [{"name","recipe","notes"}] (recipe lines separated by "\\n").
- "timeline": [{"time":"HH:MM","end":"HH:MM","item"}] only rows that have a real time.
- "dietaryNotes": dietary and allergy counts and notes, one per line ("3 gluten free", "nut allergy table 4").
- "arrivalNotes", "setupNotes" (room setup, seating, floor plan), "avNotes", "specialInstructions", "contactNotes" (host and on-site contacts): text, one note per line.
- "sections": everything else the document says, so nothing is lost: [{"key","title","kind","items"}]
  key: one of ${SECTION_KEYS.filter((k) => !FIELD_SECTIONS.includes(k)).join(', ')} ("vendors" for vendor names, arrival times and their contacts; "staffing" for staff requested; "kitchen" for kitchen notes; "decor" for linens, decor and florals; "rentals" for rentals and equipment; "parking" for parking and coat check; "signatures" for who signed and when; "other" for anything else).
  title: the heading as written. kind: one of ${SECTION_KINDS.filter((k) => !FIELD_SECTIONS.includes(k)).join(', ')}.
  items: for "list" and "text", strings; for "keyvalue", [{"label","value"}] with labels as written.

Rules:
- NO MONEY: leave out every price, total, subtotal, tax, gratuity, service charge, fee, deposit, payment, balance, minimum spend, card or billing detail and billing address. Never include a dollar amount.
- Keep the document's own words and language. Do not translate, summarize or reword.
- One object per event; if the document has several BEOs, return each.`;

/** The JSON in a reply (the object, even if the model wrapped it in a code fence or a sentence). */
export function jsonFrom(reply) {
  const s = String(reply || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch { /* look for the object */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* not JSON */ } }
  return null;
}

/** The AI's events, cleaned exactly like a PDF import's (and timeline/menu sections folded out: they're fields). */
export function eventsFromReply(reply) {
  const data = jsonFrom(reply);
  const list = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : data && typeof data === 'object' && data.name ? [data] : null;
  if (!list) return null;
  return list.slice(0, 60).map((raw) => {
    const e = cleanBeoEvent({ ...raw, sections: (raw?.sections || []).filter((s) => !FIELD_SECTIONS.includes(s?.key)) });
    return { ...e, sections: e.sections, warnings: beoWarnings(e), pages: null, via: 'ai' };
  }).filter((e) => e.name || e.date || e.menu.length || e.sections.length);
}

/**
 * @param app  the restaurant's Express app
 * @param d    { db, env, tenant, now, has(feature), userOf(req), planFeatures(), aiClient? }
 */
export function mountBeoAi(app, d) {
  app.post('/api/events/read-beo', async (req, res) => {
    try {
      await d.db.sync();
      const user = d.userOf(req);
      if (!user) return res.status(401).json({ error: 'Please sign in' });
      if (!canManageEvents(user)) return res.status(403).json({ error: 'Events team or managers only' });
      const settings = createService(d.db.store).settings();
      if (!d.has('events') || roleAllows(user, settings).events === false) return res.status(403).json({ error: 'Events aren’t included in this restaurant’s plan' });
      const text = String(req.body?.text || '').slice(0, MAX_TEXT);
      if (!text.trim()) return res.status(400).json({ error: 'That PDF has no text to read' });
      const lang = user.language === 'es' || user.language === 'en' ? user.language : settings.language === 'es' ? 'es' : 'en';
      const ai = aiFor({ db: d.db, tenant: d.tenant, env: d.env, now: d.now, lang, ...(d.aiClient ? { client: d.aiClient({ apiKey: d.env.ANTHROPIC_OWN_API_KEY || d.env.ANTHROPIC_API_KEY }) } : {}) });
      if (!ai.available) return res.status(503).json({ error: 'ai_unavailable', reason: ai.reason });
      let reply;
      try {
        reply = await ai.complete({ purpose: 'beo_import', system: BEO_SYSTEM, messages: [{ role: 'user', content: `The BEO document's text, line by line (cells separated by "|"):\n\n${text}` }], maxTokens: 8000, user, lang });
      } catch (e) {
        if (e instanceof AiUnavailable) return res.status(503).json({ error: 'ai_unavailable', reason: e.reason });
        throw e;
      }
      const events = eventsFromReply(reply.text);
      if (!events) return res.status(502).json({ error: 'ai_unreadable', reason: reply.stopReason === 'max_tokens' ? 'long' : 'json' });
      res.json({ events });
    } catch (e) {
      console.error('Read BEO with AI failed:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
    }
  });
}
