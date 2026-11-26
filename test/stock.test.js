// Stock lists (core/stock.js) and the product catalog the 86 List shares (core/products.js):
//   - the catalog: anyone adds on the fly (marked for review); managers edit, approve, merge, archive; duplicates by the
//     smart import's rules (and what must never match)
//   - merging moves list lines, 86 reports and photos onto the product kept
//   - lists: from a template, assigned to a person, a position or a room's shift, worked with Got it / Short / Out,
//     Out → the 86 List in one tap, notifications when it's done or something's out, history
//   - View as can only read; plan and role gating; the Claude tools preview → confirm; Spanish
//   - the 86 List's migration: products from past 86 names where it's clean, and every old answer the same
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, OverlayStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { seedStockDemo } from '../core/stock-seed.js';
import { productLikeness } from '../core/smart-import.js';
import { ensureCatalog, MIGRATION, categoryFrom86, productMatches } from '../core/products.js';
import { TEXT } from '../core/stock.js';
import { translateError } from '../core/errors.js';
import { ROLE_OFF, featuresForMethod } from '../core/role-features.js';
import { featureForMethod, resolveFeatures } from '../server/platform/plans.js';
import { viewCall, viewedPerson, resolveTarget, VIEW_READ_ONLY } from '../core/view-as.js';
import { toolByName, runTool, createToolContext, READ, WRITE } from '../server/tools/index.js';
import { describeAction } from '../server/assistant/actions.js';
import { startApp } from './helpers/app.js';
import { signIn } from './helpers/signin.js';

const NOW = new Date(2026, 8, 27, 12); // the demo's clock: Sunday noon
const TODAY = '2026-09-27';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBkYGBgYGAAkDAP9qL3KxwAAAABJRU5ErkJggg==';

/** The demo restaurant in memory (with the stock demo when asked), a service on a fixed clock, and people by name. */
function demo({ stock = false, plan = null } = {}) {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  if (stock) seedStockDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW, planFeatures: plan });
  const who = (name) => store.list('users', (u) => u.name === name)[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const role = (r, n = 0) => store.list('users', (u) => u.role === r && u.active !== false).sort((a, b) => a.order - b.order)[n];
  return { store, svc, who, call, role };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message), `${status} ${message || ''}`);

// ---------- duplicates ----------
test('duplicates: the smart import’s rules find the same product; different products never match', () => {
  for (const [a, b, reason] of [
    ['Bacardi Superior', 'bacardi superior 1L', 'sizeOrPrice'], ['Bacardi Superior', 'BACARDI SUPERIOR', 'sameName'], ['Rocks glass', 'Rocks glasses', 'plural'],
    ['Salt & pepper shakers', 'salt and pepper shakers', 'andSign'], ['Bacardi Superior', 'Bacardi Superor', 'typo'], ['Cocktail napkins', 'Cocktail napkin (black)', 'sizeOrPrice'],
  ]) {
    const r = productLikeness(b, a);
    assert.ok(r.score >= 70, `${b} ≈ ${a}`);
    assert.ok(r.reasons.includes(reason), `${b}: ${r.reasons}`);
  }
  for (const [a, b] of [
    ['Bacardi Superior', 'Bacardi Gold'], ['Bacardi Superior 1L', 'Bacardi Superior 750 ml'], ['Coke', 'Diet Coke'], ['Limes', 'Lime juice'],
    ['Ginger beer', 'Ginger ale'], ['Napkins', 'Cocktail napkins'], ['Limes', 'Lemons'], ['Coffee', 'Toffee'], ['Bacardi Superior', 'Bacardi Spiced'],
  ]) assert.equal(productLikeness(b, a).score, 0, `${b} is not ${a}`);

  const { store, who, call } = demo();
  const moe = who('Moe');
  call(moe, 'products.list'); // the migration first
  const kept = call(moe, 'products.add', { name: 'Bacardi Superior', category: 'spirits', unit: 'bottle', location: 'Liquor room' }).product;
  // Typing "bacardi superior 1L": the existing one first, nothing added.
  const r = call(who('Arthur'), 'products.add', { name: 'bacardi superior 1L' });
  assert.equal(r.created, false);
  assert.equal(r.product, null);
  assert.equal(r.duplicates[0].id, kept.id);
  assert.equal(r.duplicates[0].reasons[0], 'sizeOrPrice');
  assert.equal(call(moe, 'products.matches.get', { name: 'Bacardi Gold' }).matches.length, 0);
  assert.equal(store.list('products', (p) => /superior/i.test(p.name)).length, 1, 'nothing added');
});

