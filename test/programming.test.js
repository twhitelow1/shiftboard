// Regular programming and staffing pars (core/programming.js): recurrence (weekdays, seasons, date ranges, every other
// week, the nth weekday), overlap warnings, events replacing a room's programming (a full buyout every room), one-off
// date exceptions (cancel, new times, new pars) that are logged and reversible, coverage (scheduled vs par per
// position), open shifts for the gaps (drafts only), the publish check, the schedule's day-notes row (manual notes
// win) and the PDF, the Claude connector's tools (preview → confirm), permissions and View as, and Spanish.
// Everything here is invented: the venue, its rooms and its people.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { occursOn, overlapWarnings, eventRooms, dayProgramming, AUDIT } from '../core/programming.js';
import { ROLE_OFF, roleMatrix, featuresForMethod } from '../core/role-features.js';
import { translateError } from '../core/errors.js';
import { loadSheetModel, schedulePdf } from '../core/schedule-pdf.js';
import { viewCall, viewedPerson, resolveTarget, VIEW_READ_ONLY } from '../core/view-as.js';
import { toolByName, runTool, createToolContext, visibleTools, TOOLS, READ, WRITE } from '../server/tools/index.js';
import { describeAction } from '../server/assistant/actions.js';
import { startApp } from './helpers/app.js';
import en from '../web/src/i18n/en.js';
import es from '../web/src/i18n/es.js';

const WED = '2026-12-09', THU = '2026-12-10', FRI = '2026-12-11', SAT = '2026-12-12', MON = '2026-12-07', WEEK = MON;
const NOW = new Date('2026-12-01T12:00:00');
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message));

/** An invented venue: a dining room, a cellar bar and a glass room; closed Mondays. */
function fixture() {
  const store = new MemoryStore();
  const close = { open: '11:00', close: '23:00' }, late = { open: '11:00', close: '01:00' };
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Venue', closedDays: [1], areas: ['Dining Room', 'Cellar Bar', 'Glass Room'],
    rooms: ['Dining Room', 'Cellar Bar', 'Glass Room', 'Full Buyout'], hours: { 0: close, 1: { open: '', close: '' }, 2: close, 3: close, 4: close, 5: late, 6: late } });
  const job = (id, name, department, defaultRole = 'employee') => store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), department, defaultRole, order: 0, archived: false, eventRole: true });
  job('job_srv', 'Server', 'Dining Room');
  job('job_host', 'Host', 'Dining Room');
  job('job_bar', 'Bartender', 'Cellar Bar');
  job('job_bbk', 'Barback', 'Cellar Bar');
  job('job_coc', 'Cocktail Server', 'Glass Room');
  job('job_mgr', 'Manager', 'Leadership', 'manager');
  const user = (id, name, role, jobs = []) => store.insert('users', { id, name, role, active: true, email: `${id}@test.local`, availability: {}, jobCodes: jobs.map(([jobCodeId, areas]) => ({ jobCodeId, ...(areas ? { areas } : {}) })) });
  user('owner', 'Owner Person', 'super_admin');
  user('admin', 'Ada Ledger', 'admin');
  user('mgr', 'Quinn Harbor', 'manager', [['job_mgr']]);
  user('sup', 'Sky Lantern', 'supervisor', [['job_bar', ['Cellar Bar']]]);
  for (let i = 1; i <= 4; i++) user(`bar${i}`, `Bar Person${i}`, 'employee', [['job_bar', ['Cellar Bar', 'Glass Room', 'Dining Room']]]);
  for (let i = 1; i <= 4; i++) user(`coc${i}`, `Cocktail Person${i}`, 'employee', [['job_coc', ['Glass Room']]]);
  for (let i = 1; i <= 4; i++) user(`srv${i}`, `Server Person${i}`, 'employee', [['job_srv', ['Dining Room']]]);
  user('bbk1', 'Barback Person1', 'employee', [['job_bbk', ['Cellar Bar']]]);
  user('host1', 'Host Person1', 'employee', [['job_host', ['Dining Room']]]);
  const svc = createService(store, { now: () => NOW });
  const as = (id) => (m, a = {}) => svc.call(store.get('users', id), m, a);
  const layout = as('admin')('layout.get');
  as('admin')('layout.save', { rev: layout.rev, rooms: [
    { room: 'Dining Room', positions: [{ jobCodeId: 'job_srv' }, { jobCodeId: 'job_host' }, { jobCodeId: 'job_bar' }] },
    { room: 'Cellar Bar', positions: [{ jobCodeId: 'job_bar' }, { jobCodeId: 'job_bbk' }] },
    { room: 'Glass Room', positions: [{ jobCodeId: 'job_coc' }, { jobCodeId: 'job_bar' }] },
  ] });
  const mgr = as('mgr');
  const regular = mgr('programming.save', { name: 'Regular service', rooms: ['Dining Room'], days: [0, 2, 3, 4, 5, 6], start: '11:00', end: '', dayNote: 'Regular service',
    pars: [{ jobCodeId: 'job_srv', count: 3, start: '16:00' }, { jobCodeId: 'job_host', count: 1 }, { jobCodeId: 'job_mgr', count: 1 }] }).item;
  const dinner = mgr('programming.save', { name: 'Immersive dinner', rooms: ['Glass Room'], days: [3, 6], start: '18:00', end: '21:30', color: '#9333ea', notes: 'Phones away during the show',
    pars: [{ jobCodeId: 'job_coc', count: 4, start: '17:00' }, { jobCodeId: 'job_bar', count: 2 }] }).item;
  const dj = mgr('programming.save', { name: 'DJ night', rooms: ['Cellar Bar'], days: [5, 6], start: '21:00', end: '01:00', color: '#e11d48',
    pars: [{ jobCodeId: 'job_bar', count: 3 }, { jobCodeId: 'job_bbk', count: 2, start: '20:00' }] }).item;
  let n = 0;
  const shift = (userId, jobCodeId, area, date, start, end = '', extra = {}) => store.insert('shifts', { id: `shf_t${++n}`, date, start, end: end || null, jobCodeId, userId, area, tag: '', notes: '', breakMin: 0, published: true, eventId: null, staffingLineId: null, ...extra });
  return { store, svc, as, mgr, ids: { regular: regular.id, dinner: dinner.id, dj: dj.id }, shift };
}
const day = (r, date) => r.days.find((d) => d.date === date);
const item = (d, name) => d.items.find((x) => x.name === name);

