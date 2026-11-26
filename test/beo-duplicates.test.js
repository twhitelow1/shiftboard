// Duplicates when BEOs come in (core/beo-match.js, events.importBeos): identifier matches update, fuzzy ones ask a
// person (update, skip, or new: never new by default), the same BEO twice in one file is one, Import is refused until
// every possible duplicate is decided, the same file again changes nothing, and the Tripleseat sync flags a booking
// that's already here from a PDF. Invented events only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { parseBeos, beoToEvent } from '../core/beo-import.js';
import { matchEvent, compareEvents, nameSimilarity, dedupeBeos, importKey } from '../core/beo-match.js';
import { DEFAULT_RULES } from '../core/tripleseat.js';
import { beoItems } from './fixtures/beo-pdf.js';

const ev = (o) => ({ id: `evt_${Math.random().toString(36).slice(2, 8)}`, name: 'Event', date: '2027-04-10', start: '18:00', end: '22:00', room: 'Library', roomId: null, guestCount: 40, source: '', ...o });
const beo = (o) => ({ name: 'Event', date: '2027-04-10', start: '18:00', end: '22:00', room: 'Library', roomId: null, areas: 'Library', guestCount: 40, invoiceNumber: '', ...o });

test('identifiers first: the Tripleseat id, the invoice number, an earlier import', () => {
  const ts = ev({ id: 'evt_ts_777', source: 'tripleseat', externalId: '777', tripleseat: { id: '777', bookingId: '9001' }, name: 'Totally different name' });
  const pdf = ev({ id: 'evt_pdf', invoiceNumber: 'INV-1', name: 'Another name' });
  const remembered = ev({ id: 'evt_old', name: 'Spring Social', importKeys: [importKey(beo({ name: 'Spring  social', date: '2027-05-01' }))], date: '2027-05-01' });
  const all = [ts, pdf, remembered];
  assert.deepEqual([matchEvent(beo({ tripleseatId: '777', date: '2030-01-01' }), all).event.id, matchEvent(beo({ tripleseatId: '777' }), all).how], ['evt_ts_777', 'tripleseat']);
  assert.deepEqual([matchEvent(beo({ invoiceNumber: 'INV-1' }), all).event.id, matchEvent(beo({ invoiceNumber: 'INV-1' }), all).how], ['evt_pdf', 'invoice']);
  assert.equal(matchEvent(beo({ invoiceNumber: '9001' }), all).event.id, 'evt_ts_777', 'a Tripleseat BEO’s invoice # can be its booking id');
  assert.deepEqual([matchEvent(beo({ name: 'SPRING SOCIAL', date: '2027-05-01' }), all).how], ['previousImport']);
});

test('fuzzy: same day and a similar name, time or room is a possible duplicate, with reasons and a confidence', () => {
  const typed = ev({ id: 'evt_typed', name: 'Lund Wedding', start: '17:30', guestCount: 120, room: 'Full Buyout' });
  const m = matchEvent(beo({ name: 'Ferreira / Lund Wedding Reception', start: '17:00', guestCount: 118, room: 'Full Buyout', areas: 'Full Buyout' }), [typed]);
  assert.equal(m.event, undefined, 'never an automatic update');
  assert.deepEqual(m.candidates.map((c) => [c.event.id, c.confidence]), [['evt_typed', 'high']]);
  assert.deepEqual(m.candidates[0].reasons, ['sameDate', 'similarName', 'sameTime', 'sameRoom', 'sameGuests', 'typedIn']);
  // A one-letter typo in a longer word still counts; an unrelated name at the same time in the same room is a maybe.
  assert.ok(nameSimilarity('Okafor Lindqvist Wedding', 'Okafor Lindquist Wedding') >= 0.99);
  assert.equal(compareEvents(beo({ name: 'Board Dinner' }), ev({ name: 'Quarterly Board Meeting Dinner', start: '19:00', room: 'Garden Room' })).confidence, 'medium', 'similar name, overlapping time, another room');
  assert.equal(compareEvents(beo({ name: 'Garcia 50th' }), ev({ name: 'Private dinner' })).confidence, 'low', 'nothing in common but the room and the time');
});

