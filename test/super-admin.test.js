// An Admin making themselves Super Admin (core/super-admin.js, server/app.js, server/auth.js stepUp):
//   - an active Admin, while "Admins can make themselves Super Admin" is on, with a second step entered with the
//     request (a current authenticator code or a passkey); they stay signed in
//   - refused without that second step, with a wrong or used code, when the switch is off, for anyone but an Admin,
//     in View as, in a DubLow support session, from the phone app, and through the Claude connector or Ask ShiftBoard
//   - an audit entry, and every other Admin and Super Admin told in the app and (with email consent) by email
//   - the switch: only a Super Admin turns it off or on; an Admin can't, nor can a support session; DubLow's
//     console lists it and can turn it back on (audited)
//   - nothing changes for restaurants that never touch it (the setting isn't stored until someone changes it)
//   - errors in Spanish
// The people here are made up for the test, by role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { translateError } from '../core/errors.js';
import { VIEW_READ_ONLY } from '../core/view-as.js';
import {
  SA_OFF, SA_ADMINS_ONLY, SA_ALREADY, SA_STEP, SA_NOT_HERE, SA_WEB_ONLY, SA_SUPER_ONLY, HUMAN_ONLY, AUDIT_PROMOTE, AUDIT_SETTING, selfPromotionOn,
} from '../core/super-admin.js';
import { TOOLS, createToolContext, READ, WRITE } from '../server/tools/index.js';
import { openConnection } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn, nextCode, tokenFor, authenticatorOf } from './helpers/signin.js';
import { hotp } from '../server/totp.js';
import { softPasskey } from './helpers/webauthn.js';
import { hostClient } from './helpers/hosts.js';
import { fakeResend } from './helpers/fake-resend.js';

const SECRET = 'super-admin-test-secret';
const SUPPORT = 'Not available while DubLow Digital is signed in for support';
const clock = { offset: 0 };
const now = () => Date.now() + clock.offset;
/** The next 30-second authenticator step (each code works once, and only around its own time). */
const nextStep = () => { clock.offset += 31_000; };
let A;

// Made-up people, one per part they play (the demo data has one Admin and no Super Admin).
const P = {
  owner: { id: 'usr_sa_owner', name: 'Test Owner', role: 'super_admin', email: 'owner@superadmin.local', emailConsent: true },
  a1: { id: 'usr_sa_admin1', name: 'Admin One', role: 'admin', email: 'admin1@superadmin.local', emailConsent: true },
  a2: { id: 'usr_sa_admin2', name: 'Admin Two', role: 'admin', email: 'admin2@superadmin.local', emailConsent: true, language: 'es' },
  a3: { id: 'usr_sa_admin3', name: 'Admin Three', role: 'admin', email: 'admin3@superadmin.local', emailConsent: false },
  a4: { id: 'usr_sa_admin4', name: 'Admin Four', role: 'admin', email: 'admin4@superadmin.local', emailConsent: true },
  a5: { id: 'usr_sa_admin5', name: 'Admin Five', role: 'admin', email: 'admin5@superadmin.local', emailConsent: true },
  gone: { id: 'usr_sa_gone', name: 'Former Admin', role: 'admin', email: 'gone@superadmin.local', emailConsent: true, active: false },
  mgr: { id: 'usr_sa_mgr', name: 'Manager One', role: 'manager', email: 'mgr@superadmin.local', emailConsent: true },
  emp: { id: 'usr_sa_emp', name: 'Employee One', role: 'employee', email: 'emp@superadmin.local', emailConsent: true },
};

before(async () => {
  A = await startApp({ env: { JWT_SECRET: SECRET }, now });
  const hash = bcrypt.hashSync('demo1234', 4);
  await A.db.run((s) => {
    for (const p of Object.values(P)) {
      s.insert('users', { jobCodes: [], active: true, availability: {}, passwordHash: hash, smsConsent: false, createdAt: new Date().toISOString(), ...p });
    }
  }, { write: true });
});
after(async () => { await A?.close(); });

