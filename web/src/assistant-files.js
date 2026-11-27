// Ask ShiftBoard: a file attached in the chat (paperclip or drag-and-drop), read here in the browser the way the
// imports read it (core/smart-import.js, core/import-detect.js, web/src/pdf.js) and sent to the server as its text,
// sheets or pdf.js items (server/assistant/imports.js); a picture is shrunk first like the floor plan import does.
// The file stays in this tab (for "Review & import" and for another pick of what it is); the server never stores it.
import { kindOf, readXlsxSheets, MAX_UPLOAD_CHARS } from '../../core/import-detect.js';
import { readDocx, MAX_FILE_BYTES } from '../../core/smart-import.js';
import { IS_DEMO } from './api.js';
import { preparePicture } from './pages/FloorImport.jsx';

export const ACCEPT = '.pdf,.docx,.xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/csv,text/plain,image/*,'
  + 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_PDF_BYTES = 1_400_000; // a scanned PDF (no text) goes as itself, for the AI to read

const err = (key) => Object.assign(new Error(key), { key });
const base64 = async (f) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * A File → { payload, picture? } for POST /api/assistant/files. Throws an Error with .key (an i18n key):
 * assistant.fileType | assistant.fileTooBig | assistant.fileUnreadable.
 */
export async function readAttachment(f) {
  const kind = kindOf(f.name, f.type);
  if (!kind) throw err('assistant.fileType');
  if (kind !== 'image' && f.size > MAX_FILE_BYTES) throw err('assistant.fileTooBig');
  const base = { name: f.name, type: f.type || '', size: f.size };
  let payload;
  let picture = null;
  try {
    if (kind === 'table' || kind === 'text') payload = { ...base, text: await f.text() };
    else if (kind === 'xlsx') payload = { ...base, sheets: readXlsxSheets(new Uint8Array(await f.arrayBuffer())) };
    else if (kind === 'docx') {
      const d = readDocx(new Uint8Array(await f.arrayBuffer()));
      payload = { ...base, text: d.text, tables: d.tables };
    } else if (kind === 'pdf') {
      let items = [];
      if (!IS_DEMO) { const { pdfToItems } = await import('./pdf.js'); items = (await pdfToItems(f)).items; }
      payload = { ...base, items, ...(!items.length && f.size <= MAX_PDF_BYTES ? { data: await base64(f) } : {}) };
    } else {
      const p = await preparePicture(f);
      if (!p) throw err('assistant.fileUnreadable');
      picture = { ...p, name: f.name };
      payload = { ...base, type: p.mediaType, mediaType: p.mediaType, data: p.base64, width: p.width, height: p.height };
    }
  } catch (e) {
    throw e.key ? e : err('assistant.fileUnreadable');
  }
  if (JSON.stringify(payload).length > MAX_UPLOAD_CHARS) throw err('assistant.fileTooBig');
  return { payload, picture, file: f };
}

/** The text of a table the way a CSV says it (for the OpenTable / review wizards, which read CSV text). */
export function sheetCsv(rows) {
  return (rows || []).map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}
