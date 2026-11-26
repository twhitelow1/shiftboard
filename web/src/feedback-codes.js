// The follow-up codes of the anonymous Feedback box entries sent from this browser (core/feedback.js), kept in this
// browser only (localStorage), never on the server. Each: { code, seen } where seen is how many replies the person
// has already read, for the "New reply" badge. Clearing the browser's data loses them: the code itself still works.
// The demo keeps its own list, with the sample entry's code (core/feedback-seed.js) already on it.
import { IS_DEMO } from './api.js';
import { DEMO_CODE } from '../../core/feedback-seed.js';

const KEY = IS_DEMO ? 'shiftboard.demo.feedbackCodes' : 'shiftboard.feedbackCodes';
const MAX = 30;

/** The saved codes, newest first. */
export function savedCodes() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null && IS_DEMO) return [{ code: DEMO_CODE, seen: 0 }];
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.code === 'string').map((x) => ({ code: x.code, seen: Number(x.seen) || 0 })) : [];
  } catch {
    return [];
  }
}
function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); return true; } catch { return false; }
}
/** Keep a code (true when this browser could save it). */
export const keepCode = (code) => write([{ code, seen: 0 }, ...savedCodes().filter((x) => x.code !== code)]);
export const forgetCode = (code) => write(savedCodes().filter((x) => x.code !== code));
/** The person has read `seen` replies of this entry. */
export const markSeen = (code, seen) => write(savedCodes().map((x) => (x.code === code ? { ...x, seen } : x)));

// Signed entries: which replies the person has read, by entry id (also on this device only).
const SIGNED = IS_DEMO ? 'shiftboard.demo.feedbackSeen' : 'shiftboard.feedbackSeen';
export function signedSeen() {
  try { const o = JSON.parse(localStorage.getItem(SIGNED) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
export function markSignedSeen(id, seen) {
  try { localStorage.setItem(SIGNED, JSON.stringify({ ...signedSeen(), [id]: seen })); } catch { /* private mode */ }
}
