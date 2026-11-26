// Unpublish: a posted week back to draft (core/unpublish.js), and "what changed" when it's posted again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { translateError } from '../core/errors.js';
import en from '../web/src/i18n/en.js';
import es from '../web/src/i18n/es.js';

const WEEK = { start: '2026-09-28', end: '2026-10-04' }; // the seeded, posted week (Mon–Sun)

function setup(now = '2026-09-27T10:00:00') {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date(now) });
  const u = (name) => store.get('users', ids.userId[name]);
  const notes = (name) => store.list('notifications', (n) => n.userId === ids.userId[name]);
  return { store, svc, ids, u, notes };
}
const seen = (svc, who) => svc.call(who, 'shifts.list', WEEK).shifts;

test('unpublish a week: staff stop seeing it, managers see it as drafts, people are told', () => {
  const { store, svc, u, notes, ids } = setup();
  const before = seen(svc, u('Alex D')).length;
  assert.ok(before > 100);
  const preview = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(store.list('shifts', (s) => !s.published).length, 0, 'a dry run changes nothing');
  const r = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, note: 'Fixing Friday' });
  assert.equal(r.unpublished, preview.unpublished);
  assert.equal(r.notified, preview.notified);
  assert.equal(r.unpublished, before, 'nothing has started yet, so the whole week goes back');
  assert.equal(r.kept, 0);
  assert.equal(seen(svc, u('Alex D')).length, 0, 'staff no longer see it');
  const mgr = seen(svc, u('Kelly'));
  assert.equal(mgr.length, before);
  assert.ok(mgr.every((s) => !s.published), 'managers see them as drafts');
  const alex = notes('Alex D').at(-1).text;
  assert.equal(alex, "The schedule for Sep 28 – Oct 4 was pulled back for changes. You'll be notified when it's posted again. Note from Moe: “Fixing Friday”");
  assert.equal(notes('Alex D').at(-1).link, '#/my');
  assert.equal(new Set(store.list('notifications', (n) => n.text.includes('was pulled back for changes')).map((n) => n.userId)).size, r.notified);
  // Nobody can trade a drafted shift.
  const sh = store.list('shifts', (s) => s.userId === ids.userId['Alex D'])[0];
  assert.throws(() => svc.call(u('Alex D'), 'swaps.create', { shiftId: sh.id, type: 'drop' }), /Shift not found/);
  // The audit log says who, when and the counts.
  const log = store.list('auditLog', (x) => x.action === 'schedule.unpublished');
  assert.equal(log.length, 1);
  assert.equal(log[0].actorId, ids.userId.Moe);
  assert.equal(log[0].at, new Date('2026-09-27T10:00:00').toISOString());
  assert.equal(log[0].details.unpublished, r.unpublished);
  assert.equal(log[0].details.requestsCancelled, r.requestsCancelled);
  assert.equal(log[0].details.start, WEEK.start);
  // Doing it again finds nothing posted.
  assert.equal(svc.call(u('Moe'), 'shifts.unpublish', WEEK).unpublished, 0);
});

test('open trades, give-aways and pickups on those shifts are cancelled and the people told', () => {
  const { store, svc, u, notes } = setup();
  const active = store.list('requests', (r) => ['open', 'pending_approval'].includes(r.status));
  assert.equal(active.length, 3, 'the seed has a trade, a give-away and a pickup');
  const r = svc.call(u('Moe'), 'shifts.unpublish', WEEK);
  assert.equal(r.requestsCancelled, 3);
  for (const x of active) {
    const now = store.get('requests', x.id);
    assert.equal(now.status, 'cancelled');
    assert.equal(now.resolution, 'the schedule was pulled back for changes');
  }
  for (const who of ['Victor', 'Styves', 'Tori', 'Manny']) {
    assert.ok(notes(who).some((n) => n.text === 'Request cancelled: the schedule was pulled back for changes' && n.link === '#/swaps'), who);
  }
  // The web app shows the stored reason in the reader's language.
  assert.equal(en.swaps.noteSchedulePulledBack, 'the schedule was pulled back for changes');
  assert.ok(es.swaps.noteSchedulePulledBack);
});