// ---------- recurrence ----------

test('recurrence: weekdays, closed days, seasons, date ranges, every other week and the first Friday', () => {
  const base = { id: 'x', name: 'x', rooms: [], days: [5], start: '18:00', end: '', active: true };
  assert.equal(occursOn(base, FRI), true);
  assert.equal(occursOn(base, THU), false, 'only its weekdays');
  assert.equal(occursOn({ ...base, active: false }, FRI), false);
  assert.equal(occursOn({ ...base, season: 'winter' }, FRI), true, 'December is winter');
  assert.equal(occursOn({ ...base, season: 'summer' }, FRI), false);
  assert.equal(occursOn({ ...base, season: 'summer' }, '2026-07-10'), true);
  assert.equal(occursOn({ ...base, from: '2026-12-01', to: '2027-03-31' }, FRI), true, 'Dec 1 – Mar 31');
  assert.equal(occursOn({ ...base, from: '2026-12-01', to: '2027-03-31' }, '2027-04-02'), false);
  assert.equal(occursOn({ ...base, from: '2026-12-12' }, FRI), false, 'not before it starts');
  const biweekly = { ...base, repeat: 'biweekly', anchor: '2026-12-04' };
  assert.deepEqual([FRI, '2026-12-18', '2026-12-25', '2026-11-27', '2026-11-20'].map((d) => occursOn(biweekly, d)), [false, true, false, false, true], 'every other Friday from Dec 4');
  const first = { ...base, repeat: 'monthly', nth: 1 };
  assert.deepEqual(['2026-12-04', FRI, '2027-01-01', '2027-01-08'].map((d) => occursOn(first, d)), [true, false, true, false], 'the first Friday of the month');
  const last = { ...base, repeat: 'monthly', nth: -1 };
  assert.deepEqual(['2026-12-25', '2026-12-18'].map((d) => occursOn(last, d)), [true, false], 'the last Friday');

  const { mgr } = fixture();
  const r = mgr('programming.days.list', { start: MON, end: addD(MON, 6) });
  assert.equal(day(r, MON).closed, true, 'Monday is closed in Settings');
  assert.deepEqual(day(r, MON).items, []);
  assert.equal(day(r, MON).autoNote, 'CLOSED');
  assert.deepEqual(day(r, WED).items.map((x) => x.name), ['Regular service', 'Immersive dinner']);
  assert.deepEqual(day(r, THU).items.map((x) => x.name), ['Regular service']);
  assert.deepEqual(day(r, SAT).items.map((x) => x.name), ['Regular service', 'Immersive dinner', 'DJ night'], 'several items on one day in different rooms');
  // Saved with a season and a date range, checked.
  refused(() => mgr('programming.save', { name: 'Brunch', rooms: ['Dining Room'], days: [0], start: '10:00', season: 'monsoon' }), 400, 'Unknown season');
  refused(() => mgr('programming.save', { name: 'Brunch', rooms: ['Dining Room'], days: [0], start: '10:00', from: '2027-03-31', to: '2026-12-01' }), 400, 'The last day is before the first');
  refused(() => mgr('programming.save', { name: 'Brunch', rooms: ['Attic'], days: [0], start: '10:00' }), 400, 'Pick one of the venue’s rooms');
  refused(() => mgr('programming.save', { name: 'Brunch', rooms: ['Dining Room'], days: [], start: '10:00' }), 400, 'Pick at least one day');
  refused(() => mgr('programming.save', { name: 'Brunch', rooms: ['Dining Room'], days: [0], start: '10:00', pars: [{ jobCodeId: 'job_srv', count: 120 }] }), 400, 'A par is a whole number from 0 to 99');
  const winter = mgr('programming.save', { name: 'Winter brunch', rooms: [], days: [0], start: '10:00', end: '14:00', season: 'winter' }).item;
  assert.deepEqual(winter.rooms, [], 'no rooms: the whole venue');
});
const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ---------- overlaps ----------

