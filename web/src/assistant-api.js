// Ask ShiftBoard's web calls (server/assistant/): the status and history, a message (streamed as NDJSON lines),
// Confirm / Cancel on a proposed change, Clear history, and Settings → Ask ShiftBoard.
// The demo has no server and never calls Claude: it answers the suggested questions from the demo's own data.
import { ApiError, IS_DEMO, call, nowDate } from './api.js';
import { getLang, t } from './i18n/index.js';
import { addDays, weekStart, prettyDate, fmtTime, todayStr, shiftHours } from '../../core/time.js';
import { extractDocument } from '../../core/import-detect.js';
import { findHeaderRow, autoMap, rowsToRecords, menuFromText, rosterFromText } from '../../core/smart-import.js';

const headers = () => ({ 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() });
async function send(path, body, { method = 'POST' } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: headers(), ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new ApiError(res.status, data.error || t('assistant.failed')), { reason: data.reason || null, viewAs: !!data.viewAs, action: data.action || null });
  return data.result ?? data;
}

// ---------- the demo ----------
const demoChats = [];
const demoKinds = ['whenNext', 'tonight', 'eightySix', 'over40', 'openShifts'];
/** Which suggested question a message is (the demo only knows those). */
const demoKind = (text) => demoKinds.find((k) => t(`assistant.s_${k}`).toLowerCase() === String(text).trim().toLowerCase()) || null;
const list = (items) => items.join(', ');
async function demoAnswer(text) {
  const kind = demoKind(text);
  const boot = await call('app.bootstrap');
  const lang = getLang();
  const today = todayStr(nowDate());
  const people = Object.fromEntries(boot.employees.map((e) => [e.id, e.name]));
  const jobs = Object.fromEntries(boot.jobCodes.map((j) => [j.id, j.name]));
  const when = (s) => `${prettyDate(s.date, { lang })} ${fmtTime(s.start, lang)}${s.end ? `–${fmtTime(s.end, lang)}` : ''}`;
  const shifts = async (from, to) => (await call('shifts.list', { start: from, end: to })).shifts.filter((s) => s.published);
  if (kind === 'whenNext') {
    const mine = (await shifts(today, addDays(today, 27))).filter((s) => s.userId === boot.me.id).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    return mine[0] ? t('assistant.demo_next', { when: when(mine[0]), position: jobs[mine[0].jobCodeId] || '' }) : t('assistant.demo_noNext');
  }
  if (kind === 'tonight') {
    const on = (await shifts(today, today)).filter((s) => s.userId && s.start >= '15:00');
    const names = [...new Set(on.map((s) => people[s.userId]).filter(Boolean))];
    return names.length ? t('assistant.demo_tonight', { people: list(names.slice(0, 12)) }) : t('assistant.demo_nobodyTonight');
  }
  if (kind === 'eightySix') {
    const b = await call('eightySix.board.get');
    const items = b.lists.flatMap((l) => l.items).filter((i) => i.status === 'out' || i.status === 'low');
    return items.length ? t('assistant.demo_eightySix', { items: list(items.slice(0, 8).map((i) => t(i.status === 'out' ? 'assistant.demo_out' : 'assistant.demo_low', { name: i.name }))) }) : t('assistant.demo_nothing86');
  }
  if (kind === 'over40') {
    const start = weekStart(today, boot.settings.weekStartDow ?? 1);
    const hours = {};
    for (const s of await shifts(start, addDays(start, 6))) if (s.userId) hours[s.userId] = (hours[s.userId] || 0) + (s.hours ?? shiftHours(s));
    const ranked = Object.entries(hours).sort((a, b) => b[1] - a[1]);
    const over = ranked.filter(([, h]) => h > 40).map(([id, h]) => `${people[id]} (${Math.round(h * 10) / 10} h)`);
    if (over.length) return t('assistant.demo_over40', { people: list(over) });
    return ranked[0] ? t('assistant.demo_none40', { name: people[ranked[0][0]], hours: Math.round(ranked[0][1] * 10) / 10 }) : t('assistant.demo_noNext');
  }
  if (kind === 'openShifts') {
    const open = (await shifts(today, addDays(today, 13))).filter((s) => !s.userId).slice(0, 4);
    return open.length ? t('assistant.demo_open', { shifts: list(open.map((s) => `${when(s)} ${jobs[s.jobCodeId] || ''}`.trim())) }) : t('assistant.demo_noOpen');
  }
  return t('assistant.demo_other');
}

