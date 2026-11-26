// The 86 List: the ingredients and supplies the restaurant is out of ("86'd") or running low on, reported from the
// bar and the floor. It's for what the team stocks or has to order to do the work (limes, oat milk, Bacardi, napkins,
// rocks glasses, fryer oil, CO2…), not for menu items: a dish that's off the menu is Training's own 86'd flag.
// core/service.js spreads these methods into its API; each one checks its own permissions like the rest. The
// managers' 86 List report (Reports → 86 List) is in core/reports-86.js and spread in here.
//
// Collections
//   eightySixLists  one per list. Bar and Kitchen by default (made the first time anyone opens the 86 List);
//                   admins rename them and add more in Settings, e.g. one bar list per bar area.
//                   { id, name, nameEs, kind: 'bar' | 'kitchen' | 'other', area, menu: 'drinks' | 'food' | 'all' | 'none',
//                     sections: [menu sections; when set they replace `menu`], reporters: rule, viewers: rule,
//                     notify, notifyLow, resetAt: '' | 'HH:MM', order, createdAt, updatedAt }
//                   rule: { all: true } or { departments: [...], jobCodeIds: [...] }
//                   menu: Training menu items the report form also suggests. 'none' for every list (the
//                   eightySix-menu-none migration set the old ones once); Settings → "Also suggest menu items" turns it on.
//   eightySixItems  what's out or low right now. key is the menu item ('m:<id>') or the name ('n:<letters>'), so the
//                   same thing reported twice on a list updates it instead of listing it twice. Only lists that suggest
//                   menu items link new reports to the menu (for Training's "86'd today" badge); older links keep working.
//                   { id, listId, name, key, menuItemId, status: 'out' | 'low', count, note, area, category,
//                     reportedBy, reportedAt, outAt, lowAt, updatedBy, updatedAt, productId }
//                   productId: the catalog's product (core/products.js), shared with Stock lists; never shown by the 86 screens.
//                   photos: [{ id, w, h, by, at }] (up to 3, optional: the empty bottle, the shelf)
//                   category: one of the restaurant's categories (Produce, Dairy… see DEFAULT_CATEGORIES), or ''.
//   eightySixLog    items that came off a list, under the same id: the history managers read.
//                   { ...item, listName, clearedAt, clearedBy, clearedHow: 'back' | 'reset' | 'removed' }
//   eightySixNames  what each item name was last filed under, so the second report pre-fills its category.
//                   { id: 'n:<letters>', name, category, updatedAt }
//   eightySixConfig { id: 'categories', list: [{ id, name, nameEs }], updatedAt }: the categories in order, when an admin
//                   changed them (Settings → 86 List). A built-in category with no name keeps its translated name.
//   eightySixPhotos one photo per document (base64), uploaded one per request (eightySix.addPhoto). The server keeps
//                   the bytes in Postgres only (server/db.js LAZY_DATA) and serves them at /api/eighty-six/photos/:id
//                   to people who can see the list (server/eighty-six-routes.js). Kept with the history for 30 days
//                   after the item comes off the list, then deleted on the next read or write.
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
import { scheduleAreas, uniqueAreas, findArea, cleanArea, sameArea } from './areas.js';
import { checkPhoto } from './training.js';
import { eightySixReportsApi } from './reports-86.js';
import { productFor86 } from './products.js';

export const KINDS = ['bar', 'kitchen', 'other'];
export const MENU_MODES = ['drinks', 'food', 'all', 'none'];
export const UNDO_MINUTES = 60; // "Back in stock" can be undone for an hour
export const PHOTOS_PER_ITEM = 3;
export const KEEP_PHOTOS_DAYS = 30; // after an item comes off the list
export const MENU_NONE_MIGRATION = 'eightySix-menu-none'; // the marker in `migrations`: old lists stopped suggesting menu items
export const SUGGESTIONS = 12; // past reports the report form offers per list
const KNOWN_NAMES = 400; // item names with a remembered category sent to the report form
export const MAX_CATEGORIES = 30;

/**
 * The categories an item can be filed under (optional), in order. Admins rename them or add their own in
 * Settings → 86 List; 'other' always stays. The 86 List report groups by them and so does its shopping list.
 */
export const DEFAULT_CATEGORIES = [
  { id: 'produce', en: 'Produce', es: 'Frutas y verduras' },
  { id: 'dairy', en: 'Dairy', es: 'Lácteos' },
  { id: 'proteins', en: 'Proteins', es: 'Proteínas' },
  { id: 'dry', en: 'Dry goods', es: 'Abarrotes' },
  { id: 'liquor', en: 'Liquor, beer & wine', es: 'Licores, cerveza y vino' },
  { id: 'paper', en: 'Paper & disposables', es: 'Papel y desechables' },
  { id: 'glassware', en: 'Glassware & smallwares', es: 'Cristalería y utensilios' },
  { id: 'cleaning', en: 'Cleaning & chemicals', es: 'Limpieza y químicos' },
  { id: 'other', en: 'Other', es: 'Otros' },
];
const BUILT_IN = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
/**
 * The restaurant's categories in order, with their names in both languages: [{ id, name, nameEs, builtIn }].
 * A built-in one keeps its translated name unless an admin renamed it.
 */
