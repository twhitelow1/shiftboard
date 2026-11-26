// View as (server/view-as.js, core/view-as.js): a Super Admin sees the app exactly as one person or one role does.
//   - reads come out exactly as the viewed person's own (compared with calling as them, RPC by RPC)
//   - strictly read-only: every write RPC and route is refused (sign-out, password, consent, push, texts…), nothing saved
//   - Super Admins only, never themselves, re-checked on every request; never from the phone app or a support session
//   - their sign-in details stay hidden; every start and stop is in the audit log; it expires after 45 minutes
//   - a role with no person (positions, rooms), a typical person, and a preview of unsaved Roles & features
//   - the demo (core in the browser) follows the same rules
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MemoryStore, OverlayStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { ROLE_OFF } from '../core/role-features.js';
import {
  VIEW_READ_ONLY, VIEW_SUPER_ONLY, VIEW_NOT_PHONE, VIEW_NOT_SUPPORT, VIEW_HIDDEN, VIEW_MINUTES, STAND_IN_ID,
  viewCall, viewedPerson, resolveTarget, isViewRead,
} from '../core/view-as.js';
import { startApp } from './helpers/app.js';
import { signIn, tokenFor } from './helpers/signin.js';

const WEEK = '2026-09-28';
const END = '2026-10-04';
const SECRET = 'view-as-test-secret';
const clock = { offset: 0 };
let A;
let owner; // the Super Admin (the demo data has none: added here, no real person)
const people = {};

/** A tiny browser: JSON requests that keep cookies (and drop the ones the server clears). */
function browser() {
  const jar = new Map();
  const send = async (method, path, body, headers = {}) => {
    const res = await fetch(A.base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a))) jar.delete(name); else jar.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  return {
    jar,
    get: (path, headers) => send('GET', path, undefined, headers),
    post: (path, body = {}, headers) => send('POST', path, body, headers),
    rpc: (m, args = {}, headers) => send('POST', `/api/rpc/${m}`, args, headers),
    async login(email) { const r = await signIn((p, b) => send('POST', p, b), email); assert.equal(r.status, 200, `sign in ${email}: ${r.text}`); return this; },
  };
}
const ok = (r) => { assert.equal(r.status, 200, r.text); return r.body.result; };
const auditLog = () => A.db.store.list('auditLog', (x) => x.action.startsWith('viewAs.')).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
const maxSeq = async () => Number((await A.conn.query('SELECT max(seq) AS m FROM shiftboard.docs')).rows[0].m);

before(async () => {
  A = await startApp({ env: { JWT_SECRET: SECRET }, now: () => Date.now() + clock.offset });
  const pick = (role, n = 0) => A.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[n];
  for (const r of ['admin', 'manager', 'supervisor', 'employee']) people[r] = pick(r);
  people.employee2 = pick('employee', 2);
  owner = await A.db.run((s) => s.insert('users', { id: 'usr_test_owner', name: 'Owner', role: 'super_admin', email: 'owner@viewas.test', phone: '555-0100', active: true,
    jobCodes: [], availability: {}, passwordHash: bcrypt.hashSync('demo1234', 4), createdAt: new Date().toISOString() }), { write: true });
});
after(async () => { await A.close(); });

/** Bootstrap without what only View as adds (viewAs) or hides (sign-in details). */
const comparable = (method, raw) => {
  const r = raw && JSON.parse(JSON.stringify(raw, (k, v) => (k === 'now' ? undefined : v))); // the clock moved on between the two calls
  if (method !== 'app.bootstrap' || !r) return r;
  const { viewAs: _v, ...rest } = r;
  const { security: _s, hidden: _h, ...me } = rest.me;
  return { ...rest, me };
};

