// Reading an ADP timecard export (CSV). Works with whatever ADP product the restaurant is on: RUN
// (Timekeeping / Time & Attendance reports), Workforce Now Time & Attendance, ezLaborManager and
// Workforce Manager all export a timecard or time detail report as CSV, with different column names.
// Pure functions, no I/O: the browser parses the file, the server (or the demo) matches and saves it.
//
//   parseCsv(text)                 → rows (arrays of cells)
//   findHeader(rows)               → index of the header row (reports often start with title lines)
//   detectColumns(header)          → { name, employeeId, date, in: [...], out: [...], hours, … } (column indexes)
//   readPunches(rows, mapping, i)  → { punches, skipped }: one punch per worked shift, overnight handled

const clean = (s) => String(s ?? '').replace(/^﻿/, '').trim();

/** RFC 4180 CSV (quotes, doubled quotes, CRLF), with the delimiter guessed: comma, semicolon or tab. */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLines = src.split(/\r?\n/).slice(0, 10).join('\n');
  const count = (ch) => firstLines.split(ch).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map(clean));
}

// ---------------------------------------------------------------- columns

/** Lowercase words: 'File #' → 'file number', 'Time In(1)' → 'time in 1'. */
export const headerKey = (h) => clean(h).toLowerCase().replace(/#/g, ' number ').replace(/\bno\b\.?/g, 'number')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Column names seen in ADP exports (RUN, Workforce Now, ezLaborManager, Workforce Manager), and generic ones.
export const COLUMN_NAMES = {
  name: ['employee name', 'name', 'employee', 'worker name', 'associate name', 'payroll name', 'full name', 'employee full name', 'person name', 'last name first name', 'employee last name first name', 'associate'],
  firstName: ['first name', 'employee first name', 'given name', 'legal first name', 'preferred first name'],
  lastName: ['last name', 'employee last name', 'family name', 'surname', 'legal last name'],
  employeeId: ['file number', 'file', 'employee id', 'emp id', 'employee number', 'emp number', 'associate id', 'associate number', 'id', 'person number', 'person id', 'badge', 'badge number', 'payroll id', 'position id', 'clock number', 'employee code', 'worker id'],
  date: ['date', 'work date', 'punch date', 'shift date', 'apply date', 'entry date', 'timecard date', 'date worked', 'day', 'in date', 'transaction date', 'business date'],
  in: ['in', 'time in', 'in time', 'in punch', 'punch in', 'clock in', 'clock in time', 'start', 'start time', 'actual in', 'in punch time', 'time in 1', 'in 1', 'in punch 1', 'time in 2', 'in 2', 'in punch 2', 'time in 3', 'in 3'],
  out: ['out', 'time out', 'out time', 'out punch', 'punch out', 'clock out', 'clock out time', 'end', 'end time', 'actual out', 'out punch time', 'time out 1', 'out 1', 'out punch 1', 'time out 2', 'out 2', 'out punch 2', 'time out 3', 'out 3'],
  hours: ['total hours', 'hours', 'total', 'hrs', 'total hrs', 'worked hours', 'hours worked', 'shift total', 'daily total', 'daily totals', 'duration', 'totals'],
  regHours: ['regular', 'regular hours', 'reg', 'reg hours', 'reg hrs', 'regular hrs'],
  otHours: ['overtime', 'overtime hours', 'ot', 'ot hours', 'ot hrs', 'overtime hrs'],
  payCode: ['pay code', 'paycode', 'earnings code', 'earning code', 'earnings', 'hours code', 'pay type', 'earning', 'pay code name'],
  department: ['department', 'dept', 'home department', 'department name', 'department description', 'position', 'job', 'job title', 'job name', 'labor category', 'cost center', 'job code', 'position title', 'work assignment', 'home labor category'],
  rate: ['rate', 'pay rate', 'hourly rate', 'wage', 'rate amount'],
};
export const FIELDS = Object.keys(COLUMN_NAMES);
const MULTI = new Set(['in', 'out']);

/**
 * Guess which column holds what. Exact names first, then a name that starts with a known one
 * ('Time In (Rounded)'). 'in' and 'out' can be several columns (In, Out, In, Out for a meal break).
 * @returns mapping: { field: index | null }, with in/out as arrays of indexes
 */
export function detectColumns(header) {
  const keys = header.map(headerKey);
  const used = new Set();
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, MULTI.has(f) ? [] : null]));
  const hit = (k, n, pass) => (pass === 'exact' ? k === n : n.length > 2 && k.startsWith(`${n} `));
  for (const pass of ['exact', 'prefix']) {
    for (const f of FIELDS) {
      if (MULTI.has(f)) { // every In (or Out) column, left to right
        for (const [i, k] of keys.entries()) {
          if (k && !used.has(i) && COLUMN_NAMES[f].some((n) => hit(k, n, pass))) { used.add(i); mapping[f].push(i); }
        }
        continue;
      }
      if (mapping[f] != null) continue;
      for (const n of COLUMN_NAMES[f]) { // the names in order of preference: 'Date' before 'Day'
        const i = keys.findIndex((k, j) => k && !used.has(j) && hit(k, n, pass));
        if (i >= 0) { used.add(i); mapping[f] = i; break; }
      }
    }
  }
  mapping.in.sort((a, b) => a - b);
  mapping.out.sort((a, b) => a - b);
  return mapping;
}

