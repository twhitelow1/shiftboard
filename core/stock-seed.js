// SAMPLE Stock lists for the demo (core/stock.js): an invented catalog (no real brands) with drawn placeholder
// "photos" (SVG tiles, not real photos), two templates, a list assigned to a barback and in progress, one done list in
// the history, and three products staff added on the fly waiting in the managers' "New products" queue (one of them a
// likely duplicate, to show Merge). Demo people only. Called after seedDemo by the web demo and the server's SEED_DEMO
// (never by seedDemo itself, so the Roles & features fingerprint keeps the data it was taken on).
import { uid } from './store.js';
import { todayStr } from './time.js';
import { ensureCatalog, newProduct, productKey } from './products.js';

// A bottle, a box, a glass or a bunch of fruit, in the product's colors, with "Sample photo" in the corner.
function tile(shape, bg, a, b) {
  const body = {
    bottle: `<rect x="270" y="70" width="40" height="70" rx="8" fill="${b}"/><rect x="230" y="130" width="120" height="240" rx="34" fill="${a}"/><rect x="246" y="210" width="88" height="80" rx="6" fill="#ffffff" fill-opacity=".85"/>`,
    box: `<rect x="170" y="150" width="240" height="200" rx="10" fill="${a}"/><rect x="170" y="150" width="240" height="44" fill="${b}"/><rect x="250" y="230" width="80" height="50" rx="6" fill="#ffffff" fill-opacity=".85"/>`,
    glass: `<path d="M210 120 h160 l-26 220 h-108 z" fill="#ffffff" fill-opacity=".55"/><path d="M222 200 h136 l-16 132 h-104 z" fill="${a}"/><circle cx="330" cy="170" r="22" fill="${b}"/>`,
    fruit: `<circle cx="250" cy="250" r="70" fill="${a}"/><circle cx="345" cy="230" r="62" fill="${a}"/><circle cx="300" cy="300" r="60" fill="${b}"/>`,
    can: `<rect x="230" y="110" width="120" height="250" rx="18" fill="${a}"/><rect x="230" y="110" width="120" height="26" rx="10" fill="${b}"/><rect x="250" y="200" width="80" height="70" rx="6" fill="#ffffff" fill-opacity=".8"/>`,
  }[shape];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 580 440" width="580" height="440"><rect width="580" height="440" fill="${bg}"/>${body}<text x="560" y="424" text-anchor="end" font-family="sans-serif" font-size="18" fill="#ffffff" fill-opacity=".75">Sample photo</text></svg>`;
  return typeof Buffer !== 'undefined' ? Buffer.from(svg).toString('base64') : btoa(svg);
}

