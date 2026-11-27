// Ask ShiftBoard: Claude built into the app (the web app, the phone app and its browser version), acting as the
// signed-in person with exactly their permissions, metered and capped per restaurant (server/ai/).
//
//   GET  /api/assistant                         can I use it (or why not), my conversations, today's messages
//   GET  /api/assistant/conversations/:id       one of my conversations
//   POST /api/assistant                         { message, conversationId?, stream? } → the answer, streamed as
//                                               NDJSON lines ({ type: start | status | text | done }), or JSON
//                                               with stream: false (the phone app)
//   POST /api/assistant/actions/:id             { conversationId, decision: 'confirm' | 'cancel' }: a proposed
//                                               change runs only here, on the person's tap (audited)
//   POST /api/assistant/files                   a file attached in the chat → what it is and its import's preview
//                                               (server/assistant/imports.js: "Review & import" / "Import now")
//   POST /api/assistant/clear                   forget my conversations
//   GET/POST /api/assistant/settings            Settings → Ask ShiftBoard (admins): on/off, staff on/off, usage
//
// Who can use it: the plan has `assistant`, the restaurant didn't turn it off, the person's role has it (Roles &
// features), and staff are allowed when the person is below manager. View as is read-only and spends nothing: the
// assistant is off while viewing as someone (POSTs are refused by server/view-as.js; the GETs here say so).
import { createService } from '../../core/service.js';
import { atLeast, canChangeSettings } from '../../core/roles.js';
import { effectiveFeatures, roleAllows } from '../../core/role-features.js';
import { langOf } from '../../core/i18n.js';
import { uid } from '../../core/store.js';
import { TOOLS, toolByName, visibleTools, runTool, createToolContext, READ, WRITE } from '../tools/index.js';
import { todayOf } from '../tools/dates.js';
import { dayName, fmtTime } from '../../core/time.js';
import { translateError as translateMessage } from '../../core/errors.js';
import { aiFor, AiUnavailable, aiMessage, dailyLimitFor, MODEL } from '../ai/index.js';
import { dayOf, messagesToday } from '../ai/usage.js';
import { runTurn } from './loop.js';
import { claudeTools, aboutToday, systemBlocks } from './prompt.js';
import { describeAction } from './actions.js';
import * as H from './history.js';
import { mountAssistantImports, IMPORT_TOOL } from './imports.js';
import { canImportCalendar } from '../../core/calendar-import.js';

const CALENDAR_TOOL = 'import_programming_from_calendar';
const L2 = (lang, en, es) => (lang === 'es' ? es : en);

const CONFIG = 'assistantConfig';
const MAX_MESSAGE = 2000;
const TURN_BUDGET_MS = 22_000; // Vercel's function limit is 30 s (vercel.json): no new round after this

/** The restaurant's choices (Settings → Ask ShiftBoard): { enabled, staff }. */
export function assistantConfig(store) {
  const c = store.get(CONFIG, 'main') || {};
  return { enabled: c.enabled !== false, staff: c.staff !== false, updatedAt: c.updatedAt || null };
}

/**
 * @param app  the restaurant's Express app (server/app.js)
 * @param d    { db, env, tenant, now, has(feature), session(store, token), sessionToken(req), planFeatures(),
 *              serviceOpts(req), onCommit(changes, req), aiClient? }
 */
