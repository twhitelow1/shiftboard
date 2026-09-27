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

/**
 * Parse pasted text. Returns { mode, sections: [{label, rows:[{name, cells:[{dow, parsed}]}]}], csvRows, problems }.
 */
export function parseSchedule(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const rows = lines.map(splitRow).map((r) => r.map((c) => c.trim()));
  const problems = [];
  if (!rows.length) return { mode: 'empty', sections: [], csvRows: [], problems };

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
    return { mode: 'csv', sections: [], csvRows, problems };
  }

  const sections = [];
  let banner = '';
  let cur = null;
  let colDow = null;
  for (const r of rows) {
    const nonEmpty = r.filter(Boolean);
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
    if (!cur || !colDow || !r[0]) continue;
    if (/^(#+|\d{1,2}\/\d{1,2}\/\d{2,4})$/.test(r[1] || '') || /^#+$/.test(r[0])) continue; // date row
    if (/^(projected covers|events|notes)/i.test(r[0])) continue;
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
  return { mode: 'grid', sections: sections.filter((s) => s.rows.length), csvRows: [], problems };
}

/** Date for a weekday within the week starting at `weekStart` (which begins on weekStartDow). */
export function dateForDow(weekStart, weekStartDow, d) {
  return addDays(weekStart, (d - weekStartDow + 7) % 7);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function matchEmployee(name, employees) {
  const n = norm(name);
  return employees.find((e) => norm(e.name) === n) || employees.find((e) => norm(e.name).startsWith(n) || n.startsWith(norm(e.name))) || null;
}
export function matchJob(label, jobCodes) {
  const parts = String(label || '').split('·').map((p) => p.trim()).reverse();
  for (const p of parts) {
    const n = norm(p);
    if (!n) continue;
    const j = jobCodes.find((j) => norm(j.name) === n || norm(j.short) === n) ||
      jobCodes.find((j) => norm(j.name).includes(n) || n.includes(norm(j.name)));
    if (j) return j;
  }
  return null;
}
