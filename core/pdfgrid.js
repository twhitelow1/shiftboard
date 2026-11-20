// Rebuilds the "names down, days across" schedule grid from a PDF page's positioned text
// (as pdf.js returns it), so PDFs exported from the house spreadsheet go through the same
// parser as pasted spreadsheets (core/importer.js).
//
// Input: [{ str, x, y, w, h }] in points, x/y = left/top of the text, h = font size.
// Output: tab-separated rows, e.g. "ALEX D\tOFF\tOFF\t6:30PM\t3:30PM BC\t…".

const DAY = /^(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\.?$/i;
const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

export function itemsToGridText(items) {
  const words = (items || [])
    .map((i) => ({ ...i, str: String(i.str || '').replace(/\s+/g, ' ').trim() }))
    .filter((i) => i.str)
    .map((i) => ({ ...i, cx: i.x + (i.w || 0) / 2, cy: i.y + (i.h || 0) / 2 }));
  if (!words.length) return '';

  // 1. Visual lines: words whose vertical centers line up.
  words.sort((a, b) => a.cy - b.cy || a.x - b.x);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.cy - last.cy) <= Math.max(1.5, Math.min(w.h || 0, last.h) * 0.4)) last.words.push(w);
    else lines.push({ cy: w.cy, h: w.h || 0, words: [w] });
  }

  // 2. Day columns, from the first line of day names (MONDAY … SUNDAY).
  const header = lines.find((l) => l.words.filter((w) => DAY.test(w.str)).length >= 5);
  if (!header) return '';
  const centers = header.words.filter((w) => DAY.test(w.str)).map((w) => w.cx).sort((a, b) => a - b);
  const n = centers.length;
  const lefts = centers.map((c, i) => (i === 0 ? c - (centers[1] - c) / 2 : (centers[i - 1] + c) / 2));
  const colOf = (w) => {
    if (w.cx < lefts[0]) return 0; // the name column
    let c = 1;
    for (let i = 1; i < n; i++) if (w.cx >= lefts[i]) c = i + 1;
    return c;
  };
  const rows = lines.map((l) => {
    const cells = Array(n + 1).fill('');
    for (const w of [...l.words].sort((a, b) => a.x - b.x)) {
      const c = colOf(w);
      cells[c] = cells[c] ? `${cells[c]} ${w.str}` : w.str;
    }
    return { cy: l.cy, h: l.h, cells };
  });

  const isHeader = (r) => r.cells.slice(1).filter((c) => DAY.test(c)).length >= 4;
  const isDates = (r) => r.cells.slice(1).filter((c) => DATE.test(c)).length >= 3;
  const dayText = (r) => r.cells.slice(1).filter(Boolean);
  // A section banner (RABBIT HOLE, MOON RABBIT…) is printed mid-table on its own line, right above a day header.
  const isBanner = (i) => {
    const r = rows[i];
    if (r.cells[0] || dayText(r).length !== 1 || isHeader(r) || isDates(r)) return false;
    for (let k = i + 1; k < Math.min(rows.length, i + 3); k++) {
      if (isHeader(rows[k])) return true;
      if (!isDates(rows[k])) return false;
    }
    return false;
  };
  const isNote = (i) => !rows[i].cells[0] && !isHeader(rows[i]) && !isDates(rows[i]) && !isBanner(i);

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (isBanner(i)) { out.push([dayText(r)[0]]); continue; }
    if (!isNote(i)) { out.push(r.cells); continue; }
    // A run of unlabeled lines (day notes such as "CONCIERGE NIGHT FULL BUYOUT / 150 PPL"):
    // rebuild each day's paragraphs, splitting where there's a visible gap between lines.
    let j = i;
    while (j < rows.length && isNote(j)) j++;
    const run = rows.slice(i, j);
    const paras = [];
    for (let c = 1; c <= n; c++) {
      const ls = run.filter((x) => x.cells[c]);
      const list = [];
      let prev = null;
      for (const x of ls) {
        if (prev && x.cy - prev.cy <= Math.max(prev.h, x.h) * 1.6) list[list.length - 1] += ` ${x.cells[c]}`;
        else list.push(x.cells[c]);
        prev = x;
      }
      paras[c] = list;
    }
    const depth = Math.max(0, ...paras.slice(1).map((p) => p.length));
    for (let k = 0; k < depth; k++) out.push(['', ...paras.slice(1).map((p) => p[k] || '')]);
    i = j - 1;
  }
  return out.map((cells) => cells.join('\t').replace(/\t+$/, '')).join('\n');
}
