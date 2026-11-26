// Banquet Event Orders (BEOs) from a PDF. One PDF can hold several BEOs back to back (Tripleseat's BEO
// export does): each starts on a page with INVOICE #, the event's name in large type, its long date and
// the heading BANQUET EVENT ORDER, and every page has a footer "<n> of <m>  <Event name>" that restarts
// at "1 of" for the next event.
//
// Everything here is pure, so it runs the same in the browser and on the server:
//   parseBeos(items)        pdf.js text items (web/src/pdf.js pdfToItems) → one event per BEO, for the preview
//   matchRooms(areas, …)    the BEO's "Areas" text → a venue room (or a booking like Full Buyout)
//   beoToEvent(parsed, …)   a parsed BEO → what the web app sends to events.importBeos
//   cleanBeoEvent(raw)      the server's validation of what comes back (never trusts the browser)
//   mergeBeo(existing, b)   what a re-import changes on an event that's already in ShiftBoard
//
// Money stays out. Prices, totals, tax, gratuity, deposits, card digits and payment notes are dropped
// when the PDF is read and again by cleanBeoEvent on the server. The only amounts kept are the guest
// count and the F&B minimum.
//
// Input items: { page, str, x, y, w, h, bold?, italic? } in points; x/y = left/top of the text, h = font size.
import { SERVICE_STYLES } from './beo.js';
import { fingerprint, sectionKeyFor, kindFor, SECTION_KEYS, SECTION_KINDS, MIRRORED_FIELDS, LABEL_KEYS } from './beo-sections.js';

export { fingerprint };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => clean(s).toLowerCase();
/** Spacing pdf.js leaves around punctuation when a line is made of several runs: "Tab (Available: 8 pm )". */
const tidy = (s) => clean(s).replace(/\s+([),.;:!?])/g, '$1').replace(/([(])\s+/g, '$1');
const isUpper = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s);

// ---------- money: never imported ----------
const MONEY = /[-–]?\$\s?\d[\d,]*(?:\.\d+)?/;
const MONEY_ALL = /[-–]?\$\s?\d[\d,]*(?:\.\d+)?/g;
const AMOUNT = String.raw`(?:[-–]?\$\s?[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%)`;
/** A run that's only prices or percentages ("$125.00", "25% $7,500.00 $7,500.00"): a price column. */
const MONEYISH = new RegExp(`^${AMOUNT}(?:\\s+${AMOUNT})*$`);
const FINANCIAL = /\b(deposits?|credit cards?|debit cards?|gift cards?|visa|master ?card|amex|american express|invoices?|sub-?totals?|grand totals?|gratuity|tax rate|sales tax|admin(?:istrative)? fees?|service (?:fees?|charges?)|fees?|amount due|balance due|paid|payments?|refund(?:able)?|discount(?:ed|s)?|waived|f&b min(?:imum)?|food (?:and|&) beverage minimum|minimum spend|spend hit|cc)\b/i;
const CARD_DIGITS = /\d(?:[ -]?\d){12,18}/; // a card number, 13 to 19 digits (phones are shorter)
const CARD_LAST4 = /\b(?:card|visa|master ?card|amex|discover|ending(?: in)?)\s*#?\s*(?:x+|\*+)?\s*\d{4}\b|(?:x{4,}|\*{4,})\s*\d{4}\b/i;

/** A line about money or payment (prices, deposits, cards, fees, minimums): left out of every note. */
export function isFinancial(text) {
  const s = String(text || '');
  return MONEY.test(s) || FINANCIAL.test(s) || CARD_DIGITS.test(s) || CARD_LAST4.test(s);
}
/** A name with its price taken off: "Winter Spritz $14" → "Winter Spritz". */
// A price and what it's per ("$28 pp", "$14 each", "$40 / per guest", "$9++").
const PRICE_PER = /[-–]?\$\s?\d[\d,]*(?:\.\d+)?(?:\s*\+\+)?(?:\s*(?:\/\s*)?(?:pp|p\/p|per\s+(?:person|guest|piece|pc|hour|hr|dozen|platter|gallon)|each|ea\.?)(?![a-z]))?/gi;
export function stripMoney(text) {
  return tidy(String(text || '').replace(PRICE_PER, ' ').replace(MONEY_ALL, ' ').replace(/\(\s*\)/g, ' ')).replace(/\s*[-–/]\s*$/, '').trim();
}
/** A name with its price at the end ("Winter Spritz $14"): the name stays, the price goes. */
const PRICE_TAG = /^[A-Za-z0-9“"'][^$]*\$\s?\d[\d,]*(?:\.\d+)?\s*$/;
const moneyLine = (t) => isFinancial(PRICE_TAG.test(t) ? stripMoney(t) : t);
/** Notes without their money lines (one note per line). */
export function scrubNotes(text, max = 4000) {
  return String(text || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !isFinancial(l)).join('\n').slice(0, max);
}

// ---------- dates and times ----------
const validDate = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : '');
/** 'Friday, November 20, 2026' → '2026-11-20' (also 'Nov 20 2026'), or ''. */
export function parseLongDate(text) {
  const m = norm(text).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  return m ? validDate(+m[3], MONTHS.findIndex((x) => x.startsWith(m[1])) + 1, +m[2]) : '';
}
/** '11/20/2026', '11/20/ 2026' (a wrapped cell), '7/14/26' → ISO, or ''. */
export function parseSlashDate(text) {
  const m = clean(text).replace(/\s*\/\s*/g, '/').match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/);
  if (!m) return '';
  return validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
}
const suf = (s) => (s ? s[0].toLowerCase() : '');
function hm(h, m, s) {
  let hh = Number(h);
  const mm = Number(m || 0);
  if (!Number.isInteger(hh) || hh > 23 || mm > 59) return '';
  if (s === 'p' && hh < 12) hh += 12;
  if (s === 'a' && hh === 12) hh = 0;
  return `${pad(hh)}:${pad(mm)}`;
}
// A time with an optional am/pm that isn't the start of a word ("4:30 and" is not "4:30 a").
const T = String.raw`(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?(?![a-z]))?`;
const RANGE = new RegExp(`${T}\\s*(?:-|–|—|to)\\s*${T}`, 'i');
/** '8:00 pm – 9:30 pm', '4:30 - 9:30', '5:30 pm – 12:00 am', '4:30PM - 5:30PM' → { start, end } in 24h, or null. */
export function parseTimeRange(text) {
  const m = clean(text).match(RANGE);
  if (!m) return null;
  let [, sh, sm, sa, eh, em, ea] = m;
  sa = suf(sa); ea = suf(ea);
  const s12 = Number(sh) % 12, e12 = Number(eh) % 12;
  if (!sa && ea) sa = s12 > e12 && ea === 'p' ? 'a' : ea; // 11 – 2 pm is 11 am
  else if (sa && !ea) ea = e12 < s12 ? (sa === 'a' ? 'p' : 'a') : sa;
  else if (!sa && !ea) { sa = Number(sh) >= 10 && Number(sh) < 12 ? 'a' : 'p'; ea = e12 < s12 ? 'p' : sa; }
  const start = hm(sh, sm, sa), end = hm(eh, em, ea);
  return start && end && (sm || em || ea || sa) ? { start, end } : null;
}
/** One time: '7:30PM', '7:00 PM', '6pm', '7:20' (am/pm from `after`, the time before it). → 'HH:MM' or ''. */
export function parseTime(text, after = '') {
  const s = clean(text);
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(?:([ap])\.?m?\.?)?$/i) || s.match(/^(\d{1,2})()\s*([ap])\.?m\.?$/i);
  if (!m) return '';
  if (m[3]) return hm(m[1], m[2], suf(m[3]));
  const am = hm(m[1], m[2], 'a'), pm = hm(m[1], m[2], 'p');
  if (!am) return '';
  if (after) return am >= after ? am : pm >= after ? pm : am;
  return Number(m[1]) >= 10 && Number(m[1]) < 12 ? am : pm; // restaurant hours
}
/** 'Updated: 11/18/2026 11:20 am' → '2026-11-18T11:20' (or the date alone). */
function parseStamp(text) {
  const m = clean(text).match(/updated:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*([ap])?\.?m?)?/i);
  if (!m) return '';
  const date = validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  if (!date) return '';
  return m[4] ? `${date}T${hm(m[4], m[5], suf(m[6]) || (Number(m[4]) < 12 ? 'a' : ''))}` : date;
}
const money = (text) => {
  const m = String(text || '').match(/\$\s?([\d,]+(?:\.\d+)?)/);
  return m ? Math.round(Number(m[1].replace(/,/g, '')) * 100) / 100 : 0;
};

