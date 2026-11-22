// The 86 List: what the restaurant is out of ("86'd") or running low on, reported from the bar and the floor.
// core/service.js spreads these methods into its API; each one checks its own permissions like the rest.
//
// Collections
//   eightySixLists  one per list. Bar and Kitchen by default (made the first time anyone opens the 86 List);
//                   admins rename them and add more in Settings, e.g. one bar list per bar area.
//                   { id, name, nameEs, kind: 'bar' | 'kitchen' | 'other', area, menu: 'drinks' | 'food' | 'all' | 'none',
//                     sections: [menu sections; when set they replace `menu`], reporters: rule, viewers: rule,
//                     notify, notifyLow, resetAt: '' | 'HH:MM', order, createdAt, updatedAt }
//                   rule: { all: true } or { departments: [...], jobCodeIds: [...] }
//   eightySixItems  what's out or low right now. key is the menu item ('m:<id>') or the name ('n:<letters>'), so the
//                   same thing reported twice on a list updates it instead of listing it twice.
//                   { id, listId, name, key, menuItemId, status: 'out' | 'low', count, note, area,
//                     reportedBy, reportedAt, outAt, updatedBy, updatedAt }
//   eightySixLog    items that came off a list, under the same id: the history managers read.
//                   { ...item, listName, clearedAt, clearedBy, clearedHow: 'back' | 'reset' | 'removed' }
//
// Who can do what
//   see a list:      everyone by default (servers need to know what the bar is out of); admins can limit a list to
//                    departments or positions. People who report on a list always see it. A hidden list never leaves
//                    the server: not in the board, the summary, the Training badge or a notification.
//   report / clear:  the list's departments and positions (Bar: the bar department, so bartenders and barbacks;
//                    Kitchen: the kitchen and front-of-house departments). Managers and up can always do both.
//   lists:           admins (Settings → 86 List). History: managers and up.
//
// The nightly reset ("Clear the list each night at…", off by default) needs no scheduled job: every read and write
// first moves items last touched before the most recent reset time to the log.
// Marking something 86'd tells the people on today's published schedule (on now or later today) who can see the list,
// each in their own language, never the person who reported it. Running low only when the list says so.
import { uid } from './store.js';
import { canManageSchedule, canChangeSettings } from './roles.js';
import { addDays, todayStr, daysBetween, shiftSpan } from './time.js';
import { effectiveShift } from './forecast.js';
import { scheduleAreas, findArea, cleanArea, sameArea } from './areas.js';

export const KINDS = ['bar', 'kitchen', 'other'];
export const MENU_MODES = ['drinks', 'food', 'all', 'none'];
export const UNDO_MINUTES = 60; // "Back in stock" can be undone for an hour
// The bar's departments and positions (bartenders, barbacks), for the Bar list's default reporters.
const BAR_DEPT = /\bbars?\b|bartend|barback/i;
const BAR_JOB = /bartend|barback|\bbar\b/i;
// Menu sections that are drinks (the Bar's suggestions); everything else is food (the Kitchen's).
const DRINKS = /cocktail|beer|wine|spirit|liquor|drink|beverage|\bbar\b|alcohol|mocktail|bourbon|whisk|scotch|tequila|mezcal|vodka|\bgin\b|\brum\b|sake|cider|seltzer|champagne|sparkling|bubbl|aperitiv|digestiv|amaro|cordial|\bshots?\b|\bdraft\b|bebida|cerveza|vino|coctel|cóctel/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Notifications, in each language. Item names, notes and list names are restaurant data and stay as written. */
export const TEXT = {
  en: {
    out: (list, name, note) => `${list}: ${name} is 86'd${note ? ` (${note})` : ''}`,
    low: (list, name, count, note) => `${list}: ${name} is running low${paren([count != null ? `${count} left` : '', note])}`,
  },
  es: {
    out: (list, name, note) => `${list}: se acabó ${name}${note ? ` (${note})` : ''}`,
    low: (list, name, count, note) => `${list}: queda poco de ${name}${paren([count != null ? (count === 1 ? 'queda 1' : `quedan ${count}`) : '', note])}`,
  },
};
function paren(parts) {
  const p = parts.filter((x) => x !== '' && x != null);
  return p.length ? ` (${p.join(', ')})` : '';
}

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const key = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const same = (a, b) => !!key(a) && key(a) === key(b);
const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/));
const uniq = (arr) => arr.filter((x, i) => x && arr.findIndex((y) => same(x, y)) === i);
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
const isDrink = (item) => DRINKS.test(item?.category || '');
/** The dedupe key of an item: its menu item, else its name. */
export const itemKey = (menuItemId, name) => (menuItemId ? `m:${menuItemId}` : `n:${key(name)}`);

