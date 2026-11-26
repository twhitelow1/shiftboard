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
}
export interface AskStatus {
  available: boolean;
  reason?: string;
  message?: string;
  viewAs?: boolean;
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