// ---------- the catalog ----------
test('catalog: anyone adds on the fly (usable at once, waiting for review); managers edit, approve, archive; staff can’t', () => {
  const { store, who, call, role } = demo();
  const emp = who('Arthur');
  const sup = role('supervisor');
  const mgr = who('Moe');
  const added = call(emp, 'products.add', { name: 'Bar mats', category: 'smallwares', unit: 'each', location: 'Under the well', pars: { '': 9 } });
  assert.equal(added.created, true);
  const p = added.product;
  assert.equal(p.review, 'new');
  assert.equal(p.addedBy.name, 'Arthur');
  assert.deepEqual(p.pars, {}, 'par levels are managers’');
  assert.equal(p.canEdit, true, 'the person who added it can fix it until it’s reviewed');
  // Usable at once: on a list.
  const l = call(sup, 'stock.save', { name: 'Mats', lines: [{ productId: p.id, qty: 2 }], assign: { type: 'person', userId: emp.id } });
  assert.equal(l.lines[0].name, 'Bar mats');
  // In the managers' queue, not anyone else's.
  assert.ok(call(mgr, 'products.review.list').products.some((x) => x.id === p.id));
  refused(() => call(emp, 'products.review.list'), 403, 'Managers only');
  refused(() => call(sup, 'products.review.list'), 403, 'Managers only');
  refused(() => call(emp, 'products.approve', { id: p.id }), 403, 'Managers only');
  refused(() => call(emp, 'products.archive', { id: p.id }), 403, 'Managers only');
  refused(() => call(sup, 'products.merge', { keepId: p.id, mergeId: p.id }), 403, 'Managers only');
  // Someone else can't edit it; the one who added it can, until a manager approves it.
  refused(() => call(who('Luciano'), 'products.save', { id: p.id, name: 'Bar mat' }), 403, 'Managers only');
  assert.equal(call(emp, 'products.save', { id: p.id, name: 'Rubber bar mats' }).name, 'Rubber bar mats');
  const ok = call(mgr, 'products.approve', { id: p.id });
  assert.equal(ok.review, 'ok');
  refused(() => call(emp, 'products.save', { id: p.id, name: 'Mats' }), 403, 'Managers only');
  // Managers edit everything, par levels per room too.
  const edited = call(mgr, 'products.save', { id: p.id, location: 'Bar, under the well', supplier: 'Sample Supply', pars: { '': 6, 'rabbit hole': 3 } });
  assert.deepEqual(edited.pars, { '': 6, 'Rabbit Hole': 3 });
  refused(() => call(mgr, 'products.save', { id: p.id, pars: { '': -1 } }), 400, 'A par level is a number from 0 to 9999');
  // A manager's own product needs no review.
  assert.equal(call(mgr, 'products.add', { name: 'Bar spoons long' }).product.review, 'ok');
  // Photos: the person who added it (while new) or a manager; up to 3.
  const ph = call(mgr, 'products.addPhoto', { id: p.id, dataUrl: PNG, w: 2, h: 2 });
  assert.equal(ph.product.photos.length, 1);
  refused(() => call(who('Luciano'), 'products.addPhoto', { id: p.id, dataUrl: PNG }), 403, 'Only a manager can change this product’s photos');
  // Archive: gone from the catalog (and the 86 report form's suggestions), back with Restore.
  call(mgr, 'products.archive', { id: p.id });
  assert.ok(!call(emp, 'products.list').products.some((x) => x.id === p.id));
  assert.ok(call(mgr, 'products.list', { archived: true }).products.some((x) => x.id === p.id && x.status === 'archived'));
  call(mgr, 'products.archive', { id: p.id, archived: false });
  assert.ok(call(emp, 'products.list').products.some((x) => x.id === p.id));
  assert.ok(store.get('products', p.id));
  // Categories: renamed and added; Other always stays.
  const cats = call(mgr, 'products.saveCategories', { categories: [{ id: 'spirits', name: 'Liquor', nameEs: 'Licor' }, { name: 'Coffee bar', nameEs: 'Barra de café' }] }).categories;
  assert.deepEqual(cats.map((c) => c.name), ['Liquor', 'Coffee bar', 'Other']);
});

// ---------- merge ----------
test('merge moves list lines, templates, 86 reports and photos onto the kept product; the other is archived', () => {
  const { store, who, call } = demo();
  const mgr = who('Moe');
  call(mgr, 'products.list');
  const keep = call(mgr, 'products.add', { name: 'Bacardi Superior', category: 'spirits' }).product;
  const dup = call(who('Arthur'), 'products.add', { name: 'Bacardi Superior 1L', unit: 'bottle', location: 'Liquor room', force: true }).product;
  call(who('Arthur'), 'products.addPhoto', { id: dup.id, dataUrl: PNG, w: 2, h: 2 });
  const tpl = call(mgr, 'stock.save', { kind: 'template', name: 'Well restock', lines: [{ productId: keep.id, qty: 1 }, { productId: dup.id, qty: 2 }] });
  const list = call(mgr, 'stock.save', { name: 'Friday well', lines: [{ productId: dup.id, qty: 3 }], assign: { type: 'person', userId: who('Arthur').id }, date: TODAY });
  // An 86 report of the duplicate's name (Bar list), out and then back: history that must follow.
  const r = call(who('Mak'), 'eightySix.report', { listId: 'e86_bar', name: 'Bacardi Superior 1L', status: 'out' });
  assert.equal(store.get('eightySixItems', r.item.id).productId, dup.id, 'an 86 report links to the product it is');
  call(who('Mak'), 'eightySix.clear', { id: r.item.id });
  assert.equal(store.get('eightySixLog', r.item.id).productId, dup.id);

  const m = call(mgr, 'products.merge', { keepId: keep.id, mergeId: dup.id });
  assert.deepEqual(m.moved, { lines: 2, eightySix: 1, photos: 1 });
  assert.equal(m.product.location, 'Liquor room', 'empty fields filled from the merged one');
  assert.equal(m.product.photos.length, 1);
  assert.equal(store.get('products', dup.id).status, 'archived');
  assert.equal(store.get('products', dup.id).mergedInto, keep.id);
  assert.deepEqual(store.get('stockLists', tpl.id).lines.map((x) => [x.productId, x.qty]), [[keep.id, 3]], 'one line per product on a template');
  assert.equal(store.get('stockLists', list.id).lines[0].productId, keep.id);
  assert.equal(store.get('eightySixLog', r.item.id).productId, keep.id);
  assert.equal(store.get('eightySixLog', r.item.id).name, 'Bacardi Superior 1L', '86 history keeps what was reported');
  assert.ok(call(mgr, 'products.get', { id: keep.id }).usage.eightySix >= 1);
  refused(() => call(mgr, 'products.archive', { id: dup.id, archived: false }), 409, 'It was merged into another product');
  refused(() => call(mgr, 'products.merge', { keepId: keep.id, mergeId: keep.id }), 400, 'Pick two different products');
});

