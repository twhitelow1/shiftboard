// Saved lists ("par lists") and the run-down (core/stock-saved.js):
//   - personal, room and position lists, and who may make which; sharing with a person, a role, a position or a room,
//     to use or to edit; unsharing; every change in the list's log and the audit log
//   - the templates' migration (each a saved list for its room) and the old template RPCs as aliases
//   - the run-down's math (rounded up to the unit, skipped lines, zero), send to support (a quick list and its
//     notifications), work it myself, out → the 86 List and its buyer, the run history and "usually needs"
//   - par change requests; the Claude tools (preview → confirm) and Ask ShiftBoard's cards; View as; Spanish
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { seedStockDemo } from '../core/stock-seed.js';
import { needFor, usuallyNeeds, SAVED_MIGRATION, SAVED_TEXT } from '../core/stock-saved.js';
import { translateError } from '../core/errors.js';
import { viewCall, viewedPerson, resolveTarget, VIEW_READ_ONLY } from '../core/view-as.js';
import { toolByName, runTool, createToolContext, READ, WRITE } from '../server/tools/index.js';
import { describeAction } from '../server/assistant/actions.js';
import { startApp } from './helpers/app.js';

const NOW = new Date(2026, 8, 27, 12); // the demo's clock: Sunday noon
const TODAY = '2026-09-27';

function demo({ stock = true } = {}) {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  if (stock) seedStockDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const who = (name) => store.list('users', (u) => u.name === name)[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const role = (r, n = 0) => store.list('users', (u) => u.role === r && u.active !== false).sort((a, b) => a.order - b.order)[n];
  const product = (name) => store.list('products', (p) => p.name === name && p.status !== 'archived')[0];
  return { store, svc, who, call, role, product };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message), `${status} ${message || ''}`);
/** Today's shifts: who is on now, and where. */
function onDuty(store, list) {
  for (const s of store.list('shifts', (x) => x.date === TODAY)) store.remove('shifts', s.id);
  for (const [u, job, area, start, end] of list) store.insert('shifts', { id: `shf_t_${u.id}_${start}`, userId: u.id, jobCodeId: job, area, date: TODAY, start, end, published: true });
}

// ---------- the math ----------
test('run-down math: need = max(0, par − on hand), rounded up to the unit; skipped lines need nothing; zero on hand needs the par', () => {
  assert.equal(needFor(6, 4, 'bottle'), 2);
  assert.equal(needFor(6, 4.5, 'bottle'), 2, 'half a bottle left: still two bottles to bring');
  assert.equal(needFor(6, 5.9, 'case'), 1);
  assert.equal(needFor(6, 0, 'bottle'), 6, 'none on hand: the whole par');
  assert.equal(needFor(6, 9, 'bottle'), 0, 'more than the par: nothing');
  assert.equal(needFor(6, 6, 'bottle'), 0);
  assert.equal(needFor(3, 1.2, 'lb'), 2, 'pounds round up to the half');
  assert.equal(needFor(3, 1.6, 'lb'), 1.5);
  assert.equal(needFor(2, 0.25, 'gallon'), 2);
  assert.equal(needFor(4, 1.5, ''), 3, 'no unit: whole ones');
  assert.equal(needFor(4, null, 'bottle'), null, 'skipped');
  assert.equal(needFor(4, '', 'bottle'), null);
  const runs = [1, 3, 2, 8, 2, 4].map((need, i) => ({ counts: [{ lineId: 'a', need }, { lineId: 'b', need: i === 5 ? null : 1 }] }));
  assert.equal(usuallyNeeds(runs, 'a'), 3, 'the median of the last five: 3, 2, 8, 2, 4');
  assert.equal(usuallyNeeds(runs, 'b'), 1, 'a skip doesn’t count');
  assert.equal(usuallyNeeds(runs, 'c'), null);
});

