// The 86 List refocused on ingredients and supplies (menu suggestions off and migrated once, past reports suggested,
// categories remembered per name), and Reports → 86 List: missing now, the shopping list, history across seasons,
// trends, CSV, who may read it, and plan gating on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { MENU_NONE_MIGRATION, DEFAULT_CATEGORIES, categoriesOf } from '../core/eighty-six.js';
import { groupMissing, shoppingList, missingCsv, historyCsv, csvCell, eightySixStats, rangeOf, minutesBetween } from '../core/reports-86.js';
import { canSeeReports } from '../core/reports.js';
import { featuresForMethod, resolveFeatures } from '../server/platform/plans.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { tokenFor } from './helpers/signin.js';

function fresh({ lists } = {}) {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, departments: ['Leadership', 'Restaurant', 'Bar', 'Kitchen'], areas: ['Dining Room'] });
  const job = (id, name, department) => store.insert('jobCodes', { id, name, short: name.slice(0, 3), department, order: 0, archived: false });
  job('job_mgr', 'Manager', 'Leadership'); job('job_srv', 'Server', 'Restaurant'); job('job_bar', 'Bartender', 'Bar'); job('job_cook', 'Line Cook', 'Kitchen');
  const user = (id, role, jobs) => store.insert('users', { id, name: id, role, active: true, email: `${id}@t.local`, jobCodes: jobs.map((jobCodeId) => ({ jobCodeId })) });
  user('admin', 'admin', ['job_mgr']); user('mgr', 'manager', ['job_mgr']); user('sup', 'supervisor', ['job_srv']);
  user('srv', 'employee', ['job_srv']); user('bar', 'employee', ['job_bar']); user('cook', 'employee', ['job_cook']);
  for (const l of lists || []) store.insert('eightySixLists', l);
  const clock = { now: new Date('2026-11-20T18:00:00') };
  const svc = createService(store, { now: () => clock.now });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  const at = (iso) => { clock.now = new Date(iso); };
  const list = (who, name) => as(who)('eightySix.board.get').lists.find((l) => l.name === name);
  return { store, svc, clock, as, at, list, admin: as('admin'), mgr: as('mgr') };
}
const old = (id, name, kind, menu, extra = {}) => ({ id, name, nameEs: '', kind, area: '', menu, sections: [], reporters: { departments: [kind === 'bar' ? 'Bar' : 'Kitchen'], jobCodeIds: [] },
  viewers: { all: true }, notify: false, notifyLow: false, resetAt: '', order: kind === 'bar' ? 0 : 1, createdAt: '2025-01-01T00:00:00.000Z', ...extra });

test('menu suggestions: old lists stop suggesting menu items once (a marker per restaurant); new lists start with none', () => {
  const f = fresh({ lists: [old('l_bar', 'Bar', 'bar', 'drinks'), old('l_kit', 'Kitchen', 'kitchen', 'food', { sections: ['Mains'] }), old('l_prep', 'Prep', 'other', 'none')] });
  f.mgr('menu.save', { name: 'Margarita', category: 'Cocktails' });
  f.mgr('menu.save', { name: 'Steak', category: 'Mains' });
  // The first read migrates.
  const board = f.as('bar')('eightySix.board.get');
  assert.deepEqual(board.lists.map((l) => [l.name, l.suggest.length]), [['Bar', 0], ['Kitchen', 0], ['Prep', 0]]);
  assert.deepEqual(f.store.list('eightySixLists').map((l) => [l.id, l.menu, l.sections]).sort(), [['l_bar', 'none', []], ['l_kit', 'none', []], ['l_prep', 'none', []]]);
  const marker = f.store.get('migrations', MENU_NONE_MIGRATION);
  assert.deepEqual(marker.lists, [{ id: 'l_bar', menu: 'drinks', sections: [] }, { id: 'l_kit', menu: 'food', sections: ['Mains'] }], 'what each list had, kept');
  // Once: an admin turning it back on stays on.
  f.admin('eightySix.saveList', { id: 'l_bar', menu: 'drinks' });
  f.as('srv')('eightySix.summary');
  f.as('srv')('eightySix.board.get');
  assert.equal(f.store.get('eightySixLists', 'l_bar').menu, 'drinks');
  assert.equal(f.list('bar', 'Bar').suggest.length, 1);
  assert.equal(f.store.list('migrations', (m) => m.id === MENU_NONE_MIGRATION).length, 1);
  // A list added later starts with no menu suggestions.
  assert.equal(f.admin('eightySix.saveList', { name: 'Rooftop', kind: 'bar' }).menu, 'none');
  // A brand-new restaurant: defaults with none, and the marker so nothing runs again.
  const g = fresh();
  assert.deepEqual(g.admin('eightySix.settings.get').lists.map((l) => l.menu), ['none', 'none']);
  assert.ok(g.store.get('migrations', MENU_NONE_MIGRATION));
});

