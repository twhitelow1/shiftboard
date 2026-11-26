// "Approves for": approval scopes for trades, giveaways, pickups and time off (core/approval-scope.js).
//   - all / only these (include) / all except (exclude) / none, per person, with role defaults in Settings
//   - a bar manager approves a bar trade, not a kitchen one; a two-way trade needs either side; admins always can
//   - "waiting on you" lists and approval notifications go to approvers in scope plus admins, else to every manager
//   - time off by the requester's positions, with its own switch; the MCP tools follow it; refusals in Spanish
// Every person here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { translateError } from '../core/errors.js';
import { coversShift, coversPerson, cleanScope, describeScope, scopeOf } from '../core/approval-scope.js';
import { toolByName, runTool, createToolContext, READ, WRITE } from '../server/tools/index.js';
import { startApp } from './helpers/app.js';

const NOW = new Date(2026, 8, 27, 12);
const DAY = '2026-10-06';
const OUT = 'You don’t approve requests for this position. A manager who does will decide it.';
const BAR = ['job_bar', 'job_bbk', 'job_coc']; // Bartender, Barback, Cocktail Server (the demo's bar positions)

/** The demo plus invented people: a bar manager, a floor manager, a kitchen manager, bartenders, servers and cooks. */
function setup(store, { svcOpts = {} } = {}) {
  const svc = createService(store, { now: () => NOW, ...svcOpts });
  // A clean slate: the demo's own requests and time off waiting on approval are left out.
  for (const r of store.list('requests')) store.remove('requests', r.id);
  for (const t of store.list('timeOff', (x) => x.status === 'pending')) store.remove('timeOff', t.id);
  store.insert('jobCodes', { id: 'job_t_cook', name: 'Line Cook', short: 'LC', department: 'Kitchen', color: '#444444', order: 50, archived: false });
  const add = (id, name, role, jobs = []) => store.insert('users', { id, name, role, active: true, availability: {}, email: `${id}@example.com`,
    jobCodes: jobs.map(([jobCodeId, areas], i) => ({ jobCodeId, rate: null, primary: i === 0, ...(areas ? { areas } : {}) })) });
  const people = {
    barMgr: add('usr_t_barmgr', 'Sloane Avery', 'manager'),
    floorMgr: add('usr_t_floormgr', 'Dario Penn', 'manager'),
    kitchenMgr: add('usr_t_kitmgr', 'Hollis Grant', 'manager'),
    lead: add('usr_t_lead', 'Mara Quill', 'supervisor'),
    bar1: add('usr_t_bar1', 'Tamsin Holt', 'employee', [['job_bar', ['Rabbit Hole']], ['job_srv', ['Restaurant']]]),
    bar2: add('usr_t_bar2', 'Ezra Lund', 'employee', [['job_bar', ['Rabbit Hole']]]),
    srv1: add('usr_t_srv1', 'Noor Becket', 'employee', [['job_srv', ['Restaurant']], ['job_bar', ['Rabbit Hole']]]),
    cook1: add('usr_t_cook1', 'Lio Marsh', 'employee', [['job_t_cook']]),
    cook2: add('usr_t_cook2', 'Pia Strand', 'employee', [['job_t_cook']]),
    host1: add('usr_t_host1', 'Remy Oak', 'employee', [['job_host', ['Host Stand']]]),
    host2: add('usr_t_host2', 'Ada Fenn', 'employee', [['job_host', ['Host Stand']]]),
  };
  const admin = store.list('users', (u) => u.role === 'admin')[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  // Every other manager and supervisor approves nothing unless nobody else can (the role defaults); the three managers
  // and the shift lead get their own.
  call(admin, 'approvalScope.saveRoles', { manager: { mode: 'none' }, supervisor: { mode: 'none' } });
  call(admin, 'approvalScope.set', { userId: people.barMgr.id, scope: { mode: 'include', positions: BAR } });
  call(admin, 'approvalScope.set', { userId: people.floorMgr.id, scope: { mode: 'include', rooms: ['Restaurant'] } });
  call(admin, 'approvalScope.set', { userId: people.kitchenMgr.id, scope: { mode: 'include', positions: ['job_t_cook'] } });
  let n = 0;
  const shift = (jobCodeId, userId, area = '') => store.insert('shifts', { id: `shf_t_${++n}`, date: DAY, start: '16:00', end: '22:00', jobCodeId, userId, area, published: true, tag: '', notes: '', breakMin: 0 });
  /** A giveaway someone accepted: waiting on approval. */
  const giveaway = (job, from, to, area) => {
    const s = shift(job, from.id, area);
    const r = call(from, 'swaps.create', { shiftId: s.id, type: 'drop' });
    call(to, 'swaps.accept', { requestId: r.id });
    return store.get('requests', r.id);
  };
  return { svc, people, admin, call, shift, giveaway };
}
function demo(opts) {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  return { store, ...setup(store, opts) };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message), `${status} ${message || ''}`);