/** How sure the guess is: a file needs a date, someone, and times or hours. */
export function mappingProblems(mapping) {
  const out = [];
  if (mapping.date == null && !(mapping.in?.length)) out.push('date');
  if (mapping.name == null && mapping.employeeId == null && mapping.lastName == null) out.push('employee');
  if (!(mapping.in?.length) && mapping.hours == null && mapping.regHours == null) out.push('timesOrHours');
  return out;
}

/** The header row: the first of the top 25 rows that names at least three known columns. */
export function findHeader(rows) {
  let best = { i: 0, score: -1 };
  for (const [i, r] of rows.slice(0, 25).entries()) {
    const m = detectColumns(r);
    const score = FIELDS.reduce((t, f) => t + (MULTI.has(f) ? Math.min(m[f].length, 1) : m[f] != null ? 1 : 0), 0);
    if (score >= 3 && score > best.score) best = { i, score };
    if (score >= 5) break;
  }
  return best.score >= 3 ? best.i : 0;
}

/** A mapping by column name (what's remembered for next time) → by index for this file's header. */
export function mappingFromNames(names, header) {
  if (!names) return null;
  const keys = header.map(headerKey);
  const idx = (n) => { const i = keys.indexOf(headerKey(n)); return i >= 0 ? i : null; };
  const out = {};
  for (const f of FIELDS) {
    const v = names[f];
    if (MULTI.has(f)) out[f] = (Array.isArray(v) ? v : v ? [v] : []).map(idx).filter((i) => i != null);
    else out[f] = v ? idx(v) : null;
  }
  // Every remembered column must still be there, or it's a different report: guess afresh.
  const wanted = FIELDS.reduce((t, f) => t + (MULTI.has(f) ? (Array.isArray(names[f]) ? names[f].length : names[f] ? 1 : 0) : names[f] ? 1 : 0), 0);
  const found = FIELDS.reduce((t, f) => t + (MULTI.has(f) ? out[f].length : out[f] != null ? 1 : 0), 0);
  return wanted && found === wanted ? out : null;
}
/** The other way round, to remember: { date: 'Work Date', in: ['In', 'In'], … }. */
export function mappingToNames(mapping, header) {
  const out = {};
  for (const f of FIELDS) {
    if (MULTI.has(f)) out[f] = (mapping[f] || []).map((i) => header[i]).filter(Boolean);
    else out[f] = mapping[f] != null && header[mapping[f]] ? header[mapping[f]] : null;
  }
  return out;
}