test('menu links: only lists that suggest menu items link new reports; items linked before keep the Training badge', () => {
  const f = fresh({ lists: [old('l_bar', 'Bar', 'bar', 'drinks')] });
  const marg = f.mgr('menu.save', { name: 'Margarita', category: 'Cocktails' });
  // An item linked back when the Bar suggested drinks.
  f.store.insert('eightySixItems', { id: 'e86_old', listId: 'l_bar', name: 'Margarita', key: `m:${marg.id}`, menuItemId: marg.id, status: 'out', count: null, note: '',
    area: '', reportedBy: 'bar', reportedAt: '2026-11-20T17:00:00.000Z', outAt: '2026-11-20T17:00:00.000Z', updatedBy: 'bar', updatedAt: '2026-11-20T17:00:00.000Z' });
  assert.deepEqual(f.as('srv')('eightySix.summary').outMenuItemIds, [marg.id], 'the old link still shows "86’d today" in Training');
  // Typing the menu item's name again updates that item instead of adding a second line.
  const again = f.as('bar')('eightySix.report', { listId: 'l_bar', name: 'margarita', status: 'low', count: 2 });
  assert.deepEqual([again.updated, again.item.id, again.item.menuItemId], [true, 'e86_old', marg.id]);
  // Anything new on a list that doesn't suggest menu items stays plain text, even a menu item's name or id.
  f.mgr('menu.save', { name: 'Mojito', category: 'Cocktails' });
  const mojito = f.as('bar')('eightySix.report', { listId: 'l_bar', name: 'Mojito' }).item;
  assert.equal(mojito.menuItemId, null);
  const viaId = f.as('bar')('eightySix.report', { listId: 'l_bar', menuItemId: f.store.list('menuItems', (m) => m.name === 'Mojito')[0].id, name: 'Mojito' });
  assert.deepEqual([viaId.updated, viaId.item.menuItemId], [true, null], 'the same plain item');
  const sum = f.as('srv')('eightySix.summary');
  assert.equal(sum.out, 1, 'Mojito is out (Margarita is low now)');
  assert.deepEqual([sum.outMenuItemIds, sum.lowMenuItemIds], [[], [marg.id]], 'a typed name is no menu link');
});