/** Departments the restaurant uses: Settings, then the job codes'. */
function departmentsOf(store, st) {
  return uniq([...(st.departments || []), ...store.list('jobCodes').filter((j) => !j.archived).map((j) => j.department)].map((d) => text(d, 60)));
}

/**
 * The two lists a restaurant starts with. Bar: the bar department (and any Bartender or Barback position elsewhere)
 * reports drinks. Kitchen: every other department reports food. Managers report on both anyway; everyone sees both.
 */
export function defaultLists(store, st, at = new Date().toISOString()) {
  const depts = departmentsOf(store, st);
  const bar = depts.filter((d) => BAR_DEPT.test(d));
  const barJobs = store.list('jobCodes').filter((j) => !j.archived && BAR_JOB.test(j.name) && !bar.some((d) => same(d, j.department))).map((j) => j.id);
  const base = { area: '', sections: [], viewers: { all: true }, notify: true, notifyLow: false, resetAt: '', createdAt: at, updatedAt: at };
  return [
    { ...base, id: 'e86_bar', name: 'Bar', nameEs: 'Bar', kind: 'bar', menu: 'drinks', reporters: { departments: bar, jobCodeIds: barJobs }, order: 0 },
    { ...base, id: 'e86_kitchen', name: 'Kitchen', nameEs: 'Cocina', kind: 'kitchen', menu: 'food', reporters: { departments: depts.filter((d) => !BAR_DEPT.test(d)), jobCodeIds: [] }, order: 1 },
  ];
}

