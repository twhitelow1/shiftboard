// The Feedback box in the app (core/feedback.js on the server): its answers' shapes, and the follow-up codes of the
// anonymous entries sent from this phone, kept on the phone only (lib/storage.ts), per restaurant. Each code keeps
// how many replies the person has read, for the "New reply" badge; signed entries keep the same by entry id.
// Deleting the app or switching phones loses them; the code itself still opens the entry.
import { Platform, Share } from 'react-native';

import { getItem, setItem } from './storage';

export type FeedbackStatus = 'new' | 'seen' | 'in_progress' | 'done' | 'wont_do';
export interface FeedbackMessage { id: string; from: 'reader' | 'submitter'; name?: string; at?: string; date?: string; text: string }
export interface FeedbackForm {
  kinds: { id: string; label: string; safety: boolean; adminsOnly: boolean }[];
  topics: { id: string; label: string }[];
  safetyNote: string; canRead: boolean; supervisorsCanRead: boolean; callOutPhone: string; managers: { name: string; phone: string }[];
}
export interface MyEntry {
  id?: string; kind: string; kindLabel: string; topic: string; topicLabel: string; message: string; date: string; status: FeedbackStatus; statusLabel: string;
  signed: boolean; replies: number; nameOk?: boolean; thread: FeedbackMessage[]; shared: { text: string; reply: string; date: string; showName: boolean } | null;
}
export interface CodeSummary { found: boolean; kindLabel?: string; topicLabel?: string; date?: string; status?: FeedbackStatus; statusLabel?: string; replies?: number }
export interface InboxEntry extends Omit<MyEntry, 'thread'> {
  id: string; author: { id: string; name: string } | null; adminsOnly: boolean;
  thread?: FeedbackMessage[]; notes?: { id: string; name: string; at: string; text: string }[]; statuses?: { id: FeedbackStatus; label: string }[];
}
export interface Inbox {
  items: InboxEntry[]; counts: Record<FeedbackStatus, number>;
  kinds: { id: string; label: string; on: boolean }[]; topics: { id: string; label: string }[]; statuses: { id: FeedbackStatus; label: string }[];
}
export interface BoardItem { id: string; kindLabel: string; topicLabel: string; text: string; reply: string; date: string; name: string }

export interface SavedCode { code: string; seen: number }
const MAX = 30;
const codesKey = (server: string) => `feedback.codes.${server}` as const;
const seenKey = (server: string) => `feedback.seen.${server}` as const;

export async function savedCodes(server: string): Promise<SavedCode[]> {
  try {
    const list = JSON.parse((await getItem(codesKey(server))) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.code === 'string').map((x) => ({ code: String(x.code), seen: Number(x.seen) || 0 })) : [];
  } catch {
    return [];
  }
}
async function writeCodes(server: string, list: SavedCode[]): Promise<boolean> {
  try { await setItem(codesKey(server), JSON.stringify(list.slice(0, MAX))); return true; } catch { return false; }
}
/** Keep a code on this phone (true when it could). */
export const keepCode = async (server: string, code: string) => writeCodes(server, [{ code, seen: 0 }, ...(await savedCodes(server)).filter((x) => x.code !== code)]);
export const forgetCode = async (server: string, code: string) => writeCodes(server, (await savedCodes(server)).filter((x) => x.code !== code));
export const markSeen = async (server: string, code: string, seen: number) => writeCodes(server, (await savedCodes(server)).map((x) => (x.code === code ? { ...x, seen } : x)));

export async function signedSeen(server: string): Promise<Record<string, number>> {
  try { const o = JSON.parse((await getItem(seenKey(server))) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
export async function markSignedSeen(server: string, id: string, seen: number) {
  const all = await signedSeen(server);
  const keep = Object.fromEntries(Object.entries({ ...all, [id]: seen }).slice(-50));
  await setItem(seenKey(server), JSON.stringify(keep)).catch(() => {});
}

/** A code as typed → XXXX-XXXX-XXXX-XXXX, or '' when it can't be one. */
export function formatCode(typed: string): string {
  const c = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 16 ? c.match(/.{4}/g)!.join('-') : '';
}

/** Copy the code (the web version) or open the share sheet (a phone: copy, notes, a message to yourself). */
export async function copyOrShare(code: string): Promise<'copied' | 'shared' | 'failed'> {
  try {
    const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } } }).navigator;
    if (Platform.OS === 'web' && nav?.clipboard?.writeText) { await nav.clipboard.writeText(code); return 'copied'; }
    await Share.share({ message: code });
    return 'shared';
  } catch {
    return 'failed';
  }
}