// [key, name, category, unit, size, location, supplier, shape, colors, pars]
const CATALOG = [
  ['rum', 'Harbor Light Silver Rum', 'spirits', 'bottle', '1 L', 'Liquor room, shelf 2', 'Mesa Beverage Co.', 'bottle', ['#0e7490', '#e0f2fe', '#164e63'], { '': 6, 'Rabbit Hole': 4 }],
  ['gin', 'Juniper Row Gin', 'spirits', 'bottle', '750 ml', 'Liquor room, shelf 2', 'Mesa Beverage Co.', 'bottle', ['#166534', '#dcfce7', '#14532d'], { '': 4 }],
  ['vodka', 'North Fork Vodka', 'spirits', 'bottle', '1 L', 'Liquor room, shelf 1', 'Mesa Beverage Co.', 'bottle', ['#1e3a8a', '#e0e7ff', '#1e40af'], { '': 6 }],
  ['bourbon', 'Old Mesa Bourbon', 'spirits', 'bottle', '750 ml', 'Liquor room, shelf 3', 'Mesa Beverage Co.', 'bottle', ['#78350f', '#fde68a', '#451a03'], { '': 3 }],
  ['tequila', 'Agave Sol Blanco Tequila', 'spirits', 'bottle', '750 ml', 'Liquor room, shelf 3', 'Mesa Beverage Co.', 'bottle', ['#a16207', '#fef9c3', '#713f12'], { '': 4 }],
  ['lager', 'Riverbend Lager', 'beer', 'case', '24 × 12 oz', 'Walk-in, beer wall', 'Valley Distributing', 'box', ['#ca8a04', '#fef3c7', '#92400e'], { '': 2 }],
  ['ipa', 'Hazy Pines IPA', 'beer', 'keg', '1/6 bbl', 'Walk-in, keg row', 'Valley Distributing', 'can', ['#15803d', '#bbf7d0', '#166534'], {}],
  ['rose', 'Casa Alba Rosé', 'wine', 'bottle', '750 ml', 'Wine fridge', 'Hillside Wines', 'bottle', ['#be185d', '#fce7f3', '#9d174d'], { '': 6 }],
  ['soda', 'Club soda', 'mixers', 'case', '24 × 10 oz', 'Dry storage, shelf 1', 'Valley Distributing', 'can', ['#0369a1', '#e0f2fe', '#075985'], { '': 1 }],
  ['ginger', 'Ginger beer', 'mixers', 'case', '24 × 12 oz', 'Dry storage, shelf 1', 'Valley Distributing', 'can', ['#c2410c', '#ffedd5', '#9a3412'], { '': 1 }],
  ['syrup', 'Simple syrup', 'mixers', 'bottle', '1 qt', 'Walk-in, shelf 3', '', 'bottle', ['#64748b', '#f1f5f9', '#334155'], { '': 2 }],
  ['limes', 'Limes', 'garnish', 'case', '', 'Walk-in, produce shelf', 'Green Basket Produce', 'fruit', ['#65a30d', '#84cc16', '#3f6212'], { '': 1 }],
  ['mint', 'Mint', 'garnish', 'bag', '', 'Walk-in, produce shelf', 'Green Basket Produce', 'fruit', ['#15803d', '#22c55e', '#14532d'], {}],
  ['oranges', 'Oranges', 'garnish', 'case', '', 'Walk-in, produce shelf', 'Green Basket Produce', 'fruit', ['#ea580c', '#f97316', '#9a3412'], {}],
  ['rocks', 'Rocks glasses', 'glassware', 'rack', '', 'Dish pit, glass racks', '', 'glass', ['#475569', '#94a3b8', '#e2e8f0'], { '': 2 }],
  ['coupe', 'Coupe glasses', 'glassware', 'rack', '', 'Dish pit, glass racks', '', 'glass', ['#7c3aed', '#c4b5fd', '#ede9fe'], { '': 1 }],
  ['napkins', 'Cocktail napkins', 'paper', 'sleeve', '', 'Dry storage, shelf 4', 'Main Street Paper', 'box', ['#0f766e', '#ccfbf1', '#115e59'], { '': 4 }],
  ['straws', 'Paper straws', 'paper', 'box', '', 'Dry storage, shelf 4', 'Main Street Paper', 'box', ['#b91c1c', '#fee2e2', '#7f1d1d'], { '': 1 }],
  ['cups', 'To-go cups 16 oz', 'paper', 'sleeve', '16 oz', 'Dry storage, shelf 5', 'Main Street Paper', 'box', ['#4338ca', '#e0e7ff', '#312e81'], {}],
  ['sanitizer', 'Sanitizer tablets', 'cleaning', 'box', '', 'Chemical closet', 'Clean Co.', 'box', ['#0891b2', '#cffafe', '#155e75'], {}],
  ['bartowels', 'Bar towels', 'smallwares', 'bag', '', 'Laundry shelf', '', 'box', ['#57534e', '#e7e5e4', '#292524'], { '': 2 }],
];
// Staff added these on the fly; they wait for a manager (the first is a likely duplicate of the rum).
const STAFF_ADDED = [
  ['Harbor Light Silver Rum 1L', 'spirits', 'bottle', 'Arthur', 'bottle', ['#0e7490', '#e0f2fe', '#164e63']],
  ['Bar spoons', 'smallwares', 'each', 'Luciano', 'glass', ['#334155', '#cbd5e1', '#94a3b8']],
  ['Cold brew concentrate', 'mixers', 'box', 'Mak', null, null],
];

