// Ask ShiftBoard's file imports: a manager attaches any document in the chat, ShiftBoard works out what it is and
// routes it into the right import with a preview. Never applied directly: the card offers "Review & import" (the
// target's own wizard, pre-loaded at its preview) and, when the preview has no possible duplicates and no problems,
// "Import now", which shows the usual Confirm / Cancel card; only that tap applies, through the target's own apply.
//
//   POST /api/assistant/files              { file, message?, conversationId?, importId?, target?, part? }
//        file: { name, type, size, text | data (base64) | sheets | items (pdf.js) } (core/import-detect.js)
//        → { conversationId, userMessage?, message, more?: { importId, part } }: the reply with its import card.
//        A long document read by AI comes in parts: while `more` is set the app sends the same file again with
//        { importId, part }. { importId, target } reads it again as another kind of file (the manager's pick).
//   GET  /api/assistant/imports/:id        what "Review & import" pre-loads: { target, wizard, fileName, payload }
//   POST /api/assistant/imports/:id/propose { conversationId } → the message with an "Import now" confirm card
//   Confirm on that card: POST /api/assistant/actions/:id (server/assistant/index.js) → applyImport() here.
//
// The file itself is never stored: it's read in the request. What it was read into (records, events, tables) is
// kept with the card (collection assistantImports, the person's own) until it's imported or a day old, so Import now
// and Review & import work without sending it again. Classification: local signals first (the registry's detect),
// a short AI call only when they aren't sure (server/assistant/import-ai.js), all metered like any AI call.
import { uid } from '../../core/store.js';
import { extractDocument, levelOf } from '../../core/import-detect.js';
import { importTargets, importTarget } from './import-registry.js';
import { classifyWithAi } from './import-ai.js';
import * as H from './history.js';

export const IMPORT_TOOL = 'import_file';
export const IMPORTS = 'assistantImports';
const KEEP_MS = 24 * 3600_000;
const SURE_AT = 70; // a local score this high (and well ahead of the next) needs no AI
const AHEAD_BY = 15;
const CERTAIN_AT = 90; // a structure only one kind of file has (a Tripleseat BEO's layout): sure whatever else matches

const L = (lang, en, es) => (lang === 'es' ? es : en);
const LEVEL = { high: ['high', 'alta'], medium: ['medium', 'media'], low: ['low', 'baja'] };
const FILE_ERRORS = {
  type: ['I can read PDF, Word (.docx), Excel (.xlsx), CSV and pictures. Save it as one of those and attach it again.', 'Puedo leer PDF, Word (.docx), Excel (.xlsx), CSV e imágenes. Guárdalo en uno de esos formatos y adjúntalo de nuevo.'],
  empty: ['That file looks empty. Check it and attach it again.', 'Ese archivo parece vacío. Revísalo y adjúntalo de nuevo.'],
  unreadable: ['I couldn’t open that file. Save it again (or as a CSV) and attach it.', 'No pude abrir ese archivo. Guárdalo de nuevo (o como CSV) y adjúntalo.'],
  tooBig: ['That file is too big for the chat. Use the import on its page instead.', 'Ese archivo es demasiado grande para el chat. Usa la importación de su página.'],
};
const AI_NOTE = {
  off: ['AI reading isn’t set up for your restaurant, so I used ShiftBoard’s own readers.', 'La lectura con IA no está configurada en tu restaurante, así que usé los lectores de ShiftBoard.'],
  cap: ['This month’s AI allowance is used up, so I used ShiftBoard’s own readers.', 'Ya se usó la asignación de IA de este mes, así que usé los lectores de ShiftBoard.'],
};

/** What a target is called, in the person's language. */
const labelOf = (t, lang) => (t ? t.label[lang === 'es' ? 'es' : 'en'] || t.label.en : '');

/**
 * @param app  the restaurant's Express app
 * @param d    the assistant's helpers (server/assistant/index.js): { db, now, iso, person(req, res), blocked(user),
 *             toolsFor(req, user, { write }), ai(lang), hasFor(user), langFor(user), refuse(res, why, lang) }
 */