// ---------------------------------------------------------------- values

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${p2(m)}-${p2(d)}` : null;
};

/** A date in a cell: 2026-09-18, 9/18/2026, 09-18-26, Fri 09/18/2026, Sep 18, 2026, 18-Sep-2026, an Excel serial. US order (month first). */
export function parseDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (m) return ymd(+m[3], +m[1], +m[2]);
  m = s.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m && MONTHS.includes(m[1].toLowerCase())) return ymd(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  m = s.match(/(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s-](\d{2,4})/i);
  if (m && MONTHS.includes(m[2].toLowerCase())) return ymd(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 30000 && +s < 70000) { // Excel's day count (1900 system)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  }
  return null;
}

/** A time of day in a cell, as minutes after midnight: 4:02 PM, 4:02p, 16:02, 04:02:00 PM, 4 PM, 1602. */
export function parseTime(v) {
  let s = clean(v).toLowerCase();
  if (!s) return null;
  // Drop a date in front of the time ('09/18/2026 4:02 PM', '2026-09-18T16:02:00').
  s = s.replace(/^\D{0,4}\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}[t\s,]*/, '').replace(/^[a-z]{3,9},?\s+/, '').trim();
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(a|p|am|pm|a\.m\.|p\.m\.)?\b/);
  if (!m || (!m[2] && !m[3])) {
    const compact = s.match(/^(\d{3,4})\s*(a|p|am|pm)?$/); // 1602, 402p
    if (!compact) return null;
    m = [compact[0], compact[1].slice(0, -2), compact[1].slice(-2), compact[2]];
  }
  let h = +m[1];
  const min = +(m[2] || 0);
  const ap = m[3]?.[0];
  if (min > 59 || h > 24) return null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (!ap && h === 24) h = 0;
  if (h > 23) return null;
  return h * 60 + min;
}

/** Hours in a cell: 6.5, 6.50, 6:30 (h:mm), 6h 30m, PT6H30M. */
export function parseHours(v) {
  const s = clean(v).replace(/,/g, '');
  if (!s) return null;
  let m = s.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?$/i);
  if (m && (m[1] || m[2])) return round2((+(m[1] || 0)) + (+(m[2] || 0)) / 60);
  m = s.match(/^(-?\d+):(\d{2})$/);
  if (m) return round2(+m[1] + +m[2] / 60);
  m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?\s*(?:(\d+)\s*m(?:in)?)?$/i);
  if (m) return round2(+m[1] + (+(m[2] || 0)) / 60);
  m = s.match(/^-?\d+(?:\.\d+)?$/);
  return m ? round2(+s) : null;
}
const round2 = (n) => Math.round(n * 100) / 100;

/** A money cell: $15.50 → 15.5. */
const parseMoney = (v) => { const s = clean(v).replace(/[$,\s]/g, ''); return /^\d+(\.\d+)?$/.test(s) ? +s : null; };

// Pay codes: regular, overtime, or time that wasn't worked (paid time off, holidays) and isn't counted.
const OT_CODES = /^(ot|ovt|o\/t|overtime|ot\s*1\.5|dt|double\s*time|dbl|doubletime|ot\d?)$/i;
const OFF_CODES = /^(pto|vac|vacation|sick|sck|sic|hol|holiday|brv|bereave|bereavement|jury|jur|personal|per|float|flt|loa|unpaid|upd|paid\s*time\s*off|vto|fmla|meal|unpaid\s*meal|tips?|cc\s*tips|cash\s*tips|bonus|bon)$/i;
export function payCodeKind(code) {
  const c = clean(code);
  if (!c) return 'regular';
  if (OT_CODES.test(c)) return 'overtime';
  if (OFF_CODES.test(c)) return 'off';
  return 'regular';
}

// Rows that are totals or page furniture, not punches.
const TOTAL_ROW = /^(grand\s+)?(sub)?totals?\b|\btotals?:?$|^employee\s+totals?|^page\s+\d+|^report\s+total/i;

// ---------------------------------------------------------------- punches

/** 'Smith, John A' → { first: 'John A', last: 'Smith' }; 'John Smith' → { first: 'John', last: 'Smith' }. */
export function splitName(name) {
  const s = clean(name).replace(/\s+/g, ' ');
  if (!s) return { first: '', last: '', display: '' };
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    return { first, last, display: [first, last].filter(Boolean).join(' ') };
  }
  const parts = s.split(' ');
  return { first: parts.length > 1 ? parts.slice(0, -1).join(' ') : s, last: parts.length > 1 ? parts.at(-1) : '', display: s };
}

/**
 * The punches in a file. One per worked shift: In/Out pairs on one row (a meal break) become one
 * punch with a break; a clock-out at or before the clock-in is the next morning (overnight).
 * Rows with only hours (no times) are kept as hours-only punches, unless the same person and day
 * already has punches (then they're the report's day total; an overtime row moves those hours to overtime).
 * @param {string[][]} rows
 * @param {object} mapping   from detectColumns (indexes)
 * @param {number} headerRow index of the header row in rows
 * @returns {{ punches: object[], skipped: { row: number, reason: string, text: string }[] }}
 */
export function readPunches(rows, mapping, headerRow = 0) {
  const at = (r, i) => (i == null ? '' : clean(r[i]));
  const header = rows[headerRow] || [];
  const headerSig = header.map(headerKey).join('|');
  const punches = [];
  const skipped = [];
  const hoursOnly = [];
  let last = { name: '', employeeId: '', first: '', lastName: '' };
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const text = r.filter(Boolean).join(' · ').slice(0, 120);
    if (!r.some(Boolean)) continue; // blank
    if (r.map(headerKey).join('|') === headerSig) continue; // header repeated on each page
    if (r.some((c) => TOTAL_ROW.test(c)) && !(mapping.in || []).some((ix) => parseTime(r[ix]) != null)) { skipped.push({ row: line, reason: 'total', text }); continue; }

    let name = at(r, mapping.name);
    const first = at(r, mapping.firstName), lastName = at(r, mapping.lastName);
    if (!name && (first || lastName)) name = lastName && first ? `${lastName}, ${first}` : first || lastName;
    let employeeId = at(r, mapping.employeeId);
    const inCells = (mapping.in || []).map((ix) => at(r, ix));
    const outCells = (mapping.out || []).map((ix) => at(r, ix));
    const date = parseDate(at(r, mapping.date)) || parseDate(inCells[0] || '');
    const reg = parseHours(at(r, mapping.regHours));
    const ot = parseHours(at(r, mapping.otHours));
    // The hours ADP paid: the total column, else regular + overtime.
    const hoursCell = parseHours(at(r, mapping.hours)) ?? (reg != null ? round2(reg + (ot || 0)) : null);
    const hasData = date || inCells.some(Boolean) || hoursCell != null;
    if (!name && !employeeId) {
      if (!hasData) { skipped.push({ row: line, reason: 'noData', text }); continue; }
      ({ name, employeeId } = last); // grouped reports print the name once, on the person's first row
    } else if (!hasData) {
      last = { name, employeeId }; // a name-only row starts a group
      continue;
    }
    last = { name, employeeId };
    if (!name && !employeeId) { skipped.push({ row: line, reason: 'noEmployee', text }); continue; }
    if (!date) { skipped.push({ row: line, reason: 'noDate', text }); continue; }

    const payCode = at(r, mapping.payCode);
    const kind = payCodeKind(payCode);
    if (kind === 'off') { skipped.push({ row: line, reason: 'notWorked', text }); continue; }
    const base = {
      row: line, name, employeeId, date, payCode, department: at(r, mapping.department), rate: parseMoney(at(r, mapping.rate)),
    };

    // In/out pairs, in order; each later time that goes backwards has crossed midnight.
    const pairs = [];
    let cursor = null, problem = null;
    const abs = (cell) => {
      const t = parseTime(cell);
      if (t == null) return null;
      const d = parseDate(cell); // a cell with its own date ('09/19/2026 01:30 AM')
      let m = t + (d && d > date ? Math.round((Date.parse(d) - Date.parse(date)) / 60000) : 0);
      if (!d) while (cursor != null && m < cursor) m += 1440;
      return m;
    };
    for (let k = 0; k < Math.max(inCells.length, outCells.length); k++) {
      if (!inCells[k] && !outCells[k]) continue;
      const a = abs(inCells[k]);
      if (a == null) { if (inCells[k] || outCells[k]) problem = 'badTime'; continue; }
      cursor = a;
      let b = abs(outCells[k]);
      if (b != null && b === a && outCells[k]) b = null; // same in and out: no real clock-out
      if (b != null) cursor = b;
      pairs.push([a, b]);
    }
    if (problem && !pairs.length) { skipped.push({ row: line, reason: 'badTime', text }); continue; }

    if (!pairs.length) {
      if (hoursCell == null || hoursCell <= 0) { skipped.push({ row: line, reason: hoursCell === 0 ? 'zeroHours' : 'noTimes', text }); continue; }
      hoursOnly.push({ ...base, kind, hours: hoursCell, ot });
      continue;
    }
    const inMin = pairs[0][0];
    const closed = pairs.filter((p) => p[1] != null);
    const outMin = pairs.at(-1)[1];
    const worked = closed.reduce((t, [a, b]) => t + (b - a), 0) / 60;
    const breakMinutes = pairs.slice(1).reduce((t, p, k) => t + (pairs[k][1] != null ? Math.max(0, p[0] - pairs[k][1]) : 0), 0);
    const hours = hoursCell != null && hoursCell > 0 ? hoursCell : closed.length ? round2(worked) : null;
    let overtimeHours = null;
    if (kind === 'overtime') overtimeHours = hours;
    else if (ot != null) overtimeHours = Math.min(ot, hours ?? ot);
    else if (mapping.otHours != null) overtimeHours = 0;
    punches.push({
      ...base, inMin, outMin: outMin ?? null, overnight: outMin != null && outMin >= 1440, hours, overtimeHours,
      breakMinutes, pairs: pairs.length,
    });
  }

  // Hours-only rows: the day total of punches already read (skip), overtime for them (move it), or a day with no punches (keep).
  const keyOf = (p) => `${p.employeeId || p.name}|${p.date}`;
  const byDay = new Map();
  for (const p of punches) { const k = keyOf(p); byDay.set(k, [...(byDay.get(k) || []), p]); }
  for (const h of hoursOnly) {
    const same = byDay.get(keyOf(h));
    if (!same) {
      const { ot, ...rest } = h;
      punches.push({ ...rest, inMin: null, outMin: null, overnight: false, overtimeHours: h.kind === 'overtime' ? h.hours : ot != null ? Math.min(ot, h.hours) : null, breakMinutes: 0, pairs: 0 });
      continue;
    }
    if (h.kind === 'overtime') {
      const p = same.at(-1);
      p.overtimeHours = round2(Math.min(p.hours ?? h.hours, (p.overtimeHours || 0) + h.hours));
      skipped.push({ row: h.row, reason: 'overtimeMoved', text: `${h.name || h.employeeId} ${h.date} ${h.hours}` });
    } else skipped.push({ row: h.row, reason: 'dayTotal', text: `${h.name || h.employeeId} ${h.date} ${h.hours}` });
  }
  for (const p of punches) delete p.kind;
  punches.sort((a, b) => a.row - b.row);
  return { punches, skipped };
}

/** Everything at once, for a file as text: header found, columns guessed (or the remembered ones). */
export function readAdpCsv(text, { remembered = null } = {}) {
  const rows = parseCsv(text);
  const headerRow = findHeader(rows);
  const header = rows[headerRow] || [];
  const fromMemory = mappingFromNames(remembered, header);
  const mapping = fromMemory || detectColumns(header);
  return { rows, headerRow, header, mapping, remembered: !!fromMemory, problems: mappingProblems(mapping), ...readPunches(rows, mapping, headerRow) };
}