test('the rules: all, only these, all except, none; rooms by area or department; time off by positions', () => {
  const job = (id) => ({ job_bar: { id: 'job_bar', department: 'Bar' }, job_srv: { id: 'job_srv', department: 'Restaurant' } })[id];
  const barShift = { jobCodeId: 'job_bar', area: 'Rabbit Hole' };
  const srvShift = { jobCodeId: 'job_srv', area: '' }; // no area: its department, Restaurant
  assert.equal(coversShift({ mode: 'all' }, srvShift, job('job_srv')), true);
  assert.equal(coversShift({ mode: 'none' }, srvShift, job('job_srv')), false);
  assert.equal(coversShift({ mode: 'include', positions: ['job_bar'], rooms: [] }, barShift, job('job_bar')), true);
  assert.equal(coversShift({ mode: 'include', positions: ['job_bar'], rooms: [] }, srvShift, job('job_srv')), false);
  assert.equal(coversShift({ mode: 'include', positions: [], rooms: ['restaurant'] }, srvShift, job('job_srv')), true, 'room by department, any spelling');
  assert.equal(coversShift({ mode: 'exclude', positions: [], rooms: ['Restaurant'] }, srvShift, job('job_srv')), false);
  assert.equal(coversShift({ mode: 'exclude', positions: [], rooms: ['Restaurant'] }, barShift, job('job_bar')), true);
  const both = { jobCodes: [{ jobCodeId: 'job_srv' }, { jobCodeId: 'job_bar', areas: ['Rabbit Hole'] }] };
  assert.equal(coversPerson({ mode: 'include', positions: ['job_bar'], rooms: [], timeOff: true }, both, job), true, 'any of their positions');
  assert.equal(coversPerson({ mode: 'include', positions: ['job_host'], rooms: [], timeOff: true }, both, job), false);
  assert.equal(coversPerson({ mode: 'include', positions: ['job_host'], rooms: [], timeOff: false }, both, job), true, 'time off not scoped');
  assert.equal(coversPerson({ mode: 'exclude', positions: ['job_host'], rooms: [], timeOff: true }, { jobCodes: [] }, job), true);
  const fail = (s, m) => { throw Object.assign(new Error(m), { status: s }); };
  refused(() => cleanScope({ mode: 'include' }, { fail }), 400, 'Pick at least one position or room');
  refused(() => cleanScope({ mode: 'include', positions: ['nope'] }, { jobExists: () => false, fail }), 400, 'Pick positions from Rooms & positions');
  assert.equal(describeScope({ mode: 'include', positions: BAR, rooms: [] }, { job: (id) => ({ job_bar: 'Bartender', job_bbk: 'Barback', job_coc: 'Cocktail Server' })[id] }), 'Only: Bartender, Barback, Cocktail Server');
  assert.equal(describeScope({ mode: 'include', positions: [], rooms: ['Bar'] }, { lang: 'es' }), 'Solo: puestos de Bar');
  // Admins always everything, whatever is stored.
  assert.equal(scopeOf({ role: 'admin', approvalScope: { mode: 'none' } }, {}).mode, 'all');
});