test('shifts that already started stay published and are reported as kept', () => {
  const { store, svc, u } = setup('2026-09-30T12:00:00'); // Wednesday noon
  const r = svc.call(u('Moe'), 'shifts.unpublish', WEEK);
  assert.ok(r.kept > 0 && r.unpublished > 0);
  const week = store.list('shifts', (s) => s.date >= WEEK.start && s.date <= WEEK.end);
  assert.ok(week.filter((s) => s.date < '2026-09-30').every((s) => s.published), 'Mon and Tue stay posted');
  assert.ok(week.filter((s) => s.date > '2026-09-30').every((s) => !s.published), 'Thu on goes back');
  assert.equal(week.filter((s) => s.published).length, r.kept);
  const staff = seen(svc, u('Alex D'));
  assert.ok(staff.length === r.kept && staff.every((s) => s.date <= '2026-09-30'));
});

test('employees and supervisors can’t unpublish; managers and admins can', () => {
  const { store, svc, u, ids } = setup();
  assert.throws(() => svc.call(u('Alex D'), 'shifts.unpublish', WEEK), /Managers only/);
  store.update('users', ids.userId.Manny, { role: 'supervisor' });
  assert.throws(() => svc.call(u('Manny'), 'shifts.unpublish', WEEK), /Managers only/);
  assert.throws(() => svc.call(u('Manny'), 'shifts.unpublish', { ...WEEK, dryRun: true }), /Managers only/);
  assert.throws(() => svc.call(null, 'shifts.unpublish', WEEK), /sign in/);
  assert.equal(store.list('shifts', (s) => !s.published).length, 0);
  assert.throws(() => svc.call(u('Kelly'), 'shifts.unpublish', { start: '2026-10-04', end: '2026-09-28' }), /Pick a week/);
  assert.equal(translateError('Pick a week', 'es'), 'Elige una semana');
  assert.ok(svc.call(u('Kelly'), 'shifts.unpublish', WEEK).unpublished > 0, 'a manager');
});

test('scope: one room (area) or one position', () => {
  const { store, svc, u, ids, notes } = setup();
  const r = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, scope: { area: 'rabbit hole' } });
  const week = store.list('shifts', (s) => s.date >= WEEK.start && s.date <= WEEK.end);
  const drafts = week.filter((s) => !s.published);
  assert.ok(drafts.length && drafts.length === r.unpublished);
  assert.ok(drafts.every((s) => s.area === 'Rabbit Hole'));
  assert.ok(week.filter((s) => s.area !== 'Rabbit Hole').every((s) => s.published));
  assert.match(notes('Mak').at(-1).text, /^The schedule for Sep 28 – Oct 4 \(Rabbit Hole\) was pulled back for changes\./);
  // A position.
  const job = ids.jobId.BUS;
  const r2 = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, scope: { jobCodeId: job } });
  assert.ok(r2.unpublished > 0);
  assert.ok(store.list('shifts', (s) => s.jobCodeId === job && s.date >= WEEK.start && s.date <= WEEK.end).every((s) => !s.published));
  assert.throws(() => svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, scope: { jobCodeId: 'nope' } }), /Choose a job code/);
});

test('event shifts go back too, unless the manager keeps them posted', () => {
  const { store, svc, u } = setup();
  const events = store.list('shifts', (s) => s.eventId && s.date >= WEEK.start && s.date <= WEEK.end);
  assert.ok(events.length);
  const r = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, keepEvents: true });
  assert.equal(r.keptEvents, events.length);
  assert.equal(r.eventShifts, events.length);
  assert.ok(events.every((s) => store.get('shifts', s.id).published));
  assert.ok(store.list('shifts', (s) => !s.eventId && s.date >= WEEK.start && s.date <= WEEK.end).every((s) => !s.published));
});

test('the notifications are in each person’s language', () => {
  const { svc, u, notes } = setup();
  svc.call(u('Alex D'), 'account.preferences', { language: 'es' });
  svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, note: 'Cambios en la barra' });
  const alex = notes('Alex D').at(-1);
  assert.match(alex.text, /^El horario del 28 (de )?sept?\.? al 4 (de )?oct\.? volvió a borrador para hacer cambios\. Te avisaremos cuando se publique de nuevo\. Nota de Moe: “Cambios en la barra”$/, alex.text);
  assert.match(alex.i18n.en, /^The schedule for Sep 28 – Oct 4 was pulled back/);
  const victor = notes('Victor').find((n) => n.text.startsWith('Request cancelled'));
  assert.equal(victor.i18n.es, 'Se canceló la solicitud: el horario volvió a borrador para hacer cambios');
  // Posted again: Spanish too.
  svc.call(u('Moe'), 'shifts.publish', WEEK);
  assert.match(notes('Alex D').at(-1).text, /^Se volvió a publicar el horario del 28 (de )?sept?\.? al 4 (de )?oct\.?\. Tus turnos no cambiaron\.$/, notes('Alex D').at(-1).text);
});