test('the report form suggests what was reported on that list before, most often first; categories are remembered per name', () => {
  const f = fresh({ lists: [old('l_bar', 'Bar', 'bar', 'none'), old('l_kit', 'Kitchen', 'kitchen', 'none')] });
  const report = (who, listId, args) => f.as(who)('eightySix.report', { listId, ...args }).item;
  const cycle = (listId, args, who = 'bar') => { const it = report(who, listId, args); f.as(who)('eightySix.clear', { id: it.id }); return it; };
  for (let i = 0; i < 3; i++) cycle('l_bar', { name: 'Limes' });
  cycle('l_bar', { name: 'CO2', status: 'low', count: 1 });
  for (let i = 0; i < 2; i++) cycle('l_bar', { name: 'Bacardi' });
  f.at('2026-11-20T19:00:00');
  cycle('l_bar', { name: 'co 2' }); // the same name, typed differently
  cycle('l_kit', { name: 'Flour' }, 'cook');
  const bar = f.list('bar', 'Bar');
  assert.deepEqual(bar.recent.map((r) => [r.name, r.times]), [['Limes', 3], ['co 2', 2], ['Bacardi', 2]], 'most often first, the latest spelling, ties by the latest');
  assert.deepEqual(f.list('bar', 'Kitchen').recent, [], 'only for lists you report on');
  assert.deepEqual(f.list('cook', 'Kitchen').recent.map((r) => r.name), ['Flour']);
  assert.deepEqual(f.list('srv', 'Bar').recent, []);

  // Categories: the built-in set, then remembered per item name across lists and spellings.
  assert.deepEqual(f.as('bar')('eightySix.board.get').categories.map((c) => c.id), DEFAULT_CATEGORIES.map((c) => c.id));
  assert.ok(DEFAULT_CATEGORIES.some((c) => c.id === 'glassware' && c.en === 'Glassware & smallwares'));
  const limes = report('bar', 'l_bar', { name: 'Limes', category: 'produce' });
  assert.equal(limes.category, 'produce');
  f.as('bar')('eightySix.clear', { id: limes.id });
  assert.equal(report('bar', 'l_bar', { name: 'LIMES' }).category, 'produce', 'the second time (the phone sends no category), it’s filled in');
  assert.equal(report('mgr', 'l_kit', { name: 'limes', status: 'low' }).category, 'produce', 'on another list too');
  assert.equal(f.list('bar', 'Bar').recent[0].category, 'produce', 'suggestions carry it, so the form pre-fills it');
  assert.deepEqual(f.as('bar')('eightySix.board.get').known, [{ name: 'Limes', category: 'produce' }]);
  assert.equal(report('bar', 'l_bar', { name: 'Rocks glasses', category: 'nope' }).category, '', 'an unknown category is none');
  assert.equal(report('bar', 'l_bar', { name: 'Limes', category: '' }).category, '', 'chosen “none” on purpose');

  // Admins rename and add categories; built-in ones keep following the translation unless renamed.
  assert.throws(() => f.mgr('eightySix.saveCategories', { categories: [] }), /Admins only/);
  assert.throws(() => f.admin('eightySix.saveCategories', { categories: [{ name: ' ' }] }), /Every category needs a name/);
  const cats = f.admin('eightySix.saveCategories', { categories: [{ id: 'produce', name: 'Produce', nameEs: 'Frutas y verduras' }, { id: 'liquor', name: 'Spirits', nameEs: '' }, { name: 'Coffee', nameEs: 'Café' }] }).categories;
  assert.deepEqual(cats.map((c) => [c.name, c.nameEs]), [['Produce', 'Frutas y verduras'], ['Spirits', 'Licores, cerveza y vino'], ['Coffee', 'Café'], ['Other', 'Otros']], 'Other always stays');
  assert.deepEqual(f.store.get('eightySixConfig', 'categories').list.slice(0, 2), [{ id: 'produce', name: '', nameEs: '' }, { id: 'liquor', name: 'Spirits', nameEs: '' }]);
  assert.match(cats[2].id, /^e86c_/);
  assert.equal(categoriesOf(f.store).length, 4);
});

