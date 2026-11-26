// Ask ShiftBoard's conversations: each person's own, in the restaurant's store (collection assistantChats). Only
// that person ever reads them (the routes check userId; no RPC lists the collection, and View as never shows them).
// The last 20 conversations of the last 30 days are kept; a person can clear theirs. Proposed changes (action cards)
// are kept on the message that proposed them, with their arguments, so Confirm runs exactly what was shown.
import { uid } from '../../core/store.js';

export const CHATS = 'assistantChats';
export const KEEP_CONVERSATIONS = 20;
export const KEEP_DAYS = 30;
const KEEP_MESSAGES = 60; // per conversation (the oldest go first)
const CONTEXT_MESSAGES = 12; // what the model sees of the conversation so far
const ACTION_MINUTES = 60; // a proposed change can be confirmed for this long

const title = (text) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** A conversation the person owns, or null. */
export function chatOf(store, userId, id) {
  const c = id ? store.get(CHATS, id) : null;
  return c && c.userId === userId ? c : null;
}

/** Their conversations, newest first: [{ id, title, updatedAt, count }]. */
export function listChats(store, userId) {
  return store.list(CHATS, (c) => c.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }));
}

/** A conversation as the apps show it (proposals without their raw arguments). */
export function chatView(c) {
  if (!c) return null;
  return {
    id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messages: c.messages.map((m) => ({
      id: m.id, role: m.role, text: m.text, at: m.at, ...(m.notice ? { notice: m.notice } : {}),
      ...(m.actions?.length ? { actions: m.actions.map(actionView) } : {}),
    })),
  };
}
export const actionView = (a) => ({ id: a.id, tool: a.tool, title: a.title, details: a.details || [], status: a.status, ...(a.result ? { result: a.result } : {}), ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}) });

/** Drop what's too old or too many, for one person (inside a write). */
export function prune(store, userId, nowIso) {
  const cutoff = new Date(Date.parse(nowIso) - KEEP_DAYS * 86_400_000).toISOString();
  const mine = store.list(CHATS, (c) => c.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  mine.forEach((c, i) => { if (i >= KEEP_CONVERSATIONS || c.updatedAt < cutoff) store.remove(CHATS, c.id); });
}

/** Add the person's message (a new conversation when there's none). Returns { chat, message }. */
export function addUserMessage(store, { userId, chatId, text, at }) {
  let chat = chatOf(store, userId, chatId);
  const message = { id: uid('acm'), role: 'user', text: String(text), at };
  if (!chat) {
    chat = store.insert(CHATS, { id: uid('ach'), userId, title: title(text), createdAt: at, updatedAt: at, messages: [message] });
  } else {
    chat = store.update(CHATS, chat.id, { updatedAt: at, messages: [...chat.messages, message].slice(-KEEP_MESSAGES) });
  }
  prune(store, userId, at);
  return { chat, message };
}

/** Add the assistant's reply: text, and the changes it proposes (each { tool, args, title, details }), or a notice. */
export function addReply(store, { userId, chatId, text, actions = [], notice = null, at }) {
  const chat = chatOf(store, userId, chatId);
  if (!chat) return null;
  const expiresAt = new Date(Date.parse(at) + ACTION_MINUTES * 60_000).toISOString();
  const message = {
    id: uid('acm'), role: 'assistant', text: String(text || ''), at, ...(notice ? { notice } : {}),
    ...(actions.length ? { actions: actions.map((a) => ({ id: uid('act'), tool: a.tool, args: a.args, title: a.title, details: a.details || [], status: 'proposed', expiresAt })) } : {}),
  };
  store.update(CHATS, chat.id, { updatedAt: at, messages: [...chat.messages, message].slice(-KEEP_MESSAGES) });
  return message;
}

/** A proposed change in one of the person's conversations: { chat, message, action } or null. */
export function findAction(store, userId, chatId, actionId) {
  const chat = chatOf(store, userId, chatId);
  if (!chat) return null;
  for (const message of chat.messages) {
    const action = (message.actions || []).find((a) => a.id === actionId);
    if (action) return { chat, message, action };
  }
  return null;
}

/** Set a proposed change's outcome (inside a write): status 'done' | 'failed' | 'cancelled' | 'expired'. */
export function settleAction(store, { userId, chatId, actionId, status, result = '', at }) {
  const f = findAction(store, userId, chatId, actionId);
  if (!f) return null;
  const messages = f.chat.messages.map((m) => (m.id !== f.message.id ? m : {
    ...m, actions: m.actions.map((a) => (a.id === actionId ? { ...a, status, ...(result ? { result: String(result).slice(0, 500) } : {}), settledAt: at } : a)),
  }));
  store.update(CHATS, f.chat.id, { messages, updatedAt: at });
  return actionView(messages.find((m) => m.id === f.message.id).actions.find((a) => a.id === actionId));
}

export const actionExpired = (action, nowIso) => !!action.expiresAt && action.expiresAt < nowIso;

/** Forget all of a person's conversations. Returns how many. */
export function clearChats(store, userId) {
  const mine = store.list(CHATS, (c) => c.userId === userId);
  for (const c of mine) store.remove(CHATS, c.id);
  return mine.length;
}

const STATUS_NOTE = { proposed: 'waiting for them to confirm', done: 'they confirmed it and it was done', failed: 'it failed', cancelled: 'they cancelled it', expired: 'it expired' };

/**
 * The conversation so far as Messages API messages: the last few, text only (notices left out), with what became
 * of each proposed change. Starts with the person's message, as the API needs.
 */
export function contextOf(chat) {
  if (!chat) return [];
  const out = [];
  for (const m of chat.messages.slice(-CONTEXT_MESSAGES)) {
    if (m.notice) continue;
    let text = m.text;
    if (m.actions?.length) text += `\n\n${m.actions.map((a) => `[Proposed in the app: ${a.title}${a.details?.length ? ` (${a.details.map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}: ${STATUS_NOTE[a.status] || a.status}${a.result ? `: ${a.result}` : ''}]`).join('\n')}`;
    if (!text.trim()) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${text}`; else out.push({ role: m.role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