// ---------- making lists ----------
test('lists: anyone makes a personal list; room and position lists are for managers; who sees which', () => {
  const { store, who, call, role, product } = demo();
  const mak = who('Mak'), arthur = who('Arthur'), torie = who('Torie'), moe = who('Moe'), sup = role('supervisor');
  const rum = product('Harbor Light Silver Rum'), limes = product('Limes'), soda = product('Club soda');
  const mine = call(mak, 'stock.saved.save', { name: 'Well 1', lines: [{ productId: rum.id, par: 4 }, { productId: limes.id, par: 2, unit: 'bag', note: 'cut' }] });
  assert.equal(mine.scope.type, 'personal');
  assert.equal(mine.access, 'owner');
  assert.deepEqual(mine.lines.map((x) => [x.name, x.par, x.unit]), [['Harbor Light Silver Rum', 4, 'bottle'], ['Limes', 2, 'bag']]);
  // Personal: nobody else, not even a manager, until it's shared.
  refused(() => call(arthur, 'stock.saved.get', { id: mine.id }), 404, 'List not found');
  refused(() => call(moe, 'stock.saved.get', { id: mine.id }), 404, 'List not found');
  assert.ok(!call(moe, 'stock.saved.list', { all: true }).lists.some((l) => l.id === mine.id));
  // Staff can't make a list for a room or a position, or turn theirs into one.
  refused(() => call(mak, 'stock.saved.save', { name: 'Bar', scope: { type: 'room', room: 'Rabbit Hole' }, lines: [{ productId: rum.id, par: 1 }] }), 403, 'Only managers make lists for a room or a position');
  refused(() => call(mak, 'stock.saved.save', { id: mine.id, scope: { type: 'room', room: 'Rabbit Hole' } }), 403, 'Only managers make lists for a room or a position');
  refused(() => call(mak, 'stock.saved.save', { name: 'x', lines: [{ productId: rum.id, par: -1 }] }), 400, 'A par level is a number from 0 to 9999');
  refused(() => call(mak, 'stock.saved.save', { name: 'x', lines: [] }), 400, 'Add at least one product');
  // A supervisor (stockManage): a room list for the Rabbit Hole, and one for Bartender + Barback in the Rabbit Hole.
  const room = call(sup, 'stock.saved.save', { name: 'Rabbit Hole bar, nightly', scope: { type: 'room', room: 'rabbit hole' }, lines: [{ productId: rum.id, par: 6 }, { productId: soda.id, par: 2 }] });
  assert.deepEqual(room.scope, { type: 'room', room: 'Rabbit Hole' });
  const pos = call(sup, 'stock.saved.save', { name: 'Well', scope: { type: 'positions', jobCodeIds: ['job_bar', 'job_bbk'], room: 'Rabbit Hole' }, lines: [{ productId: limes.id, par: 3 }] });
  assert.equal(pos.scopeLabel, 'Bartender + Barback · Rabbit Hole');
  // Who works the Rabbit Hole sees the room list, to use; who doesn't, doesn't.
  assert.equal(call(arthur, 'stock.saved.get', { id: room.id }).access, 'use');
  assert.equal(call(arthur, 'stock.saved.get', { id: pos.id }).access, 'use');
  refused(() => call(torie, 'stock.saved.get', { id: room.id }), 404, 'List not found'); // a bartender in the Restaurant only
  refused(() => call(torie, 'stock.saved.get', { id: pos.id }), 404, 'List not found');
  assert.equal(call(moe, 'stock.saved.get', { id: room.id }).access, 'manage', 'managers manage every room and position list');
  // Using isn't editing.
  refused(() => call(arthur, 'stock.saved.save', { id: room.id, name: 'Mine now' }), 403, 'You can’t change this list');
  refused(() => call(arthur, 'stock.saved.share', { id: room.id, to: { type: 'person', userId: torie.id } }), 403, 'Only the owner or a manager can do that');
  refused(() => call(arthur, 'stock.saved.delete', { id: room.id }), 403, 'Only the owner or a manager can do that');
  // The list of lists: mine first, then for my spaces; today's rooms first.
  const ls = call(arthur, 'stock.saved.list').lists;
  assert.ok(ls.some((l) => l.id === room.id && l.section === 'forMe'));
  onDuty(store, [[arthur, 'job_bbk', 'Rabbit Hole', '11:00', '19:00']]);
  assert.equal(call(arthur, 'stock.saved.list').lists[0].today, true, 'a list for the room I work today comes first');
  // Every change is logged on the list and in the audit log.
  call(sup, 'stock.saved.save', { id: room.id, lines: [{ productId: rum.id, par: 8 }, { productId: soda.id, par: 2 }] });
  const full = call(sup, 'stock.saved.get', { id: room.id });
  assert.deepEqual(full.log.map((e) => e.what), ['created', 'edited']);
  assert.equal(full.log[1].pars, 1);
  assert.ok(store.list('auditLog', (a) => a.targetId === room.id).map((a) => a.action).includes('stock.saved.edited'));
  // Reorder: the lines keep their ids in the new (shelf) order.
  const re = call(sup, 'stock.saved.save', { id: room.id, lines: [...full.lines].reverse().map((x) => ({ id: x.id, productId: x.productId, par: x.par })) });
  assert.deepEqual(re.lines.map((x) => x.id), [...full.lines].reverse().map((x) => x.id));
  // The owner deletes theirs.
  call(mak, 'stock.saved.delete', { id: mine.id });
  assert.equal(store.get('stockParLists', mine.id), null);
});