test('missing now: every list (hidden ones too) for managers, with how long; grouped by category or list', () => {
  const f = fresh({ lists: [old('l_bar', 'Bar', 'bar', 'none'), old('l_kit', 'Kitchen', 'kitchen', 'none'),
    old('l_store', 'Storeroom', 'other', 'none', { viewers: { departments: ['Leadership'] }, reporters: { departments: ['Leadership'] }, order: 2 })] });
  f.at('2026-11-20T15:00:00');
  f.mgr('eightySix.report', { listId: 'l_store', name: 'Receipt paper', status: 'low', count: 3, category: 'paper' });
  f.at('2026-11-20T16:00:00');
  f.as('bar')('eightySix.report', { listId: 'l_bar', name: 'Limes', status: 'low', count: 4, category: 'produce' });
  f.at('2026-11-20T17:00:00');
  f.as('bar')('eightySix.report', { listId: 'l_bar', name: 'Limes' }); // ran out at 5pm
  f.as('cook')('eightySix.report', { listId: 'l_kit', name: 'To-go cups', category: 'paper', note: 'use the 12 oz' });
  f.as('cook')('eightySix.report', { listId: 'l_kit', name: 'Mystery', status: 'low' });
  f.at('2026-11-20T18:30:00');
  assert.throws(() => f.as('srv')('reports.eightySix.missing.get'), /Managers only/);
  assert.throws(() => f.as('sup')('reports.eightySix.missing.get'), /Managers only/, 'supervisors don’t get Reports');
  assert.throws(() => f.svc.call(null, 'reports.eightySix.missing.get'), /Please sign in/);
  assert.equal(f.as('cook')('eightySix.board.get').lists.some((l) => l.name === 'Storeroom'), false, 'staff never see the hidden list');
  const m = f.mgr('reports.eightySix.missing.get');
  assert.deepEqual(m.totals, { out: 2, low: 2 });
  assert.deepEqual(m.lists.map((l) => [l.name, l.hidden, l.out, l.low]), [['Bar', false, 1, 0], ['Kitchen', false, 1, 1], ['Storeroom', true, 0, 1]]);
  assert.deepEqual(m.items.map((i) => [i.name, i.status, i.minutes]), [['Limes', 'out', 90], ['To-go cups', 'out', 90], ['Receipt paper', 'low', 210], ['Mystery', 'low', 90]],
    'out first, then low; the longest missing first; time since it ran out (not since it ran low)');
  const limes = m.items[0];
  assert.deepEqual([limes.reportedBy.name, limes.updatedBy.name, limes.listName, limes.category, limes.since], ['bar', 'bar', 'Bar', 'produce', new Date('2026-11-20T17:00:00').toISOString()]);
  assert.equal(m.items[1].note, 'use the 12 oz');
  // By category: the restaurant's order, then "No category". By list: the lists' order.
  const byCat = groupMissing(m.items, { by: 'category', categories: m.categories, lists: m.lists });
  assert.deepEqual(byCat.map((g) => [g.label, g.items.map((i) => i.name), g.out, g.low]), [['Produce', ['Limes'], 1, 0], ['Paper & disposables', ['To-go cups', 'Receipt paper'], 1, 1], ['No category', ['Mystery'], 0, 1]]);
  assert.equal(groupMissing(m.items, { by: 'category', categories: m.categories, lang: 'es' })[2].label, 'Sin categoría');
  const byList = groupMissing(m.items, { by: 'list', categories: m.categories, lists: m.lists, lang: 'es' });
  assert.deepEqual(byList.map((g) => [g.id, g.items.length]), [['l_bar', 1], ['l_kit', 2], ['l_store', 1]]);
  assert.deepEqual(f.mgr('reports.eightySix.missing.get', { listId: 'l_store' }).items.map((i) => i.name), ['Receipt paper']);
  assert.equal(minutesBetween('2026-11-20T17:00:00Z', '2026-11-20T16:00:00Z'), 0, 'never negative');
});

test('the shopping list: by category, out and low on one line, the same item on two lists once; in Spanish', () => {
  const cats = [{ id: 'produce', name: 'Produce', nameEs: 'Frutas y verduras' }, { id: 'dairy', name: 'Dairy', nameEs: 'Lácteos' }, { id: 'other', name: 'Other', nameEs: 'Otros' }];
  const items = [
    { listId: 'a', name: 'oat milk', category: 'dairy', status: 'out' },
    { listId: 'a', name: 'Limes', category: 'produce', status: 'out' },
    { listId: 'a', name: 'CO2', category: 'other', status: 'low', count: 1 },
    { listId: 'b', name: 'limes', category: '', status: 'low', count: 2 }, // out on the bar: stays out
    { listId: 'b', name: 'Mint', category: 'produce', status: 'low', count: 3 },
    { listId: 'a', name: 'Mint', category: 'produce', status: 'low', count: 1 }, // the smaller count
    { listId: 'b', name: 'Napkins', category: '', status: 'low', count: null },
  ];
  assert.equal(shoppingList(items, { categories: cats, date: 'Fri, Nov 20', place: 'Copper Fox' }), [
    'Copper Fox: what we need · Fri, Nov 20',
    '', 'PRODUCE', 'OUT: Limes · LOW: Mint (1 left)',
    '', 'DAIRY', 'OUT: oat milk',
    '', 'OTHER', 'LOW: CO2 (1 left)',
    '', 'NO CATEGORY', 'LOW: Napkins',
  ].join('\n'));
  assert.equal(shoppingList(items, { categories: cats, lang: 'es', date: 'vie, 20 de nov' }).split('\n').slice(0, 4).join('\n'),
    'Lo que necesitamos · vie, 20 de nov\n\nFRUTAS Y VERDURAS\nAGOTADO: Limes · QUEDA POCO: Mint (queda 1)');
  assert.match(shoppingList([{ name: 'CO2', status: 'low', count: 3, category: 'other' }], { categories: cats, lang: 'es' }), /QUEDA POCO: CO2 \(quedan 3\)/);
  assert.equal(shoppingList([], { categories: cats }), 'What we need\n\nNothing is out or running low.');
});