export function categoriesOf(store) {
  const saved = store.get('eightySixConfig', 'categories')?.list;
  const list = Array.isArray(saved) && saved.length ? saved : DEFAULT_CATEGORIES.map((c) => ({ id: c.id, name: '', nameEs: '' }));
  return list.map((c) => {
    const b = BUILT_IN[c.id];
    const name = c.name || b?.en || c.id;
    return { id: c.id, name, nameEs: c.nameEs || b?.es || name, builtIn: !!b };
  });
}
/** A category's name in a language ('' for none). */
export const categoryName = (cat, lang = 'en') => (cat ? (lang === 'es' ? cat.nameEs || cat.name : cat.name) : '');
/** Does this list also suggest Training menu items (and link new reports to them)? Off unless an admin turns it on. */
export const suggestsMenu = (list) => !!list?.sections?.length || (!!list?.menu && list.menu !== 'none');
// The bar's departments and positions (bartenders, barbacks), for the Bar list's default reporters.
const BAR_DEPT = /\bbars?\b|bartend|barback/i;
const BAR_JOB = /bartend|barback|\bbar\b/i;
// Menu sections that are drinks (the Bar's suggestions); everything else is food (the Kitchen's).
const DRINKS = /cocktail|beer|wine|spirit|liquor|drink|beverage|\bbar\b|alcohol|mocktail|bourbon|whisk|scotch|tequila|mezcal|vodka|\bgin\b|\brum\b|sake|cider|seltzer|champagne|sparkling|bubbl|aperitiv|digestiv|amaro|cordial|\bshots?\b|\bdraft\b|bebida|cerveza|vino|coctel|cóctel/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Notifications, in each language. Item names, notes and list names are restaurant data and stay as written.
 * Worded for supplies, singular or plural: "Bar: out of limes", "Bar: running low on CO2 (1 left)".
 */
