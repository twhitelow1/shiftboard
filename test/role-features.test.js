// Settings → Roles & features (core/role-features.js): which parts of the app each role gets.
//   - defaults change nothing (a fingerprint of every RPC for every role, taken before this existed)
//   - turning a feature off for a role hides it in bootstrap and refuses its RPCs and routes (403, in Spanish too)
//   - the plan decides what's possible; Super Admins always have everything; Admins can't change the Admin column
//   - what's stored is validated, sparse, and Supervisors approving stays settings.supervisorsCanApprove
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { canSeeContacts, canApprove, ROLE_IDS } from '../core/roles.js';
import { translateError } from '../core/errors.js';
import {
  ROLE_FEATURES, ROLE_OFF, roleMatrix, roleAllows, effectiveFeatures, featuresForMethod, cleanRoleFeatures, editableRoles,
} from '../core/role-features.js';
import { resolveFeatures, PLAN_KEYS, FEATURE_KEYS } from '../server/platform/plans.js';
import { startApp } from './helpers/app.js';
import { cookieFor, tokenFor } from './helpers/signin.js';
import { roleFingerprint } from './helpers/role-parity.js';

const WEEK = '2026-09-28'; // the demo week (core/seed.js)

/** The demo data with a Super Admin added, and one active person per role (no names: by role). */
function demo({ plan } = {}) {
  const store = new MemoryStore();
  seedDemo(store, { now: new Date(2026, 8, 27, 12) });
  store.insert('users', { id: 'usr_test_owner', name: 'Owner', role: 'super_admin', email: 'owner@test.local', active: true, jobCodes: [], availability: {} });
  const svc = createService(store, { now: () => new Date(2026, 8, 27, 12), planFeatures: plan || null });
  const of = (role, n = 0) => store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[n];
  return { store, svc, of, call: (u, m, a = {}) => svc.call(store.get('users', u.id), m, a) };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message));

test('defaults change nothing: every RPC answers every role exactly as before Roles & features existed', () => {
  const before = JSON.parse(fs.readFileSync(new URL('./fixtures/role-parity.json', import.meta.url), 'utf8'));
  const now = roleFingerprint();
  assert.deepEqual(now.personas, before.personas);
  const diffs = [];
  for (const [persona, calls] of Object.entries(before.calls)) {
    for (const [call, was] of Object.entries(calls)) if (now.calls[persona][call] !== was) diffs.push(`${persona} ${call}: ${was} → ${now.calls[persona][call]}`);
  }
  assert.deepEqual(diffs, [], 'with the default role settings, nothing anyone sees or can do changed');
  assert.ok(Object.keys(before.calls.employee).length > 190, 'every method, plus realistic reads');

});

test('defaults, rule by rule: the plan as it is for every role, contacts and approvals as before, no RPC refused', () => {
  const { svc, store } = demo();
  const methods = Object.keys(svc.api);
  const settings = svc.settings();
  for (const role of [...ROLE_IDS, 'events']) {
    const u = { id: 'x', role };
    const allows = roleAllows(u, settings);
    assert.equal(allows.coworkerContacts, canSeeContacts(u), `${role}: coworkers’ phone and email as before`);
    assert.equal(allows.approve || !canApprove(u, settings), true, `${role}: approving as before`);
    for (const m of methods) assert.deepEqual(featuresForMethod(m).filter((k) => allows[k] === false), [], `${role} ${m} never refused by default`);
    for (const plan of PLAN_KEYS) {
      const planFeatures = resolveFeatures(plan);
      const eff = effectiveFeatures(u, { settings, plan: planFeatures });
      for (const k of FEATURE_KEYS) assert.equal(eff[k], planFeatures[k], `${role} on ${plan}: ${k} follows the plan`);
    }
  }
  // Supervisors: approving still follows the old setting, both ways.
  store.update('settings', 'settings', { supervisorsCanApprove: false });
  assert.equal(roleMatrix(svc.settings()).supervisor.approve, false);
  assert.equal(roleMatrix({}).employee.announcements, true, 'announcements: everyone reads them; sending stays managers and up');
  assert.equal(roleMatrix({}).manager.reports, true, 'reports: managers and up by default');
  assert.notEqual(roleMatrix({}).supervisor.reports, true, 'reports: not for staff');
});

