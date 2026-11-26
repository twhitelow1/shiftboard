// Announcements (core/announcements.js, server/announcements.js): who gets one, which channels reach whom and why
// not, texts only with smsConsent (checked again right before each text), email only with emailConsent, quiet
// hours, the daily text cap, scheduling and cancelling, the delivery records, the Spanish version, plan gating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { roleOf } from '../core/roles.js';
import { weekStart, addDays } from '../core/time.js';
import { smsText, smsSegments, gsmText, releaseDue, claimWork, applyResults, inQuietHours, quietEndAfter, countsOf, resolveAudience } from '../core/announcements.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { createMailer } from '../server/email.js';
import { createTexter } from '../server/sms.js';
import { createPusher } from '../server/push.js';
import { fakeResend } from './helpers/fake-resend.js';
import { signIn } from './helpers/signin.js';

const ALL = { push: true, appPush: true, email: true, sms: true };
const PHONES = { 'Alex D': '+13035550101', Styves: '+13035550102', Victor: '+13035550103', Tori: '+13035550104' };

function setup({ when = new Date(2026, 8, 27, 12), channels = ALL } = {}) {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const clock = { now: when };
  const svc = createService(store, { now: () => clock.now, announce: channels });
  const u = (name) => store.get('users', ids.userId[name]);
  const id = (name) => ids.userId[name];
  // Alex: texts + email; Styves: texts only; Tori: email only; Victor replied STOP; Andrea agreed to email but has no real address.
  store.update('users', id('Alex D'), { smsConsent: true, smsPhone: PHONES['Alex D'], emailConsent: true, email: 'alex@rabbits.co' });
  store.update('users', id('Styves'), { smsConsent: true, smsPhone: PHONES.Styves });
  store.update('users', id('Tori'), { emailConsent: true, email: 'tori@rabbits.co', smsPhone: PHONES.Tori });
  store.update('users', id('Victor'), { smsConsent: false, smsPhone: PHONES.Victor, smsStoppedAt: '2026-09-01T00:00:00.000Z', email: 'victor@rabbits.co' });
  store.update('users', id('Andrea'), { emailConsent: true });
  store.insert('pushSubscriptions', { id: 'psub_alex', userId: id('Alex D'), endpoint: 'https://fcm.googleapis.com/fcm/send/alex', keys: {} });
  store.insert('deviceTokens', { id: 'dev_tori', userId: id('Tori'), token: 'ExponentPushToken[tori]', platform: 'ios', v: 0 });
  const ctx = () => ({ settings: svc.settings(), channels, now: clock.now });
  return { store, ids, svc, u, id, clock, ctx };
}
const draft = (extra = {}) => ({ title: 'Staff meeting', body: 'Monday 3pm in the Library.', audience: { kind: 'everyone' }, ...extra });

test('audience: everyone, a role, a position, a room, working today / this week / a date, hand-picked; never the sender or inactive people', () => {
  const { store, svc, u, id } = setup();
  store.update('users', id('Mak'), { active: false });
  const names = (audience, day = '2026-09-27', sender = id('Moe')) => resolveAudience(store, audience, { settings: svc.settings(), day, senderId: sender }).map((x) => x.name).sort();
  const everyone = names({ kind: 'everyone' });
  assert.ok(!everyone.includes('Moe') && !everyone.includes('Mak'));
  assert.equal(everyone.length, store.list('users', (x) => x.active !== false).length - 1);
  assert.deepEqual(names({ kind: 'roles', roles: ['manager'] }), store.list('users', (x) => roleOf(x) === 'manager').map((x) => x.name).sort());
  assert.deepEqual(names({ kind: 'positions', jobCodeIds: ['job_bar'] }), ['Ciaran', 'Dante', 'Karen', 'Romina', 'Todd', 'Torie', 'Yair'], 'bartenders (Mak is inactive)');
  assert.deepEqual(names({ kind: 'rooms', areas: ['moon rabbit'] }), ['Agustina', 'Alan', 'Andrea', 'Ciaran', 'Dante', 'Flor', 'Maca', 'Payton', 'Romina', 'Samantha', 'Svetlana', 'Todd']);
  const workingOn = (dates) => [...new Set(store.list('shifts', (s) => s.userId && s.published && dates.includes(s.date)).map((s) => s.userId))]
    .map((x) => store.get('users', x)).filter((x) => x.active !== false && x.id !== id('Moe')).map((x) => x.name).sort();
  assert.deepEqual(names({ kind: 'date', date: '2026-09-29' }), workingOn(['2026-09-29']));
  assert.ok(names({ kind: 'date', date: '2026-09-29' }).length > 10);
  assert.deepEqual(names({ kind: 'today' }, '2026-10-02'), workingOn(['2026-10-02']));
  const ws = weekStart('2026-10-01', 1);
  assert.deepEqual(names({ kind: 'week' }, '2026-10-01'), workingOn(Array.from({ length: 7 }, (_, i) => addDays(ws, i))));
  assert.deepEqual(names({ kind: 'people', userIds: [id('Tori'), id('Mak'), id('Moe')] }), ['Tori']);
  assert.throws(() => svc.call(u('Moe'), 'announcements.send', draft({ audience: { kind: 'roles', roles: [] } })), /Pick who gets the announcement/);
  assert.throws(() => svc.call(u('Moe'), 'announcements.send', draft({ audience: { kind: 'date', date: '2030-01-01' } })), /Nobody is in this audience/);
});

