// Editable notification emails (core/email-templates.js, Settings → Email notifications) and the Publish options
// (core/publish-notify.js): placeholders, escaping, unknown placeholders, per-type off, Spanish, reset, the test
// email; publish with "Notify staff" off sends nothing; the PDF goes only to people who agreed to notification emails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { renderTemplate, checkTemplate, unknownPlaceholders, typeOfNote, notificationTemplateEmail, defaultTemplate, templateFor, EMAIL_TYPES, FIXED_EMAILS } from '../core/email-templates.js';
import { publishOptions } from '../core/publish-notify.js';
import { notificationEmail } from '../server/email.js';
import { translateError } from '../core/errors.js';
import { addDays, todayStr, weekStart } from '../core/time.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';

const VARS = { name: 'Avery', restaurant: 'Test Bistro', link: 'https://app.test/#/my', message: 'The schedule is up', week: 'Nov 30 – Dec 6' };

test('templates: placeholders filled, everything escaped, simple line breaks and a link button', () => {
  const template = { subject: '{restaurant}: week of {week} <b>', body: 'Hi {name},\nsee <script>alert(1)</script> below.\n\nSecond paragraph & more\n[Open the {week} schedule]({link})' };
  const m = renderTemplate({ template, vars: { ...VARS, name: '<img src=x onerror=alert(1)>' }, restaurant: 'Test <Bistro>', lang: 'en' });
  assert.equal(m.subject, 'Test Bistro: week of Nov 30 – Dec 6 <b>', 'the subject is plain text');
  assert.ok(!/<script|<img|<b>/.test(m.html.replace(/<(\/?)(b)>/g, '')), 'no markup from the template or the values');
  assert.ok(m.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && m.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(m.html.includes('Hi &lt;img src=x onerror=alert(1)&gt;,<br>see'), 'a single line break stays a line break');
  assert.ok(m.html.includes('Second paragraph &amp; more</p>'), 'a blank line starts a paragraph');
  assert.match(m.html, /<a href="https:\/\/app\.test\/#\/my"[^>]*>Open the Nov 30 – Dec 6 schedule<\/a>/);
  assert.ok(m.text.includes('Open the Nov 30 – Dec 6 schedule: https://app.test/#/my'));
  // A value can never become a button or a link: only the template's own lines can.
  const sneaky = renderTemplate({ template: { subject: 's', body: '{message}' }, vars: { ...VARS, message: '[Click](https://evil.example)' }, restaurant: 'R' });
  assert.ok(!sneaky.html.includes('href="https://evil'));
  // A button to anything but {link} or https:// is refused.
  assert.deepEqual(checkTemplate('schedulePublished', { subject: 's', body: '[Go](http://evil.example)' }).map((p) => p.code), ['buttonLink']);
});

test('templates: unknown placeholders are flagged, per type', () => {
  assert.deepEqual(unknownPlaceholders('Hi {name}, {wek} and {shift}', 'schedulePublished'), ['wek', 'shift']);
  assert.deepEqual(unknownPlaceholders('{shift} by {manager}', 'shiftChanged'), []);
  assert.deepEqual(checkTemplate('tradeDenied', { subject: '', body: '{note} {count}' }).map((p) => [p.field, p.code, p.values]),
    [['subject', 'required', undefined], ['body', 'unknown', ['count']]]);
  assert.equal(translateError('Unknown placeholder: {wek}', 'es'), 'Campo desconocido: {wek}');
  // Every automatic email is either an editable type or one of the fixed account emails.
  assert.equal(EMAIL_TYPES.length, 16);
  assert.deepEqual(FIXED_EMAILS, ['invite', 'passwordReset', 'signInLink', 'securityNotice', 'testEmail']);
});

test('templates: the defaults are what notification emails always said', () => {
  const user = { name: 'Avery Lane', email: 'avery@testbistro.co' };
  const note = { text: 'New shift: Server Fri, Dec 4 4p–10p', link: '#/my', kind: 'newShift' };
  for (const lang of ['en', 'es']) {
    const before = notificationEmail({ user, note, appUrl: 'https://app.test', restaurant: 'Test Bistro', lang });
    const now = notificationTemplateEmail({ note, user, settings: { restaurantName: 'Test Bistro' }, appUrl: 'https://app.test', lang });
    assert.equal(now.subject, before.subject);
    assert.equal(now.text, before.text, lang);
    assert.equal(now.html, before.html, lang);
  }
  assert.equal(typeOfNote({ kind: 'schedulePosted' }), 'schedulePublished');
  assert.equal(typeOfNote({ kind: 'denied' }), 'tradeDenied');
  assert.equal(typeOfNote({ link: '#/86' }), 'eightySix');
  assert.equal(typeOfNote({ link: '#/tips/2026-11-30' }), 'tips');
  assert.equal(typeOfNote({ link: '#/training/quizzes' }), 'training');
  assert.equal(typeOfNote({ text: 'something' }), 'general');
});

/** A tiny restaurant for the settings API. */
function tiny() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Bistro' });
  store.insert('users', { id: 'own', name: 'Owner Person', role: 'admin', active: true, jobCodes: [] });
  store.insert('users', { id: 'mgr', name: 'Quinn Harbor', role: 'manager', active: true, jobCodes: [] });
  const svc = createService(store);
  return { store, svc, as: (id) => (m, a) => svc.call(store.get('users', id), m, a) };
}