export function eightySixApi({ store, now, settings, notify, fail }) {
  const isMgr = (a) => canManageSchedule(a);
  const needAuth = (a) => { if (!a) fail(401, 'Please sign in'); };
  const needMgr = (a) => { needAuth(a); if (!isMgr(a)) fail(403, 'Managers only'); };
  const needAdmin = (a) => { needAuth(a); if (!canChangeSettings(a)) fail(403, 'Admins only'); };
  const fresh = (a) => store.get('users', a.id) || a; // the actor as saved (their positions)
  const nameOf = (id) => (id ? store.get('users', id)?.name || '' : '');
  const jobMap = () => Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  const lists = () => store.list('eightySixLists').sort(byOrder);
  const nowIso = () => now().toISOString();

  // ---------- who can see and report ----------
  function cleanRule(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.all) return { all: true };
    const jobs = jobMap();
    return {
      departments: uniq(asList(r.departments).map((d) => text(d, 60))).slice(0, 40),
      jobCodeIds: [...new Set(asList(r.jobCodeIds).filter((id) => jobs[id]))],
    };
  }
  function ruleMatches(user, rule) {
    if (!rule || rule.all) return true;
    const mine = (user?.jobCodes || []).map((j) => j.jobCodeId);
    if ((rule.jobCodeIds || []).some((id) => mine.includes(id))) return true;
    const jobs = jobMap();
    const depts = mine.map((id) => jobs[id]?.department).filter(Boolean);
    return (rule.departments || []).some((d) => depts.some((x) => same(x, d)));
  }
  const canReport = (u, list) => isMgr(u) || (!!list.reporters && ruleMatches(u, list.reporters));
  const canSee = (u, list) => isMgr(u) || !list.viewers || ruleMatches(u, list.viewers) || canReport(u, list);
  /** A list the person may see, or 404 (a hidden list looks like no list at all). */
  function visibleList(u, id) {
    const list = id ? store.get('eightySixLists', id) : null;
    if (!list || !canSee(u, list)) fail(404, 'List not found');
    return list;
  }
  const listName = (list, lang) => (lang === 'es' && list?.nameEs ? list.nameEs : list?.name || '');

  // ---------- the nightly reset, and the default lists ----------
  function lastReset(list) {
    if (!TIME.test(list.resetAt || '')) return null;
    const n = now();
    const [h, m] = list.resetAt.split(':').map(Number);
    const at = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, m, 0, 0);
    if (at > n) at.setDate(at.getDate() - 1);
    return at;
  }
  function archive(item, list, extra) {
    store.remove('eightySixItems', item.id);
    const doc = { ...item, listName: list?.name || item.listName || '', ...extra };
    if (store.get('eightySixLog', item.id)) store.update('eightySixLog', item.id, doc); else store.insert('eightySixLog', doc);
  }
  /** Before anything else: make the default lists if there are none, and run any reset that's due. */
  function ready() {
    let all = lists();
    if (!all.length) {
      for (const l of defaultLists(store, settings(), nowIso())) store.insert('eightySixLists', l);
      all = lists();
    }
    for (const list of all) {
      const at = lastReset(list);
      if (!at) continue;
      const iso = at.toISOString();
      for (const it of store.list('eightySixItems', (x) => x.listId === list.id && (x.updatedAt || x.reportedAt) < iso)) {
        archive(it, list, { clearedAt: iso, clearedBy: null, clearedHow: 'reset' });
      }
    }
    return all;
  }

  // ---------- menu suggestions ----------
  const menuItems = () => store.list('menuItems').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  /** The Training menu items a list suggests: its sections, else drinks (Bar), food (Kitchen), all or none. Not ones taken off the menu. */
  function suggestions(list, menu = menuItems()) {
    const on = menu.filter((i) => !i.eightySixed);
    if (list.sections?.length) return on.filter((i) => list.sections.some((c) => same(c, i.category)));
    if (list.menu === 'all') return on;
    if (list.menu === 'none') return [];
    return on.filter((i) => (list.menu === 'drinks' ? isDrink(i) : !isDrink(i)));
  }
  /** The menu item a typed name means (its English or Spanish name), if any. */
  const menuMatch = (name, menu = menuItems()) => menu.find((m) => same(m.name, name) || same(m.es?.name, name)) || null;

  // ---------- views ----------
  function itemView(it, menu) {
    const m = it.menuItemId ? menu?.find((x) => x.id === it.menuItemId) || store.get('menuItems', it.menuItemId) : null;
    return {
      id: it.id, listId: it.listId, name: it.name, nameEs: m?.es?.name || '', menuItemId: it.menuItemId || null,
      status: it.status, count: it.count ?? null, note: it.note || '', area: it.area || '',
      reportedBy: { id: it.reportedBy, name: nameOf(it.reportedBy) }, reportedAt: it.reportedAt, outAt: it.outAt || null,
      updatedBy: { id: it.updatedBy || it.reportedBy, name: nameOf(it.updatedBy || it.reportedBy) }, updatedAt: it.updatedAt || it.reportedAt,
    };
  }
  const listView = (l) => ({ id: l.id, name: l.name, nameEs: l.nameEs || '', kind: l.kind, area: l.area || '', notify: l.notify !== false, notifyLow: !!l.notifyLow, resetAt: l.resetAt || '' });
  const fullList = (l) => ({ ...listView(l), menu: l.menu, sections: l.sections || [], reporters: l.reporters || { departments: [], jobCodeIds: [] }, viewers: l.viewers || { all: true }, order: l.order ?? 0 });
  // Out first, then running low; newest first within each.
  const byUrgency = (a, b) => (a.status === b.status ? 0 : a.status === 'out' ? -1 : 1) || String(b.updatedAt || b.reportedAt).localeCompare(String(a.updatedAt || a.reportedAt));

  // ---------- notifications ----------
  const absMinutes = (n) => daysBetween('2000-01-01', todayStr(n)) * 1440 + n.getHours() * 60 + n.getMinutes();
  /** People on today's published schedule whose shift is on now or later today (and last night's, if it's still going). */
  function workingToday() {
    const st = settings();
    const n = now();
    const t = absMinutes(n);
    const d = todayStr(n);
    const ids = new Set();
    for (const s of store.list('shifts', (x) => x.published && x.userId && (x.date === d || x.date === addDays(d, -1)))) {
      const [, to] = shiftSpan(effectiveShift(s, st));
      if (to > t) ids.add(s.userId);
    }
    return [...ids].map((id) => store.get('users', id)).filter((u) => u && u.active !== false);
  }
  function tell(list, item, reporter) {
    const people = workingToday().filter((u) => u.id !== reporter.id && canSee(u, list));
    if (!people.length) return 0;
    const m = item.menuItemId ? store.get('menuItems', item.menuItemId) : null;
    const where = (lang) => `${listName(list, lang)}${item.area && !sameArea(item.area, list.area) ? ` (${item.area})` : ''}`;
    const name = (lang) => (lang === 'es' && m?.es?.name ? m.es.name : item.name);
    notify(people.map((u) => u.id), (lang) => {
      const T = TEXT[lang] || TEXT.en;
      return item.status === 'out' ? T.out(where(lang), name(lang), item.note) : T.low(where(lang), name(lang), item.count, item.note);
    }, '#/86');
    return people.length;
  }

  // ---------- cleaning input ----------
  function cleanCount(v) {
    if (v === '' || v == null) return null;
    const n = Number(String(v).trim());
    if (!Number.isInteger(n) || n < 0 || n > 9999) fail(400, 'The count must be a whole number');
    return n;
  }
  const cleanItemArea = (v) => (text(v, 60) ? findArea(cleanArea(v), scheduleAreas(settings())) || '' : '');
  function cleanList(a, cur) {
    const name = text(a.name ?? cur?.name, 40);
    if (!name) fail(400, 'Give the list a name');
    const resetAt = a.resetAt == null ? cur?.resetAt || '' : String(a.resetAt || '');
    if (resetAt && !TIME.test(resetAt)) fail(400, 'Pick a time like 04:00');
    const kind = KINDS.includes(a.kind) ? a.kind : cur?.kind || 'other';
    return {
      name,
      nameEs: text(a.nameEs ?? cur?.nameEs, 40),
      kind,
      area: 'area' in a ? cleanItemArea(a.area) : cur?.area || '',
      menu: MENU_MODES.includes(a.menu) ? a.menu : cur?.menu || (kind === 'bar' ? 'drinks' : 'food'),
      sections: 'sections' in a ? uniq(asList(a.sections).map((c) => text(c, 40))).slice(0, 40) : cur?.sections || [],
      reporters: ('reporters' in a ? cleanRule(a.reporters) : cur?.reporters) || { departments: [], jobCodeIds: [] },
      viewers: ('viewers' in a ? cleanRule(a.viewers) : cur?.viewers) || { all: true },
      notify: 'notify' in a ? a.notify !== false : cur?.notify !== false,
      notifyLow: 'notifyLow' in a ? !!a.notifyLow : !!cur?.notifyLow,
      resetAt,
    };
  }

  // ---------- API ----------
  const api = {
    // Every list the person may see with what's on it, what each list suggests from the menu, and what they may do.
    'eightySix.board.get': (actor) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const menu = menuItems();
      const items = store.list('eightySixItems');
      const out = lists().filter((l) => canSee(u, l)).map((l) => ({
        ...listView(l), canReport: canReport(u, l),
        suggest: suggestions(l, menu).map((i) => i.id),
        items: items.filter((i) => i.listId === l.id).sort(byUrgency).map((i) => itemView(i, menu)),
      }));
      const wanted = new Set(out.flatMap((l) => l.suggest));
      return {
        lists: out,
        menu: Object.fromEntries(menu.filter((i) => wanted.has(i.id)).map((i) => [i.id, { name: i.name, nameEs: i.es?.name || '', category: i.category || '' }])),
        areas: scheduleAreas(settings()),
        canReport: out.some((l) => l.canReport),
        isMgr: isMgr(u),
        now: nowIso(),
      };
    },
    // Counts per list for the banners on the Schedule and My Shifts, and the menu items 86'd today (Training's badge).
    'eightySix.summary': (actor) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const menu = menuItems();
      const items = store.list('eightySixItems');
      const mine = lists().filter((l) => canSee(u, l));
      const seen = new Set(mine.map((l) => l.id));
      const visible = items.filter((i) => seen.has(i.listId));
      const ids = (status) => [...new Set(visible.filter((i) => i.status === status).map((i) => i.menuItemId || menuMatch(i.name, menu)?.id).filter(Boolean))];
      return {
        lists: mine.map((l) => ({ ...listView(l), out: visible.filter((i) => i.listId === l.id && i.status === 'out').length, low: visible.filter((i) => i.listId === l.id && i.status === 'low').length })),
        out: visible.filter((i) => i.status === 'out').length,
        low: visible.filter((i) => i.status === 'low').length,
        outMenuItemIds: ids('out'),
        lowMenuItemIds: ids('low'),
      };
    },
    // Report something 86'd (out) or running low. The same thing again on the same list updates it.
    'eightySix.report': (actor, a = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const list = visibleList(u, a.listId);
      if (!canReport(u, list)) fail(403, 'You can’t report on this list');
      const menu = menuItems();
      const picked = a.menuItemId ? menu.find((m) => m.id === a.menuItemId) || null : null;
      const typed = text(a.name, 80);
      const linked = picked || (typed ? menuMatch(typed, menu) : null);
      if (!linked && !typed) fail(400, 'Say what’s out');
      const k = itemKey(linked?.id, linked ? linked.name : typed);
      const cur = store.list('eightySixItems', (x) => x.listId === list.id && x.key === k)[0] || null;
      const status = a.status === 'low' ? 'low' : 'out';
      const count = status === 'out' ? null : cleanCount(a.count);
      // A menu item keeps the menu's name; typed text keeps the spelling it was first reported with.
      const doc = { name: linked ? linked.name : cur?.name || typed, menuItemId: linked?.id || null, status, count, note: text(a.note, 140), area: cleanItemArea(a.area) };
      const at = nowIso();
      const nowOut = status === 'out' && cur?.status !== 'out';
      const saved = cur
        ? store.update('eightySixItems', cur.id, { ...doc, updatedBy: u.id, updatedAt: at, ...(nowOut ? { outAt: at } : {}) })
        : store.insert('eightySixItems', { id: uid('e86'), listId: list.id, key: k, ...doc, reportedBy: u.id, reportedAt: at, outAt: status === 'out' ? at : null, updatedBy: u.id, updatedAt: at });
      const announce = list.notify !== false && (nowOut || (status === 'low' && !cur && !!list.notifyLow));
      return { item: itemView(saved, menu), updated: !!cur, notified: announce ? tell(list, saved, u) : 0 };
    },
    // Back in stock: off the list and into the history. eightySix.restore undoes it.
    'eightySix.clear': (actor, { id } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const it = id ? store.get('eightySixItems', id) : null;
      const list = it ? store.get('eightySixLists', it.listId) : null;
      if (!it || !list || !canSee(u, list)) fail(404, 'That item isn’t on the list anymore');
      if (!canReport(u, list)) fail(403, 'You can’t report on this list');
      archive(it, list, { clearedAt: nowIso(), clearedBy: u.id, clearedHow: 'back' });
      return { ok: true, id: it.id, name: it.name };
    },
    'eightySix.restore': (actor, { id } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const log = id ? store.get('eightySixLog', id) : null;
      const list = log ? store.get('eightySixLists', log.listId) : null;
      const recent = log && Date.parse(nowIso()) - Date.parse(log.clearedAt) <= UNDO_MINUTES * 60000;
      if (!log || !list || !canSee(u, list) || log.clearedHow !== 'back' || !recent) fail(404, 'That can’t be undone anymore');
      if (!canReport(u, list)) fail(403, 'You can’t report on this list');
      if (store.list('eightySixItems', (x) => x.listId === list.id && x.key === log.key).length) fail(409, 'It’s already back on the list');
      const { clearedAt, clearedBy, clearedHow, listName: _n, ...item } = log;
      store.remove('eightySixLog', log.id);
      return { item: itemView(store.insert('eightySixItems', item)) };
    },

    // ----- history (managers) -----
    // What came off (and is on) the lists in the last `days`, newest first, and what was 86'd most, to help with ordering.
    'eightySix.history.get': (actor, { days = 30, listId = '' } = {}) => {
      needMgr(actor);
      ready();
      const n = Math.min(365, Math.max(1, Math.round(Number(days) || 30)));
      const from = new Date(now().getTime() - n * 86400000).toISOString();
      const byId = Object.fromEntries(lists().map((l) => [l.id, l]));
      const menu = menuItems();
      const rows = [
        ...store.list('eightySixItems').map((i) => ({ ...i, active: true })),
        ...store.list('eightySixLog').map((i) => ({ ...i, active: false })),
      ].filter((r) => (!listId || r.listId === listId) && ((r.outAt || r.reportedAt) >= from || (r.clearedAt || '') >= from));
      const when = (r) => r.outAt || r.reportedAt || '';
      rows.sort((a, b) => when(b).localeCompare(when(a)));
      const entries = rows.slice(0, 300).map((r) => ({
        ...itemView(r, menu), listName: byId[r.listId]?.name || r.listName || '', listNameEs: byId[r.listId]?.nameEs || '',
        active: r.active, clearedAt: r.clearedAt || null, clearedHow: r.clearedHow || null, clearedBy: r.clearedBy ? { id: r.clearedBy, name: nameOf(r.clearedBy) } : null,
      }));
      const groups = new Map();
      for (const r of rows.filter((x) => x.outAt && x.outAt >= from)) {
        const k = r.key || itemKey(r.menuItemId, r.name);
        const g = groups.get(k) || { key: k, name: r.name, nameEs: '', menuItemId: r.menuItemId || null, times: 0, lastAt: '', lists: [] };
        g.times++;
        if (r.outAt > g.lastAt) { g.lastAt = r.outAt; g.name = r.name; }
        const ln = byId[r.listId]?.name || r.listName || '';
        if (ln && !g.lists.includes(ln)) g.lists.push(ln);
        groups.set(k, g);
      }
      const top = [...groups.values()].map((g) => ({ ...g, nameEs: g.menuItemId ? menu.find((m) => m.id === g.menuItemId)?.es?.name || '' : '' }))
        .sort((a, b) => b.times - a.times || b.lastAt.localeCompare(a.lastAt)).slice(0, 10);
      return { days: n, from, entries, top, lists: lists().map(listView) };
    },

    // ----- lists (Settings → 86 List, admins) -----
    'eightySix.settings.get': (actor) => {
      needAdmin(actor);
      ready();
      const counts = {};
      for (const i of store.list('eightySixItems')) counts[i.listId] = (counts[i.listId] || 0) + 1;
      const jobs = store.list('jobCodes').filter((j) => !j.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return {
        lists: lists().map((l) => ({ ...fullList(l), itemCount: counts[l.id] || 0 })),
        options: {
          departments: departmentsOf(store, settings()),
          jobCodes: jobs.map((j) => ({ id: j.id, name: j.name, department: j.department || '' })),
          areas: scheduleAreas(settings()),
          sections: uniq(menuItems().map((i) => i.category)),
        },
      };
    },
    'eightySix.saveList': (actor, a = {}) => {
      needAdmin(actor);
      ready();
      const cur = a.id ? store.get('eightySixLists', a.id) : null;
      if (a.id && !cur) fail(404, 'List not found');
      const doc = { ...cleanList(a, cur), updatedAt: nowIso() };
      const out = cur ? store.update('eightySixLists', cur.id, doc)
        : store.insert('eightySixLists', { id: uid('e86l'), ...doc, order: Math.max(0, ...lists().map((l) => (l.order ?? 0) + 1)), createdAt: nowIso() });
      return fullList(out);
    },
    // Removing a list takes what's on it into the history.
    'eightySix.deleteList': (actor, { id } = {}) => {
      needAdmin(actor);
      const all = ready();
      const list = id ? store.get('eightySixLists', id) : null;
      if (!list) fail(404, 'List not found');
      if (all.length <= 1) fail(409, 'Keep at least one list');
      for (const it of store.list('eightySixItems', (x) => x.listId === id)) archive(it, list, { clearedAt: nowIso(), clearedBy: actor.id, clearedHow: 'removed' });
      store.remove('eightySixLists', id);
      return { ok: true };
    },
  };
  return api;
}