// ---------- lines from positioned text ----------
const CELL_GAP = 18; // points between two runs that make them separate cells on one line

function finishLine(raw, page) {
  const all = raw.sort((a, b) => a.x - b.x);
  // A run drawn twice (or a shorter copy under a longer one): keep the longer one.
  const redundant = (a, b) => {
    if (a === b) return false;
    const over = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (over <= Math.max(1, 0.5 * Math.min(a.w || 1, b.w || 1))) return false;
    if (a.str === b.str) return all.indexOf(a) > all.indexOf(b);
    return b.str.length > a.str.length && (b.str.startsWith(a.str) || b.str.endsWith(a.str));
  };
  const items = all.filter((a) => !all.some((b) => redundant(a, b)));
  const cells = [];
  for (const it of items) {
    const c = cells[cells.length - 1];
    if (c && it.x - c.right <= CELL_GAP) { c.parts.push(it); c.right = Math.max(c.right, it.x + it.w); } else cells.push({ x: it.x, right: it.x + it.w, parts: [it] });
  }
  const weight = (list, key) => {
    const total = list.reduce((n, i) => n + i.str.length, 0);
    return total > 0 && list.filter((i) => i[key]).reduce((n, i) => n + i.str.length, 0) * 2 > total;
  };
  return {
    page, items,
    y: Math.min(...items.map((i) => i.y)),
    h: Math.max(...items.map((i) => i.h)),
    x: items[0].x,
    right: Math.max(...items.map((i) => i.x + i.w)),
    text: tidy(items.map((i) => i.str).join(' ')),
    bold: weight(items, 'bold'),
    italic: weight(items, 'italic'),
    cells: cells.map((c) => ({ x: c.x, right: c.right, text: tidy(c.parts.map((i) => i.str).join(' ')), bold: weight(c.parts, 'bold'), italic: weight(c.parts, 'italic') })),
  };
}

/** One page's lines: runs that share a baseline, left to right. */
function pageLines(items, page) {
  const sorted = [...items].sort((a, b) => a.y + a.h - (b.y + b.h) || a.x - b.x);
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.y + it.h - g.base) <= 2) g.items.push(it); else groups.push({ base: it.y + it.h, items: [it] });
  }
  return groups.map((g) => finishLine(g.items, page));
}

const FOOTER = /^(\d{1,3})\s*of\s*(\d{1,3})\b\s*(.*)$/i;
const STAMP = /^updated:/i;

function readPages(raw) {
  const items = (raw || []).map((i) => ({
    page: Number(i.page) || 1, str: clean(i.str), x: Number(i.x) || 0, y: Number(i.y) || 0, w: Math.max(0, Number(i.w) || 0), h: Math.max(0, Number(i.h) || 0),
    bold: !!i.bold, italic: !!i.italic,
  })).filter((i) => i.str);
  const byPage = new Map();
  for (const it of items) (byPage.get(it.page) || byPage.set(it.page, []).get(it.page)).push(it);
  return [...byPage.keys()].sort((a, b) => a - b).map((page) => {
    const list = byPage.get(page);
    const stamps = list.filter((i) => STAMP.test(i.str)).map((i) => i.str);
    // The footer "<n> of <m>  <name>": the lowest run that starts that way, with whatever shares its baseline in its size.
    const bottom = Math.max(...list.map((i) => i.y));
    const hit = list.filter((i) => FOOTER.test(i.str) && i.y >= bottom - 20).sort((a, b) => b.y - a.y)[0];
    const feet = hit ? list.filter((i) => Math.abs(i.y + i.h - (hit.y + hit.h)) <= 2 && i.h <= hit.h + 0.5 && i.x >= hit.x - 2) : [];
    const f = hit && tidy(feet.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ')).match(FOOTER);
    const footer = f && +f[1] >= 1 && +f[1] <= +f[2] ? { n: +f[1], m: +f[2], name: clean(f[3]) } : null;
    const lines = pageLines(list.filter((i) => !STAMP.test(i.str) && !(footer && feet.includes(i))), page);
    const head = lines.some((l) => /^banquet event order$/i.test(l.text) || /\binvoice\s*#/i.test(l.text));
    return { page, lines, stamps, footer, head };
  });
}

/** Pages → one group per BEO: a new one where the footer restarts at "1 of", or at a BEO header page. */
function splitPages(pages) {
  const groups = [];
  for (const pg of pages) {
    const cur = groups[groups.length - 1];
    const n = pg.footer?.n;
    if (!cur || n === 1 || (pg.head && !(n > 1))) groups.push([pg]); else cur.push(pg);
  }
  return groups.filter((g) => g.some((p) => p.head || p.footer));
}

// ---------- sections ----------
const HEADINGS = [
  ['summary', /^event summary$/i],
  ['rental', /^rentals?$/i],
  ['food', /^food(?: (?:and|&) (?:menu|beverage))?$/i],
  ['beverage', /^beverages?$/i],
  ['av', /^(?:av|a\/v|audio ?\/ ?visual)(?: support)?(?: needs)?$/i],
  ['dietary', /^dietary restrictions?(?: and counts)?:?$/i],
  ['contacts', /^contact information\b.*$/i, 'main'],
  ['contacts', /^(?:host|vendor|host\s*\/\s*event)\b.*\bcontact details:?$/i, 'label'],
  ['setup', /^set[- ]?up (?:notes|details):?$/i, 'main'],
  ['setup', /^(?:floor ?plans?|layout|room layout):?$/i, 'label'],
  ['special', /^special instructions:?$/i, 'main', true],
  ['totals', /^total$/i, 'main', true],
  ['end', /^client signature$/i, 'main', true],
];
const LEFT = 70; // section headings start at the left margin (except the centered ones)
const HEAD_WORDS = /^(qty|quantity|price|unit price|discount|discount price|price discount|total|amount)$/i;

function headingOf(line, next) {
  const t = line.text;
  if (line.cells.length === 2 && /^date:?$/i.test(line.cells[0].text) && /^event day$/i.test(line.cells[1].text)) return { key: 'timeline', act: line.cells[1].x };
  for (const [key, re, kind = 'main', anyX] of HEADINGS) {
    if (re.test(t) && (anyX || line.x < LEFT)) return { key, label: kind === 'label' ? t : '' };
  }
  // A section this reader doesn't know (DECOR, ENTERTAINMENT…): a bold capitals heading over a Qty / Price table.
  if (line.x < LEFT && line.bold && isUpper(t) && t.length <= 40 && line.cells.length === 1 && next && next.items.some((i) => /^qty$/i.test(i.str))) return { key: 'other', label: t };
  return null;
}

function sectionsOf(lines) {
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i], lines[i + 1]);
    if (h) {
      cur = { ...h, heading: lines[i].text, lines: [] };
      out.push(cur);
      if (h.label && h.key !== 'other') cur.lines.push({ ...lines[i], label: true });
      continue;
    }
    if (cur) cur.lines.push(lines[i]);
  }
  return out;
}