// ---------- sharing ----------
test('sharing: a person, a role, a position or a room; use by default, edit when given; unshare; all logged', () => {
  const { store, who, call, product } = demo();
  const mak = who('Mak'), arthur = who('Arthur'), torie = who('Torie'), alex = who('Alex D'), moe = who('Moe');
  const rum = product('Harbor Light Silver Rum');
  const l = call(mak, 'stock.saved.save', { name: 'My station', lines: [{ productId: rum.id, par: 3 }] });
  const n0 = store.list('notifications').length;
  // A person: use (the default), and they're told.
  let v = call(mak, 'stock.saved.share', { id: l.id, to: { type: 'person', userId: torie.id } });
  assert.deepEqual(v.shares.map((x) => [x.label, x.can]), [['Torie', 'use']]);
  const told = store.list('notifications').slice(n0);
  assert.deepEqual(told.map((n) => n.userId), [torie.id]);
  assert.equal(told[0].i18n.en, 'Mak shared the list “My station” with you');
  assert.equal(told[0].i18n.es, 'Mak compartió contigo la lista “My station”');
  assert.equal(told[0].link, `#/stock/saved/${l.id}`);
  const t = call(torie, 'stock.saved.get', { id: l.id });
  assert.equal(t.access, 'use');
  assert.equal(t.canEdit, false);
  assert.ok(call(torie, 'stock.saved.list').lists.some((x) => x.id === l.id && x.section === 'forMe' && x.sharedWithMe));
  refused(() => call(torie, 'stock.saved.save', { id: l.id, name: 'Torie’s now' }), 403, 'You can’t change this list');
  // Edit: they change the lines and pars, but not who it's shared with.
  v = call(mak, 'stock.saved.share', { id: l.id, to: { type: 'person', userId: torie.id }, can: 'edit' });
  assert.equal(v.shares.length, 1, 'the same person again changes what they may do');
  assert.equal(call(torie, 'stock.saved.save', { id: l.id, lines: [{ productId: rum.id, par: 5 }] }).lines[0].par, 5);
  refused(() => call(torie, 'stock.saved.share', { id: l.id, to: { type: 'person', userId: arthur.id } }), 403, 'Only the owner or a manager can do that');
  refused(() => call(torie, 'stock.saved.save', { id: l.id, scope: { type: 'room', room: 'Restaurant' } }), 403, 'Only the owner or a manager can change who it’s for');
  // A position (every Barback), a role level (Supervisors), a room (Moon Rabbit).
  call(mak, 'stock.saved.share', { id: l.id, to: { type: 'position', jobCodeId: 'job_bbk' } });
  assert.equal(call(arthur, 'stock.saved.get', { id: l.id }).access, 'use');
  refused(() => call(alex, 'stock.saved.get', { id: l.id }), 404, 'List not found');
  const supUser = store.list('users', (u) => u.role === 'supervisor' && u.active !== false)[0];
  call(mak, 'stock.saved.share', { id: l.id, to: { type: 'role', role: 'supervisor' } });
  assert.equal(call(supUser, 'stock.saved.get', { id: l.id }).access, 'manage', 'a supervisor (stockManage) it’s shared with manages it');
  const moonOnly = store.list('users', (u) => u.role === 'employee' && (u.jobCodes || []).every((j) => (j.areas || []).length && j.areas.every((a) => a === 'Moon Rabbit')))[0];
  refused(() => call(moonOnly, 'stock.saved.get', { id: l.id }), 404, 'List not found');
  call(mak, 'stock.saved.share', { id: l.id, to: { type: 'room', room: 'moon rabbit' } });
  assert.equal(call(moonOnly, 'stock.saved.get', { id: l.id }).access, 'use');
  refused(() => call(mak, 'stock.saved.share', { id: l.id, to: { type: 'role', role: 'chef' } }), 400, 'Pick a role');
  refused(() => call(mak, 'stock.saved.share', { id: l.id, to: { type: 'person', userId: mak.id } }), 400, 'It’s already theirs');
  // Unshare: gone for them.
  const bb = call(mak, 'stock.saved.get', { id: l.id }).shares.find((x) => x.to.type === 'position');
  call(mak, 'stock.saved.unshare', { id: l.id, shareId: bb.id });
  refused(() => call(arthur, 'stock.saved.get', { id: l.id }), 404, 'List not found');
  refused(() => call(mak, 'stock.saved.unshare', { id: l.id, shareId: bb.id }), 404, 'That share isn’t on the list');
  // A manager sees a personal list only once it's shared with them; then manages it (shares, unshares).
  refused(() => call(moe, 'stock.saved.get', { id: l.id }), 404, 'List not found');
  call(mak, 'stock.saved.share', { id: l.id, to: { type: 'person', userId: moe.id } });
  assert.equal(call(moe, 'stock.saved.get', { id: l.id }).access, 'manage');
  // Logged, on the list and in the audit log.
  const log = call(mak, 'stock.saved.get', { id: l.id }).log.map((e) => e.what);
  assert.deepEqual(log, ['created', 'shared', 'shareChanged', 'edited', 'shared', 'shared', 'shared', 'unshared', 'shared']);
  assert.equal(store.list('auditLog', (a) => a.targetId === l.id && a.action === 'stock.saved.shared').length, 6);
  assert.equal(store.list('auditLog', (a) => a.targetId === l.id && a.action === 'stock.saved.unshared').length, 1);
});