export function mountAssistant(app, d) {
  const { db, env, tenant, now } = d;
  const iso = () => new Date(now()).toISOString();
  const settingsOf = (store = db.store) => createService(store).settings();
  const ai = (lang) => aiFor({ db, tenant, env, now, lang, ...(d.aiClient ? { client: d.aiClient({ apiKey: env.ANTHROPIC_OWN_API_KEY || env.ANTHROPIC_API_KEY }) } : {}) });

  /** The person's features: the plan's ∩ their role's (like app.bootstrap). */
  const hasFor = (user) => {
    const eff = effectiveFeatures(user, { settings: settingsOf(), plan: d.planFeatures() });
    return (f) => d.has(f) && eff[f] !== false;
  };
  /** Why this person can't use the assistant (before the AI's own reasons), or null. */
  function blocked(user) {
    if (!d.has('assistant')) return 'plan';
    const cfg = assistantConfig(db.store);
    if (!cfg.enabled) return 'off';
    if (roleAllows(user, settingsOf()).assistant === false) return 'role';
    if (!cfg.staff && !atLeast(user, 'manager')) return 'staff';
    return null;
  }
  const params = () => ({ restaurant: settingsOf().restaurantName || '', limit: dailyLimitFor(tenant, env) });

  /** The signed-in person ({ user, claims }), or an answer already sent. */
  async function person(req, res) {
    await db.sync();
    const s = d.session(db.store, d.sessionToken(req));
    if (!s) { res.status(401).json({ error: 'Please sign in' }); return null; }
    return s;
  }
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error('Ask ShiftBoard failed:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
      else try { res.end(); } catch { /* gone */ }
    }
  };

  /** The person's tools and a context that acts as them. Reads only unless write is true. */
  function toolsFor(req, user, { write = false } = {}) {
    const has = hasFor(user);
    const settings = settingsOf();
    const tools = visibleTools(TOOLS, user, { has, scopes: [READ, WRITE], settings });
    const ctx = createToolContext({
      db, userId: user.id, v: user.sessionVersion || 0, has, scopes: write ? [READ, WRITE] : [READ], now, via: 'assistant', client: 'Ask ShiftBoard',
      serviceOpts: d.serviceOpts(req), onCommit: (changes) => d.onCommit(changes, req), invite: d.invite ? (ids, by) => d.invite(ids, by, req) : null,
      calendar: d.calendar || null,
    });
    return { tools, ctx, settings };
  }

  // ---------- files attached in the chat (imports) ----------
  const imports = mountAssistantImports(app, {
    db, now, iso, person, blocked, toolsFor, hasFor, ai, viewAsMessage: aiMessage('viewAs', 'en'),
    langFor: (user) => langOf(user, settingsOf()),
    refuse: (res, why, lang) => res.status(403).json({ error: aiMessage(why, lang, params()), reason: why }),
  });

  // ---------- status and history ----------
  app.get('/api/assistant', wrap(async (req, res) => {
    await db.sync();
    res.set('Cache-Control', 'no-store');
    if (req.sbView) {
      const lang = langOf(req.sbView.real, settingsOf());
      return res.json({ result: { available: false, reason: 'viewAs', message: aiMessage('viewAs', lang), viewAs: true, conversations: [] } });
    }
    const s = await person(req, res);
    if (!s) return;
    const lang = langOf(s.user, settingsOf());
    const why = blocked(s.user) || ai(lang).reason || null;
    const limit = dailyLimitFor(tenant, env);
    res.json({ result: {
      available: !why, ...(why ? { reason: why, message: aiMessage(why, lang, params()) } : {}), model: MODEL,
      files: !blocked(s.user), // attaching a file works without AI too (the structured readers): imports.js
      today: { messages: messagesToday(db.store, dayOf(now()), s.user.id), limit },
      conversations: H.listChats(db.store, s.user.id),
    } });
  }));

  app.get('/api/assistant/conversations/:id', wrap(async (req, res) => {
    await db.sync();
    res.set('Cache-Control', 'no-store');
    if (req.sbView) return res.status(404).json({ error: 'Not found' }); // never someone else's conversations
    const s = await person(req, res);
    if (!s) return;
    const chat = H.chatOf(db.store, s.user.id, req.params.id);
    if (!chat) return res.status(404).json({ error: 'Not found' });
    res.json({ result: H.chatView(chat) });
  }));

  app.post('/api/assistant/clear', wrap(async (req, res) => {
    if (req.sbView) return res.status(403).json({ error: aiMessage('viewAs', 'en'), viewAs: true });
    const s = await person(req, res);
    if (!s) return;
    const n = await db.run((st) => H.clearChats(st, s.user.id), { write: true });
    res.json({ result: { cleared: n } });
  }));

  // ---------- a message ----------
  app.post('/api/assistant', wrap(async (req, res) => {
    const started = now();
    if (req.sbView) return res.status(403).json({ error: aiMessage('viewAs', 'en'), viewAs: true }); // view-as.js refuses it first
    const s = await person(req, res);
    if (!s) return;
    const user = s.user;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const text = typeof body.message === 'string' ? body.message.trim() : '';
    if (!text) return res.status(400).json({ error: 'Type a question first' });
    if (text.length > MAX_MESSAGE) return res.status(400).json({ error: `Keep it under ${MAX_MESSAGE} characters` });
    const lang = langOf(user, settingsOf());
    const streaming = body.stream !== false;
    const why = blocked(user);
    if (why === 'plan' || why === 'role') return res.status(403).json({ error: aiMessage(why, lang, params()), reason: why });

    // The person's message goes in their conversation first (also when the answer is a friendly "not now").
    const { chat, message: mine } = await db.run((st) => H.addUserMessage(st, { userId: user.id, chatId: body.conversationId, text, at: iso() }), { write: true });

    let out = null;
    if (streaming) {
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
    }
    const send = (o) => { if (streaming && !res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };
    send({ type: 'start', conversationId: chat.id, userMessage: { id: mine.id, role: 'user', text, at: mine.at } });

    let cards = [];
    const finish = async ({ text: reply, proposals = [], notice = null }) => {
      const look = { today: todayOf(now()), weekStartDow: settingsOf().weekStartDow ?? 1, shift: shiftLook(user) };
      const actions = proposals.map((p) => ({ tool: p.tool, args: p.args, ...describeAction(toolByName(p.tool), p.args, lang, { ...look, calendarNames: calendarNamesFor(user, p.args?.importId) }) }));
      const calId = cards.map((c) => c.calendarImportId).filter(Boolean).at(-1);
      const calendar = calId ? calendarCard(user, calId) : null;
      const msg = await db.run((st) => H.addReply(st, { userId: user.id, chatId: chat.id, text: reply, actions, notice, at: iso(), calendar }), { write: true });
      const view = H.messageView(msg);
      out = { conversationId: chat.id, userMessage: { id: mine.id, role: 'user', text, at: mine.at }, message: view };
      send({ type: 'done', ...out });
    };

    try {
      const a = ai(lang);
      const gate = why || a.reason;
      if (gate) throw new AiUnavailable(gate, { lang, params: params() });
      await a.admit({ user, lang }); // the daily limit and the per-minute limit; counts the message
      const { tools, ctx, settings } = toolsFor(req, user);
      ctx.cards = cards; // read_events_calendar adds its card here (the reply carries it)
      const positions = (user.jobCodes || []).map((j) => db.store.get('jobCodes', j.jobCodeId)?.name).filter(Boolean);
      const system = systemBlocks(aboutToday({ user, restaurant: settings.restaurantName || '', lang, today: todayOf(now()), nowMs: now(), weekStartDow: settings.weekStartDow ?? 1, positions }));
      const turn = await runTurn({
        ai: a, user, lang, system, tools, claudeTools: claudeTools(tools), ctx, messages: H.contextOf(db.store.get(H.CHATS, chat.id)),
        deadline: started + (Number(env.AI_TURN_BUDGET_MS) || TURN_BUDGET_MS), now,
        on: { text: (t) => send({ type: 'text', text: t }), status: (tool) => send({ type: 'status', tool }) },
      });
      await finish({ text: turn.text, proposals: turn.proposals });
    } catch (e) {
      if (!(e instanceof AiUnavailable)) console.error('Ask ShiftBoard turn failed:', e.message);
      const reason = e instanceof AiUnavailable ? e.reason : 'api';
      await finish({ text: e instanceof AiUnavailable ? e.message : aiMessage('api', lang), notice: reason });
    }
    if (streaming) res.end(); else res.json({ result: out });
  }));

  /** A shift's date, times and position for an action card, if this person can see it in the app. */
  function shiftLook(user) {
    return (id) => {
      const sh = db.store.get('shifts', id);
      if (!sh || (!sh.published && !atLeast(user, 'manager') && sh.userId !== user.id)) return null;
      return { date: sh.date, start: sh.start, end: sh.end || null, position: db.store.get('jobCodes', sh.jobCodeId)?.name || '' };
    };
  }

  // ---------- Confirm / Cancel on an action card ----------
  app.post('/api/assistant/actions/:id', wrap(async (req, res) => {
    if (req.sbView) return res.status(403).json({ error: aiMessage('viewAs', 'en'), viewAs: true });
    const s = await person(req, res);
    if (!s) return;
    const user = s.user;
    const lang = langOf(user, settingsOf());
    const chatId = String(req.body?.conversationId || '');
    const decision = req.body?.decision === 'confirm' ? 'confirm' : req.body?.decision === 'cancel' ? 'cancel' : null;
    if (!decision) return res.status(400).json({ error: 'Confirm or cancel' });
    const why = blocked(user);
    if (decision === 'confirm' && why) return res.status(403).json({ error: aiMessage(why, lang, params()), reason: why });

    // Claim it (one tap runs it once, even with two taps or two devices).
    const at = iso();
    const claim = await db.run((st) => {
      const f = H.findAction(st, user.id, chatId, req.params.id);
      if (!f) return { status: 404 };
      if (f.action.status !== 'proposed') return { status: 409, action: H.actionView(f.action) };
      if (H.actionExpired(f.action, at)) return { status: 410, action: H.settleAction(st, { userId: user.id, chatId, actionId: f.action.id, status: 'expired', at }) };
      if (decision === 'cancel') return { status: 200, action: H.settleAction(st, { userId: user.id, chatId, actionId: f.action.id, status: 'cancelled', at }) };
      H.settleAction(st, { userId: user.id, chatId, actionId: f.action.id, status: 'running', at });
      return { status: 202, tool: f.action.tool, args: f.action.args };
    }, { write: true });
    if (claim.status === 404) return res.status(404).json({ error: 'Not found' });
    if (claim.status !== 202) return res.status(claim.status === 200 ? 200 : claim.status).json(claim.status === 200 ? { result: { action: claim.action } } : { error: claim.status === 410 ? 'expired' : 'already', action: claim.action });

    let r;
    if (claim.tool === IMPORT_TOOL) r = await imports.applyImport(req, user, claim.args); // "Import now" (imports.js)
    else {
      const tool = toolByName(claim.tool);
      const { ctx } = toolsFor(req, user, { write: true });
      const args = { ...claim.args, ...(tool && 'confirm' in tool.input ? { confirm: true } : {}) };
      r = tool ? await runTool(tool, args, ctx) : { ok: false, error: aiMessage('role', lang) };
    }
    const action = await db.run((st) => {
      if (claim.tool === CALENDAR_TOOL && r.ok) markCalendarDone(st, user.id, chatId, claim.args?.importId, r.summary);
      return H.settleAction(st, { userId: user.id, chatId, actionId: req.params.id, status: r.ok ? 'done' : 'failed', result: r.ok ? r.summary : r.error, at: iso() });
    }, { write: true });
    res.json({ result: { ok: r.ok, action } });
  }));

  // ---------- a calendar page's card (read_events_calendar; core/calendar-import.js) ----------
  /** What the chat keeps on the message: a summary the phone app shows as is (the web card loads the full read). */
  function calendarCard(user, id) {
    try {
      const v = createService(db.store).call(db.store.get('users', user.id), 'programming.calendar.get', { id }).import;
      return {
        id: v.id, url: v.url, source: v.source, events: v.events, from: v.from, to: v.to, status: 'ready',
        recurring: v.recurring.map((r) => ({ key: r.key, name: r.name, room: r.room, days: r.days, start: r.start, end: r.end, from: r.from, to: r.to, repeat: r.repeat, count: r.count, duplicate: !!r.duplicateOf, include: r.include })),
        oneOffs: v.oneOffs.length, oneOffList: v.oneOffs.slice(0, 12).map((o) => ({ name: o.name, date: o.date, start: o.start, room: o.room, duplicate: !!o.duplicateOf })),
        unmatched: v.recurring.filter((r) => r.include && !r.room).length,
      };
    } catch (e) { console.error('Calendar card failed:', e.message); return null; }
  }
  /** Suggestion keys → names, for an action card. */
  function calendarNamesFor(user, importId) {
    if (!importId) return null;
    return (keys) => {
      try {
        const v = createService(db.store).call(db.store.get('users', user.id), 'programming.calendar.get', { id: importId }).import;
        const all = [...v.recurring, ...v.oneOffs];
        return keys.map((k) => all.find((x) => x.key === k)?.name || k);
      } catch { return keys; }
    };
  }
  function markCalendarDone(st, userId, chatId, importId, result) {
    const chat = H.chatOf(st, userId, chatId);
    const m = chat?.messages.find((x) => x.calendar?.id === importId);
    if (m) H.updateMessage(st, { userId, chatId, messageId: m.id, patch: { calendar: { ...m.calendar, status: 'done', result: String(result || '').slice(0, 300) } } });
  }

  // Import now on the card: the manager's ticks and room picks → the usual Confirm / Cancel card.
  app.post('/api/assistant/calendar/:id/propose', wrap(async (req, res) => {
    if (req.sbView) return res.status(403).json({ error: aiMessage('viewAs', 'en'), viewAs: true });
    const s = await person(req, res);
    if (!s) return;
    const user = s.user;
    const lang = langOf(user, settingsOf());
    const why = blocked(user);
    if (why) return res.status(403).json({ error: aiMessage(why, lang, params()), reason: why });
    if (!canImportCalendar(user, settingsOf())) return res.status(403).json({ error: L2(lang, 'Your role doesn’t include this.', 'Tu rol no incluye esto.') });
    const chatId = String(req.body?.conversationId || '');
    const chat = H.chatOf(db.store, user.id, chatId);
    const m = chat?.messages.find((x) => x.calendar?.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const selections = req.body?.selections && typeof req.body.selections === 'object' ? req.body.selections : {};
    let p;
    try { p = createService(db.store).call(user, 'programming.calendar.apply', { id: req.params.id, selections, dryRun: true }); } catch (e) {
      return res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.status && e.status < 500 ? translateMessage(e.message, lang) : 'Something went wrong' });
    }
    const keys = [...p.items, ...p.events].map((x) => x.key);
    const recSel = selections.recurring || {};
    const args = {
      importId: req.params.id, include: keys,
      rooms: [...p.items, ...p.events].filter((x) => x.room).map((x) => (x.room === '*' ? { key: x.key, wholeVenue: true } : { key: x.key, room: x.room })),
      changes: p.items.filter((x) => recSel[x.key] && (recSel[x.key].name || recSel[x.key].from !== undefined || recSel[x.key].to !== undefined))
        .map((x) => ({ key: x.key, ...(recSel[x.key].name ? { name: x.name } : {}), ...(recSel[x.key].from !== undefined ? { startDate: x.from || '' } : {}), ...(recSel[x.key].to !== undefined ? { endDate: x.to || '' } : {}) })),
    };
    if (!args.changes.length) delete args.changes;
    const day = (d) => dayName(d, 'short', lang);
    const details = [
      [L2(lang, 'Page', 'Página'), m.calendar.url],
      [L2(lang, 'What changes', 'Qué cambia'), p.line],
      ...p.items.slice(0, 8).map((x) => [x.name, `${x.days.map(day).join(', ')} ${fmtTime(x.start, lang)}${x.end ? `–${fmtTime(x.end, lang)}` : ''} · ${x.room === '*' ? L2(lang, 'Whole venue', 'Todo el lugar') : x.room}`]),
      ...(p.events.length ? [[L2(lang, 'Events', 'Eventos'), p.events.slice(0, 6).map((e) => e.name).join(', ') + (p.events.length > 6 ? '…' : '')]] : []),
    ];
    const msg = await db.run((st) => H.addAction(st, { userId: user.id, chatId, messageId: m.id, at: iso(),
      action: { tool: CALENDAR_TOOL, args, title: L2(lang, 'Import programming from a calendar page', 'Importar programación de una página de calendario'), details } }), { write: true });
    res.json({ result: { conversationId: chatId, message: H.messageView(msg) } });
  }));

  // ---------- Settings → Ask ShiftBoard (admins) ----------
  async function adminOf(req, res) {
    await db.sync();
    const u = req.sbView?.actor || d.session(db.store, d.sessionToken(req))?.user;
    if (!u) { res.status(401).json({ error: 'Please sign in' }); return null; }
    if (!canChangeSettings(u)) { res.status(403).json({ error: 'Admins only' }); return null; }
    return u;
  }
  function settingsView() {
    const cfg = assistantConfig(db.store);
    const a = ai('en');
    const u = a.usage();
    const people = Object.entries(u.users || {})
      .map(([id, x]) => ({ id, name: db.store.get('users', id)?.name || '', usd: x.usd || 0, messages: x.messages || 0 }))
      .filter((p) => p.name).sort((x, y) => y.usd - x.usd || y.messages - x.messages).slice(0, 5);
    return {
      available: d.has('assistant'), ...cfg, model: MODEL, ready: !a.reason || a.reason === 'cap', reason: a.reason || null,
      usage: { month: u.month, usedUsd: u.usedUsd, ownUsd: u.ownUsd, capUsd: u.capUsd, pct: u.pct, calls: u.calls, ownKey: u.ownKey, warned: !!u.warnedAt },
      top: people, dailyLimit: dailyLimitFor(tenant, env), platform: !!tenant,
    };
  }
  app.get('/api/assistant/settings', wrap(async (req, res) => {
    const u = await adminOf(req, res);
    if (!u) return;
    res.set('Cache-Control', 'no-store').json({ result: settingsView() });
  }));
  app.post('/api/assistant/settings', wrap(async (req, res) => {
    const u = await adminOf(req, res);
    if (!u) return;
    if (!d.has('assistant')) return res.status(403).json({ error: 'Not included in your plan' });
    const b = req.body || {};
    const patch = { ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}), ...(typeof b.staff === 'boolean' ? { staff: b.staff } : {}) };
    const support = d.session(db.store, d.sessionToken(req))?.claims?.sup;
    await db.run((st) => {
      const doc = { ...patch, updatedAt: iso(), updatedBy: u.id };
      if (st.get(CONFIG, 'main')) st.update(CONFIG, 'main', doc); else st.insert(CONFIG, { id: 'main', ...doc });
      st.insert('auditLog', { id: uid('aud'), at: iso(), actorId: u.id, targetId: null, action: 'assistant.settings', via: 'app', details: { ...patch, ...(support ? { support: support.by } : {}) } });
    }, { write: true });
    res.json({ result: settingsView() });
  }));
}