test('CSV: quoted cells, formulas neutralised, accents readable; missing now and history in either language', () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), '"\'+1"');
  assert.equal(csvCell(null), '""');
  const cats = [{ id: 'produce', name: 'Produce', nameEs: 'Frutas y verduras' }];
  const lists = [{ id: 'l1', name: 'Bar', nameEs: 'Barra' }];
  const rows = [{ listId: 'l1', name: 'Limes', category: 'produce', status: 'low', count: 2, since: '2026-11-20T16:00:00.000Z', reportedBy: { name: 'Ana' }, note: 'order, Tuesday', photos: [{}] }];
  const csv = missingCsv(rows, { categories: cats, lists, now: '2026-11-20T19:30:00.000Z' });
  assert.ok(csv.startsWith('﻿"Status","Item","Category","List","Left"'));
  assert.equal(csv.split('\r\n')[1], '"Running low","Limes","Produce","Bar","2","2026-11-20T16:00:00.000Z","3.5","Ana","order, Tuesday","1"');
  const es = missingCsv(rows, { categories: cats, lists, lang: 'es', now: '2026-11-20T19:30:00.000Z' });
  assert.match(es, /"Estado","Artículo","Categoría"/);
  assert.match(es, /"Queda poco","Limes","Frutas y verduras","Barra"/);
  const h = historyCsv({ items: [{ name: 'Limes', category: 'produce', lists: ['l1'], outs: 3, lows: 1, backs: 2, outMinutes: 300, avgOutMinutes: 150, stillOut: true, lastAt: 'x' }] }, { categories: cats, lists });
  assert.equal(h.split('\r\n')[1], '"Limes","Produce","Bar","3","1","5.0","2.5","yes","x"');
});

