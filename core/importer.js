// Parses schedules pasted from a spreadsheet (the classic "names down, days across"
// restaurant grid) or a simple CSV (date,employee,job,start,end,tag).
import { addDays, pad } from './time.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayIndex = (s) => {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return -1;
  return DAYS.findIndex((d) => d === t || d.slice(0, 3) === t.slice(0, 3) && t.length >= 3 && d.startsWith(t));
};

function to24(h, m, suffix, fallbackSuffix) {
  let hh = Number(h);
  const mm = Number(m || 0);
  let suf = (suffix || fallbackSuffix || '').toUpperCase().replace(/M$/, '');
  if (!suf) suf = hh === 12 || hh < 10 ? 'P' : 'A'; // restaurant heuristic: 1–9 → pm, 10–11 → am, 12 → noon
  if (suf === 'P' && hh < 12) hh += 12;
  if (suf === 'A' && hh === 12) hh = 0;
  return `${pad(hh % 24)}:${pad(mm)}`;
}

/** Parse one schedule cell like "4PM", "3:30PM BC", "12-4PM", "3:00PM-9PM", "REQUEST OFF". */
export function parseCell(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^(off|closed|x|-|—|n\/a)$/i.test(s)) return null;
  if (/^(request(ed)? off|req\.? off|ro|pto|vacation)\b/i.test(s)) return { timeOff: true, note: s };
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s*(?:(?:-|–|to)\s*(\d{1,2}|cl(?:ose)?)(?::(\d{2}))?\s*(am|pm|a|p)?)?\s*(.*)$/i);
  if (!m) return { unparsed: s };
  const [, sh, sm, ssuf, eh, em, esuf, rest] = m;
  if (Number(sh) > 23 || (sm && Number(sm) > 59)) return { unparsed: s };
  let startSuffix = ssuf;
  if (!ssuf && esuf && eh && !/^cl/i.test(eh)) {
    // "12-4PM" → 12 is noon; "10-2PM" → 10am; "5-10PM" → 5pm
    const a = Number(sh), b = Number(eh);
    startSuffix = a === 12 ? 'P' : a > b ? 'A' : esuf;
  }
  const start = to24(sh, sm, startSuffix);
  let end = null;
  if (eh && !/^cl/i.test(eh)) end = to24(eh, em, esuf, Number(eh) < 12 && Number(eh) > 0 ? 'P' : '');
  return { start, end, tag: (rest || '').trim() };
}

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t');
  // CSV with quotes
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const DATE_CELL = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
const isoDate = (c) => {
  const m = String(c || '').trim().match(DATE_CELL);
  return m ? `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])}` : null;
};

/**
 * Parse pasted text (or a grid rebuilt from a PDF by core/pdfgrid.js).
 * Returns { mode, sections: [{label, rows:[{name, cells:[{dow, parsed}]}]}], csvRows, problems,
 *           weekOf, notes: [{dow, text}], covers: [{dow, covers}] }.
 * weekOf is the earliest date printed on the schedule; notes are unlabeled day cells (events,
 * "CLOSED"…); covers come from a "Projected Covers" row.
 */