test('reads come out exactly as the viewed person sees them (RPC by RPC, for each role)', async () => {
  const boss = await browser().login(owner.email);
  const event = A.db.store.list('events').sort((a, b) => a.id.localeCompare(b.id))[0];
  const reads = [
    ['app.bootstrap', {}], ['shifts.list', { start: WEEK, end: END }], ['swaps.list', {}], ['timeOff.list', {}], ['events.list', { start: '2026-09-01' }],
    ['events.get', { id: event.id }], ['notifications.list', {}], ['myTips.week', { weekStart: WEEK }], ['menu.list', {}], ['eightySix.board.get', {}],
    ['forecast.covers', { weekStart: WEEK }], ['forecast.week', { weekStart: WEEK }], ['mod.get', {}], ['training.summary', {}], ['venue.get', {}], ['layout.get', {}],
  ];
  const direct = {};
  for (const role of ['employee', 'supervisor', 'manager', 'admin']) direct[role] = await browser().login(people[role].email);
  for (const role of ['employee', 'supervisor', 'manager', 'admin']) {
    const info = ok(await boss.post('/api/view-as/start', { userId: people[role].id }));
    assert.equal(info.name, people[role].name);
    assert.equal(info.role, role);
    for (const [m, args] of reads) {
      const mine = await direct[role].rpc(m, args);
      const seen = await boss.rpc(m, args);
      assert.equal(seen.status, mine.status, `${role} ${m}: same answer`);
      assert.deepEqual(comparable(m, seen.body?.result), comparable(m, mine.body?.result), `${role} ${m}: the same data`);
      assert.equal(seen.body?.error, mine.body?.error, `${role} ${m}: the same refusal, if any`);
    }
    const boot = ok(await boss.rpc('app.bootstrap'));
    assert.equal(boot.me.id, people[role].id);
    assert.equal(boot.viewAs.by.id, owner.id);
    assert.equal(boot.viewAs.kind, 'person');
  }
  ok(await boss.post('/api/view-as/stop'));
  assert.equal(ok(await boss.rpc('app.bootstrap')).me.id, owner.id, 'Exit view: back to the Super Admin');
});

test('strictly read-only: every write RPC and route is refused with a clear message, and nothing is saved', async () => {
  const boss = await browser().login(owner.email);
  const emp = people.employee;
  ok(await boss.post('/api/view-as/start', { userId: emp.id }));
  const before = await maxSeq();
  const shift = A.db.store.list('shifts', (s) => s.userId === emp.id && s.published)[0];
  const writes = [
    ['swaps.create', { shiftId: shift.id, type: 'drop' }], ['timeOff.create', { startDate: END }], ['shifts.save', { date: WEEK, start: '16:00', jobCodeId: shift.jobCodeId }],
    ['account.preferences', { language: 'es' }], ['employees.changePassword', { password: 'a-brand-new-passphrase' }], ['consent.accept', { terms: true }],
    ['sms.preferences', { sms: true }], ['push.subscribe', { subscription: {} }], ['devices.register', { token: 'ExpoPushToken[x]', platform: 'ios' }],
    ['notifications.readAll', {}], ['profile.update', { name: 'X' }], ['roleFeatures.save', { roleFeatures: {} }], ['settings.update', { restaurantName: 'X' }],
    ['manual.ack', {}], ['quiz.start', {}], ['eightySix.report', {}], ['events.comment', { eventId: 'evt_aspen', text: 'hi' }], ['employees.save', { name: 'X' }],
  ];
  for (const [m, args] of writes) {
    const r = await boss.rpc(m, args);
    assert.equal(r.status, 403, m);
    assert.equal(r.body.error, VIEW_READ_ONLY, m);
  }
  assert.equal((await boss.rpc('swaps.create', {}, { 'X-ShiftBoard-Language': 'es' })).body.error,
    'Solo lectura mientras ves la app como otra persona. Sal de la vista para hacer cambios.');
  for (const path of ['/api/auth/logout', '/api/rpc-ical-link', '/api/push/test', '/api/sms/test', '/api/users/invite-all', '/api/billing/portal', '/api/email/test',
    '/api/auth/mfa/totp/setup', '/api/auth/passkey/register/options', '/api/auth/mfa/recovery/regenerate', `/api/users/${emp.id}/invite`, `/api/users/${emp.id}/reset-2fa`,
    '/api/onboarding/state', '/api/toast/sync']) {
    const r = await boss.post(path, {});
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error, VIEW_READ_ONLY, path);
  }
  // Their secrets: never, not even as a read.
  for (const path of ['/api/auth/security', '/api/consents.csv']) {
    const r = await boss.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error, VIEW_HIDDEN, path);
  }
  const boot = ok(await boss.rpc('app.bootstrap'));
  assert.equal(boot.me.security, null, 'no authenticator, passkeys or recovery codes');
  assert.equal(boot.me.hidden, true);
  assert.equal(await maxSeq(), before, 'not one document written while viewing');

  // Exit view, then the same things work again (sign-out included).
  ok(await boss.post('/api/view-as/stop'));
  assert.equal((await boss.rpc('notifications.readAll')).status, 200);
  assert.equal((await boss.post('/api/auth/logout')).status, 200);
});

