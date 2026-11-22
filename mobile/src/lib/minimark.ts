// The employee manual's simple formatting, copied from web/src/minimark.js (keep them in step):
//   # Heading, ## Smaller heading, ### Smallest · - bullet lists (also * and •), 1. numbered lists
//   **bold**, *italic*, [link text](https://…) (also mailto:, tel:, sms: and #/app links) · > a highlighted note
// Blank lines separate paragraphs. It returns plain data that components/Markdown.tsx draws: no HTML, ever.

export type Block =
  | { type: 'h'; level: number; text: string }
  | { type: 'p' | 'note'; lines: string[] }
  | { type: 'list'; ordered: boolean; start?: number; items: string[] };

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: Extract<Block, { type: 'p' | 'note' }> | null = null;
  let list: Extract<Block, { type: 'list' }> | null = null;
  for (const raw of String(src ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!line.trim()) { para = null; list = null; continue; }
    if ((m = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/))) {
      para = null; list = null;
      blocks.push({ type: 'h', level: m[1].length, text: m[2].replace(/\s+#+\s*$/, '') });
      continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      para = null;
      if (!list || list.ordered) blocks.push((list = { type: 'list', ordered: false, items: [] }));
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/))) {
      para = null;
      if (!list || !list.ordered) blocks.push((list = { type: 'list', ordered: true, start: Number(m[1]), items: [] }));
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    list = null;
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      if (para?.type !== 'note') blocks.push((para = { type: 'note', lines: [] }));
      para.lines.push(m[1]);
      continue;
    }
    if (para?.type !== 'p') blocks.push((para = { type: 'p', lines: [] }));
    para.lines.push(line.trim());
  }
  return blocks;
}

/** Only these links are made tappable; anything else stays plain text. */
export function safeHref(url: string): string | null {
  const u = String(url ?? '').trim();
  return /^(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+|tel:[+\d().\-\s]+|sms:[+\d().\-\s]+|#\/[\w\-/]*)$/i.test(u) ? u : null;
}

export type Inline = { t: 'text'; v: string } | { t: 'b' | 'i'; c: Inline[] } | { t: 'a'; href: string; c: Inline[] };
const INLINE = /\*\*(.+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\s](?:[^*]*[^*\s])?)\*/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const s = String(text ?? '');
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s));) {
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