test('turning Tips off for employees hides it in bootstrap and refuses its RPCs and routes', async () => {
  const A = await startApp();
  try {
    const store = A.db.store;
    const pick = (role) => store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[0];
    const admin = await cookieFor(A.base, pick('admin').email);
    const emp = await cookieFor(A.base, pick('employee').email);
    const sup = await cookieFor(A.base, pick('supervisor').email);
    const rpc = async (cookie, method, args = {}, headers = {}) => {
      const r = await fetch(`${A.base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify(args) });
      return { status: r.status, body: await r.json() };
    };

    assert.equal((await rpc(emp, 'app.bootstrap')).body.result.features.tips, true);
    assert.equal((await rpc(emp, 'myTips.week', { weekStart: WEEK })).status, 200);

    const saved = await rpc(admin, 'roleFeatures.save', { roleFeatures: { employee: { tips: false } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.result.values.employee.tips, false);
    assert.deepEqual(store.get('settings', 'settings').roleFeatures, { employee: { tips: false } }, 'stored: only what differs from the default');

    const boot = (await rpc(emp, 'app.bootstrap')).body.result;
    assert.equal(boot.features.tips, false, 'the web nav and the phone app hide Tips');
    for (const m of ['myTips.week', 'tips.week', 'tipPools.list']) {
      const r = await rpc(emp, m, { weekStart: WEEK });
      assert.equal(r.status, 403, m);
      assert.equal(r.body.error, ROLE_OFF);
    }
    assert.equal((await rpc(emp, 'myTips.week', { weekStart: WEEK }, { 'X-ShiftBoard-Language': 'es' })).body.error, 'Tu rol no incluye esto');
    assert.equal(translateError(ROLE_OFF, 'es'), 'Tu rol no incluye esto');
    // Other roles keep it.
    assert.equal((await rpc(sup, 'app.bootstrap')).body.result.features.tips, true);
    assert.equal((await rpc(sup, 'myTips.week', { weekStart: WEEK })).status, 200);

    // A route of a feature the role doesn't have: Training photos.
    await rpc(admin, 'roleFeatures.save', { roleFeatures: { employee: { training: false } } });
    const photo = await fetch(`${A.base}/api/training/photos/nope`, { headers: { Cookie: emp } });
    assert.equal(photo.status, 403);
    assert.equal((await photo.json()).error, ROLE_OFF);
    assert.equal((await fetch(`${A.base}/api/training/photos/nope`, { headers: { Cookie: sup } })).status, 404, 'supervisors still have Training');
    // The phone app (bearer token) gets the same features and the same refusals.
    const token = await tokenFor(A.base, pick('employee').email);
    const phoneBoot = await (await fetch(`${A.base}/api/rpc/app.bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })).json();
    assert.equal(phoneBoot.result.features.training, false);
    assert.equal(phoneBoot.result.features.tips, false);
  } finally { await A.close(); }
});

test('the plan decides what’s possible: features outside it are locked and off for every role', () => {
  const plan = resolveFeatures('starter'); // no events, forecast or venue
  const { svc, store, of, call } = demo({ plan });
  const admin = of('admin');
  const view = call(admin, 'roleFeatures.get');
  const byKey = Object.fromEntries(view.features.map((f) => [f.key, f]));
  assert.equal(byKey.events.inPlan, false);
  assert.equal(byKey.forecast.inPlan, false);
  assert.equal(byKey.coversForStaff.inPlan, false, 'projected covers come from the forecast');
  assert.equal(byKey.tips.inPlan, true);
  assert.equal(byKey.schedule.inPlan, true, 'scheduling is in every plan');
  refused(() => call(admin, 'roleFeatures.save', { roleFeatures: { employee: { events: false } } }), 400, 'Not included in your plan');
  // Off for everyone, Super Admin included, whatever the role says.
  for (const u of [of('super_admin'), admin, of('employee')]) {
    const boot = svc.call(store.get('users', u.id), 'app.bootstrap');
    assert.equal(boot.features.events, false);
    assert.equal(boot.features.venue, false);
    assert.equal(boot.features.tips, true);
    assert.equal(boot.features.toast, false, 'plan-only features come through as they are');
  }
  // A feature unknown to the plan (another part of the app adds it later) counts as in the plan.
  assert.equal(effectiveFeatures({ role: 'manager' }, { plan }).announcements, true);
});