// ---------- lists ----------
test('lists: from a template, to a person, a position or a room’s shift; Got it, Short, Out; Out → 86; done → the manager hears', () => {
  const { store, who, call, role } = demo({ stock: true });
  const sup = role('supervisor');
  const mgr = who('Moe');
  const tpl = call(mgr, 'stock.lists.list', { scope: 'templates' }).lists.find((l) => l.name === 'Nightly bar restock');
  assert.ok(tpl, 'the demo’s templates');
  // A day with barbacks on the published schedule.
  const s = store.list('shifts', (x) => x.published && x.jobCodeId === 'job_bbk' && x.userId && x.area).sort((a, b) => a.date.localeCompare(b.date))[0];
  const date = s.date;
  const onBbk = [...new Set(store.list('shifts', (x) => x.published && x.date === date && x.jobCodeId === 'job_bbk' && x.userId).map((x) => x.userId))];
  const inRoom = [...new Set(store.list('shifts', (x) => x.published && x.date === date && x.area === s.area && x.userId).map((x) => x.userId))];

  // To a position on that date: every barback scheduled then, told in their own language.
  store.update('users', onBbk[0], { language: 'es' });
  const before = store.list('notifications').length;
  const byPos = call(sup, 'stock.fromTemplate', { templateId: tpl.id, date, due: '16:30', assign: { type: 'position', jobCodeId: 'job_bbk' } });
  assert.deepEqual(byPos.assignees.map((x) => x.id).sort(), [...onBbk].sort());
  assert.equal(byPos.lines.length, 8);
  assert.equal(byPos.templateId, tpl.id);
  assert.equal(byPos.notified, onBbk.filter((id) => id !== sup.id).length);
  const told = store.list('notifications').slice(before);
  assert.ok(told.some((n) => n.userId === onBbk[0] && n.text === 'Tienes una nueva lista de surtido: Nightly bar restock (para las 4:30 pm)'), told.map((n) => n.text).join(' | '));
  assert.ok(told.every((n) => n.link === `#/stock/${byPos.id}`));
  // To a room's shift: whoever works there that day.
  const byRoom = call(sup, 'stock.fromTemplate', { templateId: tpl.id, date, assign: { type: 'room', room: s.area.toLowerCase() } });
  assert.equal(byRoom.assign.room, s.area);
  assert.deepEqual(byRoom.assignees.map((x) => x.id).sort(), [...inRoom].sort());
  // To a person.
  const worker = store.get('users', onBbk[0]);
  const l = call(mgr, 'stock.save', { name: 'Friday bar restock', date: TODAY, due: '17:00', assign: { type: 'person', userId: worker.id },
    lines: tpl.lines ? tpl.lines : call(mgr, 'stock.list.get', { id: tpl.id }).lines.slice(0, 4).map((x) => ({ productId: x.productId, qty: x.qty })) });
  assert.equal(l.status, 'open');
  assert.ok(call(worker, 'stock.mine.list').lists.some((x) => x.id === l.id), 'My Shifts’ card: assigned to them today');
  assert.ok(!call(who('Torie'), 'stock.lists.list').lists.some((x) => x.id === l.id), 'not anyone else’s');
  refused(() => call(who('Torie'), 'stock.list.get', { id: l.id }), 404, 'List not found');
  refused(() => call(who('Torie'), 'stock.mark', { id: l.id, lineId: l.lines[0].id, state: 'got' }), 404, 'List not found');

  // Working it.
  const [a, b, c, d] = l.lines;
  let v = call(worker, 'stock.mark', { id: l.id, lineId: a.id, state: 'got' });
  assert.equal(v.status, 'in_progress');
  assert.equal(v.counts.done, 1);
  refused(() => call(worker, 'stock.mark', { id: l.id, lineId: b.id, state: 'short', brought: b.qty }), 400, 'Say how many you brought (less than asked)');
  v = call(worker, 'stock.mark', { id: l.id, lineId: b.id, state: 'short', brought: 0 });
  assert.equal(v.lines[1].brought, 0);
  assert.ok(v.lines[1].eightySix, 'Short offers the 86 List (running low)');
  const n0 = store.list('notifications').length;
  v = call(worker, 'stock.mark', { id: l.id, lineId: c.id, state: 'out' });
  const outNote = store.list('notifications').slice(n0);
  assert.deepEqual(outNote.map((n) => n.userId), [mgr.id], 'an out goes to the manager right away');
  assert.match(outNote[0].text, /^Friday bar restock: .+ says we’re out of /);
  // Out → the 86 List in one tap: the right list (the Bar's, for a bar product), marked out, linked to the product.
  const e86 = v.lines[2].eightySix;
  assert.equal(e86.id, 'e86_bar');
  const rep = call(worker, 'stock.reportEightySix', { id: l.id, lineId: c.id, status: 'out' });
  assert.equal(rep.eightySix.listId, 'e86_bar');
  assert.equal(rep.lines[2].reported86.status, 'out');
  const item = store.get('eightySixItems', rep.lines[2].reported86.itemId);
  assert.equal(item.status, 'out');
  assert.equal(item.productId, c.productId);
  assert.ok(call(worker, 'eightySix.board.get').lists.find((x) => x.id === 'e86_bar').items.some((i) => i.id === item.id), 'on the 86 List');
  // Short → running low.
  const low = call(worker, 'stock.reportEightySix', { id: l.id, lineId: b.id, status: 'low' });
  assert.equal(store.get('eightySixItems', low.lines[1].reported86.itemId).status, 'low');
  // Undo and redo, then the last line: done, and the manager hears once.
  call(worker, 'stock.mark', { id: l.id, lineId: a.id, state: null });
  call(worker, 'stock.mark', { id: l.id, lineId: a.id, state: 'got' });
  const n1 = store.list('notifications').length;
  v = call(worker, 'stock.mark', { id: l.id, lineId: d.id, state: 'got' });
  assert.equal(v.status, 'done');
  assert.equal(v.doneBy.id, worker.id);
  const done = store.list('notifications').slice(n1);
  assert.deepEqual(done.map((n) => n.userId), [mgr.id]);
  assert.equal(done[0].i18n.en, `Friday bar restock is done (${worker.name}): 1 short, 1 out`);
  assert.equal(done[0].i18n.es, `Friday bar restock está lista (${worker.name}): 1 incompleto, 1 sin existencia`);
  call(worker, 'stock.mark', { id: l.id, lineId: d.id, state: null });
  call(worker, 'stock.mark', { id: l.id, lineId: d.id, state: 'got' });
  assert.equal(store.list('notifications').slice(n1).length, 1, 'told once');

  // History: who did what, when, the shorts and outs.
  const hist = call(mgr, 'stock.lists.list', { scope: 'history' }).lists;
  assert.ok(hist.some((x) => x.id === l.id && x.counts.short === 1 && x.counts.out === 1));
  const full = call(mgr, 'stock.list.get', { id: l.id });
  assert.deepEqual(full.lines.map((x) => x.state), ['got', 'short', 'out', 'got']);
  assert.ok(full.lines.every((x) => x.by?.id === worker.id && x.at));
  assert.ok(full.log.some((e) => e.what === 'reported86' && e.state === 'out' && e.to === 'Bar'));
  assert.ok(full.log.filter((e) => e.what === 'mark').length >= 6);

  // Reassign: the new person is told; save as a template; delete.
  const other = who('Luciano');
  const n2 = store.list('notifications').length;
  const re = call(mgr, 'stock.assign', { id: byRoom.id, assign: { type: 'person', userId: other.id } });
  assert.deepEqual(re.assignees.map((x) => x.id), [other.id]);
  assert.ok(store.list('notifications').slice(n2).some((n) => n.userId === other.id));
  assert.ok(re.log.some((e) => e.what === 'reassigned' && e.to === other.name));
  const t2 = call(mgr, 'stock.saveAsTemplate', { id: l.id, name: 'Friday template' });
  assert.equal(t2.kind, 'template');
  assert.ok(t2.lines.every((x) => !x.state));
  refused(() => call(worker, 'stock.delete', { id: l.id }), 403, 'Supervisors and managers only');
  call(mgr, 'stock.delete', { id: byRoom.id });
  assert.equal(store.get('stockLists', byRoom.id), null);
});