test('before sending: how many each channel reaches, and why not the others', () => {
  const { svc, u, store } = setup();
  const s = svc.call(u('Kelly'), 'announcements.summary', draft({ email: true, sms: true }));
  const total = store.list('users', (x) => x.active !== false).length - 1;
  assert.equal(s.total, total);
  assert.equal(s.sms.reach, 2, 'Alex and Styves agreed to texts');
  assert.equal(s.sms.skipped.stopped, 1, 'Victor replied STOP');
  assert.equal(s.sms.skipped.noConsent, total - 3, 'everyone else hasn’t agreed (Tori gave a number but never agreed)');
  assert.equal(s.email.reach, 2, 'Alex and Tori');
  assert.equal(s.email.skipped.noEmail, total - 2 - (s.email.skipped.noConsent || 0));
  assert.equal(s.push.reach, 2, 'Alex (browser) and Tori (phone app)');
  assert.equal(s.push.skipped.noDevice, total - 2);
  assert.match(s.sms.text.en.text, /^Our Restaurant: Staff meeting - Monday 3pm in the Library\. Reply STOP to opt out$/);
  // Channels not picked aren't counted as skipped; channels not set up say so.
  assert.deepEqual(svc.call(u('Kelly'), 'announcements.summary', draft()).sms.skipped, {});
  const none = createService(store, { now: () => new Date(2026, 8, 27, 12), announce: { push: true } });
  assert.equal(none.call(u('Kelly'), 'announcements.summary', draft({ email: true, sms: true })).sms.skipped.notSetUp, total);
  // The restaurant switched texts off: nobody.
  svc.call(u('Moe'), 'sms.setRestaurant', { on: false });
  assert.equal(svc.call(u('Kelly'), 'announcements.summary', draft({ sms: true })).sms.skipped.restaurantOff, total);
});

test('managers and up only; staff read what they got, with read receipts', () => {
  const { svc, u, store, id, ctx } = setup();
  for (const who of ['Alex D', 'Courtney']) {
    assert.throws(() => svc.call(u(who), 'announcements.send', draft()), /Managers only/, who);
    assert.throws(() => svc.call(u(who), 'announcements.summary', draft()), /Managers only/, who);
    assert.throws(() => svc.call(u(who), 'announcements.cancel', { id: 'x' }), /Managers only/, who);
    assert.throws(() => svc.call(u(who), 'announcements.saveSettings', { smsDailyCap: 5, quietStart: '22:00', quietEnd: '08:00' }), /Admins only/, who);
  }
  const a = svc.call(u('Kelly'), 'announcements.send', draft({ audience: { kind: 'people', userIds: [id('Alex D'), id('Styves')] } }));
  assert.equal(a.status, 'queued');
  releaseDue(store, ctx());
  const note = store.list('notifications', (n) => n.announcementId === a.id && n.userId === id('Alex D'))[0];
  assert.equal(note.text, 'Staff meeting: Monday 3pm in the Library.');
  assert.equal(note.link, `#/announcements/${a.id}`);
  assert.deepEqual(svc.call(u('Alex D'), 'announcements.list', {}).map((x) => [x.title, x.read, x.from]), [['Staff meeting', false, 'Kelly']]);
  assert.throws(() => svc.call(u('Tori'), 'announcements.get', { id: a.id }), /Announcement not found/, 'not for her');
  assert.equal(svc.call(u('Alex D'), 'announcements.get', { id: a.id }).manage, null, 'staff never see the delivery details');
  const opened = svc.call(u('Alex D'), 'announcements.open', { id: a.id });
  assert.equal(opened.mine.read, true);
  assert.equal(store.get('notifications', note.id).read, true);
  const detail = svc.call(u('Moe'), 'announcements.get', { id: a.id }).manage;
  assert.equal(detail.counts.read, 1);
  assert.ok(detail.rows.find((r) => r.userId === id('Alex D')).readAt);
  assert.equal(detail.rows.find((r) => r.userId === id('Styves')).readAt, null);
  assert.equal(svc.call(u('Moe'), 'announcements.list', {})[0].id, a.id, 'managers see the history');
});