// ---------- line items (RENTAL, FOOD, BEVERAGE, AV): qty, description, prices ----------
function entriesOf(lines) {
  const out = [];
  let prev = null;
  for (const l of lines) {
    if (l.label) { out.push({ text: l.text, main: l.text, extra: [], qty: null, label: true, bold: l.bold, italic: l.italic, x: l.x, right: l.right, y: l.y, page: l.page, gap: 99, pageBreak: false }); prev = l; continue; }
    if (l.items.every((i) => HEAD_WORDS.test(i.str))) continue;
    let items = l.items.filter((i) => !MONEYISH.test(i.str));
    if (!items.length) continue;
    let qty = null;
    if (items.length > 1 && /^\d{1,5}$/.test(items[0].str) && items[0].x < LEFT && items[1].x - (items[0].x + items[0].w) >= 6) { qty = Number(items[0].str); items = items.slice(1); }
    // "Roasted Squash (V) **Served with the…**": a bold run after a plain name is a note.
    const k = items.findIndex((i, n) => n > 0 && i.bold && !items[0].bold);
    const cells = k > 0 ? [...finishLine(items.slice(0, k), l.page).cells.slice(0, 1).map((c) => ({ ...c, text: tidy(items.slice(0, k).map((i) => i.str).join(' ')) })), ...finishLine(items.slice(k), l.page).cells] : finishLine(items, l.page).cells;
    out.push({
      text: tidy(cells.map((c) => c.text).join(' ')), main: cells[0].text, extra: cells.slice(1).map((c) => c.text), qty,
      bold: cells[0].bold, italic: cells[0].italic, x: cells[0].x, right: Math.max(...cells.map((c) => c.right)), y: l.y, page: l.page,
      gap: prev && prev.page === l.page ? l.y - prev.y : 99, pageBreak: !!prev && prev.page !== l.page,
    });
    prev = l;
  }
  return out;
}

const PLACEHOLDER = /^(?:x{2,}|x{1,2}:x{2}(?:\s*[-–]\s*x{1,2}:x{2})?|menu heading:?\s*x*)$/i;
const BULLET_ONLY = /^[•◦▪●○\-–*]$/;
const CONT_START = /^[a-z&)\]]/;
const CONT_END = /(?:\b(?:with|and|or|of|the|to|for|in|on|at|a|an|by|from)|[,/&(–-])$/i;
/** An open parenthesis not closed yet: "(4" goes on to "available)". */
const opens = (t) => (String(t).match(/\(/g) || []).length > (String(t).match(/\)/g) || []).length;
/** A wrapped line of the same sentence (food and drink text). */
const continues = (e, prev) => !!prev && !e.qty && (e.pageBreak || e.gap <= 16) && (CONT_START.test(e.text) || CONT_END.test(prev.text) || opens(prev.text));
const join = (a, b, wrapped) => (!a ? b : wrapped ? `${a} ${b}` : `${a} · ${b}`);

/** The next line's first word would have fit at the end of this one: so the line was broken on purpose. */
const fitsAfter = (prev, l, edge) => {
  const first = l.text.split(' ')[0];
  const per = l.text.length ? (l.right - l.x) / l.text.length : 6;
  return prev.right + (first.length + 1) * per < edge - 8;
};
/** Free text, one note per line; a line that ran to the right edge continues on the next. Money lines are dropped. */
function freeText(lines, { skip = [], margin = 0 } = {}) {
  const usable = lines.filter((l) => !(BULLET_ONLY.test(l.text) || PLACEHOLDER.test(l.text) || skip.some((re) => re.test(l.text))));
  // The text's right edge: the section's widest line, or most of the page when every line is short.
  const edge = Math.max(0.9 * margin, ...usable.map((l) => l.right));
  const paras = [];
  let prev = null;
  for (const l of usable) {
    const wrapped = prev && !l.label && !prev.label && prev.page === l.page && l.y - prev.y <= 16 && prev.italic === l.italic && (!fitsAfter(prev, l, edge) || CONT_END.test(prev.text) || opens(prev.text)) && !/^[•◦▪●○\-–*]/.test(l.text);
    if (wrapped) paras[paras.length - 1].text += ` ${l.text}`; else paras.push({ text: l.text, label: !!l.label });
    prev = l;
  }
  const kept = paras.filter((p) => !isFinancial(p.text));
  // A label (Floorplans:, Vendor Contact Details) only when something follows it.
  return kept.filter((p, i) => !p.label || (kept[i + 1] && !kept[i + 1].label)).map((p) => tidy(p.text));
}

// ---------- the summary table ----------
const COLS = [
  ['date', /date/i], ['time', /time/i], ['location', /location|venue/i], ['areas', /area|room|space/i],
  ['type', /type/i], ['guests', /guest|count|attend|pax/i], ['fbMin', /f&b|min/i],
];
const SLASH = /^\d{1,2}\/\d{1,2}\/?/;

function parseSummary(lines) {
  const items = lines.flatMap((l) => l.items.map((i) => ({ ...i, page: l.page })));
  const pos = (i) => i.page * 10000 + i.y;
  const firstRow = items.filter((i) => SLASH.test(i.str)).sort((a, b) => pos(a) - pos(b))[0];
  if (!firstRow) return [];
  // The header is the lines around its "Date" label; a tall cell in the first row can start above that row's date.
  const label = items.filter((i) => /^date$/i.test(i.str) && pos(i) < pos(firstRow)).sort((a, b) => pos(a) - pos(b))[0];
  const headEnd = Math.min(label ? pos(label) + 12 : Infinity, pos(firstRow) - 2);
  const before = (i) => pos(i) < headEnd && (!label || pos(i) >= pos(label) - 12);
  // Header words stacked over each column ("Event / Type", "Event F&B / Min"): runs that overlap sideways are one column.
  const head = items.filter(before).sort((a, b) => a.x - b.x);
  const cols = [];
  for (const i of head) {
    const c = cols.find((k) => i.x <= k.right + 2 && i.x + i.w >= k.x - 2);
    if (c) { c.parts.push(i); c.x = Math.min(c.x, i.x); c.right = Math.max(c.right, i.x + i.w); } else cols.push({ x: i.x, right: i.x + i.w, parts: [i] });
  }
  const used = new Set();
  for (const c of cols) {
    const label = c.parts.sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.str).join(' ');
    // Most specific first: "Event Type" is a type, "Event F&B Min" a minimum.
    const hit = [...COLS].sort((a, b) => (a[0] === 'fbMin' ? -1 : 0) - (b[0] === 'fbMin' ? -1 : 0)).find(([k, re]) => re.test(label) && !used.has(k));
    c.key = hit?.[0] || '';
    if (c.key) used.add(c.key);
    c.center = (c.x + c.right) / 2;
  }
  const known = cols.filter((c) => c.key);
  if (!known.length) return [];
  const data = items.filter((i) => pos(i) >= headEnd);
  const colOf = (i) => known.reduce((best, c) => (Math.abs(i.x + i.w / 2 - c.center) < Math.abs(i.x + i.w / 2 - best.center) ? c : best), known[0]).key;
  const dateCol = known.find((c) => c.key === 'date');
  const inDates = data.filter((i) => !dateCol || colOf(i) === 'date').sort((a, b) => pos(a) - pos(b));
  const starts = inDates.filter((i) => SLASH.test(i.str));
  // Each row runs from halfway after the previous row's date cell to halfway before the next one's.
  const bottoms = starts.map((s, k) => Math.max(...inDates.filter((i) => pos(i) >= pos(s) && (k + 1 >= starts.length || pos(i) < pos(starts[k + 1]))).map(pos)));
  return starts.map((s, k) => {
    const from = k ? (bottoms[k - 1] + pos(s)) / 2 : -Infinity;
    const to = k + 1 < starts.length ? (bottoms[k] + pos(starts[k + 1])) / 2 : Infinity;
    const mine = data.filter((i) => pos(i) >= from && pos(i) < to);
    const cell = (key) => tidy(mine.filter((i) => colOf(i) === key).sort((a, b) => pos(a) - pos(b) || a.x - b.x).map((i) => i.str).join(' '));
    const time = parseTimeRange(cell('time'));
    const guests = cell('guests').match(/\d[\d,]*/);
    return {
      date: parseSlashDate(cell('date')), start: time?.start || '', end: time?.end || '',
      location: cell('location'), areas: cell('areas'), type: cell('type'),
      guestCount: guests ? Number(guests[0].replace(/,/g, '')) : 0, fbMinimum: money(cell('fbMin')),
      bold: mine.filter((i) => i.bold).length * 2 > mine.length,
    };
  });
}