test('a quick list from a bartender: search, tap, how many, sent to the barbacks on duty in their room; they check it off; the sender hears', () => {
  const { store, svc, who, call } = demo({ stock: true });
  // Today: a bartender and two barbacks on now in the Rabbit Hole, a barback on later, one in another room, one off.
  const lou = who('Mak'), b1 = who('Arthur'), b2 = who('Luciano'), later = who('Hans'), elsewhere = who('Wilder');
  for (const s of store.list('shifts', (x) => x.date === TODAY)) store.remove('shifts', s.id);
  const shift = (u, job, area, start, end) => store.insert('shifts', { id: `shf_q_${u.id}`, userId: u.id, jobCodeId: job, area, date: TODAY, start, end, published: true });
  shift(lou, 'job_bar', 'Rabbit Hole', '11:00', '19:00');
  shift(b1, 'job_bbk', 'Rabbit Hole', '11:30', '18:00');
  shift(b2, 'job_bbk', 'Rabbit Hole', '10:00', '16:00');
  shift(later, 'job_bbk', 'Rabbit Hole', '17:00', '23:00');
  shift(elsewhere, 'job_bbk', 'Restaurant', '11:00', '19:00');
  // The default: barbacks, in the room Lou is working.
  const opts = call(lou, 'stock.options.get');
  assert.deepEqual(opts.quick, { jobCodeId: 'job_bbk', room: 'Rabbit Hole' });
  assert.equal(opts.canQuick, true);
  assert.equal(opts.people.length, 0, 'staff send to who is on duty, not to a person');
  // Search the library (aliases too), tap, how many.
  const cat = call(lou, 'products.list').products;
  const rum = cat.find((p) => p.name === 'Harbor Light Silver Rum');
  const gin = cat.find((p) => p.name === 'Juniper Row Gin');
  const before = store.list('notifications').length;
  const l = call(lou, 'stock.save', { name: 'Well', lines: [{ productId: rum.id, qty: 3 }, { productId: gin.id, qty: 2, note: 'the 750s' }], assign: { type: 'position', ...opts.quick } });
  assert.equal(l.quick, true);
  assert.equal(l.date, TODAY);
  assert.deepEqual(l.assignees.map((x) => x.name).sort(), ['Arthur', 'Luciano'], 'on duty now, in that room');
  const told = store.list('notifications').slice(before);
  assert.deepEqual(told.map((n) => n.userId).sort(), [b1.id, b2.id].sort());
  assert.equal(told[0].i18n.en, 'Mak needs 2 items from the liquor room');
  assert.equal(told[0].i18n.es, 'Mak necesita 2 artículos de liquor room');
  // Staff can't schedule for a person, make templates, or see everyone's lists.
  refused(() => call(lou, 'stock.save', { name: 'x', lines: [{ productId: rum.id, qty: 1 }], assign: { type: 'person', userId: b1.id } }), 400, 'Pick a position or a room');
  refused(() => call(lou, 'stock.save', { name: 'x', lines: [{ productId: rum.id, qty: 1 }] }), 400, 'Pick who the list is for');
  refused(() => call(lou, 'stock.save', { kind: 'template', name: 'T', lines: [{ productId: rum.id, qty: 1 }] }), 403, 'Supervisors and managers only');
  assert.equal(call(lou, 'stock.lists.list', { scope: 'all' }).lists.length, 0);
  assert.ok(call(lou, 'stock.lists.list').lists.some((x) => x.id === l.id), 'the sender sees it in My lists');
  refused(() => call(elsewhere, 'stock.list.get', { id: l.id }), 404, 'List not found');
  // A barback checks it off; the sender sees progress live and hears when it's done.
  call(b1, 'stock.mark', { id: l.id, lineId: l.lines[0].id, state: 'got' });
  assert.equal(call(lou, 'stock.list.get', { id: l.id }).counts.done, 1);
  const n = store.list('notifications').length;
  call(b2, 'stock.mark', { id: l.id, lineId: l.lines[1].id, state: 'got' });
  const done = store.list('notifications').slice(n);
  assert.deepEqual(done.map((x) => x.userId), [lou.id]);
  assert.equal(done[0].i18n.en, 'Well is done (Luciano), everything brought');
  // The sender can delete their own; nobody else on staff can.
  refused(() => call(b1, 'stock.delete', { id: l.id }), 403, 'Supervisors and managers only');
  call(lou, 'stock.delete', { id: l.id });
  // Nobody on now: the barbacks on today's schedule there.
  const n2 = svc.call(store.get('users', lou.id), 'stock.save', { name: 'Later', lines: [{ productId: rum.id, qty: 1 }], assign: { type: 'room', room: 'Moon Rabbit' } });
  assert.deepEqual(n2.assignees, [], 'nobody in that room today');
});