test('defaults change nothing: every manager and supervisor approves everything', () => {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  for (const u of store.list('users', (x) => ['manager', 'supervisor'].includes(x.role))) {
    const s = svc.call(u, 'approvalScope.get', {});
    assert.deepEqual([s.scope.mode, s.source], ['all', 'default'], u.name);
  }
});

test('a bar manager approves a bar giveaway but not a kitchen one; admins always can; Spanish refusal', () => {
  const { store, people: p, admin, call, giveaway } = demo();
  const bar = giveaway('job_bar', p.bar1, p.bar2, 'Rabbit Hole');
  const kitchen = giveaway('job_t_cook', p.cook1, p.cook2);
  refused(() => call(p.barMgr, 'swaps.approve', { requestId: kitchen.id }), 403, OUT);
  refused(() => call(p.barMgr, 'swaps.deny', { requestId: kitchen.id }), 403, OUT);
  assert.equal(translateError(OUT, 'es'), 'No apruebas solicitudes de este puesto. Las decide un gerente que sí las aprueba.');
  refused(() => call(p.floorMgr, 'swaps.approve', { requestId: bar.id }), 403, OUT);
  call(p.barMgr, 'swaps.approve', { requestId: bar.id });
  assert.equal(store.get('requests', bar.id).status, 'approved');
  assert.equal(store.get('shifts', bar.shiftId).userId, p.bar2.id);
  call(admin, 'swaps.approve', { requestId: kitchen.id });
  assert.equal(store.get('requests', kitchen.id).status, 'approved', 'admins can always approve');
});

test('a two-way trade: an approver in scope for either shift decides it (documented rule)', () => {
  const { store, people: p, call, shift } = demo();
  const mine = shift('job_bar', p.bar1.id, 'Rabbit Hole');
  const theirs = shift('job_srv', p.srv1.id, 'Restaurant');
  const r = call(p.bar1, 'swaps.create', { shiftId: mine.id, type: 'swap', targetShiftId: theirs.id });
  call(p.srv1, 'swaps.accept', { requestId: r.id });
  const waiting = (u) => call(u, 'swaps.list').approvals.map((x) => x.id);
  assert.deepEqual(waiting(p.barMgr), [r.id]);
  assert.deepEqual(waiting(p.floorMgr), [r.id]);
  assert.deepEqual(waiting(p.kitchenMgr), []);
  // Both sides' approvers were told.
  const told = store.list('notifications', (x) => x.kind === 'approvalNeeded').map((x) => x.userId);
  assert.ok(told.includes(p.barMgr.id) && told.includes(p.floorMgr.id) && !told.includes(p.kitchenMgr.id));
  refused(() => call(p.kitchenMgr, 'swaps.approve', { requestId: r.id }), 403, OUT);
  call(p.floorMgr, 'swaps.approve', { requestId: r.id });
  assert.equal(store.get('shifts', mine.id).userId, p.srv1.id);
});

test('notifications and “waiting on you” go to approvers in scope plus admins; with nobody in scope, every manager', () => {
  const { store, people: p, admin, call, giveaway } = demo();
  const mgrs = store.list('users', (u) => ['manager', 'admin', 'super_admin'].includes(u.role) && u.active !== false).map((u) => u.id);
  const bar = giveaway('job_bar', p.bar1, p.bar2, 'Rabbit Hole');
  const toldBar = new Set(store.list('notifications', (x) => x.kind === 'approvalNeeded').map((x) => x.userId));
  assert.ok(toldBar.has(p.barMgr.id), 'the bar manager');
  assert.ok(toldBar.has(admin.id), 'admins');
  assert.ok(!toldBar.has(p.floorMgr.id) && !toldBar.has(p.kitchenMgr.id) && !toldBar.has(p.lead.id), 'not the others');
  assert.equal(call(p.floorMgr, 'app.bootstrap').pendingApprovals, 0);
  assert.equal(call(p.barMgr, 'app.bootstrap').pendingApprovals, 1);
  assert.deepEqual(call(p.floorMgr, 'swaps.list').approvals, []);
  // The host stand: nobody has it in scope → every manager is told and can decide it, so it never gets stuck.
  const host = giveaway('job_host', p.host1, p.host2, 'Host Stand');
  const toldHost = new Set(store.list('notifications', (x) => x.kind === 'approvalNeeded' && x.at && x.args?.en?.[1]?.includes('Host')).map((x) => x.userId));
  for (const id of mgrs) assert.ok(toldHost.has(id), `manager ${id} told`);
  assert.ok(!toldHost.has(p.lead.id), 'supervisors aren’t part of the fallback');
  assert.ok(call(p.kitchenMgr, 'swaps.list').approvals.some((x) => x.id === host.id));
  call(p.kitchenMgr, 'swaps.approve', { requestId: host.id });
  assert.equal(store.get('requests', host.id).status, 'approved');
  assert.equal(bar.status, 'pending_approval');
});