test('overlap warnings: one item per room at a time (a whole-venue item uses every room); saving still works', () => {
  const { mgr, ids } = fixture();
  assert.deepEqual(mgr('programming.list').warnings, [], 'the fixture has none: different rooms');
  const r = mgr('programming.save', { name: 'Late jazz', rooms: ['Cellar Bar'], days: [6], start: '22:00', end: '23:30' });
  assert.equal(r.warnings.length, 1, 'saved, with a warning');
  assert.equal(r.warnings[0].room, 'Cellar Bar');
  assert.deepEqual(r.warnings[0].days, [6]);
  assert.ok([r.warnings[0].a, r.warnings[0].b].includes(ids.dj));
  // Not on the same weekday, not at the same time, not in the same season: no warning.
  assert.equal(mgr('programming.save', { name: 'Tuesday jazz', rooms: ['Cellar Bar'], days: [2], start: '22:00', end: '23:30' }).warnings.length, 0);
  assert.equal(mgr('programming.save', { name: 'Happy hour', rooms: ['Cellar Bar'], days: [5], start: '16:00', end: '18:00' }).warnings.length, 0);
  const items = [{ id: 'a', name: 'A', rooms: ['Cellar Bar'], days: [5], start: '21:00', end: '23:00', season: 'winter' }, { id: 'b', name: 'B', rooms: ['Cellar Bar'], days: [5], start: '21:00', end: '23:00', season: 'summer' }];
  assert.deepEqual(overlapWarnings(items), []);
  // A whole-venue item overlaps any room's item.
  assert.equal(overlapWarnings([{ ...items[0], season: '' }, { id: 'c', name: 'C', rooms: [], days: [5], start: '22:00', end: '23:00' }]).length, 1);
  assert.ok(mgr('programming.list').warnings.length >= 1, 'the list shows it too');
});

// ---------- events ----------

test('an event in a room replaces that room’s programming for the time they overlap; other rooms keep theirs', () => {
  const { store, mgr } = fixture();
  store.insert('events', { id: 'evt_glass', name: 'Lantern Society Dinner', date: WED, start: '17:30', end: '22:00', room: 'Glass Room', guestCount: 40, status: 'confirmed', staffing: [] });
  store.insert('events', { id: 'evt_tent', name: 'Maybe Party', date: '2026-12-26', start: '20:00', end: '23:00', room: 'Cellar Bar', guestCount: 30, status: 'tentative', staffing: [] });
  store.insert('events', { id: 'evt_late', name: 'Afterparty', date: FRI, start: '23:00', end: '02:00', room: 'Cellar Bar', guestCount: 80, status: 'confirmed', staffing: [] });
  const r = mgr('programming.days.list', { start: WED, end: '2026-12-26' });
  const wed = day(r, WED);
  assert.equal(item(wed, 'Immersive dinner').status, 'replaced');
  assert.deepEqual(item(wed, 'Immersive dinner').replacedBy.map((x) => x.name), ['Lantern Society Dinner']);
  assert.equal(item(wed, 'Regular service').status, 'on', 'the dining room keeps its programming');
  assert.equal(wed.autoNote, 'REGULAR SERVICE', 'replaced programming leaves the day note');
  // Partly: the DJ runs 21:00–23:00, before the afterparty.
  const fri = item(day(r, FRI), 'DJ night');
  assert.equal(fri.status, 'partial');
  assert.deepEqual([fri.partStart, fri.partEnd], ['21:00', '23:00']);
  assert.equal(item(day(r, '2026-12-26'), 'DJ night').status, 'on', 'a tentative event (more than two weeks out) replaces nothing');
  // Room names in the event's room text: "&", "/", initials and the start of a name.
  const rooms = ['Dining Room', 'Cellar Bar', 'Glass Room'];
  assert.deepEqual(eventRooms({ room: 'Glass Room & Cellar Bar' }, rooms).rooms, ['Glass Room', 'Cellar Bar']);
  assert.deepEqual(eventRooms({ room: 'Patio / CB / gla' }, rooms).rooms, ['Cellar Bar', 'Glass Room']);
  assert.equal(eventRooms({ room: 'Full Buyout' }, rooms).all, true);
});

test('a full buyout replaces every room; its own staffing is the pars, and staffed x/y stays the event’s', () => {
  const { store, mgr, as, shift } = fixture();
  store.insert('events', { id: 'evt_buyout', name: 'Harbor Gala', date: SAT, start: '16:00', end: '02:00', room: 'Full Buyout', guestCount: 120, status: 'confirmed',
    staffing: [{ id: 'stf_g1', jobCodeId: 'job_srv', count: 6, start: '15:00', end: '' }, { id: 'stf_g2', jobCodeId: 'job_bar', count: 3, start: '15:00', end: '' }] });
  shift('srv1', 'job_srv', 'Dining Room', SAT, '15:00', '', { eventId: 'evt_buyout', staffingLineId: 'stf_g1' });
  shift('srv2', 'job_srv', 'Dining Room', SAT, '15:00', '', { eventId: 'evt_buyout', staffingLineId: 'stf_g1' });
  shift(null, 'job_srv', 'Dining Room', SAT, '15:00', '', { eventId: 'evt_buyout', staffingLineId: 'stf_g1' });
  const sat = day(mgr('programming.days.list', { start: SAT, end: SAT }), SAT);
  assert.equal(item(sat, 'Immersive dinner').status, 'replaced');
  assert.equal(item(sat, 'DJ night').status, 'replaced');
  const reg = item(sat, 'Regular service');
  assert.equal(reg.status, 'partial', 'lunch still runs before the buyout');
  assert.deepEqual([reg.partStart, reg.partEnd], ['11:00', '16:00']);
  assert.equal(sat.events[0].all, true);
  const ev = sat.coverage.find((c) => c.kind === 'event');
  assert.deepEqual(ev.lines.map((l) => [l.jobCodeId, l.have, l.need, l.open]), [['job_srv', 2, 6, 1], ['job_bar', 0, 3, 0]]);
  const e = as('mgr')('events.get', { id: 'evt_buyout' });
  assert.equal(e.filled, ev.lines.reduce((t, l) => t + Math.min(l.have, l.need), 0), 'the same staffed count as the event');
  assert.equal(e.needed, ev.lines.reduce((t, l) => t + l.need, 0));
  assert.ok(!sat.coverage.some((c) => c.name === 'DJ night'), 'no pars for what the buyout replaced');
});