test('roles: supervisors and up schedule lists and templates; Stock lists off means no stock at all', () => {
  const { who, call, role } = demo({ stock: true });
  const emp = who('Arthur');
  const mgr = who('Moe');
  const sup = role('supervisor');
  const p = call(mgr, 'products.list').products[0];
  assert.ok(call(sup, 'stock.save', { name: 'Sup list', date: '2026-09-29', lines: [{ productId: p.id, qty: 1 }], assign: { type: 'person', userId: emp.id } }).id);
  call(mgr, 'roleFeatures.save', { roleFeatures: { supervisor: { stockManage: false }, manager: { stockManage: false } } });
  // Without it a supervisor is like staff: quick lists only.
  const q = call(sup, 'stock.save', { name: 'Again', date: '2026-10-01', lines: [{ productId: p.id, qty: 1 }], assign: { type: 'position', jobCodeId: 'job_bbk' } });
  assert.equal(q.quick, true);
  assert.equal(q.date, TODAY, 'a quick list is for today');
  refused(() => call(sup, 'stock.save', { kind: 'template', name: 'T', lines: [{ productId: p.id, qty: 1 }] }), 403, 'Supervisors and managers only');
  refused(() => call(role('manager'), 'products.review.list'), 403, 'Managers only');
  assert.ok(call(mgr, 'products.review.list'), 'Admins always');
  // Stock lists off for employees: every stock RPC answers "Your role doesn't include this".
  call(mgr, 'roleFeatures.save', { roleFeatures: { employee: { stock: false } } });
  refused(() => call(emp, 'stock.lists.list'), 403, ROLE_OFF);
  refused(() => call(emp, 'products.add', { name: 'Anything' }), 403, ROLE_OFF);
  assert.equal(call(emp, 'app.bootstrap').features.stock, false);
  assert.equal(call(sup, 'app.bootstrap').features.stock, true);
});

test('the library: aliases ("titos", "Tito’s", "vodka") find a product; accents, case and punctuation don’t matter', () => {
  const { who, call } = demo({ stock: true });
  const mgr = who('Moe');
  const v = call(mgr, 'products.add', { name: 'Tito’s Handmade Vodka', category: 'spirits', location: 'Liquor room, shelf 1', aliases: 'Titos, house vodka, Tito’s Handmade Vodka, titos' }).product;
  assert.deepEqual(v.aliases, ['Titos', 'house vodka'], 'its own name and repeats dropped');
  for (const q of ['titos', 'Tito’s', 'TITO S', 'house vodka', 'vodka', 'liquor room', 'tito vodka']) assert.ok(productMatches(v, q), q);
  assert.ok(!productMatches(v, 'gin'));
  assert.ok(productMatches({ name: 'Crème de cassis', aliases: [] }, 'creme de cassis'));
  // Duplicate checks see aliases: adding "Titos" suggests it.
  const r = call(who('Arthur'), 'products.add', { name: 'Titos' });
  assert.ok(r.duplicates.some((d) => d.id === v.id && d.reasons.includes('alias')), JSON.stringify(r.duplicates.map((d) => [d.name, d.reasons])));
  // Staff see the detail: photos, where it's kept, aliases.
  const d = call(who('Arthur'), 'products.get', { id: v.id }).product;
  assert.deepEqual([d.location, d.aliases], ['Liquor room, shelf 1', ['Titos', 'house vodka']]);
  // The import takes aliases too? Managers change them.
  assert.deepEqual(call(mgr, 'products.save', { id: v.id, aliases: ['TV'] }).aliases, ['TV']);
});

test('out reaches the buyer and the shopping list: ordered, then received (back in stock)', () => {
  const { store, who, call } = demo({ stock: true });
  const mgr = who('Moe');
  const kelly = who('Kelly');
  const barback = who('Arthur');
  // Kelly buys for the Bar.
  const b = call(mgr, 'products.saveBuyers', { listId: 'e86_bar', userIds: [kelly.id] });
  assert.deepEqual(b.lists.find((l) => l.id === 'e86_bar').buyers, [kelly.id]);
  assert.ok(b.lists.find((l) => l.id === 'e86_kitchen').defaults.length > 0, 'other lists: the managers of their area');
  refused(() => call(barback, 'products.saveBuyers', { listId: 'e86_bar', userIds: [] }), 403, 'Managers only');
  const l = call(barback, 'stock.list.get', { id: 'stk_demo_today' });
  const line = l.lines.find((x) => !x.state && x.name === 'Club soda');
  call(barback, 'stock.mark', { id: l.id, lineId: line.id, state: 'out' });
  const n = store.list('notifications').length;
  const r = call(barback, 'stock.reportEightySix', { id: l.id, lineId: line.id, status: 'out' });
  assert.equal(r.eightySix.buyers, 1);
  const toBuyer = store.list('notifications').slice(n).filter((x) => x.userId === kelly.id);
  assert.equal(toBuyer.length, 1);
  assert.equal(toBuyer[0].i18n.en, 'To order: Club soda is out on Bar (Arthur)');
  assert.equal(toBuyer[0].i18n.es, 'Para pedir: no hay Club soda en Bar (Arthur)');
  assert.equal(toBuyer[0].link, '#/reports/86');
  // On the shopping list (Reports → 86 List → Missing now) with its photo, supplier and how often it ran short or out.
  const miss = call(mgr, 'reports.eightySix.missing.get').items.find((i) => i.id === r.lines.find((x) => x.id === line.id).reported86.itemId);
  assert.equal(miss.product.name, 'Club soda');
  assert.equal(miss.product.supplier, 'Valley Distributing');
  assert.equal(miss.product.photos.length, 1);
  assert.ok(miss.shortOut >= 2, 'the 86 report and the list’s out');
  // Ordered (the buyer, or a manager), then Received: off the 86 List.
  refused(() => call(barback, 'eightySix.markOrdered', { id: miss.id }), 403, 'Managers only');
  call(kelly, 'eightySix.markOrdered', { id: miss.id });
  const again = call(mgr, 'reports.eightySix.missing.get').items.find((i) => i.id === miss.id);
  assert.equal(again.orderedBy.name, 'Kelly');
  call(kelly, 'eightySix.clear', { id: miss.id });
  assert.ok(!call(mgr, 'reports.eightySix.missing.get').items.some((i) => i.id === miss.id), 'received: back in stock');
  assert.equal(store.get('eightySixLog', miss.id).clearedHow, 'back');
});