test('exclude lists, role defaults and the person’s own setting; who may set it', () => {
  const { store, people: p, admin, call, giveaway } = demo();
  const bar = giveaway('job_bar', p.bar1, p.bar2, 'Rabbit Hole');
  const kitchen = giveaway('job_t_cook', p.cook1, p.cook2);
  // The supervisor follows the role default (none); their own "all except Kitchen" overrides it.
  assert.equal(call(p.lead, 'approvalScope.get').source, 'role');
  refused(() => call(p.lead, 'swaps.approve', { requestId: bar.id }), 403, OUT);
  call(p.barMgr, 'approvalScope.set', { userId: p.lead.id, scope: { mode: 'exclude', rooms: ['Kitchen'] } });
  const got = call(p.lead, 'approvalScope.get');
  assert.deepEqual([got.source, got.scope.mode, got.label.en], ['person', 'exclude', 'All except: Kitchen positions']);
  refused(() => call(p.lead, 'swaps.approve', { requestId: kitchen.id }), 403, OUT);
  call(p.lead, 'swaps.approve', { requestId: bar.id });
  // Back to the role default.
  call(admin, 'approvalScope.set', { userId: p.lead.id, scope: null });
  assert.equal(call(p.lead, 'approvalScope.get').source, 'role');
  // Who may set it: never your own, never an admin's; a manager can't set another manager's; admins can.
  refused(() => call(p.barMgr, 'approvalScope.set', { userId: p.barMgr.id, scope: { mode: 'all' } }), 403, 'Ask another manager or an admin to change what you approve');
  refused(() => call(p.barMgr, 'approvalScope.set', { userId: p.floorMgr.id, scope: { mode: 'all' } }), 403, 'Only a higher role can change what they approve');
  refused(() => call(admin, 'approvalScope.set', { userId: admin.id, scope: { mode: 'none' } }), 400, 'Admins and Super Admins always approve everything');
  refused(() => call(p.bar1, 'approvalScope.set', { userId: p.lead.id, scope: { mode: 'all' } }), 403);
  refused(() => call(p.barMgr, 'approvalScope.saveRoles', { manager: { mode: 'all' } }), 403);
  refused(() => call(admin, 'approvalScope.set', { userId: p.lead.id, scope: { mode: 'include', rooms: ['Nowhere'] } }), 400, 'Pick rooms from Rooms & positions');
  assert.equal(translateError('Pick rooms from Rooms & positions', 'es'), 'Elige salones de Salones y puestos');
  assert.ok(store.list('auditLog', (a) => a.action === 'approvalScope.set').length >= 4);
});