export function parseSchedule(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const rows = lines.map(splitRow).map((r) => r.map((c) => c.trim()));
  const problems = [];
  if (!rows.length) return { mode: 'empty', sections: [], csvRows: [], problems, weekOf: null, notes: [], covers: [] };

  const head = rows[0].map((c) => c.toLowerCase());
  if (head.includes('date') && (head.includes('employee') || head.includes('name'))) {
    const idx = (k) => head.findIndex((h) => h === k || h.startsWith(k));
    const iDate = idx('date'), iEmp = head.includes('employee') ? idx('employee') : idx('name'), iJob = idx('job'), iStart = idx('start'), iEnd = idx('end'), iTag = idx('tag');
    const csvRows = rows.slice(1).map((r, n) => {
      let date = r[iDate];
      const us = date?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (us) date = `${us[3].length === 2 ? '20' + us[3] : us[3]}-${pad(us[1])}-${pad(us[2])}`;
      const st = parseCell(iEnd >= 0 && r[iEnd] ? `${r[iStart]}-${r[iEnd]}` : r[iStart]);
      if (!st || st.unparsed || st.timeOff) problems.push(`Line ${n + 2}: couldn't read time "${r[iStart]}"`);
      return { date, name: r[iEmp], job: iJob >= 0 ? r[iJob] : '', start: st?.start, end: st?.end || null, tag: (iTag >= 0 ? r[iTag] : '') || st?.tag || '' };
    }).filter((r) => r.date && r.name && r.start);
    return { mode: 'csv', sections: [], csvRows, problems, weekOf: null, notes: [], covers: [] };
  }

  const sections = [];
  const dates = [];
  const notes = [];
  const covers = [];
  let banner = '';
  let cur = null;
  let colDow = null;
  for (const r of rows) {
    const nonEmpty = r.filter(Boolean);
    const rowDates = r.slice(1).map(isoDate).filter(Boolean);
    if (rowDates.length >= 3) { dates.push(...rowDates); continue; } // the dates printed over the days
    const dayCols = r.map(dayIndex);
    const dayCount = dayCols.slice(1).filter((d) => d >= 0).length;
    if (dayCount >= 4) {
      colDow = [...dayCols];
      colDow[0] = -1; // first column holds names
      // Repair a mistyped day header (e.g. "OFF" where MONDAY should be) from its neighbours.
      for (let i = colDow.length - 2; i >= 1; i--) if (colDow[i] < 0 && colDow[i + 1] >= 0) colDow[i] = (colDow[i + 1] + 6) % 7;
      for (let i = 2; i < Math.min(colDow.length, 8); i++) if (colDow[i] < 0 && colDow[i - 1] >= 0 && r[i] !== undefined) colDow[i] = (colDow[i - 1] + 1) % 7;
      const label = r[0] && dayIndex(r[0]) < 0 ? r[0] : '';
      cur = { label: [banner, label].filter(Boolean).join(' · ') || `Section ${sections.length + 1}`, baseLabel: label, rows: [] };
      sections.push(cur);
      continue;
    }
    if (nonEmpty.length === 1 && r[0]) {
      if (/^notes?:?$|^events?:?$/i.test(r[0])) { cur = null; continue; }
      banner = r[0];
      continue;
    }
    if (colDow && /^projected covers/i.test(r[0] || '')) {
      r.forEach((c, i) => { if (i > 0 && colDow[i] >= 0 && /^\d+$/.test(c)) covers.push({ dow: colDow[i], covers: Number(c) }); });
      continue;
    }
    if (colDow && !r[0] && nonEmpty.length) { // unlabeled day cells: event notes, "CLOSED", "MEETING"…
      r.forEach((c, i) => { if (i > 0 && c && colDow[i] >= 0) notes.push({ dow: colDow[i], text: c }); });
      continue;
    }
    if (!cur || !colDow || !r[0]) continue;
    if (/^(#+|\d{1,2}\/\d{1,2}\/\d{2,4})$/.test(r[1] || '') || /^#+$/.test(r[0])) continue; // date row
    if (/^(events|notes)/i.test(r[0])) continue;
    const cells = [];
    for (let i = 1; i < r.length; i++) {
      const d = colDow[i];
      if (d == null || d < 0) continue;
      const parsed = parseCell(r[i]);
      if (parsed?.unparsed) problems.push(`${r[0]} (${DAYS[d]}): couldn't read "${parsed.unparsed}"`);
      if (parsed && !parsed.unparsed) cells.push({ dow: d, parsed });
    }
    cur.rows.push({ name: r[0], cells });
  }
  const weekOf = dates.length ? [...dates].sort()[0] : null;
  return { mode: 'grid', sections: sections.filter((s) => s.rows.length), csvRows: [], problems, weekOf, notes, covers };
}

/** Date for a weekday within the week starting at `weekStart` (which begins on weekStartDow). */
export function dateForDow(weekStart, weekStartDow, d) {
  return addDays(weekStart, (d - weekStartDow + 7) % 7);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const singular = (w) => String(w || '').replace(/men$/i, 'man').replace(/(ss)es$/i, '$1').replace(/([^s])s$/i, '$1');
const SYNONYMS = { mod: ['manager'], managerondut: ['manager'], runner: ['foodrunner'], bar: ['bartender'], cocktail: ['cocktailserver'], door: ['doorman'] };

/** Match a name from a schedule ("ALEX D", "MARYANN") to an employee. */
export function matchEmployee(name, employees) {
  const n = norm(name);
  if (!n) return null;
  return employees.find((e) => norm(e.name) === n)
    || (n.length >= 3 && employees.find((e) => norm(e.name).startsWith(n) || n.startsWith(norm(e.name))))
    || (n.length >= 4 && employees.find((e) => norm(e.name).endsWith(n)))
    || null;
}

/**
 * Match a section label ("RESTAURANT · Servers", "MOON RABBIT · Bar", "M.O.D.") to a job code.
 * Tries the most specific reading first: banner + role ("Moon Rabbit Bar" → "MR Bartender"),
 * then the role alone, then the banner.
 */
export function matchJob(label, jobCodes) {
  const parts = String(label || '').split('·').map((p) => p.trim()).filter(Boolean);
  const role = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  const banner = parts.length > 1 ? parts[0] : '';
  const r = norm(role), rs = norm(singular(role));
  const b = norm(banner);
  const ini = banner.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase();
  const roleCands = [...new Set([r, rs, ...(SYNONYMS[rs] || SYNONYMS[r] || [])].filter(Boolean))];
  const exact = (c) => jobCodes.find((j) => norm(j.name) === c || norm(j.short) === c);
  const starts = (c) => c.length >= 3 && jobCodes.find((j) => norm(j.name).startsWith(c));
  const contains = (c) => jobCodes.find((j) => norm(j.name).length >= 4 && c.includes(norm(j.name)));
  const within = (c) => c.length >= 4 && jobCodes.find((j) => norm(j.name).includes(c));
  const specific = [b && b + r, b && b + rs, ini.length > 1 && ini + r, ini.length > 1 && ini + rs].filter(Boolean);
  for (const c of specific) { const j = exact(c) || starts(c); if (j) return j; }
  for (const c of roleCands) { const j = jobCodes.find((x) => norm(x.name) === c); if (j) return j; }
  for (const c of specific.slice(0, 2)) { const j = contains(c); if (j) return j; }
  for (const c of roleCands) { const j = exact(c) || starts(c) || contains(c) || within(c); if (j) return j; }
  if (b) { const j = exact(b) || starts(b) || within(b); if (j) return j; }
  return null;
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
/** "THROUGH THE LENS ARTIST" → "Through the Lens Artist", "CHANG/SMITH" → "Chang/Smith". */
export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ').map((w, i) =>
    (i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/(^|[/\-'(])([a-z])/g, (m, p, c) => p + c.toUpperCase()))).join(' ');
}
/** "ALEX D" → "Alex D", "CJ" → "CJ", "MARYANN" → "Maryann". */
export function personName(s) {
  return String(s || '').trim().split(/\s+/).map((w) => (w.length <= 2 ? w.toUpperCase() : titleCase(w))).join(' ');
}

const ROLE_NAMES = { server: 'Server', runner: 'Food Runner', busser: 'Busser', bar: 'Bartender', bartender: 'Bartender', barback: 'Barback',
  cocktail: 'Cocktail Server', host: 'Host', doorman: 'Doorman', door: 'Doorman', cook: 'Cook', dishwasher: 'Dishwasher', expo: 'Expo' };
/**
 * Name and department for a new job code made from a section label. A role that shows up under
 * several banners keeps the banner ("Moon Rabbit Bartender"); a banner that already names the
 * role is used as-is ("Back Host Stand").
 */
export function suggestJob(label, allLabels = []) {
  const parts = String(label || '').split('·').map((p) => p.trim()).filter(Boolean);
  const role = parts.length > 1 ? parts[parts.length - 1] : '';
  const banner = parts.length > 1 ? parts[0] : parts[0] || '';
  if (/^m\.?\s*o\.?\s*d\.?$|manager on duty/i.test(role || banner)) return { name: 'Manager', department: 'Leadership' };
  const department = titleCase(banner) || 'Restaurant';
  if (!role) return { name: titleCase(banner) || 'Staff', department };
  const key = singular(role).toLowerCase().replace(/[^a-z]/g, '');
  const base = ROLE_NAMES[key] || titleCase(singular(role));
  if (banner && norm(banner).includes(key)) return { name: titleCase(banner), department };
  const shared = allLabels.filter((l) => {
    const p = String(l).split('·').map((x) => x.trim());
    return p.length > 1 && singular(p[p.length - 1]).toLowerCase().replace(/[^a-z]/g, '') === key;
  }).length > 1;
  return { name: shared && banner ? `${titleCase(banner)} ${base}` : base, department };
}

const GUESTS = /(\d{1,4})\s*(?:ppl|people|guests|pax|persons?)\b/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Split day notes into events ("CONCIERGE NIGHT FULL BUYOUT 150 PPL" → name, room, guests)
 * and plain notes ("CLOSED", "MEETING"). A note is an event when it has a guest count.
 */
export function notesToEvents(notes, rooms = []) {
  const events = [], dayNotes = [];
  const byLength = [...rooms].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of notes || []) {
    const m = n.text.match(GUESTS);
    if (!m) { dayNotes.push(n); continue; }
    let rest = n.text.replace(m[0], ' ');
    let room = '';
    for (const r of byLength) {
      const re = new RegExp(`\\b${escapeRe(r)}\\b`, 'i');
      if (re.test(rest)) { room = r; rest = rest.replace(re, ' '); break; }
    }
    const t = n.text;
    const type = /wedding/i.test(t) ? 'Wedding' : /rehearsal/i.test(t) ? 'Rehearsal dinner' : /bachelor|birthday|party|shower/i.test(t) ? 'Party'
      : /fundraiser|gala|benefit/i.test(t) ? 'Fundraiser' : /happy hour/i.test(t) ? 'Happy hour' : /buyout/i.test(t) ? 'Buyout' : '';
    const name = titleCase(rest.replace(/\s+/g, ' ').replace(/^[\s,:;–-]+|[\s,:;–-]+$/g, ''));
    events.push({ dow: n.dow, name: name || 'Event', guestCount: Number(m[1]), room, type, source: n.text });
  }
  return { events, dayNotes };
}