test('texts only with smsConsent, checked again when the batch is picked up; email only with emailConsent', () => {
  const { svc, u, store, id, ctx } = setup();
  assert.throws(() => svc.call(u('Kelly'), 'announcements.send', draft({ sms: true })), /Confirm that the text is about the schedule/);
  const a = svc.call(u('Kelly'), 'announcements.send', draft({ sms: true, email: true, scheduleRelated: true }));
  releaseDue(store, ctx());
  const rec = (name) => store.get('announcements', a.id).recipients[id(name)];
  assert.deepEqual([rec('Alex D').sms.s, rec('Styves').sms.s, rec('Victor').sms.r, rec('Tori').sms.r], ['queued', 'queued', 'stopped', 'noConsent']);
  assert.deepEqual([rec('Alex D').email.s, rec('Tori').email.s, rec('Victor').email.r, rec('Andrea').email.r], ['queued', 'queued', 'noConsent', 'noEmail']);
  assert.equal(store.get('announcements', a.id).status, 'sending');
  // Styves replies STOP and Tori turns email off before the batch goes out.
  store.update('users', id('Styves'), { smsConsent: false, smsStoppedAt: new Date().toISOString() });
  store.update('users', id('Tori'), { emailConsent: false });
  const work = claimWork(store, { ...ctx(), by: 'test', max: 500 });
  const job = (name) => work.jobs.find((j) => j.userId === id(name));
  assert.deepEqual(job('Alex D').channels, ['push', 'email', 'sms']);
  assert.equal(job('Alex D').to, PHONES['Alex D']);
  assert.ok(!job('Styves')?.channels.includes('sms'));
  assert.equal(rec('Styves').sms.r, 'consentWithdrawn');
  assert.equal(rec('Tori').email.r, 'consentWithdrawn');
  // The sender reports back: sent, failed with the reason, or back in the queue (rate limited).
  applyResults(store, a.id, [
    { userId: id('Alex D'), channel: 'sms', s: 'sent' }, { userId: id('Alex D'), channel: 'email', s: 'failed', r: 'Resend 422: invalid' },
    { userId: id('Alex D'), channel: 'push', s: 'sent' }, { userId: id('Tori'), channel: 'push', s: 'queued', r: 'rateLimited' },
  ], ctx());
  assert.deepEqual([rec('Alex D').sms.s, rec('Alex D').email.r, rec('Tori').push.s], ['sent', 'Resend 422: invalid', 'queued']);
  assert.equal(store.get('announcements', a.id).status, 'sending', 'Tori’s push is still to go');
  const again = claimWork(store, { ...ctx(), by: 'test' });
  applyResults(store, a.id, again.jobs.map((j) => ({ userId: j.userId, channel: 'push', s: 'sent' })), ctx());
  const done = store.get('announcements', a.id);
  assert.equal(done.status, 'sent');
  assert.equal(done.next, null);
  const c = countsOf(done);
  assert.deepEqual([c.sms.sent, c.sms.skipped, c.email.failed, c.push.sent], [1, c.recipients - 1, 1, 2]);
  assert.equal(claimWork(store, { ...ctx(), by: 'test' }), null, 'nothing left');
});

