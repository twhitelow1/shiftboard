// Reads PDFs in the browser (pdf.js). A schedule PDF comes back as the grid in tab-separated text for
// core/importer.js, plus the background colors behind its labels (banner colors); a BEO PDF as positioned
// text for core/beo-import.js. Loaded on demand from the import dialogs, so pdf.js never weighs down the app.
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { itemsToGridText, fillRects, labelColors } from '../../core/pdfgrid.js';

GlobalWorkerOptions.workerSrc = workerUrl;

/** A font pdf.js has loaded for a page (its name says bold or italic), or null if it doesn't come. */
function loadedFont(page, id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    const done = (f) => { clearTimeout(timer); resolve(f || null); };
    try { page.commonObjs.get(id, done, () => done(null)); } catch { done(null); }
  });
}

/**
 * Every page's text with its position and style, for the BEO importer (core/beo-import.js parseBeos):
 * [{ page, str, x, y, w, h, bold, italic }] in points, x/y = left/top, h = font size.
 */
export async function pdfToItems(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  // Font names (Roboto-Bold, Lato-Italic) are "extra properties"; nothing is drawn, so no font faces either.
  const task = getDocument({ data, isEvalSupported: false, fontExtraProperties: true, disableFontFace: true });
  const doc = await task.promise;
  try {
    const items = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { height } = page.getViewport({ scale: 1 });
      const { items: runs } = await page.getTextContent();
      const fonts = {};
      try {
        await page.getOperatorList(); // loads the page's fonts
        for (const id of new Set(runs.map((i) => i.fontName).filter(Boolean))) fonts[id] = await loadedFont(page, id);
      } catch { /* bold and italic are hints; the BEO still reads without them */ }
      for (const i of runs) {
        if (!('str' in i) || !i.str.trim()) continue;
        const [, , c, d, e, f] = i.transform;
        const h = Math.hypot(c, d) || i.height || 0;
        const font = fonts[i.fontName];
        const name = String(font?.name || '');
        items.push({
          page: p, str: i.str, x: e, y: height - f - h, w: i.width, h,
          bold: !!(font?.bold || font?.black) || /bold|black|heavy|semibold|demi/i.test(name),
          italic: !!font?.italic || /italic|oblique/i.test(name),
        });
      }
    }
    return { items, pages: doc.numPages };
  } finally {
    task.destroy();
  }
}

/** → { text, colors } where colors maps upper-case label text to its cell color. */
export async function pdfToGridText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const pages = [];
    const colors = {};
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { height } = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      const words = items.filter((i) => 'str' in i && i.str.trim()).map((i) => {
        const [, , c, d, e, f] = i.transform;
        const h = Math.hypot(c, d) || i.height || 0;
        return { str: i.str, x: e, y: height - f - h, w: i.width, h };
      });
      pages.push(itemsToGridText(words));
      try {
        const ops = await page.getOperatorList();
        const found = labelColors(words, fillRects(ops.fnArray, ops.argsArray, OPS, height));
        for (const [k, v] of Object.entries(found)) if (!colors[k]) colors[k] = v;
      } catch { /* colors are a nicety; the schedule still imports */ }
    }
    return { text: pages.filter(Boolean).join('\n'), colors };
  } finally {
    task.destroy();
  }
}