// ---------- the header (account, contact, managers) ----------
const LABELS = [
  ['account', /^account\s*:/i], ['contact', /^contact\s*:/i], ['email', /^e-?mail\s*:/i], ['phone', /^phone\s*:/i],
  ['billTo', /^bill\s*to(?:\s*address)?\s*:/i], ['salesManager', /^sales\s*manager\s*:/i], ['eventManager', /^event\s*manager\s*:/i],
  ['remit', /^remit(?:\s*to)?(?:\s*address)?\s*:/i],
];
function parseFields(lines) {
  const out = [];
  for (const l of lines) {
    let cur = null;
    for (const it of l.items) {
      const hit = LABELS.find(([, re]) => re.test(it.str));
      if (hit) { cur = { key: hit[0], x: it.x, value: it.str.replace(hit[1], '').trim() }; out.push(cur); } else if (cur) cur.value = clean(`${cur.value} ${it.str}`);
    }
  }
  // Left column: the client. Right column: the restaurant's sales manager (its EMAIL is theirs, not the client's).
  const midX = 300;
  const pick = (key, side) => out.find((f) => f.key === key && (!side || (side === 'left' ? f.x < midX : f.x >= midX)))?.value || '';
  return {
    client: pick('account'), contactName: pick('contact'), contactEmail: pick('email', 'left'), contactPhone: pick('phone'),
    salesManager: pick('salesManager'), eventManager: pick('eventManager'),
  };
}

// ---------- food ----------
const TIMING = /^(?:serve\s*time|service\s*time|set\s*by|set\s*time|set|room|location|stationed)\s*:/i;
const MARK = /^(?:gf|df|v|vg|vgn|veg|vegan|vegetarian|pb|plant[- ]based|nf|sf|gluten[- ]free|dairy[- ]free|nut[- ]free|contains\s+[a-z][a-z &]*|halal|kosher|spicy|raw)$/i;
const STYLE_RULES = [
  ['plated', /\bplated\b/i], ['family', /\bfamily[- ]style\b/i], ['buffet', /\bbuffet\b/i],
  ['stations', /\bstations?\b|\bgrazing\b|\bcarving\b/i], ['reception', /\bpassed\b|\breception\b|\bhors d|\bcanap[eé]s?\b|\bcocktail party\b/i],
];
/** The service style (core/beo.js) the food headings and event type point to, most staff-heavy first. */
export function serviceStyleFrom(texts) {
  const all = texts.filter(Boolean).join(' | ');
  return STYLE_RULES.find(([, re]) => re.test(all))?.[0] || '';
}
/** 'Roasted Beets (GF, DF, Contains Nuts)' → { item: 'Roasted Beets', dietary: ['GF', 'DF', 'Contains Nuts'] }. */
export function dietaryMarks(text) {
  const t = clean(text);
  const m = t.match(/\s*\(([^()]+)\)\s*$/);
  if (m) {
    const marks = m[1].split(/[,;/]/).map(clean).filter(Boolean);
    if (marks.length && marks.every((x) => MARK.test(x))) return { item: t.slice(0, m.index).trim(), dietary: marks.map((x) => (x.length <= 3 ? x.toUpperCase() : x)) };
  }
  return { item: t, dietary: [] };
}
function isDish(t) {
  if (/^[“"‘']/.test(t)) return true;
  if (!/^[A-Z0-9]/.test(t)) return false; // lowercase, ½, *, -, • … : a description or a note
  if (dietaryMarks(t).dietary.length) return true;
  if (t.replace(/\([^)]*\)/g, '').includes(',')) return false;
  return !(/^[^:]{1,24}:\s*\S/.test(t) || /:$/.test(t)); // "Includes: …", "DR:"
}
const isCourse = (e) => !e.qty && ((e.bold && isUpper(e.text) && e.text.length <= 40) || /^course\s*\d+\b/i.test(e.text) || /^[A-Za-z ]{0,24}\bcourse$/i.test(e.text));

function parseFood(entries) {
  const menu = [];
  const groups = [];
  let group = '', course = '', cur = null, pending = null, dropping = false, noted = false;
  const add = (line) => { menu.push(line); return line; };
  const note = (text, wrapped = false) => {
    if (!text) return;
    if (!cur) cur = add({ course: course || group, item: '', notes: '' });
    cur.notes = join(cur.notes, text, wrapped && noted); // a wrapped line continues the note above it, not the dish's name
    noted = true;
  };
  const dish = (text, extra = {}) => {
    const { item, dietary } = dietaryMarks(stripMoney(text));
    const line = { course: course || group, item, notes: '', ...extra };
    if (pending) { line.qty ??= pending.qty; line.notes = pending.note; pending = null; }
    if (dietary.length) line.dietary = dietary;
    return add(line);
  };
  const nextOf = (i) => entries.slice(i + 1).find((x) => !PLACEHOLDER.test(x.text));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const t = e.text;
    if (PLACEHOLDER.test(t)) continue;
    const wrapped = continues(e, entries[i - 1]);
    if (dropping && wrapped) continue;
    dropping = false;
    if (moneyLine(t)) { dropping = true; continue; }
    const next = nextOf(i);
    const wasNoted = noted;
    noted = false;
    if (e.qty != null) {
      const name = stripMoney(e.main);
      if (/^\(.*\)$/.test(name)) { pending = { qty: e.qty, note: name.slice(1, -1).trim() }; cur = null; continue; }
      if (isUpper(name) && (serviceStyleFrom([name]) || (next && TIMING.test(next.text)))) {
        group = name; course = ''; groups.push(name);
        cur = add({ course: '', item: name, notes: '', qty: e.qty });
      } else {
        cur = dish(name, { qty: e.qty, course: /\b(vendor|staff|crew)\b/i.test(name) ? '' : course || group });
      }
      for (const x of e.extra) note(x);
      continue;
    }
    if (TIMING.test(t)) { note(t); continue; }
    if (wrapped && cur) { noted = wasNoted; note(t, true); continue; }
    if (!e.italic && next && TIMING.test(next.text) && t.length <= 60 && /^[A-Z]/.test(t)) {
      group = t; course = ''; groups.push(t);
      cur = add({ course: '', item: t, notes: '' });
      continue;
    }
    if (isCourse(e)) { course = t; cur = null; continue; }
    if (e.italic || e.bold || !isDish(t)) { note(t); continue; }
    cur = dish(e.main);
    for (const x of e.extra) note(x);
  }
  return { menu: menu.map(({ qty, dietary, ...m }) => ({ ...m, ...(qty ? { qty } : {}), ...(dietary?.length ? { dietary } : {}) })), groups };
}

// ---------- beverage ----------
const INGREDIENT = /^(?:\.?\d+(?:[./]\d+)?\s*(?:oz|ounces?|ml|cl|dash(?:es)?|drops?|barspoons?|bsp|tsp|tbsp|parts?|pumps?|splash|sprigs?|slices?|wedges?|leaves|leaf)\b|(?:fill|top|topped|garnish(?:ed)?|shake|stir|build|strain|rim(?:med)?|float|muddle|served? (?:up|over|on))\b)/i;
const GLASS = /\b(?:glass|coupe|flute|snifter|mug|tumbler|highball|collins|colins|rocks|globe|tiki|hurricane|nick ?(?:&|and) ?nora|julep cup)$/i;
const PACKAGE = /\b(?:open bar|cash bar|hosted bar|consumption|bar tab|tab|package|drink tickets?|beer (?:and|&) wine|wine service)\b/i;
const DRINK = /\b(?:cocktails?|mocktails?|spritz|martini|margarita|old fashioned|punch|sangria|mule|negroni|sour|potion|toddy|mimosa|bellini|paloma|daiquiri|julep|smash|fizz)\b/i;