test('an event with no staffing of its own: “Use the regular pars” or “Set pars for this event”', () => {
  const { store, mgr, as, shift } = fixture();
  store.insert('events', { id: 'evt_none', name: 'Book Club Supper', date: WED, start: '17:30', end: '22:00', room: 'Glass Room', guestCount: 30, status: 'confirmed', staffing: [] });
  let wed = day(mgr('programming.days.list', { start: WED, end: WED }), WED);
  assert.equal(wed.events[0].needsPars, true, 'the calendar offers the two choices');
  assert.ok(!wed.coverage.some((c) => c.kind === 'event'));
  // Use the regular pars: the dinner's pars, counted in the Glass Room.
  shift('coc1', 'job_coc', 'Glass Room', WED, '17:00');
  assert.equal(mgr('programming.eventPars', { eventId: 'evt_none', mode: 'regular' }).programmingPars, 'regular');
  wed = day(mgr('programming.days.list', { start: WED, end: WED }), WED);
  assert.equal(wed.events[0].needsPars, false);
  const ev = wed.coverage.find((c) => c.kind === 'event');
  assert.deepEqual(ev.lines.map((l) => [l.jobCodeId, l.have, l.need]), [['job_coc', 1, 4], ['job_bar', 0, 2]]);
  // Set pars for this event: copied into its staffing lines, which staffed x/y counts.
  const copied = mgr('programming.eventPars', { eventId: 'evt_none', mode: 'copy' });
  assert.deepEqual(copied.staffing.map((l) => [l.jobCodeId, l.count]), [['job_coc', 4], ['job_bar', 2]]);
  assert.equal(as('mgr')('events.get', { id: 'evt_none' }).needed, 6);
  refused(() => mgr('programming.eventPars', { eventId: 'evt_none', mode: 'copy' }), 400, 'This event already has its own staffing');
  refused(() => as('bar1')('programming.eventPars', { eventId: 'evt_none', mode: 'regular' }), 403);
  assert.ok(store.list('auditLog', (x) => x.action === AUDIT.eventPars).length === 2, 'logged');
});

// ---------- one-off exceptions ----------

test('one-off date exceptions: cancel, new times, new pars; shown, logged in the audit log, and reversible', () => {
  const { store, mgr, ids } = fixture();
  // "Cancel DJ this Friday"
  mgr('programming.override', { id: ids.dj, date: FRI, action: 'cancel', reason: 'DJ is sick' });
  let fri = day(mgr('programming.days.list', { start: FRI, end: FRI }), FRI);
  assert.equal(item(fri, 'DJ night').status, 'cancelled');
  assert.equal(item(fri, 'DJ night').exception.reason, 'DJ is sick');
  assert.equal(fri.autoNote, 'REGULAR SERVICE');
  assert.ok(!fri.coverage.some((c) => c.name === 'DJ night'), 'no pars on a cancelled night');
  assert.equal(item(day(mgr('programming.days.list', { start: SAT, end: SAT }), SAT), 'DJ night').status, 'on', 'only that date');
  // Holiday hours: new times.
  mgr('programming.override', { id: ids.regular, date: THU, action: 'retime', start: '15:00', end: '20:00', reason: 'Holiday hours' });
  const thu = item(day(mgr('programming.days.list', { start: THU, end: THU }), THU), 'Regular service');
  assert.deepEqual([thu.start, thu.end], ['15:00', '20:00']);
  // New pars for one night.
  mgr('programming.override', { id: ids.dinner, date: WED, action: 'repar', pars: [{ jobCodeId: 'job_coc', count: 6 }] });
  const wed = day(mgr('programming.days.list', { start: WED, end: WED }), WED);
  assert.deepEqual(item(wed, 'Immersive dinner').pars, [{ jobCodeId: 'job_coc', count: 6 }]);
  assert.deepEqual(wed.coverage.find((c) => c.name === 'Immersive dinner').lines.map((l) => l.need), [6]);
  // "Closed for private event": everything that runs that day.
  const all = mgr('programming.override', { id: 'all', date: SAT, action: 'cancel', reason: 'Closed for private event' });
  assert.equal(all.items.length, 3);
  assert.deepEqual(day(mgr('programming.days.list', { start: SAT, end: SAT }), SAT).items.map((x) => x.status), ['cancelled', 'cancelled', 'cancelled']);
  // Reversible: clear goes back to the regular programming.
  mgr('programming.override', { id: ids.dj, date: FRI, action: 'clear' });
  assert.equal(item(day(mgr('programming.days.list', { start: FRI, end: FRI }), FRI), 'DJ night').status, 'on');
  assert.equal(store.get('programming', ids.dj).exceptions[FRI], undefined);
  // Logged: who, what, before and after.
  const log = store.list('auditLog', (x) => x.action === AUDIT.override || x.action === AUDIT.cleared);
  assert.equal(log.length, 1 + 1 + 1 + 3 + 1);
  const cleared = log.find((x) => x.action === AUDIT.cleared);
  assert.equal(cleared.actorId, 'mgr');
  assert.equal(cleared.details.before.reason, 'DJ is sick');
  assert.ok(mgr('programming.list').log.some((x) => x.action === AUDIT.cleared && x.by === 'Quinn Harbor'), 'Settings → Programming shows recent changes');
  refused(() => mgr('programming.override', { id: ids.dj, date: FRI, action: 'explode' }), 400, 'Pick what changes');
  refused(() => mgr('programming.override', { id: 'nope', date: FRI, action: 'cancel' }), 404, 'Programming not found');
});