test('Super Admins always have everything; Admins change only the roles below Admin', () => {
  const { store, of, call } = demo();
  const owner = of('super_admin');
  const admin = of('admin');
  assert.deepEqual(editableRoles(store.get('users', owner.id)), ['employee', 'supervisor', 'manager', 'admin']);
  assert.deepEqual(editableRoles(store.get('users', admin.id)), ['employee', 'supervisor', 'manager']);
  assert.deepEqual(call(admin, 'roleFeatures.get').editable, ['employee', 'supervisor', 'manager']);

  refused(() => call(admin, 'roleFeatures.save', { roleFeatures: { admin: { tips: false } } }), 403, 'Only a Super Admin can change what Admins can do');
  refused(() => call(admin, 'roleFeatures.save', { roleFeatures: { super_admin: { tips: false } } }), 400, 'A Super Admin always has everything');
  refused(() => call(owner, 'roleFeatures.save', { roleFeatures: { super_admin: { tips: false } } }), 400, 'A Super Admin always has everything');
  // Admins may send the Admin column as it is (the editor sends every column).
  const full = call(admin, 'roleFeatures.get').values;
  const rows = Object.fromEntries(['employee', 'supervisor', 'manager', 'admin'].map((r) => [r, Object.fromEntries(Object.entries(full[r]).filter(([, v]) => typeof v === 'boolean'))]));
  rows.employee.eightySix = false;
  assert.equal(call(admin, 'roleFeatures.save', { roleFeatures: rows }).values.employee.eightySix, false);

  // A Super Admin can turn something off for Admins, never for themselves.
  call(owner, 'roleFeatures.save', { roleFeatures: { admin: { tips: false } } });
  assert.equal(call(admin, 'app.bootstrap').features.tips, false);
  refused(() => call(admin, 'tips.week', { weekStart: WEEK }), 403, ROLE_OFF);
  assert.equal(call(owner, 'app.bootstrap').features.tips, true);
  for (const def of ROLE_FEATURES) assert.equal(roleAllows(store.get('users', owner.id), store.get('settings', 'settings'))[def.key], true, def.key);

  // Managers and below can't open the editor.
  refused(() => call(of('manager'), 'roleFeatures.get'), 403, 'Admins only');
  refused(() => call(of('employee'), 'roleFeatures.save', { roleFeatures: {} }), 403, 'Admins only');
});

test('validation: known roles and features, true or false, fixed cells stay fixed, stored sparse', () => {
  const { store, of, call } = demo();
  const owner = of('super_admin');
  const bad = [
    [{ roleFeatures: null }, 400, 'Send the roles and their features'],
    [{ roleFeatures: [] }, 400, 'Send the roles and their features'],
    [{ roleFeatures: { chef: { tips: false } } }, 400, 'Unknown role'],
    [{ roleFeatures: { employee: { payroll: false } } }, 400, 'Unknown feature'],
    [{ roleFeatures: { employee: { tips: 'no' } } }, 400, 'Each feature is either on or off'],
    [{ roleFeatures: { employee: 'all' } }, 400, 'Send the roles and their features'],
    [{ roleFeatures: { manager: { schedule: false } } }, 400, 'That can’t be changed for this role'], // managers always see the schedule
    [{ roleFeatures: { employee: { forecast: true } } }, 400, 'That can’t be changed for this role'], // not for employees
    [{ roleFeatures: { employee: { approve: true } } }, 400, 'That can’t be changed for this role'],
  ];
  for (const [args, status, message] of bad) refused(() => call(owner, 'roleFeatures.save', args), status, message);
  assert.equal(store.get('settings', 'settings').roleFeatures, undefined, 'nothing stored by a refused save');

  call(owner, 'roleFeatures.save', { roleFeatures: { employee: { coworkerContacts: true, tips: true }, supervisor: { approve: false } } });
  assert.deepEqual(store.get('settings', 'settings').roleFeatures, { employee: { coworkerContacts: true } }, 'defaults aren’t stored');
  assert.equal(store.get('settings', 'settings').supervisorsCanApprove, false, 'Supervisors approving: the setting the phone app reads');
  assert.equal(canApprove(of('supervisor'), store.get('settings', 'settings')), false);
  // settings.update can't write role features around the checks.
  call(owner, 'settings.update', { roleFeatures: { employee: { schedule: false } } });
  assert.deepEqual(store.get('settings', 'settings').roleFeatures, { employee: { coworkerContacts: true } });
  // Junk already in the data is ignored when read.
  assert.deepEqual(cleanRoleFeatures({ employee: { tips: 'x', schedule: false, nope: false }, super_admin: { tips: false }, manager: { schedule: false } }), { employee: { schedule: false } });
});

