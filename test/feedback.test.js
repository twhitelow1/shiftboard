// Feedback box (core/feedback.js): anonymous by default, and anonymous in the data.
//   - an anonymous entry leaves no link to the person anywhere: not on the entry, the audit log, notifications,
//     the rate limit (after the day ends), error tracking or the database's own bookkeeping
//   - the date only, never the time; the rate limit works without knowing who
//   - follow-up by code (a wrong code is refused), signed vs anonymous, who reads (supervisors by the setting,
//     Concern / report admins-only), internal notes, notifications (never texted, no message in push or email)
//   - View as is read-only, plan and role gating, Spanish
// People are picked by role from the demo data; no names are typed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { viewCall, VIEW_READ_ONLY } from '../core/view-as.js';
import { ROLE_OFF, featuresForMethod as roleFeaturesFor } from '../core/role-features.js';
import { translateError } from '../core/errors.js';
import { normalizeCode, codeHash, SUBMITS_PER_DAY, DEFAULT_KINDS } from '../core/feedback.js';
import { seedFeedbackDemo, DEMO_CODE } from '../core/feedback-seed.js';
import { sha256Hex, hmacHex } from '../core/sha256.js';
import { featuresForMethod, resolveFeatures, PLANS, NOT_IN_PLAN } from '../server/platform/plans.js';
import { DocDb, openConnection } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { createMailer } from '../server/email.js';
import { createTexter } from '../server/sms.js';
import { createExpoPush, EXPO_PUSH_URL } from '../server/expo-push.js';
import { capture } from '../server/errors-routes.js';
import { fakeResend } from './helpers/fake-resend.js';
import { fakeTwilio, TWILIO_ENV } from './helpers/app.js';
import { cookieFor } from './helpers/signin.js';
import en from '../web/src/i18n/en.js';
import es from '../web/src/i18n/es.js';
import enFeedback from '../web/src/i18n/en-feedback.js';
import esFeedback from '../web/src/i18n/es-feedback.js';

const MESSAGE = 'The walk-in door sticks after close; somebody could get shut in. Zebra-quartz-41.';

/** The demo data with a Super Admin, at 3:42 pm on the demo Sunday. The clock moves with tick(days). */
function setup() {
  let clock = new Date(2026, 8, 27, 15, 42, 17);
  const store = new MemoryStore();
  seedDemo(store, { now: clock });
  store.insert('users', { id: 'usr_test_owner', name: 'Owner Person', role: 'super_admin', email: 'owner@test.local', active: true, jobCodes: [], availability: {} });
  const svc = createService(store, { now: () => clock, feedbackKey: 'test-feedback-key' });
  const people = () => store.list('users', (u) => u.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const of = (role, n = 0) => people().filter((u) => u.role === role)[n];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  return { store, svc, of, call, tick: (days) => { clock = new Date(clock.getTime() + days * 86_400_000); }, now: () => clock };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message), `expected ${status} ${message || ''}`);

/** Every document, as JSON, by collection/id. */
const snapshot = (store) => new Map([...store.cols].flatMap(([col, m]) => [...m].map(([id, d]) => [`${col}/${id}`, JSON.stringify(d)])));
/** Documents that are new or changed since `before`. */
const changedSince = (store, before) => [...snapshot(store)].filter(([k, v]) => before.get(k) !== v);
/** What would identify this person in a document. */
const needles = (u) => [u.id, u.email, u.name, u.phone].filter((x) => typeof x === 'string' && x.length >= 3);
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

