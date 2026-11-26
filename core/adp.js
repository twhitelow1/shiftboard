// ADP → ShiftBoard. Pure functions (no I/O) that turn ADP workers and punches into ShiftBoard
// documents, used by both ways in: the API sync (server/adp.js + server/adp-sync.js, when the
// restaurant has API access) and the CSV import (core/adp-csv.js reads the file, any ADP product).
//
// Collections written here:
//   timeEntries  ADP punches, source: 'adp', origin: 'api' | 'csv' (same fields Toast's use; tips null)
//   adpWorkers   each ADP person seen, and which ShiftBoard person they are (id: 'aoid:…', 'id:…' or 'name:…')
//   adpJobs      ADP departments / positions, and which job code each one is (id: 'dept:…')
//   integrations 'adp': last sync, last import, the remembered CSV columns
import { matchEmployees, matchJobs, norm, localStamp } from './toast.js';
import { payCodeKind, splitName } from './adp-csv.js';
import { addDays, daysBetween, fromMin, toMin } from './time.js';

export const SOURCE = 'adp';
export const INTEGRATION_ID = 'adp';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normEmail = (e) => String(e || '').trim().toLowerCase();

/** An employee ID / file number for comparing: letters and digits, no leading zeros ('001234' = '1234'). */
export const normId = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID)
    ? store.update('integrations', INTEGRATION_ID, patch)
    : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}

// ---------------------------------------------------------------- people

/** 'Rivera, Ana M' → first 'Ana', last 'Rivera' (a middle initial is dropped for matching). */
function nameParts(name) {
  const { first, last, display } = splitName(name);
  return { first: first.replace(/\s+[a-z]\.?$/i, ''), last, display };
}

/** The adpWorkers id for a person in a CSV file: their employee ID / file number, else their name. */
export function csvWorkerKey({ employeeId, name }) {
  const id = normId(employeeId);
  if (id) return `id:${id}`;
  const n = norm(nameParts(name).display);
  return n ? `name:${n}` : null;
}

/** An ADP worker (GET /hr/v2/workers) as stored in adpWorkers. Keeps an existing match. */
export function apiWorkerDoc(w, cur, at) {
  const legal = w?.person?.legalName || {};
  const preferred = w?.person?.preferredName || {};
  const first = preferred.givenName || legal.givenName || legal.nickName || '';
  const last = legal.familyName1 || legal.familyName || '';
  const assignments = Array.isArray(w?.workAssignments) ? w.workAssignments : [];
  const primary = assignments.find((a) => a?.primaryIndicator) || assignments[0] || {};
  const emails = [...(w?.businessCommunication?.emails || []), ...(w?.person?.communication?.emails || [])].map((e) => normEmail(e?.emailUri)).filter(Boolean);
  const ids = [w?.workerID?.idValue, ...assignments.map((a) => a?.payrollFileNumber), ...assignments.map((a) => a?.positionID)].map(normId).filter(Boolean);
  const dept = (primary.homeOrganizationalUnits || []).find((u) => /dep/i.test(u?.typeCode?.codeValue || ''))?.nameCode;
  const status = String(w?.workerStatus?.statusCode?.codeValue || '').toLowerCase();
  return {
    id: `aoid:${w.associateOID}`, origin: 'api', aoid: w.associateOID,
    name: [first, last].filter(Boolean).join(' ') || legal.formattedName || 'Unnamed', first, last, legalFirst: legal.givenName || '',
    email: emails[0] || '', ids: [...new Set(ids)], employeeId: primary.payrollFileNumber || w?.workerID?.idValue || '',
    department: dept?.shortName || dept?.longName || dept?.codeValue || primary.jobTitle || '',
    deleted: !!status && status !== 'active' && status !== 'leave',
    userId: cur?.userId ?? null, matchedBy: cur?.matchedBy ?? null, seenAt: at,
  };
}