test('plan: Stock lists is in every plan; off for a restaurant, its RPCs and routes say so', async () => {
  for (const plan of ['starter', 'pro', 'beta']) assert.equal(resolveFeatures(plan).stock, true, plan);
  for (const m of ['stock.mark', 'stock.lists.list', 'products.add', 'products.importApply']) {
    assert.equal(featureForMethod(m), 'stock', m);
    assert.deepEqual(featuresForMethod(m), ['stock'], m);
  }
  const { svc, store } = demo({ plan: { ...resolveFeatures('starter'), stock: false } });
  const emp = store.list('users', (u) => u.name === 'Arthur')[0];
  assert.equal(svc.call(emp, 'app.bootstrap').features.stock, false, 'the apps hide it');
  const A = await startApp({ tenant: { slug: 'tst', plan: 'starter', status: 'active', isDefault: true, features: { ...resolveFeatures('starter'), stock: false } } });
  try {
    const post = async (p, body, headers = {}) => { const r = await fetch(A.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }; };
    const { cookie } = await signIn(post, 'arthur@demo.shiftboard');
    const r = await post('/api/rpc/stock.lists.list', {}, { Cookie: cookie });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Not included in your plan');
    assert.equal((await fetch(`${A.base}/api/stock/photos/nope`, { headers: { Cookie: cookie } })).status, 403);
  } finally { await A.close(); }
});

test('View as is read-only: the lists and the catalog read as that person; working or adding is refused', () => {
  const { store } = demo({ stock: true });
  const real = store.insert('users', { id: 'usr_test_owner', name: 'Owner', role: 'super_admin', active: true, jobCodes: [], availability: {} });
  const emp = store.list('users', (u) => u.name === 'Arthur')[0];
  const target = resolveTarget(store, real, { userId: emp.id }, { today: TODAY });
  const view = { real, target, actor: viewedPerson(store, real, target), until: Date.now() + 60_000 };
  const opts = { now: () => NOW };
  const mine = viewCall(store, view, 'stock.lists.list', {}, opts);
  assert.ok(mine.lists.some((l) => l.id === 'stk_demo_today'));
  const l = viewCall(store, view, 'stock.list.get', { id: 'stk_demo_today' }, opts);
  assert.equal(l.lines.length, 10);
  assert.ok(viewCall(store, view, 'products.list', {}, opts).products.length > 20);
  assert.ok(viewCall(store, view, 'stock.mine.list', {}, opts));
  for (const [m, a] of [['stock.mark', { id: l.id, lineId: l.lines[5].id, state: 'got' }], ['stock.reportEightySix', { id: l.id, lineId: l.lines[3].id }],
    ['products.add', { name: 'Anything' }], ['stock.save', { name: 'x' }], ['products.merge', {}]]) {
    assert.throws(() => viewCall(store, view, m, a, opts), (e) => e.status === 403 && e.message === VIEW_READ_ONLY, m);
  }
  assert.equal(store.get('stockLists', 'stk_demo_today').lines[5].state, null, 'nothing changed');
});

// ---------- the Claude connector and Ask ShiftBoard ----------
let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });
const ctxFor = (user, { scopes = [READ, WRITE] } = {}) => createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, has: () => true, scopes, via: 'claude', client: 'Test client' });
const person = (name) => A.db.store.list('users', (u) => u.name === name)[0];

test('tools: add_product previews (likely duplicates first), then confirm adds it for review', async () => {
  const emp = person('Arthur');
  const tool = toolByName('add_product');
  // The demo has "Harbor Light Silver Rum": "harbor light silver rum 1L" is it.
  const prev = await runTool(tool, { name: 'harbor light silver rum 1L' }, ctxFor(emp));
  assert.equal(prev.ok, true, prev.error);
  assert.match(prev.summary, /^Preview only, nothing saved/);
  assert.ok(prev.data.likelyDuplicates.some((p) => p.name === 'Harbor Light Silver Rum'));
  const refusedNew = await runTool(tool, { name: 'harbor light silver rum 1L', confirm: true }, ctxFor(emp));
  assert.equal(refusedNew.ok, false);
  assert.equal(refusedNew.status, 409);
  // A preview runs on a read-only connection; adding doesn't.
  assert.equal((await runTool(tool, { name: 'Pineapple juice' }, ctxFor(emp, { scopes: [READ] }))).ok, true);
  assert.equal((await runTool(tool, { name: 'Pineapple juice', confirm: true }, ctxFor(emp, { scopes: [READ] }))).ok, false);
  const done = await runTool(tool, { name: 'Pineapple juice', category: 'mixers', unit: 'case', confirm: true }, ctxFor(emp));
  assert.equal(done.ok, true, done.error);
  assert.equal(done.data.product.waitingForReview, true);
  assert.equal(done.data.product.addedBy, 'Arthur');
  assert.ok(A.db.store.list('auditLog', (x) => x.action === 'claude.add_product').length >= 1);
  // Ask ShiftBoard's card, in Spanish.
  const card = describeAction(tool, { name: 'Pineapple juice', category: 'mixers', unit: 'case' }, 'es');
  assert.equal(card.title, 'Agregar un producto al catálogo');
  assert.deepEqual(card.details, [['Nombre', 'Pineapple juice'], ['Categoría', 'Mezcladores'], ['Unidad', 'case']]);
});