test('what each switch does on the server: schedule, contacts, trading, covers, events access', () => {
  const { store, of, call } = demo();
  const owner = of('super_admin');
  const emp = of('employee');
  const empId = emp.id;
  const save = (rf) => call(owner, 'roleFeatures.save', { roleFeatures: rf });

  // Coworkers' phone & email: on for employees gives them what supervisors see.
  const contacts = () => call(emp, 'app.bootstrap').employees.find((e) => e.id !== empId && e.email);
  assert.equal(contacts(), undefined, 'employees don’t see coworkers’ email by default');
  save({ employee: { coworkerContacts: true } });
  assert.ok(contacts()?.email, 'switched on: they do');
  save({ supervisor: { coworkerContacts: false } });
  assert.equal(call(of('supervisor'), 'app.bootstrap').employees.find((e) => e.id !== of('supervisor').id && e.email), undefined);

  // Without the schedule: only their own shifts and open shifts.
  const all = call(emp, 'shifts.list', { start: WEEK, end: '2026-10-04' });
  assert.ok(all.shifts.some((s) => s.userId && s.userId !== empId));
  save({ employee: { schedule: false } });
  const mine = call(emp, 'shifts.list', { start: WEEK, end: '2026-10-04' });
  assert.ok(mine.shifts.length > 0 && mine.shifts.every((s) => !s.userId || s.userId === empId));
  assert.ok(mine.timeOff.every((x) => x.userId === empId));
  assert.equal(call(emp, 'app.bootstrap').features.schedule, false);

  // Can't trade: still sees trades, can't ask for one.
  save({ employee: { tradeRequests: false } });
  assert.ok(call(emp, 'swaps.list'));
  const shift = store.list('shifts', (s) => s.userId === empId && s.published)[0];
  refused(() => call(emp, 'swaps.create', { shiftId: shift.id, type: 'drop' }), 403, ROLE_OFF);

  // Projected covers off for staff: covers refused, and the phone app's `forecast` (it fetches covers with it) is off.
  save({ employee: { coversForStaff: false } });
  refused(() => call(emp, 'forecast.covers', { weekStart: WEEK }), 403, ROLE_OFF);
  assert.equal(call(emp, 'app.bootstrap').features.forecast, false);
  assert.equal(call(of('manager'), 'app.bootstrap').features.forecast, true);

  // Events off for employees, except a person with Events & BEOs access.
  save({ employee: { events: false } });
  refused(() => call(emp, 'events.list'), 403, ROLE_OFF);
  assert.deepEqual(call(emp, 'shifts.list', { start: WEEK, end: '2026-10-04' }).events, [], 'no event names on the schedule either');
  const coord = of('employee', 3);
  store.update('users', coord.id, { eventsAccess: true });
  assert.ok(Array.isArray(call(coord, 'events.list')));

  // Team off for managers: no adding people.
  save({ manager: { team: false } });
  refused(() => call(of('manager'), 'employees.save', { name: 'Someone New' }), 403, ROLE_OFF);
  assert.equal(call(of('manager'), 'app.bootstrap').features.team, false);
  assert.equal(call(owner, 'app.bootstrap').features.team, true);

});