// ---------- templates ----------
test('templates become saved lists for their room once; the old template RPCs keep working on them', () => {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const who = (name) => store.list('users', (u) => u.name === name)[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const moe = who('Moe');
  call(moe, 'products.list'); // the catalog
  const rum = store.list('products', (p) => /^bacardi$/i.test(p.name))[0] || call(moe, 'products.add', { name: 'Well rum', force: true }).product;
  const limes = store.list('products', (p) => /^limes?$/i.test(p.name))[0];
  // An older restaurant's templates (written before saved lists), one with lists sent to the Moon Rabbit.
  const at = '2026-09-01T10:00:00.000Z';
  const tpl = (id, name, lines) => store.insert('stockLists', { id, kind: 'template', name, notes: 'n', lines, date: '', due: '', assign: null, quick: false, templateId: null,
    eightySixListId: 'e86_bar', status: 'open', createdBy: moe.id, createdAt: at, updatedAt: at, log: [] });
  tpl('stk_old_moon', 'Moon Rabbit open', [{ id: 'l1', productId: rum.id, qty: 3, note: 'top shelf' }, { id: 'l2', productId: limes.id, qty: 1, note: '' }]);
  tpl('stk_old_any', 'Anywhere', [{ id: 'l3', productId: limes.id, qty: 2, note: '' }]);
  store.insert('stockLists', { id: 'stk_old_sent', kind: 'list', name: 'Moon Rabbit open', lines: [], date: '2026-09-20', due: '', assign: { type: 'room', room: 'Moon Rabbit' }, templateId: 'stk_old_moon', status: 'done', createdBy: moe.id, createdAt: at, updatedAt: at, log: [] });
  store.remove('migrations', SAVED_MIGRATION);
  // The first time Stock lists are used: each template is a saved list for its room, its quantities the pars.
  const tpls = call(moe, 'stock.lists.list', { scope: 'templates' }).lists;
  const marker = store.get('migrations', SAVED_MIGRATION);
  assert.ok(marker);
  const moon = store.get('stockParLists', marker.lists.stk_old_moon);
  assert.deepEqual(moon.scope, { type: 'room', room: 'Moon Rabbit' }, 'the room its lists went to');
  assert.deepEqual(moon.lines.map((x) => [x.productId, x.par, x.note]), [[rum.id, 3, 'top shelf'], [limes.id, 1, '']]);
  assert.equal(moon.owner, moe.id);
  assert.equal(moon.templateId, 'stk_old_moon');
  assert.deepEqual(store.get('stockParLists', marker.lists.stk_old_any).scope, { type: 'room', room: '' }, 'no room: every room');
  assert.equal(store.get('stockLists', 'stk_old_moon').kind, 'migrated', 'the template is kept, hidden');
  assert.equal(store.get('stockLists', 'stk_old_moon').migratedTo, moon.id);
  // Once only.
  call(moe, 'stock.saved.list');
  assert.equal(store.list('stockParLists').length, 2);
  // The 'templates' scope answers with them, like templates.
  assert.deepEqual(tpls.map((x) => [x.kind, x.name, x.counts.lines]).sort(), [['template', 'Anywhere', 1], ['template', 'Moon Rabbit open', 2]]);
  // stock.fromTemplate: by the saved list's id, or the old template's; each par is how many.
  for (const templateId of [moon.id, 'stk_old_moon']) {
    const l = call(moe, 'stock.fromTemplate', { templateId, date: TODAY, assign: { type: 'person', userId: who('Arthur').id } });
    assert.deepEqual(l.lines.map((x) => [x.productId, x.qty]), [[rum.id, 3], [limes.id, 1]]);
    assert.equal(l.templateId, moon.id);
  }
  // stock.list.get on a template reads like a template did.
  assert.deepEqual(call(moe, 'stock.list.get', { id: moon.id }).lines.map((x) => x.qty), [3, 1]);
  // A new template, and "save as template", make saved lists (every room).
  const t2 = call(moe, 'stock.save', { kind: 'template', name: 'New one', lines: [{ productId: rum.id, qty: 4 }] });
  assert.equal(t2.kind, 'template');
  assert.deepEqual(store.get('stockParLists', t2.id).scope, { type: 'room', room: '' });
  assert.equal(store.get('stockParLists', t2.id).lines[0].par, 4);
  refused(() => call(who('Arthur'), 'stock.fromTemplate', { templateId: moon.id }), 403, 'Supervisors and managers only');
  refused(() => call(moe, 'stock.fromTemplate', { templateId: 'stk_nope' }), 404, 'Template not found');
});

// ---------- the run-down ----------
test('run it: count, see the needs, send them to the barbacks on duty (a quick list, notified); they check it off', () => {
  const { store, who, call, product } = demo();
  const mak = who('Mak'), b1 = who('Arthur'), b2 = who('Luciano'), off = who('Hans'), moe = who('Moe');
  onDuty(store, [[mak, 'job_bar', 'Rabbit Hole', '11:00', '19:00'], [b1, 'job_bbk', 'Rabbit Hole', '11:30', '18:00'], [b2, 'job_bbk', 'Rabbit Hole', '10:00', '16:00'],
    [off, 'job_bbk', 'Rabbit Hole', '17:00', '23:00']]);
  const nightly = call(mak, 'stock.saved.list').lists.find((l) => l.name === 'Nightly bar restock');
  assert.equal(nightly.today, true, 'Mak works the Rabbit Hole today');
  assert.equal(nightly.lastRun.needs, 5, 'the demo’s past run');
  const l = call(mak, 'stock.saved.get', { id: nightly.id });
  const [rum, vodka, gin, tequila, soda, limes, napkins, rocks] = l.lines;
  assert.deepEqual([rum.par, vodka.par, gin.par], [6, 6, 4]);
  assert.equal(rum.last.need, 2, 'last run');
  // Counting (skip the napkins; none of the limes; plenty of soda).
  const counts = [{ lineId: rum.id, onHand: 4.5 }, { lineId: vodka.id, onHand: 6 }, { lineId: gin.id, onHand: 1 }, { lineId: tequila.id, onHand: 0 },
    { lineId: soda.id, onHand: 5 }, { lineId: limes.id, onHand: 0 }, { lineId: napkins.id, skip: true, onHand: 3 }, { lineId: rocks.id, onHand: 2 }];
  const pre = call(mak, 'stock.saved.needs.get', { id: l.id, counts });
  assert.deepEqual(pre.needs.map((x) => [x.name, x.need]), [['Harbor Light Silver Rum', 2], ['Juniper Row Gin', 3], ['Agave Sol Blanco Tequila', 4], ['Limes', 2], ['Rocks glasses', 1]]);
  assert.equal(pre.skipped, 1);
  assert.equal(store.get('stockParLists', l.id).runs.length, 1, 'the preview saves nothing');
  // Send to support: barbacks on duty in the Rabbit Hole.
  const opts = call(mak, 'stock.saved.options.get');
  assert.deepEqual(opts.support, { jobCodeId: 'job_bbk', room: 'Rabbit Hole' });
  const n0 = store.list('notifications').length;
  const r = call(mak, 'stock.saved.run', { id: l.id, counts, send: 'support', assign: { type: 'position', ...opts.support } });
  assert.equal(r.list.quick, true);
  assert.equal(r.list.name, 'Nightly bar restock');
  assert.deepEqual(r.list.lines.map((x) => [x.name, x.qty]), pre.needs.map((x) => [x.name, x.need]), 'just the needed lines, how many each');
  assert.deepEqual(r.list.assignees.map((x) => x.name).sort(), ['Arthur', 'Luciano'], 'on duty now, in that room');
  assert.equal(r.notified, 2);
  const told = store.list('notifications').slice(n0);
  assert.deepEqual(told.map((x) => x.userId).sort(), [b1.id, b2.id].sort());
  assert.equal(told[0].i18n.en, 'Mak needs 5 items');
  assert.equal(store.get('stockLists', r.list.id).savedListId, l.id);
  // The run is in the history: who, when, the counts (skipped: null).
  const after1 = call(mak, 'stock.saved.get', { id: l.id });
  assert.equal(after1.runs.length, 2);
  assert.equal(after1.runs[0].by.name, 'Mak');
  assert.equal(after1.runs[0].needs, 5);
  assert.equal(after1.runs[0].skipped, 1);
  assert.equal(after1.runs[0].listId, r.list.id);
  assert.equal(after1.runs[0].counts.find((c) => c.lineId === napkins.id).onHand, null);
  assert.equal(after1.lines.find((x) => x.id === rum.id).usually, 2, 'usually needs: the last runs’ median');
  assert.deepEqual(after1.lines.find((x) => x.id === napkins.id).last, null, 'skipped both times');
  // A barback checks it off; Mak hears when it's done.
  for (const x of r.list.lines) call(b1, 'stock.mark', { id: r.list.id, lineId: x.id, state: 'got' });
  assert.equal(call(mak, 'stock.list.get', { id: r.list.id }).status, 'done');
  assert.ok(store.list('notifications', (n) => n.userId === mak.id).some((n) => n.i18n?.en === 'Nightly bar restock is done (Arthur), everything brought'));
  // To one person, or a room.
  const toPerson = call(mak, 'stock.saved.run', { id: l.id, counts, send: 'support', assign: { type: 'person', userId: b2.id } });
  assert.deepEqual(toPerson.list.assignees.map((x) => x.name), ['Luciano']);
  const toRoom = call(mak, 'stock.saved.run', { id: l.id, counts, send: 'support', assign: { type: 'room', room: 'Rabbit Hole' } });
  assert.ok(toRoom.list.assignees.length >= 2);
  // The plain quick list still goes to the people on duty only.
  refused(() => call(mak, 'stock.save', { name: 'x', lines: [{ productId: rum.productId, qty: 1 }], assign: { type: 'person', userId: b1.id } }), 400, 'Pick a position or a room');
  // Nothing needed: no list to send; only the counts.
  const full = l.lines.map((x) => ({ lineId: x.id, onHand: x.par }));
  refused(() => call(mak, 'stock.saved.run', { id: l.id, counts: full, send: 'support', assign: { type: 'position', ...opts.support } }), 400, 'Nothing is needed');
  const none = call(mak, 'stock.saved.run', { id: l.id, counts: full });
  assert.equal(none.list, null);
  assert.equal(none.needs.length, 0);
  refused(() => call(mak, 'stock.saved.run', { id: l.id, counts: [] }), 400, 'Count at least one product');
  refused(() => call(mak, 'stock.saved.run', { id: l.id, counts: [{ lineId: rum.id, onHand: -1 }] }), 400, 'On hand is a number from 0 to 99999');
  refused(() => call(mak, 'stock.saved.run', { id: l.id, counts: [{ lineId: 'spn_nope', onHand: 1 }] }), 400, 'That product isn’t on the list');
  // Somebody who can't see it can't run it.
  refused(() => call(who('Torie'), 'stock.saved.run', { id: l.id, counts }), 404, 'List not found');
  assert.ok(store.list('auditLog', (a) => a.targetId === l.id && a.action === 'stock.saved.ran').length >= 4);
  assert.ok(moe);
});

test('run it: work it myself (a list for me, then Got it / Short / Out); out with none in the storeroom → the 86 List and its buyer', () => {
  const { store, who, call, product } = demo();
  const mak = who('Mak'), moe = who('Moe');
  const l = call(mak, 'stock.saved.get', { id: 'spl_demo_station' });
  assert.equal(l.access, 'owner');
  const [rum, vodka, tequila, syrup] = l.lines;
  // A product added on the fly during the run (not on the list): by the owner, kept on the list.
  const mint = product('Mint');
  const added = call(mak, 'stock.saved.addLine', { id: l.id, productId: mint.id, par: 1 });
  assert.equal(added.lines.at(-1).name, 'Mint');
  refused(() => call(mak, 'stock.saved.addLine', { id: l.id, productId: mint.id }), 400, 'It’s already on the list');
  const counts = [{ lineId: rum.id, onHand: 1 }, { lineId: vodka.id, onHand: 0 }, { lineId: tequila.id, onHand: 0 }, { lineId: syrup.id, onHand: 2 }];
  // Out only for a line with none on hand.
  refused(() => call(mak, 'stock.saved.run', { id: l.id, counts, send: 'self', out: [rum.id] }), 400, 'Only a product with none on hand can be marked out');
  const n0 = store.list('notifications').length;
  const r = call(mak, 'stock.saved.run', { id: l.id, counts, send: 'self', out: [tequila.id] });
  assert.equal(r.list.assign.userId, mak.id, 'assigned to me');
  assert.equal(r.list.canWork, true);
  assert.deepEqual(r.list.lines.map((x) => [x.name, x.qty]), [['Harbor Light Silver Rum', 1], ['North Fork Vodka', 2]], 'the out line isn’t on it');
  assert.equal(r.notified, 0, 'nobody else told');
  // Out: on the 86 List (the bar's), and the buyer is told.
  assert.deepEqual(r.eightySix.map((x) => [x.name, x.listId]), [['Agave Sol Blanco Tequila', 'e86_bar']]);
  const item = store.list('eightySixItems', (x) => x.productId === tequila.productId)[0];
  assert.equal(item.status, 'out');
  const buy = store.list('notifications').slice(n0).filter((n) => n.link === '#/reports/86');
  assert.ok(buy.some((n) => n.i18n.en === 'To order: Agave Sol Blanco Tequila is out on Bar (Mak)'), buy.map((n) => n.text).join(' | '));
  assert.ok(buy.some((n) => n.userId === moe.id));
  assert.deepEqual(call(mak, 'stock.saved.get', { id: l.id }).runs[0].out, ['Agave Sol Blanco Tequila']);
  // Then the usual Got it / Short / Out.
  const w = call(mak, 'stock.mark', { id: r.list.id, lineId: r.list.lines[0].id, state: 'got' });
  assert.equal(w.counts.done, 1);
  // A product counted during the run without being on the list (someone who can only use it): only on this run.
  const arthur = who('Arthur');
  const lime = product('Oranges');
  const ar = call(arthur, 'stock.saved.run', { id: l.id, counts: [{ lineId: rum.id, onHand: 2 }, { productId: lime.id, par: 2, onHand: 0.5 }], send: 'self' });
  assert.deepEqual(ar.list.lines.map((x) => [x.name, x.qty]), [['Oranges', 2]]);
  assert.ok(!call(mak, 'stock.saved.get', { id: l.id }).lines.some((x) => x.productId === lime.id));
});

// ---------- par changes ----------
test('par changes: editors change them during a run; others ask the owner, who’s told and answers', () => {
  const { store, who, call } = demo();
  const mak = who('Mak'), arthur = who('Arthur'), moe = who('Moe');
  const l = call(arthur, 'stock.saved.get', { id: 'spl_demo_station' });
  assert.equal(l.access, 'use', 'shared with the Barbacks to use');
  const rum = l.lines[0];
  refused(() => call(arthur, 'stock.saved.setPar', { id: l.id, lineId: rum.id, par: 5 }), 403, 'Ask the owner to change the par');
  refused(() => call(arthur, 'stock.saved.requestPar', { id: l.id, lineId: rum.id, par: rum.par }), 400, 'That’s already the par');
  const n0 = store.list('notifications').length;
  const asked = call(arthur, 'stock.saved.requestPar', { id: l.id, lineId: rum.id, par: 4, note: 'we run out by 10' });
  assert.equal(asked.notified, 1);
  assert.equal(asked.requests.length, 1, 'they see their own request');
  const told = store.list('notifications').slice(n0);
  assert.deepEqual(told.map((n) => n.userId), [mak.id]);
  assert.equal(told[0].i18n.en, 'Arthur asks to change the par for Harbor Light Silver Rum on “My station” from 2 to 4');
  assert.equal(told[0].i18n.es, 'Arthur pide cambiar el par de Harbor Light Silver Rum en “My station” de 2 a 4');
  // The owner sees it and accepts: the par changes, Arthur hears.
  const own = call(mak, 'stock.saved.get', { id: l.id });
  assert.equal(own.openRequests, 1);
  const done = call(mak, 'stock.saved.answerRequest', { id: l.id, requestId: own.requests[0].id, accept: true });
  assert.equal(done.lines[0].par, 4);
  assert.equal(done.requests.length, 0);
  assert.ok(store.list('notifications', (n) => n.userId === arthur.id).some((n) => n.i18n?.en === 'The par for Harbor Light Silver Rum on “My station” is now 4'));
  refused(() => call(mak, 'stock.saved.answerRequest', { id: l.id, requestId: own.requests[0].id }), 404, 'That request was already answered');
  // Declined: the par stays.
  const again = call(arthur, 'stock.saved.requestPar', { id: l.id, lineId: rum.id, par: 9 });
  call(mak, 'stock.saved.answerRequest', { id: l.id, requestId: again.requestId, accept: false });
  assert.equal(call(mak, 'stock.saved.get', { id: l.id }).lines[0].par, 4);
  assert.ok(store.list('notifications', (n) => n.userId === arthur.id).some((n) => n.i18n?.es === 'No se aceptó tu cambio de par de Harbor Light Silver Rum en “My station”'));
  // The owner changes a par directly during a run.
  assert.equal(call(mak, 'stock.saved.setPar', { id: l.id, lineId: rum.id, par: 3.5 }).lines[0].par, 3.5);
  const log = call(mak, 'stock.saved.get', { id: l.id }).log.map((e) => e.what);
  assert.deepEqual(log.slice(-5), ['parAsked', 'parAccepted', 'parAsked', 'parDeclined', 'par']);
  assert.equal(store.list('auditLog', (a) => a.targetId === l.id && a.action === 'stock.saved.parAsked').length, 2);
  // A manager (it isn't shared with them) can't see a personal list's requests.
  refused(() => call(moe, 'stock.saved.get', { id: l.id }), 404, 'List not found');
});

// ---------- View as ----------
test('View as is read-only: saved lists read as that person; running, sharing and saving are refused', () => {
  const { store } = demo();
  const real = store.insert('users', { id: 'usr_test_owner', name: 'Owner', role: 'super_admin', active: true, jobCodes: [], availability: {} });
  const emp = store.list('users', (u) => u.name === 'Arthur')[0];
  const target = resolveTarget(store, real, { userId: emp.id }, { today: TODAY });
  const view = { real, target, actor: viewedPerson(store, real, target), until: Date.now() + 60_000 };
  const opts = { now: () => NOW };
  const ls = viewCall(store, view, 'stock.saved.list', {}, opts);
  assert.ok(ls.lists.some((l) => l.id === 'spl_demo_station'));
  const l = viewCall(store, view, 'stock.saved.get', { id: 'spl_demo_station' }, opts);
  assert.equal(l.access, 'use');
  assert.ok(viewCall(store, view, 'stock.saved.needs.get', { id: l.id, counts: [{ lineId: l.lines[0].id, onHand: 0 }] }, opts).needs.length === 1);
  assert.ok(viewCall(store, view, 'stock.saved.options.get', {}, opts));
  for (const [m, a] of [['stock.saved.run', { id: l.id, counts: [{ lineId: l.lines[0].id, onHand: 0 }], send: 'self' }], ['stock.saved.share', { id: l.id }],
    ['stock.saved.save', { name: 'x' }], ['stock.saved.requestPar', { id: l.id }], ['stock.saved.setPar', { id: l.id }], ['stock.saved.unshare', { id: l.id }]]) {
    assert.throws(() => viewCall(store, view, m, a, opts), (e) => e.status === 403 && e.message === VIEW_READ_ONLY, m);
  }
  assert.equal(store.get('stockParLists', 'spl_demo_station').runs.length, 0, 'nothing changed');
});

// ---------- Spanish ----------
test('Spanish: notifications, errors and labels', () => {
  assert.equal(SAVED_TEXT.es.parYes('Limes', 'Bar', 3), 'El par de Limes en “Bar” ahora es 3');
  for (const m of ['Only managers make lists for a room or a position', 'Ask the owner to change the par', 'Nothing is needed', 'Only a product with none on hand can be marked out',
    'Count at least one product', 'Only the owner or a manager can do that', 'You can’t change this list']) assert.notEqual(translateError(m, 'es'), m, m);
  const { who, call, store } = demo();
  const arthur = who('Arthur');
  store.update('users', arthur.id, { language: 'es' });
  const l = call(arthur, 'stock.saved.get', { id: 'spl_demo_station' });
  assert.equal(l.scopeLabel, 'Solo para mí');
  assert.equal(l.lines[0].unitName, 'botella');
  const all = call(who('Moe'), 'stock.saved.options.get');
  assert.deepEqual(all.roles.map((r) => r.id), ['admin', 'manager', 'supervisor', 'employee']);
});

// ---------- the Claude connector and Ask ShiftBoard ----------
let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });
const ctxFor = (user, { scopes = [READ, WRITE] } = {}) => createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, has: () => true, scopes, via: 'claude', client: 'Test client' });
const person = (name) => A.db.store.list('users', (u) => u.name === name)[0];

