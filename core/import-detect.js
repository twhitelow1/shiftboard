// Ask ShiftBoard's file imports, the pure part: turning an attached file into a "document" every import target can
// look at, and the cheap local signals that say what kind of document it is (no AI, no I/O). The server's import
// registry (server/assistant/import-registry.js) scores each target with these and only asks the AI when unsure.
//
//   extractDocument(file) → doc   file: { name, type, size, text? | data? (base64) | sheets? | items? (pdf.js) | image? }
//     doc: { name, ext, kind: 'table' | 'xlsx' | 'docx' | 'pdf' | 'image' | 'text', size,
//            sheets: [{ name, rows }], text, blocks?, items?, image?: { mediaType, data }, pdf?: base64 }
//   chunkText(text, size)          the same parts "Read it with AI" sends (one AI call each, inside Vercel's 30 s)
//   headerHits(rows, names)        how many of a list of column names the best header row has
//
// The web app reads XLSX, DOCX and PDF in the browser (core/smart-import.js, web/src/pdf.js) and sends the sheets,
// text or pdf.js items; the phone app sends the file's bytes (base64) and the server reads them here, the same way.
import { unzipSync, strFromU8 } from 'fflate';
import { readTable, readDocx, headerKey, AI_CHUNK_CHARS } from './smart-import.js';

export const MAX_UPLOAD_CHARS = 1_900_000; // base64 or text in one JSON request (the API takes 2 MB)
export const MAX_SHEET_ROWS = 5000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXT = ['csv', 'tsv', 'txt', 'text'];

/** What kind of file it is from its name and type: 'table' (CSV/TSV) | 'text' | 'xlsx' | 'docx' | 'pdf' | 'image' | null. */
export function kindOf(name = '', type = '') {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (ext === 'csv' || ext === 'tsv' || type === 'text/csv') return 'table';
  if (TEXT_EXT.includes(ext) || /^text\//.test(type)) return 'text';
  if (ext === 'xlsx' || /spreadsheetml/.test(type)) return 'xlsx';
  if (ext === 'docx' || /wordprocessingml/.test(type)) return 'docx';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'].includes(ext) || /^image\//.test(type)) return 'image';
  return null;
}

const b64ToBytes = (s) => {
  const clean = String(s || '').replace(/^data:[^,]*,/, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const cellText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const cleanRows = (rows) => (Array.isArray(rows) ? rows : []).slice(0, MAX_SHEET_ROWS)
  .map((r) => (Array.isArray(r) ? r.slice(0, 80).map((c) => cellText(c).slice(0, 2000)) : [])).filter((r) => r.some(Boolean));

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e.toLowerCase()] || m));

