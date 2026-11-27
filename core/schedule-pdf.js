// The printable schedule: a week as a PDF laid out like the house sheet that gets taped on the wall.
//
//   restaurant name and week dates            (every page; "Page 2 of 3")
//   M.O.D. block: one row per manager with their start time per day, OFF or REQ OFF,
//                 then the day's events and notes, then Projected Covers
//   each room as a colored banner (Settings → Rooms & positions colors), then its positions: a small
//                 label and a weekday header row, one row per person (name, then a start time per day,
//                 tags in red, OFF on yellow, REQ OFF on green for approved time off), and an OPEN row
//   Notes:        the week's notes line
//
// Pure JavaScript (pdf-lib, the 14 standard PDF fonts, nothing embedded), so it runs on Vercel's serverless
// functions, inside the publish email, and in the browser for the demo. Two steps:
//   sheetModel(...)        the week's rows, from what the app already reads (app.bootstrap, shifts.list,
//                          forecast.covers), filtered like the Sheet view (hidden positions never show)
//   renderSchedulePdf(...) the PDF bytes: paper Letter / Legal / Tabloid, portrait or landscape, and
//                          'fit' (one page, never under MIN_FONT; it splits instead) or 'split' (pages
//                          that repeat the weekday header and never part a section's header from its rows)
// A week with any draft shift in it is watermarked DRAFT.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { range, dow, parseDate, dayName } from './time.js';
import { buildSections } from './layout.js';
import { bannerColor, textOn, sameArea } from './areas.js';
import { isManagerJob, isModShift } from './mod.js';
import { atLeast, offSchedule } from './roles.js';

import { PAPER, cleanPdfOptions } from './pdf-options.js';
export { PAPER, cleanPdfOptions };

export const MIN_FONT = 7; // never smaller than this when printed: it splits pages instead
const MAX_FONT = 10;
const SPLIT_FONT = 8.5;
const MARGIN = 24;

/** The words printed on the sheet, in the restaurant's language (restaurant data stays as typed). */
export const PDF_WORDS = {
  en: { mod: 'M.O.D.', off: 'OFF', reqOff: 'REQ OFF', open: 'OPEN', notes: 'Notes:', covers: 'Projected Covers', draft: 'DRAFT',
    week: (a, b) => `${a} – ${b}`, page: (n, m) => `Page ${n} of ${m}`, cont: '(cont.)', people: 'PPL', schedule: 'Schedule' },
  es: { mod: 'GERENTE EN TURNO (M.O.D.)', off: 'LIBRE', reqOff: 'PIDIÓ LIBRE', open: 'DISPONIBLE', notes: 'Notas:', covers: 'Cubiertos proyectados',
    draft: 'BORRADOR', week: (a, b) => `${a} – ${b}`, page: (n, m) => `Página ${n} de ${m}`, cont: '(cont.)', people: 'PERS.', schedule: 'Horario' },
};
const words = (lang) => PDF_WORDS[lang === 'es' ? 'es' : 'en'];

const COLORS = { off: '#ffff00', reqOff: '#93c47d', mod: '#e83e8c', tag: '#d40000', grid: '#3f3f46', events: '#c00000', draft: '#b91c1c' };

// ---------- the week's rows ----------

/** "16:00" → "4PM", "15:30" → "3:30PM"; with an end: "1-9PM", "10AM-6PM" (like the Sheet view). */
export function sheetTime(s, startOnly = false) {
  const part = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return { n: `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`, ap: h >= 12 ? 'PM' : 'AM' };
  };
  const a = part(s.start);
  if (!s.end || startOnly) return `${a.n}${a.ap}`;
  const b = part(s.end);
  return a.ap === b.ap ? `${a.n}-${b.n}${b.ap}` : `${a.n}${a.ap}-${b.n}${b.ap}`;
}
/** "Server" → "Servers", "Doorman" → "Doormen" (the Sheet view's section labels). */
export const pluralLabel = (n) => (/man$/i.test(n) ? n.replace(/man$/i, 'men') : /(s|x|ch|sh)$/i.test(n) ? `${n}es` : /[^aeiou]y$/i.test(n) ? `${n.slice(0, -1)}ies` : `${n}s`);
const usDate = (d) => { const x = parseDate(d); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; };