test('quiet hours: texts wait until 8 am unless an admin marks it urgent', () => {
  const { svc, u, store, id, ctx, clock } = setup({ when: new Date(2026, 8, 27, 23, 0) });
  assert.equal(inQuietHours(new Date(2026, 8, 27, 21, 59)), false);
  assert.equal(inQuietHours(new Date(2026, 8, 27, 22, 0)), true);
  assert.equal(inQuietHours(new Date(2026, 8, 28, 7, 59)), true);
  assert.equal(inQuietHours(new Date(2026, 8, 28, 8, 0)), false);
  assert.equal(quietEndAfter(new Date(2026, 8, 27, 23)).getTime(), new Date(2026, 8, 28, 8).getTime());
  assert.equal(quietEndAfter(new Date(2026, 8, 28, 1)).getTime(), new Date(2026, 8, 28, 8).getTime());
  const s = svc.call(u('Kelly'), 'announcements.summary', draft({ sms: true }));
  assert.equal(s.quietUntil, new Date(2026, 8, 28, 8).toISOString());
  assert.equal(s.sms.held, 2);
  const a = svc.call(u('Kelly'), 'announcements.send', draft({ sms: true, scheduleRelated: true }));
  releaseDue(store, ctx());
  assert.equal(store.get('announcements', a.id).recipients[id('Alex D')].sms.notBefore, new Date(2026, 8, 28, 8).toISOString());
  const night = claimWork(store, { ...ctx(), by: 'test', max: 500 });
  assert.ok(night.jobs.every((j) => !j.channels.includes('sms')), 'phone notifications go now, texts wait');
  applyResults(store, a.id, night.jobs.map((j) => ({ userId: j.userId, channel: 'push', s: 'sent' })), ctx());
  assert.equal(store.get('announcements', a.id).status, 'sent');
  assert.equal(store.get('announcements', a.id).next, new Date(2026, 8, 28, 8).toISOString());
  assert.equal(countsOf(store.get('announcements', a.id), clock.now.getTime()).sms.held, 2);
  clock.now = new Date(2026, 8, 28, 8, 1);
  const morning = claimWork(store, { ...ctx(), by: 'test', max: 500 });
  assert.deepEqual(morning.jobs.filter((j) => j.channels.includes('sms')).map((j) => j.to).sort(), [PHONES['Alex D'], PHONES.Styves]);
  // Urgent: admins only, and it texts right away.
  clock.now = new Date(2026, 8, 28, 23, 30);
  assert.throws(() => svc.call(u('Kelly'), 'announcements.send', draft({ sms: true, scheduleRelated: true, urgent: true })), /Only admins can mark an announcement urgent/);
  const urgent = svc.call(u('Moe'), 'announcements.send', draft({ title: 'Closed tomorrow', sms: true, scheduleRelated: true, urgent: true }));
  releaseDue(store, ctx());
  assert.equal(store.get('announcements', urgent.id).recipients[id('Alex D')].sms.notBefore, undefined);
  assert.ok(claimWork(store, { ...ctx(), by: 'test', max: 500 }).jobs.some((j) => j.channels.includes('sms')));
});

test('daily cap: at most 2 announcement texts per person per day (admins can change it)', () => {
  const { svc, u, store, id, ctx, clock } = setup();
  const textOf = () => {
    const a = svc.call(u('Kelly'), 'announcements.send', draft({ sms: true, scheduleRelated: true, audience: { kind: 'people', userIds: [id('Alex D')] } }));
    releaseDue(store, ctx());
    return store.get('announcements', a.id).recipients[id('Alex D')].sms;
  };
  assert.equal(textOf().s, 'queued');
  assert.equal(textOf().s, 'queued');
  assert.deepEqual(textOf(), { s: 'skipped', r: 'dailyCap' });
  assert.equal(svc.call(u('Kelly'), 'announcements.summary', draft({ sms: true, audience: { kind: 'people', userIds: [id('Alex D')] } })).sms.skipped.dailyCap, 1);
  assert.throws(() => svc.call(u('Kelly'), 'announcements.saveSettings', { smsDailyCap: 3, quietStart: '22:00', quietEnd: '08:00' }), /Admins only/);
  assert.throws(() => svc.call(u('Moe'), 'announcements.saveSettings', { smsDailyCap: 30, quietStart: '22:00', quietEnd: '08:00' }), /from 0 to 10/);
  assert.deepEqual(svc.call(u('Moe'), 'announcements.saveSettings', { smsDailyCap: 3, quietStart: '21:00', quietEnd: '09:00' }), { smsDailyCap: 3, quietStart: '21:00', quietEnd: '09:00' });
  assert.equal(textOf().s, 'queued');
  clock.now = new Date(2026, 8, 28, 12);
  assert.equal(textOf().s, 'queued', 'a new day');
});

