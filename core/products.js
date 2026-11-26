// The product catalog: one list of what the restaurant stocks (Bacardi Superior, cocktail napkins, rocks glasses,
// limes…), shared by Stock lists (core/stock.js) and the 86 List (core/eighty-six.js). A product added in one place
// shows up in the other: Stock lists pick lines from it, the 86 List's report form suggests it, and an 86 report of a
// name the catalog doesn't have yet adds it (for a manager to review, like anything staff add).
//
// Collections
//   products       { id, name, key (looseItemKey), category, unit, size, pars: { [area or '']: n }, location, supplier,
//                    notes, photos: [{ id, w, h, by, at }] (up to 3), status: 'active' | 'archived', review: 'new' | 'ok',
//                    source: 'app' | 'eightySix' | 'import' | 'migration', eightySixListId (the 86 list it's reported on),
//                    addedBy (user id, null from the migration), addedAt, updatedBy, updatedAt, reviewedBy, reviewedAt,
//                    mergedInto (archived by a merge) }
//   productPhotos  one photo per document (base64), LAZY_DATA in server/db.js, served at /api/stock/photos/:id.
//   stockConfig    'main': { categories: [{ id, name, nameEs }], updatedAt } when a manager changed the categories.
//
// The 86 List keeps its own reports (eightySixItems / eightySixLog, one per time something ran out), now with a
// productId linking each to the catalog. Nothing an 86 screen shows changed: the link is only on the stored reports.
//
// The migration (MIGRATION in `migrations`, once per restaurant, the first time the catalog is used): a product for each
// distinct name reported on the 86 List before, where that's clean, and every past report linked to its product.
//   - names are grouped by the smart import's duplicate rules (core/smart-import.js productLooseKey: case, accents,
//     plurals, "&"/"and", a size on the end): "Lime", "limes" and "LIMES" are one product, spelled the way it was
//     reported most often (the latest when tied).
//   - not clean, so left out (listed on the marker for a manager to look at): a name only a typo away from another
//     name ("Proseco" next to "Prosecco": the one reported less often; both when it's a tie), and reports linked to a
//     Training menu item (a dish, not a supply). Their reports keep working as before, just without a product.
//   - an 86 report's history is never changed otherwise: names, times, categories and photos stay as they were.
import { uid } from './store.js';
import { productLikeness, productLooseKey, itemKey as foldKey, editDistance, typoBudget } from './smart-import.js';

export const MIGRATION = 'products-from-86';
export const PHOTOS_PER_PRODUCT = 3;
export const MAX_CATEGORIES = 30;
export const POSSIBLE = 60; // a likeness at least this is a "likely match"

/** The catalog's categories (editable: Settings → Products). */
export const DEFAULT_CATEGORIES = [
  { id: 'spirits', en: 'Spirits', es: 'Licores' },
  { id: 'beer', en: 'Beer', es: 'Cerveza' },
  { id: 'wine', en: 'Wine', es: 'Vino' },
  { id: 'mixers', en: 'Mixers', es: 'Mezcladores' },
  { id: 'garnish', en: 'Garnish', es: 'Guarniciones' },
  { id: 'glassware', en: 'Glassware', es: 'Cristalería' },
  { id: 'smallwares', en: 'Smallwares', es: 'Utensilios' },
  { id: 'paper', en: 'Paper & disposables', es: 'Papel y desechables' },
  { id: 'cleaning', en: 'Cleaning', es: 'Limpieza' },
  { id: 'dry', en: 'Kitchen dry goods', es: 'Abarrotes de cocina' },
  { id: 'other', en: 'Other', es: 'Otros' },
];
const BUILT_IN = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
/** How a product is counted. Free text is fine too; these are the suggestions, with their Spanish. */
export const UNITS = [
  { id: 'bottle', en: 'bottle', es: 'botella' }, { id: 'case', en: 'case', es: 'caja' }, { id: 'sleeve', en: 'sleeve', es: 'paquete' },
  { id: 'box', en: 'box', es: 'caja chica' }, { id: 'each', en: 'each', es: 'pieza' }, { id: 'lb', en: 'lb', es: 'lb' },
  { id: 'bag', en: 'bag', es: 'bolsa' }, { id: 'keg', en: 'keg', es: 'barril' }, { id: 'can', en: 'can', es: 'lata' },
  { id: 'gallon', en: 'gallon', es: 'galón' }, { id: 'roll', en: 'roll', es: 'rollo' }, { id: 'rack', en: 'rack', es: 'rejilla' },
];
const UNIT_IDS = new Set(UNITS.map((u) => u.id));
/** A unit in a language ('case' → 'caja'); one typed in stays as typed. */
export const unitName = (unit, lang = 'en') => { const u = UNITS.find((x) => x.id === unit); return u ? u[lang === 'es' ? 'es' : 'en'] : unit || ''; };