/**
 * The week as rows for the PDF.
 * @param {object} o
 * @param {object} o.boot     app.bootstrap's answer (settings, jobCodes, employees, layout)
 * @param {object} o.week     shifts.list's answer for the week (shifts, timeOff, events, notes, rosters)
 * @param {object} [o.covers] forecast.covers's answer ({ days: [{ date, totalCovers }] }), or null
 * @param {string} o.weekStart
 * @param {string} [o.lang]   'en' | 'es' (weekday names and OFF / REQ OFF)
 * @param {string[]} [o.rooms] only these rooms (banners); empty = the whole week
 * @param {boolean} [o.publishedOnly] leave out draft shifts (staff, the publish email)
 */
export function sheetModel({ boot, week, covers = null, weekStart, lang = 'en', rooms = [], publishedOnly = false, programming = null }) {
  const W = words(lang);
  const st = boot.settings || {};
  const startOnly = !!st.startTimesOnly;
  const days = range(weekStart, 7);
  const jobs = Object.fromEntries((boot.jobCodes || []).map((j) => [j.id, j]));
  const people = new Map((boot.employees || []).map((e) => [e.id, e]));
  const shifts = (week.shifts || []).filter((s) => s.date >= days[0] && s.date <= days[6] && (!publishedOnly || s.published));
  const approvedOff = (userId, date) => (week.timeOff || []).some((t) => t.userId === userId && t.status === 'approved' && t.startDate <= date && t.endDate >= date);
  const shiftText = (s) => ({ time: sheetTime(s, startOnly), tag: String(s.tag || '').trim() });
  const byStart = (a, b) => String(a.start).localeCompare(String(b.start));

  // The M.O.D. block: managers and up who are on the schedule, people who hold a manager position, and anyone
  // with a manager-on-duty shift this week (core/mod.js, the same rule as the manager-on-duty card).
  const modShifts = shifts.filter((s) => s.userId && isModShift(people.get(s.userId), jobs[s.jobCodeId]));
  const modIds = new Set(modShifts.map((s) => s.userId));
  for (const e of people.values()) {
    if (e.active === false || offSchedule(e)) continue;
    if (atLeast(e, 'manager') || (e.jobCodes || []).some((j) => isManagerJob(jobs[j.jobCodeId]))) modIds.add(e.id);
  }
  const order = (u) => u.order ?? 1e9;
  const modRows = [...modIds].map((id) => people.get(id)).filter(Boolean)
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((u) => ({
      name: (u.sheetName || u.name).toUpperCase(),
      cells: days.map((d) => {
        const list = modShifts.filter((s) => s.userId === u.id && s.date === d).sort(byStart);
        if (list.length) return { kind: 'shift', parts: list.map(shiftText) };
        return approvedOff(u.id, d) ? { kind: 'reqOff', parts: [] } : { kind: 'off', parts: [] };
      }),
    }));

  // The day's events and notes (REGULAR SERVICE, THANKSGIVING DINNER…), and Projected Covers.
  // A manager's own note wins; otherwise the day's regular programming (programming.days.list: core/programming.js).
  const dayNote = (d) => (week.notes || []).find((n) => n.kind === 'day' && n.date === d)?.text || programming?.days?.find((x) => x.date === d)?.autoNote || '';
  const events = days.map((d) => [
    ...(week.events || []).filter((e) => e.date === d && e.status !== 'cancelled')
      .map((e) => [e.name, e.room, e.guestCount ? `${e.guestCount} ${W.people}` : ''].filter(Boolean).join(' ')),
    dayNote(d),
  ].filter(Boolean).join('\n'));
  const coverDays = covers?.days || [];
  const coverCells = days.map((d) => { const c = coverDays.find((x) => x.date === d)?.totalCovers; return c == null ? '' : String(c); });

  // Each room's sections, like the Sheet view: shown positions in order, everyone who holds the position
  // there (OFF on the days they don't work), anyone with a shift there, and open shifts. Manager positions
  // are the M.O.D. block's, so they don't print twice.
  const { sections } = buildSections({ layout: boot.layout, jobs, employees: boot.employees || [], shifts, rosters: week.rosters || [], settings: st });
  const wanted = (banner) => !rooms.length || rooms.some((r) => sameArea(r, banner));
  const shown = sections.filter((x) => wanted(x.banner) && !isManagerJob(x.job) && (x.rows.length || x.open.length));
  const workingOn = (userId, date) => shifts.some((s) => s.userId === userId && s.date === date);
  const groups = [];
  for (const sec of shown) {
    let g = groups[groups.length - 1];
    if (!g || g.banner !== sec.banner) {
      const color = bannerColor(st, sec.banner, sec.roomIndex ?? groups.length);
      g = { banner: sec.banner, title: sec.banner, color, text: textOn(color), sections: [], secs: [] };
      groups.push(g);
    }
    g.secs.push(sec);
    g.sections.push({
      label: sec.sheetLabel || pluralLabel(sec.label),
      rows: [
        ...sec.rows.map(({ user, shifts: list }) => ({
          name: (user.sheetName || user.name).toUpperCase(),
          cells: days.map((d) => {
            const mine = list.filter((s) => s.date === d).sort(byStart);
            if (mine.length) return { kind: 'shift', parts: mine.map(shiftText) };
            if (approvedOff(user.id, d)) return { kind: 'reqOff', parts: [] };
            if (workingOn(user.id, d)) return { kind: 'blank', parts: [] }; // working in another section that day
            return { kind: 'off', parts: [] };
          }),
        })),
        ...(sec.open.length ? [{
          name: W.open,
          open: true,
          cells: days.map((d) => {
            const list = sec.open.filter((s) => s.date === d).sort(byStart);
            return list.length ? { kind: 'shift', parts: list.map(shiftText) } : { kind: 'blank', parts: [] };
          }),
        }] : []),
      ],
    });
  }
  for (const g of groups) {
    // A department banner keeps the name the imported sheet gave it (like the Sheet view).
    if (!g.secs.some((x) => x.area)) g.title = g.secs.find((x) => x.sheetBanner)?.sheetBanner || g.banner;
    delete g.secs;
  }

  const weekNote = (week.notes || []).find((n) => n.kind === 'week' && n.date === weekStart)?.text || '';
  return {
    lang: lang === 'es' ? 'es' : 'en',
    restaurant: st.restaurantName || 'ShiftBoard',
    weekStart,
    days,
    dates: days.map(usDate),
    dayNames: days.map((d) => dayName(dow(d), 'long', lang === 'es' ? 'es' : 'en').toUpperCase()),
    draft: shifts.some((s) => !s.published),
    mod: modRows,
    events,
    covers: coverDays.length ? coverCells : null,
    groups,
    weekNote,
    rooms: rooms.length ? groups.map((g) => g.title) : [],
  };
}