test('scheduled for later, cancelled until it goes out', () => {
  const { svc, u, store, ctx, clock } = setup();
  const later = new Date(2026, 8, 27, 15).toISOString();
  assert.throws(() => svc.call(u('Kelly'), 'announcements.send', draft({ sendAt: new Date(2026, 8, 27, 11).toISOString() })), /Pick a time in the future/);
  assert.throws(() => svc.call(u('Kelly'), 'announcements.send', draft({ sendAt: new Date(2027, 0, 30).toISOString() })), /within 90 days/);
  const a = svc.call(u('Kelly'), 'announcements.send', draft({ sendAt: later }));
  const b = svc.call(u('Kelly'), 'announcements.send', draft({ title: 'Second', sendAt: later }));
  assert.deepEqual([a.status, a.sendAt], ['scheduled', later]);
  assert.deepEqual(releaseDue(store, ctx()), [], 'not yet');
  assert.equal(store.list('notifications', (n) => n.announcementId).length, 0);
  assert.equal(svc.call(u('Moe'), 'announcements.cancel', { id: a.id }).status, 'cancelled');
  clock.now = new Date(2026, 8, 27, 15, 1);
  assert.deepEqual(releaseDue(store, ctx()), [b.id], 'the cancelled one never goes out');
  assert.equal(store.list('notifications', (n) => n.announcementId === a.id).length, 0);
  assert.ok(store.list('notifications', (n) => n.announcementId === b.id).length > 10);
  assert.throws(() => svc.call(u('Kelly'), 'announcements.cancel', { id: b.id }), /Only scheduled announcements can be cancelled/);
  assert.deepEqual(svc.call(u('Kelly'), 'announcements.list', {}).map((x) => [x.title, x.status]).sort(), [['Second', 'sending'], ['Staff meeting', 'cancelled']]);
});

test('the Spanish version goes to Spanish speakers; without one they get the English', () => {
  const { svc, u, store, id, ctx } = setup();
  const spanishBefore = svc.call(u('Kelly'), 'announcements.summary', draft()).spanish;
  svc.call(u('Alex D'), 'account.preferences', { language: 'es' });
  svc.call(u('Styves'), 'account.preferences', { language: 'es' });
  const both = svc.call(u('Kelly'), 'announcements.send', draft({ titleEs: 'Junta del personal', bodyEs: 'El lunes a las 3 pm en la Biblioteca.', sms: true, scheduleRelated: true }));
  assert.equal(svc.call(u('Kelly'), 'announcements.summary', draft()).spanish, spanishBefore + 2);
  releaseDue(store, ctx());
  const note = (who, annId) => store.list('notifications', (n) => n.announcementId === annId && n.userId === id(who))[0];
  assert.equal(note('Alex D', both.id).text, 'Junta del personal: El lunes a las 3 pm en la Biblioteca.');
  assert.equal(note('Tori', both.id).text, 'Staff meeting: Monday 3pm in the Library.');
  assert.equal(store.get('announcements', both.id).recipients[id('Alex D')].lang, 'es');
  assert.equal(svc.call(u('Alex D'), 'announcements.list', {})[0].title, 'Junta del personal');
  svc.call(u('Alex D'), 'account.preferences', { language: 'en' });
  assert.equal(svc.call(u('Alex D'), 'notifications.list').find((n) => n.announcementId === both.id).text, 'Staff meeting: Monday 3pm in the Library.', 'follows a later language change');
  const englishOnly = svc.call(u('Kelly'), 'announcements.send', draft({ title: 'Inventory night' }));
  releaseDue(store, ctx());
  assert.match(note('Styves', englishOnly.id).text, /^Inventory night: /, 'English when there is no Spanish version');
  // The texts: the restaurant's name first, the STOP words last (STOP in English in Spanish too), accents GSM-7 lacks dropped.
  const es = smsText({ restaurant: 'Our Restaurant', title: 'Junta del personal', body: 'El lunes a las 3 pm en la Biblioteca. ¡Gracias!', lang: 'es' });
  assert.equal(es.text, 'Our Restaurant: Junta del personal - El lunes a las 3 pm en la Biblioteca. ¡Gracias! Responde STOP para cancelar');
  assert.equal(es.encoding, 'GSM-7');
  assert.equal(gsmText('Reunión mañana, café “gratis” — sí'), 'Reunion mañana, café "gratis" - si', 'é and ñ are GSM-7; ó and í are not');
});