export const TEXT = {
  en: {
    out: (list, name, note) => `${list}: out of ${name}${note ? ` (${note})` : ''}`,
    low: (list, name, count, note) => `${list}: running low on ${name}${paren([count != null ? `${count} left` : '', note])}`,
  },
  es: {
    out: (list, name, note) => `${list}: no hay ${name}${note ? ` (${note})` : ''}`,
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
/** The key of an item's name alone (accents, case and spaces don't matter): its remembered category, report groups. */
export const nameKey = (name) => `n:${key(name)}`;

// ---------- who can see and report (also used by the photo route, server/eighty-six-routes.js) ----------
function ruleMatches(store, user, rule) {
  if (!rule || rule.all) return true;
  const mine = (user?.jobCodes || []).map((j) => j.jobCodeId);
  if ((rule.jobCodeIds || []).some((id) => mine.includes(id))) return true;
  const depts = mine.map((id) => store.get('jobCodes', id)?.department).filter(Boolean);
  return (rule.departments || []).some((d) => depts.some((x) => same(x, d)));
}
/** May this person report on (and clear) the list? Managers and up always may. */
export const canReportList = (store, u, list) => canManageSchedule(u) || (!!list?.reporters && ruleMatches(store, u, list.reporters));
/** May this person see the list? Everyone unless an admin limited it; managers and its reporters always. */
export const canSeeList = (store, u, list) => !!list && (canManageSchedule(u) || !list.viewers || ruleMatches(store, u, list.viewers) || canReportList(store, u, list));

/** A photo document, if the caller may see it: it's on an item (on a list or in the history) of a list they can see. */
export function eightySixPhotoFor(store, actor, id) {
  const p = id ? store.get('eightySixPhotos', id) : null;
  if (!p || !actor) return null;
  const u = store.get('users', actor.id) || actor;
  if (!canSeeList(store, u, store.get('eightySixLists', p.listId))) return null;
  const owner = store.get('eightySixItems', p.itemId) || store.get('eightySixLog', p.itemId);
  return owner && (owner.photos || []).some((x) => x.id === p.id) ? p : null;
}

/** Departments the restaurant uses: Settings, then the job codes'. */
function departmentsOf(store, st) {
  return uniq([...(st.departments || []), ...store.list('jobCodes').filter((j) => !j.archived).map((j) => j.department)].map((d) => text(d, 60)));
}

/**
 * The two lists a restaurant starts with. Bar: the bar department (and any Bartender or Barback position elsewhere)
 * reports what the bar runs out of. Kitchen: every other department reports the rest. Managers report on both anyway;
 * everyone sees both. Neither suggests menu items: the 86 List is for ingredients and supplies.
 */
export function defaultLists(store, st, at = new Date().toISOString()) {
  const depts = departmentsOf(store, st);
  const bar = depts.filter((d) => BAR_DEPT.test(d));
  const barJobs = store.list('jobCodes').filter((j) => !j.archived && BAR_JOB.test(j.name) && !bar.some((d) => same(d, j.department))).map((j) => j.id);
  const base = { area: '', menu: 'none', sections: [], viewers: { all: true }, notify: true, notifyLow: false, resetAt: '', createdAt: at, updatedAt: at };
  return [
    { ...base, id: 'e86_bar', name: 'Bar', nameEs: 'Bar', kind: 'bar', reporters: { departments: bar, jobCodeIds: barJobs }, order: 0 },
    { ...base, id: 'e86_kitchen', name: 'Kitchen', nameEs: 'Cocina', kind: 'kitchen', reporters: { departments: depts.filter((d) => !BAR_DEPT.test(d)), jobCodeIds: [] }, order: 1 },
  ];
}

/**
 * Once per restaurant: lists from before the 86 List was about ingredients and supplies stop suggesting menu items.
 * The marker in `migrations` keeps what each list had, so an admin can see it (and turn it back on in Settings).
 * Returns how many lists changed, or null when it ran before.
 */
export function migrateMenuNone(store, at = new Date().toISOString()) {
  if (store.get('migrations', MENU_NONE_MIGRATION)) return null;
  const changed = [];
  for (const l of store.list('eightySixLists')) {
    if (!suggestsMenu(l)) continue;
    changed.push({ id: l.id, menu: l.menu, sections: l.sections || [] });
    store.update('eightySixLists', l.id, { menu: 'none', sections: [], updatedAt: at });
  }
  store.insert('migrations', { id: MENU_NONE_MIGRATION, at, lists: changed });
  return changed.length;
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
  const canReport = (u, list) => canReportList(store, u, list);
  const canSee = (u, list) => canSeeList(store, u, list);
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
  /** Before anything else: make the default lists if there are none, migrate old lists once, and run any reset that's due. */
  function ready() {
    let all = lists();
    if (!all.length) {
      for (const l of defaultLists(store, settings(), nowIso())) store.insert('eightySixLists', l);
      all = lists();
    }
    if (migrateMenuNone(store, nowIso())) all = lists();
    for (const list of all) {
      const at = lastReset(list);
      if (!at) continue;
      const iso = at.toISOString();
      for (const it of store.list('eightySixItems', (x) => x.listId === list.id && (x.updatedAt || x.reportedAt) < iso)) {
        archive(it, list, { clearedAt: iso, clearedBy: null, clearedHow: 'reset' });
      }
    }
    // Photos stay with the history for KEEP_PHOTOS_DAYS after the item came off the list, then go.
    const cutoff = new Date(now().getTime() - KEEP_PHOTOS_DAYS * 86400000).toISOString();
    for (const old of store.list('eightySixLog', (x) => x.photos?.length > 0 && !!x.clearedAt && x.clearedAt < cutoff)) {
      for (const ph of old.photos) store.remove('eightySixPhotos', ph.id);
      store.update('eightySixLog', old.id, { photos: [], photosRemovedAt: nowIso() });
    }
    return all;
  }

  // ---------- menu suggestions (only for lists an admin set to suggest menu items) ----------
  const menuItems = () => store.list('menuItems').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  /** The Training menu items a list suggests: its sections, else drinks, food, all or none (the default). Not ones taken off the menu. */
  function suggestions(list, menu = menuItems()) {
    if (!suggestsMenu(list)) return [];
    const on = menu.filter((i) => !i.eightySixed);
    if (list.sections?.length) return on.filter((i) => list.sections.some((c) => same(c, i.category)));
    if (list.menu === 'all') return on;
    return on.filter((i) => (list.menu === 'drinks' ? isDrink(i) : !isDrink(i)));
  }
  /** The menu item a typed name means (its English or Spanish name), if any. */
  const menuMatch = (name, menu = menuItems()) => menu.find((m) => same(m.name, name) || same(m.es?.name, name)) || null;

  // ---------- categories, and what was reported before ----------
  const categories = () => categoriesOf(store);
  const cleanCategory = (v, cats = categories()) => { const id = text(v, 40); return cats.some((c) => c.id === id) ? id : ''; };
  const remembered = (name) => store.get('eightySixNames', nameKey(name));
  function remember(name, category) {
    const id = nameKey(name);
    if (id === 'n:') return;
    const cur = store.get('eightySixNames', id);
    if (cur && cur.category === category && cur.name === name) return;
    const doc = { name, category, updatedAt: nowIso() };
    if (cur) store.update('eightySixNames', id, doc); else store.insert('eightySixNames', { id, ...doc });
  }
  /**
   * Past reports on each list (on it now or in the history), most frequent first, then the latest: the report form
   * offers them so "limes" is one tap. One pass over the log for every list. { listId: [{ name, times, category }] }
   */
  function pastReports(listIds) {
    const want = new Set(listIds);
    const per = new Map();
    for (const col of ['eightySixLog', 'eightySixItems']) {
      for (const r of store.list(col, (x) => want.has(x.listId))) {
        const k = nameKey(r.name);
        if (k === 'n:') continue;
        const m = per.get(r.listId) || new Map();
        const at = r.updatedAt || r.reportedAt || '';
        const g = m.get(k) || { name: r.name, times: 0, at: '', category: '' };
        g.times++;
        if (at >= g.at) { g.at = at; g.name = r.name; g.category = r.category || g.category; }
        m.set(k, g);
        per.set(r.listId, m);
      }
    }
    const out = {};
    for (const id of listIds) {
      out[id] = [...(per.get(id)?.values() || [])]
        .sort((a, b) => b.times - a.times || b.at.localeCompare(a.at))
        .slice(0, SUGGESTIONS)
        .map((g) => ({ name: g.name, times: g.times, category: remembered(g.name)?.category ?? g.category ?? '' }));
    }
    return out;
  }

  // ---------- views ----------
  /** An item as `viewer` sees it; each photo says whether they may remove it (who added it, who reported the item, managers). */
  function itemView(it, menu, viewer) {
    const m = it.menuItemId ? menu?.find((x) => x.id === it.menuItemId) || store.get('menuItems', it.menuItemId) : null;
    return {
      id: it.id, listId: it.listId, name: it.name, nameEs: m?.es?.name || '', menuItemId: it.menuItemId || null,
      status: it.status, count: it.count ?? null, note: it.note || '', area: it.area || '', category: it.category || '',
      reportedBy: { id: it.reportedBy, name: nameOf(it.reportedBy) }, reportedAt: it.reportedAt, outAt: it.outAt || null, lowAt: it.lowAt || null,
      updatedBy: { id: it.updatedBy || it.reportedBy, name: nameOf(it.updatedBy || it.reportedBy) }, updatedAt: it.updatedAt || it.reportedAt,
      photos: (it.photos || []).map((ph) => ({ id: ph.id, w: ph.w || 0, h: ph.h || 0, canRemove: !!viewer && (isMgr(viewer) || ph.by === viewer.id || it.reportedBy === viewer.id) })),
    };
  }
  /** The item (on a list, or in the history) a person may see, or 404. */
  function visibleItem(u, id, { history = false } = {}) {
    const it = id ? store.get('eightySixItems', id) || (history ? store.get('eightySixLog', id) : null) : null;
    const list = it ? store.get('eightySixLists', it.listId) : null;
    if (!it || !list || !canSee(u, list)) fail(404, 'That item isn’t on the list anymore');
    return { it, list, active: !!store.get('eightySixItems', it.id) };
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
  /** The tags for an item or a list: the restaurant's areas (settings.areas), or its rooms when it has none. */
  const areas = () => { const st = settings(); const own = uniqueAreas(st.areas || []); return own.length ? own : scheduleAreas(st); };
  const cleanItemArea = (v) => (text(v, 60) ? findArea(cleanArea(v), areas()) || '' : '');
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
      menu: MENU_MODES.includes(a.menu) ? a.menu : cur?.menu || 'none',
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
    // Every list the person may see with what's on it, and what they may do. For the lists they report on: what was
    // reported there before (most often first), the menu items it suggests (only when an admin turned that on), the
    // categories, and the category each item name was last filed under.
    'eightySix.board.get': (actor) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const menu = menuItems();
      const items = store.list('eightySixItems');
      const seen = lists().filter((l) => canSee(u, l));
      const past = pastReports(seen.filter((l) => canReport(u, l)).map((l) => l.id));
      const out = seen.map((l) => ({
        ...listView(l), canReport: canReport(u, l),
        suggest: suggestions(l, menu).map((i) => i.id),
        recent: past[l.id] || [],
        items: items.filter((i) => i.listId === l.id).sort(byUrgency).map((i) => itemView(i, menu, u)),
      }));
      const wanted = new Set(out.flatMap((l) => l.suggest));
      const reporter = out.some((l) => l.canReport);
      return {
        lists: out,
        menu: Object.fromEntries(menu.filter((i) => wanted.has(i.id)).map((i) => [i.id, { name: i.name, nameEs: i.es?.name || '', category: i.category || '' }])),
        categories: categories().map(({ id, name, nameEs }) => ({ id, name, nameEs })),
        known: reporter ? store.list('eightySixNames', (x) => !!x.category).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, KNOWN_NAMES).map((x) => ({ name: x.name, category: x.category })) : [],
        areas: areas(),
        canReport: reporter,
        isMgr: isMgr(u),
        now: nowIso(),
      };
    },
    // Counts per list for the banners on the Schedule and My Shifts, and the menu items 86'd today (Training's badge:
    // items linked to a menu item, and on lists that suggest menu items, a typed name that is one).
    'eightySix.summary': (actor) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const menu = menuItems();
      const items = store.list('eightySixItems');
      const mine = lists().filter((l) => canSee(u, l));
      const seen = new Set(mine.map((l) => l.id));
      const menuLists = new Set(mine.filter(suggestsMenu).map((l) => l.id));
      const visible = items.filter((i) => seen.has(i.listId));
      const ids = (status) => [...new Set(visible.filter((i) => i.status === status)
        .map((i) => i.menuItemId || (menuLists.has(i.listId) ? menuMatch(i.name, menu)?.id : null)).filter(Boolean))];
      return {
        lists: mine.map((l) => ({ ...listView(l), out: visible.filter((i) => i.listId === l.id && i.status === 'out').length, low: visible.filter((i) => i.listId === l.id && i.status === 'low').length })),
        out: visible.filter((i) => i.status === 'out').length,
        low: visible.filter((i) => i.status === 'low').length,
        outMenuItemIds: ids('out'),
        lowMenuItemIds: ids('low'),
      };
    },
    // Report something 86'd (out) or running low. The same thing again on the same list updates it.
    // category: optional; left out (the phone app), the item keeps its own or the one its name was last filed under.
    'eightySix.report': (actor, a = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const list = visibleList(u, a.listId);
      if (!canReport(u, list)) fail(403, 'You can’t report on this list');
      const menu = menuItems();
      const onList = (k) => store.list('eightySixItems', (x) => x.listId === list.id && x.key === k)[0] || null;
      const typed = text(a.name, 80);
      // Menu items only on a list set to suggest them, or to update an item linked to one before (Training's badge).
      const picked = a.menuItemId ? menu.find((m) => m.id === a.menuItemId) || null : null;
      const match = !picked && typed ? menuMatch(typed, menu) : null;
      const linkable = (m) => !!m && (suggestsMenu(list) || !!onList(itemKey(m.id)));
      const linked = linkable(picked) ? picked : linkable(match) ? match : null;
      // A product from the catalog (Stock lists' products, core/products.js): its name, unless something was typed.
      const product = !linked && a.productId ? store.get('products', String(a.productId)) : null;
      const name = linked ? linked.name : typed || (picked ? picked.name : product?.name || '');
      if (!name) fail(400, 'Say what’s out');
      const k = itemKey(linked?.id, name);
      const cur = onList(k);
      const status = a.status === 'low' ? 'low' : 'out';
      const count = status === 'out' ? null : cleanCount(a.count);
      const shown = linked ? linked.name : cur?.name || name; // a menu item keeps the menu's name; typed text its first spelling
      const category = 'category' in a ? cleanCategory(a.category) : cur?.category || remembered(shown)?.category || '';
      const at = nowIso();
      // The catalog's product (found by name, or added for a manager to review): the same thing in Stock lists. Not for a dish.
      const productId = linked ? null : productFor86(store, { productId: product?.id || cur?.productId || null, name: shown, category86: category, list, by: u.id, at })?.id || null;
      const doc = { name: shown, menuItemId: linked?.id || null, status, count, note: text(a.note, 140), area: cleanItemArea(a.area), category, ...(productId ? { productId } : {}) };
      const nowOut = status === 'out' && cur?.status !== 'out';
      const nowLow = status === 'low' && cur?.status !== 'low';
      const saved = cur
        ? store.update('eightySixItems', cur.id, { ...doc, updatedBy: u.id, updatedAt: at, ...(nowOut ? { outAt: at } : {}), ...(nowLow ? { lowAt: at } : {}) })
        : store.insert('eightySixItems', { id: uid('e86'), listId: list.id, key: k, ...doc, reportedBy: u.id, reportedAt: at,
          outAt: status === 'out' ? at : null, lowAt: status === 'low' ? at : null, updatedBy: u.id, updatedAt: at });
      if ('category' in a) remember(shown, category);
      const announce = list.notify !== false && (nowOut || (status === 'low' && !cur && !!list.notifyLow));
      return { item: itemView(saved, menu, u), updated: !!cur, notified: announce ? tell(list, saved, u) : 0 };
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
      return { item: itemView(store.insert('eightySixItems', item), null, u) };
    },

    // ----- photos: up to 3 per report, optional (the empty bottle, the low shelf) -----
    // One photo per request (the app shrinks it first); the same checks as Training's menu photos.
    'eightySix.addPhoto': (actor, { itemId, dataUrl, w, h } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const { it, list, active } = visibleItem(u, itemId);
      if (!active) fail(404, 'That item isn’t on the list anymore');
      if (!canReport(u, list)) fail(403, 'You can’t report on this list');
      if ((it.photos || []).length >= PHOTOS_PER_ITEM) fail(400, 'A report can have up to 3 photos');
      const { mime, data, bytes } = checkPhoto(dataUrl, fail);
      const dim = (v) => Math.max(0, Math.min(10000, Math.round(Number(v) || 0)));
      const photo = { id: uid('e86p'), w: dim(w), h: dim(h), by: u.id, at: nowIso() };
      store.insert('eightySixPhotos', { ...photo, itemId: it.id, listId: list.id, mime, data, bytes });
      const saved = store.update('eightySixItems', it.id, { photos: [...(it.photos || []), photo] });
      return { photo: { id: photo.id, w: photo.w, h: photo.h, canRemove: true }, item: itemView(saved, null, u) };
    },
    // Who added it, who reported the item, or a manager. Also from the history.
    'eightySix.removePhoto': (actor, { itemId, photoId } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const { it, active } = visibleItem(u, itemId, { history: true });
      const ph = (it.photos || []).find((x) => x.id === photoId);
      if (!ph) fail(404, 'Photo not found');
      if (!isMgr(u) && ph.by !== u.id && it.reportedBy !== u.id) fail(403, 'Only the person who reported it or a manager can remove a photo');
      store.remove('eightySixPhotos', ph.id);
      const saved = store.update(active ? 'eightySixItems' : 'eightySixLog', it.id, { photos: it.photos.filter((x) => x.id !== ph.id) });
      return { item: itemView(saved, null, u) };
    },
    // The photo itself as a data URL, for the demo (on a server the bytes aren't cached: /api/eighty-six/photos/:id serves them).
    'eightySix.photo.get': (actor, { id } = {}) => {
      needAuth(actor);
      const p = eightySixPhotoFor(store, actor, id);
      if (!p?.data) fail(404, 'Photo not found');
      return { id: p.id, dataUrl: `data:${p.mime};base64,${p.data}` };
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
      const u = fresh(actor);
      const entries = rows.slice(0, 300).map((r) => ({
        ...itemView(r, menu, u), listName: byId[r.listId]?.name || r.listName || '', listNameEs: byId[r.listId]?.nameEs || '',
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
        categories: categories(),
        options: {
          departments: departmentsOf(store, settings()),
          jobCodes: jobs.map((j) => ({ id: j.id, name: j.name, department: j.department || '' })),
          areas: areas(),
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
    // The categories items can be filed under, in order: rename the built-in ones (in either language) or add more.
    // A removed category's items show under Other. 'other' always stays (last, unless it's placed elsewhere).
    'eightySix.saveCategories': (actor, { categories: list } = {}) => {
      needAdmin(actor);
      if (!Array.isArray(list)) fail(400, 'Send the categories');
      const seen = new Set();
      const out = [];
      for (const c of list.slice(0, MAX_CATEGORIES)) {
        const b = BUILT_IN[c?.id];
        const name = text(c?.name, 40);
        const nameEs = text(c?.nameEs, 40);
        if (!b && !name) fail(400, 'Every category needs a name');
        const id = b || (c?.id && /^e86c_[a-z0-9]+$/.test(c.id)) ? c.id : uid('e86c');
        if (seen.has(id)) continue;
        seen.add(id);
        // A built-in name left as it is keeps following the translation.
        out.push({ id, name: b && (!name || same(name, b.en)) ? '' : name, nameEs: b && (!nameEs || same(nameEs, b.es)) ? '' : nameEs });
      }
      if (!seen.has('other')) out.push({ id: 'other', name: '', nameEs: '' });
      const doc = { list: out, updatedAt: nowIso() };
      if (store.get('eightySixConfig', 'categories')) store.update('eightySixConfig', 'categories', doc); else store.insert('eightySixConfig', { id: 'categories', ...doc });
      return { categories: categories() };
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
  // Reports → 86 List (managers): what's missing now, the history and the trends (core/reports-86.js).
  Object.assign(api, eightySixReportsApi({ store, now, settings, fail, ready, lists, categories, itemView, menuItems, nameOf, remembered }));
  return api;
}

/**
 * SAMPLE 86 List for the demo: the Bar, Moon Rabbit bar and Kitchen lists, plus a Storeroom list only managers see.
 * A few supplies out or low now, and about fourteen months of history (two Winters and two Summers, so the 86 List
 * report has seasons to compare): limes and mint run out in summer, short rib and heavy cream in winter, and
 * everything runs out more on Fridays and Saturdays. Invented supplies, demo people only, the same every time.
 */
export function seedEightySix(store, { userId, now = new Date() }) {
  const st = store.get('settings', 'settings') || {};
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60000).toISOString();
  const [bar, kitchen] = defaultLists(store, st, at(60 * 24 * 450));
  store.insert('eightySixLists', bar);
  store.insert('eightySixLists', { ...kitchen, order: 2 });
  const cocktail = store.list('jobCodes', (j) => /cocktail/i.test(j.name)).map((j) => j.id);
  store.insert('eightySixLists', {
    ...bar, id: 'e86_moon', name: 'Moon Rabbit bar', nameEs: 'Bar del Moon Rabbit', area: 'Moon Rabbit', order: 1,
    reporters: { departments: bar.reporters.departments, jobCodeIds: [...bar.reporters.jobCodeIds, ...cocktail] },
  });
  store.insert('eightySixLists', {
    ...kitchen, id: 'e86_store', name: 'Storeroom', nameEs: 'Bodega', kind: 'other', order: 3,
    reporters: { departments: ['Leadership'], jobCodeIds: [] }, viewers: { departments: ['Leadership'], jobCodeIds: [] },
  });
  store.insert('migrations', { id: MENU_NONE_MIGRATION, at: at(60 * 24 * 450), lists: [] });

  // [list, name, category, times a Summer, times a Winter, who reports]
  const BAR = ['Mak', 'Yair', 'Dante', 'Karen', 'Torie', 'Arthur', 'Luciano'];
  const MOON = ['Romina', 'Dante', 'Ciaran', 'Agustina'];
  const KITCHEN = ['Chef Lucas', 'Kelly', 'Ben', 'Courtney'];
  const SUPPLIES = [
    ['e86_bar', 'Limes', 'produce', 14, 6, BAR], ['e86_bar', 'Mint', 'produce', 6, 1, BAR], ['e86_bar', 'Lemons', 'produce', 4, 3, BAR],
    ['e86_bar', 'Ginger beer', 'dry', 5, 3, BAR], ['e86_bar', 'Bacardi', 'liquor', 5, 3, BAR], ['e86_bar', 'Tito’s', 'liquor', 3, 3, BAR],
    ['e86_bar', 'Buffalo Trace', 'liquor', 2, 4, BAR], ['e86_bar', 'Prosecco', 'liquor', 4, 2, BAR], ['e86_bar', 'Oat milk', 'dairy', 3, 4, BAR],
    ['e86_bar', 'CO2', 'other', 3, 3, BAR], ['e86_bar', 'Rocks glasses', 'glassware', 3, 2, BAR], ['e86_bar', 'Coupe glasses', 'glassware', 2, 2, BAR],
    ['e86_bar', 'Cocktail napkins', 'paper', 4, 3, BAR], ['e86_bar', 'Straws', 'paper', 2, 1, BAR],
    ['e86_moon', 'Rosé', 'liquor', 6, 1, MOON], ['e86_moon', 'Aperol', 'liquor', 4, 1, MOON], ['e86_moon', 'Champagne flutes', 'glassware', 2, 2, MOON],
    ['e86_moon', 'Oranges', 'produce', 2, 2, MOON], ['e86_moon', 'Mezcal', 'liquor', 2, 2, MOON], ['e86_moon', 'Ice', 'other', 3, 0, MOON],
    ['e86_kitchen', 'Fryer oil', 'dry', 3, 3, KITCHEN], ['e86_kitchen', 'Flour', 'dry', 2, 2, KITCHEN], ['e86_kitchen', 'Brioche buns', 'dry', 3, 2, KITCHEN],
    ['e86_kitchen', 'Burrata', 'dairy', 3, 1, KITCHEN], ['e86_kitchen', 'Heavy cream', 'dairy', 1, 4, KITCHEN], ['e86_kitchen', 'Eggs', 'dairy', 2, 2, KITCHEN],
    ['e86_kitchen', 'Salmon', 'proteins', 2, 2, KITCHEN], ['e86_kitchen', 'Short rib', 'proteins', 1, 4, KITCHEN], ['e86_kitchen', 'Tomatoes', 'produce', 3, 1, KITCHEN],
    ['e86_kitchen', 'Peaches', 'produce', 3, 0, KITCHEN], ['e86_kitchen', 'Avocados', 'produce', 3, 3, KITCHEN], ['e86_kitchen', 'Napkins', 'paper', 3, 2, KITCHEN],
    ['e86_kitchen', 'To-go containers', 'paper', 3, 2, KITCHEN], ['e86_kitchen', 'To-go cups', 'paper', 2, 1, KITCHEN], ['e86_kitchen', 'Nitrile gloves', 'paper', 1, 1, KITCHEN],
    ['e86_kitchen', 'Sanitizer', 'cleaning', 2, 2, KITCHEN], ['e86_kitchen', 'Dish soap', 'cleaning', 1, 1, KITCHEN],
    ['e86_store', 'Receipt paper', 'paper', 2, 2, ['Kelly', 'Ben']], ['e86_store', 'Trash bags', 'cleaning', 1, 1, ['Kelly', 'Ben']],
    ['e86_store', 'Hand soap', 'cleaning', 1, 1, ['Kelly', 'Courtney']], ['e86_store', 'Toilet paper', 'paper', 1, 2, ['Ben', 'Courtney']],
  ];
  const NOTES = ['Ordered', 'On the Sysco truck Tuesday', 'Delivery came short', 'Borrowed some from the other bar', 'Costco run tomorrow', 'Vendor is out too'];
  const CLEARERS = ['Kelly', 'Ben', 'Chef Lucas', 'Courtney'];
  let seed = 86;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const who = (name) => userId[name] || userId.Kelly;
  const listNameOf = (id) => store.get('eightySixLists', id)?.name || '';
  for (const [, name, category] of SUPPLIES) {
    if (!store.get('eightySixNames', nameKey(name))) store.insert('eightySixNames', { id: nameKey(name), name, category, updatedAt: at(60 * 24 * 450) });
  }

  // On the lists now: what's missing tonight.
  const item = (listId, name, status, by, minutesAgo, extra = {}) => ({
    id: uid('e86'), listId, name, key: itemKey(null, name), menuItemId: null, status, count: null, note: '', area: '',
    category: SUPPLIES.find((x) => x[1] === name)?.[2] || '',
    reportedBy: who(by), reportedAt: at(minutesAgo), outAt: status === 'out' ? at(minutesAgo) : null, lowAt: status === 'low' ? at(minutesAgo) : null,
    updatedBy: who(by), updatedAt: at(minutesAgo), ...extra,
  });
  const nowItems = [
    item('e86_bar', 'Limes', 'out', 'Mak', 35, { note: 'Produce comes tomorrow morning', area: 'Rabbit Hole' }),
    item('e86_bar', 'CO2', 'low', 'Karen', 130, { count: 1 }),
    item('e86_bar', 'Rocks glasses', 'low', 'Yair', 75, { count: 6, note: 'Dish machine is backed up' }),
    item('e86_bar', 'Oat milk', 'low', 'Torie', 300, { count: 2 }),
    item('e86_moon', 'Rosé', 'low', 'Dante', 70, { count: 3, note: 'Offer the Garden Spritz' }),
    item('e86_moon', 'Aperol', 'out', 'Romina', 160),
    item('e86_kitchen', 'To-go cups', 'out', 'Kelly', 50, { note: 'Using the 12 oz for now' }),
    item('e86_kitchen', 'Fryer oil', 'low', 'Chef Lucas', 240, { count: 1 }),
    item('e86_kitchen', 'Napkins', 'low', 'Ben', 95, { count: 2, note: 'Two sleeves left' }),
    item('e86_store', 'Receipt paper', 'low', 'Kelly', 60 * 26, { count: 3 }),
  ];
  for (const it of nowItems) store.insert('eightySixItems', it);
  const busyUntil = new Map(); // one time on a list at once: the next report of the same thing starts after it came back
  const onNow = new Map(nowItems.map((it) => [`${it.listId}|${it.name}`, Date.parse(it.reportedAt)]));

  // History: day by day back about fourteen months, busier on weekends; closed Mondays (like the demo schedule).
  const DOW = [1, 0, 0.7, 0.8, 1, 1.7, 1.8];
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let back = 430; back >= 1; back--) {
    const d = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() - back);
    const summer = d.getMonth() >= 4 && d.getMonth() <= 9;
    for (const [listId, name, category, sumTimes, winTimes, people] of SUPPLIES) {
      const p = ((summer ? sumTimes : winTimes) / 182) * DOW[d.getDay()] * 1.05;
      if (rand() >= p) continue;
      const k = `${listId}|${name}`;
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15 + Math.floor(rand() * 7), Math.floor(rand() * 60));
      if ((busyUntil.get(k) || 0) > start.getTime()) continue;
      const lowFirst = rand() < 0.45;
      const goesOut = !lowFirst || rand() < 0.3;
      const lowFor = lowFirst ? (2 + rand() * 20) * 60 : 0; // minutes low before it ran out (or came back)
      const outFor = goesOut ? (1 + rand() * 30) * 60 : 0; // minutes out before it came back
      const outAt = goesOut ? new Date(start.getTime() + lowFor * 60000) : null;
      const clearedAt = new Date(start.getTime() + (lowFor + outFor + (goesOut ? 0 : 60)) * 60000);
      if (clearedAt.getTime() >= (onNow.get(k) ?? now.getTime())) continue; // back before tonight's report of it
      busyUntil.set(k, clearedAt.getTime());
      const by = who(pick(people));
      store.insert('eightySixLog', {
        id: uid('e86'), listId, name, key: itemKey(null, name), menuItemId: null, status: goesOut ? 'out' : 'low',
        count: goesOut ? null : 1 + Math.floor(rand() * 4), note: rand() < 0.18 ? pick(NOTES) : '', area: '', category,
        reportedBy: by, reportedAt: start.toISOString(), outAt: outAt ? outAt.toISOString() : null, lowAt: lowFirst ? start.toISOString() : null,
        updatedBy: by, updatedAt: (outAt || start).toISOString(),
        listName: listNameOf(listId), clearedAt: clearedAt.toISOString(), clearedBy: who(rand() < 0.5 ? pick(people) : pick(CLEARERS)), clearedHow: 'back',
      });
    }
  }
}