/** A person seen in a CSV file, as an adpWorkers doc. */
export function csvWorkerDoc(p, cur, at) {
  const { first, last, display } = nameParts(p.name);
  const id = normId(p.employeeId);
  return {
    id: csvWorkerKey(p), origin: cur?.origin || 'csv', aoid: cur?.aoid || null,
    name: cur?.origin === 'api' ? cur.name : display || cur?.name || p.employeeId, first: cur?.first || first, last: cur?.last || last, ...(cur?.legalFirst ? { legalFirst: cur.legalFirst } : {}),
    email: cur?.email || '', ids: [...new Set([...(cur?.ids || []), ...(id ? [id] : [])])], employeeId: cur?.employeeId || p.employeeId || '',
    department: cur?.department || p.department || '', deleted: false,
    userId: cur?.userId ?? null, matchedBy: cur?.matchedBy ?? null, seenAt: at,
  };
}

/**
 * Suggest a ShiftBoard person for each unmatched ADP worker: by email, then by employee ID / file
 * number saved on the person (user.adpId), then by name (full name, first name + last initial, first
 * name alone; each only when unambiguous, the legal name before the name they go by). Matches made by
 * hand, and people already taken, are left alone.
 * @returns Map(workerId -> { userId, by: 'email' | 'id' | 'name' })
 */
export function matchWorkers(workers, users) {
  const out = new Map();
  const active = users.filter((u) => u.active !== false);
  // The API and CSV files can each know the same person (a file imported before API access, keyed by
  // name): each only competes with its own kind, so one doesn't block the other.
  for (const origin of ['api', 'csv']) {
    const mine = workers.filter((w) => (w.origin === 'api' ? 'api' : 'csv') === origin);
    const taken = new Set(mine.filter((w) => w.userId).map((w) => w.userId));
    const open = mine.filter((w) => !w.userId && w.matchedBy !== 'manual');
    const claim = (w, u, by) => { out.set(w.id, { userId: u.id, by }); taken.add(u.id); };
    for (const w of open) {
      const email = normEmail(w.email);
      if (!email) continue;
      const hits = active.filter((u) => !taken.has(u.id) && normEmail(u.email) === email);
      if (hits.length === 1) claim(w, hits[0], 'email');
    }
    for (const w of open) {
      if (out.has(w.id) || !w.ids?.length) continue;
      const hits = active.filter((u) => !taken.has(u.id) && u.adpId && w.ids.includes(normId(u.adpId)));
      if (hits.length === 1) claim(w, hits[0], 'id');
    }
    // Names: the Toast matcher's rules, on everyone not matched yet.
    const shaped = mine.map((w) => ({
      // ADP's legal first name (API workers) is matched as the first name, the preferred one as Toast's chosen name.
      id: w.id, firstName: (w.legalFirst || w.first || nameParts(w.name).first).replace(/\s+[a-z]\.?$/i, ''), lastName: w.last || nameParts(w.name).last,
      chosenName: w.legalFirst && w.first && w.first !== w.legalFirst ? w.first : '', email: '',
      userId: w.userId || out.get(w.id)?.userId || null, matchedBy: w.matchedBy,
    }));
    for (const [id, m] of matchEmployees(shaped, active.filter((u) => !taken.has(u.id)))) out.set(id, { userId: m.userId, by: 'name' });
  }
  return out;
}

/** Suggest a job code for each unmatched ADP department or position (same name or short name). */
export function matchDepartments(jobs, jobCodes) {
  return matchJobs(jobs.map((j) => ({ id: j.id, title: j.title, code: '', jobCodeId: j.jobCodeId, matchedBy: j.matchedBy })), jobCodes);
}
export const deptKey = (dept) => (norm(dept) ? `dept:${norm(dept)}` : null);

// ---------------------------------------------------------------- positions

/**
 * The job code for an ADP punch: the ADP department's mapping, else the position the person was
 * scheduled for that day (the shift nearest the clock-in), else their primary position.
 * @returns { jobCodeId, jobFrom: 'dept' | 'schedule' | 'primary' | null }
 */
export function resolveJob({ deptJob, userId, date, inLocal, shifts = [], user }) {
  if (deptJob) return { jobCodeId: deptJob, jobFrom: 'dept' };
  if (userId) {
    const mine = shifts.filter((s) => s.userId === userId && s.date === date && s.jobCodeId);
    if (mine.length) {
      const at = inLocal ? toMin(inLocal.slice(11, 16)) + (inLocal.slice(0, 10) > date ? 1440 : 0) : null;
      const best = at == null ? mine[0] : mine.sort((a, b) => Math.abs(toMin(a.start) - at) - Math.abs(toMin(b.start) - at))[0];
      return { jobCodeId: best.jobCodeId, jobFrom: 'schedule' };
    }
    const jobs = user?.jobCodes || [];
    const primary = jobs.find((j) => j.primary) || (jobs.length === 1 ? jobs[0] : null);
    if (primary) return { jobCodeId: primary.jobCodeId, jobFrom: 'primary' };
  }
  return { jobCodeId: null, jobFrom: null };
}

