// Toast POS → ShiftBoard. Pure functions (no I/O) that turn Toast API objects into
// ShiftBoard documents. The HTTP client is server/toast.js; server/toast-sync.js runs these
// inside a database write, one business day at a time.
//
// Collections written here:
//   sales           one doc per business date (the forecast's history), source: 'toast'
//   timeEntries     one doc per Toast time entry, id `toast_<guid>`
//   toastEmployees  Toast's employees and which ShiftBoard person each one is
//   toastJobs       Toast's jobs and which ShiftBoard job code each one is
//   integrations    'toast': restaurant name, time zone, last sync

import { nameTiers } from './names.js';

export const SOURCE = 'toast';
export const INTEGRATION_ID = 'toast';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** '2026-09-21' -> '20260921' (Toast's businessDate format). */
export const toToastDate = (date) => String(date).replaceAll('-', '');
/** 20260921 or '20260921' -> '2026-09-21'. */
export function fromToastDate(v) {
  const s = String(v ?? '');
  if (DAY.test(s)) return s;
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** An ISO instant as the restaurant's wall-clock time: 'YYYY-MM-DDTHH:MM' (null if missing). */
export function localStamp(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timeZone || undefined }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d); // unknown zone: the process's own
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------- sales

// Selections that move money but aren't sales (gift cards sold or reloaded, house account payments).
const NOT_SALES = new Set(['TOAST_CARD_SELL', 'TOAST_CARD_RELOAD', 'HOUSE_ACCOUNT_PAY_BALANCE']);
const notSales = (s) => NOT_SALES.has(s?.selectionType) || /^gift ?card/i.test(String(s?.displayName || ''));

/**
 * One business day's orders → { sales, covers, orders, skipped }.
 *  - Orders and checks that are voided or deleted are left out entirely (sales and guests).
 *  - Net sales per check is check.amount: after discounts, with non-gratuity service charges,
 *    without tax, tips or gratuity (Toast's recommended starting point). Gift card sales and
 *    house account payments are taken back out.
 *  - Covers are the orders' numberOfGuests.
 * Refunds are not subtracted (Toast reports them on the day of the refund).
 */
export function summarizeOrders(orders) {
  let sales = 0, covers = 0, count = 0, skipped = 0;
  for (const o of orders || []) {
    if (!o || o.voided || o.deleted) { skipped++; continue; }
    let net = 0, live = 0;
    for (const c of o.checks || []) {
      if (!c || c.voided || c.deleted) continue;
      live++;
      net += Number(c.amount) || 0;
      for (const s of c.selections || []) if (!s?.voided && notSales(s)) net -= Number(s.price) || 0;
    }
    if (!live) { skipped++; continue; } // every check voided or deleted
    sales += net;
    covers += Math.max(0, Number(o.numberOfGuests) || 0);
    count++;
  }
  return { sales: round2(sales), covers, orders: count, skipped };
}

/**
 * True when a sales day was typed in by hand (Forecast → Sales history) rather than synced:
 * there is no Toast snapshot and it has numbers, or someone edited it after the last sync.
 * Forecast overrides are a different collection (forecastOverrides) and never touched here.
 */
export function isManualSales(doc) {
  if (!doc) return false;
  if (doc.toast) return round2(doc.sales) !== round2(doc.toast.sales) || (Number(doc.covers) || 0) !== (Number(doc.toast.covers) || 0);
  return (Number(doc.sales) || 0) > 0 || (Number(doc.covers) || 0) > 0;
}

/**
 * Save Toast's numbers for one date into `sales` (same shape the forecast reads).
 * Days typed in by hand are kept unless replaceManual. Returns 'added' | 'updated' | 'same' | 'kept'.
 */
export function upsertSales(store, date, summary, { replaceManual = false, at = new Date().toISOString() } = {}) {
  const cur = store.get('sales', date);
  const toast = { sales: round2(summary.sales), covers: Number(summary.covers) || 0, orders: summary.orders || 0, syncedAt: at };
  if (cur && isManualSales(cur) && !replaceManual) {
    store.update('sales', date, { toast }); // remember what Toast says; the hand-typed numbers stay
    return 'kept';
  }
  const doc = { id: date, date, sales: toast.sales, covers: toast.covers, notes: cur?.notes || '', source: SOURCE, toast };
  if (cur && isManualSales(cur)) doc.replaced = { sales: cur.sales, covers: cur.covers, at };
  if (!cur) { store.insert('sales', doc); return 'added'; }
  const same = cur.source === SOURCE && round2(cur.sales) === doc.sales && (Number(cur.covers) || 0) === doc.covers;
  if (same && cur.toast?.orders === toast.orders) return 'same'; // nothing changed: no write
  store.update('sales', date, doc);
  return same ? 'same' : 'updated';
}

// ---------------------------------------------------------------- people and jobs

/** Lowercase letters and digits only, single spaces (accents dropped). */
export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const normEmail = (e) => String(e || '').trim().toLowerCase();

export function toastEmployeeName(e) {
  const first = (e?.chosenName || e?.firstName || '').trim();
  return [first, (e?.lastName || '').trim()].filter(Boolean).join(' ') || 'Unnamed';
}

/** A Toast employee as stored in `toastEmployees` (keeps an existing mapping). */
function employeeDoc(e, cur, at) {
  return {
    id: e.guid,
    firstName: e.firstName || '', lastName: e.lastName || '', chosenName: e.chosenName || '',
    name: toastEmployeeName(e), email: normEmail(e.email), deleted: !!e.deleted,
    externalEmployeeId: e.externalEmployeeId || '',
    userId: cur?.userId ?? null, matchedBy: cur?.matchedBy ?? null, seenAt: at,
  };
}

function jobDoc(j, cur, at) {
  return {
    id: j.guid, title: j.title || j.code || 'Job', code: j.code || '', deleted: !!j.deleted,
    defaultWage: num(j.defaultWage), tipped: !!j.tipped,
    jobCodeId: cur?.jobCodeId ?? null, matchedBy: cur?.matchedBy ?? null, seenAt: at,
  };
}

/**
 * Suggest a ShiftBoard person for each unmatched Toast employee: by email, then by name.
 * Name rules, each used only when the match is unambiguous on both sides:
 *   full name ("Mary Ann Lopez"), first name + last initial ("Alex D"), then first name alone ("Moe").
 * Each rule tries the person's legal name first (payroll has it), then the name they go by (core/names.js).
 * People already matched (including by hand) are never suggested twice.
 * @returns Map(toastEmployeeId -> { userId, by: 'email' | 'name' })
 */
export function matchEmployees(toastEmployees, users) {
  const out = new Map();
  const taken = new Set(toastEmployees.filter((e) => e.userId).map((e) => e.userId));
  const open = toastEmployees.filter((e) => !e.userId && e.matchedBy !== 'manual');
  const free = () => users.filter((u) => !taken.has(u.id));
  const claim = (e, u, by) => { out.set(e.id, { userId: u.id, by }); taken.add(u.id); };

  // 1. Email
  for (const e of open) {
    const email = normEmail(e.email);
    if (!email) continue;
    const hits = free().filter((u) => normEmail(u.email) === email);
    if (hits.length === 1) claim(e, hits[0], 'email');
  }
  // 2–4. Names
  const firstOf = (e) => [norm(e.firstName), norm(e.chosenName)].filter(Boolean);
  const tiers = [(u) => nameTiers(u, { payroll: true })[0], (u) => nameTiers(u, { payroll: true })[1]];
  const rules = [
    (e) => firstOf(e).map((f) => norm(`${f} ${e.lastName}`)),
    (e) => (norm(e.lastName) ? firstOf(e).map((f) => `${f} ${norm(e.lastName)[0]}`) : []),
    (e) => firstOf(e),
  ];
  for (const [i, keys] of rules.entries()) {
    for (const keysOf of tiers) {
      for (const e of open) {
        if (out.has(e.id)) continue;
        const mine = new Set(keys(e));
        if (!mine.size) continue;
        const hits = free().filter((u) => keysOf(u).some((k) => mine.has(k)));
        if (hits.length !== 1) continue;
        // First-name-only: no other Toast employee may answer to the same name.
        if (i === 2 && toastEmployees.some((o) => o.id !== e.id && firstOf(o).some((f) => mine.has(f)))) continue;
        claim(e, hits[0], 'name');
      }
    }
  }
  return out;
}

/** Suggest a ShiftBoard job code for each unmatched Toast job (same name, short name or code). */
export function matchJobs(toastJobs, jobCodes) {
  const out = new Map();
  const single = (s) => norm(s).replace(/s$/, '');
  for (const j of toastJobs) {
    if (j.jobCodeId || j.matchedBy === 'manual') continue;
    const names = new Set([single(j.title), single(j.code)].filter(Boolean));
    const hits = jobCodes.filter((c) => !c.archived && [single(c.name), single(c.short)].some((n) => n && names.has(n)));
    if (hits.length === 1) out.set(j.id, { jobCodeId: hits[0].id, by: 'name' });
  }
  return out;
}

/** Point every stored time entry at the person and job code its Toast employee / job maps to now. */
export function resolveEntries(store, { employeeIds, jobIds } = {}) {
  const emp = new Map(store.list('toastEmployees').map((e) => [e.id, e]));
  const job = new Map(store.list('toastJobs').map((j) => [j.id, j]));
  const all = !employeeIds && !jobIds;
  const touched = (t) => all || employeeIds?.has(t.toastEmployeeId) || jobIds?.has(t.toastJobId);
  let changed = 0;
  for (const t of store.list('timeEntries', (t) => t.source === SOURCE && touched(t))) {
    const userId = emp.get(t.toastEmployeeId)?.userId ?? null;
    const jobCodeId = job.get(t.toastJobId)?.jobCodeId ?? null;
    if (t.userId !== userId || t.jobCodeId !== jobCodeId) {
      store.update('timeEntries', t.id, { userId, jobCodeId });
      changed++;
    }
  }
  return changed;
}

/**
 * Save Toast's employee and job lists (and restaurant info), then auto-match anything new.
 * Existing matches, including ones made by hand, are kept.
 */
export function applyLists(store, { employees = [], jobs = [], restaurant = null, at = new Date().toISOString() }) {
  for (const e of employees) {
    if (!e?.guid) continue;
    const cur = store.get('toastEmployees', e.guid);
    cur ? store.update('toastEmployees', e.guid, employeeDoc(e, cur, at)) : store.insert('toastEmployees', employeeDoc(e, null, at));
  }
  for (const j of jobs) {
    if (!j?.guid) continue;
    const cur = store.get('toastJobs', j.guid);
    cur ? store.update('toastJobs', j.guid, jobDoc(j, cur, at)) : store.insert('toastJobs', jobDoc(j, null, at));
  }
  const empMatches = matchEmployees(store.list('toastEmployees'), store.list('users'));
  for (const [id, m] of empMatches) store.update('toastEmployees', id, { userId: m.userId, matchedBy: m.by });
  const jobMatches = matchJobs(store.list('toastJobs'), store.list('jobCodes'));
  for (const [id, m] of jobMatches) store.update('toastJobs', id, { jobCodeId: m.jobCodeId, matchedBy: m.by });
  if (empMatches.size || jobMatches.size) resolveEntries(store, { employeeIds: new Set(empMatches.keys()), jobIds: new Set(jobMatches.keys()) });

  const patch = { listsAt: at };
  if (restaurant) {
    const g = restaurant.general || restaurant;
    Object.assign(patch, {
      restaurantName: g.name || '', locationName: g.locationName || '', timeZone: g.timeZone || '',
      closeoutHour: num(g.closeoutHour),
    });
  }
  saveIntegration(store, patch);
  const allE = store.list('toastEmployees'), allJ = store.list('toastJobs');
  return {
    employees: allE.length, employeesMatched: allE.filter((e) => e.userId).length, newMatches: empMatches.size,
    jobs: allJ.length, jobsMatched: allJ.filter((j) => j.jobCodeId).length, newJobMatches: jobMatches.size,
  };
}

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID)
    ? store.update('integrations', INTEGRATION_ID, patch)
    : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}