test('an anonymous entry leaves no link to the person anywhere in the store, including after the rate limit expires', () => {
  const { store, of, call, tick } = setup();
  const emp = of('employee', 2);
  const before = snapshot(store);
  const r = call(emp, 'feedback.submit', { kind: 'suggestion', topic: 'kitchen', message: MESSAGE });
  assert.equal(r.signed, false);
  assert.match(r.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r.id, undefined, 'the answer has no entry id to keep');

  const changed = changedSince(store, before);
  const cols = new Set(changed.map(([k]) => k.split('/')[0]));
  assert.ok(cols.has('feedback') && cols.has('notifications') && cols.has('feedbackLimits'), [...cols].join());
  for (const [k, json] of changed) {
    for (const n of needles(emp)) assert.ok(!json.includes(n), `${k} mentions the writer (${n === emp.id ? 'id' : 'name/email/phone'})`);
    assert.ok(!json.includes(r.code) && !json.includes(normalizeCode(r.code)), `${k} keeps the code itself`);
  }
  // Nothing in the audit log, and notifications don't say who did it.
  assert.equal(changed.filter(([k]) => k.startsWith('auditLog/')).length, 0);
  for (const n of store.list('notifications', (x) => x.feedback)) {
    assert.equal(n.by, undefined, 'no `by` on the readers’ notifications');
    assert.equal(n.noText, true, 'never texted');
    assert.ok(!n.text.includes('Zebra-quartz'), 'the message is never in a notification');
  }
  // The entry itself: no user id, the code only hashed, the date only.
  const [entry] = store.list('feedback');
  assert.deepEqual(Object.keys(entry).sort(), ['codeHash', 'date', 'id', 'kind', 'message', 'notes', 'shared', 'signed', 'status', 'thread', 'topic']);
  assert.equal(entry.codeHash, codeHash(r.code));
  assert.equal(entry.date, '2026-09-27');
  assert.doesNotMatch(JSON.stringify(entry), ISO_TIME, 'no time of day');
  assert.match(entry.id, /^fbk_[0-9a-z]{14}$/);

  // The rate limit keeps an HMAC, never the id; the day after, the first feedback call wipes it.
  const lim = store.get('feedbackLimits', 'today');
  assert.equal(Object.keys(lim.counts).length, 1);
  assert.equal(Object.keys(lim.counts)[0], hmacHex('test-feedback-key', `${emp.id}|2026-09-27|submit`));
  tick(1);
  call(of('employee', 5), 'feedback.form.get');
  const after = store.get('feedbackLimits', 'today');
  assert.equal(after.day, '2026-09-28');
  assert.deepEqual(after.counts, {});
  // Across every collection, the writer is now only where they were before (their own account, shifts…).
  for (const [k, json] of changedSince(store, before)) for (const n of needles(emp)) assert.ok(!json.includes(n), `${k} after the day ends`);
});

test('who is told doesn’t depend on who wrote it (a reader writing one is told too)', () => {
  const { store, of, call } = setup();
  const recipients = (u) => {
    const before = new Set(store.list('notifications').map((n) => n.id));
    call(u, 'feedback.submit', { kind: 'feedback', message: 'Same words from two people.' });
    return store.list('notifications', (n) => !before.has(n.id)).map((n) => n.userId).sort();
  };
  const fromStaff = recipients(of('employee', 1));
  const fromManager = recipients(of('manager'));
  assert.ok(fromStaff.length >= 2);
  assert.deepEqual(fromManager, fromStaff);
  assert.ok(fromStaff.includes(of('manager').id));
  assert.ok(!fromStaff.includes(of('employee', 1).id) && !fromStaff.includes(of('supervisor').id), 'staff and supervisors don’t read by default');
});

test('the date only, also on the writer’s follow-ups; readers’ replies keep their time', () => {
  const { store, of, call } = setup();
  const { code } = call(of('employee'), 'feedback.submit', { kind: 'suggestion', message: 'More hooks for aprons.' });
  const [entry] = store.list('feedback');
  call(of('manager'), 'feedback.reply', { id: entry.id, text: 'We’ll put six more up.' });
  const view = call(of('employee'), 'feedback.byCode.reply', { code, text: 'Thank you!' });
  const thread = store.get('feedback', entry.id).thread;
  assert.equal(thread[0].from, 'reader');
  assert.match(thread[0].at, ISO_TIME);
  assert.deepEqual(Object.keys(thread[1]).sort(), ['date', 'from', 'id', 'text']);
  assert.equal(thread[1].date, '2026-09-27');
  assert.equal(view.thread.length, 2);
  assert.equal(view.replies, 1);
});

