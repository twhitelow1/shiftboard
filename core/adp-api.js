// RPC methods for ADP (Settings → Integrations → ADP, and Labor review → Import ADP hours) and the
// clock-in source. Spread into the api object in core/service.js; same (actor, args) shape and checks.
// The CSV is read in the browser (core/adp-csv.js) and arrives here as punches, so the import works
// in the demo too. The API sync needs the network and env credentials: server/adp-sync.js.
import { uid } from './store.js';
import { SOURCE, integration, planCsvImport, applyCsvImport, resolveAdpEntries } from './adp.js';
import { FIELDS } from './adp-csv.js';
import { CLOCK_SOURCES, clockSetting, resolveClockSource } from './clock.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PUNCHES = 6000; // about two months of a 100-person restaurant
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const numOrNull = (v, min, max) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.min(max, Math.max(min, Number(v))));
const intOrNull = (v, min, max) => { const n = numOrNull(v, min, max); return n == null ? null : Math.round(n); };

/** Punches from the browser, checked and trimmed: nothing but the fields the import reads. */
export function cleanPunches(list, fail) {
  if (!Array.isArray(list) || !list.length) fail(400, 'There are no punches to import in that file');
  if (list.length > MAX_PUNCHES) fail(400, 'That file is too big. Import a week or a pay period at a time.');
  const out = [];
  for (const p of list) {
    if (!p || !DAY.test(p.date || '')) continue;
    const name = text(p.name, 80), employeeId = text(p.employeeId, 40);
    if (!name && !employeeId) continue;
    const inMin = intOrNull(p.inMin, 0, 2880);
    const outMin = inMin == null ? null : intOrNull(p.outMin, inMin, inMin + 1440);
    const hours = numOrNull(p.hours, 0, 24);
    if (inMin == null && hours == null) continue;
    out.push({
      row: intOrNull(p.row, 0, 1e7) || 0, name, employeeId, date: p.date, inMin, outMin, hours,
      overtimeHours: numOrNull(p.overtimeHours, 0, 24), breakMinutes: intOrNull(p.breakMinutes, 0, 1440) || 0,
      overnight: outMin != null && outMin >= 1440, pairs: intOrNull(p.pairs, 0, 10) || 0,
      payCode: text(p.payCode, 24), department: text(p.department, 60), rate: numOrNull(p.rate, 0, 1000),
    });
  }
  if (!out.length) fail(400, 'There are no punches to import in that file');
  return out;
}

/** The columns to remember: { field: 'Header name' | ['In', 'In'] }, nothing else. */
function cleanColumns(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const f of FIELDS) {
    const v = c[f];
    out[f] = Array.isArray(v) ? v.slice(0, 4).map((x) => text(x, 60)).filter(Boolean) : v ? text(v, 60) : null;
  }
  return out;
}