export function seedStockDemo(store, { now = new Date() } = {}) {
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60000).toISOString();
  ensureCatalog(store, at(60 * 24 * 30)); // the 86 List's past reports become products first, like a real restaurant's
  const user = (name) => store.list('users', (u) => u.name === name)[0]?.id || null;
  const mgr = user('Moe') || user('Kelly');
  const photo = (productId, data, n, by) => {
    const p = { id: `prp_demo_${productId}_${n}`, w: 580, h: 440, by, at: at(60 * 24 * 20) };
    store.insert('productPhotos', { ...p, productId, mime: 'image/svg+xml', data, bytes: Math.floor((data.length * 3) / 4) });
    return p;
  };
  const ids = {};
  for (const [key, name, category, unit, size, location, supplier, shape, [bg, a, b], pars] of CATALOG) {
    const id = `prd_demo_${key}`;
    const existing = store.list('products', (p) => p.status !== 'archived' && p.key === productKey(name))[0];
    const doc = { ...newProduct({ name, category, unit, size, location, supplier, pars }, { by: mgr, at: at(60 * 24 * 21), review: 'ok', source: 'app' }), id };
    if (existing) {
      ids[key] = existing.id;
      store.update('products', existing.id, { unit, size, location, supplier, pars, category, photos: existing.photos?.length ? existing.photos : [photo(existing.id, tile(shape, bg, a, b), 1, mgr)] });
      continue;
    }
    store.insert('products', { ...doc, photos: [photo(id, tile(shape, bg, a, b), 1, mgr)] });
    ids[key] = id;
  }
  // What people also call them (search finds these too).
  const ALIASES = { rum: ['well rum', 'silver rum'], vodka: ['house vodka', 'well vodka'], tequila: ['blanco', 'well tequila'], soda: ['soda water'], napkins: ['bev naps'], bartowels: ['bar rags'] };
  for (const [key, aliases] of Object.entries(ALIASES)) if (ids[key]) store.update('products', ids[key], { aliases });
  for (const [i, [name, category, unit, who, shape, colors]] of STAFF_ADDED.entries()) {
    const id = `prd_demo_new${i + 1}`;
    const by = user(who);
    store.insert('products', { ...newProduct({ name, category, unit }, { by, at: at(60 * (5 + i * 7)), review: 'new', source: 'app' }), id,
      photos: shape ? [photo(id, tile(shape, colors[0], colors[1], colors[2]), 1, by)] : [] });
  }

  const line = (key, qty, extra = {}) => ({ id: uid('sln'), productId: ids[key], qty, note: '', state: null, brought: null, by: null, at: null, reported86: null, ...extra });
  const bar = store.get('eightySixLists', 'e86_bar') ? 'e86_bar' : null;
  const tpl = (id, name, notes, lines) => store.insert('stockLists', {
    id, kind: 'template', name, notes, lines, date: '', due: '', assign: null, quick: false, templateId: null, eightySixListId: bar,
    status: 'open', createdBy: mgr, createdAt: at(60 * 24 * 14), updatedAt: at(60 * 24 * 14), log: [{ at: at(60 * 24 * 14), by: mgr, what: 'created' }],
  });
  tpl('stk_demo_nightly', 'Nightly bar restock', 'Rabbit Hole bar. Fill the wells, then the back bar.',
    [line('rum', 2), line('vodka', 2), line('gin', 1), line('tequila', 1), line('soda', 1), line('limes', 1), line('napkins', 2), line('rocks', 1)]);
  tpl('stk_demo_patio', 'Patio open', 'Before the patio opens for the season or after a rain day.',
    [line('cups', 2), line('straws', 1), line('napkins', 2), line('sanitizer', 1), line('bartowels', 1)]);

  // Today's list for a barback, in progress: two got, one short (reported low), one out (on the 86 List), the rest to do.
  const d = todayStr(now);
  const arthur = user('Arthur');
  const started = at(25);
  const fri = [
    line('rum', 3, { state: 'got', brought: 3, by: arthur, at: at(22) }), line('vodka', 2, { state: 'got', brought: 2, by: arthur, at: at(20) }),
    line('tequila', 2, { state: 'short', brought: 1, by: arthur, at: at(18) }), line('ginger', 1, { state: 'out', brought: 0, by: arthur, at: at(15) }),
    line('soda', 1), line('limes', 1, { note: 'Cut half of them' }), line('mint', 1), line('napkins', 2), line('rocks', 2), line('coupe', 1),
  ];
  store.insert('stockLists', {
    id: 'stk_demo_today', kind: 'list', name: 'Bar restock before service', notes: 'Rabbit Hole bar. Ask Mak if the well is short.', lines: fri, date: d, due: '16:30',
    assign: arthur ? { type: 'person', userId: arthur } : { type: 'position', jobCodeId: 'job_bbk' }, quick: false, templateId: 'stk_demo_nightly', eightySixListId: bar,
    status: 'in_progress', createdBy: mgr, createdAt: at(120), updatedAt: at(15), assignedBy: mgr, assignedAt: at(120), startedAt: started,
    log: [{ at: at(120), by: mgr, what: 'created' }, ...fri.filter((x) => x.state).map((x) => ({ at: x.at, by: arthur, what: 'mark', lineId: x.id, state: x.state, ...(x.state === 'short' ? { brought: x.brought } : {}) }))],
  });
  // Every barback on today's schedule: the patio, not started.
  store.insert('stockLists', {
    id: 'stk_demo_patio_today', kind: 'list', name: 'Patio open', notes: '', lines: [line('cups', 2), line('straws', 1), line('napkins', 2), line('sanitizer', 1)], date: d, due: '17:00',
    assign: { type: 'position', jobCodeId: 'job_bbk' }, quick: false, templateId: 'stk_demo_patio', eightySixListId: bar,
    status: 'open', createdBy: mgr, createdAt: at(90), updatedAt: at(90), assignedBy: mgr, assignedAt: at(90), log: [{ at: at(90), by: mgr, what: 'created' }],
  });
  // Yesterday's, done: one short.
  const luciano = user('Luciano') || arthur;
  const y = [line('rum', 2), line('vodka', 2), line('gin', 1), line('limes', 1), line('napkins', 2)]
    .map((x, i) => ({ ...x, state: i === 3 ? 'short' : 'got', brought: i === 3 ? 0.5 : x.qty, by: luciano, at: at(60 * 24 - i * 3) }));
  store.insert('stockLists', {
    id: 'stk_demo_done', kind: 'list', name: 'Nightly bar restock', notes: '', lines: y, date: todayStr(new Date(now.getTime() - 86400000)), due: '16:30',
    assign: { type: 'person', userId: luciano }, quick: false, templateId: 'stk_demo_nightly', eightySixListId: bar,
    status: 'done', createdBy: mgr, createdAt: at(60 * 26), updatedAt: at(60 * 24 - 12), assignedBy: mgr, assignedAt: at(60 * 26), startedAt: at(60 * 24),
    doneAt: at(60 * 24 - 12), doneBy: luciano, toldDone: at(60 * 24 - 12), log: [{ at: at(60 * 26), by: mgr, what: 'created' }],
  });
}
