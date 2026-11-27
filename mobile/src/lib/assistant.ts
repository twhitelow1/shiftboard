// Ask ShiftBoard from the phone: the same API as the web app (server/assistant/), with the whole answer at once
// (stream: false) since React Native's fetch doesn't read a response as it arrives. Changes come back as cards and
// only run when the person taps Confirm.
import type { Client } from './api';

export interface AskAction {
  id: string;
  tool: string;
  title: string;
  details: [string, string][];
  status: 'proposed' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
  result?: string;
}
export interface AskMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  notice?: string;
  actions?: AskAction[];
  file?: { name: string; size?: number };
  import?: AskImport;
  calendar?: AskCalendar;
}
/** A calendar page's suggestions (read_events_calendar): shown read-only on the phone, reviewed on the website. */
export interface AskCalendar {
  id: string;
  url: string;
  source: 'tribe' | 'ics' | 'jsonld' | 'ai';
  events: number;
  from: string;
  to: string;
  status: 'ready' | 'done';
  recurring: { key: string; name: string; room: string; days: number[]; start: string; end: string; from: string; to: string; repeat: string; count: number; duplicate: boolean; include: boolean }[];
  oneOffs: number;
  oneOffList: { name: string; date: string; start: string; room: string; duplicate: boolean }[];
  unmatched: number;
  result?: string;
}
export interface AskStatus {
  available: boolean;
  reason?: string;
  message?: string;
  viewAs?: boolean;
  files?: boolean; // attaching a file works even without AI (the structured readers)
  today?: { messages: number; limit: number };
  conversations: { id: string; title: string; updatedAt: string }[];
}

export const askStatus = (client: Client) => client.get<AskStatus>('/api/assistant');
export const askConversation = (client: Client, id: string) => client.get<{ id: string; messages: AskMessage[] }>(`/api/assistant/conversations/${encodeURIComponent(id)}`);
export const askClear = (client: Client) => client.post<{ cleared: number }>('/api/assistant/clear');
/** One message; resolves with the reply (the server has up to 30 s). */
export const askSend = (client: Client, message: string, conversationId: string | null) =>
  client.post<{ conversationId: string; userMessage: AskMessage; message: AskMessage }>('/api/assistant', { message, conversationId, stream: false }, { timeoutMs: 40000 });
export const askDecide = (client: Client, actionId: string, conversationId: string, decision: 'confirm' | 'cancel') =>
  client.post<{ ok?: boolean; action: AskAction }>(`/api/assistant/actions/${encodeURIComponent(actionId)}`, { conversationId, decision });

// ---------- files attached in the chat (server/assistant/imports.js) ----------
/** What the server gets: the file's text, its bytes (base64) or a shrunk picture. Never kept on the server. */
export interface AskFilePayload { name: string; type?: string; size?: number; text?: string; data?: string; mediaType?: string; width?: number; height?: number }
export interface AskImport {
  id: string;
  fileName: string;
  status: 'reading' | 'ready' | 'empty' | 'failed' | 'refused' | 'unknown' | 'done';
  target: string | null;
  label: string;
  confidence: 'high' | 'medium' | 'low' | null;
  how?: string;
  choices: { id: string; label: string }[];
  progress?: { part: number; parts: number };
  summary?: { line: string; details: string[] };
  wizard: string | null;
  canImportNow: boolean;
  needsFile?: boolean;
  needsReview?: boolean;
  lowConfidence?: number;
  notes: string[];
  refused?: string;
  result?: string;
}
export interface AttachResult { conversationId: string; userMessage?: AskMessage; message: AskMessage; more?: { importId: string; part: number } }
type AttachOpts = { message?: string; conversationId?: string | null; importId?: string; target?: string; part?: number };

/** Attach a file: the reply with its import card. */
export const askAttach = (client: Client, file: AskFilePayload, opts: AttachOpts = {}) =>
  client.post<AttachResult>('/api/assistant/files', { file, ...opts }, { timeoutMs: 45000 });
/** Keep sending the file while a long document is read in parts; onPart shows each step. */
export async function askAttachAll(client: Client, file: AskFilePayload, opts: AttachOpts, onPart?: (r: AttachResult) => void): Promise<AttachResult> {
  let r = await askAttach(client, file, opts);
  const first = r.userMessage;
  while (r.more) {
    onPart?.(r);
    r = await askAttach(client, file, { conversationId: r.conversationId, ...r.more });
  }
  return { ...r, userMessage: first };
}
/** "Import now": the message with a Confirm / Cancel card. */
export const askProposeImport = (client: Client, importId: string, conversationId: string) =>
  client.post<{ conversationId: string; message: AskMessage }>(`/api/assistant/imports/${encodeURIComponent(importId)}/propose`, { conversationId });