test('history: a season, the last days or two dates, across the Winter–Summer boundary; numbers per item, list, category, day, person', () => {
  const f = fresh({ lists: [old('l_bar', 'Bar', 'bar', 'none'), old('l_kit', 'Kitchen', 'kitchen', 'none')] });
  const episode = (who, listId, name, outIso, backIso, args = {}) => {
    f.at(outIso);
    const it = f.as(who)('eightySix.report', { listId, name, ...args }).item;
    if (backIso) { f.at(backIso); f.as(who)('eightySix.clear', { id: it.id }); }
    return it;
  };
  // Winter 2025–26 ends April 30; Summer 2026 starts May 1 (local time).
  episode('bar', 'l_bar', 'Limes', '2026-04-30T21:00:00', '2026-05-01T09:00:00', { category: 'produce' }); // Thursday, winter, out 12 h
  episode('bar', 'l_bar', 'Limes', '2026-05-01T18:00:00', '2026-05-01T20:00:00'); // Friday, summer, out 2 h
  episode('bar', 'l_bar', 'limes', '2026-05-08T18:00:00', '2026-05-08T22:00:00'); // Friday, out 4 h
  episode('bar', 'l_bar', 'Limes', '2026-06-05T18:00:00', '2026-06-06T00:00:00'); // Friday, out 6 h
  episode('bar', 'l_bar', 'CO2', '2026-05-02T19:00:00', '2026-05-03T10:00:00', { status: 'low', count: 1, category: 'other' }); // Saturday, low only
  episode('cook', 'l_kit', 'Flour', '2026-03-10T12:00:00', '2026-03-10T15:00:00', { category: 'dry' }); // winter
  f.at('2026-07-01T17:00:00');
  f.as('cook')('eightySix.report', { listId: 'l_kit', name: 'Fryer oil', status: 'low', count: 2 }); // ran low…
  f.at('2026-07-01T20:00:00');
  f.as('cook')('eightySix.report', { listId: 'l_kit', name: 'Fryer oil' }); // …then out, still out
  f.at('2026-07-04T12:00:00');

  assert.throws(() => f.as('bar')('reports.eightySix.history.get'), /Managers only/);
  assert.throws(() => f.as('sup')('reports.eightySix.history.get', { season: 'summer-2026' }), /Managers only/);
  assert.throws(() => f.mgr('reports.eightySix.history.get', { season: 'monsoon-2026' }), /Pick a season/);
  assert.throws(() => f.mgr('reports.eightySix.history.get', { from: '2026-01-01' }), /Pick a start and end date/);

  const summer = f.mgr('reports.eightySix.history.get', {}); // this season by default
  assert.deepEqual(summer.range, { kind: 'season', seasonId: 'summer-2026', from: '2026-05-01', to: '2026-10-31' });
  assert.deepEqual(summer.seasons.map((s) => s.id), ['summer-2026', 'winter-2025']);
  const t = summer.totals;
  assert.deepEqual([t.reports, t.outs, t.lows, t.items, t.backs, t.outMinutes, t.avgOutMinutes, t.stillOut], [5, 4, 1, 3, 3, 720, 240, 1]);
  assert.deepEqual(summer.items.map((x) => [x.name, x.outs, x.lows, x.backs, x.avgOutMinutes]), [['Limes', 3, 0, 3, 240], ['Fryer oil', 1, 0, 0, null], ['CO2', 0, 1, 0, null]]);
  assert.equal(summer.items[0].category, 'produce', 'remembered from the first report');
  assert.deepEqual(summer.repeat.map((x) => [x.name, x.outs]), [['Limes', 3]], 'out 3 times this season');
  assert.deepEqual(summer.byList.map((l) => [l.name, l.outs, l.lows]), [['Bar', 3, 1], ['Kitchen', 1, 0]]);
  assert.deepEqual(summer.byCategory.map((c) => [c.category, c.outs, c.lows]), [['produce', 3, 0], ['', 1, 0], ['other', 0, 1]]);
  assert.deepEqual(summer.byWeekday.map((d) => d.outs + d.lows), [0, 0, 0, 1, 0, 3, 1], 'Fridays; the fryer oil ran out on a Wednesday');
  assert.deepEqual(summer.reporters.map((p) => [p.name, p.reports]), [['bar', 4], ['cook', 1]]);

  const winter = f.mgr('reports.eightySix.history.get', { season: 'winter-2025' });
  assert.deepEqual([winter.range.from, winter.range.to], ['2025-11-01', '2026-04-30']);
  assert.deepEqual(winter.items.map((x) => [x.name, x.outs, x.outMinutes]), [['Limes', 1, 720], ['Flour', 1, 180]], 'April 30 is winter, even though it came back in May');
  const days = f.mgr('reports.eightySix.history.get', { days: 7 });
  assert.deepEqual([days.range.from, days.range.to, days.totals.reports], ['2026-06-28', '2026-07-04', 1]);
  const dates = f.mgr('reports.eightySix.history.get', { from: '2026-05-08', to: '2026-04-01', listId: 'l_bar' });
  assert.deepEqual([dates.range.from, dates.range.to, dates.totals.reports, dates.listId], ['2026-04-01', '2026-05-08', 4, 'l_bar']);
  assert.match(historyCsv(summer, { categories: summer.categories, lists: summer.lists }), /"Limes","Produce","Bar","3","0","12.0","4.0","no"/);
  assert.equal(rangeOf({}, '2026-01-15', {}).seasonId, 'winter-2025');
});