export function mountAssistantImports(app, d) {
  const { db } = d;

  /** The person's import (or null). */
  const importOf = (store, userId, id) => { const x = id ? store.get(IMPORTS, String(id)) : null; return x && x.userId === userId ? x : null; };

  /** Everything a target needs to read, preview and apply as this person. */
  function contextFor(req, user, lang, { write = false, fileName = '' } = {}) {
    const { ctx } = d.toolsFor(req, user, { write });
    const ai = d.ai(lang);
    const x = { ctx, ai, user, lang, fileName, hint: '', offset: 0, aiNote: AI_NOTE[ai.reason === 'cap' ? 'cap' : 'off'][lang === 'es' ? 1 : 0] };
    x.noteAi = (e) => { x.aiFailed = e?.reason || 'api'; x.aiNote = AI_NOTE[e?.reason === 'cap' ? 'cap' : 'off'][lang === 'es' ? 1 : 0]; };
    // A write as the person, in one transaction with an audit entry that says it came from the assistant.
    x.write = (method, args) => Object.assign(Object.create(ctx), { tool: IMPORT_TOOL, args: { target: x.target, fileName } }).write(method, args);
    return x;
  }

  /** What it is: local signals first, then the AI when they aren't sure. */
  async function classify(doc, x, { hint, mayAny }) {
    const scores = importTargets().map((t) => {
      let score = 0;
      try { score = Number(t.detect(doc, { hint })) || 0; } catch { score = 0; }
      return { id: t.id, score: Math.max(0, Math.min(100, Math.round(score))) };
    }).sort((a, b) => b.score - a.score);
    let [top] = scores;
    const unsure = !top || top.score < SURE_AT || (top.score < CERTAIN_AT && scores[1] && top.score - scores[1].score < AHEAD_BY);
    let how = 'local';
    if (unsure && mayAny && x.ai.available) {
      const r = await classifyWithAi(doc, importTargets().map((t) => ({ id: t.id, about: t.about || labelOf(t, 'en') })), x);
      if (r?.type) { top = { id: r.type, score: { high: 90, medium: 70, low: 50 }[r.confidence] }; how = 'ai'; }
      else if (r && !r.type) top = { id: null, score: 0 };
    }
    if (!top?.id || !top.score) return { target: null, confidence: null, how, scores: scores.slice(0, 5) };
    return { target: top.id, score: top.score, confidence: levelOf(top.score), how, scores: scores.slice(0, 5) };
  }

  /** The card the chat shows, from the import's state. */
  function cardOf(imp, lang, user, has) {
    const t = importTarget(imp.target);
    const allowed = importTargets().filter((x) => x.allowed(user, has));
    const may = !!t && allowed.some((x) => x.id === t.id);
    const p = imp.preview;
    return {
      id: imp.id, fileName: imp.name, kind: imp.kind, status: imp.status, target: imp.target || null, label: labelOf(t, lang),
      confidence: imp.confidence || null, how: imp.how || 'local',
      choices: allowed.filter((x) => x.id !== imp.target).map((x) => ({ id: x.id, label: labelOf(x, lang) })),
      ...(imp.status === 'reading' ? { progress: { part: imp.part || 0, parts: imp.parts || 0 } } : {}),
      ...(p ? { summary: { line: p.line, details: p.details || [], counts: p.counts } } : {}),
      wizard: may ? t.wizard : null, ...(may && t.needsFile ? { needsFile: true } : {}),
      canImportNow: !!(may && t.importNow && p && imp.status === 'ready' && !p.checks && !p.problems && p.toImport > 0),
      ...(p && (p.checks || p.problems) ? { needsReview: true } : {}),
      ...(imp.lowConfidence ? { lowConfidence: imp.lowConfidence } : {}),
      notes: imp.notes || [], ...(imp.result ? { result: imp.result } : {}),
      ...(t && !may ? { refused: L(lang, 'Only managers can import this.', 'Solo los gerentes pueden importar esto.') } : {}),
      ...(imp.source ? { source: imp.source } : {}),
    };
  }

  /** The words above the card. */
  function replyText(imp, lang, card) {
    const t = importTarget(imp.target);
    if (!t) return L(lang, `I’m not sure what “${imp.name}” is. Pick what to import it as:`, `No estoy seguro de qué es “${imp.name}”. Elige cómo importarlo:`);
    const lvl = LEVEL[imp.confidence]?.[lang === 'es' ? 1 : 0];
    const phrase = t.phrase?.[lang === 'es' ? 'es' : 'en'] || card.label;
    const what = L(lang, `This looks like **${phrase}**${lvl ? ` (${lvl})` : ''}.`, `Esto parece **${phrase}**${lvl ? ` (confianza ${lvl})` : ''}.`);
    if (card.refused) return `${what} ${card.refused}`;
    if (imp.forced) return L(lang, `Reading it as ${phrase}, as you picked.`, `Lo leo como ${phrase}, como elegiste.`);
    return `${what} ${card.choices.length ? L(lang, 'Not right? Pick another type below.', '¿No es eso? Elige otro tipo abajo.') : ''}`.trim();
  }

  function saveCard(store, imp, lang, user, has) {
    const card = cardOf(imp, lang, user, has);
    return H.updateMessage(store, { userId: imp.userId, chatId: imp.chatId, messageId: imp.messageId, patch: { text: replyText(imp, lang, card), import: card } });
  }

  // ---------- attach a file ----------
  app.post('/api/assistant/files', async (req, res) => {
    try {
      if (req.sbView) return res.status(403).json({ error: d.viewAsMessage, viewAs: true });
      const s = await d.person(req, res);
      if (!s) return;
      const user = s.user;
      const lang = d.langFor(user);
      const why = d.blocked(user);
      if (why) return d.refuse(res, why, lang);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      let doc;
      try { doc = extractDocument(body.file || {}); } catch (e) { return res.status(e.code === 'tooBig' ? 413 : 400).json({ error: (FILE_ERRORS[e.code] || FILE_ERRORS.unreadable)[lang === 'es' ? 1 : 0], reason: e.code || 'unreadable' }); }
      const has = d.hasFor(user);
      const fingerprint = `${doc.name}|${doc.kind}|${doc.size}|${(doc.text || '').length}|${doc.sheets.length}|${doc.image?.data.length || 0}|${doc.pdf?.length || 0}`;
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';
      const x = contextFor(req, user, lang, { fileName: doc.name });
      x.hint = message;
      const at = d.iso();

      // A new attachment, a part of one being read, or one read again as another kind (the manager's pick).
      let imp = body.importId ? importOf(db.store, user.id, body.importId) : null;
      if (body.importId && !imp) return res.status(404).json({ error: L(lang, 'That import is gone. Attach the file again.', 'Esa importación ya no está. Adjunta el archivo de nuevo.') });
      if (imp && imp.fingerprint !== fingerprint) return res.status(409).json({ error: L(lang, 'That’s a different file. Attach it as a new message.', 'Ese es otro archivo. Adjúntalo en un mensaje nuevo.') });
      const forced = typeof body.target === 'string' && body.target ? importTarget(body.target) : null;
      if (body.target && (!forced || !forced.allowed(user, has))) return res.status(403).json({ error: L(lang, 'Only managers can import this.', 'Solo los gerentes pueden importar esto.') });
      let first = null;
      if (!imp) {
        const mayAny = importTargets().some((t) => t.allowed(user, has));
        const c = forced ? { target: forced.id, score: 100, confidence: 'high', how: 'picked' } : await classify(doc, x, { hint: message, mayAny });
        first = await db.run((st) => {
          for (const old of st.list(IMPORTS, (i) => i.userId === user.id && Date.parse(i.at) < Date.parse(at) - KEEP_MS)) st.remove(IMPORTS, old.id);
          const { chat, message: mine } = H.addUserMessage(st, { userId: user.id, chatId: body.conversationId, text: message, file: { name: doc.name, kind: doc.kind, size: doc.size }, at });
          const reply = H.addReply(st, { userId: user.id, chatId: chat.id, text: '', at });
          const doc_ = st.insert(IMPORTS, {
            id: uid('aim'), userId: user.id, chatId: chat.id, messageId: reply.id, at, name: doc.name, kind: doc.kind, fingerprint,
            target: c.target, confidence: c.confidence, how: c.how, scores: c.scores || [], status: 'reading', payload: null, part: 0, notes: [], ...(forced ? { forced: true } : {}),
          });
          return { chat, mine, imp: doc_ };
        }, { write: true });
        imp = first.imp;
      } else if (forced && (body.part == null || forced.id !== imp.target)) {
        imp = await db.run((st) => st.update(IMPORTS, imp.id, { target: forced.id, confidence: 'high', how: 'picked', forced: true, status: 'reading', payload: null, preview: null, part: 0, parts: 0, notes: [], lowConfidence: 0, source: null }), { write: true });
      }

      // Read it (one part per request for a long document read by AI), then preview it.
      const t = importTarget(imp.target);
      let update = {};
      if (!t) update = { status: 'unknown' };
      else if (!t.allowed(user, has)) update = { status: 'refused' };
      else if (imp.status === 'reading') {
        x.target = t.id;
        const part = Number.isInteger(body.part) && body.part >= 0 ? body.part : imp.part || 0;
        x.offset = imp.payload?.records?.length || 0;
        const r = await t.parse(doc, x, { part });
        const merged = mergePayload(imp.payload, r.payload);
        const notes = [...new Set([...(imp.notes || []), ...(r.notes || []), ...(x.aiFailed ? [x.aiNote] : []), ...(r.truncated ? [L(lang, 'It’s a long document: I read the first part. Split it to import the rest.', 'Es un documento largo: leí la primera parte. Divídelo para importar el resto.')] : [])])];
        update = { payload: merged, source: r.source || imp.source || null, notes, part: r.part ?? part + 1, parts: r.parts || imp.parts || 0 };
        const lowCount = (merged?.lowConfidence || []).filter((l) => l?.length).length;
        if (lowCount) update.lowConfidence = lowCount;
        if (r.done) {
          update.status = 'ready';
          try {
            update.preview = await t.preview(merged, x);
            if (!update.preview.counts?.total) update.status = 'empty';
          } catch (e) {
            update.status = 'failed';
            update.notes = [...notes, e.status ? e.message : L(lang, 'The preview didn’t work. Try Review & import.', 'La vista previa no funcionó. Prueba Revisar e importar.')];
          }
          if (t.id === 'schedule' && update.payload) update.payload = { weekOf: update.preview?.weekOf || null }; // the grid stays in the browser
        }
      }
      const saved = await db.run((st) => {
        const cur = st.update(IMPORTS, imp.id, update);
        return { imp: cur, msg: saveCard(st, cur, lang, user, has) };
      }, { write: true });
      const out = {
        conversationId: saved.imp.chatId,
        ...(first ? { userMessage: H.messageView(first.mine) } : {}),
        message: H.messageView(saved.msg),
        ...(saved.imp.status === 'reading' ? { more: { importId: saved.imp.id, part: saved.imp.part } } : {}),
      };
      res.set('Cache-Control', 'no-store').json({ result: out });
    } catch (e) {
      console.error('Ask ShiftBoard file import failed:', e.message);
      if (!res.headersSent) res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.status && e.status < 500 ? e.message : 'Something went wrong' });
    }
  });

  // ---------- Review & import: what the wizard pre-loads ----------
  app.get('/api/assistant/imports/:id', async (req, res) => {
    if (req.sbView) return res.status(404).json({ error: 'Not found' });
    const s = await d.person(req, res);
    if (!s) return;
    const imp = importOf(db.store, s.user.id, req.params.id);
    const t = imp && importTarget(imp.target);
    if (!imp || !t) return res.status(404).json({ error: 'Not found' });
    if (!t.allowed(s.user, d.hasFor(s.user))) return res.status(403).json({ error: L(d.langFor(s.user), 'Only managers can import this.', 'Solo los gerentes pueden importar esto.') });
    res.set('Cache-Control', 'no-store').json({ result: { id: imp.id, target: t.id, wizard: t.wizard, needsFile: !!t.needsFile, fileName: imp.name, kind: imp.kind, source: imp.source || 'file', status: imp.status, payload: imp.payload || {} } });
  });

  // ---------- Import now: a confirm card (only when nothing needs the manager's decision) ----------
  app.post('/api/assistant/imports/:id/propose', async (req, res) => {
    try {
      if (req.sbView) return res.status(403).json({ error: d.viewAsMessage, viewAs: true });
      const s = await d.person(req, res);
      if (!s) return;
      const user = s.user;
      const lang = d.langFor(user);
      const why = d.blocked(user);
      if (why) return d.refuse(res, why, lang);
      const imp = importOf(db.store, user.id, req.params.id);
      const t = imp && importTarget(imp.target);
      if (!imp || !t) return res.status(404).json({ error: 'Not found' });
      const has = d.hasFor(user);
      if (!t.allowed(user, has)) return res.status(403).json({ error: L(lang, 'Only managers can import this.', 'Solo los gerentes pueden importar esto.') });
      if (imp.status !== 'ready' || !t.importNow) return res.status(409).json({ error: L(lang, 'This one needs Review & import.', 'Este necesita Revisar e importar.') });
      const x = contextFor(req, user, lang, { fileName: imp.name });
      x.target = t.id;
      const p = await t.preview(imp.payload, x); // again: the data may have changed since the card
      if (p.checks || p.problems || !p.toImport) {
        const msg = await db.run((st) => saveCard(st, st.update(IMPORTS, imp.id, { preview: p }), lang, user, has), { write: true });
        return res.status(409).json({ error: L(lang, 'There are possible duplicates or problems to check first. Use Review & import.', 'Primero hay posibles duplicados o problemas por revisar. Usa Revisar e importar.'), message: H.messageView(msg) });
      }
      const title = L(lang, `Import ${labelOf(t, lang).toLowerCase()}`, `Importar: ${labelOf(t, lang)}`);
      const details = [[L(lang, 'File', 'Archivo'), imp.name], [L(lang, 'What changes', 'Qué cambia'), p.line]];
      const msg = await db.run((st) => {
        st.update(IMPORTS, imp.id, { preview: p });
        return H.addAction(st, { userId: user.id, chatId: imp.chatId, messageId: imp.messageId, action: { tool: IMPORT_TOOL, args: { importId: imp.id }, title, details }, at: d.iso() });
      }, { write: true });
      if (!msg) return res.status(404).json({ error: 'Not found' });
      res.json({ result: { conversationId: imp.chatId, message: H.messageView(msg) } });
    } catch (e) {
      console.error('Ask ShiftBoard import proposal failed:', e.message);
      if (!res.headersSent) res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.status && e.status < 500 ? e.message : 'Something went wrong' });
    }
  });

  /**
   * Confirm on an "Import now" card: preview again, refuse if anything needs a decision, then the target's own apply
   * as the person (via: 'assistant' in the audit log). → { ok, summary } | { ok: false, error }.
   */
  async function applyImport(req, user, args = {}) {
    const lang = d.langFor(user);
    const imp = importOf(db.store, user.id, args.importId);
    const t = imp && importTarget(imp.target);
    if (!imp || !t || !t.apply) return { ok: false, error: L(lang, 'That import is gone. Attach the file again.', 'Esa importación ya no está. Adjunta el archivo de nuevo.') };
    const has = d.hasFor(user);
    if (!t.allowed(user, has)) return { ok: false, error: L(lang, 'Only managers can import this.', 'Solo los gerentes pueden importar esto.') };
    if (imp.status === 'done') return { ok: false, error: L(lang, 'Already imported.', 'Ya se importó.') };
    const x = contextFor(req, user, lang, { write: true, fileName: imp.name });
    x.target = t.id;
    try {
      const p = await t.preview(imp.payload, x);
      if (p.checks || p.problems) return { ok: false, error: L(lang, 'Not imported: there are possible duplicates or problems to check. Use Review & import.', 'No se importó: hay posibles duplicados o problemas por revisar. Usa Revisar e importar.') };
      const r = await t.apply(imp.payload, x);
      await db.run((st) => {
        const cur = st.update(IMPORTS, imp.id, { status: 'done', result: r.line, payload: null, doneAt: d.iso() });
        saveCard(st, cur, lang, user, has);
      }, { write: true });
      return { ok: true, summary: r.line };
    } catch (e) {
      if (!e.status) console.error('Ask ShiftBoard import failed:', e.message);
      return { ok: false, error: e.status ? e.message : L(lang, 'The import didn’t work. Try Review & import.', 'La importación no funcionó. Prueba Revisar e importar.') };
    }
  }

  return { applyImport };
}

/** Parts read so far + this part (records and their low-confidence fields add up; anything else is replaced). */
function mergePayload(prev, next) {
  if (!next) return prev || null;
  if (!prev?.records || !next.records) return next;
  const lows = (p) => (p.lowConfidence?.length ? p.lowConfidence : p.records.map(() => []));
  const low = [...lows(prev), ...lows(next)];
  return { ...prev, ...next, records: [...prev.records, ...next.records], ...(low.some((l) => l.length) ? { lowConfidence: low } : {}) };
}