// ---------------------------------------------------------------- time entries

const unpaidBreakMinutes = (breaks) => Math.round((breaks || []).reduce((t, b) => {
  if (!b || b.paid || b.missed || !b.inDate || !b.outDate) return t;
  const m = (new Date(b.outDate) - new Date(b.inDate)) / 60000;
  return t + (Number.isFinite(m) && m > 0 ? m : 0);
}, 0));

/** A Toast TimeEntry as a `timeEntries` doc. The tip-pool feature reads these field names. */
export function timeEntryDoc(te, { date, employee, job, timeZone, at }) {
  return {
    id: `toast_${te.guid}`,
    source: SOURCE,
    externalId: te.guid,
    date: fromToastDate(te.businessDate) || date,
    userId: employee?.userId ?? null,
    toastEmployeeId: te.employeeReference?.guid || null,
    toastEmployeeName: employee?.name || '',
    jobCodeId: job?.jobCodeId ?? null,
    toastJobId: te.jobReference?.guid || null,
    toastJobTitle: job?.title || '',
    inAt: te.inDate || null,
    outAt: te.outDate || null,
    inLocal: localStamp(te.inDate, timeZone),
    outLocal: localStamp(te.outDate, timeZone),
    regularHours: round2(te.regularHours),
    overtimeHours: round2(te.overtimeHours),
    hourlyWage: num(te.hourlyWage), // null for salaried jobs
    declaredCashTips: round2(te.declaredCashTips),
    nonCashTips: round2(te.nonCashTips),
    cashGratuityServiceCharges: round2(te.cashGratuityServiceCharges),
    nonCashGratuityServiceCharges: round2(te.nonCashGratuityServiceCharges),
    tipsWithheld: round2(te.tipsWithheld),
    breakMinutes: unpaidBreakMinutes(te.breaks),
    autoClockedOut: !!te.autoClockedOut,
    modifiedAt: te.modifiedDate || null,
    syncedAt: at,
  };
}