test('Super Admins only, never themselves; checked again on every request', async () => {
  const emp = people.employee;
  for (const role of ['admin', 'manager', 'employee']) {
    const b = await browser().login(people[role].email);
    const r = await b.post('/api/view-as/start', { userId: emp.id });
    assert.equal(r.status, 403, role);
    assert.equal(r.body.error, VIEW_SUPER_ONLY);
    assert.equal((await b.get('/api/view-as/options')).status, 403, role);
  }
  const boss = await browser().login(owner.email);
  const opts = ok(await boss.get('/api/view-as/options'));
  assert.ok(opts.people.some((p) => p.id === people.admin.id), 'anyone at or below their rank');
  assert.ok(!opts.people.some((p) => p.id === owner.id), 'not themselves');
  assert.deepEqual(opts.roles, ['employee', 'supervisor', 'manager', 'admin']);
  assert.equal(opts.minutes, VIEW_MINUTES);
  assert.ok(opts.positions.length && opts.rooms.length);

  assert.equal((await boss.post('/api/view-as/start', { userId: owner.id })).status, 400, 'not yourself');
  assert.equal((await boss.post('/api/view-as/start', { userId: 'usr_nobody' })).status, 404);
  assert.equal((await boss.post('/api/view-as/start', { role: 'super_admin' })).status, 400, 'not the top role');
  await A.db.run((s) => s.update('users', people.employee2.id, { active: false }), { write: true });
  assert.equal((await boss.post('/api/view-as/start', { userId: people.employee2.id })).body.error, 'This person is inactive');
  await A.db.run((s) => s.update('users', people.employee2.id, { active: true }), { write: true });

  // While viewing as an Admin: nothing to escalate with (it's read-only), and it ends as soon as they'd outrank you.
  ok(await boss.post('/api/view-as/start', { userId: people.admin.id }));
  assert.equal((await boss.rpc('roleFeatures.save', { roleFeatures: { admin: { tips: false } } })).body.error, VIEW_READ_ONLY);
  assert.equal(ok(await boss.rpc('roleFeatures.get')).editable.includes('admin'), false, 'the editor as the Admin sees it');
  await A.db.run((s) => s.update('users', owner.id, { role: 'admin' }), { write: true }); // no longer a Super Admin
  const boot = ok(await boss.rpc('app.bootstrap'));
  assert.equal(boot.me.id, owner.id);
  assert.equal(boot.viewAs, undefined, 'the view ended by itself');
  assert.equal(auditLog().at(-1).details.reason, 'ended');
  await A.db.run((s) => s.update('users', owner.id, { role: 'super_admin' }), { write: true });
  // Another Super Admin is at their rank: allowed.
  const other = await A.db.run((s) => s.insert('users', { id: 'usr_test_owner2', name: 'Co-owner', role: 'super_admin', email: 'co@viewas.test', active: true, jobCodes: [], availability: {} }), { write: true });
  assert.equal(ok(await boss.post('/api/view-as/start', { userId: other.id })).role, 'super_admin');
  ok(await boss.post('/api/view-as/stop'));
});

test('a role with no person: picked positions and rooms; published shifts only; pay rates and contacts hidden; Training by position', async () => {
  const boss = await browser().login(owner.email);
  const server = A.db.store.list('jobCodes', (j) => /server/i.test(j.name))[0];
  const draft = ok(await boss.rpc('shifts.save', { date: WEEK, start: '11:00', end: '15:00', jobCodeId: server.id, published: false })).shift;
  assert.ok(ok(await boss.rpc('shifts.list', { start: WEEK, end: END })).shifts.some((s) => s.id === draft.id), 'the Super Admin sees the draft');

  const info = ok(await boss.post('/api/view-as/start', { role: 'employee', positions: [server.id, 'job_nope'], rooms: ['Restaurant'] }));
  assert.equal(info.kind, 'role');
  assert.deepEqual(info.positions, [server.name], 'unknown positions dropped');
  const boot = ok(await boss.rpc('app.bootstrap'));
  assert.equal(boot.me.id, STAND_IN_ID);
  assert.equal(boot.me.role, 'employee');
  assert.deepEqual(boot.me.jobCodes.map((j) => j.jobCodeId), [server.id]);
  assert.deepEqual(boot.me.jobCodes[0].areas, ['Restaurant']);
  for (const e of boot.employees.filter((x) => x.id !== STAND_IN_ID)) {
    assert.equal(e.email, undefined, 'no coworkers’ email');
    assert.ok(e.jobCodes.every((j) => j.rate === undefined), 'no pay rates');
  }
  const week = ok(await boss.rpc('shifts.list', { start: WEEK, end: END }));
  assert.ok(week.shifts.length && week.shifts.every((s) => s.published), 'published shifts only');
  assert.equal((await boss.rpc('forecast.week', { weekStart: WEEK })).status, 403, 'managers’ tools stay closed');
  assert.ok(ok(await boss.rpc('training.summary')), 'Training works for the stand-in');
  assert.ok(ok(await boss.rpc('menu.list')));
  assert.equal(A.db.store.get('users', STAND_IN_ID), null, 'the stand-in is never saved');
  ok(await boss.post('/api/view-as/stop'));
  ok(await boss.rpc('shifts.delete', { id: draft.id }));

  // A typical person in a role: a real person of that role.
  const typical = ok(await boss.post('/api/view-as/start', { role: 'employee', typical: true }));
  assert.equal(typical.kind, 'person');
  assert.equal(typical.typical, 'employee');
  assert.equal(A.db.store.get('users', typical.userId).role, 'employee');
  ok(await boss.post('/api/view-as/stop'));
});