test('must NOT match: different times in the same room, a recurring event on another day, another invoice number', () => {
  const lunch = ev({ id: 'evt_lunch', name: 'Rotary Club Lunch', start: '11:30', end: '13:30', room: 'Library' });
  const dinner = beo({ name: 'Henderson Rehearsal Dinner', start: '18:30', end: '21:30', room: 'Library' });
  assert.deepEqual(matchEvent(dinner, [lunch]).candidates, [], 'same room, same day, different times and names: two events');
  const weekly = ev({ id: 'evt_trivia_1', name: 'Tuesday Trivia Night', date: '2027-04-06', start: '19:00' });
  assert.deepEqual(matchEvent(beo({ name: 'Tuesday Trivia Night', date: '2027-04-13', start: '19:00' }), [weekly]).candidates, [], 'a recurring event next week is another event');
  const invoiced = ev({ name: 'Wine Dinner', invoiceNumber: 'A-1' });
  assert.deepEqual(matchEvent(beo({ name: 'Wine Dinner', invoiceNumber: 'B-2' }), [invoiced]).candidates, [], 'two invoice numbers: two BEOs');
  // Two seatings of the same dinner (same name, different times) are flagged, but only as a maybe.
  const first = ev({ name: 'Chef’s Wine Dinner', start: '17:00', end: '19:00' });
  assert.equal(compareEvents(beo({ name: 'Chef’s Wine Dinner', start: '20:00', end: '22:00' }), first).confidence, 'low');
});

test('the same BEO twice in one file is one: the newest stamp, else the later pages; a decision on either holds', () => {
  const a = { name: 'Gala', date: '2027-04-10', invoiceNumber: '55', beoUpdatedAt: '2027-03-01T10:00', pages: [1, 3] };
  const b = { ...a, beoUpdatedAt: '2027-03-04T09:00', pages: [4, 6] };
  const other = { name: 'Brunch', date: '2027-04-11', invoiceNumber: '', pages: [7, 8] };
  const out = dedupeBeos([b, other, a]);
  assert.deepEqual(out.map((x) => [x.name, x.beoUpdatedAt || '', (x.merged || []).length]), [['Gala', '2027-03-04T09:00', 1], ['Brunch', '', 0]]);
  assert.deepEqual(out[0].merged, [{ index: 2, pages: [1, 3], beoUpdatedAt: '2027-03-01T10:00' }]);
  const noStamp = dedupeBeos([{ name: 'Gala', date: '2027-04-10', pages: [1, 2] }, { name: 'GALA', date: '2027-04-10', pages: [3, 4], guestCount: 90 }]);
  assert.deepEqual([noStamp.length, noStamp[0].pages, noStamp[0].guestCount], [1, [3, 4], 90], 'printed twice: the later pages');
  const decided = dedupeBeos([{ ...a, decision: { action: 'skip' } }, b]);
  assert.deepEqual(decided[0].decision, { action: 'skip' });
});

function restaurant() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Copper Fox', rooms: ['Main Dining', 'Garden Room', 'Cellar Bar', 'Full Buyout'] });
  store.insert('users', { id: 'usr_mgr', name: 'mgr', role: 'manager', jobCodes: [], active: true });
  const svc = createService(store, { now: () => new Date('2026-11-30T10:00:00') });
  const mgr = (method, args) => svc.call(store.get('users', 'usr_mgr'), method, args);
  const payload = (evs) => evs.map((e) => beoToEvent(e, { room: e.areas }));
  return { store, svc, mgr, payload };
}