const sameEntry = (a, b) => {
  const strip = ({ syncedAt, ...rest }) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/**
 * Replace one business date's Toast time entries with what Toast returned for that date.
 * Idempotent: ids come from Toast's guid, deleted entries are removed, and entries Toast no
 * longer reports for the date are dropped. Returns counts.
 */
export function applyTimeEntries(store, date, entries, { timeZone, at = new Date().toISOString() } = {}) {
  const emp = new Map(store.list('toastEmployees').map((e) => [e.id, e]));
  const job = new Map(store.list('toastJobs').map((j) => [j.id, j]));
  const seen = new Set();
  const out = { found: 0, added: 0, updated: 0, removed: 0, unmatched: 0 };
  for (const te of entries || []) {
    if (!te?.guid) continue;
    const id = `toast_${te.guid}`;
    if (te.deleted) { if (store.remove('timeEntries', id)) out.removed++; continue; }
    const doc = timeEntryDoc(te, { date, employee: emp.get(te.employeeReference?.guid), job: job.get(te.jobReference?.guid), timeZone, at });
    if (doc.date !== date) continue; // belongs to another business date; synced with that date
    seen.add(id);
    out.found++;
    if (!doc.userId) out.unmatched++;
    const cur = store.get('timeEntries', id);
    if (!cur) { store.insert('timeEntries', doc); out.added++; } else if (!sameEntry(cur, doc)) { store.update('timeEntries', id, doc); out.updated++; }
  }
  for (const t of store.list('timeEntries', (t) => t.source === SOURCE && t.date === date && !seen.has(t.id))) {
    store.remove('timeEntries', t.id);
    out.removed++;
  }
  return out;
}

/**
 * Everything for one business date, in one write: sales and time entries.
 * `orders` / `entries` are Toast's raw objects (orders may be null when only labor was fetched).
 */
export function applyDay(store, { date, orders, entries, replaceManual = false, timeZone, at = new Date().toISOString() }) {
  if (!DAY.test(date || '')) throw new Error(`Bad date ${date}`);
  const result = { date };
  if (orders) {
    const summary = summarizeOrders(orders);
    result.sales = { ...summary, saved: upsertSales(store, date, summary, { replaceManual, at }) };
  }
  if (entries) result.entries = applyTimeEntries(store, date, entries, { timeZone: timeZone || integration(store).timeZone, at });
  return result;
}
