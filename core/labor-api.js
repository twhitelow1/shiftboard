// RPC methods for Forecast & Labor → Labor review and the Toast mappings (Settings → Integrations).
// Spread into the api object in core/service.js; same (actor, args) shape and permission checks.
// Syncing itself needs the network and env credentials, so it lives on the server (server/toast-sync.js).
import { addDays, weekStart as weekStartOf, todayStr } from './time.js';
import { laborReview } from './labor.js';
import { integration, resolveEntries, SOURCE } from './toast.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function laborMethods({ store, settings, fail, needMgr, now = () => new Date() }) {
  const today = () => todayStr(now());

  /** What the UI shows about the last sync (never secrets; those live only in env). */
  function syncInfo() {
    const i = integration(store);
    return {
      restaurantName: i.restaurantName || '', locationName: i.locationName || '', timeZone: i.timeZone || '',
      lastSync: i.lastSync || null, lastCron: i.lastCron || null, listsAt: i.listsAt || null,
    };
  }

  return {
    // ----- labor review: scheduled vs. worked for one week -----
    'labor.week': (actor, { weekStart: ws } = {}) => {
      needMgr(actor);
      const st = settings();
      const start = DAY.test(ws || '') ? weekStartOf(ws, st.weekStartDow) : addDays(weekStartOf(today(), st.weekStartDow), -7);
      const end = addDays(start, 6);
      const inWeek = (x) => x.date >= start && x.date <= end;
      const review = laborReview({
        weekStart: start,
        shifts: store.list('shifts', inWeek),
        entries: store.list('timeEntries', inWeek),
        sales: store.list('sales', inWeek),
        users: store.list('users').map(({ passwordHash, ...u }) => u),
        jobCodes: store.list('jobCodes'),
        settings: st,
      });
      const anyEntries = store.list('timeEntries', (t) => t.date <= end).length > 0;
      return { ...review, anyEntries, toast: syncInfo(), today: today() };
    },

    // ----- Toast: what's been synced and how Toast's people and jobs map to ShiftBoard's -----
    'toast.get': (actor) => {
      needMgr(actor);
      const entries = store.list('timeEntries', (t) => t.source === SOURCE);
      const byEmp = new Map(), byJob = new Map();
      for (const t of entries) {
        const e = byEmp.get(t.toastEmployeeId) || { n: 0, last: '' };
        e.n++; if (t.date > e.last) e.last = t.date;
        byEmp.set(t.toastEmployeeId, e);
        byJob.set(t.toastJobId, (byJob.get(t.toastJobId) || 0) + 1);
      }
      const employees = store.list('toastEmployees').map((e) => ({
        id: e.id, name: e.name, email: e.email, deleted: e.deleted, userId: e.userId, matchedBy: e.matchedBy,
        entries: byEmp.get(e.id)?.n || 0, lastDate: byEmp.get(e.id)?.last || null,
      })).sort((a, b) => a.name.localeCompare(b.name));
      const jobs = store.list('toastJobs').map((j) => ({
        id: j.id, title: j.title, code: j.code, deleted: j.deleted, jobCodeId: j.jobCodeId, matchedBy: j.matchedBy, entries: byJob.get(j.id) || 0,
      })).sort((a, b) => a.title.localeCompare(b.title));
      const salesDays = store.list('sales', (s) => s.source === SOURCE).length;
      return {
        ...syncInfo(), employees, jobs,
        totals: { entries: entries.length, unmatchedEntries: entries.filter((t) => !t.userId).length, salesDays },
      };
    },

    /** Match Toast employees to people and Toast jobs to job codes by hand. null = leave unmatched. */
    'toast.saveMapping': (actor, { employees = [], jobs = [] } = {}) => {
      needMgr(actor);
      const empIds = new Set(), jobIds = new Set();
      const list = Array.isArray(employees) ? employees : [];
      // The mapping after this save, to catch one person matched to two Toast employees.
      const after = new Map(store.list('toastEmployees').map((e) => [e.id, e.userId]));
      for (const m of list) after.set(m?.id, m?.userId || null);
      for (const m of list) {
        const cur = store.get('toastEmployees', m?.id);
        if (!cur) fail(404, 'That Toast employee is gone. Sync again.');
        const userId = m.userId || null;
        if (userId && !store.get('users', userId)) fail(404, 'Person not found');
        // Two Toast records for one person happens (a re-hire), but only on purpose.
        const twice = userId && [...after].some(([id, u]) => id !== cur.id && u === userId);
        if (twice && !m.allowShared) fail(409, `${store.get('users', userId).name} is already matched to another Toast employee`);
        store.update('toastEmployees', cur.id, { userId, matchedBy: 'manual' });
        empIds.add(cur.id);
      }
      for (const m of Array.isArray(jobs) ? jobs : []) {
        const cur = store.get('toastJobs', m?.id);
        if (!cur) fail(404, 'That Toast job is gone. Sync again.');
        const jobCodeId = m.jobCodeId || null;
        if (jobCodeId && !store.get('jobCodes', jobCodeId)) fail(404, 'Job code not found');
        store.update('toastJobs', cur.id, { jobCodeId, matchedBy: 'manual' });
        jobIds.add(cur.id);
      }
      const updated = resolveEntries(store, { employeeIds: empIds, jobIds });
      return { saved: empIds.size + jobIds.size, entriesUpdated: updated };
    },
  };
}