function parseBeverage(entries) {
  const bev = { package: '', bar: '', notes: [] };
  const drinks = [];
  let drink = null, dropping = false, lastNote = null;
  const isRecipe = (e) => INGREDIENT.test(e.text) || (GLASS.test(e.text) && e.text.length <= 30);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const t = e.text;
    if (PLACEHOLDER.test(t)) continue;
    const prev = entries[i - 1];
    const wrapped = continues(e, prev);
    if (dropping && wrapped) continue;
    dropping = false;
    if (moneyLine(t) || /^\d+(?:st|nd|rd|th)\s+hour\b/i.test(t)) { dropping = true; continue; } // prices, fees, the hourly bar billing
    if (isRecipe(e)) {
      if (!drink) { // the drink's name is the line just above its recipe
        const name = lastNote && lastNote === bev.notes[bev.notes.length - 1] ? bev.notes.pop() : '';
        drink = { name: name || '', recipe: [], notes: '' };
        drinks.push(drink);
      }
      drink.recipe.push(t);
      lastNote = null;
      continue;
    }
    // A description under a recipe ("butterscotch, Cream Soda, Vanilla Foam").
    if (drink && drink.recipe.length && !drink.notes && !e.qty && e.gap <= 16 && (/,/.test(t) || CONT_START.test(t))) { drink.notes = t; continue; }
    if (drink && drink.notes && wrapped) { drink.notes += ` ${t}`; continue; }
    drink = null;
    const name = stripMoney(e.main);
    const hadMoney = MONEY.test(e.main);
    if (/^bar\s*:/i.test(t)) { bev.bar = t.replace(/^bar\s*:\s*/i, ''); lastNote = null; continue; }
    if (DRINK.test(name) && !PACKAGE.test(name) && (e.qty || e.bold || hadMoney || /#\s*\d/.test(name))) {
      drink = { name, recipe: [], notes: '', ...(e.qty ? { qty: e.qty } : {}) };
      drinks.push(drink);
      lastNote = null;
      continue;
    }
    if (!bev.package && PACKAGE.test(name)) { bev.package = name; lastNote = null; continue; }
    const said = PRICE_TAG.test(t) ? stripMoney(t) : t;
    if (wrapped && lastNote != null && bev.notes.length) { bev.notes[bev.notes.length - 1] += ` ${said}`; lastNote = bev.notes[bev.notes.length - 1]; continue; }
    bev.notes.push(said);
    lastNote = bev.notes[bev.notes.length - 1];
  }
  return {
    beverage: { package: bev.package, bar: bev.bar, notes: bev.notes.join('\n') },
    specialDrinks: drinks.filter((d) => d.name).map((d) => ({ name: d.name, recipe: d.recipe.join('\n'), notes: d.notes, ...(d.qty ? { qty: d.qty } : {}) })),
  };
}

// ---------- rental: arrival notes and the booking's details ----------
const SUBHEAD = /^[A-Z][A-Za-z ]{2,40}\b(?:details|notes|info|information|instructions|timing):?$/;
function parseRental(entries) {
  const arrival = [], notes = [];
  let mode = 'notes', dropping = false, prev = null;
  const edge = Math.max(0, ...entries.map((e) => e.right));
  for (const e of entries) {
    const t = e.text;
    if (PLACEHOLDER.test(t) || BULLET_ONLY.test(t)) continue;
    const wrapped = !!prev && !e.qty && prev.page === e.page && e.gap <= 16 && prev.italic === e.italic && !/^[•◦▪●○\-–*]/.test(t) && (!fitsAfter(prev, e, edge) || CONT_END.test(prev.text) || opens(prev.text));
    if (dropping && wrapped) { prev = e; continue; }
    dropping = false;
    if (/^arrival notes?\b/i.test(t)) {
      mode = 'arrival';
      const rest = t.replace(/^arrival notes?(?:\s+for(?:\s+the)?\s+host(?:\s+team)?)?\s*[:\-–]?\s*/i, '');
      if (rest) arrival.push(rest);
      prev = e;
      continue;
    }
    if (e.qty != null || SUBHEAD.test(t)) mode = 'notes';
    const line = e.qty != null ? stripMoney(t.replace(/\s*[-–]?\s*discounted\b/i, '')) : t;
    if (!line || moneyLine(line)) { dropping = true; prev = e; continue; }
    const list = mode === 'arrival' ? arrival : notes;
    if (wrapped && list.length) list[list.length - 1] += ` ${line}`; else list.push(line);
    prev = e;
  }
  return { arrivalNotes: arrival.join('\n'), rentalNotes: notes };
}

// ---------- the timeline ("Date: | Event Day") ----------
const BOILERPLATE = /\s*[-–]?\s*additional timing needed may result in additional charges\.?/i;
function parseTimeline(lines, actX, eventStart) {
  const split = lines.map((l) => {
    const time = l.items.filter((i) => i.x < actX - 4), act = l.items.filter((i) => i.x >= actX - 4);
    return { page: l.page, y: l.y, time: tidy(time.map((i) => i.str).join(' ')), act: tidy(act.map((i) => i.str).join(' ')) };
  });
  // Cells: lines in one column that sit close together (a cell wraps at 14pt; rows are 18pt or more apart).
  const blocks = (key) => {
    const out = [];
    for (const s of split) {
      if (!s[key]) continue;
      const b = out[out.length - 1];
      if (b && b.page === s.page && s.y - b.bottom <= 16) { b.texts.push(s[key]); b.bottom = s.y; } else out.push({ page: s.page, top: s.y, bottom: s.y, texts: [s[key]] });
    }
    return out.map((b) => ({ ...b, center: b.page * 10000 + (b.top + b.bottom) / 2, half: (b.bottom - b.top) / 2 }));
  };
  const acts = blocks('act'), times = blocks('time');
  const timeOf = new Map();
  for (const tb of times) {
    let best = null;
    for (const a of acts) {
      const d = Math.abs(a.center - tb.center);
      if (d <= Math.max(9, a.half + tb.half) && (!best || d < best.d)) best = { a, d };
    }
    if (best && !timeOf.has(best.a)) timeOf.set(best.a, tb);
  }
  const rows = [];
  let prefix = '', last = eventStart ? hm(Math.max(0, Number(eventStart.slice(0, 2)) - 6), 0, '') : '';
  for (const a of acts) {
    const bullets = a.texts.every((x) => /^[•◦▪●○]/.test(x));
    let item = a.texts.map((x) => x.replace(/^[•◦▪●○]\s*/, '')).join(bullets ? '; ' : ' ').replace(BOILERPLATE, '').trim();
    const tb = timeOf.get(a);
    let time = '', end = '';
    if (tb) {
      const tt = tb.texts.join(' ');
      if (/x/i.test(tt.replace(/[\d:\s\-–apm.]/gi, '')) || /x{1,2}:x{2}/i.test(tt)) { prefix = ''; continue; } // XX:XX: not set yet
      const r = parseTimeRange(tt);
      time = r?.start || parseTime(tt, last);
      end = r?.end || '';
      if (!time) { prefix = ''; continue; } // "60", "180": not a time
    } else {
      const hours = item.match(/\(\s*hours?:\s*([^)]*)\)/i);
      const r = hours && parseTimeRange(hours[1]);
      if (r) { time = r.start; end = r.end; } else if (/:$/.test(item)) { prefix = item; continue; } else continue;
    }
    item = item.replace(/\s*\(\s*hours?:[^)]*\)/i, '').trim();
    if (prefix) item = `${prefix} ${item}`.trim();
    prefix = '';
    if (!item || PLACEHOLDER.test(item) || /^(?:x{2,}[;\s]*)+$/i.test(item)) continue;
    rows.push({ time, ...(end ? { end } : {}), item });
    last = time;
  }
  return rows;
}

// ---------- nothing lost: lines no part of the reader carried ----------
// Words that are the BEO's structure (headings, column names, labels), not what it says.
const STRUCTURE = new Set(('qty quantity price total totals discount rental rentals food beverage beverages banquet event order summary setup set details notes ' +
  'dietary restrictions counts contact information host vendor floorplans floorplan layout special instructions date day type min account email phone ' +
  'menu heading xxx invoice updated support needs guests time areas location sales manager and the for with').split(' '));