/** The categories in order, with both names: [{ id, name, nameEs, builtIn }]. */
export function productCategories(store) {
  const saved = store.get('stockConfig', 'main')?.categories;
  const list = Array.isArray(saved) && saved.length ? saved : DEFAULT_CATEGORIES.map((c) => ({ id: c.id, name: '', nameEs: '' }));
  return list.map((c) => {
    const b = BUILT_IN[c.id];
    const name = c.name || b?.en || c.id;
    return { id: c.id, name, nameEs: c.nameEs || b?.es || name, builtIn: !!b };
  });
}

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const productKey = (name) => productLooseKey(name) || foldKey(name);
export const cleanUnit = (v) => { const s = text(v, 20).toLowerCase(); return UNIT_IDS.has(s) ? s : text(v, 20); };

/** Likely matches for a name among the catalog's active products, best first: [{ product, score, confidence, reasons }]. */
export function matchesFor(store, name, { exclude = null, limit = 5, min = POSSIBLE } = {}) {
  const out = [];
  for (const p of store.list('products', (x) => x.status !== 'archived' && x.id !== exclude)) {
    const r = productLikeness(name, p.name);
    if (r.score >= min) out.push({ product: p, ...r });
  }
  return out.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name)).slice(0, limit);
}
/** The product a name surely is (the same name, or only a size, plural or "&" apart), or null. */
export function sureMatch(store, name) {
  const best = matchesFor(store, name, { limit: 2, min: 85 });
  return best.length === 1 || (best.length > 1 && best[0].score > best[1].score) ? best[0].product : null;
}

// 86 categories → the catalog's: the supplies the bar and the kitchen report.
const LIQUOR = /beer|lager|ipa|ale\b|stout|cerveza/i;
const WINE = /wine|ros[eé]|prosecco|champagne|cava|vino|pinot|cabernet|chardonnay|sauvignon|merlot|malbec/i;
/** A catalog category for an 86 report (its 86 category and whether it was on a bar list). */
export function categoryFrom86(cat86, name, bar) {
  if (cat86 === 'liquor') return LIQUOR.test(name) ? 'beer' : WINE.test(name) ? 'wine' : 'spirits';
  if (cat86 === 'glassware') return 'glassware';
  if (cat86 === 'paper') return 'paper';
  if (cat86 === 'cleaning') return 'cleaning';
  if (cat86 === 'dry') return bar ? 'mixers' : 'dry';
  if (cat86 === 'produce') return bar ? 'garnish' : 'other';
  if (cat86 === 'dairy') return bar ? 'mixers' : 'other';
  return 'other';
}

/** A new product document (the caller inserts it). */
export function newProduct(fields, { by = null, at, review = 'ok', source = 'app' }) {
  const name = text(fields.name, 80);
  return {
    id: uid('prd'), name, key: productKey(name), category: fields.category || 'other', unit: cleanUnit(fields.unit), size: text(fields.size, 30),
    pars: fields.pars || {}, location: text(fields.location, 80), supplier: text(fields.supplier, 80), notes: text(fields.notes, 300), photos: [],
    status: 'active', review, source, eightySixListId: fields.eightySixListId || null, addedBy: by, addedAt: at, updatedBy: by, updatedAt: at,
  };
}

