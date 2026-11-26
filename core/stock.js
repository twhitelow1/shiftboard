// Stock lists: a manager (by default supervisors and up) makes a list of products to bring up or restock ("Friday bar
// restock", "Patio open"), assigns it to a person, a position on a date (every Barback on Friday) or whoever is on
// shift in a room that day, with a due time, and the person works it on their phone: each line with its photo, how
// many, where it's kept, and Got it / Short (how many they brought) / Out. "Out" reports it to the 86 List in one tap
// (the right list, marked out); "Short" offers to report it running low. The manager sees progress as it happens and
// is told when it's done or something's out. Lists can be saved as templates ("Nightly bar restock") and reassigned;
// done lists keep their history (who did what, when, the shorts and outs).
//
// The products come from the catalog (core/products.js), shared with the 86 List. Anyone signed in adds a product on
// the fly (a name and maybe a photo): it's usable at once, marked "Added by <name>", and waits in the managers' "New
// products" queue (approve, edit, merge into another, archive). Managers keep the catalog in Stock → Products.
//
// Plan feature `stock` (every plan). Role features (core/role-features.js):
//   stock        work the lists assigned to you, add products (everyone)
//   stockManage  create, assign and template lists (supervisors and up by default); with manager and up: the catalog
//   stockOwnLists  employees: make a list for themselves (off by default)
//
// Collections
//   stockLists  { id, kind: 'list' | 'template', name, notes, lines: [line], date ('' or YYYY-MM-DD), due ('' or HH:MM),
//                 assign: null | { type: 'person', userId } | { type: 'position', jobCodeId } | { type: 'room', room },
//                 personal (an employee's own list), templateId, eightySixListId, status: 'open' | 'in_progress' | 'done',
//                 createdBy, createdAt, updatedAt, assignedBy, assignedAt, startedAt, doneAt, doneBy, toldDone,
//                 log: [{ at, by, what, lineId?, state?, brought?, to? }] }
//   line        { id, productId, qty, note, state: null | 'got' | 'short' | 'out', brought, by, at,
//                 reported86: null | { itemId, listId, status, at } }
import { uid } from './store.js';
import { atLeast, roleOf } from './roles.js';
import { roleAllows } from './role-features.js';
import { todayStr, fmtTime } from './time.js';
import { scheduleAreas, uniqueAreas, sameArea } from './areas.js';
import { checkPhoto } from './training.js';
import { canReportList, canSeeList } from './eighty-six.js';
import {
  productCategories, DEFAULT_CATEGORIES, UNITS, unitName, matchesFor, newProduct, productKey, cleanUnit, ensureCatalog,
  PHOTOS_PER_PRODUCT, MAX_CATEGORIES,
} from './products.js';