// ---------- coverage ----------

test('coverage: scheduled vs par per room and position; each shift counts once; open shifts listed apart', () => {
  const { mgr, shift } = fixture();
  // Wednesday's dinner: Cocktail Server 4 (in at 5), Bartender 2.
  shift('coc1', 'job_coc', 'Glass Room', WED, '17:00', '22:00');
  shift('coc2', 'job_coc', 'Glass Room', WED, '17:00', '22:00');
  shift(null, 'job_coc', 'Glass Room', WED, '17:00', '22:00');
  shift('bar1', 'job_bar', 'Glass Room', WED, '17:00', '22:00');
  shift('bar2', 'job_bar', 'Cellar Bar', WED, '17:00', '22:00'); // in another room: not the Glass Room's
  shift('srv1', 'job_srv', 'Dining Room', WED, '16:00', '22:00');
  shift('srv2', 'job_srv', 'Dining Room', WED, '11:00', '15:00'); // lunch: before the dinner servers' par time, but regular service runs from 11
  shift('host1', 'job_host', 'Dining Room', WED, '16:00');
  shift('mgr', 'job_mgr', '', WED, '15:00'); // a manager with no room counts wherever they work
  const wed = day(mgr('programming.days.list', { start: WED, end: WED }), WED);
  const cov = (name) => Object.fromEntries(wed.coverage.find((c) => c.name === name).lines.map((l) => [l.jobCodeId, `${l.have}/${l.need}${l.open ? `+${l.open}` : ''}`]));
  assert.deepEqual(cov('Immersive dinner'), { job_coc: '2/4+1', job_bar: '1/2' });
  assert.deepEqual(cov('Regular service'), { job_srv: '2/3', job_host: '1/1', job_mgr: '1/1' });
  assert.equal(wed.short, 2 + 1 + 1, 'missing: 2 cocktail servers, a bartender, a server');
});

test('“Create open shifts for the gaps”: drafts at the par start times, never published; only what’s still missing', () => {
  const { store, mgr, as, shift } = fixture();
  shift('coc1', 'job_coc', 'Glass Room', WED, '17:00', '22:00');
  shift(null, 'job_coc', 'Glass Room', WED, '17:00', '22:00');
  const dry = mgr('programming.fillGaps', { start: WED, end: WED, dryRun: true });
  assert.equal(dry.created, 0);
  const before = store.list('shifts').length;
  assert.equal(store.list('shifts').length, before, 'a dry run saves nothing');
  const r = mgr('programming.fillGaps', { start: WED, end: WED });
  assert.equal(r.created, dry.wouldCreate);
  assert.ok(r.shifts.every((s) => s.published === false && s.userId === null), 'drafts, open');
  const coc = r.shifts.filter((s) => s.jobCodeId === 'job_coc');
  assert.equal(coc.length, 2, 'par 4 − 1 scheduled − 1 open already');
  assert.ok(coc.every((s) => s.start === '17:00' && s.area === 'Glass Room' && s.end === '21:30' && s.programmingId), 'at the par’s start time, in its room');
  const srv = r.shifts.filter((s) => s.jobCodeId === 'job_srv');
  assert.ok(srv.length === 3 && srv.every((s) => s.start === '16:00' && s.area === 'Dining Room'));
  assert.equal(mgr('programming.fillGaps', { start: WED, end: WED }).created, 0, 'again: nothing more (the open shifts cover the gaps)');
  assert.equal(day(mgr('programming.days.list', { start: WED, end: WED }), WED).short, r.created + 1, 'still short until someone is assigned');
  // An event's gaps become open shifts on its staffing lines (so its staffed x/y counts them).
  store.insert('events', { id: 'evt_s', name: 'Quartz Awards', date: THU, start: '18:00', end: '22:00', room: 'Glass Room', guestCount: 50, status: 'confirmed',
    staffing: [{ id: 'stf_q', jobCodeId: 'job_coc', count: 2, start: '17:00', end: '' }] });
  mgr('programming.fillGaps', { start: THU, end: THU });
  const e = as('mgr')('events.get', { id: 'evt_s' });
  assert.equal(e.staffing[0].created, 2);
  assert.equal(e.filled, 0);
  assert.ok(store.list('shifts', (s) => s.eventId === 'evt_s').every((s) => !s.published));
  refused(() => as('bar1')('programming.fillGaps', { start: WED, end: WED }), 403, 'Managers only');
  assert.equal(store.list('auditLog', (x) => x.action === AUDIT.fillGaps).length, 2);
});