/** Every sheet of an Excel workbook, with its tab name, in the workbook's order: [{ name, rows }]. */
export function readXlsxSheets(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    filter: (f) => f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) || f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels',
  });
  if (!files['xl/workbook.xml'] && !Object.keys(files).some((n) => n.startsWith('xl/worksheets/'))) throw new Error('not an xlsx');
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of strFromU8(files['xl/sharedStrings.xml']).match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(unxml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  const targetOf = (rid) => {
    const m = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`));
    return m ? `xl/${m[1].replace(/^\/?xl\//, '')}` : null;
  };
  let order = [];
  if (files['xl/workbook.xml']) {
    for (const m of strFromU8(files['xl/workbook.xml']).matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const name = unxml((m[1].match(/\bname="([^"]*)"/) || [])[1] || '');
      const rid = (m[1].match(/\br:id="([^"]+)"/) || [])[1];
      const path = rid ? targetOf(rid) : null;
      if (path && files[path]) order.push({ name, path });
    }
  }
  if (!order.length) {
    order = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10))
      .map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  }
  const col = (ref) => [...String(ref).replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return order.map(({ name, path }) => {
    const rows = [];
    for (const r of strFromU8(files[path]).match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const out = [];
      for (const c of r.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/\br="([A-Z]+)\d+"/) || [])[1];
        const type = (c.match(/\bt="(\w+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let value = '';
        if (type === 's') value = shared[+v] ?? '';
        else if (type === 'inlineStr') value = unxml((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        else if (v !== undefined) value = unxml(v);
        out[ref ? col(ref) : out.length] = cellText(value);
      }
      rows.push(Array.from(out, (x) => x ?? ''));
    }
    return { name, rows: cleanRows(rows) };
  }).filter((s) => s.rows.length);
}

/** pdf.js items → plain lines (cells separated by two spaces), page by page. */
export function pdfText(items) {
  const lines = [];
  let cur = null;
  for (const i of [...(items || [])].filter((x) => x && String(x.str || '').trim()).sort((a, b) => (a.page - b.page) || (a.y - b.y) || (a.x - b.x))) {
    if (cur && cur.page === i.page && Math.abs(i.y - cur.y) <= Math.max(2, (i.h || 8) * 0.5)) cur.parts.push(i);
    else { cur = { page: i.page, y: i.y, parts: [i] }; lines.push(cur); }
  }
  return lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => cellText(p.str)).join('  ')).join('\n');
}

const cleanItems = (items) => (Array.isArray(items) ? items.slice(0, 40_000) : []).filter((i) => i && typeof i.str === 'string')
  .map((i) => ({ page: Number(i.page) || 1, str: i.str.slice(0, 500), x: Number(i.x) || 0, y: Number(i.y) || 0, w: Number(i.w) || 0, h: Number(i.h) || 0, bold: !!i.bold, italic: !!i.italic }));

/**
 * An attached file → the document the import targets read. Throws an Error with .code: 'type' (not a file we read),
 * 'empty', 'unreadable', 'tooBig'.
 */
export function extractDocument(file = {}) {
  const name = cellText(file.name).slice(0, 120) || 'file';
  const kind = kindOf(name, file.type || '');
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  if (!kind) fail('type');
  for (const k of ['text', 'data']) if (typeof file[k] === 'string' && file[k].length > MAX_UPLOAD_CHARS) fail('tooBig');
  const doc = { name, ext: (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase(), kind, size: Number(file.size) || 0, sheets: [], text: '' };
  try {
    if (kind === 'table' || kind === 'text') {
      const text = typeof file.text === 'string' ? file.text : file.data ? new TextDecoder().decode(b64ToBytes(file.data)) : '';
      doc.text = text.replace(/^﻿/, '').replace(/\u0000/g, '');
      const rows = cleanRows(readTable(doc.text));
      if (rows.length && (kind === 'table' || (rows.length >= 2 && Math.max(...rows.map((r) => r.length)) >= 2 && /[,\t;]/.test(doc.text.split('\n')[0] || '')))) doc.sheets = [{ name, rows }];
    } else if (kind === 'xlsx') {
      doc.sheets = Array.isArray(file.sheets) ? file.sheets.map((s) => ({ name: cellText(s?.name).slice(0, 60), rows: cleanRows(s?.rows) })).filter((s) => s.rows.length) : readXlsxSheets(b64ToBytes(file.data));
      doc.text = doc.sheets.map((s) => `# ${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`).join('\n\n');
    } else if (kind === 'docx') {
      const d = Array.isArray(file.blocks) || typeof file.text === 'string'
        ? { text: String(file.text || ''), tables: Array.isArray(file.tables) ? file.tables : [] }
        : readDocx(b64ToBytes(file.data));
      doc.text = String(d.text || '');
      doc.sheets = (d.tables || []).map((rows, i) => ({ name: `Table ${i + 1}`, rows: cleanRows(rows) })).filter((s) => s.rows.length);
    } else if (kind === 'pdf') {
      doc.items = cleanItems(file.items);
      doc.text = doc.items.length ? pdfText(doc.items) : String(file.text || '');
      if (typeof file.data === 'string' && file.data) doc.pdf = file.data.replace(/^data:[^,]*,/, '');
      if (!doc.text.trim() && !doc.pdf) fail('empty');
    } else if (kind === 'image') {
      const mediaType = IMAGE_TYPES.includes(file.mediaType) ? file.mediaType : IMAGE_TYPES.includes(file.type) ? file.type : 'image/jpeg';
      const data = String(file.data || '').replace(/^data:[^,]*,/, '');
      if (!data || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) fail('unreadable');
      doc.image = { mediaType, data, width: Number(file.width) || 0, height: Number(file.height) || 0 };
    }
  } catch (e) {
    if (e.code) throw e;
    fail('unreadable');
  }
  if (kind !== 'image' && kind !== 'pdf' && !doc.text.trim() && !doc.sheets.length) fail('empty');
  return doc;
}

/** Split text into parts of at most `size` characters, at line breaks where possible (as "Read it with AI" does). */
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

// ---------------------------------------------------------------- signals

/** A word list in a text, case and accents folded: how many of the words or phrases appear. */
export function wordHits(text, words) {
  const s = ` ${headerKey(text)} `;
  return words.filter((w) => s.includes(` ${headerKey(w)} `)).length;
}

/** The best header row of the first rows: { index, hits } where hits counts the names (headerKey-folded) it has. */
export function headerHits(rows, names, { scan = 25 } = {}) {
  const want = names.map(headerKey);
  let best = { index: -1, hits: 0 };
  for (const [i, r] of (rows || []).slice(0, scan).entries()) {
    const keys = new Set(r.map(headerKey).filter(Boolean));
    const hits = want.filter((n) => keys.has(n)).length;
    if (hits > best.hits) best = { index: i, hits };
  }
  return best;
}

/** The text a classifier or a person sees first: tab names and the first rows of each sheet, or the text's start. */
export function docSample(doc, max = 3000) {
  if (doc.sheets?.length) {
    const parts = doc.sheets.slice(0, 6).map((s) => `${doc.kind === 'xlsx' ? `[Sheet "${s.name}"]\n` : ''}${s.rows.slice(0, 12).map((r) => r.join(' | ')).join('\n')}`);
    const s = parts.join('\n\n');
    if (s.length >= max || !doc.text) return s.slice(0, max);
    return `${s}\n\n${doc.text}`.slice(0, max);
  }
  return String(doc.text || '').slice(0, max);
}

const LEVEL = [[80, 'high'], [55, 'medium'], [1, 'low']];
/** A score 0–100 → 'high' | 'medium' | 'low' | null. */
export const levelOf = (score) => LEVEL.find(([at]) => score >= at)?.[1] || null;
