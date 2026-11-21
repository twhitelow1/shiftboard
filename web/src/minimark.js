// A tiny, safe formatter for employee manual pages. It understands:
//   # Heading, ## Smaller heading, ### Smallest
//   - bullet lists (also * and •), 1. numbered lists
//   **bold**, *italic*, [link text](https://…) (also mailto:, tel:, sms: and #/app links)
//   > a highlighted note
// Blank lines separate paragraphs. It returns plain data that React renders as elements: no HTML is
// ever parsed or injected, so a page can't carry scripts or styles.

/** Split text into blocks: { type: 'h', level, text } | { type: 'p' | 'note', lines } | { type: 'list', ordered, start, items } */
export function parseBlocks(src) {
  const blocks = [];
  let para = null;
  let list = null;
  for (const raw of String(src ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { para = null; list = null; continue; }
    if ((m = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/))) {
      para = null; list = null;
      blocks.push({ type: 'h', level: m[1].length, text: m[2].replace(/\s+#+\s*$/, '') });
      continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      para = null;
      if (!list || list.ordered) blocks.push(list = { type: 'list', ordered: false, items: [] });
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/))) {
      para = null;
      if (!list || !list.ordered) blocks.push(list = { type: 'list', ordered: true, start: Number(m[1]), items: [] });
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; } // a wrapped list item
    list = null;
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      if (para?.type !== 'note') blocks.push(para = { type: 'note', lines: [] });
      para.lines.push(m[1]);
      continue;
    }
    if (para?.type !== 'p') blocks.push(para = { type: 'p', lines: [] });
    para.lines.push(line.trim());
  }
  return blocks;
}

/** Only these links are made clickable; anything else stays plain text. */
export function safeHref(url) {
  const u = String(url ?? '').trim();
  return /^(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+|tel:[+\d().\-\s]+|sms:[+\d().\-\s]+|#\/[\w\-/]*)$/i.test(u) ? u : null;
}

const INLINE = /\*\*(.+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\s](?:[^*]*[^*\s])?)\*/g;

/** Inline text as tokens: { t: 'text', v } | { t: 'b' | 'i', c: tokens } | { t: 'a', href, c: tokens } */
export function parseInline(text) {
  const out = [];
  const s = String(text ?? '');
  const re = new RegExp(INLINE.source, 'g'); // its own copy: the calls below recurse
  let last = 0;
  for (let m; (m = re.exec(s));) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1] != null) out.push({ t: 'b', c: parseInline(m[1]) });
    else if (m[2] != null) {
      const href = safeHref(m[3]);
      out.push(href ? { t: 'a', href, c: parseInline(m[2]) } : { t: 'text', v: m[0] });
    } else out.push({ t: 'i', c: parseInline(m[4]) });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

/** Plain text of a page (for a short preview): no formatting marks. */
export function plainText(src, max = 160) {
  const flat = (tokens) => tokens.map((x) => (x.t === 'text' ? x.v : flat(x.c))).join('');
  const parts = parseBlocks(src).map((b) => (b.type === 'h' ? b.text : b.type === 'list' ? b.items.join(' · ') : b.lines.join(' ')));
  const text = flat(parseInline(parts.join(' ')));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