test('preview unsaved Roles & features as a role: the draft applies to the view only', async () => {
  const boss = await browser().login(owner.email);
  const info = ok(await boss.post('/api/view-as/start', { role: 'employee', draft: { roleFeatures: { employee: { tips: false, coworkerContacts: true } }, supervisorsCanApprove: false } }));
  assert.equal(info.draft, true);
  const boot = ok(await boss.rpc('app.bootstrap'));
  assert.equal(boot.features.tips, false);
  assert.equal(boot.features.coworkerContacts, true);
  assert.ok(boot.employees.some((e) => e.id !== STAND_IN_ID && e.email), 'the draft’s contacts switch applies');
  assert.equal(boot.settings.supervisorsCanApprove, false);
  assert.equal((await boss.rpc('myTips.week', { weekStart: WEEK })).body.error, ROLE_OFF);
  const stored = A.db.store.get('settings', 'settings');
  assert.equal(stored.roleFeatures, undefined, 'never saved');
  assert.notEqual(stored.supervisorsCanApprove, false);
  ok(await boss.post('/api/view-as/stop'));
  assert.equal(ok(await boss.rpc('app.bootstrap')).features.tips, true);
});

test('audit: each start and stop, with who viewed whom and when (switching too)', async () => {
  const boss = await browser().login(owner.email);
  const n = auditLog().length;
  ok(await boss.post('/api/view-as/start', { userId: people.employee.id }));
  ok(await boss.post('/api/view-as/start', { userId: people.supervisor.id })); // switch straight to someone else
  ok(await boss.post('/api/view-as/stop'));
  const log = auditLog().slice(n);
  assert.deepEqual(log.map((x) => [x.action, x.targetId, x.details.reason || null]), [
    ['viewAs.start', people.employee.id, null], ['viewAs.stop', people.employee.id, 'switched'],
    ['viewAs.start', people.supervisor.id, null], ['viewAs.stop', people.supervisor.id, 'exit'],
  ]);
  for (const x of log) {
    assert.equal(x.actorId, owner.id);
    assert.equal(x.details.by, 'Owner');
    assert.ok(Date.parse(x.at));
  }
  assert.equal(log[0].details.name, people.employee.name);
  assert.equal(log[0].details.role, 'employee');
  assert.ok(Math.abs(Date.parse(log[0].details.until) - Date.parse(log[0].at) - VIEW_MINUTES * 60_000) < 1000, 'ends 45 minutes after it started');
  assert.equal(log[1].details.jti, log[0].details.jti, 'the stop names the view it ends');
  // A role view is logged with the role and positions.
  ok(await boss.post('/api/view-as/start', { role: 'supervisor', positions: [], rooms: ['Restaurant'] }));
  assert.deepEqual([auditLog().at(-1).details.role, auditLog().at(-1).details.rooms], ['supervisor', ['Restaurant']]);
  ok(await boss.post('/api/view-as/stop'));
});

test('it expires after 45 minutes: back to the real person, logged once', async () => {
  const boss = await browser().login(owner.email);
  ok(await boss.post('/api/view-as/start', { userId: people.employee.id }));
  clock.offset = (VIEW_MINUTES - 1) * 60_000;
  assert.equal(ok(await boss.rpc('app.bootstrap')).me.id, people.employee.id, 'still on at 44 minutes');
  clock.offset = (VIEW_MINUTES + 1) * 60_000;
  try {
    const [a, b] = await Promise.all([boss.rpc('app.bootstrap'), boss.rpc('shifts.list', { start: WEEK, end: END })]);
    assert.equal(a.body.result.me.id, owner.id);
    assert.equal(a.body.result.viewAs, undefined);
    assert.equal(b.status, 200);
    assert.equal(boss.jar.has('sb_view'), false, 'the view cookie is cleared');
    const stops = auditLog().filter((x) => x.action === 'viewAs.stop' && x.details.reason === 'expired');
    assert.equal(stops.length, 1, 'logged once');
    assert.equal(stops[0].targetId, people.employee.id);
    assert.equal((await boss.rpc('notifications.readAll')).status, 200, 'writes work again');
  } finally { clock.offset = 0; }
});