test('Import is refused until every possible duplicate is decided; skip, update and new each do what they say', () => {
  const { store, mgr, payload } = restaurant();
  const typed = mgr('events.save', { name: 'Northside Robotics Holiday Party', date: '2026-12-05', start: '18:00', end: '23:00', room: 'Cellar Bar', guestCount: 55, status: 'confirmed' });
  const evs = payload(parseBeos(beoItems()));
  const list = evs.map((e) => ({ ...e, invoiceNumber: '' }));
  const dry = mgr('events.importBeos', { events: list, dryRun: true }).events;
  assert.deepEqual(dry.map((x) => x.status), ['new', 'duplicate', 'new']);
  assert.equal(dry[1].candidates[0].id, typed.id);
  assert.throws(() => mgr('events.importBeos', { events: list }), /Decide what to do with each possible duplicate first/);
  assert.equal(store.list('events').length, 1, 'nothing saved, not even the new ones');
  // Skip: nothing happens to it.
  const skipped = mgr('events.importBeos', { events: list.map((e, i) => (i === 1 ? { ...e, decision: { action: 'skip' } } : e)), dryRun: true }).events;
  assert.equal(skipped[1].status, 'skipped');
  // New: an explicit choice creates a second event.
  const asNew = mgr('events.importBeos', { events: [{ ...list[1], decision: { action: 'new' } }], dryRun: true }).events[0];
  assert.equal(asNew.status, 'new');
  // Update: the chosen event takes the BEO.
  const done = mgr('events.importBeos', { events: list.map((e, i) => (i === 1 ? { ...e, decision: { action: 'update', id: typed.id } } : e)) }).events;
  assert.deepEqual(done.map((x) => x.status), ['new', 'update', 'new']);
  assert.equal(done[1].id, typed.id);
  assert.equal(store.list('events').length, 3);
  assert.equal(store.get('events', typed.id).guestCount, 60);
});

test('re-importing the same file changes nothing: every BEO is the same event, nothing is written', () => {
  const { store, mgr, payload } = restaurant();
  const list = payload(parseBeos(beoItems()));
  mgr('events.importBeos', { events: list });
  const before = JSON.stringify(store.list('events'));
  const again = mgr('events.importBeos', { events: list }).events;
  assert.deepEqual(again.map((x) => [x.status, x.match.how]), [['same', 'invoice'], ['same', 'invoice'], ['same', 'invoice']]);
  assert.equal(JSON.stringify(store.list('events')), before);
  // The same file holding one BEO twice: one event, the other copy merged.
  const twice = mgr('events.importBeos', { events: [list[0], list[1], list[0]], dryRun: true }).events;
  assert.deepEqual(twice.map((x) => x.status), ['merged', 'same', 'same']);
});

test('Tripleseat ↔ PDF: a PDF of a synced booking asks first; a booking synced after its PDF is flagged on the Tripleseat side', () => {
  const { store, svc, mgr, payload } = restaurant();
  const [rivera, northside] = payload(parseBeos(beoItems()));
  // PDF → an event Tripleseat already synced (no invoice number on it): a possible duplicate from Tripleseat.
  const sync = (raw) => svc.tripleseat.applyEvent(raw, { timeZone: 'America/Denver', rules: DEFAULT_RULES });
  const raw = (id, name, date, start, end, room) => ({ id, name, event_start: `${date.slice(5, 7)}/${date.slice(8)}/${date.slice(0, 4)} ${start}`, event_end: `${date.slice(5, 7)}/${date.slice(8)}/${date.slice(0, 4)} ${end}`,
    guest_count: 24, status: 'DEFINITE', rooms: [{ id: 11, name: room }], location_id: 1, booking_id: 600 + id, updated_at: '11/20/2026 09:15 AM' });
  sync(raw(4321, 'Rivera Rehearsal', '2026-12-04', '07:00 PM', '10:00 PM', 'Main Dining'));
  const ask = mgr('events.importBeos', { events: [{ ...rivera, invoiceNumber: '' }], dryRun: true }).events[0];
  assert.deepEqual([ask.status, ask.candidates[0].id, ask.candidates[0].reasons.includes('fromTripleseat')], ['duplicate', 'evt_ts_4321', true]);
  // Tripleseat → an event already here from a PDF: added (the sync can't ask) and flagged for the events team.
  mgr('events.importBeos', { events: [northside] });
  const r = sync(raw(4400, 'Northside Robotics Holiday Party & Awards', '2026-12-05', '06:00 PM', '11:00 PM', 'Cellar Bar'));
  assert.equal(r.action, 'added');
  const flag = store.get('events', 'evt_ts_4400').tripleseat.review[0];
  assert.deepEqual([flag.code, flag.otherName], ['possibleDuplicate', 'Northside Robotics Holiday Party & Awards Night']);
  // A booking on another day isn't.
  sync(raw(4500, 'Northside Robotics Holiday Party & Awards', '2027-12-04', '06:00 PM', '11:00 PM', 'Cellar Bar'));
  assert.deepEqual(store.get('events', 'evt_ts_4500').tripleseat.review, []);
});