test('Settings → Email notifications: admins save, turn off and reset; the defaults stay in code', () => {
  const f = tiny();
  const admin = f.as('own');
  assert.throws(() => f.as('mgr')('emailTemplates.get'), /Admins only/);
  const view = admin('emailTemplates.get');
  assert.equal(view.types.find((t) => t.id === 'schedulePublished').on, true);
  assert.deepEqual(view.types[0].vars, ['name', 'restaurant', 'link', 'message', 'week', 'manager']);
  assert.throws(() => admin('emailTemplates.save', { type: 'schedulePublished', lang: 'en', subject: 'Week {wek}', body: 'x' }), /Unknown placeholder: \{wek\}/);
  assert.throws(() => admin('emailTemplates.save', { type: 'nope', on: false }), /Unknown email type/);
  admin('emailTemplates.save', { type: 'schedulePublished', lang: 'es', subject: 'Horario {week}', body: 'Hola {name}:\n\nYa está el horario del {week}.' });
  admin('emailTemplates.save', { type: 'tradeUpdate', on: false });
  const st = f.svc.settings();
  assert.deepEqual(st.emailTemplates, { schedulePublished: { es: { subject: 'Horario {week}', body: 'Hola {name}:\n\nYa está el horario del {week}.' } }, tradeUpdate: { off: true } });
  assert.equal(templateFor(st, 'schedulePublished', 'en').custom, false, 'English keeps the default');
  // Saving the default words back is the same as no custom version.
  const def = defaultTemplate('schedulePublished', 'en');
  admin('emailTemplates.save', { type: 'schedulePublished', lang: 'en', ...def });
  assert.equal(f.svc.settings().emailTemplates.schedulePublished.en, undefined);
  const reset = admin('emailTemplates.reset', { type: 'schedulePublished', lang: 'es' });
  assert.equal(reset.types.find((t) => t.id === 'schedulePublished').es.custom, false);
  assert.deepEqual(f.svc.settings().emailTemplates, { tradeUpdate: { off: true } });
});

test('publish options: notify on unless false; the PDF only with notify, remembered per restaurant', () => {
  assert.deepEqual(publishOptions({}, {}), { notify: true, attach: null, remember: null });
  assert.deepEqual(publishOptions({ notify: false, attachPdf: true }, {}).attach, null);
  assert.deepEqual(publishOptions({ attachPdf: true, pdf: { paper: 'tabloid', fit: 'split' } }, {}),
    { notify: true, attach: { paper: 'tabloid', orientation: 'portrait', fit: 'split' }, remember: { attach: true, paper: 'tabloid', orientation: 'portrait', fit: 'split' } });
  assert.deepEqual(publishOptions({}, { publishPdf: { attach: true, paper: 'legal' } }).attach, { paper: 'legal', orientation: 'portrait', fit: 'fit' }, 'the remembered choice');
});

// ---------- over HTTP, with Resend stood in for ----------
const PEOPLE = [
  { id: 'usr_t_a', name: 'Avery Lane', email: 'avery@testbistro.co', emailConsent: true },
  { id: 'usr_t_b', name: 'Blair Stone', email: 'blair@testbistro.co', emailConsent: false },
  { id: 'usr_t_c', name: 'Casey Río', email: 'casey@testbistro.co', emailConsent: true, language: 'es' },
];