// ---------- drawing ----------

const hex = (h) => {
  const m = String(h || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0, 0, 0);
};

const LETTERS = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ø: 'O', ø: 'o' };
/** Text the standard fonts can print (WinAnsi): accents kept, anything else spelled without them or as '?'. */
function makeSafe(font) {
  const ok = new Set(font.getCharacterSet());
  const cache = new Map();
  return (text) => {
    const s = String(text ?? '').replace(/[\t\r]/g, ' ');
    if (cache.has(s)) return cache.get(s);
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (ch === '\n' || ok.has(cp)) { out += ch; continue; }
      const bare = (LETTERS[ch] || ch).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += [...bare].every((c) => ok.has(c.codePointAt(0))) && bare ? bare : '?';
    }
    cache.set(s, out);
    return out;
  };
}

/** Split text into lines that fit `width` at `size` (long words are cut). */
function wrap(font, text, size, width) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * The PDF for a sheetModel.
 * @param {object} model   sheetModel(...)
 * @param {object} [opts]  { paper: 'letter'|'legal'|'tabloid', orientation: 'portrait'|'landscape', fit: 'fit'|'split' }
 * @returns {Promise<Uint8Array>}
 */
export async function renderSchedulePdf(model, opts = {}) {
  return (await schedulePdf(model, opts)).bytes;
}