const words = (s) => (String(s).toLowerCase().match(/[a-zÀ-ɏ][a-zÀ-ɏ'’]{2,}/g) || []).filter((w) => !STRUCTURE.has(w));
function valueWords(v, out = new Set()) {
  if (typeof v === 'string') for (const w of words(v)) out.add(w);
  else if (Array.isArray(v)) v.forEach((x) => valueWords(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'warnings') valueWords(x, out);
  return out;
}
/** A line whose words aren't (mostly) somewhere in what was read. */
const isLost = (text, seen) => { const w = words(text); return w.length > 0 && w.filter((x) => seen.has(x)).length / w.length < 0.75; };
const BILLING = /^\d+(?:st|nd|rd|th)\s+hour\b/i; // the bar billed by the hour
const ARRIVAL_LABEL = /^arrival notes?(?:\s+for(?:\s+the)?\s+host(?:\s+team)?)?\s*[:\-–]?$/i;
const SKIP_PARTS = new Set(['summary', 'totals', 'end', 'timeline']); // money, signatures, and the run of show (XX:XX rows are blanks)

/** Lines of the BEO's sections that nothing else carried, by heading: [{ key, title, items }]. Money stays out. */
function leftovers(parts, event, sections) {
  const seen = valueWords({ ...event, sections });
  const out = [];
  for (const part of parts) {
    if (SKIP_PARTS.has(part.key)) continue;
    const kept = [];
    let prev = null, money = false;
    for (const l of part.lines) {
      if (l.label || l.items.every((i) => HEAD_WORDS.test(i.str) || MONEYISH.test(i.str))) continue;
      const t = tidy(l.items.filter((i) => !MONEYISH.test(i.str) && !(/^\d{1,5}$/.test(i.str) && i.x < LEFT)).map((i) => i.str).join(' '));
      // A line that goes on from a money line ("…once the minimum" / "is met") is money too.
      const goesOn = prev && prev.page === l.page && l.y - prev.y <= 16 && (CONT_START.test(t) || CONT_END.test(prev.t) || opens(prev.t));
      money = (money && goesOn) || moneyLine(t) || BILLING.test(t);
      prev = { page: l.page, y: l.y, t };
      if (!t || money || PLACEHOLDER.test(t) || BULLET_ONLY.test(t) || ARRIVAL_LABEL.test(t)) continue;
      if (isLost(t, seen)) { kept.push(PRICE_TAG.test(t) ? stripMoney(t) : t); for (const w of words(t)) seen.add(w); }
    }
    if (!kept.length) continue;
    const title = part.label || part.heading || '';
    const key = sectionKeyFor(title);
    out.push({ key: ['list', 'text'].includes(kindFor(key)) && key !== 'notes' ? key : 'other', title, items: kept });
  }
  return out;
}

// ---------- one BEO ----------
const bodySize = (lines) => {
  const hs = lines.flatMap((l) => l.items.map((i) => i.h)).filter(Boolean).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 12;
};
const DATEISH = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,2},?)?(?:\s+\d{4})?|\d{1,2},?(?:\s+\d{4})?|\d{4})(?:\s|$)/i;

function parseEvent(pages) {
  const warnings = [];
  const lines = pages.flatMap((p) => p.lines);
  const first = pages[0].lines;
  const beoAt = first.findIndex((l) => /^banquet event order$/i.test(l.text));
  const labelAt = first.findIndex((l) => LABELS.some(([, re]) => re.test(l.text)));
  const sumAt = lines.findIndex((l) => /^event summary$/i.test(l.text));
  const headEnd = beoAt >= 0 ? beoAt : labelAt >= 0 ? labelAt : Math.max(0, sumAt);

  // Invoice number and the "Updated:" stamp (the one with a time wins).
  const invoice = first.map((l) => l.text.match(/invoice\s*#\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]*)/i)).find(Boolean)?.[1] || '';
  const stamps = pages.flatMap((p) => p.stamps).map(parseStamp).filter(Boolean);
  const beoUpdatedAt = stamps.find((s) => s.includes('T')) || stamps[0] || '';

  // Name (the largest type) and long date (the next size down, on the right); either can wrap.
  const zone = first.slice(0, headEnd).filter((l) => !/invoice\s*#/i.test(l.text)).flatMap((l) => l.items);
  const base = bodySize(lines);
  const big = zone.filter((i) => i.h > base + 1);
  const byPos = (a, b) => a.y - b.y || a.x - b.x;
  let titleItems, dateItems;
  if (big.length) {
    const top = Math.max(...big.map((i) => i.h));
    titleItems = big.filter((i) => i.h >= top - 0.5);
    dateItems = big.filter((i) => i.h < top - 0.5);
  } else {
    dateItems = zone.filter((i) => i.x > 250 && DATEISH.test(i.str));
    titleItems = zone.filter((i) => !dateItems.includes(i));
  }
  let name = tidy(titleItems.sort(byPos).map((i) => i.str).join(' '));
  let date = parseLongDate(dateItems.sort(byPos).map((i) => i.str).join(' ')) || parseLongDate(zone.sort(byPos).map((i) => i.str).join(' '));
  if (!name) name = pages.find((p) => p.footer?.name)?.footer.name || '';

  const fields = parseFields(first.slice(headEnd, sumAt >= 0 && sumAt < first.length ? sumAt : first.length));
  const margin = Math.max(0, ...lines.map((l) => l.right));
  const notes = (ls, o = {}) => freeText(ls, { margin, ...o });

  // Sections, in order; any of them can be missing.
  const parts = sectionsOf(sumAt >= 0 ? lines.slice(sumAt) : lines.slice(headEnd));
  const of = (key) => parts.filter((s) => s.key === key);
  const linesOf = (key) => of(key).flatMap((s) => s.lines);

  // EVENT SUMMARY: the row on the BEO's date is the event; other rows (a tasting…) are kept as other dates.
  const rows = parseSummary(linesOf('summary'));
  const main = rows.find((r) => date && r.date === date) || rows.find((r) => r.bold) || rows[0] || {};
  if (!date) date = main.date || '';
  const otherDates = rows.filter((r) => r !== main).map((r) => ({ date: r.date, start: r.start, end: r.end, areas: r.areas, guestCount: r.guestCount, type: r.type }));

  const food = parseFood(entriesOf(linesOf('food')));
  const drinks = parseBeverage(entriesOf(linesOf('beverage')));
  const rental = parseRental(entriesOf(linesOf('rental')));
  const av = notes(linesOf('av').filter((l) => !l.items.every((i) => HEAD_WORDS.test(i.str))).map((l) => ({ ...l, text: tidy(l.items.filter((i) => !MONEYISH.test(i.str) && !(/^\d{1,5}$/.test(i.str) && i.x < LEFT)).map((i) => i.str).join(' ')) })).filter((l) => l.text));
  const otherBodies = of('other').map((s) => ({
    label: s.label,
    body: notes(s.lines.filter((l) => !l.items.every((i) => HEAD_WORDS.test(i.str))).map((l) => ({ ...l, text: tidy(l.items.filter((i) => !MONEYISH.test(i.str) && !(/^\d{1,5}$/.test(i.str) && i.x < LEFT)).map((i) => i.str).join(' ')) })).filter((l) => l.text)),
  })).filter((o) => o.body.length);
  const others = otherBodies.flatMap((o) => [`${o.label}:`, ...o.body]);
  const timelineSec = of('timeline')[0];
  const timeline = timelineSec ? parseTimeline(timelineSec.lines, timelineSec.act, main.start || '') : [];
  const fbFromTotals = money(linesOf('totals').find((l) => /^f&b minimum/i.test(l.text))?.text);

  const setupBody = notes(linesOf('setup'), { skip: [/^set[- ]?up (?:notes|details):?$/i] });
  const contactBody = notes(linesOf('contacts'));
  const guaranteed = lines.map((l) => l.text.match(/\bguarantee(?:d)?(?:\s+(?:guest\s+)?count|\s+guests?)?\s*[:#-]?\s*(\d{1,5})\b/i)).find(Boolean);

  const event = {
    name, date, start: main.start || '', end: main.end || '', guestCount: main.guestCount || 0, ...(guaranteed ? { guaranteed: Number(guaranteed[1]) } : {}), type: main.type || '',
    areas: main.areas || '', ...(main.location ? { location: main.location } : {}), serviceStyle: serviceStyleFrom([...food.groups, main.type]) || (!food.menu.length && drinks.beverage.package ? 'cocktail' : ''),
    invoiceNumber: invoice, beoUpdatedAt,
    ...fields,
    fbMinimum: main.fbMinimum || fbFromTotals || 0,
    menu: food.menu,
    beverage: drinks.beverage, specialDrinks: drinks.specialDrinks,
    timeline,
    dietaryNotes: notes(linesOf('dietary')).join('\n'),
    arrivalNotes: rental.arrivalNotes,
    contactNotes: contactBody.join('\n'),
    setupNotes: [...rental.rentalNotes, ...setupBody, ...others].join('\n'),
    specialInstructions: notes(linesOf('special')).join('\n'),
    avNotes: av.join('\n'),
    otherDates,
    pages: [pages[0].page, pages[pages.length - 1].page],
  };
  // The same text as sections (core/beo-sections.js): rentals, setup and other headings each on their own, the host
  // and the vendors apart (vendors' names are for staff too; phone numbers and emails aren't).
  const headingOfKey = (key) => of(key)[0]?.heading || '';
  const sections = [];
  const push = (key, title, items, from) => { if (items.length) sections.push({ key, title: tidy(title), kind: kindFor(key), items, ...(from ? { from } : {}) }); };
  push('rentals', headingOfKey('rental'), rental.rentalNotes, ['setupNotes']);
  push('setup', headingOfKey('setup'), setupBody, ['setupNotes']);
  for (const o of otherBodies) {
    const key = sectionKeyFor(o.label);
    push(['list', 'text'].includes(kindFor(key)) && key !== 'other' ? key : 'other', o.label, o.body, ['setupNotes']);
  }
  const host = [], vendors = [];
  let side = host;
  for (const p of contactBody) {
    if (/\bvendor\b.*\bcontact/i.test(p) && p.length <= 60) { side = vendors; continue; }
    if (/^(?:contact information|(?:host|event)\b.*\bcontact details)/i.test(p) && p.length <= 60) { side = host; continue; }
    side.push(p.replace(/^[•◦▪●○*–-]\s*/, ''));
  }
  push('contacts', '', host.filter(Boolean).map((value) => ({ value })), ['contactNotes']);
  push('vendors', '', vendors.filter(Boolean), ['contactNotes']);
  // Anything the BEO says that none of the above carried: kept under its own heading, so nothing is lost.
  for (const left of leftovers(parts, event, sections)) push(left.key, left.title, left.items);
  event.sections = sections;
  const expected = pages.find((p) => p.footer)?.footer.m;
  if (!event.name) warnings.push({ code: 'noName' });
  if (!event.date) warnings.push({ code: 'noDate' });
  if (!event.start) warnings.push({ code: 'noTime' });
  if (!event.guestCount) warnings.push({ code: 'noGuests' });
  if (!rows.length) warnings.push({ code: 'noSummary' });
  if (expected && expected !== pages.length) warnings.push({ code: 'pagesMissing', found: pages.length, expected });
  event.warnings = warnings;
  return event;
}

/**
 * pdf.js text items → one event per BEO, in the PDF's order. Each has the fields events.importBeos takes
 * (name, date, start, end, guestCount, areas, serviceStyle, menu, beverage, specialDrinks, timeline, notes,
 * the client's contact details, invoiceNumber, beoUpdatedAt…) plus `pages` [first, last] and `warnings`
 * [{ code }] for the preview: noName, noDate, noTime, noGuests, noSummary, pagesMissing { found, expected }.
 */
export function parseBeos(items) {
  return splitPages(readPages(items)).map(parseEvent);
}

/**
 * The PDF's text, line by line in reading order with the page breaks marked: what "Read it with AI" sends when a
 * BEO isn't laid out the way this reader knows. Lines that are only money (a price column) are left out here already.
 */
export function beoText(items, max = 60000) {
  const out = [];
  for (const pg of readPages(items)) {
    out.push(`--- page ${pg.page} ---`);
    for (const l of pg.lines) {
      const t = tidy(l.cells.map((c) => c.text).filter((x) => !MONEYISH.test(x)).join('  |  '));
      if (t) out.push(t);
    }
  }
  return out.join('\n').slice(0, max);
}

/** What the preview warns about on a BEO read some other way (the AI): the same codes parseBeos gives. */
export function beoWarnings(e) {
  const w = [];
  if (!e.name) w.push({ code: 'noName' });
  if (!e.date) w.push({ code: 'noDate' });
  if (!e.start) w.push({ code: 'noTime' });
  if (!e.guestCount) w.push({ code: 'noGuests' });
  return w;
}

// ---------- rooms ----------
const roomKey = (n) => norm(n).replace(/^the\s+/, '').replace(/[^a-z0-9&]+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The rooms a BEO's Areas text names, in the order written: venue rooms ({ id, name }) first, then
 * booking names from Settings (Full Buyout). → { roomId, room, how, matches: [names] } where how is
 * 'one', 'several' (the first is used; the preview asks), 'booking', or 'none'.
 */
export function matchRooms(areas, rooms = [], names = []) {
  const text = ` ${roomKey(areas)} `;
  const find = (list) => list.map((r) => {
    const k = roomKey(r.name);
    const m = k && text.match(new RegExp(`\\s${escapeRe(k)}s?\\s`));
    return m ? { ...r, at: m.index } : null;
  }).filter(Boolean).sort((a, b) => a.at - b.at);
  const venue = find(rooms);
  if (venue.length) return { roomId: venue[0].id || null, room: venue[0].name, how: venue.length > 1 ? 'several' : 'one', matches: venue.map((r) => r.name) };
  const named = find(names.filter((n) => !rooms.some((r) => roomKey(r.name) === roomKey(n))).map((n) => ({ id: null, name: n })));
  if (named.length) return { roomId: null, room: named[0].name, how: rooms.length ? 'booking' : named.length > 1 ? 'several' : 'one', matches: named.map((r) => r.name) };
  return { roomId: null, room: '', how: 'none', matches: [] };
}

// ---------- what gets imported ----------
/** Fields the BEO owns: a re-import updates them. Staffing, captain, status, attire, comments and shifts stay as managers left them. */
export const BEO_FIELDS = ['name', 'date', 'start', 'end', 'room', 'roomId', 'areas', 'location', 'guestCount', 'guaranteed', 'type', 'serviceStyle',
  'client', 'contactName', 'contactEmail', 'contactPhone', 'contactNotes', 'salesManager', 'eventManager', 'fbMinimum',
  'menu', 'beverage', 'specialDrinks', 'timeline', 'dietaryNotes', 'arrivalNotes', 'setupNotes', 'specialInstructions', 'avNotes', 'otherDates'];
/** Staff on the event hear about these changing. */
export const KEY_FIELDS = ['date', 'start', 'end', 'room', 'guestCount'];

/** A parsed BEO with the room picked in the preview → the payload for events.importBeos. */
export function beoToEvent(parsed, { roomId = null, room = '', date } = {}) {
  const out = {};
  for (const f of [...BEO_FIELDS, 'invoiceNumber', 'beoUpdatedAt', 'tripleseatId', 'sections']) if (f in parsed) out[f] = parsed[f];
  out.roomId = roomId || null;
  out.room = room || '';
  if (date) out.date = date;
  return out;
}

const text = (v, max) => tidy(v).slice(0, max);
const noCards = (v, max) => { const t = text(v, max); return CARD_DIGITS.test(t) || CARD_LAST4.test(t) ? '' : t; };
const name = (v, max = 200) => noCards(stripMoney(v), max);
const timeOk = (v) => (/^\d{2}:\d{2}$/.test(v || '') && v.slice(0, 2) < '24' && v.slice(3) < '60' ? v : '');
const dateOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const intIn = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * The server's copy of an imported BEO: known fields only, each cleaned and bounded, money lines and
 * card digits dropped (whatever the browser sent). Unknown fields (prices, deposits, estRevenue…) never get through.
 */
export function cleanBeoEvent(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const phone = text(r.contactPhone, 30);
  const digits = phone.replace(/\D/g, '');
  const email = text(r.contactEmail, 120);
  return {
    name: name(r.name, 120),
    date: dateOk(r.date),
    start: timeOk(r.start), end: timeOk(r.end),
    roomId: r.roomId ? text(r.roomId, 60) : null,
    room: name(r.room, 120),
    areas: name(r.areas, 200),
    location: name(r.location, 120),
    guestCount: intIn(r.guestCount, 100000),
    guaranteed: intIn(r.guaranteed, 100000),
    type: name(r.type, 60),
    serviceStyle: SERVICE_STYLES[r.serviceStyle] ? r.serviceStyle : '',
    client: name(r.client, 120),
    contactName: name(r.contactName, 120),
    contactEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    contactPhone: /^[\d\s()+.-]{7,30}$/.test(phone) && digits.length >= 7 && digits.length <= 12 ? phone : '',
    contactNotes: scrubNotes(r.contactNotes, 2000),
    salesManager: name(r.salesManager, 80),
    eventManager: name(r.eventManager, 80),
    fbMinimum: Math.min(Math.max(0, Math.round((Number(r.fbMinimum) || 0) * 100) / 100), 10_000_000),
    menu: list(r.menu, 200).map((m) => ({
      course: name(m?.course, 80), item: name(m?.item, 200), notes: scrubNotes(String(m?.notes ?? '').replace(/ · /g, '\n'), 800).replace(/\n/g, ' · '),
      ...(intIn(m?.qty, 100000) ? { qty: intIn(m.qty, 100000) } : {}),
      ...(list(m?.dietary, 10).length ? { dietary: list(m.dietary, 10).map((d) => text(d, 30)).filter(Boolean) } : {}),
    })).filter((m) => m.item || m.notes),
    beverage: { package: name(r.beverage?.package, 200), bar: name(r.beverage?.bar, 200), notes: scrubNotes(r.beverage?.notes, 2000) },
    specialDrinks: list(r.specialDrinks, 40).map((d) => ({
      name: name(d?.name, 120), recipe: scrubNotes(d?.recipe, 1000), notes: scrubNotes(d?.notes, 300), batch: name(d?.batch, 60),
      ...(intIn(d?.qty, 100000) ? { qty: intIn(d.qty, 100000) } : {}),
    })).filter((d) => d.name),
    timeline: list(r.timeline, 60).map((x) => ({ time: timeOk(x?.time), ...(timeOk(x?.end) ? { end: timeOk(x.end) } : {}), item: isFinancial(x?.item) ? '' : name(x?.item, 300) })).filter((x) => x.time && x.item),
    dietaryNotes: scrubNotes(r.dietaryNotes, 2000),
    arrivalNotes: scrubNotes(r.arrivalNotes, 2000),
    setupNotes: scrubNotes(r.setupNotes, 4000),
    specialInstructions: scrubNotes(r.specialInstructions, 4000),
    avNotes: scrubNotes(r.avNotes, 2000),
    otherDates: list(r.otherDates, 10).map((o) => ({ date: dateOk(o?.date), start: timeOk(o?.start), end: timeOk(o?.end), areas: name(o?.areas, 200), guestCount: intIn(o?.guestCount, 100000), type: name(o?.type, 60) })).filter((o) => o.date),
    invoiceNumber: /^[A-Za-z0-9-]{1,30}$/.test(String(r.invoiceNumber || '')) ? String(r.invoiceNumber) : '',
    beoUpdatedAt: /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(String(r.beoUpdatedAt || '')) ? String(r.beoUpdatedAt) : '',
    tripleseatId: /^[A-Za-z0-9_-]{1,40}$/.test(String(r.tripleseatId || '')) ? String(r.tripleseatId) : '',
    sections: cleanSections(r.sections),
  };
}

/** One line of a section's text: money lines go, a price at the end of a name comes off, card digits never. */
const line = (v, max) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t || moneyLine(t) || /^\d+(?:st|nd|rd|th)\s+hour\b/i.test(t)) return '';
  return noCards(PRICE_TAG.test(t) ? stripMoney(t) : t, max);
};
/** Several lines (a key-value's value, a drink's recipe): each one cleaned. */
const block = (v, max) => String(v ?? '').split('\n').map((l) => line(l, max)).filter(Boolean).join('\n').slice(0, max);
const SECTION_ITEM = {
  timeline: (x) => { const t = line(x?.text ?? x?.item, 300); return timeOk(x?.time) && t ? { time: timeOk(x.time), ...(timeOk(x?.end) ? { end: timeOk(x.end) } : {}), text: t } : null; },
  menu: (m) => {
    const out = { course: name(m?.course, 80), item: line(m?.item, 200), notes: block(String(m?.notes ?? '').replace(/ · /g, '\n'), 800).replace(/\n/g, ' · ') };
    if (intIn(m?.qty, 100000)) out.qty = intIn(m.qty, 100000);
    const diet = list(m?.dietary, 10).map((d) => text(d, 30)).filter(Boolean);
    if (diet.length) out.dietary = diet;
    return out.item || out.notes ? out : null;
  },
  list: (x) => line(typeof x === 'string' ? x : x?.text ?? x?.value, 600) || null,
  text: (x) => line(typeof x === 'string' ? x : x?.text ?? x?.value, 1200) || null,
  keyvalue: (x) => {
    if (typeof x === 'string') { const v = line(x, 600); return v ? { value: v } : null; }
    const label = isFinancial(x?.label) ? null : name(x?.label, 80);
    const value = block(x?.value, 1000);
    if (label === null || !value) return null;
    return { ...(label ? { label } : {}), ...(LABEL_KEYS.includes(x?.labelKey) ? { labelKey: x.labelKey } : {}), value };
  },
};
/**
 * A BEO's sections, cleaned like every other field (core/beo-sections.js has the model): known keys and kinds only,
 * bounded, money lines and card digits out, a section about money (TOTALS, PAYMENT…) left out whole.
 */
export function cleanSections(raw) {
  return list(raw, 40).map((s) => {
    if (!s || typeof s !== 'object') return null;
    const key = SECTION_KEYS.includes(s.key) ? s.key : 'other';
    const kind = SECTION_KINDS.includes(s.kind) ? s.kind : kindFor(key);
    const title = name(s.title, 80);
    if (isFinancial(s.title) || /^(?:totals?|payments?|billing|invoice|pricing)$/i.test(title)) return null;
    const items = list(s.items, 120).map(SECTION_ITEM[kind]).filter(Boolean);
    if (!items.length) return null;
    const from = list(s.from, 2).filter((f) => MIRRORED_FIELDS.includes(f));
    return { key, title, kind, items, ...(from.length ? { from } : {}) };
  }).filter(Boolean);
}

// ---------- re-imports ----------
const isEmpty = (v) => v == null || v === '' || v === 0 || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isEmpty));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (isEmpty(a) && isEmpty(b));

/**
 * What importing a cleaned BEO does to an event (null when it's new). The BEO's value wins when it has
 * one. When the BEO leaves a field blank, a value someone typed in ShiftBoard stays, and a value the
 * last import wrote is cleared. The BEO's sections (beoSections) are replaced. → { doc, changes: [fields, 'sections'],
 * keyChanges: [date/start/end/room/guestCount] }.
 */
// An event synced from Tripleseat keeps Tripleseat's booking: a BEO PDF of it adds the menu, drinks, timeline
// and notes, and the next sync stays the source of the name, date, times, guests and room (core/tripleseat.js).
export const TRIPLESEAT_OWNS = ['name', 'date', 'start', 'end', 'guestCount', 'guaranteed', 'status', 'room', 'roomId'];

export function mergeBeo(existing, b) {
  const prints = existing?.beoPrints || {};
  const doc = {};
  const keep = existing?.source === 'tripleseat' ? new Set(TRIPLESEAT_OWNS) : null;
  for (const f of BEO_FIELDS) {
    if (keep?.has(f)) { if (f in existing) doc[f] = existing[f]; continue; }
    if (f === 'roomId') continue;
    const cur = existing?.[f];
    let next = b[f];
    if (f === 'room') { // the room and its link go together
      if (!b.room && !b.roomId && existing && !isEmpty(cur) && prints.room !== fingerprint(cur)) { doc.room = cur; doc.roomId = existing.roomId ?? null; continue; }
      doc.room = b.room; doc.roomId = b.roomId || null;
      continue;
    }
    if (existing && isEmpty(next) && !isEmpty(cur) && prints[f] !== fingerprint(cur)) next = cur; // typed in ShiftBoard: kept
    doc[f] = next;
  }
  // The BEO's own sections (core/beo-sections.js) are the BEO's: each import replaces them, section by section.
  doc.beoSections = Array.isArray(b.sections) ? b.sections : [];
  doc.beoPrints = Object.fromEntries(BEO_FIELDS.filter((f) => f !== 'roomId').map((f) => [f, fingerprint(doc[f])]));
  const changes = existing ? [...BEO_FIELDS.filter((f) => !same(doc[f], existing[f])), ...(same(doc.beoSections, existing.beoSections) ? [] : ['sections'])] : [];
  const keyChanges = changes.filter((f) => KEY_FIELDS.includes(f) || f === 'roomId').map((f) => (f === 'roomId' ? 'room' : f));
  return { doc, changes, keyChanges: [...new Set(keyChanges)] };
}