export const STATES = ['got', 'short', 'out'];
export const MAX_LINES = 150;
const HISTORY_DAYS = 30;
const BAR_CATEGORIES = new Set(['spirits', 'beer', 'wine', 'mixers', 'garnish', 'glassware']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Notifications, in each language. List and product names are the restaurant's and stay as typed. */
export const TEXT = {
  en: {
    assigned: (name, due) => `New stock list for you: ${name}${due ? ` (due ${due})` : ''}`,
    done: (name, who, short, out) => `${name} is done (${who})${short || out ? `: ${[short && `${short} short`, out && `${out} out`].filter(Boolean).join(', ')}` : ', everything brought'}`,
    out: (name, product, who) => `${name}: ${who} says we’re out of ${product}`,
  },
  es: {
    assigned: (name, due) => `Tienes una nueva lista de surtido: ${name}${due ? ` (para las ${due})` : ''}`,
    done: (name, who, short, out) => `${name} está lista (${who})${short || out ? `: ${[short && `${short} incompleto${short === 1 ? '' : 's'}`, out && `${out} sin existencia`].filter(Boolean).join(', ')}` : ', se trajo todo'}`,
    out: (name, product, who) => `${name}: ${who} dice que no hay ${product}`,
  },
};

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fold = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** May this person create, assign and template lists? (role feature stockManage; Super Admins always) */
export const canManageLists = (u, settings) => !!u && (roleOf(u) === 'super_admin' || roleAllows(u, settings).stockManage === true);
/** May this person edit, merge and archive products? Managers and up whose role has stockManage. */
export const canManageCatalog = (u, settings) => !!u && atLeast(u, 'manager') && canManageLists(u, settings);
/** May an employee make a list for themselves? */
export const canOwnLists = (u, settings) => canManageLists(u, settings) || (!!u && roleOf(u) === 'employee' && roleAllows(u, settings).stockOwnLists === true);

/** A product photo document, if the caller may see it (anyone signed in: the catalog is the whole team's). */
export function productPhotoFor(store, actor, id) {
  const p = id && actor ? store.get('productPhotos', id) : null;
  if (!p) return null;
  const prod = store.get('products', p.productId);
  return prod && (prod.photos || []).some((x) => x.id === p.id) ? p : null;
}

export function stockApi({ store, now, settings, notify, fail, api, planHas = () => true, langOf }) {
  const nowIso = () => now().toISOString();
  const today = () => todayStr(now());
  const needAuth = (a) => { if (!a) fail(401, 'Please sign in'); };
  const fresh = (a) => store.get('users', a.id) || a;
  const nameOf = (id) => (id ? store.get('users', id)?.name || '' : '');
  const lists = () => store.list('stockLists');
  const needLists = (a) => { needAuth(a); if (!canManageLists(fresh(a), settings())) fail(403, 'Supervisors and managers only'); };
  const needCatalog = (a) => { needAuth(a); if (!canManageCatalog(fresh(a), settings())) fail(403, 'Managers only'); };
  const areas = () => { const st = settings(); const own = uniqueAreas(st.areas || []); return own.length ? own : scheduleAreas(st); };
  const ready = () => ensureCatalog(store, nowIso());

  // ---------- products ----------
  const cats = () => productCategories(store);
  const cleanCategory = (v) => { const id = text(v, 40); return cats().some((c) => c.id === id) ? id : 'other'; };
  function cleanPars(v) {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    const known = areas();
    for (const [k, n] of Object.entries(v)) {
      const area = k === '' ? '' : known.find((a) => sameArea(a, k));
      const num = Number(n);
      if (area === undefined || n === '' || n == null) continue;
      if (!Number.isFinite(num) || num < 0 || num > 9999) fail(400, 'A par level is a number from 0 to 9999');
      out[area] = Math.round(num * 100) / 100;
    }
    return out;
  }
  function productView(p, viewer, { mgr = canManageCatalog(viewer, settings()) } = {}) {
    if (!p) return null;
    return {
      id: p.id, name: p.name, category: p.category || 'other', unit: p.unit || '', size: p.size || '', pars: p.pars || {}, location: p.location || '',
      supplier: p.supplier || '', notes: p.notes || '', status: p.status || 'active', review: p.review || 'ok', source: p.source || 'app',
      eightySixListId: p.eightySixListId || null, addedBy: p.addedBy ? { id: p.addedBy, name: nameOf(p.addedBy) } : null, addedAt: p.addedAt || null,
      updatedAt: p.updatedAt || null, mergedInto: p.mergedInto || null,
      photos: (p.photos || []).map((ph) => ({ id: ph.id, w: ph.w || 0, h: ph.h || 0, canRemove: !!viewer && (mgr || ph.by === viewer.id) })),
      canEdit: mgr || (!!viewer && p.addedBy === viewer.id && p.review === 'new'),
    };
  }
  const activeProducts = () => store.list('products', (p) => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name));
  function visibleProduct(id) {
    const p = id ? store.get('products', String(id)) : null;
    if (!p) fail(404, 'Product not found');
    return p;
  }
  const matchView = (viewer) => (m) => ({ ...productView(m.product, viewer), score: m.score, confidence: m.confidence, reasons: m.reasons });
  function productFields(a, cur) {
    const name = text(a.name ?? cur?.name, 80);
    if (!name) fail(400, 'Give the product a name');
    return {
      name, key: productKey(name),
      category: 'category' in a ? cleanCategory(a.category) : cur?.category || 'other',
      unit: 'unit' in a ? cleanUnit(a.unit) : cur?.unit || '',
      size: 'size' in a ? text(a.size, 30) : cur?.size || '',
      pars: 'pars' in a ? cleanPars(a.pars) : cur?.pars || {},
      location: 'location' in a ? text(a.location, 80) : cur?.location || '',
      supplier: 'supplier' in a ? text(a.supplier, 80) : cur?.supplier || '',
      notes: 'notes' in a ? text(a.notes, 300) : cur?.notes || '',
      eightySixListId: 'eightySixListId' in a ? (store.get('eightySixLists', a.eightySixListId) ? a.eightySixListId : null) : cur?.eightySixListId || null,
    };
  }

  // ---------- who a list is for ----------
  const jobOf = (id) => (id ? store.get('jobCodes', id) : null);
  /** The people a list is assigned to, now. */
  function assignees(l) {
    const a = l.assign;
    if (!a) return l.personal ? [l.createdBy] : [];
    if (a.type === 'person') return a.userId ? [a.userId] : [];
    const day = l.date || today();
    const shifts = store.list('shifts', (s) => s.published && s.userId && s.date === day);
    const active = (id) => store.get('users', id)?.active !== false;
    if (a.type === 'position') {
      const on = [...new Set(shifts.filter((s) => s.jobCodeId === a.jobCodeId).map((s) => s.userId))].filter(active);
      if (on.length) return on;
      // Nobody scheduled in that position that day: everyone who works it.
      return store.list('users', (u) => u.active !== false && (u.jobCodes || []).some((j) => j.jobCodeId === a.jobCodeId)).map((u) => u.id);
    }
    if (a.type === 'room') return [...new Set(shifts.filter((s) => sameArea(s.area, a.room)).map((s) => s.userId))].filter(active);
    return [];
  }
  const assignedTo = (l, u) => assignees(l).includes(u.id);
  const canWork = (l, u) => l.kind === 'list' && (assignedTo(l, u) || l.createdBy === u.id || canManageLists(u, settings()));
  const canEditList = (l, u) => canManageLists(u, settings()) || (l.personal && l.createdBy === u.id);
  const canSee = (l, u) => (l.kind === 'template' ? canManageLists(u, settings()) : canWork(l, u));
  function visibleList(u, id) {
    const l = id ? store.get('stockLists', String(id)) : null;
    if (!l || !canSee(l, u)) fail(404, 'List not found');
    return l;
  }
  function cleanAssign(a, { personal, actor }) {
    if (personal) return null; // an employee's own list is theirs
    if (!a || typeof a !== 'object' || !a.type) return null;
    if (a.type === 'person') {
      const u = a.userId ? store.get('users', String(a.userId)) : null;
      if (!u || u.active === false) fail(400, 'Pick someone on the team');
      return { type: 'person', userId: u.id };
    }
    if (a.type === 'position') {
      const j = jobOf(a.jobCodeId);
      if (!j || j.archived) fail(400, 'Pick a position');
      return { type: 'position', jobCodeId: j.id };
    }
    if (a.type === 'room') {
      const room = areas().find((r) => sameArea(r, a.room)) || '';
      if (!room) fail(400, 'Pick a room');
      return { type: 'room', room };
    }
    if (a.type === 'me') return { type: 'person', userId: actor.id };
    fail(400, 'Pick who the list is for');
    return null;
  }
  const assignWords = (a) => {
    if (!a) return '';
    if (a.type === 'person') return nameOf(a.userId);
    if (a.type === 'position') return jobOf(a.jobCodeId)?.name || '';
    return a.room || '';
  };

  // ---------- the 86 List ----------
  /** The 86 list a product belongs on, for this person: its own, where it was reported before, the list's, by category. */
  function list86For(product, l, u) {
    if (!planHas('eightySix') || roleAllows(u, settings()).eightySix === false) return null;
    const all = store.list('eightySixLists').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const ok = (x) => x && canReportList(store, u, x) && canSeeList(store, u, x);
    const byId = (id) => all.find((x) => x.id === id);
    if (ok(byId(product?.eightySixListId))) return byId(product.eightySixListId);
    if (product) {
      const past = [...store.list('eightySixItems', (x) => x.productId === product.id), ...store.list('eightySixLog', (x) => x.productId === product.id)]
        .sort((a, b) => String(b.updatedAt || b.reportedAt).localeCompare(String(a.updatedAt || a.reportedAt)));
      for (const r of past) if (ok(byId(r.listId))) return byId(r.listId);
    }
    if (ok(byId(l?.eightySixListId))) return byId(l.eightySixListId);
    const bar = BAR_CATEGORIES.has(product?.category);
    return all.filter(ok).find((x) => (bar ? x.kind === 'bar' : x.kind !== 'bar')) || all.find(ok) || null;
  }

  // ---------- views ----------
  const counts = (l) => {
    const c = { lines: l.lines.length, done: 0, got: 0, short: 0, out: 0 };
    for (const x of l.lines) if (x.state) { c.done++; c[x.state]++; }
    return c;
  };
  function lineView(x, l, u, lang) {
    const p = store.get('products', x.productId);
    const e86 = x.state === 'out' || x.state === 'short' ? list86For(p, l, u) : null;
    return {
      id: x.id, productId: x.productId, name: p?.name || x.name || '', category: p?.category || 'other', unit: p?.unit || '', unitName: unitName(p?.unit, lang),
      size: p?.size || '', location: p?.location || '', photos: (p?.photos || []).map((ph) => ({ id: ph.id, w: ph.w || 0, h: ph.h || 0 })),
      review: p?.review || 'ok', qty: x.qty, note: x.note || '', state: x.state || null, brought: x.brought ?? null,
      by: x.by ? { id: x.by, name: nameOf(x.by) } : null, at: x.at || null,
      reported86: x.reported86 ? { ...x.reported86, listName: store.get('eightySixLists', x.reported86.listId)?.name || '' } : null,
      eightySix: e86 ? { id: e86.id, name: e86.name, nameEs: e86.nameEs || '' } : null,
    };
  }
  function summary(l, u) {
    const ids = l.kind === 'list' ? assignees(l) : [];
    return {
      id: l.id, kind: l.kind, name: l.name, notes: l.notes || '', date: l.date || '', due: l.due || '', status: l.status || 'open', personal: !!l.personal,
      assign: l.assign || null, assignLabel: assignWords(l.assign) || (l.personal ? nameOf(l.createdBy) : ''),
      assignees: ids.map((id) => ({ id, name: nameOf(id) })), mine: ids.includes(u.id),
      counts: counts(l), createdBy: { id: l.createdBy, name: nameOf(l.createdBy) }, createdAt: l.createdAt, updatedAt: l.updatedAt,
      startedAt: l.startedAt || null, doneAt: l.doneAt || null, doneBy: l.doneBy ? { id: l.doneBy, name: nameOf(l.doneBy) } : null,
      templateId: l.templateId || null, overdue: l.kind === 'list' && l.status !== 'done' && isLate(l),
    };
  }
  function isLate(l) {
    if (!l.date) return false;
    const d = today();
    if (l.date < d) return true;
    if (l.date > d || !l.due) return false;
    const n = now();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}` > l.due;
  }
  function fullView(l, u) {
    const lang = langOf(u);
    return {
      ...summary(l, u), eightySixListId: l.eightySixListId || null,
      lines: l.lines.map((x) => lineView(x, l, u, lang)),
      log: (l.log || []).slice(-200).map((e) => ({ ...e, byName: nameOf(e.by), product: e.lineId ? store.get('products', l.lines.find((x) => x.id === e.lineId)?.productId)?.name || '' : '' })),
      canWork: canWork(l, u) && l.kind === 'list', canEdit: canEditList(l, u), canManage: canManageLists(u, settings()),
    };
  }

  // ---------- lines ----------
  function cleanLines(raw, cur = []) {
    if (!Array.isArray(raw)) return cur;
    if (raw.length > MAX_LINES) fail(400, 'A list can have up to 150 products');
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      const p = r?.productId ? store.get('products', String(r.productId)) : null;
      if (!p || p.status === 'archived') fail(400, 'Pick products from the catalog');
      const qty = Number(r.qty ?? 1);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) fail(400, 'How many is a number from 1 to 9999');
      const old = r.id ? cur.find((x) => x.id === r.id) : null;
      const id = old && !seen.has(old.id) ? old.id : uid('sln');
      seen.add(id);
      out.push({ ...(old && old.productId === p.id ? old : { state: null, brought: null, by: null, at: null, reported86: null }), id, productId: p.id, qty: Math.round(qty * 100) / 100, note: text(r.note, 140) });
    }
    return out;
  }
  const logEntry = (l, e) => [...(l.log || []), { at: nowIso(), ...e }].slice(-500);
  function tellAssigned(l, actor) {
    const ids = assignees(l).filter((id) => id !== actor.id);
    if (!ids.length) return 0;
    notify(ids, (lang) => (TEXT[lang] || TEXT.en).assigned(l.name, l.due ? fmtTime(l.due, lang) : ''), `#/stock/${l.id}`);
    return ids.length;
  }
  const managersOf = (l, actor) => [...new Set([l.createdBy, l.assignedBy].filter((id) => id && id !== actor.id))];

  const api_ = {
    // ----- the catalog -----
    // Every active product (archived too for managers who ask), the categories and units, and the review queue's size.
    'products.list': (actor, { archived = false } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const mgr = canManageCatalog(u, settings());
      const all = store.list('products', (p) => p.status !== 'archived' || (archived && mgr)).sort((a, b) => a.name.localeCompare(b.name));
      return {
        products: all.map((p) => productView(p, u, { mgr })), categories: cats().map(({ id, name, nameEs }) => ({ id, name, nameEs })),
        units: UNITS, areas: areas(), canManage: mgr, canManageLists: canManageLists(u, settings()), canOwnLists: canOwnLists(u, settings()),
        newCount: mgr ? all.filter((p) => p.review === 'new' && p.status !== 'archived').length : 0,
      };
    },
    'products.get': (actor, { id } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const p = visibleProduct(id);
      const inLists = lists().filter((l) => l.lines.some((x) => x.productId === p.id)).length;
      const in86 = store.list('eightySixItems', (x) => x.productId === p.id).length + store.list('eightySixLog', (x) => x.productId === p.id).length;
      return { product: productView(p, u), usage: { lists: inLists, eightySix: in86 }, matches: canManageCatalog(u, settings()) ? matchesFor(store, p.name, { exclude: p.id }).map(matchView(u)) : [] };
    },
    // Likely duplicates of a name (the smart import's rules): shown while adding, with "Use this one".
    'products.matches.get': (actor, { name, exclude } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      return { matches: text(name, 80) ? matchesFor(store, text(name, 80), { exclude: exclude || null }).map(matchView(u)) : [] };
    },
    // Anyone: a new product on the fly (a name is enough). Likely duplicates come back instead unless force: true.
    'products.add': (actor, a = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const fields = productFields(a, null);
      const dups = matchesFor(store, fields.name);
      if (dups.length && a.force !== true) return { product: null, created: false, duplicates: dups.map(matchView(u)) };
      const mgr = canManageCatalog(u, settings());
      if (!mgr) fields.pars = {}; // par levels are managers'
      const p = store.insert('products', { ...newProduct(fields, { by: u.id, at: nowIso(), review: mgr ? 'ok' : 'new', source: a.source === 'import' ? 'import' : 'app' }), ...fields });
      return { product: productView(p, u), created: true, duplicates: [] };
    },
    // Managers: edit everything. The person who added a product can fix it until a manager reviewed it.
    'products.save': (actor, a = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      if (!a.id) return api_['products.add'](actor, { ...a, force: true }).product;
      const cur = visibleProduct(a.id);
      if (!productView(cur, u).canEdit) fail(403, 'Managers only');
      const fields = productFields(a, cur);
      if (!canManageCatalog(u, settings())) delete fields.pars;
      return productView(store.update('products', cur.id, { ...fields, updatedBy: u.id, updatedAt: nowIso() }), u);
    },
    // The "New products" queue: what staff (and 86 reports) added, waiting for a manager.
    'products.review.list': (actor) => {
      needCatalog(actor);
      ready();
      const u = fresh(actor);
      return { products: store.list('products', (p) => p.review === 'new' && p.status !== 'archived').sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
        .map((p) => ({ ...productView(p, u), matches: matchesFor(store, p.name, { exclude: p.id }).map(matchView(u)) })) };
    },
    'products.approve': (actor, { id } = {}) => {
      needCatalog(actor);
      const p = visibleProduct(id);
      return productView(store.update('products', p.id, { review: 'ok', reviewedBy: actor.id, reviewedAt: nowIso() }), fresh(actor));
    },
    'products.archive': (actor, { id, archived = true } = {}) => {
      needCatalog(actor);
      const p = visibleProduct(id);
      if (!archived && p.mergedInto) fail(409, 'It was merged into another product');
      return productView(store.update('products', p.id, { status: archived ? 'archived' : 'active', review: 'ok', updatedBy: actor.id, updatedAt: nowIso() }), fresh(actor));
    },
    // Merge one product into another: list lines, 86 reports and photos move to the one kept; the other is archived.
    'products.merge': (actor, { keepId, mergeId } = {}) => {
      needCatalog(actor);
      ready();
      const keep = visibleProduct(keepId);
      const gone = visibleProduct(mergeId);
      if (keep.id === gone.id) fail(400, 'Pick two different products');
      if (keep.status === 'archived') fail(400, 'Keep a product that isn’t archived');
      const moved = { lines: 0, eightySix: 0, photos: 0 };
      for (const l of lists()) {
        if (!l.lines.some((x) => x.productId === gone.id)) continue;
        const lines = [];
        for (const x of l.lines) {
          if (x.productId !== gone.id) { lines.push(x); continue; }
          moved.lines++;
          const twin = lines.find((y) => y.productId === keep.id && !y.state && !x.state);
          if (twin && l.kind === 'template') { twin.qty += x.qty; continue; } // one line per product on a template
          lines.push({ ...x, productId: keep.id });
        }
        store.update('stockLists', l.id, { lines });
      }
      for (const col of ['eightySixItems', 'eightySixLog']) {
        for (const r of store.list(col, (x) => x.productId === gone.id)) { store.update(col, r.id, { productId: keep.id }); moved.eightySix++; }
      }
      const photos = [...(keep.photos || [])];
      for (const ph of gone.photos || []) {
        if (photos.length >= PHOTOS_PER_PRODUCT) { store.remove('productPhotos', ph.id); continue; }
        photos.push(ph);
        store.update('productPhotos', ph.id, { productId: keep.id });
        moved.photos++;
      }
      const fill = {};
      for (const f of ['unit', 'size', 'location', 'supplier', 'notes', 'eightySixListId']) if (!keep[f] && gone[f]) fill[f] = gone[f];
      if (!Object.keys(keep.pars || {}).length && Object.keys(gone.pars || {}).length) fill.pars = gone.pars;
      const at = nowIso();
      const kept = store.update('products', keep.id, { ...fill, photos, review: 'ok', reviewedBy: actor.id, reviewedAt: at, updatedBy: actor.id, updatedAt: at });
      store.update('products', gone.id, { status: 'archived', review: 'ok', mergedInto: keep.id, photos: [], updatedBy: actor.id, updatedAt: at });
      return { product: productView(kept, fresh(actor)), moved };
    },
    // Photos: up to 3. The person who added the product (while it's new), managers, or anyone when it has none yet.
    'products.addPhoto': (actor, { id, dataUrl, w, h } = {}) => {
      needAuth(actor);
      const u = fresh(actor);
      const p = visibleProduct(id);
      if (p.status === 'archived') fail(404, 'Product not found');
      const mine = canManageCatalog(u, settings()) || (p.addedBy === u.id && p.review === 'new') || !(p.photos || []).length;
      if (!mine) fail(403, 'Only a manager can change this product’s photos');
      if ((p.photos || []).length >= PHOTOS_PER_PRODUCT) fail(400, 'A product can have up to 3 photos');
      const { mime, data, bytes } = checkPhoto(dataUrl, fail);
      const dim = (v) => Math.max(0, Math.min(10000, Math.round(Number(v) || 0)));
      const photo = { id: uid('prp'), w: dim(w), h: dim(h), by: u.id, at: nowIso() };
      store.insert('productPhotos', { ...photo, productId: p.id, mime, data, bytes });
      return { photo: { id: photo.id, w: photo.w, h: photo.h, canRemove: true }, product: productView(store.update('products', p.id, { photos: [...(p.photos || []), photo] }), u) };
    },
    'products.removePhoto': (actor, { id, photoId } = {}) => {
      needAuth(actor);
      const u = fresh(actor);
      const p = visibleProduct(id);
      const ph = (p.photos || []).find((x) => x.id === photoId);
      if (!ph) fail(404, 'Photo not found');
      if (!canManageCatalog(u, settings()) && ph.by !== u.id) fail(403, 'Only a manager can change this product’s photos');
      store.remove('productPhotos', ph.id);
      return { product: productView(store.update('products', p.id, { photos: p.photos.filter((x) => x.id !== ph.id) }), u) };
    },
    // The photo itself as a data URL, for the demo (on a server /api/stock/photos/:id serves the bytes).
    'products.photo.get': (actor, { id } = {}) => {
      needAuth(actor);
      const p = productPhotoFor(store, actor, id);
      if (!p?.data) fail(404, 'Photo not found');
      return { id: p.id, dataUrl: `data:${p.mime};base64,${p.data}` };
    },
    // The categories, in order (Stock → Products → Categories): rename the built-in ones or add more. 'other' stays.
    'products.saveCategories': (actor, { categories: list } = {}) => {
      needCatalog(actor);
      if (!Array.isArray(list)) fail(400, 'Send the categories');
      const builtIn = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
      const seen = new Set();
      const out = [];
      for (const c of list.slice(0, MAX_CATEGORIES)) {
        const b = builtIn[c?.id];
        const name = text(c?.name, 40), nameEs = text(c?.nameEs, 40);
        if (!b && !name) fail(400, 'Every category needs a name');
        const id = b || (c?.id && /^pcat_[a-z0-9]+$/.test(c.id)) ? c.id : uid('pcat');
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: b && (!name || fold(name) === fold(b.en)) ? '' : name, nameEs: b && (!nameEs || fold(nameEs) === fold(b.es)) ? '' : nameEs });
      }
      if (!seen.has('other')) out.push({ id: 'other', name: '', nameEs: '' });
      const doc = { categories: out, updatedAt: nowIso() };
      if (store.get('stockConfig', 'main')) store.update('stockConfig', 'main', doc); else store.insert('stockConfig', { id: 'main', ...doc });
      return { categories: cats() };
    },

    // ----- lists -----
    // scope: 'mine' (assigned to me, not done), 'all' (managers: every open list), 'templates', 'history' (done, last `days`).
    'stock.lists.list': (actor, { scope = 'mine', days = HISTORY_DAYS } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const mgr = canManageLists(u, settings());
      let out = [];
      if (scope === 'templates') out = mgr ? lists().filter((l) => l.kind === 'template') : [];
      else if (scope === 'history') {
        const from = new Date(now().getTime() - Math.min(365, Math.max(1, Number(days) || HISTORY_DAYS)) * 86400000).toISOString();
        out = lists().filter((l) => l.kind === 'list' && l.status === 'done' && (l.doneAt || '') >= from && (mgr || canWork(l, u)));
        out.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
      } else if (scope === 'all') out = mgr ? lists().filter((l) => l.kind === 'list' && l.status !== 'done') : [];
      else out = lists().filter((l) => l.kind === 'list' && l.status !== 'done' && (assignedTo(l, u) || (l.personal && l.createdBy === u.id)));
      if (scope !== 'history') out.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.due || '99').localeCompare(b.due || '99') || a.name.localeCompare(b.name));
      return { lists: out.map((l) => summary(l, u)), canManage: mgr, canOwn: canOwnLists(u, settings()), today: today() };
    },
    // My lists for today (My Shifts' card): assigned to me, dated today or not dated, not done.
    'stock.mine.list': (actor) => {
      needAuth(actor);
      const u = fresh(actor);
      const d = today();
      return { lists: lists().filter((l) => l.kind === 'list' && l.status !== 'done' && (!l.date || l.date <= d) && (assignedTo(l, u) || (l.personal && l.createdBy === u.id)))
        .map((l) => summary(l, u)) };
    },
    'stock.list.get': (actor, { id } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      return fullView(visibleList(u, id), u);
    },
    // Who and where a list can go to: people, positions, rooms, the 86 lists.
    'stock.options.get': (actor) => {
      needAuth(actor);
      const u = fresh(actor);
      const mgr = canManageLists(u, settings());
      return {
        people: mgr ? store.list('users', (x) => x.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ id: x.id, name: x.name })) : [{ id: u.id, name: u.name }],
        positions: mgr ? store.list('jobCodes', (j) => !j.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((j) => ({ id: j.id, name: j.name })) : [],
        rooms: mgr ? areas() : [],
        eightySixLists: planHas('eightySix') ? store.list('eightySixLists', (l) => canSeeList(store, u, l)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((l) => ({ id: l.id, name: l.name, nameEs: l.nameEs || '' })) : [],
        canManage: mgr, canOwn: canOwnLists(u, settings()), today: today(),
      };
    },
    // Create or change a list or a template. Employees with "own lists" make lists for themselves only.
    'stock.save': (actor, a = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const mgr = canManageLists(u, settings());
      const cur = a.id ? visibleList(u, a.id) : null;
      if (cur ? !canEditList(cur, u) : !canOwnLists(u, settings())) fail(403, 'Supervisors and managers only');
      const kind = cur?.kind || (a.kind === 'template' ? 'template' : 'list');
      if (kind === 'template' && !mgr) fail(403, 'Supervisors and managers only');
      const name = text(a.name ?? cur?.name, 60);
      if (!name) fail(400, 'Give the list a name');
      const personal = cur ? !!cur.personal : !mgr;
      const date = kind === 'template' ? '' : 'date' in a ? String(a.date || '') : cur?.date || '';
      if (date && !DATE.test(date)) fail(400, 'Pick a date');
      const due = kind === 'template' ? '' : 'due' in a ? String(a.due || '') : cur?.due || '';
      if (due && !TIME.test(due)) fail(400, 'Pick a time like 17:00');
      const lines = cleanLines(a.lines, cur?.lines || []);
      if (!lines.length) fail(400, 'Add at least one product');
      const assign = kind === 'template' ? null : 'assign' in a ? cleanAssign(a.assign, { personal, actor: u }) : cur?.assign || null;
      const at = nowIso();
      const doc = {
        name, notes: text(a.notes ?? cur?.notes, 300), lines, date, due, assign,
        eightySixListId: 'eightySixListId' in a ? (store.get('eightySixLists', a.eightySixListId) ? a.eightySixListId : null) : cur?.eightySixListId || null, updatedAt: at,
      };
      const changedTo = JSON.stringify(assign) !== JSON.stringify(cur?.assign || null) || (cur && date !== cur.date);
      let out;
      if (cur) {
        const allDone = doc.lines.length && doc.lines.every((x) => x.state);
        out = store.update('stockLists', cur.id, { ...doc, ...(changedTo && assign ? { assignedBy: u.id, assignedAt: at } : {}),
          ...(cur.kind === 'list' && cur.status === 'done' && !allDone ? { status: 'in_progress', doneAt: null, doneBy: null } : {}),
          log: logEntry(cur, { by: u.id, what: changedTo ? 'reassigned' : 'edited', ...(changedTo ? { to: assignWords(assign) } : {}) }) });
      } else {
        out = store.insert('stockLists', { id: uid('stk'), kind, ...doc, personal: kind === 'list' && personal, templateId: a.templateId && store.get('stockLists', a.templateId)?.kind === 'template' ? a.templateId : null,
          status: 'open', createdBy: u.id, createdAt: at, ...(assign ? { assignedBy: u.id, assignedAt: at } : {}), log: [{ at, by: u.id, what: 'created' }] });
      }
      const told = out.kind === 'list' && (!cur || changedTo) ? tellAssigned(out, u) : 0;
      return { ...fullView(out, u), notified: told };
    },
    // A list from a template: its products and quantities, for a date, a person or position or room, a due time.
    'stock.fromTemplate': (actor, { templateId, name, date, due, assign, notes } = {}) => {
      needLists(actor);
      const tpl = templateId ? store.get('stockLists', String(templateId)) : null;
      if (!tpl || tpl.kind !== 'template') fail(404, 'Template not found');
      const lines = tpl.lines.filter((x) => store.get('products', x.productId)?.status !== 'archived').map((x) => ({ productId: x.productId, qty: x.qty, note: x.note }));
      return api_['stock.save'](actor, { kind: 'list', name: text(name, 60) || tpl.name, date: date ?? today(), due: due ?? '', assign, notes: notes ?? tpl.notes, lines, templateId: tpl.id, eightySixListId: tpl.eightySixListId });
    },
    // Save a list's products and quantities as a template.
    'stock.saveAsTemplate': (actor, { id, name } = {}) => {
      needLists(actor);
      const u = fresh(actor);
      const l = visibleList(u, id);
      return api_['stock.save'](actor, { kind: 'template', name: text(name, 60) || l.name, notes: l.notes, lines: l.lines.map((x) => ({ productId: x.productId, qty: x.qty, note: x.note })), eightySixListId: l.eightySixListId });
    },
    // Reassign (or set the date and due time): the new people are told.
    'stock.assign': (actor, { id, assign, date, due } = {}) => {
      needLists(actor);
      const u = fresh(actor);
      const l = visibleList(u, id);
      if (l.kind !== 'list') fail(400, 'Templates aren’t assigned. Make a list from it.');
      return api_['stock.save'](actor, { id: l.id, assign, ...(date !== undefined ? { date } : {}), ...(due !== undefined ? { due } : {}) });
    },
    'stock.delete': (actor, { id } = {}) => {
      needAuth(actor);
      const u = fresh(actor);
      const l = visibleList(u, id);
      if (!canEditList(l, u)) fail(403, 'Supervisors and managers only');
      store.remove('stockLists', l.id);
      return { ok: true };
    },
    // Working a list: Got it, Short (with how many were brought), Out, or undo (state: null).
    'stock.mark': (actor, { id, lineId, state = null, brought, note } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const l = visibleList(u, id);
      if (!canWork(l, u)) fail(403, 'This list isn’t assigned to you');
      const i = l.lines.findIndex((x) => x.id === lineId);
      if (i < 0) fail(404, 'That product isn’t on the list');
      if (state !== null && !STATES.includes(state)) fail(400, 'Got it, short or out');
      let qty = null;
      if (state === 'short') {
        qty = Number(brought);
        if (brought === '' || brought == null || !Number.isFinite(qty) || qty < 0 || qty >= l.lines[i].qty) fail(400, 'Say how many you brought (less than asked)');
      }
      const at = nowIso();
      const line = { ...l.lines[i], state, brought: state === 'short' ? qty : state === 'got' ? l.lines[i].qty : state === 'out' ? 0 : null, by: state ? u.id : null, at: state ? at : null,
        ...(note !== undefined ? { note: text(note, 140) } : {}) };
      const lines = l.lines.map((x, k) => (k === i ? line : x));
      const all = lines.every((x) => x.state);
      const patch = { lines, updatedAt: at, log: logEntry(l, { by: u.id, what: 'mark', lineId, state, ...(state === 'short' ? { brought: qty } : {}) }) };
      if (!l.startedAt && state) patch.startedAt = at;
      patch.status = all ? 'done' : lines.some((x) => x.state) ? 'in_progress' : 'open';
      if (all && l.status !== 'done') { patch.doneAt = at; patch.doneBy = u.id; }
      if (!all) { patch.doneAt = null; patch.doneBy = null; }
      const saved = store.update('stockLists', l.id, patch);
      // The manager hears about it: an "out" right away, and the list once it's done (once).
      const product = store.get('products', line.productId)?.name || '';
      const bosses = managersOf(saved, u);
      if (state === 'out' && bosses.length && l.lines[i].state !== 'out') notify(bosses, (lang) => (TEXT[lang] || TEXT.en).out(saved.name, product, u.name), `#/stock/${saved.id}`);
      if (all && l.status !== 'done' && !saved.toldDone && bosses.length) {
        const c = counts(saved);
        notify(bosses, (lang) => (TEXT[lang] || TEXT.en).done(saved.name, u.name, c.short, c.out), `#/stock/${saved.id}`);
        store.update('stockLists', saved.id, { toldDone: at });
      }
      return fullView(store.get('stockLists', saved.id), u);
    },
    // Out → the 86 List in one tap (status 'out'), or Short → running low: the right list (or the one picked), through
    // eightySix.report, so the 86 List's own rules apply (who may report, who's told).
    'stock.reportEightySix': (actor, { id, lineId, status, listId, count } = {}) => {
      needAuth(actor);
      ready();
      const u = fresh(actor);
      const l = visibleList(u, id);
      if (!canWork(l, u)) fail(403, 'This list isn’t assigned to you');
      const line = l.lines.find((x) => x.id === lineId);
      if (!line) fail(404, 'That product isn’t on the list');
      if (!planHas('eightySix') || roleAllows(u, settings()).eightySix === false) fail(403, 'The 86 List isn’t on for you');
      const p = store.get('products', line.productId);
      const target = listId ? store.get('eightySixLists', String(listId)) : list86For(p, l, u);
      if (!target) fail(400, 'There’s no 86 list you can report on');
      const st = status === 'low' ? 'low' : 'out';
      const r = api['eightySix.report'](actor, { listId: target.id, name: p?.name || '', productId: p?.id, status: st, count: st === 'low' ? (count ?? line.brought ?? '') : '', note: '' });
      const at = nowIso();
      const lines = l.lines.map((x) => (x.id === line.id ? { ...x, reported86: { itemId: r.item.id, listId: target.id, status: st, at } } : x));
      store.update('stockLists', l.id, { lines, log: logEntry(l, { by: u.id, what: 'reported86', lineId, state: st, to: target.name }) });
      return { ...fullView(store.get('stockLists', l.id), u), eightySix: { listId: target.id, listName: target.name, status: st, notified: r.notified } };
    },
  };
  return api_;
}