test('republishing: staff see it again, and each person hears what changed for them', () => {
  const { store, svc, u, ids, notes } = setup();
  svc.call(u('Moe'), 'shifts.unpublish', WEEK);
  const mine = (name) => store.list('shifts', (s) => s.userId === ids.userId[name] && s.date >= WEEK.start && s.date <= WEEK.end).sort((a, b) => a.date.localeCompare(b.date));
  // Alex's Thursday moves an hour, Jonathan's Tuesday is removed, Tori gets a new Monday, Styves gets Jonathan's Thursday,
  // and Manny (no shifts this week) gets one too.
  const alexThu = mine('Alex D').find((s) => s.date === '2026-10-01');
  svc.call(u('Moe'), 'shifts.save', { ...alexThu, start: '17:00' });
  const jonTue = mine('Jonathan').find((s) => s.date === '2026-09-29');
  svc.call(u('Moe'), 'shifts.delete', { id: jonTue.id });
  svc.call(u('Moe'), 'shifts.save', { date: '2026-09-28', start: '16:00', end: '22:00', jobCodeId: ids.jobId.SRV, userId: ids.userId.Tori });
  svc.call(u('Moe'), 'shifts.save', { date: '2026-09-28', start: '17:00', end: '22:00', jobCodeId: ids.jobId.SRV, userId: ids.userId.Manny });
  const jonThu = mine('Jonathan').find((s) => s.date === '2026-10-01');
  svc.call(u('Moe'), 'shifts.save', { ...jonThu, userId: ids.userId.Styves });
  const quietBefore = notes('Andrea').length;

  const r = svc.call(u('Moe'), 'shifts.publish', WEEK);
  assert.ok(r.published > 100);
  assert.ok(seen(svc, u('Alex D')).length > 100, 'staff see it again');
  assert.ok(seen(svc, u('Alex D')).every((s) => s.published));

  const job = (id) => store.get('jobCodes', id).name;
  const posted = (name) => notes(name).filter((n) => n.text.startsWith('The schedule for Sep 28 – Oct 4 is posted')).at(-1).text;
  assert.equal(posted('Alex D'), `The schedule for Sep 28 – Oct 4 is posted again. What changed for you: moved ${job(alexThu.jobCodeId)}${alexThu.area ? ` (${alexThu.area})` : ''} Thu, Oct 1 4p → Thu, Oct 1 5p`);
  const jon = posted('Jonathan');
  assert.match(jon, /^The schedule for Sep 28 – Oct 4 is posted again\. What changed for you: /);
  assert.match(jon, /removed .*Tue, Sep 29 4p/);
  assert.match(jon, /removed .*Thu, Oct 1 4:30p/);
  assert.match(posted('Tori'), /What changed for you: added .*Mon, Sep 28 4p–10p$/);
  assert.equal(posted('Manny'), 'The schedule for Sep 28 – Oct 4 is posted. Check your shifts.', 'new to this schedule: the usual message');
  assert.match(posted('Styves'), /added .*Thu, Oct 1 4:30p/);
  // Someone whose shifts didn't change hears just that, once.
  const andrea = notes('Andrea').slice(quietBefore);
  assert.deepEqual(andrea.map((n) => n.text), ["The schedule for Sep 28 – Oct 4 is posted again. Your shifts didn't change."]);
  assert.ok(store.list('pullbacks').every((p) => p.closedAt), 'the pullback is closed');

  // Next time it's a normal publish.
  svc.call(u('Moe'), 'shifts.save', { date: '2026-09-28', start: '11:00', jobCodeId: ids.jobId.SRV, userId: ids.userId.Andrea });
  svc.call(u('Moe'), 'shifts.publish', WEEK);
  assert.equal(notes('Andrea').at(-1).text, 'The schedule for Sep 28 – Oct 4 is posted. Check your shifts.');
});