/**
 * The PDF and how it was laid out: { bytes, fontSize, pages: [[{ type, label?, name?, cont? }]] } (what each
 * page holds, top to bottom; for tests and the download's file name).
 */
export async function schedulePdf(model, opts = {}) {
  const o = cleanPdfOptions(opts);
  const W = words(model.lang);
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = makeSafe(regular);
  const [pw, ph] = o.orientation === 'landscape' ? [...PAPER[o.paper]].reverse() : PAPER[o.paper];
  const tableW = pw - MARGIN * 2;
  const headerH = 30; // restaurant name, week, page number
  const bodyTop = ph - MARGIN - headerH;
  const bodyH = bodyTop - MARGIN;

  // Every row, at a font size. Heights scale with the size; the name column fits the longest name.
  const plan = (f) => {
    const pad = Math.max(2, f * 0.35);
    const allNames = [...model.mod.map((r) => r.name), ...model.groups.flatMap((g) => g.sections.flatMap((s) => [s.label, ...s.rows.map((r) => r.name)])), W.covers, W.notes];
    const longest = Math.max(...allNames.map((n) => bold.widthOfTextAtSize(safe(n), f)));
    const nameW = Math.min(tableW * 0.22, Math.max(tableW * 0.12, longest + pad * 2));
    const dayW = (tableW - nameW) / 7;
    const rowH = f * 1.65;
    const eventsSize = f * 0.85;
    const eventLines = model.events.map((t) => wrap(bold, safe(t).toUpperCase(), eventsSize, dayW - pad * 2).slice(0, 8));
    const eventsH = Math.max(rowH * 2, Math.max(0, ...eventLines.map((l) => l.length)) * eventsSize * 1.2 + pad * 2);
    const noteLines = wrap(regular, safe(model.weekNote), f, tableW - nameW - pad * 2).slice(0, 12);
    const notesH = Math.max(rowH, noteLines.length * f * 1.25 + pad * 2);
    const dates = { type: 'dates', h: f * 3.1 };
    const blocks = [];
    // The top: M.O.D. banner, the dates and weekdays, each manager, the day's events, Projected Covers.
    blocks.push({ rows: [{ type: 'banner', h: f * 2, text: W.mod, fill: COLORS.mod, color: textOn(COLORS.mod) }, dates,
      ...model.mod.map((r) => ({ type: 'person', h: rowH, row: r })),
      { type: 'events', h: eventsH, lines: eventLines },
      ...(model.covers ? [{ type: 'covers', h: rowH }] : [])], head: 1 });
    for (const g of model.groups) {
      g.sections.forEach((s, i) => {
        const headRow = { type: 'head', h: rowH, label: s.label, fill: g.color, color: g.text };
        const rows = s.rows.map((r) => ({ type: 'person', h: rowH, row: r }));
        // A room's banner stays with its first section; a section's header never leaves its rows.
        const banner = { type: 'banner', h: f * 2, text: g.title, fill: g.color, color: g.text };
        blocks.push(i === 0 ? { rows: [banner, headRow, ...rows], head: 2, headRow, banner }
          : { rows: [headRow, ...rows], head: 1, headRow, banner });
      });
    }
    blocks.push({ rows: [{ type: 'notes', h: notesH, lines: noteLines }], head: 1 });
    return { f, pad, nameW, dayW, rowH, dates, blocks, eventsSize };
  };

  // Lay rows onto pages. Every page after the first starts with the weekday header (dates). A block that fits
  // on a fresh page is never split; a longer one is split between people, repeating its section header.
  const paginate = (p) => {
    const pages = [[]];
    let used = 0;
    const room = () => bodyH - used;
    // A new page starts with the weekday header, and the room's banner again when it carries on there.
    let current = null;
    const newPage = (ownBanner = false) => {
      pages.push([p.dates]);
      used = p.dates.h;
      if (current?.banner && !ownBanner) { pages[pages.length - 1].push({ ...current.banner, cont: true }); used += current.banner.h; }
    };
    const sum = (rows) => rows.reduce((t, r) => t + r.h, 0);
    for (const b of p.blocks) {
      const h = sum(b.rows);
      if (h <= room()) { pages[pages.length - 1].push(...b.rows); used += h; current = b; continue; }
      current = b.rows[0] === b.banner ? null : b; // a room's first section brings its own banner
      if (h <= bodyH - p.dates.h - (current?.banner?.h || 0)) { newPage(); pages[pages.length - 1].push(...b.rows); used += h; current = b; continue; }
      current = b;
      // Too tall for any page: its header and at least two people (or what's left) together, then continue.
      let rest = b.rows.slice();
      let first = true;
      while (rest.length) {
        const head = first ? rest.slice(0, b.head) : (b.headRow ? [{ ...b.headRow, cont: true }] : []);
        const body = first ? rest.slice(b.head) : rest;
        const minTake = Math.min(body.length, 2);
        if (sum(head) + sum(body.slice(0, minTake)) > room()) newPage(first && b.rows[0] === b.banner);
        let take = 0;
        let hh = sum(head);
        while (take < body.length && hh + body[take].h <= room()) { hh += body[take].h; take++; }
        take = Math.max(take, Math.min(1, body.length));
        pages[pages.length - 1].push(...head, ...body.slice(0, take));
        used += sum(head) + sum(body.slice(0, take));
        rest = body.slice(take);
        first = false;
        if (rest.length) newPage();
      }
    }
    return pages;
  };

  let p;
  let pages;
  if (o.fit === 'fit') {
    for (let f = MAX_FONT; f >= MIN_FONT; f -= 0.25) {
      const tryPlan = plan(f);
      const tryPages = paginate(tryPlan);
      if (tryPages.length === 1) { p = tryPlan; pages = tryPages; break; }
    }
  }
  if (!p) { p = plan(o.fit === 'fit' ? Math.max(MIN_FONT, SPLIT_FONT - 0.5) : SPLIT_FONT); pages = paginate(p); }

  const { f, pad, nameW, dayW, eventsSize } = p;
  const black = rgb(0, 0, 0);
  const grid = hex(COLORS.grid);
  const red = hex(COLORS.tag);
  const weekLine = W.week(model.dates[0], model.dates[6]);

  const fitSize = (font, text, size, width) => {
    let s = size;
    while (s > MIN_FONT && font.widthOfTextAtSize(text, s) > width) s -= 0.25;
    return s;
  };
  const clip = (font, text, size, width) => {
    if (font.widthOfTextAtSize(text, size) <= width) return text;
    let t = text;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
    return `${t}…`;
  };

  pages.forEach((rows, pi) => {
    const page = doc.addPage([pw, ph]);
    const text = (str, x, y, size, font = regular, color = black, extra = {}) => page.drawText(str, { x, y, size, font, color, ...extra });
    const centered = (str, x, w, y, size, font = regular, color = black) => {
      const s = fitSize(font, str, size, w - pad * 2);
      const t = clip(font, str, s, w - pad * 2);
      text(t, x + (w - font.widthOfTextAtSize(t, s)) / 2, y, s, font, color);
    };
    const box = (x, y, w, h, fill) => page.drawRectangle({ x, y, width: w, height: h, ...(fill ? { color: hex(fill) } : {}), borderColor: grid, borderWidth: 0.5 });
    const baseline = (y, h, size) => y + (h - size * 0.72) / 2;

    // Header: restaurant, week, DRAFT, page.
    const top = ph - MARGIN;
    text(safe(model.restaurant), MARGIN, top - 14, 13, bold);
    const rightText = `${weekLine}${pages.length > 1 ? `   ·   ${W.page(pi + 1, pages.length)}` : ''}`;
    text(rightText, pw - MARGIN - regular.widthOfTextAtSize(rightText, 10), top - 13, 10, regular);
    if (model.draft) {
      const dw = bold.widthOfTextAtSize(W.draft, 10);
      const dx = MARGIN + bold.widthOfTextAtSize(safe(model.restaurant), 13) + 12;
      page.drawRectangle({ x: dx - 4, y: top - 17, width: dw + 8, height: 15, borderColor: hex(COLORS.draft), borderWidth: 1 });
      text(W.draft, dx, top - 13, 10, bold, hex(COLORS.draft));
    }
    if (model.rooms?.length) text(safe(model.rooms.join(' · ')), MARGIN, top - 26, 8, regular, rgb(0.3, 0.3, 0.3));

    let y = bodyTop;
    for (const r of rows) {
      y -= r.h;
      const by = baseline(y, r.h, f);
      if (r.type === 'banner') {
        box(MARGIN, y, tableW, r.h, r.fill);
        centered(`${safe(r.text).toUpperCase()}${r.cont ? ` ${W.cont}` : ''}`, MARGIN, tableW, baseline(y, r.h, f * 1.2), f * 1.2, bold, hex(r.color));
      } else if (r.type === 'dates') {
        box(MARGIN, y, nameW, r.h);
        model.days.forEach((d, i) => {
          const x = MARGIN + nameW + i * dayW;
          box(x, y, dayW, r.h);
          centered(model.dates[i], x, dayW, y + r.h * 0.55, f * 0.9, bold);
          centered(safe(model.dayNames[i]), x, dayW, y + r.h * 0.18, f * 0.9, regular);
        });
      } else if (r.type === 'head') {
        box(MARGIN, y, nameW, r.h, r.fill);
        const label = safe(r.label) + (r.cont ? ` ${W.cont}` : '');
        text(clip(bold, label, f, nameW - pad * 2), MARGIN + pad, by, f, bold, hex(r.color));
        model.days.forEach((d, i) => {
          const x = MARGIN + nameW + i * dayW;
          box(x, y, dayW, r.h);
          centered(safe(model.dayNames[i]), x, dayW, by, f * 0.9, bold);
        });
      } else if (r.type === 'person') {
        box(MARGIN, y, nameW, r.h);
        const name = safe(r.row.name);
        centered(name, MARGIN, nameW, by, f, bold, r.row.open ? hex(COLORS.tag) : black);
        r.row.cells.forEach((c, i) => {
          const x = MARGIN + nameW + i * dayW;
          if (c.kind === 'off') { box(x, y, dayW, r.h, COLORS.off); centered(W.off, x, dayW, by, f * 0.9); return; }
          if (c.kind === 'reqOff') { box(x, y, dayW, r.h, COLORS.reqOff); centered(W.reqOff, x, dayW, by, f * 0.9); return; }
          box(x, y, dayW, r.h);
          if (c.kind !== 'shift') return;
          // "3:30PM TRAIN": the time in black, its tag in red, several shifts joined by " / ".
          const segs = [];
          c.parts.forEach((part, j) => {
            if (j) segs.push({ t: ' / ', font: regular, color: black });
            segs.push({ t: safe(part.time), font: bold, color: black });
            if (part.tag) segs.push({ t: ` ${safe(part.tag).toUpperCase()}`, font: bold, color: red });
          });
          const avail = dayW - pad * 2;
          let s = f;
          const width = (size) => segs.reduce((t, g) => t + g.font.widthOfTextAtSize(g.t, size), 0);
          while (s > MIN_FONT && width(s) > avail) s -= 0.25;
          if (width(s) > avail) { // still too long: one string, cut with an ellipsis
            const all = segs.map((g) => g.t).join('');
            centered(all, x, dayW, by, s, bold, black);
            return;
          }
          let cx = x + (dayW - width(s)) / 2;
          for (const g of segs) { text(g.t, cx, baseline(y, r.h, s), s, g.font, g.color); cx += g.font.widthOfTextAtSize(g.t, s); }
        });
      } else if (r.type === 'events') {
        box(MARGIN, y, nameW, r.h);
        model.days.forEach((d, i) => {
          const x = MARGIN + nameW + i * dayW;
          box(x, y, dayW, r.h);
          const lines = r.lines[i];
          const lh = eventsSize * 1.2;
          let ly = y + r.h / 2 + (lines.length * lh) / 2 - eventsSize;
          for (const line of lines) { centered(line, x, dayW, ly, eventsSize, bold, hex(COLORS.events)); ly -= lh; }
        });
      } else if (r.type === 'covers') {
        box(MARGIN, y, nameW, r.h);
        text(clip(bold, safe(W.covers), f, nameW - pad * 2), MARGIN + pad, by, f, bold);
        model.days.forEach((d, i) => {
          const x = MARGIN + nameW + i * dayW;
          box(x, y, dayW, r.h);
          if (model.covers[i]) centered(model.covers[i], x, dayW, by, f, bold);
        });
      } else if (r.type === 'notes') {
        box(MARGIN, y, nameW, r.h);
        text(safe(W.notes), MARGIN + pad, y + r.h - pad - f * 0.85, f, bold);
        box(MARGIN + nameW, y, tableW - nameW, r.h);
        let ly = y + r.h - pad - f * 0.85;
        for (const line of r.lines) { text(line, MARGIN + nameW + pad, ly, f); ly -= f * 1.25; }
      }
    }

    if (model.draft) {
      const size = Math.min(pw, ph) / 4.2;
      const w = bold.widthOfTextAtSize(W.draft, size);
      const a = (35 * Math.PI) / 180;
      page.drawText(W.draft, {
        x: pw / 2 - (w / 2) * Math.cos(a) + (size * 0.35) * Math.sin(a), y: ph / 2 - (w / 2) * Math.sin(a) - (size * 0.35) * Math.cos(a),
        size, font: bold, color: hex(COLORS.draft), opacity: 0.13, rotate: degrees(35),
      });
    }
  });

  doc.setTitle(`${model.restaurant} · ${W.schedule} ${weekLine}`);
  doc.setCreator('ShiftBoard');
  doc.setProducer('ShiftBoard');
  doc.setLanguage(model.lang === 'es' ? 'es' : 'en-US');
  const summary = pages.map((rows) => rows.map((r) => ({ type: r.type, ...(r.label ? { label: r.label } : {}), ...(r.text ? { label: r.text } : {}),
    ...(r.row ? { name: r.row.name } : {}), ...(r.cont ? { cont: true } : {}) })));
  return { bytes: await doc.save(), fontSize: f, pages: summary };
}

/** A file name: "schedule-2026-11-23.pdf" (with the rooms when only some print). */
export function pdfFileName(model) {
  const rooms = model.rooms?.length ? `-${model.rooms.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}` : '';
  return `schedule-${model.weekStart}${rooms}${model.draft ? '-draft' : ''}.pdf`;
}

/**
 * Read the week through the app's own methods (the same permissions: staff get published shifts and approved time
 * off only) and build the model. call(method, args) is service.call bound to the person asking.
 */
export async function loadSheetModel(call, { weekStart, lang, rooms = [], publishedOnly = false, isMgr = false }) {
  const end = range(weekStart, 7)[6];
  const [boot, week, covers, programming] = await Promise.all([
    call('app.bootstrap', {}),
    call('shifts.list', { start: weekStart, end }),
    Promise.resolve().then(() => call('forecast.covers', { weekStart })).catch(() => null),
    Promise.resolve().then(() => call('programming.days.list', { start: weekStart, end, lang })).catch(() => null),
  ]);
  return sheetModel({ boot, week, covers, weekStart, lang, rooms, publishedOnly: publishedOnly || !isMgr, programming });
}