/**
 * The product an 86 report is (found by name, else added for review) and its id: what eightySix.report stores as
 * productId. productId: the product the reporter picked. Never for a report linked to a menu item (a dish).
 */
export function productFor86(store, { productId, name, category86, list, by, at }) {
  ensureCatalog(store, at);
  if (productId) {
    const p = store.get('products', productId);
    if (p && p.status !== 'archived') return p;
  }
  const found = sureMatch(store, name);
  if (found) return found;
  const doc = newProduct({ name, category: categoryFrom86(category86, name, list?.kind === 'bar'), eightySixListId: list?.id || null }, { by, at, review: 'new', source: 'eightySix' });
  return doc.name ? store.insert('products', doc) : null;
}

/**
 * Once per restaurant: products from the 86 List's past reports, and every report linked to its product (see the
 * top of this file). Returns the marker, or null when it ran before.
 */
export function ensureCatalog(store, at = new Date().toISOString()) {
  if (store.get('migrations', MIGRATION)) return null;
  const lists = Object.fromEntries(store.list('eightySixLists').map((l) => [l.id, l]));
  const groups = new Map(); // loose key → { spellings: Map(name → { n, at }), lists: Map(listId → n), cat86, first, ids: [[col, id]] }
  const menuLinked = [];
  for (const col of ['eightySixLog', 'eightySixItems']) {
    for (const r of store.list(col)) {
      if (r.menuItemId) { menuLinked.push(r.name); continue; }
      const k = productKey(r.name);
      if (!k) continue;
      const g = groups.get(k) || { spellings: new Map(), lists: new Map(), cat86: '', first: '', last: '', ids: [] };
      const when = r.updatedAt || r.reportedAt || '';
      const s = g.spellings.get(r.name) || { n: 0, at: '' };
      s.n++; if (when > s.at) s.at = when;
      g.spellings.set(r.name, s);
      g.lists.set(r.listId, (g.lists.get(r.listId) || 0) + 1);
      if (when >= g.last) { g.last = when; g.cat86 = r.category || g.cat86; }
      if (!g.first || (r.reportedAt && r.reportedAt < g.first)) g.first = r.reportedAt || when;
      g.ids.push([col, r.id]);
      groups.set(k, g);
    }
  }
  for (const n of store.list('eightySixNames')) {
    const k = productKey(n.name);
    if (groups.has(k) && n.category && !groups.get(k).cat86) groups.get(k).cat86 = n.category;
  }
  // A name a typo away from another (and not the same product by the rules above) isn't clean: the one reported less
  // often is left for a manager (both, when they were reported as often), never guessed into the other.
  const keys = [...groups.keys()];
  const typo = new Set();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      if (a[0] !== b[0]) continue;
      const budget = Math.min(typoBudget(a), typoBudget(b));
      if (!budget || editDistance(a, b, budget) > budget) continue;
      const na = groups.get(a).ids.length, nb = groups.get(b).ids.length;
      if (na <= nb) typo.add(a);
      if (nb <= na) typo.add(b);
    }
  }
  let created = 0, linked = 0;
  const skipped = [];
  for (const [k, g] of groups) {
    const spelling = [...g.spellings.entries()].sort((a, b) => b[1].n - a[1].n || b[1].at.localeCompare(a[1].at))[0][0];
    const existing = store.list('products', (p) => p.status !== 'archived' && p.key === k)[0] || null;
    if (!existing && typo.has(k)) { skipped.push(spelling); continue; }
    let product = existing;
    if (!product) {
      const listId = [...g.lists.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      product = store.insert('products', newProduct({ name: spelling, category: categoryFrom86(g.cat86, spelling, lists[listId]?.kind === 'bar'), eightySixListId: lists[listId] ? listId : null },
        { by: null, at: g.first || at, review: 'ok', source: 'migration' }));
      created++;
    }
    for (const [col, id] of g.ids) { store.update(col, id, { productId: product.id }); linked++; }
  }
  return store.insert('migrations', { id: MIGRATION, at, created, linked, skipped: skipped.sort(), menuItems: [...new Set(menuLinked)].length });
}