test('tools: get_saved_stock_lists, run_stock_list (preview, then confirm sends it), share_stock_list (confirm; owner or manager)', async () => {
  const mak = person('Mak'), arthur = person('Arthur');
  const lists = await runTool(toolByName('get_saved_stock_lists'), {}, ctxFor(arthur));
  assert.equal(lists.ok, true, lists.error);
  assert.ok(lists.data.lists.some((l) => l.name === 'My station' && l.owner === 'Mak'));
  const one = await runTool(toolByName('get_saved_stock_lists'), { list: 'nightly' }, ctxFor(arthur));
  assert.equal(one.data.name, 'Nightly bar restock');
  assert.equal(one.data.products[0].par, 6);
  assert.equal(one.data.lastRun.needed, 5);

  const run = toolByName('run_stock_list');
  const args = { list: 'My station', counts: [{ product: 'Harbor Light Silver Rum', onHand: 0.5 }, { product: 'north fork vodka', onHand: 2 }, { product: 'Simple syrup', onHand: 0 }] };
  const before = A.db.store.get('stockParLists', 'spl_demo_station').runs.length;
  const prev = await runTool(run, args, ctxFor(mak));
  assert.equal(prev.ok, true, prev.error);
  assert.match(prev.summary, /^Preview only, nothing saved/);
  assert.deepEqual(prev.data.needs.map((x) => [x.product, x.need]), [['Harbor Light Silver Rum', 2], ['Simple syrup', 2]]);
  assert.equal(A.db.store.get('stockParLists', 'spl_demo_station').runs.length, before, 'nothing saved');
  assert.equal((await runTool(run, args, ctxFor(mak, { scopes: [READ] }))).ok, true, 'a preview runs on a read-only connection');
  assert.equal((await runTool(run, { ...args, send: 'self', confirm: true }, ctxFor(mak, { scopes: [READ] }))).ok, false);
  const unknown = await runTool(run, { ...args, counts: [{ product: 'Unicorn tears', onHand: 1 }] }, ctxFor(mak));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Not on “My station”: Unicorn tears/);
  const done = await runTool(run, { ...args, send: 'support', person: 'Luciano', confirm: true }, ctxFor(mak));
  assert.equal(done.ok, true, done.error);
  assert.equal(done.data.stockList.for, 'Luciano');
  assert.deepEqual(done.data.stockList.products.map((x) => [x.product, x.qty]), [['Harbor Light Silver Rum', 2], ['Simple syrup', 2]]);
  assert.equal(A.db.store.get('stockParLists', 'spl_demo_station').runs.length, before + 1);
  assert.ok(A.db.store.list('auditLog', (x) => x.action === 'claude.run_stock_list').length >= 1);

  const share = toolByName('share_stock_list');
  const ask = await runTool(share, { list: 'My station', person: 'Torie', can: 'edit' }, ctxFor(mak));
  assert.equal(ask.status, 409, 'confirm first');
  const notMine = await runTool(share, { list: 'My station', person: 'Torie', confirm: true }, ctxFor(arthur));
  assert.equal(notMine.status, 403, 'only the owner or a manager');
  const ok = await runTool(share, { list: 'My station', person: 'Torie', can: 'edit', confirm: true }, ctxFor(mak));
  assert.equal(ok.ok, true, ok.error);
  assert.ok(ok.data.shares.some((x) => x.with === 'Torie' && x.can === 'edit'));
  const un = await runTool(share, { list: 'My station', person: 'Torie', unshare: true, confirm: true }, ctxFor(mak));
  assert.equal(un.ok, true, un.error);
  assert.ok(!un.data.shares.some((x) => x.with === 'Torie'));

  // Ask ShiftBoard's cards, in both languages.
  const card = describeAction(run, { ...args, send: 'support', position: 'Barback' }, 'es');
  assert.equal(card.title, 'Guardar un conteo de surtido');
  assert.deepEqual(card.details, [['Lista', 'My station'], ['Hay', 'Harbor Light Silver Rum: 0.5, north fork vodka: 2, Simple syrup: 0'],
    ['Después', 'Mandar lo que falta al equipo de apoyo'], ['Enviar a', 'Barback']]);
  const card2 = describeAction(share, { list: 'My station', role: 'supervisor', can: 'edit' }, 'en');
  assert.deepEqual(card2, { title: 'Share a stock list', details: [['List', 'My station'], ['Share with', 'Supervisors'], ['They can', 'Edit it']] });
});