/** A signed-in browser for someone (password + their authenticator app, kept by the helper). */
async function browser(p, { lang } = {}) {
  const c = jsonClient(A.base);
  const r = await signIn(c.post, p.email, 'demo1234', { now });
  assert.equal(r.status, 200, `sign in ${p.email}: ${JSON.stringify(r.body)}`);
  const headers = lang ? { 'X-ShiftBoard-Language': lang } : {};
  return { ...c, rpc: (m, args = {}, h = {}) => c.post(`/api/rpc/${m}`, args, { ...headers, ...h }) };
}
const code = (p) => { nextStep(); return nextCode(p.email, { now }); };
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.result; };
const refused = (r, status, error) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (error) assert.equal(r.body.error, error); };
const user = async (id) => { await A.db.sync(); return A.db.store.get('users', id); };
async function setSwitch(on) { await A.db.run((s) => s.update('settings', 'settings', { adminsCanBecomeSuperAdmin: on }), { write: true }); }

test('an Admin makes themselves Super Admin with a fresh authenticator code, and stays signed in', async () => {
  const a1 = await browser(P.a1);
  const v = (await user(P.a1.id)).sessionVersion || 0;
  // Nothing stored until someone changes it: the setting isn't in the answers, and it counts as on.
  const boot = ok(await a1.rpc('app.bootstrap'));
  assert.equal('adminsCanBecomeSuperAdmin' in boot.settings, false);
  assert.equal(selfPromotionOn(boot.settings), true);

  const r = ok(await a1.rpc('account.becomeSuperAdmin', { code: code(P.a1) }));
  assert.equal(r.ok, true);
  assert.equal(r.me.role, 'super_admin');
  const u = await user(P.a1.id);
  assert.equal(u.role, 'super_admin');
  assert.equal(u.sessionVersion || 0, v, 'no sign-out');
  // Same session, now a Super Admin.
  assert.equal(ok(await a1.rpc('app.bootstrap')).me.role, 'super_admin');
  refused(await a1.rpc('account.becomeSuperAdmin', { code: code(P.a1) }), 403, SA_ALREADY);
});