async function setup() {
  const A = await startApp({ sms: false });
  const admin = A.db.store.list('users').find((u) => u.role === 'admin' || u.role === 'superadmin');
  await A.db.run((s) => {
    s.update('users', admin.id, { email: 'owner@testbistro.co' });
    for (const p of PEOPLE) s.insert('users', { ...p, role: 'employee', active: true, availability: {}, jobCodes: [{ jobCodeId: 'job_srv' }] });
  }, { write: true });
  const c = jsonClient(A.base);
  const r = await signIn(c.post, 'owner@testbistro.co');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rpc = async (m, args = {}) => { const x = await c.post(`/api/rpc/${m}`, args); assert.equal(x.status, 200, `${m}: ${JSON.stringify(x.body)}`); return x.body.result; };
  const week = weekStart(addDays(todayStr(), 35), 1);
  const drafts = async (ws) => { for (const p of PEOPLE) await rpc('shifts.save', { date: addDays(ws, 2), start: '16:00', end: '22:00', jobCodeId: 'job_srv', userId: p.id, area: '' }); };
  return { A, c, rpc, week, drafts };
}

test('publish with "Notify staff" off: published, and nobody hears anything on any channel', async () => {
  const { A, rpc, week, drafts } = await setup();
  try {
    await drafts(week);
    await A.settled();
    const notesBefore = A.db.store.list('notifications').length;
    const callsBefore = A.resend.calls.length;
    const r = await rpc('shifts.publish', { start: week, end: addDays(week, 6), notify: false });
    assert.deepEqual([r.published, r.notified, r.silent], [3, 0, true]);
    await A.settled();
    await A.db.sync();
    assert.equal(A.db.store.list('notifications').length, notesBefore, 'no notifications');
    assert.equal(A.resend.calls.length, callsBefore, 'no email');
    assert.ok(A.db.store.list('shifts', (s) => s.date >= week && s.date <= addDays(week, 6)).every((s) => s.published));
  } finally { await A.close(); }
});

test('publish with the PDF: attached to the publish email for people with email consent only, in their language and template', async () => {
  const { A, c, rpc, week, drafts } = await setup();
  try {
    await rpc('emailTemplates.save', { type: 'schedulePublished', lang: 'es', subject: '{restaurant}: horario del {week}', body: 'Hola {name}:\n\nYa salió el horario del {week}.\n\n[Ver mis turnos]({link})' });
    await drafts(week);
    await A.settled();
    const r = await rpc('shifts.publish', { start: week, end: addDays(week, 6), attachPdf: true, pdf: { paper: 'tabloid', fit: 'fit' } });
    assert.equal(r.notified, 3, 'everyone hears in the app');
    await A.settled();
    const mails = A.resend.emails().filter((m) => m.attachments);
    assert.deepEqual(mails.map((m) => m.to[0]).sort(), ['avery@testbistro.co', 'casey@testbistro.co'], 'Blair didn’t agree to notification emails');
    for (const m of mails) {
      assert.equal(m.attachments.length, 1);
      assert.match(m.attachments[0].filename, new RegExp(`^schedule-${week}\\.pdf$`));
      const pdf = Buffer.from(m.attachments[0].content, 'base64');
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.ok(pdf.length < 200_000);
    }
    // Attachments go one per email (Resend's batch API takes none).
    assert.ok(A.resend.calls.filter((x) => x.body?.attachments).every((x) => x.url.endsWith('/emails')));
    const es = mails.find((m) => m.to[0] === 'casey@testbistro.co');
    assert.match(es.subject, /: horario del /);
    assert.ok(es.html.includes('Hola Casey:') && es.html.includes('>Ver mis turnos</a>'));
    const en = mails.find((m) => m.to[0] === 'avery@testbistro.co');
    assert.match(en.subject, /^The schedule for .+ is posted\. Check your shifts\.$/);
    // Remembered for next time.
    await A.db.sync();
    assert.deepEqual(A.db.store.get('settings', 'settings').publishPdf, { attach: true, paper: 'tabloid', orientation: 'portrait', fit: 'fit' });

    // A type that's off sends no email at all (the in-app notification still comes).
    await rpc('emailTemplates.save', { type: 'schedulePublished', on: false });
    const next = addDays(week, 7);
    await drafts(next);
    await A.settled();
    const before = A.resend.emails().length;
    await rpc('shifts.publish', { start: next, end: addDays(next, 6) });
    await A.settled();
    assert.equal(A.resend.emails().length, before);

    // Send me a test: the template as typed, with sample values, to the admin's own address.
    const t = await c.post('/api/email/template-test', { type: 'tradeDenied', lang: 'en', subject: 'Denied: {shift}', body: 'Sorry {name}. {note}' });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const test = A.resend.emails().at(-1);
    assert.equal(test.to[0], 'owner@testbistro.co');
    assert.match(test.subject, /^\[Test\] Denied: Server/);
    assert.equal((await c.post('/api/email/template-test', { type: 'tradeDenied', lang: 'en', subject: '{nope}', body: 'x' }, { 'X-ShiftBoard-Language': 'es' })).body.error, 'Campo desconocido: {nope}');
  } finally { await A.close(); }
});