test('the rate limit works without knowing who: five a day each, separately, and again tomorrow', () => {
  const { store, of, call, tick } = setup();
  const a = of('employee', 1);
  const b = of('employee', 2);
  for (let i = 0; i < SUBMITS_PER_DAY; i++) call(a, 'feedback.submit', { kind: 'feedback', message: `Note ${i}` });
  refused(() => call(a, 'feedback.submit', { kind: 'feedback', message: 'One more' }), 429, 'That’s the most entries for one day. Try again tomorrow.');
  call(b, 'feedback.submit', { kind: 'feedback', message: 'Someone else still can' });
  const counts = store.get('feedbackLimits', 'today').counts;
  assert.deepEqual(Object.values(counts).sort(), [1, SUBMITS_PER_DAY]);
  for (const k of Object.keys(counts)) assert.match(k, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(store.get('feedbackLimits', 'today')).includes(a.id));
  tick(1);
  call(a, 'feedback.submit', { kind: 'feedback', message: 'A new day' });
  assert.equal(store.list('feedback').length, SUBMITS_PER_DAY + 2);
  assert.equal(translateError('That’s the most entries for one day. Try again tomorrow.', 'es'), 'Ya llegaste al máximo de mensajes por día. Inténtalo de nuevo mañana.');
});

test('follow-up by code: open it, read the reply, write back; a wrong code is refused', () => {
  const { of, call } = setup();
  const emp = of('employee', 3);
  const { code } = call(emp, 'feedback.submit', { kind: 'concern', topic: 'equipment', message: MESSAGE });
  const admin = of('admin');
  const id = call(admin, 'feedback.inbox.list').items[0].id;
  call(admin, 'feedback.reply', { id, text: 'Fixed the latch this morning. Thanks for telling us.' });
  call(admin, 'feedback.setStatus', { id, status: 'done' });
  // Typed loosely: lowercase, spaces instead of dashes.
  const mine = call(emp, 'feedback.byCode.get', { code: code.toLowerCase().replace(/-/g, ' ') });
  assert.equal(mine.message, MESSAGE);
  assert.equal(mine.status, 'done');
  assert.equal(mine.thread[0].text, 'Fixed the latch this morning. Thanks for telling us.');
  assert.equal(mine.id, undefined);
  // Anyone holding the code can follow up (that's the point), and only with it.
  call(of('employee', 4), 'feedback.byCode.reply', { code, text: 'Still sticks a little.' });
  assert.equal(call(admin, 'feedback.inbox.get', { id }).thread.at(-1).text, 'Still sticks a little.');
  refused(() => call(emp, 'feedback.byCode.get', { code: 'ABCD-EFGH-JKLM-NPQR' }), 404, 'No entry has that code');
  refused(() => call(emp, 'feedback.byCode.get', { code: 'nope' }), 404, 'No entry has that code');
  refused(() => call(emp, 'feedback.byCode.reply', { code: `${code.slice(0, -1)}2`.replace(/22$/, '23'), text: 'x' }), 404);
  // The device's badge check: replies counted per code, unknown codes just "not found".
  const sum = call(emp, 'feedback.codes.summary', { codes: [code, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ'] });
  assert.equal(sum[0].found, true);
  assert.equal(sum[0].replies, 1);
  assert.deepEqual(sum[1], { found: false });
});

test('signed vs anonymous: readers see a signer’s name, never an anonymous writer (not even a Super Admin)', () => {
  const { of, call, store } = setup();
  const emp = of('employee', 1);
  const owner = store.get('users', 'usr_test_owner');
  call(emp, 'feedback.submit', { kind: 'shoutout', topic: 'foh', message: 'Thanks to the hosts.', signed: true });
  call(emp, 'feedback.submit', { kind: 'shoutout', topic: 'foh', message: 'Thanks to the bar.' });
  for (const reader of [of('manager'), of('admin'), owner]) {
    const { items } = call(reader, 'feedback.inbox.list');
    const signed = items.find((x) => x.signed);
    const anon = items.find((x) => !x.signed);
    assert.deepEqual(signed.author, { id: emp.id, name: emp.name });
    assert.equal(anon.author, null);
    const full = JSON.stringify(call(reader, 'feedback.inbox.get', { id: anon.id }));
    for (const n of needles(emp)) assert.ok(!full.includes(n));
    assert.ok(!full.includes('codeHash'));
  }
  // My feedback lists my signed entries only; anonymous ones are reached by their code.
  const mine = call(emp, 'feedback.mine.list');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].message, 'Thanks to the hosts.');
  refused(() => call(of('employee', 2), 'feedback.mine.get', { id: mine[0].id }), 404);
  // Filters: signed / anonymous.
  assert.equal(call(of('manager'), 'feedback.inbox.list', { signed: 'anonymous' }).items.length, 1);
  assert.equal(call(of('manager'), 'feedback.inbox.list', { signed: 'signed' }).items[0].signed, true);
});

test('who reads: managers and up; supervisors only by the setting; Concern / report only Admins and Super Admins', () => {
  const { of, call, store } = setup();
  const owner = store.get('users', 'usr_test_owner');
  const sup = of('supervisor');
  call(of('employee'), 'feedback.submit', { kind: 'concern', message: 'A concern.' });
  call(of('employee'), 'feedback.submit', { kind: 'suggestion', message: 'A suggestion.' });
  const kinds = (u) => call(u, 'feedback.inbox.list').items.map((x) => x.kind).sort();
  refused(() => call(of('employee'), 'feedback.inbox.list'), 403, 'Only the people who read the Feedback box can do this');
  refused(() => call(sup, 'feedback.inbox.list'), 403);
  assert.deepEqual(kinds(of('manager')), ['suggestion'], 'Concern / report is admins-only by default');
  assert.deepEqual(kinds(of('admin')), ['concern', 'suggestion']);
  assert.deepEqual(kinds(owner), ['concern', 'suggestion']);
  const concern = call(of('admin'), 'feedback.inbox.list', { kind: 'concern' }).items[0];
  refused(() => call(of('manager'), 'feedback.inbox.get', { id: concern.id }), 404);
  refused(() => call(of('manager'), 'feedback.reply', { id: concern.id, text: 'x' }), 404);
  assert.equal(call(of('manager'), 'app.bootstrap').features.feedbackInbox, true);
  assert.equal(call(sup, 'app.bootstrap').features.feedbackInbox, false);
  assert.equal(call(of('employee'), 'app.bootstrap').features.feedbackInbox, false);
  assert.equal(call(of('employee'), 'app.bootstrap').features.feedback, true);

  // Only admins change the settings; then supervisors read, and Concern / report can go to managers too.
  refused(() => call(of('manager'), 'feedback.settings.save', { supervisorsCanRead: true }), 403, 'Admins only');
  const cfg = call(of('admin'), 'feedback.settings.get');
  call(of('admin'), 'feedback.settings.save', { supervisorsCanRead: true, kinds: cfg.kinds.map((k) => ({ ...k, adminsOnly: false })) });
  assert.deepEqual(kinds(sup), ['concern', 'suggestion']);
  assert.deepEqual(kinds(of('manager')), ['concern', 'suggestion']);
  assert.equal(call(sup, 'app.bootstrap').features.feedbackInbox, true);
  // Kinds: rename, add, turn off; one in use never disappears.
  const saved = call(of('admin'), 'feedback.settings.save', { kinds: [{ id: 'suggestion', en: 'Idea', es: 'Idea', on: true }, { en: 'Menu idea', es: 'Idea para el menú' }] });
  assert.deepEqual(saved.kinds.map((k) => [k.id, k.on]), [['suggestion', true], ['menu_idea', true], ['feedback', false], ['concern', false], ['shoutout', false]]);
  assert.deepEqual(call(of('employee'), 'feedback.form.get').kinds.map((k) => k.label), ['Idea', 'Menu idea']);
  refused(() => call(of('employee'), 'feedback.submit', { kind: 'concern', message: 'x' }), 400, 'Pick what kind of entry this is');
  refused(() => call(of('admin'), 'feedback.settings.save', { kinds: [{ en: 'Only', on: false }] }), 400, 'Keep at least one kind on');
});

test('internal notes are hidden from the person who wrote it', () => {
  const { of, call, store } = setup();
  const emp = of('employee');
  const { code } = call(emp, 'feedback.submit', { kind: 'feedback', message: 'Anonymous one.' });
  call(emp, 'feedback.submit', { kind: 'feedback', message: 'Signed one.', signed: true });
  const mgr = of('manager');
  for (const e of store.list('feedback')) call(mgr, 'feedback.note', { id: e.id, text: 'Internal: talk to the vendor first (Plum-77).' });
  assert.equal(call(mgr, 'feedback.inbox.get', { id: store.list('feedback')[0].id }).notes[0].text, 'Internal: talk to the vendor first (Plum-77).');
  const views = [call(emp, 'feedback.byCode.get', { code }), ...call(emp, 'feedback.mine.list')];
  views.push(call(emp, 'feedback.mine.get', { id: views[1].id }));
  for (const v of views) {
    assert.equal(v.notes, undefined);
    assert.ok(!JSON.stringify(v).includes('Plum-77'));
  }
});

test('status changes and replies notify a signed writer (never texted); an anonymous writer only sees them by code', () => {
  const { of, call, store } = setup();
  const emp = of('employee', 2);
  const mgr = of('manager');
  call(emp, 'feedback.submit', { kind: 'feedback', topic: 'schedule', message: 'Signed note.', signed: true });
  call(emp, 'feedback.submit', { kind: 'feedback', topic: 'schedule', message: 'Anonymous note.' });
  const [signed, anon] = ['Signed note.', 'Anonymous note.'].map((m) => store.list('feedback', (e) => e.message === m)[0]);
  const mineBefore = store.list('notifications', (n) => n.userId === emp.id).length;
  call(mgr, 'feedback.setStatus', { id: signed.id, status: 'seen' }); // opening it isn't news
  call(mgr, 'feedback.reply', { id: signed.id, text: 'Looking into it.' });
  call(mgr, 'feedback.setStatus', { id: signed.id, status: 'in_progress' });
  const notes = store.list('notifications', (n) => n.userId === emp.id).slice(mineBefore);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].text, `${mgr.name} replied to your feedback (Feedback)`);
  assert.equal(notes[1].text, 'Your feedback (Feedback) is now: In progress');
  assert.ok(notes.every((n) => n.noText && n.link === '#/feedback/mine' && !n.text.includes('Looking into it')));
  const total = store.list('notifications').length;
  call(mgr, 'feedback.reply', { id: anon.id, text: 'Thanks.' });
  call(mgr, 'feedback.setStatus', { id: anon.id, status: 'done' });
  assert.equal(store.list('notifications').length, total, 'nobody to notify for an anonymous entry');
  // Sharing: never by default; a name only with the writer's OK.
  assert.equal(call(emp, 'feedback.board.list').length, 0);
  refused(() => call(mgr, 'feedback.share', { id: signed.id, text: 'Edited.', showName: true }), 400, 'They haven’t agreed to show their name');
  call(mgr, 'feedback.askName', { id: signed.id });
  call(emp, 'feedback.mine.nameOk', { id: signed.id, ok: true });
  call(mgr, 'feedback.share', { id: signed.id, text: 'Post the schedule earlier.', reply: 'Now up by Thursday.', showName: true });
  call(mgr, 'feedback.share', { id: anon.id, text: 'An edited version.' });
  const board = call(of('employee', 5), 'feedback.board.list');
  assert.deepEqual(board.map((b) => b.name).sort(), ['', emp.name]);
  call(emp, 'feedback.mine.nameOk', { id: signed.id, ok: false });
  assert.deepEqual(call(of('employee', 5), 'feedback.board.list').map((b) => b.name), ['', '']);
  refused(() => call(mgr, 'feedback.askName', { id: anon.id }), 400);
});

