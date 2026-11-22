// The 86 List: per-list report and clear permissions (the bar's list for bar staff and managers), visibility limits,
// the nightly reset, notifications to the people on shift today, the managers' history, settings, the demo, the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { TEXT, PHOTOS_PER_ITEM, KEEP_PHOTOS_DAYS, eightySixPhotoFor } from '../core/eighty-six.js';
import { PHOTO_MAX_BYTES } from '../core/training.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';

// A small restaurant: managers, a supervisor, servers (one reads Spanish), two bartenders, a barback and a cook.
function fresh() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Bistro', departments: ['Leadership', 'Restaurant', 'Bar', 'Kitchen'], areas: ['Dining Room', 'Rooftop'] });
  const job = (id, name, department, defaultRole = 'employee') => store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), department, defaultRole, order: 0, archived: false });
  job('job_mgr', 'Manager', 'Leadership', 'manager');
  job('job_srv', 'Server', 'Restaurant');
  job('job_bar', 'Bartender', 'Bar');
  job('job_bbk', 'Barback', 'Bar');
  job('job_cook', 'Line Cook', 'Kitchen');
  const user = (id, role, jobs, extra = {}) => store.insert('users', { id, name: id, role, active: true, email: `${id}@test.local`, phone: '', availability: {},
    jobCodes: jobs.map((jobCodeId) => ({ jobCodeId })), ...extra });
  user('admin', 'admin', ['job_mgr']);
  user('mgr', 'manager', ['job_mgr']);
  user('sup', 'supervisor', ['job_srv']);
  user('srv', 'employee', ['job_srv']);
  user('srv2', 'employee', ['job_srv']);
  user('esp', 'employee', ['job_srv'], { language: 'es' });
  user('bar', 'employee', ['job_bar']);
  user('bar2', 'employee', ['job_bar']);
  user('bbk', 'employee', ['job_bbk']);
  user('cook', 'employee', ['job_cook']);
  const clock = { now: new Date('2026-11-20T15:00:00') }; // a Friday afternoon
  const svc = createService(store, { now: () => clock.now });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  const board = (id) => as(id)('eightySix.board.get');
  const list = (id, name) => board(id).lists.find((l) => l.name === name);
  return { store, svc, clock, as, board, list, admin: as('admin'), mgr: as('mgr') };
}
function withMenu() {
  const f = fresh();
  f.menu = {};
  for (const [name, category, es] of [['Margarita', 'Cocktails', 'Margarita'], ['House Red', 'Wine', 'Tinto de la casa'], ['Fries', 'Sides', 'Papas fritas'], ['Steak', 'Mains', 'Bistec']]) {
    f.menu[name] = f.admin('menu.save', { name, category, es: { name: es } });
  }
  f.admin('menu.save', { name: 'Old Special', category: 'Mains', eightySixed: true });
  return f;
}
const shift = (f, userId, date, start, end, published = true) => f.store.insert('shifts', { date, start, end, userId, jobCodeId: f.store.get('users', userId).jobCodes[0].jobCodeId, area: '', tag: '', notes: '', breakMin: 0, published });
const jpeg = (bytes = 200) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes - 4, 7)]).toString('base64')}`;
const notes = (f, id) => f.store.list('notifications', (n) => n.userId === id && n.link === '#/86');

test('default lists: Bar for bar staff plus managers, Kitchen for the kitchen and front of house; everyone sees both', () => {
  const f = withMenu();
  const names = (id) => f.board(id).lists.map((l) => `${l.name}${l.canReport ? '+' : ''}`);
  assert.deepEqual(names('bar'), ['Bar+', 'Kitchen']);
  assert.deepEqual(names('bbk'), ['Bar+', 'Kitchen'], 'barbacks report on the bar too');
  assert.deepEqual(names('srv'), ['Bar', 'Kitchen+'], 'servers see what the bar is out of, and report food');
  assert.deepEqual(names('sup'), ['Bar', 'Kitchen+']);
  assert.deepEqual(names('cook'), ['Bar', 'Kitchen+']);
  assert.deepEqual(names('mgr'), ['Bar+', 'Kitchen+'], 'managers report on every list');
  const bar = f.list('bar', 'Bar'), kitchen = f.list('bar', 'Kitchen');
  assert.equal(bar.kind, 'bar');
  assert.equal(f.list('srv', 'Kitchen').nameEs, 'Cocina');
  // The Bar suggests the drinks on the Training menu; the Kitchen the food. Not what's off the menu.
  const menuName = (b, id) => b.menu[id].name;
  const b = f.board('bar');
  assert.deepEqual(bar.suggest.map((id) => menuName(b, id)).sort(), ['House Red', 'Margarita']);
  assert.deepEqual(kitchen.suggest.map((id) => menuName(b, id)).sort(), ['Fries', 'Steak']);

  // Reporting is checked per list on the server.
  assert.throws(() => f.as('srv')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace' }), /can’t report on this list/);
  assert.throws(() => f.as('sup')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace' }), /can’t report on this list/, 'a supervisor on the floor is not bar staff');
  assert.throws(() => f.as('bar')('eightySix.report', { listId: kitchen.id, name: 'Fries' }), /can’t report on this list/);
  const bt = f.as('bar')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace' }).item;
  const fries = f.as('srv')('eightySix.report', { listId: kitchen.id, menuItemId: f.menu.Fries.id }).item;
  f.mgr('eightySix.report', { listId: bar.id, name: 'Limes', status: 'low' });
  f.mgr('eightySix.report', { listId: kitchen.id, name: 'Steak' });
  // Clearing: the list's reporters or managers.
  assert.throws(() => f.as('srv')('eightySix.clear', { id: bt.id }), /can’t report on this list/);
  assert.throws(() => f.as('cook')('eightySix.clear', { id: bt.id }), /can’t report on this list/);
  assert.throws(() => f.as('bar')('eightySix.clear', { id: fries.id }), /can’t report on this list/);
  assert.equal(f.as('bbk')('eightySix.clear', { id: bt.id }).ok, true);
  assert.equal(f.mgr('eightySix.clear', { id: fries.id }).ok, true);
  assert.deepEqual(f.list('srv', 'Bar').items.map((i) => i.name), ['Limes']);
  assert.throws(() => f.svc.call(null, 'eightySix.board.get'), /Please sign in/);
});

test('reporting: menu items or free text, the same thing twice updates it, a count and a note, back in stock with undo', () => {
  const f = withMenu();
  const bar = f.list('bar', 'Bar');
  const report = (args) => f.as('bar')('eightySix.report', { listId: bar.id, ...args });
  const first = report({ name: '  Buffalo   Trace ', note: 'use Maker’s' });
  assert.equal(first.updated, false);
  assert.equal(first.item.name, 'Buffalo Trace');
  assert.equal(first.item.status, 'out');
  assert.equal(first.item.reportedBy.name, 'bar');
  assert.equal(first.item.reportedAt, f.clock.now.toISOString());
  f.clock.now = new Date('2026-11-20T15:20:00');
  const again = f.as('bar2')('eightySix.report', { listId: bar.id, name: 'buffalo trace', status: 'low', count: '3', note: 'back Friday' });
  assert.equal(again.updated, true);
  assert.equal(again.item.id, first.item.id, 'the same item, not a second line');
  assert.deepEqual([again.item.status, again.item.count, again.item.note, again.item.updatedBy.name, again.item.reportedBy.name], ['low', 3, 'back Friday', 'bar2', 'bar']);
  assert.equal(f.list('srv', 'Bar').items.length, 1);
  // A typed name that's on the menu (in either language) links to the menu item.
  f.clock.now = new Date('2026-11-20T15:21:00');
  const marg = report({ name: 'margarita' }).item;
  assert.equal(marg.menuItemId, f.menu.Margarita.id);
  f.clock.now = new Date('2026-11-20T15:22:00');
  const red = report({ name: 'Tinto de la Casa', status: 'low', count: 0 }).item;
  assert.deepEqual([red.name, red.nameEs, red.menuItemId, red.count], ['House Red', 'Tinto de la casa', f.menu['House Red'].id, 0]);
  assert.equal(report({ menuItemId: f.menu.Margarita.id, note: 'no limes' }).updated, true);
  // Out first, then running low; newest first.
  assert.deepEqual(f.list('srv', 'Bar').items.map((i) => `${i.name}:${i.status}`), ['Margarita:out', 'House Red:low', 'Buffalo Trace:low']);
  // Area tag: one of the restaurant's areas, or nothing.
  assert.equal(report({ name: 'Rye', area: 'rooftop' }).item.area, 'Rooftop');
  assert.equal(report({ name: 'Gin', area: 'Narnia' }).item.area, '');
  assert.throws(() => report({ name: '   ' }), /Say what’s out/);
  assert.throws(() => report({ name: 'Ice', status: 'low', count: '2.5' }), /whole number/);
  assert.throws(() => report({ listId: 'nope', name: 'Ice' }), /List not found/);

  // Back in stock, then undo.
  const cleared = f.as('bar2')('eightySix.clear', { id: marg.id });
  assert.equal(cleared.name, 'Margarita');
  assert.ok(!f.list('srv', 'Bar').items.some((i) => i.id === marg.id));
  assert.throws(() => f.as('bar2')('eightySix.clear', { id: marg.id }), /isn’t on the list anymore/);
  assert.throws(() => f.as('srv')('eightySix.restore', { id: marg.id }), /can’t report on this list/);
  const back = f.as('bar')('eightySix.restore', { id: marg.id }).item;
  assert.deepEqual([back.id, back.status, back.note], [marg.id, 'out', 'no limes']);
  assert.throws(() => f.as('bar')('eightySix.restore', { id: marg.id }), /can’t be undone/);
  // Undo works for an hour, and not over a new report of the same thing.
  f.as('bar')('eightySix.clear', { id: marg.id });
  report({ name: 'Margarita' });
  assert.throws(() => f.as('bar')('eightySix.restore', { id: marg.id }), /already back on the list/);
  f.as('bar')('eightySix.clear', { id: first.item.id });
  f.clock.now = new Date('2026-11-20T16:30:00');
  assert.throws(() => f.as('bar')('eightySix.restore', { id: first.item.id }), /can’t be undone/);
});

test('visibility: a list limited to some departments never reaches anyone else, through any method', () => {
  const f = withMenu();
  const bar = f.list('admin', 'Bar');
  assert.throws(() => f.mgr('eightySix.saveList', { id: bar.id, name: 'Bar' }), /Admins only/);
  assert.throws(() => f.as('bar')('eightySix.settings.get'), /Admins only/);
  // Back-bar stock: only the bar sees it. A list the kitchen reports on but only managers and the kitchen see.
  const stock = f.admin('eightySix.saveList', { name: 'Back bar stock', kind: 'bar', viewers: { departments: ['Bar'] }, reporters: { departments: ['Bar'] }, menu: 'none' });
  const prep = f.admin('eightySix.saveList', { name: 'Prep', kind: 'kitchen', viewers: { departments: [] }, reporters: { departments: ['Kitchen'] } });
  assert.deepEqual(stock.viewers, { departments: ['Bar'], jobCodeIds: [] });
  const sees = (id) => f.board(id).lists.map((l) => l.name);
  assert.deepEqual(sees('srv'), ['Bar', 'Kitchen']);
  assert.deepEqual(sees('bar'), ['Bar', 'Kitchen', 'Back bar stock']);
  assert.deepEqual(sees('cook'), ['Bar', 'Kitchen', 'Prep'], 'people who report on a list always see it');
  assert.deepEqual(sees('mgr'), ['Bar', 'Kitchen', 'Back bar stock', 'Prep'], 'managers see every list');

  f.mgr('menu.save', { name: 'Bitters', category: 'Cocktails' });
  const item = f.as('bar')('eightySix.report', { listId: stock.id, name: 'Bitters' }).item;
  assert.ok(item.menuItemId);
  // Hidden from the server everywhere: the board, the summary (banner and Training badge), reports, clears, undo.
  const sum = f.as('srv')('eightySix.summary');
  assert.deepEqual(sum.lists.map((l) => l.name), ['Bar', 'Kitchen']);
  assert.equal(sum.out, 0);
  assert.deepEqual(sum.outMenuItemIds, []);
  assert.deepEqual(f.as('bar')('eightySix.summary').outMenuItemIds, [item.menuItemId]);
  assert.throws(() => f.as('srv')('eightySix.report', { listId: stock.id, name: 'Bitters' }), /List not found/);
  assert.throws(() => f.as('srv')('eightySix.clear', { id: item.id }), /isn’t on the list anymore/);
  assert.throws(() => f.as('srv')('eightySix.history.get'), /Managers only/);
  f.as('bar')('eightySix.clear', { id: item.id });
  assert.throws(() => f.as('srv')('eightySix.restore', { id: item.id }), /can’t be undone/, 'looks like nothing there');
  assert.ok(JSON.stringify([f.board('srv'), f.as('srv')('eightySix.summary')]).indexOf('Back bar stock') < 0);
  // Back to everyone.
  f.admin('eightySix.saveList', { id: stock.id, viewers: { all: true } });
  assert.deepEqual(sees('srv'), ['Bar', 'Kitchen', 'Back bar stock']);
  assert.equal(f.list('srv', 'Back bar stock').canReport, false);
});

test('the nightly reset: off by default; when on, items from before the reset time leave the list on the next read', () => {
  const f = withMenu();
  const bar = f.list('bar', 'Bar');
  const fri = f.as('bar')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace' }).item; // Fri 3pm
  f.clock.now = new Date('2026-11-21T05:00:00');
  assert.equal(f.list('srv', 'Bar').items.length, 1, 'items stay until cleared while the reset is off');
  assert.throws(() => f.admin('eightySix.saveList', { id: bar.id, resetAt: '4am' }), /Pick a time like 04:00/);
  assert.equal(f.admin('eightySix.saveList', { id: bar.id, resetAt: '04:00' }).resetAt, '04:00');
  assert.equal(f.as('srv')('eightySix.summary').out, 0, 'gone at Sat 5am: it was from before 4am');
  const log = f.store.get('eightySixLog', fri.id);
  assert.deepEqual([log.clearedHow, log.clearedBy, log.clearedAt], ['reset', null, new Date('2026-11-21T04:00:00').toISOString()]);
  assert.equal(log.listName, 'Bar');
  // Saturday's items stay through Saturday night and go at 4am Sunday. Touching one after the reset keeps it.
  const sat = f.as('bar')('eightySix.report', { listId: bar.id, name: 'Rye' }).item;
  f.clock.now = new Date('2026-11-21T23:59:00');
  assert.deepEqual(f.list('srv', 'Bar').items.map((i) => i.id), [sat.id]);
  f.clock.now = new Date('2026-11-22T03:59:00');
  assert.equal(f.list('srv', 'Bar').items.length, 1);
  f.clock.now = new Date('2026-11-22T04:01:00');
  assert.equal(f.list('srv', 'Bar').items.length, 0);
  const late = f.as('bar')('eightySix.report', { listId: bar.id, name: 'Gin' }).item;
  f.clock.now = new Date('2026-11-23T03:00:00');
  f.as('bar2')('eightySix.report', { listId: bar.id, name: 'Gin', status: 'low', count: 1 });
  f.clock.now = new Date('2026-11-23T04:30:00');
  assert.equal(f.list('srv', 'Bar').items.length, 0, 'last touched before 4am');
  assert.equal(f.store.get('eightySixLog', late.id).clearedHow, 'reset');
  // Other lists keep their own setting (off).
  const kitchen = f.list('srv', 'Kitchen');
  f.as('cook')('eightySix.report', { listId: kitchen.id, name: 'Steak' });
  f.clock.now = new Date('2026-11-25T12:00:00');
  assert.equal(f.list('srv', 'Kitchen').items.length, 1);
  // Turning it off again.
  assert.equal(f.admin('eightySix.saveList', { id: bar.id, resetAt: '' }).resetAt, '');
});

test('notifications: marking something 86’d tells the people working today who can see the list, in their language, not the reporter', () => {
  const f = withMenu();
  const today = '2026-11-20', clock = f.clock;
  clock.now = new Date('2026-11-20T17:00:00');
  shift(f, 'bar', today, '16:00', '23:00'); // the reporter
  shift(f, 'bar2', today, '18:00', null); // later today, until close
  shift(f, 'srv', today, '16:00', '22:00'); // on now
  shift(f, 'esp', today, '17:00', '23:00'); // on now, reads Spanish
  shift(f, 'cook', today, '06:00', '14:00'); // done for the day
  shift(f, 'srv2', '2026-11-21', '16:00', '22:00'); // tomorrow
  shift(f, 'sup', today, '18:00', '23:00', false); // not posted
  shift(f, 'bbk', '2026-11-19', '20:00', '03:00'); // last night, over
  const bar = f.list('bar', 'Bar');
  const r = f.as('bar')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace', note: 'use the other bourbon' });
  assert.equal(r.notified, 3);
  const got = (id) => notes(f, id).map((n) => n.text);
  assert.deepEqual(got('srv'), ['Bar: Buffalo Trace is 86\'d (use the other bourbon)']);
  assert.deepEqual(got('bar2'), ['Bar: Buffalo Trace is 86\'d (use the other bourbon)']);
  assert.deepEqual(got('esp'), ['Bar: se acabó Buffalo Trace (use the other bourbon)'], 'Spanish; the note stays as typed');
  for (const id of ['bar', 'cook', 'srv2', 'sup', 'bbk', 'mgr', 'admin']) assert.deepEqual(got(id), [], id);
  assert.deepEqual(notes(f, 'srv')[0].i18n, { en: 'Bar: Buffalo Trace is 86\'d (use the other bourbon)', es: 'Bar: se acabó Buffalo Trace (use the other bourbon)' });
  // The same thing again while it's still out: nobody hears twice.
  assert.equal(f.as('bar2')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace', note: 'still out' }).notified, 0);
  assert.equal(got('srv').length, 1);
  assert.equal(got('bar').length, 0);

  // Running low: quiet by default; low → out tells people; a menu item goes by its Spanish name in Spanish.
  const kitchen = f.list('srv', 'Kitchen');
  assert.equal(f.as('srv')('eightySix.report', { listId: kitchen.id, menuItemId: f.menu.Fries.id, status: 'low', count: 3 }).notified, 0);
  assert.equal(f.as('esp')('eightySix.report', { listId: kitchen.id, menuItemId: f.menu.Fries.id }).notified, 3, 'srv, bar, bar2: not esp who reported it');
  assert.deepEqual(got('esp'), ['Bar: se acabó Buffalo Trace (use the other bourbon)']);
  assert.equal(got('srv').at(-1), 'Kitchen: Fries is 86\'d');
  assert.equal(got('bar').at(-1), 'Kitchen: Fries is 86\'d');
  f.as('srv')('eightySix.report', { listId: kitchen.id, menuItemId: f.menu.Steak.id });
  assert.equal(got('esp').at(-1), 'Cocina: se acabó Bistec', 'the list and the menu item in Spanish');
  // A list that tells people when something is running low, in each language, with the count.
  f.admin('eightySix.saveList', { id: bar.id, notifyLow: true });
  f.as('bar')('eightySix.report', { listId: bar.id, name: 'Limes', status: 'low', count: 3 });
  assert.equal(got('srv').at(-1), 'Bar: Limes is running low (3 left)');
  assert.equal(got('esp').at(-1), 'Bar: queda poco de Limes (quedan 3)');
  assert.equal(TEXT.es.low('Bar', 'Limes', 1, 'pide más'), 'Bar: queda poco de Limes (queda 1, pide más)');
  // Only people who can see the list hear about it: the bar's own list stays with the bar.
  f.admin('eightySix.saveList', { id: bar.id, viewers: { departments: ['Bar'] }, nameEs: 'Barra' });
  f.as('bar2')('eightySix.report', { listId: bar.id, name: 'Mezcal' });
  assert.equal(got('bar').at(-1), 'Bar: Mezcal is 86\'d');
  assert.ok(!got('srv').some((x) => /Mezcal/.test(x)) && !got('esp').some((x) => /Mezcal/.test(x)));
  // The list's area or the item's own area, and the list's Spanish name.
  f.admin('eightySix.saveList', { id: bar.id, viewers: { all: true } });
  f.as('bar')('eightySix.report', { listId: bar.id, name: 'Tequila', area: 'Rooftop' });
  assert.equal(got('esp').at(-1), 'Barra (Rooftop): se acabó Tequila');
  // Notifications off for a list.
  f.admin('eightySix.saveList', { id: kitchen.id, notify: false });
  assert.equal(f.as('srv')('eightySix.report', { listId: kitchen.id, name: 'Onion rings' }).notified, 0);
  // After midnight: last night's shift that's still going, and today's later shifts.
  shift(f, 'mgr', today, '19:00', '02:00');
  clock.now = new Date('2026-11-21T01:00:00');
  assert.equal(f.as('bar')('eightySix.report', { listId: bar.id, name: 'Vodka' }).notified, 2);
  assert.equal(got('mgr').at(-1), 'Bar: Vodka is 86\'d', 'on until 2am');
  assert.equal(got('srv2').at(-1), 'Bar: Vodka is 86\'d', 'working later today (Saturday)');
  for (const id of ['srv', 'bar2', 'esp']) assert.ok(!got(id).some((x) => /Vodka/.test(x)), `${id} went home`);
});

test('history: what was 86’d and when, and the most 86’d in the last 30 days, for managers', () => {
  const f = withMenu();
  const bar = f.list('bar', 'Bar'), kitchen = f.list('cook', 'Kitchen');
  const at = (iso) => { f.clock.now = new Date(iso); };
  const out = (who, listId, args) => f.as(who)('eightySix.report', { listId, ...args }).item;
  at('2026-10-01T18:00:00'); // more than 30 days before the end: not counted
  f.as('bar')('eightySix.clear', { id: out('bar', bar.id, { menuItemId: f.menu.Margarita.id }).id });
  for (const d of ['2026-11-02', '2026-11-09', '2026-11-16']) {
    at(`${d}T19:00:00`);
    const m = out('bar', bar.id, { name: 'Margarita' });
    at(`${d}T21:30:00`);
    f.as('bar2')('eightySix.clear', { id: m.id });
  }
  at('2026-11-12T18:00:00');
  const fries = out('cook', kitchen.id, { menuItemId: f.menu.Fries.id, note: 'fryer down' });
  at('2026-11-13T12:00:00');
  f.mgr('eightySix.clear', { id: fries.id });
  out('bar', bar.id, { name: 'Limes', status: 'low', count: 2 }); // only low: in the log, not "86'd"
  at('2026-11-20T17:00:00');
  out('bar', bar.id, { name: 'Margarita', note: 'no limes' }); // out right now

  assert.throws(() => f.as('bar')('eightySix.history.get'), /Managers only/);
  assert.throws(() => f.as('sup')('eightySix.history.get'), /Managers only/);
  const h = f.mgr('eightySix.history.get');
  assert.equal(h.days, 30);
  assert.deepEqual(h.top.map((x) => [x.name, x.times]), [['Margarita', 4], ['Fries', 1]]);
  assert.deepEqual(h.top[0].lists, ['Bar']);
  assert.equal(h.top[0].lastAt, new Date('2026-11-20T17:00:00').toISOString());
  assert.equal(h.top[1].nameEs, 'Papas fritas');
  // The log: newest first, still out or back (when, who), how long.
  assert.deepEqual(h.entries.map((e) => `${e.name}:${e.active ? 'out now' : e.clearedHow}`), ['Margarita:out now', 'Margarita:back', 'Limes:out now', 'Fries:back', 'Margarita:back', 'Margarita:back']);
  const fr = h.entries.find((e) => e.name === 'Fries');
  assert.deepEqual([fr.listName, fr.reportedBy.name, fr.clearedBy.name, fr.note, fr.outAt, fr.clearedAt],
    ['Kitchen', 'cook', 'mgr', 'fryer down', new Date('2026-11-12T18:00:00').toISOString(), new Date('2026-11-13T12:00:00').toISOString()]);
  // A longer window and one list.
  const all = f.mgr('eightySix.history.get', { days: 90, listId: bar.id });
  assert.deepEqual(all.top.map((x) => [x.name, x.times]), [['Margarita', 5]]);
  assert.ok(all.entries.every((e) => e.listId === bar.id));
  // A list that's removed takes its items into the history, under its old name.
  f.admin('eightySix.deleteList', { id: kitchen.id });
  assert.equal(f.mgr('eightySix.history.get').entries.find((e) => e.name === 'Fries').listName, 'Kitchen');
  assert.throws(() => f.admin('eightySix.deleteList', { id: bar.id }), /Keep at least one list/);
});

test('settings: admins add, rename and limit lists (one bar list per bar area); the defaults appear once', () => {
  const f = withMenu();
  const s = f.admin('eightySix.settings.get');
  assert.deepEqual(s.lists.map((l) => [l.name, l.kind, l.menu]), [['Bar', 'bar', 'drinks'], ['Kitchen', 'kitchen', 'food']]);
  assert.deepEqual(s.lists[0].reporters, { departments: ['Bar'], jobCodeIds: [] });
  assert.deepEqual(s.lists[1].reporters, { departments: ['Leadership', 'Restaurant', 'Kitchen'], jobCodeIds: [] });
  assert.deepEqual(s.lists[0].viewers, { all: true });
  assert.deepEqual(s.options.areas, ['Dining Room', 'Rooftop'], 'the restaurant’s areas');
  assert.deepEqual(s.options.sections.sort(), ['Cocktails', 'Mains', 'Sides', 'Wine']);
  f.admin('eightySix.saveList', { id: s.lists[0].id, name: 'Main bar', nameEs: 'Barra principal', area: 'dining room' });
  const roof = f.admin('eightySix.saveList', { name: 'Rooftop bar', kind: 'bar', area: 'Rooftop', reporters: { departments: ['Bar'], jobCodeIds: ['job_srv', 'nope'] }, sections: ['Cocktails'] });
  assert.deepEqual([roof.area, roof.menu, roof.reporters.jobCodeIds, roof.notify, roof.notifyLow, roof.resetAt], ['Rooftop', 'drinks', ['job_srv'], true, false, '']);
  assert.throws(() => f.admin('eightySix.saveList', { name: ' ' }), /Give the list a name/);
  const lists = f.board('srv').lists;
  assert.deepEqual(lists.map((l) => [l.name, l.area, l.canReport]), [['Main bar', 'Dining Room', false], ['Kitchen', '', true], ['Rooftop bar', 'Rooftop', true]]);
  assert.deepEqual(lists[2].suggest, [f.menu.Margarita.id], 'its own menu sections');
  assert.equal(f.store.list('eightySixLists').length, 3, 'the defaults were made once');
});

test('the demo has a Bar, a Moon Rabbit bar and a Kitchen list with items on them; bartenders report on the bars', () => {
  const store = new MemoryStore();
  const now = new Date('2026-09-27T12:00:00');
  const ids = seedDemo(store, { now });
  const svc = createService(store, { now: () => now });
  const u = (name) => store.get('users', ids.userId[name]);
  const mak = svc.call(u('Mak'), 'eightySix.board.get');
  assert.deepEqual(mak.lists.map((l) => [l.name, l.kind, l.canReport]), [['Bar', 'bar', true], ['Moon Rabbit bar', 'bar', true], ['Kitchen', 'kitchen', false]]);
  assert.ok(mak.lists.every((l) => l.items.length));
  const alex = svc.call(u('Alex D'), 'eightySix.board.get');
  assert.deepEqual(alex.lists.map((l) => l.canReport), [false, false, true]);
  assert.equal(svc.call(u('Agustina'), 'eightySix.board.get').lists[1].canReport, true, 'cocktail servers report on the Moon Rabbit bar');
  const sum = svc.call(u('Alex D'), 'eightySix.summary');
  assert.deepEqual([sum.out, sum.low], [2, 2]);
  const h = svc.call(u('Moe'), 'eightySix.history.get');
  assert.equal(h.top[0].name, 'Copper Fox Mule');
  for (const e of h.entries) assert.ok(e.reportedBy.name, 'demo people only');
});

test('the API: read-only methods, reports and errors in the caller’s language', async () => {
  const conn = await openPglite();
  const app = createApp({ db: new DocDb(conn), env: { SEED_DEMO: 'true', JWT_SECRET: 'test-secret-86' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const signIn = async (email) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234', client: 'mobile' }) });
    const { token } = await r.json();
    return async (method, args = {}) => {
      const res = await fetch(`${base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
      return { status: res.status, body: await res.json() };
    };
  };
  try {
    const mak = await signIn('mak@demo.shiftboard');
    const alex = await signIn('alexd@demo.shiftboard');
    const board = (await mak('eightySix.board.get')).body.result;
    const bar = board.lists.find((l) => l.kind === 'bar');
    const r = await mak('eightySix.report', { listId: bar.id, name: 'Rabbit Hole Rye', note: 'two cases Monday' });
    assert.equal(r.status, 200);
    assert.ok((await alex('eightySix.summary')).body.result.out >= 3);
    await alex('account.preferences', { language: 'es' });
    const no = await alex('eightySix.report', { listId: bar.id, name: 'Hielo' });
    assert.equal(no.status, 403);
    assert.equal(no.body.error, 'No puedes reportar en esta lista');
    const gone = await alex('eightySix.clear', { id: 'e86_nope' });
    assert.equal(gone.body.error, 'Eso ya no está en la lista');
    assert.equal((await mak('eightySix.clear', { id: r.body.result.item.id })).status, 200);
    assert.equal((await alex('eightySix.history.get')).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});