test('texts stay short: characters and segments counted, long ones cut with a link', () => {
  assert.deepEqual(smsSegments('a'.repeat(160)), { chars: 160, segments: 1, encoding: 'GSM-7' });
  assert.deepEqual(smsSegments('a'.repeat(161)), { chars: 161, segments: 2, encoding: 'GSM-7' });
  assert.deepEqual(smsSegments('€'.repeat(80)), { chars: 160, segments: 1, encoding: 'GSM-7' }, 'the euro sign counts twice');
  assert.deepEqual(smsSegments('😀 hi'), { chars: 5, segments: 1, encoding: 'UCS-2' });
  assert.equal(smsSegments('ß'.repeat(10) + '你'.repeat(70)).segments, 2);
  const url = 'https://schedule.rabbits.co/#/announcements/ann_123';
  const long = smsText({ restaurant: 'Our Restaurant', title: 'Schedule change', body: 'x'.repeat(600), url });
  assert.equal(long.trimmed, true);
  assert.ok(long.segments <= 2 && long.chars <= 306, `${long.chars} chars`);
  assert.ok(long.text.startsWith('Our Restaurant: Schedule change - xxx'));
  assert.ok(long.text.endsWith(`... ${url} Reply STOP to opt out`));
  const short = smsText({ restaurant: 'Our Restaurant', title: 'Closed today', body: 'Snow day!', url });
  assert.deepEqual([short.text, short.segments, short.trimmed], ['Our Restaurant: Closed today - Snow day! Reply STOP to opt out', 1, false]);
});

// ---------- the server: sending in the background, after the commit ----------

function fakeTwilio({ onSend } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    calls.push(form);
    if (onSend) await onSend(form, calls.length);
    return { ok: true, status: 201, json: async () => ({ sid: `SM${calls.length}`, status: 'queued' }) };
  };
  return { calls, fetchImpl };
}
function fakePush() {
  const sent = [];
  return { sent, send: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, message: JSON.parse(payload) }); return { statusCode: 201 }; } };
}
const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'test-auth-token', TWILIO_MESSAGING_SERVICE_SID: 'MGtest' };
const PUSH_ENV = { VAPID_PUBLIC_KEY: 'test-public-key', VAPID_PRIVATE_KEY: 'test-private-key', VAPID_SUBJECT: 'mailto:owner@example.com' };
const KEYS = { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) };

async function startServer({ twilio = fakeTwilio(), tenant = null, env = {} } = {}) {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const resend = fakeResend();
  const push = fakePush();
  const fullEnv = { SEED_DEMO: 'true', EXPO_PUSH: 'off', APP_URL: 'https://schedule.rabbits.co', CRON_SECRET: 'cron-secret', ...TWILIO_ENV, ...PUSH_ENV, ...env };
  const app = createApp({
    db, env: fullEnv, tenant,
    mailer: createMailer({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Schedule <schedule@rabbits.co>' }, { fetchImpl: resend.fetchImpl }),
    texter: createTexter(fullEnv, { fetchImpl: twilio.fetchImpl }),
    pusher: createPusher(fullEnv, { send: push.send }),
  });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email) => {
    let cookie = '';
    const post = async (p, body = {}) => {
      const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    assert.equal((await signIn(post, email)).status, 200);
    return { post, rpc: (m, a) => post(`/api/rpc/${m}`, a) };
  };
  const write = (fn) => db.run(fn, { write: true });
  // Whatever time the tests run, no quiet hours (the same start and end): texts go right away.
  await write((s) => s.update('settings', 'settings', { announcements: { smsDailyCap: 2, quietStart: '03:00', quietEnd: '03:00' } }));
  return {
    app, db, base, resend, twilio, push, client, write,
    settled: async () => { for (let i = 0; i < 5; i++) await app.locals.settled(); },
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); },
  };
}