test('nothing leaks through push, email or texts; a failed call is recorded without who made it', async () => {
  const conn = await freshConn();
  const db = new DocDb(conn);
  const resend = fakeResend();
  const twilio = fakeTwilio();
  const expoCalls = [];
  const expoFetch = async (url, init) => {
    expoCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ data: url === EXPO_PUSH_URL ? JSON.parse(init.body).map((_, i) => ({ status: 'ok', id: `tkt-${expoCalls.length}-${i}` })) : {} }) };
  };
  const env = { SEED_DEMO: 'true', JWT_SECRET: 'feedback-test-secret', FEEDBACK_SECRET: 'feedback-hmac-secret', ...TWILIO_ENV };
  const app = createApp({
    db, env, mailer: createMailer({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'ShiftBoard <schedule@test.example>' }, { fetchImpl: resend.fetchImpl }),
    texter: createTexter(env, { fetchImpl: twilio.fetchImpl }), expoPush: createExpoPush(env, { fetchImpl: expoFetch }),
  });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const people = db.store.list('users', (u) => u.active !== false && u.email).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const mgrId = people.find((u) => u.role === 'manager').id;
    const empId = people.filter((u) => u.role === 'employee')[1].id;
    // Everyone has a real-looking address, agreed to emails and texts, and the manager and the writer have the phone app.
    await db.run((s) => {
      for (const u of s.list('users', (x) => x.active !== false)) {
        s.update('users', u.id, { email: `${u.id.replace(/\W/g, '')}@crew-mail.app`, emailConsent: true, smsConsent: true, smsPhone: `+1303555${String(1000 + (u.order || 0)).slice(-4)}`, smsWelcomedAt: '2026-01-01T00:00:00.000Z' });
      }
      const mgr = s.get('users', mgrId);
      s.insert('deviceTokens', { id: 'dev_mgr', userId: mgr.id, token: 'ExponentPushToken[manager00000000000000]', platform: 'ios', v: 0, createdAt: '2026-01-01T00:00:00.000Z' });
      s.insert('deviceTokens', { id: 'dev_emp', userId: empId, token: 'ExponentPushToken[writer000000000000000]', platform: 'ios', v: 0, createdAt: '2026-01-01T00:00:00.000Z' });
    }, { write: true });
    const mgr = db.store.get('users', mgrId);
    const emp = db.store.get('users', empId);
    const rpc = async (cookie, method, args = {}) => {
      const res = await fetch(`${base}/api/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(args) });
      return { status: res.status, body: await res.json() };
    };
    const empCookie = await cookieFor(base, emp.email);
    const mgrCookie = await cookieFor(base, mgr.email);
    await app.locals.settled();
    const sent = { email: resend.emails().length, texts: twilio.texts().length, push: expoCalls.length };
    const { rows: [{ max }] } = await conn.query('SELECT max(seq)::text AS max FROM shiftboard.docs');

    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
    let r;
    try {
      r = await rpc(empCookie, 'feedback.submit', { kind: 'suggestion', topic: 'kitchen', message: MESSAGE });
      await app.locals.settled();
    } finally { Object.assign(console, orig); }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const code = r.body.result.code;

    // The readers heard about it: push and email with the kind and topic only; no texts at all.
    const pushes = expoCalls.slice(sent.push).filter((c) => c.url === EXPO_PUSH_URL).flatMap((c) => c.body);
    assert.ok(pushes.some((m) => m.to === 'ExponentPushToken[manager00000000000000]'), 'the manager’s phone gets a push');
    assert.ok(!pushes.some((m) => m.to.includes('writer')), 'nothing goes to the writer’s phone');
    for (const m of pushes) { assert.equal(m.body, 'New in the Feedback box: Suggestion · Kitchen'); assert.ok(!JSON.stringify(m).includes('Zebra')); }
    const emails = resend.emails().slice(sent.email);
    assert.ok(emails.some((e) => e.to.includes(mgr.email)), 'readers get the email copy');
    for (const e of emails) {
      assert.ok(!JSON.stringify(e).includes('Zebra'), 'no message in an email');
      for (const n of needles(emp)) assert.ok(!JSON.stringify(e).includes(n), 'no writer in an email');
    }
    assert.equal(twilio.texts().length, sent.texts, 'never texted');
    for (const line of logs) for (const n of [...needles(emp), 'Zebra']) assert.ok(!line.includes(n), `server log: ${line}`);

    // The database: every row written since has no link to the writer, and feedback rows keep the day only.
    const { rows } = await conn.query('SELECT col, id, data::text AS data, updated_at FROM shiftboard.docs WHERE seq > $1::bigint', [max]);
    assert.ok(rows.some((x) => x.col === 'feedback'));
    for (const row of rows) {
      for (const n of [...needles(emp), code, 'writer000']) assert.ok(!`${row.id} ${row.data}`.includes(n), `${row.col}/${row.id}`);
      if (['feedback', 'feedbackLimits'].includes(row.col)) {
        const t = new Date(row.updated_at);
        assert.equal(`${t.getUTCHours()}${t.getUTCMinutes()}${t.getUTCSeconds()}` === '000' || (t.getHours() === 0 && t.getMinutes() === 0 && t.getSeconds() === 0), true, `${row.col} updated_at is a day, not a time`);
      }
    }
    assert.equal((await conn.query(`SELECT count(*)::int AS n FROM shiftboard.docs WHERE col = 'auditLog' AND seq > $1::bigint`, [max])).rows[0].n, 0);

    // A reply: the anonymous writer gets nothing pushed, emailed or texted (they check with their code).
    const before = { email: resend.emails().length, push: expoCalls.length };
    const id = (await rpc(mgrCookie, 'feedback.inbox.list')).body.result.items[0].id;
    assert.equal((await rpc(mgrCookie, 'feedback.reply', { id, text: 'Thanks, fixing it.' })).status, 200);
    await app.locals.settled();
    assert.equal(resend.emails().length, before.email);
    assert.equal(expoCalls.length, before.push);
    assert.equal((await rpc(empCookie, 'feedback.byCode.get', { code })).body.result.thread[0].text, 'Thanks, fixing it.');
    assert.equal((await rpc(empCookie, 'feedback.byCode.get', { code: 'ABCD-EFGH-JKLM-NPQR' })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }

  // Error tracking: a 500 from a feedback call keeps the method, not the person or their device.
  const recorded = [];
  const mini = express();
  mini.use(capture({ recorder: { record: (ev) => recorded.push(ev) }, userOf: () => ({ id: 'usr_someone' }) }));
  mini.post('/api/rpc/:method', (req, res) => { console.error('boom', new Error('Test failure')); res.status(500).json({ error: 'Something went wrong' }); });
  const s2 = mini.listen(0, '127.0.0.1');
  await once(s2, 'listening');
  const orig = console.error;
  console.error = () => {};
  try {
    for (const m of ['feedback.submit', 'shifts.list']) {
      await fetch(`http://127.0.0.1:${s2.address().port}/api/rpc/${m}`, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    }
    await new Promise((res) => setTimeout(res, 50));
  } finally { console.error = orig; s2.closeAllConnections(); s2.close(); }
  const [fb, other] = recorded;
  assert.equal(fb.route, '/api/rpc/feedback.submit');
  assert.equal(fb.userId, null);
  assert.equal(fb.device, '');
  assert.equal(other.userId, 'usr_someone', 'other calls keep who made them, as before');
});