test('publish check: the understaffed days and rooms are summed up; publishing itself answers as before and isn’t blocked', () => {
  const { mgr, shift } = fixture();
  shift('coc1', 'job_coc', 'Glass Room', WED, '17:00', '22:00', { published: false });
  const gaps = mgr('programming.gaps.list', { start: WEEK, end: addD(WEEK, 6) });
  assert.ok(gaps.short > 0);
  const wed = gaps.days.find((d) => d.date === WED);
  const dinner = wed.rooms.find((c) => c.name === 'Immersive dinner');
  assert.equal(dinner.room, 'Glass Room');
  assert.deepEqual(dinner.lines.find((l) => l.jobCodeId === 'job_coc'), { jobCodeId: 'job_coc', need: 4, have: 1, open: 0, gap: 3, start: '17:00' }, 'drafts count: what publishing would post');
  assert.ok(!gaps.days.some((d) => d.date === MON), 'closed Monday has no gaps');
  const pub = mgr('shifts.publish', { start: WEEK, end: addD(WEEK, 6), notify: false });
  assert.deepEqual(Object.keys(pub).sort(), ['notified', 'published', 'silent'], 'shifts.publish answers exactly as before');
  assert.equal(pub.published, 1, 'not blocked');
});

// ---------- the day-notes row and the PDF ----------

test('day-notes row: filled from programming; a manager’s own note wins; the PDF prints the same line', async () => {
  const { mgr, as, store } = fixture();
  let r = mgr('programming.days.list', { start: WEEK, end: addD(WEEK, 6) });
  assert.equal(day(r, WED).autoNote, 'REGULAR SERVICE\nGLASS ROOM: IMMERSIVE DINNER 6PM');
  assert.equal(day(r, SAT).note, 'REGULAR SERVICE\nGLASS ROOM: IMMERSIVE DINNER 6PM\nCELLAR BAR: DJ NIGHT 9PM');
  mgr('notes.save', { kind: 'day', date: WED, text: 'STAFF MEETING 3PM' });
  r = mgr('programming.days.list', { start: WEEK, end: addD(WEEK, 6) });
  assert.equal(day(r, WED).note, 'STAFF MEETING 3PM', 'manual notes win');
  assert.equal(day(r, WED).manualNote, 'STAFF MEETING 3PM');
  assert.match(day(r, WED).autoNote, /IMMERSIVE/, 'the automatic line is still there for whoever wants it');
  // shifts.list answers as before: no programming fields.
  const week = mgr('shifts.list', { start: WEEK, end: addD(WEEK, 6) });
  assert.deepEqual(Object.keys(week).sort(), ['events', 'notes', 'rosters', 'shifts', 'timeOff', 'warnings']);
  // The PDF's notes row: the manual note on Wednesday, programming on the other days.
  const call = (m, a) => as('mgr')(m, a);
  const model = await loadSheetModel(call, { weekStart: WEEK, lang: 'en', isMgr: true });
  assert.equal(model.events[2], 'STAFF MEETING 3PM');
  assert.equal(model.events[5], 'REGULAR SERVICE\nGLASS ROOM: IMMERSIVE DINNER 6PM\nCELLAR BAR: DJ NIGHT 9PM');
  assert.equal(model.events[0], 'CLOSED');
  const { bytes } = await schedulePdf(model, {});
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const words = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join(' ');
  assert.match(words, /DJ NIGHT 9PM/);
  assert.match(words, /STAFF MEETING 3PM/);
  // In Spanish (the PDF's language).
  const esModel = await loadSheetModel(call, { weekStart: WEEK, lang: 'es', isMgr: true });
  assert.equal(esModel.events[0], 'CERRADO');
  assert.equal(esModel.events[5], 'REGULAR SERVICE\nGLASS ROOM: IMMERSIVE DINNER 6 PM\nCELLAR BAR: DJ NIGHT 9 PM', 'names stay as typed; times in Spanish');
  assert.ok(store.list('notes').length === 1);
});

// ---------- permissions, roles and View as ----------

test('permissions: everyone sees programming; pars, coverage and editing are managers and up by default (role features)', () => {
  const { store, svc, as, mgr, ids } = fixture();
  const emp = as('bar1');
  const r = emp('programming.days.list', { start: WED, end: WED });
  assert.equal(r.canPars, false);
  const wed = day(r, WED);
  assert.deepEqual(wed.items.map((x) => x.name), ['Regular service', 'Immersive dinner'], 'staff see what’s on');
  assert.equal(item(wed, 'Immersive dinner').notes, 'Phones away during the show', 'with the notes for staff');
  assert.ok(wed.items.every((x) => !('pars' in x)), 'no pars');
  assert.equal(wed.coverage, undefined, 'no coverage');
  assert.ok(emp('programming.list').items.every((x) => !('pars' in x)));
  refused(() => emp('programming.save', { name: 'Mine', days: [2], start: '10:00' }), 403, ROLE_OFF);
  refused(() => emp('programming.override', { id: ids.dj, date: FRI, action: 'cancel' }), 403, ROLE_OFF);
  refused(() => emp('programming.gaps.list', { start: WED, end: WED }), 403, ROLE_OFF);
  refused(() => as('sup')('programming.gaps.list', { start: WED, end: WED }), 403, ROLE_OFF);
  assert.equal(as('owner')('programming.days.list', { start: WED, end: WED }).canPars, true, 'a Super Admin always');
  // The defaults: managers and admins; switchable per role; never refused per RPC (checked inside).
  const m = roleMatrix({});
  assert.deepEqual([m.employee.staffingPars, m.supervisor.staffingPars, m.manager.staffingPars, m.admin.staffingPars], [false, false, true, true]);
  assert.deepEqual([m.employee.programmingEdit, m.supervisor.programmingEdit, m.manager.programmingEdit], [false, false, true]);
  for (const k of ['programming.days.list', 'programming.save', 'programming.gaps.list']) assert.deepEqual(featuresForMethod(k), [], k);
  // An admin lets supervisors see pars, and takes editing away from managers.
  as('admin')('roleFeatures.save', { roleFeatures: { supervisor: { staffingPars: true }, manager: { programmingEdit: false } } });
  assert.ok(as('sup')('programming.gaps.list', { start: WED, end: WED }));
  assert.equal(svc.call(store.get('users', 'sup'), 'app.bootstrap').features.staffingPars, true, 'the apps get it in bootstrap');
  refused(() => mgr('programming.save', { name: 'x', days: [2], start: '10:00' }), 403, ROLE_OFF);
  assert.ok(as('admin')('programming.save', { id: ids.dj, name: 'DJ night', rooms: ['Cellar Bar'], days: [5, 6], start: '21:00', end: '01:00' }), 'admins always');
  assert.equal(store.get('programming', ids.dj).pars.length, 2, 'saving without pars keeps them');
});

