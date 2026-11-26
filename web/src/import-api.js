// Smart import → Read it with AI (server/import-routes.js): the document's text in parts, each read into records.
// The demo has no server, so it never calls: AI reading shows "isn't set up" there.
import { IS_DEMO } from './api.js';
import { getLang } from './i18n/index.js';
import { AI_CHUNK_CHARS, MAX_AI_CHARS } from '../../core/smart-import.js';

export class ImportReadError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

/** Split text into parts of at most `size` characters, at line breaks where possible. */
export function chunkText(text, size = AI_CHUNK_CHARS) {
  const out = [];
  let cur = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.length > size ? line.slice(0, size) : line;
    if (cur && cur.length + l.length + 1 > size) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Read a document with AI: { records } in the order found. onPart(n, total) reports progress.
 * Throws ImportReadError with reason 'demo' | 'tooLong' | 'no_key' | 'off' | 'plan' | 'cap' | 'busy' | … .
 */
export async function readWithAi(target, text, { onPart } = {}) {
  if (IS_DEMO) throw new ImportReadError('demo', 'demo');
  if (String(text || '').length > MAX_AI_CHARS) throw new ImportReadError('tooLong', 'tooLong');
  const parts = chunkText(text);
  const records = [];
  for (let i = 0; i < parts.length; i++) {
    onPart?.(i + 1, parts.length);
    const res = await fetch('/api/import/read', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() },
      body: JSON.stringify({ target, text: parts[i], offset: records.length }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ImportReadError(body.error || `Request failed (${res.status})`, body.reason || 'api');
    records.push(...(body.result?.records || []));
  }
  return { records };
}
