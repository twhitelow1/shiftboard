// Reads a schedule PDF in the browser (pdf.js) and returns the grid as tab-separated text for
// core/importer.js. Loaded on demand from the import dialog, so pdf.js never weighs down the app.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { itemsToGridText } from '../../core/pdfgrid.js';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function pdfToGridText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const pages = [];
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
    }
    return pages.filter(Boolean).join('\n');
  } finally {
    task.destroy();
  }
}