test('trends: a season against the same season last year, the same number of days in', () => {
  const f = fresh({ lists: [old('l_bar', 'Bar', 'bar', 'none')] });
  const out = (iso, name) => { f.at(iso); const it = f.as('bar')('eightySix.report', { listId: 'l_bar', name }).item; f.at(iso.replace('T18', 'T22')); f.as('bar')('eightySix.clear', { id: it.id }); };
  out('2025-05-10T18:00:00', 'Limes');
  out('2025-06-20T18:00:00', 'Mint');
  out('2025-09-01T18:00:00', 'Limes'); // after the point we've reached this year
  out('2026-05-09T18:00:00', 'Limes');
  out('2026-05-20T18:00:00', 'Limes');
  out('2026-06-01T18:00:00', 'Rosé');
  f.at('2026-06-30T12:00:00');
  const tr = f.mgr('reports.eightySix.trends.get');
  assert.deepEqual([tr.season.id, tr.season.to, tr.last.id, tr.last.to, tr.partial], ['summer-2026', '2026-06-30', 'summer-2025', '2025-06-30', true]);
  assert.deepEqual([tr.totals.now.outs, tr.totals.then.outs, tr.totals.lastWhole.outs], [3, 2, 3]);
  assert.deepEqual(tr.items.map((x) => [x.name, x.nowOuts, x.thenOuts, x.change]), [['Limes', 2, 1, 1], ['Rosé', 1, 0, 1], ['Mint', 0, 1, -1]], 'biggest change first, then the busiest');
  assert.equal(tr.newThisYear, 1);
  assert.equal(f.mgr('reports.eightySix.trends.get', { season: 'summer-2025' }).last.id, 'summer-2024');
  assert.throws(() => f.as('srv')('reports.eightySix.trends.get'), /Managers only/);
});

test('who may open Reports, and the plan: reports.* needs Reports, the 86 report needs the 86 List too', async () => {
  assert.deepEqual([['employee'], ['supervisor'], ['manager'], ['admin'], ['super_admin']].map(([role]) => canSeeReports({ role })), [false, false, true, true, true]);
  assert.deepEqual(featuresForMethod('reports.eightySix.history.get'), ['reports', 'eightySix']);
  assert.deepEqual(featuresForMethod('eightySix.board.get'), ['eightySix']);
  assert.equal(resolveFeatures('starter').reports, true, 'every plan has Reports');
  assert.equal(resolveFeatures('pro').reports, true);
  const serve = async (features) => {
    const conn = await openPglite();
    const tenant = { id: 't1', slug: 'bistro', name: 'Bistro', isDefault: true, status: 'active', plan: 'starter', features: { ...resolveFeatures('starter'), ...features } };
    const app = createApp({ db: new DocDb(conn), env: { SEED_DEMO: 'true', JWT_SECRET: `t-${Math.random()}` }, tenant });
    await app.locals.ready();
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const as = async (email) => {
      const token = await tokenFor(base, email);
      return async (method, args = {}) => {
        const res = await fetch(`${base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
        return { status: res.status, body: await res.json() };
      };
    };
    return { as, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); } };
  };
  const on = await serve({});
  try {
    const kelly = await on.as('kelly@demo.shiftboard');
    const m = await kelly('reports.eightySix.missing.get');
    assert.equal(m.status, 200);
    assert.ok(m.body.result.lists.some((l) => l.hidden), 'the Storeroom, hidden from staff, is in the manager’s report');
    assert.equal((await kelly('reports.eightySix.history.get', { days: 30 })).status, 200);
    const alex = await on.as('alexd@demo.shiftboard');
    const no = await alex('reports.eightySix.missing.get');
    assert.equal(no.status, 403);
    await alex('account.preferences', { language: 'es' });
    assert.equal((await alex('reports.eightySix.trends.get')).body.error, 'Solo para gerentes');
  } finally { await on.close(); }
  for (const off of [{ reports: false }, { eightySix: false }]) {
    const s = await serve(off);
    try {
      const moe = await s.as('moe@demo.shiftboard');
      const r = await moe('reports.eightySix.missing.get');
      assert.equal(r.status, 403, JSON.stringify(off));
      assert.equal(r.body.error, 'Not included in your plan');
      const boot = (await moe('app.bootstrap')).body.result;
      assert.equal(boot.tenant.features.reports, !('reports' in off));
    } finally { await s.close(); }
  }
});