/** Point stored ADP entries at the person and job code their worker / department maps to now. */
export function resolveAdpEntries(store, { workerIds, deptIds } = {}) {
  const workers = new Map(store.list('adpWorkers').map((w) => [w.id, w]));
  const depts = new Map(store.list('adpJobs').map((j) => [j.id, j]));
  const users = new Map(store.list('users').map((u) => [u.id, u]));
  const all = !workerIds && !deptIds;
  const list = store.list('timeEntries', (t) => t.source === SOURCE && (all || workerIds?.has(t.adpWorkerId) || deptIds?.has(t.adpJobId)));
  const dates = new Set(list.map((t) => t.date));
  const shifts = store.list('shifts', (s) => dates.has(s.date) && s.userId);
  let changed = 0;
  for (const t of list) {
    const userId = workers.get(t.adpWorkerId)?.userId ?? null;
    const job = resolveJob({ deptJob: depts.get(t.adpJobId)?.jobCodeId, userId, date: t.date, inLocal: t.inLocal, shifts, user: users.get(userId) });
    if (t.userId !== userId || t.jobCodeId !== job.jobCodeId || t.jobFrom !== job.jobFrom) {
      store.update('timeEntries', t.id, { userId, ...job });
      changed++;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- entries

const stampOf = (date, min) => (min == null ? null : `${addDays(date, Math.floor(min / 1440))}T${fromMin(min)}`);

/** A timeEntries doc for one ADP punch. `p` is a normalized punch (from a CSV row or the API). */
function entryDoc(p, { id, origin, worker, deptId, job, userId, at, importId = null }) {
  const hours = p.hours != null ? round2(p.hours) : null;
  const ot = p.overtimeHours != null ? round2(Math.min(p.overtimeHours, hours ?? p.overtimeHours)) : null;
  const inLocal = p.inLocal !== undefined ? p.inLocal : stampOf(p.date, p.inMin);
  const outLocal = p.outLocal !== undefined ? p.outLocal : stampOf(p.date, p.outMin);
  return {
    id, source: SOURCE, origin, externalId: p.entryId || id.replace(/^adp_/, ''),
    date: p.date, userId, jobCodeId: job.jobCodeId, jobFrom: job.jobFrom,
    adpWorkerId: worker.id, adpName: worker.name, adpEmployeeId: worker.employeeId || '', adpJobId: deptId, adpDept: p.department || '', payCode: p.payCode || '',
    inAt: p.inAt || null, outAt: p.outAt || null,
    inLocal, outLocal,
    regularHours: hours == null ? 0 : round2(hours - (ot || 0)),
    overtimeHours: ot, // null: the export didn't say (Labor review works overtime out from the weekly limit)
    hourlyWage: p.rate != null ? Number(p.rate) : null,
    declaredCashTips: null, nonCashTips: null, // ADP time data has no tips; Toast stays the source of tips
    breakMinutes: p.breakMinutes || 0, autoClockedOut: false, noClockOut: !!inLocal && !outLocal,
    importId, syncedAt: at,
  };
}
// Same punch, same numbers? (Key order doesn't matter; when it was synced or which import brought it doesn't either.)
const canon = (o) => JSON.stringify(Object.keys(o).filter((k) => k !== 'syncedAt' && k !== 'importId').sort().map((k) => [k, o[k]]));
const sameDoc = (a, b) => canon(a) === canon(b);
const hasOffset = (v) => /[zZ]$|[+-]\d{2}:?\d{2}$/.test(String(v || ''));

/** Is this an hours-only punch, and what to key it on (employee + date + time in). */
const punchKey = (workerKey, p) => `adp_${slug(workerKey)}_${p.date}_${p.inMin != null ? fromMin(p.inMin).replace(':', '') + (p.inMin >= 1440 ? 'n' : '') : `h-${slug(p.payCode || 'reg')}`}`;

/**
 * What importing these punches would do, without writing anything (the preview, and the plan
 * applyCsvImport saves). Re-importing the same file or week finds the same ids: nothing doubles.
 * @param {object} store
 * @param {object[]} punches  from readPunches (core/adp-csv.js)
 * @param {object} [o]
 * @param {object} [o.matches]  { workerKey: userId | '' } picked by hand in the preview
 * @returns {{ rows, counts, workers, depts, entries, removals }}
 */
export function planCsvImport(store, punches, { matches = {}, at = new Date().toISOString() } = {}) {
  const users = store.list('users');
  const userById = new Map(users.map((u) => [u.id, u]));
  // People: the stored ADP workers, plus anyone new in this file (by ID, else name).
  const stored = new Map(store.list('adpWorkers').map((w) => [w.id, w]));
  const byId = new Map();
  for (const w of stored.values()) for (const id of w.ids || []) if (!byId.has(id)) byId.set(id, w.id);
  const workers = new Map();
  const keyFor = (p) => (normId(p.employeeId) && byId.get(normId(p.employeeId))) || csvWorkerKey(p);
  for (const p of punches) {
    const key = keyFor(p);
    if (!key || workers.has(key)) continue;
    workers.set(key, csvWorkerDoc(p, stored.get(key), at));
  }
  for (const [key, userId] of Object.entries(matches || {})) {
    const w = workers.get(key);
    if (!w || (userId && !userById.has(userId))) continue;
    workers.set(key, { ...w, userId: userId || null, matchedBy: 'manual' });
  }
  const pool = [...stored.values()].filter((w) => !workers.has(w.id)).concat([...workers.values()]);
  for (const [id, m] of matchWorkers(pool, users)) if (workers.has(id)) workers.set(id, { ...workers.get(id), userId: m.userId, matchedBy: m.by });

  // Departments / positions.
  const storedDepts = new Map(store.list('adpJobs').map((j) => [j.id, j]));
  const depts = new Map();
  for (const p of punches) {
    const id = deptKey(p.department);
    if (id && !depts.has(id)) depts.set(id, storedDepts.get(id) || { id, title: p.department, jobCodeId: null, matchedBy: null, seenAt: at });
  }
  for (const [id, m] of matchDepartments([...depts.values()], store.list('jobCodes'))) depts.set(id, { ...depts.get(id), jobCodeId: m.jobCodeId, matchedBy: m.by });

  // Entries, against what's stored.
  const dates = [...new Set(punches.map((p) => p.date))];
  const dateSet = new Set(dates);
  const shifts = store.list('shifts', (s) => dateSet.has(s.date) && s.userId);
  const existing = store.list('timeEntries', (t) => t.source === SOURCE && dateSet.has(t.date));
  const apiDays = new Set(existing.filter((t) => t.origin === 'api' && t.userId).map((t) => `${t.userId}|${t.date}`));
  const seen = new Map();
  const rows = [];
  const entries = [];
  const counts = { rows: punches.length, new: 0, updated: 0, same: 0, duplicate: 0, fromApi: 0, unmatched: 0, noPosition: 0, overnight: 0, noClockOut: 0, removed: 0, hours: 0 };
  for (const p of punches) {
    const key = keyFor(p);
    const worker = workers.get(key);
    const deptId = deptKey(p.department);
    const userId = worker?.userId || null;
    const id = punchKey(key, p);
    const inLocal = stampOf(p.date, p.inMin);
    const job = resolveJob({ deptJob: depts.get(deptId)?.jobCodeId, userId, date: p.date, inLocal, shifts, user: userById.get(userId) });
    const row = { row: p.row, workerKey: key, name: worker?.name || p.name, employeeId: p.employeeId, userId, matchedBy: worker?.matchedBy || null,
      date: p.date, inLocal, outLocal: stampOf(p.date, p.outMin), hours: p.hours, overtimeHours: p.overtimeHours, department: p.department, payCode: p.payCode,
      jobCodeId: job.jobCodeId, jobFrom: job.jobFrom, overnight: !!p.overnight, noClockOut: p.inMin != null && p.outMin == null, status: 'new', id };
    if (seen.has(id)) { row.status = 'duplicate'; counts.duplicate++; rows.push(row); continue; }
    if (userId && apiDays.has(`${userId}|${p.date}`)) { row.status = 'fromApi'; counts.fromApi++; rows.push(row); continue; }
    // The same punch stored under another key (an earlier file without IDs, or with the name spelled differently).
    let cur = store.get('timeEntries', id);
    if (!cur && inLocal) {
      cur = existing.find((t) => t.date === p.date && t.inLocal === inLocal && t.origin !== 'api' && !seen.has(t.id)
        && ((userId && t.userId === userId) || t.adpWorkerId === key || (norm(worker?.name) && norm(t.adpName) === norm(worker?.name)))) || null;
    }
    const doc = entryDoc(p, { id: cur?.id || id, origin: 'csv', worker, deptId, job, userId, at });
    row.id = doc.id;
    seen.set(doc.id, true);
    if (!cur) { row.status = 'new'; counts.new++; } else if (sameDoc({ ...cur, importId: null }, doc)) { row.status = 'same'; counts.same++; } else { row.status = 'updated'; counts.updated++; }
    if (!userId) counts.unmatched++;
    if (!job.jobCodeId) counts.noPosition++;
    if (row.overnight) counts.overnight++;
    if (row.noClockOut) counts.noClockOut++;
    counts.hours = round2(counts.hours + (p.hours || 0));
    entries.push({ doc, status: row.status });
    rows.push(row);
  }
  // A corrected file replaces what an earlier one said for the same person and day (a changed
  // clock-in time would otherwise leave the old punch behind and count the shift twice).
  const fileDays = new Set(rows.filter((r) => r.status !== 'duplicate').map((r) => `${r.workerKey}|${r.date}`));
  const removals = existing.filter((t) => t.origin === 'csv' && fileDays.has(`${t.adpWorkerId}|${t.date}`) && !seen.has(t.id)).map((t) => t.id);
  counts.removed = removals.length;
  return { rows, counts, workers: [...workers.values()], depts: [...depts.values()], entries, removals, dates: dates.sort() };
}

/**
 * Save an import. Manual matches with an employee ID are written on the person too (user.adpId),
 * so the next file matches them by ID. Returns the counts.
 */
export function applyCsvImport(store, plan, { importId = null, at = new Date().toISOString(), by = null, fileName = '', columns = null } = {}) {
  for (const w of plan.workers) {
    const cur = store.get('adpWorkers', w.id);
    cur ? store.update('adpWorkers', w.id, w) : store.insert('adpWorkers', w);
    if (w.userId && (w.matchedBy === 'manual' || w.matchedBy === 'name') && w.employeeId) {
      const u = store.get('users', w.userId);
      if (u && !u.adpId) store.update('users', u.id, { adpId: w.employeeId });
    }
  }
  for (const d of plan.depts) store.get('adpJobs', d.id) ? store.update('adpJobs', d.id, d) : store.insert('adpJobs', d);
  for (const { doc, status } of plan.entries) {
    if (status === 'same') continue;
    const full = { ...doc, importId };
    store.get('timeEntries', doc.id) ? store.update('timeEntries', doc.id, full) : store.insert('timeEntries', full);
  }
  for (const id of plan.removals) store.remove('timeEntries', id);
  const lastImport = { id: importId, at, by, fileName: String(fileName || '').slice(0, 120), from: plan.dates[0] || null, to: plan.dates.at(-1) || null, counts: plan.counts };
  const i = integration(store);
  saveIntegration(store, { lastImport, imports: [lastImport, ...(i.imports || [])].slice(0, 10), ...(columns ? { csvColumns: columns } : {}) });
  return plan.counts;
}

// ---------------------------------------------------------------- the API's time cards

/**
 * The start of the pay period a date falls in, from one known period (ADP's current one). Weekly and
 * every-two-weeks periods repeat; semi-monthly (1st–15th, 16th–end) and monthly follow the calendar.
 */
export function payPeriodStart(date, anchor) {
  if (!DAY.test(date || '') || !DAY.test(anchor?.startDate || '') || !DAY.test(anchor?.endDate || '')) return null;
  const len = daysBetween(anchor.startDate, anchor.endDate) + 1;
  const startDay = Number(anchor.startDate.slice(8));
  if (len >= 13 && len <= 16 && (startDay === 1 || startDay === 16)) return `${date.slice(0, 8)}${Number(date.slice(8)) <= 15 ? '01' : '16'}`;
  if (len >= 28 && startDay === 1) return `${date.slice(0, 8)}01`;
  if (!(len >= 1 && len <= 31)) return null;
  return addDays(anchor.startDate, Math.floor(daysBetween(anchor.startDate, date) / len) * len);
}

/** 'PT6H30M' or a number of hours → hours. */
function durationHours(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return durationHours(v.valueNumber ?? v.value ?? v.timeDuration ?? null);
  const m = String(v).match(/^P?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?$/i);
  if (m && (m[1] || m[2])) return (+(m[1] || 0)) + (+(m[2] || 0)) / 60;
  return Number.isFinite(+v) ? +v : null;
}
/** An ADP date-time: with an offset it's converted to the restaurant's zone; without one it's already local. */
function localOf(v, timeZone) {
  if (!v) return null;
  const s = String(v);
  if (hasOffset(s)) return localStamp(s, timeZone);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : null;
}
const codeOf = (c) => (c && typeof c === 'object' ? c.codeValue || c.shortName || '' : c || '');

/**
 * ADP time cards (GET /time/v2/workers/{aoid}/team-time-cards or …/time-cards, $expand=dayEntries)
 * → one punch per time entry: { aoid, date, inLocal, outLocal, inAt, outAt, hours, overtimeHours, payCode,
 * department, entryId }. Read defensively: ADP's payloads differ a little between products and versions.
 * Time off (PTO, holiday…) is left out; an overtime split on an entry becomes its overtime hours.
 */
export function timeCardPunches(payload, { timeZone } = {}) {
  const cards = [];
  const teams = payload?.teamTimeCards || (payload?.timeCards ? [{ timeCards: payload.timeCards, associateOID: payload.associateOID }] : Array.isArray(payload) ? payload : []);
  for (const t of teams) for (const c of t?.timeCards || []) cards.push({ ...c, associateOID: c.associateOID || t.associateOID, personLegalName: c.personLegalName || t.personLegalName });
  const out = [];
  for (const card of cards) {
    const aoid = card.associateOID;
    if (!aoid) continue;
    for (const day of card.dayEntries || []) {
      const date = String(day.entryDate || '').slice(0, 10);
      if (!DAY.test(date)) continue;
      for (const te of day.timeEntries || []) {
        const period = te.timePeriod || {};
        const start = period.startDateTime || period.startPeriod || te.startDateTime || null;
        const end = period.endDateTime || period.endPeriod || te.endDateTime || null;
        // Hours by pay code: from the entry's totals when ADP splits them, else the entry's own.
        const totals = Array.isArray(te.totals) && te.totals.length ? te.totals : [{ payCode: te.payCode || te.entryCode, timeDuration: te.timeDuration ?? te.totalQuantity }];
        let reg = 0, ot = 0, off = 0, code = '';
        for (const x of totals) {
          const h = durationHours(x.timeDuration ?? x.totalQuantity ?? x.hours) || 0;
          const c = codeOf(x.payCode || x.entryCode);
          code ||= c;
          const kind = payCodeKind(c);
          if (kind === 'overtime') ot += h; else if (kind === 'off') off += h; else reg += h;
        }
        if (!start && reg + ot === 0) continue; // time off only
        if (off && reg + ot === 0) continue;
        const inLocal = localOf(start, timeZone);
        let outLocal = localOf(end, timeZone);
        if (outLocal && inLocal && outLocal <= inLocal) outLocal = null;
        let hours = reg + ot;
        if (!hours && inLocal && outLocal) hours = (Date.parse(`${outLocal}:00Z`) - Date.parse(`${inLocal}:00Z`)) / 3600000;
        const alloc = (te.laborAllocations || te.homeLaborAllocations || [])[0];
        out.push({
          aoid, name: card.personLegalName?.formattedName || [card.personLegalName?.givenName, card.personLegalName?.familyName1].filter(Boolean).join(' '),
          date, inLocal, outLocal, inAt: hasOffset(start) ? new Date(start).toISOString() : null,
          outAt: hasOffset(end) ? new Date(end).toISOString() : null,
          hours: round2(hours), overtimeHours: round2(ot), payCode: code,
          department: alloc?.allocationCode?.shortName || alloc?.allocationCode?.codeValue || codeOf(te.departmentCode) || '',
          entryId: te.entryID || te.itemID || null,
        });
      }
    }
  }
  return out;
}

/**
 * Save ADP's worker list (GET /hr/v2/workers) and auto-match anything new. Matches made by hand stay.
 */
export function applyWorkers(store, workers, { at = new Date().toISOString() } = {}) {
  for (const w of workers || []) {
    if (!w?.associateOID) continue;
    const id = `aoid:${w.associateOID}`;
    const cur = store.get('adpWorkers', id);
    const doc = apiWorkerDoc(w, cur, at);
    cur ? store.update('adpWorkers', id, doc) : store.insert('adpWorkers', doc);
  }
  const matches = matchWorkers(store.list('adpWorkers'), store.list('users'));
  for (const [id, m] of matches) store.update('adpWorkers', id, { userId: m.userId, matchedBy: m.by });
  if (matches.size) resolveAdpEntries(store, { workerIds: new Set(matches.keys()) });
  saveIntegration(store, { workersAt: at });
  const all = store.list('adpWorkers', (w) => w.origin === 'api'); // ADP's own list (files can know people too)
  return { workers: all.length, matched: all.filter((w) => w.userId).length, newMatches: matches.size };
}

/**
 * Replace one date's API punches with what ADP returned for it. Idempotent: the id is the worker
 * plus the clock-in time (or ADP's entry id), entries ADP no longer reports are dropped, and CSV
 * punches for people the API now covers that day are dropped too (the API is the same data, kept current).
 */
export function applyAdpDay(store, { date, punches, at = new Date().toISOString() }) {
  if (!DAY.test(date || '')) throw new Error(`Bad date ${date}`);
  const users = new Map(store.list('users').map((u) => [u.id, u]));
  const depts = new Map(store.list('adpJobs').map((j) => [j.id, j]));
  const shifts = store.list('shifts', (s) => s.date === date && s.userId);
  const seen = new Set();
  const out = { date, found: 0, added: 0, updated: 0, removed: 0, unmatched: 0 };
  for (const p of punches || []) {
    if (p.date !== date || !p.aoid) continue;
    const wid = `aoid:${p.aoid}`;
    let worker = store.get('adpWorkers', wid);
    if (!worker) worker = store.insert('adpWorkers', { id: wid, origin: 'api', aoid: p.aoid, name: p.name || p.aoid, first: '', last: '', email: '', ids: [], employeeId: '', department: '', deleted: false, userId: null, matchedBy: null, seenAt: at });
    const deptId = deptKey(p.department);
    if (deptId && !depts.has(deptId)) {
      const d = { id: deptId, title: p.department, jobCodeId: null, matchedBy: null, seenAt: at };
      const m = matchDepartments([d], store.list('jobCodes')).get(deptId);
      depts.set(deptId, store.insert('adpJobs', m ? { ...d, jobCodeId: m.jobCodeId, matchedBy: m.by } : d));
    }
    const id = p.entryId ? `adp_api_${slug(p.entryId)}` : `adp_${slug(wid)}_${date}_${(p.inLocal || 'h').slice(11, 16).replace(':', '')}`;
    const userId = worker.userId || null;
    const job = resolveJob({ deptJob: depts.get(deptId)?.jobCodeId, userId, date, inLocal: p.inLocal, shifts, user: users.get(userId) });
    const doc = entryDoc(p, { id, origin: 'api', worker, deptId, job, userId, at });
    seen.add(id);
    out.found++;
    if (!userId) out.unmatched++;
    const cur = store.get('timeEntries', id);
    if (!cur) { store.insert('timeEntries', doc); out.added++; } else if (!sameDoc(cur, doc)) { store.update('timeEntries', id, doc); out.updated++; }
  }
  const apiPeople = new Set(store.list('timeEntries', (t) => t.source === SOURCE && t.origin === 'api' && t.date === date && seen.has(t.id)).map((t) => t.userId).filter(Boolean));
  for (const t of store.list('timeEntries', (t) => t.source === SOURCE && t.date === date)) {
    const stale = t.origin === 'api' ? !seen.has(t.id) : t.userId && apiPeople.has(t.userId);
    if (stale) { store.remove('timeEntries', t.id); out.removed++; }
  }
  return out;
}