/** Can I use it, why not, my conversations. */
export async function status() {
  if (IS_DEMO) return { available: true, demo: true, conversations: demoChats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })), today: { messages: 0, limit: 50 } };
  return send('/api/assistant', null, { method: 'GET' });
}
export async function conversation(id) {
  if (IS_DEMO) return demoChats.find((c) => c.id === id) || null;
  return send(`/api/assistant/conversations/${encodeURIComponent(id)}`, null, { method: 'GET' });
}
export async function clearHistory() {
  if (IS_DEMO) { demoChats.length = 0; return { cleared: 0 }; }
  return send('/api/assistant/clear', {});
}
/** Import now on a calendar page's card: the ticks and rooms → the message with its Confirm card. */
export const proposeCalendar = (importId, conversationId, selections) => send(`/api/assistant/calendar/${encodeURIComponent(importId)}/propose`, { conversationId, selections });
export const decide = (actionId, conversationId, decision) => send(`/api/assistant/actions/${encodeURIComponent(actionId)}`, { conversationId, decision });

/**
 * Send a message. on: { start({ conversationId, userMessage }), status(tool), text(delta), done({ conversationId, message }) }.
 * Resolves with the final { conversationId, message }. signal: an AbortController's, for Stop.
 */
export async function ask({ message, conversationId }, on = {}, signal) {
  if (IS_DEMO) {
    let chat = demoChats.find((c) => c.id === conversationId);
    const at = new Date().toISOString();
    if (!chat) demoChats.unshift(chat = { id: `demo_${Date.now()}`, title: message.slice(0, 60), updatedAt: at, messages: [] });
    const userMessage = { id: `u_${Date.now()}`, role: 'user', text: message, at };
    chat.messages.push(userMessage);
    on.start?.({ conversationId: chat.id, userMessage });
    const answer = await demoAnswer(message).catch(() => t('assistant.demo_other'));
    for (const piece of answer.match(/.{1,18}/gs) || []) { await new Promise((r) => setTimeout(r, 25)); on.text?.(piece); }
    const reply = { id: `a_${Date.now()}`, role: 'assistant', text: answer, at: new Date().toISOString(), demo: true };
    chat.messages.push(reply);
    chat.updatedAt = reply.at;
    const out = { conversationId: chat.id, message: reply };
    on.done?.(out);
    return out;
  }
  const res = await fetch('/api/assistant', { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify({ message, conversationId }), signal });
  if (!res.ok || !/ndjson/.test(res.headers.get('content-type') || '')) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new ApiError(res.status, data.error || t('assistant.failed')), { reason: data.reason || null, viewAs: !!data.viewAs });
  }
  // NDJSON: one event per line, as it comes.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    if (ev.type === 'start') on.start?.(ev);
    else if (ev.type === 'status') on.status?.(ev.tool);
    else if (ev.type === 'text') on.text?.(ev.text);
    else if (ev.type === 'done') { final = ev; on.done?.(ev); }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  handle(buf);
  if (!final) throw new ApiError(502, t('assistant.failed'));
  return final;
}

// ---------- files: what it is, and its import's preview (server/assistant/imports.js) ----------
/** Attach a file (assistant-files.js readAttachment payload). opts: { message, conversationId, importId, target, part }. */
export async function attachFile(file, opts = {}) {
  if (IS_DEMO) return demoAttach(file, opts);
  return send('/api/assistant/files', { file, ...opts });
}
/** What "Review & import" pre-loads: { target, wizard, fileName, source, payload }. */
export const importFor = (id) => (IS_DEMO ? Promise.resolve(demoImports.get(id) || null) : send(`/api/assistant/imports/${encodeURIComponent(id)}`, null, { method: 'GET' }));
/** "Import now": the message with a Confirm / Cancel card. */
export const proposeImport = (id, conversationId) => send(`/api/assistant/imports/${encodeURIComponent(id)}/propose`, { conversationId });