test('View as reads the inbox, read-only', () => {
  const { store, of, call } = setup();
  call(of('employee'), 'feedback.submit', { kind: 'feedback', message: 'Viewed, not changed.' });
  const owner = store.get('users', 'usr_test_owner');
  const view = { real: owner, actor: of('manager'), target: of('manager').id, lang: 'en' };
  const list = viewCall(store, view, 'feedback.inbox.list', {});
  assert.equal(list.items.length, 1);
  assert.equal(viewCall(store, view, 'feedback.inbox.get', { id: list.items[0].id }).message, 'Viewed, not changed.');
  for (const m of ['feedback.setStatus', 'feedback.reply', 'feedback.note', 'feedback.share', 'feedback.submit', 'feedback.settings.save']) {
    refused(() => viewCall(store, view, m, { id: list.items[0].id, status: 'done', text: 'x', kind: 'feedback', message: 'x' }), 403, VIEW_READ_ONLY);
  }
  assert.equal(store.list('feedback')[0].status, 'new');
});

test('plan and role gating: every plan has it; admins can turn submitting or reading off per role', async () => {
  assert.deepEqual(featuresForMethod('feedback.submit'), ['feedback']);
  assert.deepEqual(featuresForMethod('feedback.inbox.list'), ['feedback']);
  for (const p of ['starter', 'pro', 'beta']) assert.equal(resolveFeatures(p).feedback, true, p);
  assert.ok(PLANS.starter.features.includes('feedback'));
  assert.deepEqual(roleFeaturesFor('feedback.submit'), ['feedback']);
  assert.deepEqual(roleFeaturesFor('feedback.inbox.get'), ['feedbackInbox']);
  assert.deepEqual(roleFeaturesFor('feedback.settings.save'), []);

  const { of, call } = setup();
  const admin = of('admin');
  call(admin, 'roleFeatures.save', { roleFeatures: { employee: { feedback: false }, manager: { feedbackInbox: false } } });
  refused(() => call(of('employee'), 'feedback.submit', { kind: 'feedback', message: 'x' }), 403, ROLE_OFF);
  assert.equal(call(of('employee'), 'app.bootstrap').features.feedback, false);
  refused(() => call(of('manager'), 'feedback.inbox.list'), 403, ROLE_OFF);
  assert.equal(call(of('manager'), 'app.bootstrap').features.feedbackInbox, false);
  call(of('manager'), 'feedback.submit', { kind: 'feedback', message: 'Managers still write' });
  assert.equal(call(admin, 'feedback.inbox.list').items.length, 1);

  // Off in the plan: the RPCs answer 403 "Not included in your plan" (server/app.js).
  const conn = await openPglite();
  const db = new DocDb(conn);
  const tenant = { id: 't_fb', slug: 'fb', isDefault: true, status: 'active', plan: 'starter', features: resolveFeatures('starter', { feedback: false }) };
  const app = createApp({ db, env: { SEED_DEMO: 'true', JWT_SECRET: 'fb-plan', EXPO_PUSH: 'off' }, tenant });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const emp = db.store.list('users', (u) => u.role === 'employee' && u.active !== false && u.email)[0];
    const cookie = await cookieFor(base, emp.email);
    const res = await fetch(`${base}/api/rpc/feedback.submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ kind: 'feedback', message: 'x' }) });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, NOT_IN_PLAN);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); }
});

test('Spanish: labels, notifications, errors and the web catalogs', () => {
  const { store, of, call } = setup();
  const mgr = of('manager');
  store.update('users', mgr.id, { language: 'es' });
  store.update('users', of('employee').id, { language: 'es' });
  const form = call(of('employee'), 'feedback.form.get');
  assert.deepEqual(form.kinds.map((k) => k.label), DEFAULT_KINDS.map((k) => k.es));
  assert.match(form.safetyNote, /^Los problemas urgentes de seguridad/);
  call(of('employee', 1), 'feedback.submit', { kind: 'shoutout', topic: 'foh', message: 'Gracias.' });
  const note = store.list('notifications', (n) => n.userId === mgr.id && n.feedback).at(-1);
  assert.equal(note.text, 'Nuevo en el buzón de sugerencias: Reconocimiento · Salón');
  assert.equal(note.i18n.en, 'New in the Feedback box: Shout-out · Front of house');
  const list = call(mgr, 'feedback.inbox.list');
  assert.equal(list.items[0].statusLabel, 'Nuevo');
  assert.deepEqual(list.statuses.map((s) => s.label), ['Nuevo', 'Visto', 'En proceso', 'Hecho', 'No se hará']);
  assert.equal(translateError('No entry has that code', 'es'), 'Ningún mensaje tiene ese código');
  // The web catalogs: the feedback files are spread into en.js / es.js, with the same keys.
  assert.equal(en.feedback, enFeedback.feedback);
  assert.equal(es.feedback, esFeedback.feedback);
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && !('other' in v) ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  assert.deepEqual(keys(esFeedback), keys(enFeedback));
});

test('the demo has one entry of each kind and a code that opens one with a reply', () => {
  const store = new MemoryStore();
  const now = new Date(2026, 8, 27, 12);
  seedDemo(store, { now });
  seedFeedbackDemo(store, { now });
  const svc = createService(store, { now: () => now });
  assert.deepEqual([...new Set(store.list('feedback').map((e) => e.kind))].sort(), DEFAULT_KINDS.map((k) => k.id).sort());
  const emp = store.list('users', (u) => u.role === 'employee')[3];
  const v = svc.call(emp, 'feedback.byCode.get', { code: DEMO_CODE });
  assert.equal(v.replies, 1);
  assert.equal(svc.call(emp, 'feedback.board.list').length, 2);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ---------- a database of this test file's own (PGlite, or a throwaway one next to TEST_DATABASE_URL) ----------
async function freshConn() {
  const PG_URL = process.env.TEST_DATABASE_URL;
  if (!PG_URL) return openPglite();
  const u = new URL(PG_URL);
  const name = `${u.pathname.slice(1) || 'postgres'}_feedback`;
  const admin = openConnection({ DATABASE_URL: PG_URL });
  try { await admin.query(`CREATE DATABASE "${name}"`); } catch (e) { if (e.code !== '42P04') throw e; } finally { await admin.end(); }
  u.pathname = `/${name}`;
  const conn = openConnection({ DATABASE_URL: u.toString() });
  const { rows } = await conn.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('shiftboard', 'platform') OR nspname LIKE 't\\_%'`);
  for (const r of rows) await conn.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  return conn;
}