test('tools: create_stock_list needs confirm and a list-maker; get_stock_lists shows what to bring', async () => {
  const mgr = person('Moe');
  const emp = person('Arthur');
  const tool = toolByName('create_stock_list');
  const args = { name: 'Sunday patio', products: [{ name: 'Paper straws', qty: 2 }, { name: 'cocktail napkin', qty: 3 }], person: 'Arthur', date: 'today', due: '15:00' };
  const ask = await runTool(tool, args, ctxFor(mgr));
  assert.equal(ask.status, 409, 'confirm first');
  assert.equal((await runTool(tool, { ...args, confirm: true }, ctxFor(emp))).status, 403, 'not for staff');
  const unknown = await runTool(tool, { ...args, products: [{ name: 'Unicorn tears', qty: 1 }], confirm: true }, ctxFor(mgr));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Not in the product catalog: Unicorn tears/);
  const ok = await runTool(tool, { ...args, confirm: true }, ctxFor(mgr));
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.data.products.map((p) => [p.product, p.qty]), [['Paper straws', 2], ['Cocktail napkins', 3]], '“cocktail napkin” is the catalog’s product');
  assert.deepEqual(ok.data.assignees, ['Arthur']);
  const mine = await runTool(toolByName('get_stock_lists'), {}, ctxFor(emp));
  assert.equal(mine.ok, true, mine.error);
  const sunday = mine.data.lists.find((l) => l.name === 'Sunday patio');
  assert.ok(sunday.products.some((p) => p.product === 'Paper straws' && p.location === 'Dry storage, shelf 4'));
  assert.equal((await runTool(toolByName('get_stock_lists'), { scope: 'all' }, ctxFor(emp))).status, 403);
  const card = describeAction(tool, { name: 'Sunday patio', products: args.products, person: 'Arthur', due: '15:00' }, 'en');
  assert.equal(card.title, 'Create a stock list');
  assert.deepEqual(card.details, [['List', 'Sunday patio'], ['Products', '2 × Paper straws, 3 × cocktail napkin'], ['Person', 'Arthur'], ['Due', '3p']]);
});

test('photos: served to people signed in, from the database (not the cache)', async () => {
  const post = async (p, body, headers = {}) => { const r = await fetch(A.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }; };
  const { cookie } = await signIn(post, 'luciano@demo.shiftboard');
  const add = await post('/api/rpc/products.add', { name: 'Speed pourers' }, { Cookie: cookie });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const up = await post('/api/rpc/products.addPhoto', { id: add.body.result.product.id, dataUrl: PNG, w: 2, h: 2 }, { Cookie: cookie });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const id = up.body.result.photo.id;
  assert.equal(A.db.store.get('productPhotos', id).data, undefined, 'no bytes in the cache');
  const res = await fetch(`${A.base}/api/stock/photos/${id}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${A.base}/api/stock/photos/${id}`)).status, 401);
  // Spanish errors from the API.
  const es = await post('/api/rpc/stock.mark', { id: 'nope' }, { Cookie: cookie, 'X-ShiftBoard-Language': 'es' });
  assert.equal(es.status, 404);
});