/**
 * SAMPLE 86 List for the demo: the Bar and Kitchen lists plus a Moon Rabbit bar list, a few items on them now, and
 * a month of history. Invented items (from the sample Training menu, or made up) and demo people only.
 */
export function seedEightySix(store, { userId, now = new Date() }) {
  const st = store.get('settings', 'settings') || {};
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60000).toISOString();
  const [bar, kitchen] = defaultLists(store, st, at(60 * 24 * 40));
  store.insert('eightySixLists', bar);
  store.insert('eightySixLists', { ...kitchen, order: 2 });
  const cocktail = store.list('jobCodes', (j) => /cocktail/i.test(j.name)).map((j) => j.id);
  store.insert('eightySixLists', {
    ...bar, id: 'e86_moon', name: 'Moon Rabbit bar', nameEs: 'Bar del Moon Rabbit', area: 'Moon Rabbit', order: 1,
    reporters: { departments: bar.reporters.departments, jobCodeIds: [...bar.reporters.jobCodeIds, ...cocktail] },
  });
  const menu = (id) => store.get('menuItems', id);
  const item = (listId, name, menuItemId, status, by, minutesAgo, extra = {}) => {
    const m = menuItemId ? menu(menuItemId) : null;
    const nm = m ? m.name : name;
    return {
      id: uid('e86'), listId, name: nm, key: itemKey(m ? menuItemId : null, nm), menuItemId: m ? menuItemId : null, status, count: null, note: '', area: '',
      reportedBy: userId[by], reportedAt: at(minutesAgo), outAt: status === 'out' ? at(minutesAgo) : null, updatedBy: userId[by], updatedAt: at(minutesAgo), ...extra,
    };
  };
  // On the lists now
  for (const it of [
    item('e86_bar', '', 'mnu_mule', 'out', 'Mak', 35, { note: 'Ginger beer comes Tuesday', area: 'Rabbit Hole' }),
    item('e86_bar', 'Smoked pineapple syrup', null, 'low', 'Karen', 130, { count: 1 }),
    item('e86_moon', '', 'mnu_rose', 'low', 'Dante', 70, { count: 3, note: 'Offer the Garden Spritz' }),
    item('e86_kitchen', '', 'mnu_burrata', 'out', 'Chef Lucas', 50, { note: 'Peaches back Friday' }),
  ]) store.insert('eightySixItems', it);
  // History: what was out, for how long, and who said it was back
  const day = 60 * 24;
  const past = (listId, name, menuItemId, status, by, minutesAgo, outFor, backBy, extra) => ({
    ...item(listId, name, menuItemId, status, by, minutesAgo, extra),
    listName: store.get('eightySixLists', listId)?.name || '', clearedAt: at(minutesAgo - outFor), clearedBy: userId[backBy], clearedHow: 'back',
  });
  for (const it of [
    past('e86_bar', '', 'mnu_mule', 'out', 'Yair', 3 * day + 300, 20 * 60, 'Mak', { note: 'Out of ginger beer' }),
    past('e86_bar', '', 'mnu_mule', 'out', 'Mak', 9 * day + 240, 26 * 60, 'Dante'),
    past('e86_bar', '', 'mnu_mule', 'out', 'Dante', 17 * day + 200, 22 * 60, 'Yair'),
    past('e86_bar', 'Fresh lime juice', null, 'out', 'Karen', 2 * day + 400, 90, 'Karen', { note: 'Juicing more now' }),
    past('e86_bar', 'Fresh lime juice', null, 'out', 'Torie', 11 * day + 360, 120, 'Torie'),
    past('e86_moon', '', 'mnu_rose', 'out', 'Romina', 20 * day + 300, 2 * day, 'Todd'),
    past('e86_moon', '', 'mnu_spritz', 'low', 'Todd', 6 * day + 280, 8 * 60, 'Romina', { count: 4 }),
    past('e86_kitchen', '', 'mnu_burrata', 'out', 'Chef Lucas', 6 * day + 420, 2 * day, 'Chef Lucas', { note: 'Peach delivery late' }),
    past('e86_kitchen', '', 'mnu_burger', 'out', 'Kelly', 12 * day + 330, 18 * 60, 'Chef Lucas', { note: 'Out of brioche buns' }),
    past('e86_kitchen', '', 'mnu_cake', 'low', 'Ben', 4 * day + 300, 5 * 60, 'Chef Lucas', { count: 2 }),
  ]) store.insert('eightySixLog', it);
}