test('View as: a role or a person sees programming exactly as they would; changes are refused', () => {
  const { store } = fixture();
  const real = store.get('users', 'owner');
  const opts = { now: () => NOW };
  const view = (ask) => { const target = resolveTarget(store, real, ask, { today: '2026-12-01' }); return { real, target, actor: viewedPerson(store, real, target) }; };
  const asEmp = view({ userId: 'bar1' });
  const r = viewCall(store, asEmp, 'programming.days.list', { start: WED, end: WED }, opts);
  assert.equal(r.canPars, false);
  assert.equal(day(r, WED).coverage, undefined);
  const asMgr = view({ userId: 'mgr' });
  assert.ok(day(viewCall(store, asMgr, 'programming.days.list', { start: WED, end: WED }, opts), WED).coverage.length > 0);
  assert.ok(viewCall(store, asMgr, 'programming.gaps.list', { start: WED, end: WED }, opts));
  for (const [m, a] of [['programming.save', { name: 'x' }], ['programming.override', { id: 'all', date: WED, action: 'cancel' }], ['programming.fillGaps', { start: WED, end: WED }], ['programming.eventPars', {}]]) {
    assert.throws(() => viewCall(store, asMgr, m, a, opts), (e) => e.status === 403 && e.message === VIEW_READ_ONLY, m);
  }
  assert.equal(store.list('shifts').length, 0, 'nothing changed');
});

// ---------- Spanish ----------

test('Spanish: errors, the day note, and the web app’s words in both languages', () => {
  assert.equal(translateError('Pick at least one day', 'es'), 'Elige al menos un día');
  assert.equal(translateError('A par is a whole number from 0 to 99', 'es'), 'Un par es un número entero del 0 al 99');
  const { store, as } = fixture();
  store.update('users', 'bar1', { language: 'es' });
  const r = as('bar1')('programming.days.list', { start: MON, end: WED });
  assert.equal(day(r, MON).autoNote, 'CERRADO');
  assert.equal(day(r, WED).autoNote, 'REGULAR SERVICE\nGLASS ROOM: IMMERSIVE DINNER 6 PM');
  assert.equal(item(day(r, WED), 'Immersive dinner').name, 'Immersive dinner', 'programming names stay as typed');
  assert.equal(es.programming.title, 'Programación');
  assert.equal(en.programming.title, 'Programming');
  assert.equal(es.roles.f_staffingPars.length > 0 && es.roles.f_programmingEdit.length > 0, true, 'Roles & features rows');
  assert.ok(es.claude.can_programming);
  const day1 = dayProgramming({ date: MON, items: [], settings: { closedDays: [1] }, lang: 'es' });
  assert.deepEqual(day1.noteLines, ['CERRADO']);
});

// ---------- the demo ----------

test('demo: regular service, an immersive dinner, DJ nights, a Saturday buyout, and some gaps', () => {
  const store = new MemoryStore();
  seedDemo(store, { now: new Date(2026, 8, 27, 12) });
  const svc = createService(store, { now: () => new Date(2026, 8, 27, 12) });
  const r = svc.call(store.get('users', 'usr_moe'), 'programming.days.list', { start: '2026-09-28', end: '2026-10-04' });
  assert.equal(r.days[0].autoNote, 'CLOSED', 'closed Mondays');
  const sat = r.days[5];
  assert.equal(item(sat, 'Immersive dinner').status, 'replaced');
  assert.ok(item(sat, 'Immersive dinner').replacedBy[0].all, 'by the wedding, a full buyout');
  assert.equal(item(r.days[2], 'Immersive dinner').status, 'on', 'Wednesday');
  assert.equal(item(r.days[4], 'DJ night').status, 'replaced', 'Friday’s party in the Rabbit Hole');
  assert.ok(r.days.some((d) => d.short > 0), 'some pars are short');
  assert.deepEqual(svc.call(store.get('users', 'usr_moe'), 'programming.list').warnings, [], 'no overlaps');
});

// ---------- the Claude connector and Ask ShiftBoard ----------

let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });
const ctxFor = (user, { scopes = [READ, WRITE] } = {}) => createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, has: () => true, scopes, via: 'claude', client: 'Test client', now: () => Date.parse('2026-09-27T18:00:00Z') });
const person = (id) => A.db.store.get('users', id);