// ---------- the 86 List's migration ----------
test('the 86 migration: products from past 86 names where it’s clean, reports linked, every 86 answer the same', () => {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  // Messier history than the demo's: a typo of a name reported often, a spelling in capitals, and a dish from the menu.
  const log = store.list('eightySixLog', (x) => x.name === 'Prosecco')[0];
  store.insert('eightySixLog', { ...log, id: 'e86_typo', name: 'Proseco', key: 'n:proseco' });
  store.insert('eightySixLog', { ...log, id: 'e86_caps', name: 'LIMES', key: 'n:limes', listId: 'e86_bar' });
  const menuItem = store.list('menuItems')[0];
  store.insert('eightySixLog', { ...log, id: 'e86_dish', name: menuItem.name, key: `m:${menuItem.id}`, menuItemId: menuItem.id });
  const svc = createService(store, { now: () => NOW });
  const users = store.list('users');
  const people = [users.find((u) => u.role === 'employee'), users.find((u) => u.role === 'manager'), users.find((u) => u.role === 'admin')];
  const reads = [['eightySix.board.get', {}], ['eightySix.summary', {}], ['eightySix.history.get', { days: 365 }], ['reports.eightySix.history.get', { days: 365 }],
    ['reports.eightySix.trends.get', {}], ['reports.eightySix.missing.get', {}]];
  // Missing now adds each linked report's product (photo, supplier, how often) for the shopping list: nothing else changes.
  const strip = (m, r) => (m === 'reports.eightySix.missing.get' && r ? { ...r, items: r.items.map(({ product: _p, shortOut: _s, ...i }) => i) } : r);
  const answers = () => people.map((u) => reads.map(([m, a]) => { try { return JSON.stringify(strip(m, svc.call(u, m, a))); } catch (e) { return `E${e.status}`; } }));
  const before = answers();
  const logBefore = store.list('eightySixLog').length;

  const marker = ensureCatalog(store, NOW.toISOString());
  assert.equal(marker.id, MIGRATION);
  assert.equal(ensureCatalog(store), null, 'once');
  assert.deepEqual(answers(), before, 'the 86 List reads exactly as before');
  assert.equal(store.list('eightySixLog').length, logBefore);

  const products = store.list('products');
  const names = products.map((p) => p.name);
  assert.ok(names.includes('Prosecco'), 'the name reported most is a product');
  assert.ok(!names.includes('Proseco'), 'its typo isn’t');
  assert.deepEqual(marker.skipped, ['Proseco']);
  assert.equal(store.get('eightySixLog', 'e86_typo').productId, undefined, 'left for a manager, unlinked');
  assert.equal(names.filter((n) => /^limes$/i.test(n)).length, 1, '“LIMES” and “Limes” are one product');
  assert.equal(store.get('eightySixLog', 'e86_caps').productId, products.find((p) => p.name === 'Limes').id);
  assert.ok(!names.includes(menuItem.name), 'a dish from the menu isn’t a product');
  assert.equal(marker.menuItems, 1);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'no duplicates');
  // Every other past report is linked; categories are the catalog's.
  assert.ok(store.list('eightySixLog', (x) => !x.menuItemId && x.id !== 'e86_typo').every((x) => x.productId));
  assert.equal(products.find((p) => p.name === 'Bacardi').category, 'spirits');
  assert.equal(products.find((p) => p.name === 'Prosecco').category, 'wine');
  assert.equal(products.find((p) => p.name === 'Cocktail napkins').category, 'paper');
  assert.equal(products.find((p) => p.name === 'Limes').category, 'garnish', 'produce on a bar list');
  assert.equal(categoryFrom86('produce', 'Tomatoes', false), 'other');
  assert.ok(products.every((p) => p.source === 'migration' && p.review === 'ok' && p.addedBy === null));
  assert.equal(products.find((p) => p.name === 'Limes').eightySixListId, 'e86_bar');
  // A new 86 report of a known name links to it; of a new name adds a product for review (shared catalog).
  const mak = users.find((u) => u.name === 'Mak');
  const r1 = svc.call(mak, 'eightySix.report', { listId: 'e86_bar', name: 'limes', status: 'out' });
  assert.equal(store.get('eightySixItems', r1.item.id).productId, products.find((p) => p.name === 'Limes').id);
  const r2 = svc.call(mak, 'eightySix.report', { listId: 'e86_bar', name: 'Blood oranges', status: 'low', count: 2 });
  const added = store.get('products', store.get('eightySixItems', r2.item.id).productId);
  assert.deepEqual([added.name, added.review, added.source, added.addedBy], ['Blood oranges', 'new', 'eightySix', mak.id]);
  // Picked from the catalog in the report form: its name.
  const r3 = svc.call(mak, 'eightySix.report', { listId: 'e86_bar', productId: products.find((p) => p.name === 'Mint').id, status: 'out' });
  assert.equal(r3.item.name, 'Mint');
  assert.deepEqual(Object.keys(r3.item).sort(), Object.keys(r1.item).sort(), 'the 86 answer has no new fields');
});

test('the 86 migration on an older restaurant runs by itself the first time the catalog (or an 86 report) is used', () => {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  assert.equal(store.get('migrations', MIGRATION), null);
  svc.call(store.list('users', (u) => u.name === 'Arthur')[0], 'stock.lists.list');
  assert.ok(store.get('migrations', MIGRATION));
  assert.ok(store.list('products').length >= 30);
});

// ---------- Spanish ----------
test('Spanish: notifications, errors and the catalog’s words', () => {
  assert.equal(TEXT.es.assigned('Surtido del viernes', '5 pm'), 'Tienes una nueva lista de surtido: Surtido del viernes (para las 5 pm)');
  assert.equal(TEXT.es.out('Surtido', 'Limes', 'Ana'), 'Surtido: Ana dice que no hay Limes', 'product names stay as typed');
  assert.equal(TEXT.es.done('Surtido', 'Ana', 0, 0), 'Surtido está lista (Ana), se trajo todo');
  for (const m of ['Supervisors and managers only', 'This list isn’t assigned to you', 'Say how many you brought (less than asked)', 'Product not found', 'Pick products from the catalog']) {
    assert.notEqual(translateError(m, 'es'), m, m);
  }
  const { who, call } = demo({ stock: true });
  const es = who('Arthur');
  call(es, 'account.preferences', { language: 'es' });
  const l = call(es, 'stock.list.get', { id: 'stk_demo_today' });
  assert.equal(l.lines[0].unitName, 'botella');
  assert.equal(l.lines[0].name, 'Harbor Light Silver Rum', 'product names as typed');
  const cats = call(es, 'products.list').categories;
  assert.equal(cats.find((c) => c.id === 'paper').nameEs, 'Papel y desechables');
});

test('the demo: catalog with photos, two templates, a barback’s list in progress, staff products to review', () => {
  const { store, who, call } = demo({ stock: true });
  const mgr = who('Moe');
  assert.equal(call(mgr, 'stock.lists.list', { scope: 'templates' }).lists.length, 2);
  const today = call(who('Arthur'), 'stock.mine.list').lists.find((l) => l.id === 'stk_demo_today');
  assert.equal(today.status, 'in_progress');
  assert.deepEqual([today.counts.got, today.counts.short, today.counts.out], [2, 1, 1]);
  const queue = call(mgr, 'products.review.list').products;
  assert.equal(queue.length, 3);
  assert.ok(queue[0].matches.length || queue.some((p) => p.matches.length), 'one is a likely duplicate (Merge)');
  assert.ok(store.list('productPhotos').every((p) => p.mime === 'image/svg+xml' && Buffer.from(p.data, 'base64').toString().includes('Sample photo')));
  assert.ok(call(mgr, 'products.list').products.filter((p) => p.photos.length).length >= 20);
  // Copies of the store stay apart (the demo's view-as overlay).
  const copy = new OverlayStore(store);
  createService(copy, { now: () => NOW }).call(who('Arthur'), 'stock.mark', { id: 'stk_demo_today', lineId: today.id ? call(who('Arthur'), 'stock.list.get', { id: today.id }).lines[4].id : '', state: 'got' });
  assert.equal(store.get('stockLists', 'stk_demo_today').lines[4].state, null);
});