test('a new restaurant gets its Bar and Kitchen lists on the first read, through the server’s read-only path', async () => {
  const conn = await openPglite();
  const env = { ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'first-pass-86', JWT_SECRET: 'test-secret-86b' };
  const db = new DocDb(conn);
  const app = createApp({ db, env });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, client: 'mobile' }) })).json();
    const rpc = async (method, args = {}) => (await (await fetch(`${base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(args) })).json()).result;
    const first = await rpc('eightySix.board.get');
    assert.deepEqual(first.lists.map((l) => [l.name, l.kind]), [['Bar', 'bar'], ['Kitchen', 'kitchen']]);
    assert.deepEqual((await rpc('eightySix.summary')).lists.map((l) => l.id), first.lists.map((l) => l.id), 'saved once: the same lists after');
    await db.sync();
    assert.equal(db.store.list('eightySixLists').length, 2, 'stored in the database');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});

test('photos: up to 3 per report, checked like Training’s, only for people who can see the list; the reporter or a manager removes them', () => {
  const f = withMenu();
  const bar = f.list('bar', 'Bar');
  const item = f.as('bar')('eightySix.report', { listId: bar.id, name: 'Buffalo Trace' }).item;
  assert.deepEqual(item.photos, [], 'photos are optional');
  const add = (who, dataUrl = jpeg(), id = item.id) => f.as(who)('eightySix.addPhoto', { itemId: id, dataUrl, w: 1200, h: 900 });
  const first = add('bar');
  assert.deepEqual([first.photo.w, first.photo.h, first.item.photos.length], [1200, 900, 1]);
  const doc = f.store.get('eightySixPhotos', first.photo.id);
  assert.deepEqual([doc.itemId, doc.listId, doc.mime, doc.by], [item.id, bar.id, 'image/jpeg', 'bar']);
  // Type, the real bytes and size, like menu.addPhoto.
  assert.throws(() => add('bar', 'data:image/gif;base64,R0lGODlhAQABAAAAACw='), /Upload a JPG, PNG or WebP photo/);
  assert.throws(() => add('bar', jpeg().replace('image/jpeg', 'image/png')), /isn’t the kind of image it says it is/);
  assert.throws(() => add('bar', jpeg(PHOTO_MAX_BYTES + 10)), (e) => e.status === 413 && /too large/.test(e.message));
  assert.throws(() => add('bar', 'not a photo'), /Upload a JPG, PNG or WebP photo/);
  // Who: the list's reporters; at most 3.
  assert.throws(() => add('srv'), /can’t report on this list/);
  add('bar2');
  const third = add('mgr');
  assert.equal(third.item.photos.length, PHOTOS_PER_ITEM);
  assert.throws(() => add('bar'), /up to 3 photos/);
  // Everyone who sees the list sees the photos; the reporter and managers may remove any, others their own.
  const seen = (who) => f.list(who, 'Bar').items.find((i) => i.id === item.id).photos;
  assert.deepEqual(seen('srv').map((p) => p.canRemove), [false, false, false]);
  assert.deepEqual(seen('bar').map((p) => p.canRemove), [true, true, true], 'the reporter');
  assert.deepEqual(seen('bar2').map((p) => p.canRemove), [false, true, false], 'their own');
  assert.ok(eightySixPhotoFor(f.store, f.store.get('users', 'srv'), first.photo.id));
  assert.match(f.as('srv')('eightySix.photo.get', { id: first.photo.id }).dataUrl, /^data:image\/jpeg;base64,/);
  assert.throws(() => f.as('bbk')('eightySix.removePhoto', { itemId: item.id, photoId: first.photo.id }), /Only the person who reported it or a manager/);
  assert.throws(() => f.as('bar2')('eightySix.removePhoto', { itemId: item.id, photoId: first.photo.id }), /Only the person who reported it or a manager/);
  assert.equal(f.as('bar2')('eightySix.removePhoto', { itemId: item.id, photoId: seen('bar2')[1].id }).item.photos.length, 2);
  assert.equal(f.mgr('eightySix.removePhoto', { itemId: item.id, photoId: first.photo.id }).item.photos.length, 1);
  assert.equal(f.store.get('eightySixPhotos', first.photo.id), null, 'the bytes go too');
  assert.throws(() => f.mgr('eightySix.removePhoto', { itemId: item.id, photoId: first.photo.id }), /Photo not found/);
  // A hidden list: no photo for anyone outside it, through any method.
  f.admin('eightySix.saveList', { id: bar.id, viewers: { departments: ['Bar'] } });
  const left = seen('bar')[0].id;
  assert.equal(eightySixPhotoFor(f.store, f.store.get('users', 'srv'), left), null);
  assert.throws(() => f.as('srv')('eightySix.photo.get', { id: left }), /Photo not found/);
  assert.throws(() => f.as('srv')('eightySix.addPhoto', { itemId: item.id, dataUrl: jpeg() }), /isn’t on the list anymore/);
  assert.throws(() => f.as('srv')('eightySix.removePhoto', { itemId: item.id, photoId: left }), /isn’t on the list anymore/);
  assert.ok(f.as('bbk')('eightySix.photo.get', { id: left }).dataUrl);
  assert.throws(() => f.as('bar')('eightySix.photo.get', { id: 'e86p_nope' }), /Photo not found/);
});

test('photos stay with the history for 30 days after the item comes off the list, then they are deleted', () => {
  const f = withMenu();
  const bar = f.list('bar', 'Bar');
  const report = (name) => f.as('bar')('eightySix.report', { listId: bar.id, name }).item;
  const photo = (it) => f.as('bar')('eightySix.addPhoto', { itemId: it.id, dataUrl: jpeg() }).photo.id;
  const start = new Date('2026-11-20T15:00:00').getTime();
  const gone = report('Gin'), still = report('Rye');
  const p1 = photo(gone), p2 = photo(gone), p3 = photo(still);
  f.as('bar')('eightySix.clear', { id: gone.id }); // Fri Nov 20, 3pm
  // Kept with the history: managers see them there, and anyone who can see the list can open them.
  assert.equal(f.mgr('eightySix.history.get').entries.find((e) => e.id === gone.id).photos.length, 2);
  assert.ok(eightySixPhotoFor(f.store, f.store.get('users', 'srv'), p1));
  f.clock.now = new Date(start + (KEEP_PHOTOS_DAYS - 1) * 86400000);
  f.as('srv')('eightySix.summary');
  assert.ok(f.store.get('eightySixPhotos', p1) && f.store.get('eightySixPhotos', p2), 'still there after 29 days');
  f.clock.now = new Date(start + (KEEP_PHOTOS_DAYS + 1) * 86400000);
  f.as('srv')('eightySix.summary');
  assert.equal(f.store.get('eightySixPhotos', p1), null);
  assert.equal(f.store.get('eightySixPhotos', p2), null);
  const log = f.store.get('eightySixLog', gone.id);
  assert.deepEqual(log.photos, []);
  assert.ok(log.photosRemovedAt, 'the history entry stays, without its photos');
  assert.ok(f.store.get('eightySixPhotos', p3), 'an item still on the list keeps its photos');
  // The nightly reset counts as coming off the list too.
  f.admin('eightySix.saveList', { id: bar.id, resetAt: '04:00' });
  f.clock.now = new Date(f.clock.now.getTime() + 86400000);
  f.as('srv')('eightySix.summary');
  assert.equal(f.store.get('eightySixLog', still.id).clearedHow, 'reset');
  assert.ok(f.store.get('eightySixPhotos', p3));
  f.clock.now = new Date(f.clock.now.getTime() + (KEEP_PHOTOS_DAYS + 1) * 86400000);
  f.as('srv')('eightySix.board.get');
  assert.equal(f.store.get('eightySixPhotos', p3), null);
});

test('photo bytes stay in Postgres (not in any instance’s memory) and are served only to people who can see the list', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', JWT_SECRET: 'test-secret-86c' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const signIn = async (email) => {
    const { token } = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234', client: 'mobile' }) })).json();
    const auth = { Authorization: `Bearer ${token}` };
    const rpc = async (method, args = {}) => {
      const res = await fetch(`${base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(args) });
      return { status: res.status, body: await res.json() };
    };
    return { rpc, get: (url) => fetch(`${base}${url}`, { headers: auth }) };
  };
  try {
    const mak = await signIn('mak@demo.shiftboard');
    const alex = await signIn('alexd@demo.shiftboard');
    const moe = await signIn('moe@demo.shiftboard');
    const bar = (await mak.rpc('eightySix.board.get')).body.result.lists[0];
    const item = bar.items[0];
    const up = await mak.rpc('eightySix.addPhoto', { itemId: item.id, dataUrl: jpeg(300 * 1024), w: 800, h: 600 });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const id = up.body.result.photo.id;
    assert.equal((await mak.rpc('eightySix.addPhoto', { itemId: item.id, dataUrl: jpeg(PHOTO_MAX_BYTES + 10) })).status, 413);
    assert.equal((await alex.rpc('eightySix.addPhoto', { itemId: item.id, dataUrl: jpeg() })).status, 403, 'a server can’t add to the bar’s list');
    // Served behind sign-in (cookie or bearer), to anyone who can see the list.
    const url = `/api/eighty-six/photos/${id}`;
    assert.equal((await fetch(`${base}${url}`)).status, 401);
    const img = await alex.get(url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /^private/);
    assert.equal((await img.arrayBuffer()).byteLength, 300 * 1024);
    assert.equal((await alex.get('/api/eighty-six/photos/nope')).status, 404);
    // On a server the RPC has no bytes to hand out (the route serves them).
    assert.equal((await alex.rpc('eightySix.photo.get', { id })).status, 404);
    // The bytes are in Postgres only: this instance's cache and a cold-started one hold none.
    assert.equal(db.store.get('eightySixPhotos', id).data, undefined);
    const cold = new DocDb(conn);
    await cold.sync();
    assert.equal(cold.store.get('eightySixPhotos', id).data, undefined, 'a cold start loads no photo bytes');
    assert.equal((await cold.lazyData('eightySixPhotos', id)).length, Math.ceil(300 * 1024 / 3) * 4);
    // Hide the bar's list from servers: the photo is gone for them, still there for the bar.
    assert.equal((await moe.rpc('eightySix.saveList', { id: bar.id, viewers: { departments: ['Bar'] } })).status, 200);
    assert.equal((await alex.get(url)).status, 404);
    assert.equal((await mak.get(url)).status, 200);
    // Back in stock keeps the photo with the history; removing it deletes the bytes.
    await mak.rpc('eightySix.clear', { id: item.id });
    assert.equal((await mak.get(url)).status, 200);
    assert.equal((await moe.rpc('eightySix.removePhoto', { itemId: item.id, photoId: id })).status, 200);
    assert.equal((await mak.get(url)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