test('tools: get_programming and get_staffing_gaps read; staff get no coverage and no gaps tool', async () => {
  const mgr = person('usr_moe'), emp = person('usr_karen');
  const got = await runTool(toolByName('get_programming'), { from: '2026-10-03', to: '2026-10-03' }, ctxFor(mgr));
  assert.equal(got.ok, true, got.error);
  const sat = got.data.days[0];
  assert.equal(sat.programming.find((x) => x.name === 'Immersive dinner').status, 'replaced');
  assert.ok(sat.coverage.some((c) => c.lines.some((l) => /^Cocktail Server|^Bartender|^Server/.test(l))));
  const staff = await runTool(toolByName('get_programming'), { from: '2026-10-03', to: '2026-10-03' }, ctxFor(emp));
  assert.equal(staff.ok, true);
  assert.equal(staff.data.days[0].coverage, undefined);
  assert.ok(staff.data.days[0].programming.every((x) => !x.pars));
  const gaps = await runTool(toolByName('get_staffing_gaps'), { from: '2026-09-28', to: '2026-10-04' }, ctxFor(mgr));
  assert.equal(gaps.ok, true);
  assert.ok(gaps.data.short > 0);
  assert.equal((await runTool(toolByName('get_staffing_gaps'), {}, ctxFor(emp))).status, 403);
  const names = (u) => visibleTools(TOOLS, u, { has: () => true, scopes: [READ, WRITE], settings: A.db.store.get('settings', 'settings') }).map((t) => t.name);
  assert.ok(names(mgr).includes('set_programming') && names(mgr).includes('get_staffing_gaps'));
  assert.ok(!names(emp).includes('set_programming') && !names(emp).includes('override_programming_for_date') && !names(emp).includes('get_staffing_gaps'));
  assert.ok(names(emp).includes('get_programming'), 'everyone reads what’s on');
});

test('tools: set_programming and override_programming_for_date preview first, then confirm saves', async () => {
  const mgr = person('usr_moe');
  const store = A.db.store;
  const count = store.list('programming').length;
  const args = { name: 'Trivia Tuesday', rooms: ['Rabbit Hole'], days: ['tue'], start: '19:00', end: '21:00', pars: [{ position: 'Bartender', count: 2 }] };
  const prev = await runTool(toolByName('set_programming'), args, ctxFor(mgr));
  assert.equal(prev.ok, true, prev.error);
  assert.match(prev.summary, /Preview only, nothing saved/);
  assert.deepEqual(prev.data.item.days, ['Tuesday']);
  assert.equal(store.list('programming').length, count, 'nothing saved');
  const done = await runTool(toolByName('set_programming'), { ...args, confirm: true }, ctxFor(mgr));
  assert.equal(done.ok, true, done.error);
  assert.equal(store.list('programming').length, count + 1);
  assert.equal(store.get('programming', done.data.id).pars[0].count, 2);
  // An overlap shows as a warning in the preview.
  const clash = await runTool(toolByName('set_programming'), { name: 'Karaoke', rooms: ['Rabbit Hole'], days: ['tue'], start: '20:00', end: '22:00' }, ctxFor(mgr));
  assert.match(clash.summary, /Overlaps Trivia Tuesday in Rabbit Hole/);
  // Override one date: preview, then confirm (logged twice: the tool's audit entry and the override's).
  const o = { programming: 'DJ night', date: '2026-10-03', action: 'cancel', reason: 'Sound system repair' };
  const p2 = await runTool(toolByName('override_programming_for_date'), o, ctxFor(mgr));
  assert.match(p2.summary, /Preview only/);
  assert.equal(store.get('programming', 'prg_demo_dj').exceptions['2026-10-03'], undefined);
  const d2 = await runTool(toolByName('override_programming_for_date'), { ...o, confirm: true }, ctxFor(mgr));
  assert.equal(d2.ok, true, d2.error);
  assert.equal(store.get('programming', 'prg_demo_dj').exceptions['2026-10-03'].cancel, true);
  assert.ok(store.list('auditLog', (x) => x.action === 'claude.override_programming_for_date').length === 1);
  assert.ok(store.list('auditLog', (x) => x.action === AUDIT.override).length >= 1);
  // A read-only connection previews but never saves; staff can't use it at all.
  assert.equal((await runTool(toolByName('set_programming'), args, ctxFor(mgr, { scopes: [READ] }))).ok, true);
  assert.equal((await runTool(toolByName('set_programming'), { ...args, confirm: true }, ctxFor(mgr, { scopes: [READ] }))).ok, false);
  assert.equal((await runTool(toolByName('set_programming'), args, ctxFor(person('usr_karen')))).status, 403);
  // Ask ShiftBoard's confirm card, in Spanish.
  const card = describeAction(toolByName('override_programming_for_date'), o, 'es', { today: '2026-09-27' });
  assert.equal(card.title, 'Cambiar la programación de un día');
  assert.ok(card.details.some(([l, v]) => l === 'Cambio' && v === 'Cancelar ese día'));
  const card2 = describeAction(toolByName('set_programming'), args, 'es', { today: '2026-09-27' });
  assert.ok(card2.details.some(([l, v]) => l === 'Días' && /mar/.test(v)));
  assert.ok(card2.details.some(([l, v]) => l === 'Personal par' && v === 'Bartender 2'));
});