test('never from the phone app, and never in a DubLow support session', async () => {
  const token = await tokenFor(A.base, owner.email);
  const phone = { Authorization: `Bearer ${token}` };
  const start = await fetch(`${A.base}/api/view-as/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...phone }, body: JSON.stringify({ userId: people.employee.id }) });
  assert.equal(start.status, 403);
  assert.equal((await start.json()).error, VIEW_NOT_PHONE);
  assert.equal((await fetch(`${A.base}/api/view-as/options`, { headers: phone })).status, 403);
  const boss = await browser().login(owner.email);
  assert.equal((await boss.post('/api/view-as/start', { userId: people.employee.id, client: 'mobile' })).body.error, VIEW_NOT_PHONE);

  // A view cookie sent along with the phone app's token is ignored: the phone app is always the real person.
  ok(await boss.post('/api/view-as/start', { userId: people.employee.id }));
  const view = `sb_view=${boss.jar.get('sb_view')}`;
  const r = await fetch(`${A.base}/api/rpc/app.bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: view, ...phone }, body: '{}' });
  const boot = (await r.json()).result;
  assert.equal(boot.me.id, owner.id);
  assert.equal(boot.viewAs, undefined);
  ok(await boss.post('/api/view-as/stop'));

  // Support session ("Sign in as owner"): View as refused, and an earlier view isn't honored inside it.
  const sup = jwt.sign({ sub: owner.id, v: owner.sessionVersion || 0, sup: { by: 'ops@dublow.test', until: Date.now() + 600_000 } }, SECRET, { expiresIn: '10m' });
  const asSupport = (path, body) => fetch(`${A.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `sb_session=${sup}; ${view}` }, body: JSON.stringify(body) });
  const refused = await asSupport('/api/view-as/start', { userId: people.employee.id });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, VIEW_NOT_SUPPORT);
  assert.equal((await (await asSupport('/api/rpc/app.bootstrap', {})).json()).result.viewAs, undefined);
});

/** Every document, by collection (empty collections, which reads create in the cache, don't count). */
const snapshot = (store) => JSON.stringify([...store.cols].filter(([, m]) => m.size).sort(([a], [b]) => a.localeCompare(b)).map(([k, m]) => [k, [...m.values()]]));

test('the demo (core in the browser) follows the same rules: same reads, writes refused, nothing changes', () => {
  const store = new MemoryStore();
  const now = new Date(2026, 8, 27, 12);
  seedDemo(store, { now });
  const real = store.insert('users', { id: 'usr_demo_owner', name: 'Owner', role: 'super_admin', active: true, jobCodes: [], availability: {} });
  const emp = store.list('users', (u) => u.role === 'employee').sort((a, b) => a.order - b.order)[0];
  const target = resolveTarget(store, real, { userId: emp.id }, { today: WEEK });
  const view = { real, target, actor: viewedPerson(store, real, target), until: Date.now() + 60_000 };
  const before = snapshot(store);
  for (const [m, args] of [['app.bootstrap', {}], ['shifts.list', { start: WEEK, end: END }], ['swaps.list', {}], ['myTips.week', { weekStart: WEEK }]]) {
    const direct = createService(new OverlayStore(store), { now: () => now }).call(store.get('users', emp.id), m, args); // on a copy: only the view touches `store`
    assert.deepEqual(comparable(m, viewCall(store, view, m, args, { now: () => now })), comparable(m, direct), m);
  }
  assert.throws(() => viewCall(store, view, 'swaps.create', {}, { now: () => now }), (e) => e.status === 403 && e.message === VIEW_READ_ONLY);
  assert.equal(snapshot(store), before, 'the demo’s data is untouched');
  assert.throws(() => resolveTarget(store, store.get('users', emp.id), { userId: real.id }), (e) => e.status === 403 && e.message === VIEW_SUPER_ONLY);
  // The read list: reads only.
  for (const m of ['app.bootstrap', 'shifts.list', 'events.get', 'tips.week', 'forecast.covers', 'roleFeatures.get']) assert.equal(isViewRead(m), true, m);
  for (const m of ['shifts.save', 'swaps.create', 'notifications.readAll', 'quiz.start', 'manual.ack', 'tripleseat.webhookLink', 'roleFeatures.save', 'devices.register']) assert.equal(isViewRead(m), false, m);
});