test('server: sent in the background after the commit, each channel to the right people, with delivery records', async () => {
  const S = await startServer();
  try {
    const alex = await S.client('alexd@demo.shiftboard');
    const styves = await S.client('styves@demo.shiftboard');
    const kelly = await S.client('kelly@demo.shiftboard');
    assert.equal((await alex.rpc('sms.preferences', { on: true, phone: '(303) 555-0101', consent: true })).status, 200);
    assert.equal((await styves.rpc('sms.preferences', { on: true, phone: '(303) 555-0102', consent: true })).status, 200);
    assert.equal((await alex.rpc('push.subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/alex', keys: KEYS } })).status, 200);
    await S.write((s) => {
      s.update('users', 'usr_alexd', { email: 'alex@rabbits.co', emailConsent: true });
      s.update('users', 'usr_tori', { email: 'tori@rabbits.co', emailConsent: true });
    });
    await S.settled();
    const welcomes = S.twilio.calls.length; // the one-time welcome texts on opting in
    const sentEmails = S.resend.calls.length;

    const preview = await kelly.rpc('announcements.summary', draft({ email: true, sms: true }));
    assert.equal(preview.status, 200);
    assert.deepEqual([preview.body.result.sms.reach, preview.body.result.email.reach, preview.body.result.push.reach], [2, 2, 1]);
    const r = await kelly.rpc('announcements.send', draft({ email: true, sms: true, scheduleRelated: true, link: '#/schedule' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.result.id;
    await S.settled();

    const texts = S.twilio.calls.slice(welcomes);
    assert.deepEqual(texts.map((t) => t.To).sort(), ['+13035550101', '+13035550102']);
    for (const t of texts) {
      assert.equal(t.Body, 'Our Restaurant: Staff meeting - Monday 3pm in the Library. Reply STOP to opt out');
      assert.equal(t.MessagingServiceSid, 'MGtest');
    }
    const emails = S.resend.calls.slice(sentEmails).flatMap((c) => (Array.isArray(c.body) ? c.body : [c.body]));
    assert.deepEqual(emails.map((e) => e.to[0]).sort(), ['alex@rabbits.co', 'tori@rabbits.co']);
    assert.ok(emails.every((e) => e.subject === 'Our Restaurant: Staff meeting'), 'only the announcement’s own emails, no notification copies');
    assert.match(emails[0].text, /Open ShiftBoard: https:\/\/schedule\.rabbits\.co\/#\/announcements\/ann_/);
    assert.ok(S.resend.calls.slice(sentEmails).every((c) => c.url.endsWith('/emails/batch')), 'the batch API');
    assert.deepEqual(S.push.sent.map((p) => [p.endpoint.split('/').pop(), p.message.title, p.message.url]), [['alex', 'Staff meeting', `/#/announcements/${id}`]]);

    const detail = (await kelly.rpc('announcements.get', { id })).body.result.manage;
    assert.equal(detail.status, 'sent');
    const row = (uid) => detail.rows.find((x) => x.userId === uid);
    assert.deepEqual([row('usr_alexd').sms.s, row('usr_alexd').email.s, row('usr_alexd').push.s], ['sent', 'sent', 'sent']);
    assert.deepEqual([row('usr_tori').sms.r, row('usr_tori').email.s, row('usr_tori').push.r], ['noConsent', 'sent', 'noDevice']);
    assert.equal(detail.counts.sms.sent, 2);
    const inbox = (await alex.rpc('notifications.list', {})).body.result;
    assert.ok(inbox.some((n) => n.announcementId === id && n.link === `#/announcements/${id}`));
    const opened = (await alex.rpc('announcements.open', { id })).body.result.mine;
    assert.deepEqual([opened.title, opened.link, opened.read], ['Staff meeting', '#/schedule', true]);
    assert.equal((await kelly.rpc('announcements.get', { id })).body.result.manage.counts.read, 1);
    // A second look sends nothing again.
    const before = [S.twilio.calls.length, S.resend.calls.length, S.push.sent.length];
    await kelly.rpc('app.bootstrap', {});
    await S.settled();
    assert.deepEqual([S.twilio.calls.length, S.resend.calls.length, S.push.sent.length], before);
  } finally { await S.close(); }
});

test('server: text consent is checked again right before each text', async () => {
  let S;
  // While the first text is going out, Styves replies STOP (as if the inbound webhook ran on another instance).
  const twilio = fakeTwilio({ onSend: async (form, n) => { if (n === 1) await S.write((s) => s.update('users', 'usr_styves', { smsConsent: false, smsStoppedAt: new Date().toISOString() })); } });
  S = await startServer({ twilio });
  try {
    await S.write((s) => {
      s.update('users', 'usr_alexd', { smsConsent: true, smsPhone: '+13035550101', smsWelcomedAt: '2026-01-01T00:00:00.000Z' });
      s.update('users', 'usr_styves', { smsConsent: true, smsPhone: '+13035550102', smsWelcomedAt: '2026-01-01T00:00:00.000Z' });
    });
    const moe = await S.client('moe@demo.shiftboard');
    const r = await moe.rpc('announcements.send', draft({ sms: true, scheduleRelated: true, urgent: true, audience: { kind: 'people', userIds: ['usr_alexd', 'usr_styves'] } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await S.settled();
    assert.deepEqual(S.twilio.calls.map((c) => c.To), ['+13035550101'], 'Styves stopped before his turn');
    const rows = (await moe.rpc('announcements.get', { id: r.body.result.id })).body.result.manage.rows;
    assert.deepEqual(rows.map((x) => [x.userId, x.sms.s, x.sms.r || '']).sort(), [['usr_alexd', 'sent', ''], ['usr_styves', 'skipped', 'consentWithdrawn']]);
  } finally { await S.close(); }
});

test('server: a scheduled announcement goes out from the cron when its time comes; a cancelled one never does', async () => {
  const S = await startServer();
  try {
    await S.write((s) => s.update('users', 'usr_alexd', { smsConsent: true, smsPhone: '+13035550101', smsWelcomedAt: '2026-01-01T00:00:00.000Z' }));
    const kelly = await S.client('kelly@demo.shiftboard');
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    const keep = (await kelly.rpc('announcements.send', draft({ title: 'Kept', sms: true, scheduleRelated: true, urgent: false, sendAt, audience: { kind: 'people', userIds: ['usr_alexd'] } }))).body.result;
    const drop = (await kelly.rpc('announcements.send', draft({ title: 'Dropped', sendAt, audience: { kind: 'people', userIds: ['usr_alexd'] } }))).body.result;
    assert.deepEqual([keep.status, drop.status], ['scheduled', 'scheduled']);
    assert.equal((await kelly.rpc('announcements.cancel', { id: drop.id })).body.result.status, 'cancelled');
    const cron = (auth) => fetch(`${S.base}/api/cron/announcements`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
    assert.equal((await cron()).status, 401);
    assert.equal((await (await cron('cron-secret')).json()).result.released, 0, 'not yet');
    // Its time comes (moved into the past, as if an hour went by).
    const past = new Date(Date.now() - 60_000).toISOString();
    await S.write((s) => { for (const id of [keep.id, drop.id]) s.update('announcements', id, { sendAt: past, ...(id === keep.id ? { next: past } : {}) }); });
    const ran = (await (await cron('cron-secret')).json()).result;
    assert.equal(ran.released, 1);
    assert.deepEqual(S.twilio.calls.map((c) => c.Body), ['Our Restaurant: Kept - Monday 3pm in the Library. Reply STOP to opt out']);
    const list = (await kelly.rpc('announcements.list', {})).body.result;
    assert.deepEqual(list.map((x) => [x.title, x.status]).sort(), [['Dropped', 'cancelled'], ['Kept', 'sent']]);
    assert.equal(S.db.store.list('notifications', (n) => n.announcementId === drop.id).length, 0);
  } finally { await S.close(); }
});

test('server: plan gating (announcements; texts need the plan’s text messages too)', async () => {
  const tenant = (features) => ({ id: 'ten_x', slug: 'x', name: 'X', isDefault: true, status: 'active', plan: 'starter', features });
  const off = await startServer({ tenant: tenant({ announcements: false, sms: true }) });
  try {
    const moe = await off.client('moe@demo.shiftboard');
    const r = await moe.rpc('announcements.list', {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Not included in your plan');
    assert.equal((await moe.rpc('announcements.send', draft())).status, 403);
  } finally { await off.close(); }
  const noTexts = await startServer({ tenant: tenant({ announcements: true, sms: false }) });
  try {
    await noTexts.write((s) => s.update('users', 'usr_alexd', { smsConsent: true, smsPhone: '+13035550101' }));
    const moe = await noTexts.client('moe@demo.shiftboard');
    const s = (await moe.rpc('announcements.summary', draft({ sms: true }))).body.result;
    assert.equal(s.channels.sms, false);
    assert.equal(s.sms.reach, 0);
    assert.ok(s.sms.skipped.notSetUp > 0);
  } finally { await noTexts.close(); }
});