test('a long list of changes is cut to three, with "+N more"', () => {
  const { store, svc, u, ids, notes } = setup();
  svc.call(u('Moe'), 'shifts.unpublish', WEEK);
  for (const s of store.list('shifts', (s) => s.userId === ids.userId['Alex D'] && s.date >= WEEK.start && s.date <= WEEK.end)) svc.call(u('Moe'), 'shifts.delete', { id: s.id });
  const had = store.list('pullbacks')[0].seen[ids.userId['Alex D']].length;
  assert.ok(had > 3);
  svc.call(u('Moe'), 'shifts.publish', WEEK);
  const text = notes('Alex D').find((n) => n.text.includes('is posted again')).text;
  assert.equal(text.split('; ').length, 3);
  assert.ok(text.endsWith(` (+${had - 3} more)`), text);
});

test('the demo build path: the same service in the browser, on the demo clock', () => {
  // web/src/api.js: seedDemo with the demo clock, createService with now = DEMO_NOW (Sun Sep 27 2026, noon).
  const DEMO_NOW = new Date(2026, 8, 27, 12, 0, 0);
  const store = new MemoryStore();
  const ids = seedDemo(store, { now: DEMO_NOW });
  const svc = createService(store, { now: () => DEMO_NOW });
  const moe = store.get('users', ids.userId.Moe);
  const plan = svc.call(moe, 'shifts.unpublish', { ...WEEK, dryRun: true });
  assert.ok(plan.unpublished > 0 && plan.notified > 0 && plan.requestsCancelled === 3);
  const done = svc.call(moe, 'shifts.unpublish', WEEK);
  assert.equal(done.unpublished, plan.unpublished);
  assert.equal(svc.call(store.get('users', ids.userId['Alex D']), 'shifts.list', WEEK).shifts.length, 0);
  assert.equal(svc.call(moe, 'shifts.publish', WEEK).published, done.unpublished);
  // Every word the dialog uses exists in both languages.
  for (const k of Object.keys(en.unpublish)) assert.ok(es.unpublish[k], k);
});

test('"Notify staff" off: nobody hears about the pull-back, but cancelled requests are still told', () => {
  const { store, svc, u, ids } = setup();
  const before = store.list('notifications').length;
  const preview = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, notify: false, dryRun: true });
  assert.equal(preview.notified, 0);
  assert.ok(preview.people > 0);
  const r = svc.call(u('Moe'), 'shifts.unpublish', { ...WEEK, notify: false, note: 'not sent' });
  assert.equal(r.notify, false);
  assert.equal(r.notified, 0);
  assert.equal(r.requestsCancelled, 3);
  const sent = store.list('notifications').slice(before);
  assert.ok(!sent.some((n) => n.text.startsWith('The schedule for')), 'no schedule notice');
  for (const who of ['Victor', 'Styves', 'Tori', 'Manny']) {
    assert.ok(sent.some((n) => n.userId === ids.userId[who] && n.text === 'Request cancelled: the schedule was pulled back for changes'), who);
  }
  assert.equal(new Set(sent.map((n) => n.userId)).size, 4, 'only the people on the cancelled requests');
  assert.equal(store.list('auditLog', (x) => x.action === 'schedule.unpublished')[0].details.notify, false);
  // Still a pull-back: staff don't see it, and republishing works as usual.
  assert.equal(seen(svc, u('Alex D')).length, 0);
  svc.call(u('Moe'), 'shifts.publish', WEEK);
  assert.ok(seen(svc, u('Alex D')).length > 100);
});

test('the shared "Notify staff" helper', async () => {
  const { staffNotifier, wantsNotify } = await import('../core/notify-choice.js');
  const calls = [];
  const fake = (ids, text, link) => calls.push({ ids, text, link });
  assert.equal(wantsNotify({}), true);
  assert.equal(wantsNotify(undefined), true);
  assert.equal(wantsNotify({ notify: false }), false);
  assert.equal(staffNotifier(fake, {})(['a', 'b', 'a', null], 'hi', '#/my'), 2);
  assert.deepEqual(calls, [{ ids: ['a', 'b'], text: 'hi', link: '#/my' }]);
  assert.equal(staffNotifier(fake, { notify: false })(['a'], 'hi'), 0);
  assert.equal(calls.length, 1);
});