export function adpMethods({ store, settings, fail, needMgr, needAdmin, now = () => new Date() }) {
  function clockInfo() {
    const st = settings();
    const counts = { adp: 0, toast: 0 };
    for (const t of store.list('timeEntries')) counts[t.source === SOURCE ? 'adp' : 'toast']++;
    return { setting: clockSetting(st), source: resolveClockSource(st, counts.adp > 0), counts };
  }

  return {
    // ----- what's there: last sync and import, the people and departments ADP knows, the clock-in source -----
    'adp.get': (actor) => {
      needMgr(actor);
      const i = integration(store);
      const entries = store.list('timeEntries', (t) => t.source === SOURCE);
      const byWorker = new Map(), byDept = new Map();
      for (const t of entries) {
        const w = byWorker.get(t.adpWorkerId) || { n: 0, last: '' };
        w.n++; if (t.date > w.last) w.last = t.date;
        byWorker.set(t.adpWorkerId, w);
        byDept.set(t.adpJobId, (byDept.get(t.adpJobId) || 0) + 1);
      }
      const workers = store.list('adpWorkers').map((w) => ({
        id: w.id, name: w.name, employeeId: w.employeeId || '', email: w.email || '', origin: w.origin, deleted: !!w.deleted,
        userId: w.userId, matchedBy: w.matchedBy, entries: byWorker.get(w.id)?.n || 0, lastDate: byWorker.get(w.id)?.last || null,
      })).sort((a, b) => a.name.localeCompare(b.name));
      const depts = store.list('adpJobs').map((d) => ({ id: d.id, title: d.title, jobCodeId: d.jobCodeId, matchedBy: d.matchedBy, entries: byDept.get(d.id) || 0 }))
        .sort((a, b) => a.title.localeCompare(b.title));
      return {
        lastSync: i.lastSync || null, lastCron: i.lastCron || null, lastImport: i.lastImport || null, imports: i.imports || [],
        workersAt: i.workersAt || null, csvColumns: i.csvColumns || null,
        clock: clockInfo(), workers, depts,
        totals: {
          entries: entries.length, unmatchedEntries: entries.filter((t) => !t.userId).length, noPosition: entries.filter((t) => !t.jobCodeId).length,
          csv: entries.filter((t) => t.origin === 'csv').length, api: entries.filter((t) => t.origin === 'api').length,
        },
      };
    },

    /** Match ADP people to ShiftBoard people, and ADP departments to positions, by hand. null = leave unmatched. */
    'adp.saveMapping': (actor, { workers = [], depts = [] } = {}) => {
      needMgr(actor);
      const workerIds = new Set(), deptIds = new Set();
      const list = Array.isArray(workers) ? workers : [];
      const after = new Map(store.list('adpWorkers').map((w) => [w.id, w.userId]));
      for (const m of list) after.set(m?.id, m?.userId || null);
      for (const m of list) {
        const cur = store.get('adpWorkers', m?.id);
        if (!cur) fail(404, 'That ADP person is gone. Import or sync again.');
        const userId = m.userId || null;
        const user = userId ? store.get('users', userId) : null;
        if (userId && !user) fail(404, 'Person not found');
        const twice = userId && [...after].some(([id, u]) => id !== cur.id && u === userId);
        if (twice && !m.allowShared) fail(409, `${user.name} is already matched to another ADP person`);
        store.update('adpWorkers', cur.id, { userId, matchedBy: 'manual' });
        // Remember their ADP employee ID on the person, so the next file matches them by ID.
        if (user && cur.employeeId && !user.adpId) store.update('users', user.id, { adpId: cur.employeeId });
        workerIds.add(cur.id);
      }
      for (const m of Array.isArray(depts) ? depts : []) {
        const cur = store.get('adpJobs', m?.id);
        if (!cur) fail(404, 'That ADP department is gone. Import or sync again.');
        const jobCodeId = m.jobCodeId || null;
        if (jobCodeId && !store.get('jobCodes', jobCodeId)) fail(404, 'Job code not found');
        store.update('adpJobs', cur.id, { jobCodeId, matchedBy: 'manual' });
        deptIds.add(cur.id);
      }
      const updated = resolveAdpEntries(store, { workerIds, deptIds });
      return { saved: workerIds.size + deptIds.size, entriesUpdated: updated };
    },

    // ----- the CSV import: preview (nothing saved), then save -----
    'adp.previewImport': (actor, { punches, matches } = {}) => {
      needMgr(actor);
      const plan = planCsvImport(store, cleanPunches(punches, fail), { matches: matches || {}, at: now().toISOString() });
      return { rows: plan.rows, counts: plan.counts, dates: plan.dates, removals: plan.removals.length };
    },
    'adp.importCsv': (actor, { punches, matches, fileName, columns } = {}) => {
      needMgr(actor);
      const at = now().toISOString();
      const plan = planCsvImport(store, cleanPunches(punches, fail), { matches: matches || {}, at });
      const counts = applyCsvImport(store, plan, { importId: uid('imp'), at, by: actor.id, fileName: text(fileName, 120), columns: cleanColumns(columns) });
      return { counts, from: plan.dates[0] || null, to: plan.dates.at(-1) || null };
    },

    // ----- which clock counts: ADP, Toast, both (ADP wins), or automatic -----
    'clock.setSource': (actor, { source } = {}) => {
      needAdmin(actor);
      if (!CLOCK_SOURCES.includes(source)) fail(400, 'Pick ADP, Toast, both, or automatic');
      store.get('settings', 'settings') ? store.update('settings', 'settings', { clockSource: source }) : store.insert('settings', { ...settings(), clockSource: source });
      return clockInfo();
    },
  };
}