test('time off: in scope when any of the requester’s positions is; its own switch; marked out of scope in the list', () => {
  const { store, people: p, admin, call } = demo();
  const t = call(p.bar1, 'timeOff.create', { startDate: '2026-10-20' }); // bartender (Rabbit Hole) and server (Restaurant)
  const told = store.list('notifications', (x) => x.kind === 'requestedOff').map((x) => x.userId);
  assert.ok(told.includes(p.barMgr.id) && told.includes(p.floorMgr.id) && !told.includes(p.kitchenMgr.id), 'both of their positions’ managers');
  const c = call(p.cook1, 'timeOff.create', { startDate: '2026-10-21' });
  const list = call(p.barMgr, 'timeOff.list');
  assert.equal(list.find((x) => x.id === c.id).outOfScope, true);
  assert.equal(list.find((x) => x.id === t.id).outOfScope, undefined);
  refused(() => call(p.barMgr, 'timeOff.decide', { id: c.id, status: 'approved' }), 403, 'You don’t approve time off for this person’s positions. A manager who does will decide it.');
  assert.match(translateError('You don’t approve time off for this person’s positions. A manager who does will decide it.', 'es'), /^No apruebas días libres/);
  // "Use the same scope for time off" off: any approver decides time off, as before.
  call(admin, 'approvalScope.set', { userId: p.barMgr.id, scope: { mode: 'include', positions: BAR, timeOff: false } });
  assert.equal(call(p.barMgr, 'timeOff.list').find((x) => x.id === c.id).outOfScope, undefined);
  call(p.barMgr, 'timeOff.decide', { id: c.id, status: 'approved' });
  assert.equal(store.get('timeOff', c.id).status, 'approved');
  call(p.floorMgr, 'timeOff.decide', { id: t.id, status: 'denied' });
});

// ---------- the Claude connector / Ask ShiftBoard ----------
let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });

test('MCP: get_pending_approvals, approve_request and deny_request follow the scope (and answer in Spanish)', async () => {
  let fx;
  await A.db.run((store) => { fx = setup(store); return null; }, { write: true });
  const ctxFor = (u) => createToolContext({ db: A.db, userId: u.id, v: 0, has: () => true, scopes: [READ, WRITE], via: 'claude', client: 'Test client' });
  let bar, kitchen, off;
  await A.db.run((store) => {
    const call = (u, m, a = {}) => createService(store, { now: () => NOW }).call(store.get('users', u.id), m, a);
    const mk = (job, from, to, area) => {
      const s = store.insert('shifts', { date: DAY, start: '16:00', end: '22:00', jobCodeId: job, userId: from.id, area, published: true, tag: '', notes: '', breakMin: 0 });
      const r = call(from, 'swaps.create', { shiftId: s.id, type: 'drop' });
      call(to, 'swaps.accept', { requestId: r.id });
      return r.id;
    };
    bar = mk('job_bar', fx.people.bar1, fx.people.bar2, 'Rabbit Hole');
    kitchen = mk('job_t_cook', fx.people.cook1, fx.people.cook2, '');
    off = call(fx.people.cook1, 'timeOff.create', { startDate: '2026-10-22' }).id;
    return null;
  }, { write: true });
  const p = fx.people;
  const pending = await runTool(toolByName('get_pending_approvals'), {}, ctxFor(p.barMgr));
  assert.equal(pending.ok, true, pending.error);
  assert.deepEqual(pending.data.trades.map((x) => x.id), [bar]);
  assert.deepEqual(pending.data.timeOff, [], 'the cook’s time off isn’t the bar manager’s');
  const no = await runTool(toolByName('approve_request'), { requestId: kitchen }, ctxFor(p.barMgr));
  assert.deepEqual([no.ok, no.status], [false, 403]);
  assert.match(no.error, /don’t approve requests for this position/);
  await A.db.run((store) => { store.update('users', p.barMgr.id, { language: 'es' }); return null; }, { write: true });
  const es = await runTool(toolByName('deny_request'), { timeOffId: off }, ctxFor(p.barMgr));
  assert.equal(es.ok, false);
  assert.match(es.error, /^No apruebas días libres/);
  const yes = await runTool(toolByName('approve_request'), { requestId: bar }, ctxFor(p.barMgr));
  assert.equal(yes.ok, true, yes.error);
  const kit = await runTool(toolByName('get_pending_approvals'), {}, ctxFor(p.kitchenMgr));
  assert.deepEqual(kit.data.trades.map((x) => x.id), [kitchen]);
  assert.deepEqual(kit.data.timeOff.map((x) => x.id), [off]);
});