// The demo never calls Claude: a rule-based guess (menu, team or products, from the headers and the file's name) and
// the demo's own preview (the same import preview, in the browser). Invented sample rows when it can't read the file.
const demoImports = new Map();
const DEMO_WORDS = { employees: /roster|team|staff|employee|equipo|personal/i, products: /inventory|order|product|stock|supplies|inventario|producto/i, menu: /menu|men[uú]|dish|food|drink|carta/i };
const DEMO_SAMPLE = {
  menu: [['Charred Leek Toast', 'Small Plates', '12'], ['Saffron Clam Stew', 'Large Plates', '29'], ['Burnt Honey Tart', 'Desserts', '10']].map(([name, category, price], i) => ({ row: i + 1, values: { name, category, price }, present: ['name', 'category', 'price'] })),
  employees: [['Wren Castellano', 'wren.c@invented.test'], ['Orrin Paley', 'orrin.p@invented.test']].map(([name, email], i) => ({ row: i + 1, values: { name, email }, present: ['name', 'email'] })),
  products: [['Invented Agave Reposado', 'spirits', 'bottle'], ['Cocktail Napkins', 'paper', 'case']].map(([name, category, unit], i) => ({ row: i + 1, values: { name, category, unit }, present: ['name', 'category', 'unit'] })),
};
async function demoAttach(file, { message = '', conversationId, importId, target: picked }) {
  let doc = null;
  try { doc = extractDocument(file); } catch { doc = { name: file.name, kind: 'pdf', sheets: [], text: '' }; }
  const scored = ['menu', 'employees', 'products'].map((target) => {
    const sheet = (doc.sheets || []).map((s) => ({ s, h: findHeaderRow(s.rows, target, { min: 2 }) })).find((x) => x.h >= 0);
    const named = DEMO_WORDS[target].test(`${message} ${doc.name}`);
    return { target, sheet, score: (sheet ? 60 : 0) + (named ? 30 : 0) };
  }).sort((a, b) => b.score - a.score);
  const best = picked ? scored.find((x) => x.target === picked) || { target: picked, score: 100 } : scored[0].score ? scored[0] : { target: 'menu', score: 50 };
  const target = best.target;
  let records = [];
  if (best.sheet) records = rowsToRecords(best.sheet.s.rows, best.sheet.h, autoMap(best.sheet.s.rows[best.sheet.h], target));
  else if (doc.text && target === 'menu') records = menuFromText(doc.text);
  else if (doc.text && target === 'employees') records = rosterFromText(doc.text);
  if (!records.length) records = DEMO_SAMPLE[target];
  const p = await call(`${target}.importPreview`, { records, options: target === 'menu' ? { createCategories: true } : {}, decisions: {} });
  const c = p.counts;
  const label = t(`assistant.imp_${target}`);
  const id = `demo_imp_${Date.now()}`;
  demoImports.set(id, { id, target, wizard: 'smartImport', fileName: doc.name, source: 'file', payload: { records } });
  let chat = demoChats.find((x) => x.id === conversationId);
  const at = new Date().toISOString();
  if (!chat) demoChats.unshift(chat = { id: `demo_${Date.now()}`, title: doc.name, updatedAt: at, messages: [] });
  const userMessage = { id: `u_${Date.now()}`, role: 'user', text: message, at, file: { name: doc.name, kind: doc.kind, size: file.size || 0 } };
  const card = {
    id, fileName: doc.name, kind: doc.kind, status: 'ready', target, label, confidence: best.score >= 80 ? 'high' : 'medium', how: 'demo',
    choices: ['menu', 'employees', 'products'].filter((x) => x !== target).map((x) => ({ id: x, label: t(`assistant.imp_${x}`) })),
    summary: { line: t('assistant.demoImportLine', { label, total: c.total, new: c.new, update: c.update, check: c.check }), details: [], counts: c },
    wizard: 'smartImport', canImportNow: false, ...(c.check || c.problem ? { needsReview: true } : {}), notes: [t('assistant.demoImportNote')],
  };
  const message_ = { id: `a_${Date.now()}`, role: 'assistant', text: t('assistant.demoLooksLike', { label }), at, import: card, demo: true };
  const old = importId ? chat.messages.findIndex((m) => m.import?.id === importId) : -1;
  if (old >= 0) { chat.messages[old] = { ...message_, id: chat.messages[old].id, text: t('assistant.demoPicked', { label }) }; return { conversationId: chat.id, message: chat.messages[old] }; }
  chat.messages.push(userMessage, message_);
  chat.updatedAt = at;
  return { conversationId: chat.id, userMessage, message: message_ };
}

// ---------- Settings → Ask ShiftBoard (admins) ----------
export const assistantSettings = () => send('/api/assistant/settings', null, { method: 'GET' });
export const saveAssistantSettings = (patch) => send('/api/assistant/settings', patch);