test('the audit log has it, and every other Admin and Super Admin is told in the app and (with consent) by a security email', async () => {
  await A.settled();
  await A.db.sync();
  const store = A.db.store;
  const entry = store.list('auditLog', (x) => x.action === AUDIT_PROMOTE && x.actorId === P.a1.id)[0];
  assert.ok(entry);
  assert.equal(entry.targetId, P.a1.id);
  assert.equal(entry.details.summary, 'Admin One made themselves Super Admin');
  assert.equal(entry.details.step, 'totp');
  assert.deepEqual([entry.details.from, entry.details.to], ['admin', 'super_admin']);

  // In the app: every other active Admin and Super Admin (the demo's own Admin too), in their language; not the
  // person themselves, managers, staff or inactive people.
  const notes = store.list('notifications', (n) => n.security && n.kind === 'madeSuperAdmin');
  const told = new Set(notes.map((n) => n.userId));
  const admins = store.list('users', (u) => u.id !== P.a1.id && u.active !== false && ['admin', 'super_admin'].includes(u.role)).map((u) => u.id);
  assert.deepEqual([...told].sort(), admins.sort());
  for (const id of [P.a1.id, P.mgr.id, P.emp.id, P.gone.id]) assert.equal(told.has(id), false, id);
  assert.equal(notes.find((n) => n.userId === P.owner.id).text, 'Admin One made themselves Super Admin.');
  assert.equal(notes.find((n) => n.userId === P.a2.id).text, 'Admin One se dio el rol de superadministrador.');

  // By email: the security notice, only to those who agreed to emails, in their language; no second, generic copy.
  const mails = A.resend.emails();
  const notice = mails.filter((m) => /Super Admin|superadministrador/.test(m.subject));
  const to = notice.flatMap((m) => [].concat(m.to));
  assert.ok(to.includes(P.owner.email));
  assert.ok(to.includes(P.a4.email));
  assert.ok(!to.includes(P.a3.email), 'no email consent: in the app only');
  assert.ok(!to.includes(P.a1.email) && !to.includes(P.mgr.email) && !to.includes(P.gone.email));
  assert.equal(new Set(to).size, to.length, 'one email each');
  const es = notice.find((m) => [].concat(m.to).includes(P.a2.email));
  assert.match(es.subject, /^Admin One se dio el rol de superadministrador/);
  assert.match(notice.find((m) => [].concat(m.to).includes(P.owner.email)).subject, /^Admin One made themselves Super Admin/);
  assert.match(es.html, /#\/team/);
});

test('refused without a fresh second step: none, a wrong code, a code already used, a recovery code', async () => {
  const a4 = await browser(P.a4);
  refused(await a4.rpc('account.becomeSuperAdmin', {}), 403, SA_STEP);
  refused(await a4.rpc('account.becomeSuperAdmin', { code: '000000' }), 403, 'That code didn’t work. Check your authenticator app and try again.');
  // The code they signed in with doesn't work again.
  const app = authenticatorOf(P.a4.email);
  refused(await a4.rpc('account.becomeSuperAdmin', { code: hotp(app.secret, app.lastStep) }), 403, 'That code didn’t work. Check your authenticator app and try again.');
  const used = code(P.a4);
  ok(await a4.rpc('account.becomeSuperAdmin', { code: used }));
  // Done once; put them back as an Admin (another Super Admin can) and replay the same code.
  const owner = await browser(P.owner);
  const me = (await owner.rpc('app.bootstrap')).body.result.employees.find((e) => e.id === P.a4.id);
  ok(await owner.rpc('employees.save', { ...me, role: 'admin' }));
  refused(await a4.rpc('account.becomeSuperAdmin', { code: used }), 403, 'That code didn’t work. Check your authenticator app and try again.');
  assert.equal((await user(P.a4.id)).role, 'admin');
});

test('a passkey works as the second step: a challenge for them only, used once', async () => {
  const a5 = await browser(P.a5);
  const key = softPasskey();
  const { options: reg } = (await a5.post('/api/auth/passkey/register/options', {})).body;
  assert.equal((await a5.post('/api/auth/passkey/register/verify', { response: key.register(reg, A.base) })).status, 200);
  // No passkey, no passkey challenge.
  const a3 = await browser(P.a3);
  refused(await a3.post('/api/auth/step-up/passkey/options', {}), 400);
  const { options } = (await a5.post('/api/auth/step-up/passkey/options', {})).body;
  assert.deepEqual(options.allowCredentials.map((c) => c.id), [key.id]);
  refused(await a5.rpc('account.becomeSuperAdmin', { passkey: key.sign(options, A.base, { verified: false }) }), 403, 'That passkey didn’t work. Try again, or use your authenticator app.');
  const { options: o2 } = (await a5.post('/api/auth/step-up/passkey/options', {})).body;
  const answer = key.sign(o2, A.base);
  const r = ok(await a5.rpc('account.becomeSuperAdmin', { passkey: answer }));
  assert.equal(r.me.role, 'super_admin');
  await A.db.sync();
  assert.equal(A.db.store.list('auditLog', (x) => x.action === AUDIT_PROMOTE && x.actorId === P.a5.id)[0].details.step, 'passkey');
  // Back to Admin; the same answer (its challenge used) doesn't work again.
  const owner = await browser(P.owner);
  const me = (await owner.rpc('app.bootstrap')).body.result.employees.find((e) => e.id === P.a5.id);
  ok(await owner.rpc('employees.save', { ...me, role: 'admin' }));
  refused(await a5.rpc('account.becomeSuperAdmin', { passkey: answer }), 403);
  assert.equal((await user(P.a5.id)).role, 'admin');
});

test('a non-admin is refused, before any code is used', async () => {
  for (const p of [P.mgr, P.emp]) {
    const b = await browser(p);
    const c = code(p);
    refused(await b.rpc('account.becomeSuperAdmin', { code: c }), 403, SA_ADMINS_ONLY);
    assert.equal((await user(p.id)).role, p.role);
    // The code wasn't spent on the refusal: it still works to sign in.
    const fresh = jsonClient(A.base);
    const first = await fresh.post('/api/auth/login', { email: p.email, password: 'demo1234' });
    assert.equal((await fresh.post('/api/auth/mfa/verify', { ticket: first.body.ticket, method: 'totp', code: c })).status, 200);
  }
  await A.db.sync();
  assert.equal(A.db.store.list('auditLog', (x) => x.action === AUDIT_PROMOTE && [P.mgr.id, P.emp.id].includes(x.actorId)).length, 0);
});

test('the switch: only a Super Admin turns it off; then Admins are refused and can’t turn it back on', async () => {
  const owner = await browser(P.owner);
  const a2 = await browser(P.a2);
  const a3 = await browser(P.a3);
  // An Admin can't change it either way.
  refused(await a3.rpc('settings.adminsCanBecomeSuperAdmin', { on: false }), 403, SA_SUPER_ONLY);
  refused(await a3.rpc('settings.adminsCanBecomeSuperAdmin', { on: true }), 403, SA_SUPER_ONLY);
  refused(await (await browser(P.mgr)).rpc('settings.adminsCanBecomeSuperAdmin', { on: false }), 403, 'Admins only');
  refused(await owner.rpc('settings.adminsCanBecomeSuperAdmin', { on: 'no' }), 400);

  // A Super Admin turns it off: stored, audited, and Admins are refused (no code used).
  assert.deepEqual(ok(await owner.rpc('settings.adminsCanBecomeSuperAdmin', { on: false })), { adminsCanBecomeSuperAdmin: false });
  assert.equal(ok(await a3.rpc('app.bootstrap')).settings.adminsCanBecomeSuperAdmin, false);
  await A.db.sync();
  const log = A.db.store.list('auditLog', (x) => x.action === AUDIT_SETTING);
  assert.deepEqual(log.at(-1).details, { from: true, to: false });
  assert.equal(log.at(-1).actorId, P.owner.id);
  refused(await a3.rpc('account.becomeSuperAdmin', { code: code(P.a3) }), 403, SA_OFF);

  // An Admin can't turn it back on, not even through Settings' general save.
  refused(await a3.rpc('settings.adminsCanBecomeSuperAdmin', { on: true }), 403, SA_SUPER_ONLY);
  ok(await a3.rpc('settings.update', { adminsCanBecomeSuperAdmin: true }));
  assert.equal(ok(await a3.rpc('app.bootstrap')).settings.adminsCanBecomeSuperAdmin, false);

  // Errors in Spanish (the person's language, or the app's).
  const es = await a2.rpc('account.becomeSuperAdmin', { code: code(P.a2) });
  refused(es, 403, 'En este restaurante los administradores no pueden hacerse superadministradores. Pídeselo a un superadministrador.');
  refused(await a3.rpc('settings.adminsCanBecomeSuperAdmin', { on: true }, { 'X-ShiftBoard-Language': 'es' }), 403, 'Solo un superadministrador puede cambiar esto');

  // Turning it off changed nobody's role; a Super Admin turns it back on.
  assert.equal((await user(P.a1.id)).role, 'super_admin');
  assert.deepEqual(ok(await owner.rpc('settings.adminsCanBecomeSuperAdmin', { on: true })), { adminsCanBecomeSuperAdmin: true });
  assert.equal(ok(await a3.rpc('app.bootstrap')).settings.adminsCanBecomeSuperAdmin, true);
});

test('Spanish error messages', async () => {
  const a2 = await browser(P.a2); // their language is Spanish
  refused(await a2.rpc('account.becomeSuperAdmin', {}), 403, 'Primero confirma que eres tú con tu app de autenticación o una llave de acceso');
  refused(await a2.rpc('account.becomeSuperAdmin', { code: '000000' }), 403, 'Ese código no funcionó. Revisa tu app de autenticación e inténtalo de nuevo.');
  const mgr = await browser(P.mgr);
  refused(await mgr.rpc('account.becomeSuperAdmin', {}, { 'X-ShiftBoard-Language': 'es' }), 403, 'Solo un administrador puede hacerse superadministrador');
  for (const m of [SA_OFF, SA_ADMINS_ONLY, SA_ALREADY, SA_STEP, SA_NOT_HERE, SA_WEB_ONLY, SA_SUPER_ONLY,
    'That passkey didn’t work. Try again, or use your authenticator app.', 'You don’t have a passkey yet. Use your authenticator app.']) {
    assert.notEqual(translateError(m, 'es'), m, m);
  }
});

test('refused in View as: a Super Admin viewing as an Admin changes nothing', async () => {
  const owner = await browser(P.owner);
  ok(await owner.post('/api/view-as/start', { userId: P.a3.id }));
  assert.equal(ok(await owner.rpc('app.bootstrap')).me.id, P.a3.id);
  refused(await owner.rpc('account.becomeSuperAdmin', { code: code(P.owner) }), 403, VIEW_READ_ONLY);
  refused(await owner.rpc('settings.adminsCanBecomeSuperAdmin', { on: false }), 403, VIEW_READ_ONLY);
  refused(await owner.post('/api/auth/step-up/passkey/options', {}), 403);
  ok(await owner.post('/api/view-as/stop', {}));
  assert.equal((await user(P.a3.id)).role, 'admin');
  assert.equal(ok(await owner.rpc('app.bootstrap')).settings.adminsCanBecomeSuperAdmin, true);
});

test('refused in a DubLow support session, for the action and for the switch', async () => {
  const support = (p) => {
    const until = now() + 15 * 60_000;
    const token = jwt.sign({ sub: p.id, v: 0, sup: { by: 'ops@dublow.test', until } }, SECRET, { expiresIn: '15m' });
    const c = jsonClient(A.base);
    const cookie = { Cookie: `sb_session=${token}` };
    return { rpc: (m, a = {}) => c.post(`/api/rpc/${m}`, a, cookie), post: (path, a = {}) => c.post(path, a, cookie) };
  };
  const asAdmin = support(P.a3);
  assert.equal((await asAdmin.rpc('app.bootstrap')).status, 200, 'the support session works');
  refused(await asAdmin.rpc('account.becomeSuperAdmin', { code: code(P.a3) }), 403, SUPPORT);
  refused(await asAdmin.post('/api/auth/step-up/passkey/options', {}), 403, SUPPORT);
  // As the owner (a Super Admin): the switch stays as it is, either way.
  const asOwner = support(P.owner);
  refused(await asOwner.rpc('settings.adminsCanBecomeSuperAdmin', { on: false }), 403, SUPPORT);
  await setSwitch(false);
  refused(await asOwner.rpc('settings.adminsCanBecomeSuperAdmin', { on: true }), 403, SUPPORT);
  await setSwitch(true);
  assert.equal((await user(P.a3.id)).role, 'admin');
});

test('refused from the phone app (it’s web-only)', async () => {
  const token = await tokenFor(A.base, P.a3.email, 'demo1234');
  const c = jsonClient(A.base);
  refused(await c.post('/api/rpc/account.becomeSuperAdmin', { code: code(P.a3) }, { Authorization: `Bearer ${token}` }), 403, SA_WEB_ONLY);
  assert.equal((await user(P.a3.id)).role, 'admin');
});

test('refused through the Claude connector and Ask ShiftBoard, and no tool can do it', async () => {
  const u = await user(P.a3.id);
  for (const via of ['claude', 'assistant']) {
    const ctx = createToolContext({ db: A.db, userId: u.id, v: u.sessionVersion || 0, scopes: [READ, WRITE], via, now });
    for (const method of HUMAN_ONLY) {
      await assert.rejects(ctx.write(method, { on: false, code: '123456' }), (e) => e.status === 403 && e.message === SA_NOT_HERE, `${via} ${method}`);
      await assert.rejects(ctx.write((call) => call(method, { on: false })), (e) => e.status === 403 && e.message === SA_NOT_HERE, `${via} ${method} in a batch`);
      await assert.rejects(ctx.read(method), (e) => e.status === 403, `${via} ${method} as a read`);
    }
  }
  // Even with a second step handed to the service, a tool's service refuses (belt and braces).
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const admin = store.list('users', (x) => x.role === 'admin')[0];
  assert.throws(() => createService(store, { via: 'claude', freshStep: { method: 'totp' } }).call(admin, 'account.becomeSuperAdmin'), (e) => e.message === SA_NOT_HERE);
  assert.ok(ids);
  // No tool's handler calls these methods.
  for (const tool of TOOLS) assert.doesNotMatch(tool.handler.toString(), /becomeSuperAdmin|adminsCanBecomeSuperAdmin/, tool.name);
  assert.equal((await user(P.a3.id)).role, 'admin');
});

test('in the core (and the demo): never without the server’s second step; the last Super Admin stays', () => {
  const store = new MemoryStore();
  seedDemo(store);
  const admin = store.list('users', (x) => x.role === 'admin')[0];
  store.insert('users', { id: 'usr_core_owner', name: 'Owner', role: 'super_admin', email: 'o@core.local', active: true, jobCodes: [], availability: {} });
  const owner = store.get('users', 'usr_core_owner');
  assert.throws(() => createService(store).call(admin, 'account.becomeSuperAdmin', { code: '123456' }), (e) => e.status === 403 && e.message === SA_STEP);
  assert.equal(store.get('users', admin.id).role, 'admin');
  // The only Super Admin can't make themselves anything else, and nobody can remove the last one.
  const svc = createService(store);
  const ownerView = svc.call(owner, 'app.bootstrap').employees.find((e) => e.id === owner.id);
  assert.throws(() => svc.call(owner, 'employees.save', { ...ownerView, role: 'admin' }), /change your own role/);
  assert.throws(() => svc.call(admin, 'employees.save', { ...ownerView, role: 'admin' }), (e) => e.status === 403);
  // Turning the switch off demotes nobody.
  const promoted = createService(store, { freshStep: { method: 'totp' } }).call(admin, 'account.becomeSuperAdmin');
  assert.equal(promoted.me.role, 'super_admin');
  svc.call(owner, 'settings.adminsCanBecomeSuperAdmin', { on: false });
  assert.equal(store.get('users', admin.id).role, 'super_admin');
});

// ---------- DubLow's platform console ----------
const PG_URL = process.env.TEST_DATABASE_URL;
/** PGlite, or a throwaway database of its own next to TEST_DATABASE_URL (never the one other tests use). */
async function freshConn() {
  if (!PG_URL) return openPglite();
  const u = new URL(PG_URL);
  const name = `${u.pathname.slice(1) || 'postgres'}_superadmin`;
  const admin = openConnection({ DATABASE_URL: PG_URL });
  try { await admin.query(`CREATE DATABASE "${name}"`); } catch (e) { if (e.code !== '42P04') throw e; } finally { await admin.end(); }
  u.pathname = `/${name}`;
  const conn = openConnection({ DATABASE_URL: u.toString() });
  const { rows } = await conn.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('shiftboard', 'platform') OR nspname LIKE 't\\_%'`);
  for (const r of rows) await conn.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  return conn;
}

test('the DubLow console lists the switch per restaurant and can turn it back on, audited', async () => {
  const conn = await freshConn();
  const resend = fakeResend();
  const app = createPlatformApp({
    conn, env: {
      PLATFORM_DOMAIN: 'lvh.test', PLATFORM_ADMIN_EMAIL: 'ops@dublow.test', PLATFORM_ADMIN_PASSWORD: 'console-password-1',
      PLATFORM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), JWT_SECRET: 'sa-platform-jwt', SEED_DEMO: 'true', EXPO_PUSH: 'off',
      RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>',
    },
    mailerFor: (e) => createMailer(e, { fetchImpl: resend.fetchImpl }),
  });
  await app.locals.warmDefault();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const admin = hostClient(server.address().port, 'admin.lvh.test');
    const login = await admin.post('/api/platform/login', { email: 'ops@dublow.test', password: 'console-password-1' });
    assert.equal(login.status, 200, login.text);
    if (login.body.result?.mustChange) assert.equal((await admin.post('/api/platform/password', { password: 'console-password-1' })).status, 200);
    const made = await admin.post('/api/platform/tenants', { plan: 'starter', name: 'Switch Spot', slug: 'switch-spot', ownerName: 'Test Owner', ownerEmail: 'owner@switch.local' });
    assert.equal(made.status, 200, made.text);
    const id = made.body.result.tenant.id;
    const listed = async () => (await admin.get('/api/platform/tenants')).body.result.find((t) => t.id === id);
    assert.equal((await listed()).adminsCanBecomeSuperAdmin, true, 'on by default');

    // The restaurant's Super Admin turned it off (as if in the app); the console shows it, and DubLow turns it back on.
    const rt = await app.locals.platform.runtime((await app.locals.platform.registry.get(id)));
    await rt.app.locals.ready();
    await rt.db.run((s) => createService(s).call(s.list('users', (u) => u.role === 'super_admin')[0], 'settings.adminsCanBecomeSuperAdmin', { on: false }), { write: true });
    assert.equal((await listed()).adminsCanBecomeSuperAdmin, false);
    assert.equal((await admin.patch(`/api/platform/tenants/${id}`, { adminsCanBecomeSuperAdmin: 'yes' })).status, 400);
    const r = await admin.patch(`/api/platform/tenants/${id}`, { adminsCanBecomeSuperAdmin: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.result.adminsCanBecomeSuperAdmin, true);
    assert.equal((await listed()).adminsCanBecomeSuperAdmin, true);
    await rt.db.sync();
    assert.equal(createService(rt.db.store).settings().adminsCanBecomeSuperAdmin, true);
    // Audited: in the restaurant's log (by DubLow, from the console) and the platform's.
    const mine = rt.db.store.list('auditLog', (x) => x.action === AUDIT_SETTING).at(-1);
    assert.deepEqual(mine.details, { from: false, to: true, via: 'console', by: 'ops@dublow.test' });
    const log = (await admin.get(`/api/platform/audit?tenant=${id}`)).body.result;
    const entry = log.find((a) => a.action === 'tenant.settings');
    assert.deepEqual(entry.details, { adminsCanBecomeSuperAdmin: { from: false, to: true } });
    // Together with other changes, and off again.
    const both = await admin.patch(`/api/platform/tenants/${id}`, { adminsCanBecomeSuperAdmin: false, notes: 'Owner asked to lock it.' });
    assert.equal(both.status, 200, both.text);
    assert.equal(both.body.result.adminsCanBecomeSuperAdmin, false);
    assert.equal(both.body.result.notes, 'Owner asked to lock it.');
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }
});

test('nothing stored means nothing changes: a fresh restaurant answers settings without the new key', () => {
  const store = new MemoryStore();
  seedDemo(store);
  const svc = createService(store);
  const admin = store.list('users', (x) => x.role === 'admin')[0];
  assert.equal('adminsCanBecomeSuperAdmin' in svc.call(admin, 'app.bootstrap').settings, false);
  assert.equal('adminsCanBecomeSuperAdmin' in svc.call(admin, 'settings.update', { restaurantName: 'Same Place' }), false);
  assert.equal(selfPromotionOn(svc.settings()), true);
});

