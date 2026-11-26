// A BEO's details as sections (core/beo-sections.js, core/beo-import.js): everything the BEO says lands somewhere
// (nothing non-financial lost), money never does, only sections with something in them show, staff don't see the
// client's contact or anyone's phone and email, a manager's edit wins over the BEO's copy, and a re-import says what
// changed section by section. The PDF is test/fixtures/beo-sections-pdf.js: one invented BEO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { parseBeos, matchRooms, beoToEvent, cleanBeoEvent, cleanSections, mergeBeo } from '../core/beo-import.js';
import { eventSections, visibleSections, sectionChanges, sectionKeyFor, redactContacts, sectionsFound, SECTION_KEYS } from '../core/beo-sections.js';
import { sectionsBeoItems } from './fixtures/beo-sections-pdf.js';

const parse = (o) => parseBeos(sectionsBeoItems(o))[0];
const keys = (list) => list.map((s) => (s.key === 'other' ? `other:${s.title}` : s.key));

test('every part of the BEO lands in a section, in order: timeline, menu, dietary, bar … other', () => {
  const e = parse();
  assert.deepEqual(keys(eventSections(e)), ['timeline', 'menu', 'dietary', 'bar', 'setup', 'rentals', 'av', 'decor', 'vendors', 'arrival', 'instructions', 'contacts', 'other:PHOTO BOOTH', 'other:FOOD']);
  const by = Object.fromEntries(eventSections(e).map((s) => [s.key === 'other' ? s.title : s.key, s]));
  // the run of show
  assert.equal(by.timeline.kind, 'timeline');
  assert.deepEqual(by.timeline.items.map((x) => `${x.time} ${x.text}`), ['14:00 Vendor load-in', '18:00 Guest Arrival', '19:00 Dinner Service Begins', '20:30 Toasts', '22:30 Last call', '23:00 End of Event']);
  // the menu, with its dietary marks; the dietary counts as their own (prominent) section
  assert.deepEqual(by.menu.items.filter((m) => m.dietary).map((m) => [m.item, m.dietary]), [['Spring Pea Soup', ['GF', 'V']], ['Halibut', ['GF', 'DF']]]);
  assert.deepEqual(by.dietary.items, ['Gluten free - 5 guests', 'Nut allergy - table 4', 'Vegan - 2 guests']);
  // the bar: package, bar, and the special drink with its recipe (its price taken off)
  assert.deepEqual(by.bar.items.map((x) => x.labelKey || x.label), ['package', 'bar', 'Garden Spritz']);
  assert.equal(by.bar.items[2].value, '1.5 oz gin\nTop with soda\nCollins Glass');
  // rentals, an unknown DECOR table (→ decor), ENTERTAINMENT (→ A/V), a heading nobody knows (→ other, as written)
  assert.deepEqual(by.rentals.items, ['Grand Hall - Private Event: 80 Guests', 'Lounge furniture on the terrace']);
  assert.deepEqual([by.decor.title, by.decor.items], ['DECOR', ['Ivory linens, floor length', 'Centerpieces: white peonies (Florist Example)']]);
  assert.deepEqual([by.av.title, by.av.items.length], ['ENTERTAINMENT', 2]);
  assert.deepEqual(by['PHOTO BOOTH'].items, ['Booth on the terrace, props provided']);
  // vendors: names and arrival times (their phone and email follow the client-details rule, below)
  assert.deepEqual(by.vendors.items, ['Florist: Florist Example, arrives 1:00 pm, 555-010-6001', 'Photographer: Lens Sample, lens@photo.example']);
  assert.deepEqual(by.setup.items, ['• Rounds of 8, head table by the windows', 'Floorplans:', 'Stage at the north wall']);
  // a line no part of the reader carried (a course heading with nothing under it) is kept under its heading
  assert.deepEqual(by.FOOD.items, ['LATE NIGHT SNACK TBD']);
  // the existing fields are as they were: the BEO's sections mirror setupNotes and contactNotes
  assert.ok(e.setupNotes.includes('DECOR:\nIvory linens, floor length'));
  assert.deepEqual([e.name, e.date, e.start, e.end, e.guestCount, e.type, e.location], ['Marlowe Foundation Spring Gala', '2027-03-13', '18:00', '23:00', 80, 'Gala', 'Marlowe House']);
  assert.deepEqual(sectionsFound(e).find((s) => s.key === 'menu'), { key: 'menu', title: '', count: 3 });
});

test('money never comes through: not in the fields, not in any section, whatever the browser (or the AI) sends', () => {
  const e = parse();
  const all = JSON.stringify({ ...e, fbMinimum: 0 });
  for (const word of ['$', 'fee', 'Fee', 'Deposit', '4242', 'Gratuity', 'Subtotal', '10,795', 'Client Signature', 'Visa']) assert.ok(!all.includes(word), word);
  // The server's cleaning of sections: money lines, money titles, card digits, unknown keys and kinds.
  const clean = cleanSections([
    { key: 'decor', title: 'DECOR', kind: 'list', items: ['Gold chargers $2.00', 'Linen fee', 'Card 4111 1111 1111 1111', 'Ivory napkins', '', 42] },
    { key: 'other', title: 'TOTALS', kind: 'keyvalue', items: [{ label: 'Food', value: '$2,000' }] },
    { key: 'other', title: 'Payment schedule', kind: 'text', items: ['50% deposit due'] },
    { key: 'bar', title: 'BAR', kind: 'keyvalue', items: [{ label: 'Deposit', value: '500' }, { label: 'Package', value: 'Beer & wine' }, { labelKey: 'nope', label: 'Wine', value: 'House red $12 per glass\nHouse white' }] },
    { key: 'hacker', title: 'Notes', kind: 'html', items: ['<b>Valet</b> at 5'], from: ['setupNotes', 'password'] },
    { key: 'timeline', title: 'Run', kind: 'timeline', items: [{ time: '18:00', text: 'Doors' }, { time: '25:00', text: 'Bad' }, { time: '19:00', text: 'Collect the balance due' }] },
  ]);
  assert.deepEqual(clean, [
    { key: 'decor', title: 'DECOR', kind: 'list', items: ['Gold chargers', 'Ivory napkins'] },
    { key: 'bar', title: 'BAR', kind: 'keyvalue', items: [{ label: 'Package', value: 'Beer & wine' }, { label: 'Wine', value: 'House white' }] },
    { key: 'other', title: 'Notes', kind: 'text', items: ['<b>Valet</b> at 5'], from: ['setupNotes'] },
    { key: 'timeline', title: 'Run', kind: 'timeline', items: [{ time: '18:00', text: 'Doors' }] },
  ]);
  assert.ok(!JSON.stringify(cleanBeoEvent({ name: 'X', date: '2027-01-01', sections: [{ key: 'notes', items: ['Tip jar on the bar', 'Grand total $9,000'] }] }).sections).includes('$'));
});

test('display only what’s known: no empty sections, no empty labels, no placeholders', () => {
  assert.deepEqual(eventSections({ name: 'Bare', date: '2027-01-01', menu: [], timeline: [], beverage: { package: '', bar: '', notes: '' }, specialDrinks: [], setupNotes: '', dietaryNotes: ' ', notes: '' }), []);
  const only = eventSections({ dietaryNotes: '2 vegan\n\n', beverage: { package: '', bar: 'Main bar', notes: '' }, timeline: [{ time: '', item: 'No time yet' }, { time: '18:00', item: '' }],
    beoSections: [{ key: 'decor', title: 'DECOR', kind: 'list', items: ['', ' '] }, { key: 'signatures', kind: 'keyvalue', items: [{ labelKey: 'signed', value: '' }] }] });
  assert.deepEqual(only, [
    { key: 'dietary', title: '', kind: 'list', items: ['2 vegan'] },
    { key: 'bar', title: '', kind: 'keyvalue', items: [{ labelKey: 'bar', value: 'Main bar' }] },
  ]);
  for (const k of ['timeline', 'menu', 'dietary', 'contacts', 'other']) assert.ok(SECTION_KEYS.includes(k));
});

test('staff see the operational sections; the client’s contact and every phone number and email are for managers and the events team', () => {
  const e = parse();
  const staff = visibleSections(e, { client: false });
  const team = visibleSections(e, { client: true });
  assert.ok(!keys(staff).includes('contacts') && keys(team).includes('contacts'));
  for (const k of ['timeline', 'menu', 'dietary', 'bar', 'setup', 'vendors', 'instructions']) assert.ok(keys(staff).includes(k), k);
  const text = JSON.stringify(staff);
  assert.ok(!/555-010|@/.test(text), 'no phone numbers or emails anywhere for staff');
  assert.deepEqual(staff.find((s) => s.key === 'vendors').items, ['Florist: Florist Example, arrives 1:00 pm', 'Photographer: Lens Sample']);
  assert.deepEqual(team.find((s) => s.key === 'contacts').items.slice(0, 4).map((x) => x.labelKey), ['client', 'contact', 'phone', 'email']);
  assert.equal(redactContacts('Call (555) 010-3000 or x@y.example, set at 5:30 - 7:00 for 120'), 'Call or , set at 5:30 - 7:00 for 120');
  assert.equal(redactContacts('Rounds of 8'), 'Rounds of 8');
});

function restaurant() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test House', rooms: ['Grand Hall', 'Terrace'] });
  for (const [id, role, extra] of [['usr_mgr', 'manager'], ['usr_emp', 'employee'], ['usr_ev', 'employee', { eventsAccess: true }]]) {
    store.insert('users', { id, name: id.slice(4), role, jobCodes: [{ jobCodeId: 'job_srv' }], active: true, ...extra });
  }
  store.insert('jobCodes', { id: 'job_srv', name: 'Server', short: 'SRV', order: 0 });
  const svc = createService(store, { now: () => new Date('2027-03-01T10:00:00') });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  const payload = (evs) => evs.map((e) => { const m = matchRooms(e.areas, [], ['Grand Hall', 'Terrace']); return beoToEvent(e, { room: m.room || e.areas }); });
  return { store, mgr: as('usr_mgr'), emp: as('usr_emp'), ev: as('usr_ev'), payload };
}

test('the event page’s data: staff get the BEO’s sections without the client contact or anyone’s phone and email; the events team gets all', () => {
  const { mgr, emp, ev, payload } = restaurant();
  const id = mgr('events.importBeos', { events: payload([parse()]) }).events[0].id;
  const staffView = emp('events.get', { id });
  assert.ok(!staffView.beoSections.some((s) => s.key === 'contacts'));
  assert.ok(!/555-010|@/.test(JSON.stringify(staffView)), 'nowhere in what staff are sent');
  assert.deepEqual(staffView.beoEdited, []);
  assert.equal(staffView.beoPrints, undefined);
  assert.equal(staffView.importKeys, undefined);
  assert.deepEqual(keys(visibleSections(staffView, { client: false })), ['timeline', 'menu', 'dietary', 'bar', 'setup', 'rentals', 'av', 'decor', 'vendors', 'arrival', 'instructions', 'other:PHOTO BOOTH', 'other:FOOD']);
  const teamView = ev('events.get', { id });
  assert.ok(teamView.beoSections.some((s) => s.key === 'contacts'));
  assert.ok(JSON.stringify(visibleSections(teamView, { client: true })).includes('555-010-6001'));
});

test('a manager’s edit wins: once setupNotes is edited, the field shows and the BEO’s setup, rentals and decor don’t', () => {
  const { mgr, emp, payload } = restaurant();
  const id = mgr('events.importBeos', { events: payload([parse()]) }).events[0].id;
  const e = mgr('events.get', { id });
  mgr('events.save', { ...e, setupNotes: 'Rounds of 10 now\nNo stage' });
  const after = emp('events.get', { id });
  assert.deepEqual(after.beoEdited, ['setupNotes']);
  const shown = visibleSections(after, { client: false });
  assert.deepEqual(shown.find((s) => s.key === 'setup').items, ['Rounds of 10 now', 'No stage']);
  assert.ok(!keys(shown).some((k) => ['rentals', 'decor', 'av', 'other:PHOTO BOOTH'].includes(k)), 'the BEO copies of setupNotes step aside');
  assert.ok(keys(shown).includes('other:FOOD') && keys(shown).includes('vendors'), 'sections from other fields stay');
});

test('re-importing updates the BEO section by section, says what changed, and keeps what managers added', () => {
  const { store, mgr, payload } = restaurant();
  const id = mgr('events.importBeos', { events: payload([parse()]) }).events[0].id;
  const e = mgr('events.get', { id });
  mgr('events.save', { ...e, attire: 'All black', notes: 'Manager note', staffing: [{ jobCodeId: 'job_srv', count: 4, start: '17:00' }] });
  // The same PDF again: nothing to do, nothing written.
  const before = JSON.stringify(store.get('events', id));
  assert.equal(mgr('events.importBeos', { events: payload([parse()]) }).events[0].status, 'same');
  assert.equal(JSON.stringify(store.get('events', id)), before, 're-importing the same file changes nothing');
  // A newer BEO: 90 guests, one more gluten free, other linens, no photo booth.
  const next = payload([parse({ guests: '90', stamp: '03/05/2027 9:00 am', dietary: '- Gluten free - 6 guests', decor: 'Sage linens, floor length', noPhoto: true })]);
  const dry = mgr('events.importBeos', { events: next, dryRun: true }).events[0];
  assert.equal(dry.status, 'update');
  assert.ok(['guestCount', 'dietaryNotes', 'setupNotes', 'sections'].every((c) => dry.changes.includes(c)), dry.changes.join());
  assert.deepEqual(dry.sectionChanges, [
    { key: 'dietary', title: '', change: 'changed' },
    { key: 'decor', title: 'DECOR', change: 'changed' },
    { key: 'other', title: 'PHOTO BOOTH', change: 'removed' },
  ]);
  mgr('events.importBeos', { events: next });
  const after = store.get('events', id);
  assert.deepEqual([after.guestCount, after.attire, after.notes, after.staffing.length], [90, 'All black', 'Manager note', 1]);
  assert.ok(!after.beoSections.some((s) => s.title === 'PHOTO BOOTH'));
  assert.deepEqual(after.beoSections.find((s) => s.key === 'decor').items[0], 'Sage linens, floor length');
  assert.deepEqual(sectionChanges(e, e), []);
});

test('an event from Tripleseat keeps Tripleseat’s booking; the BEO adds its sections', () => {
  const b = cleanBeoEvent(beoToEvent(parse()));
  const ts = { id: 'evt_ts_1', source: 'tripleseat', name: 'Spring Gala', date: '2027-03-13', start: '18:30', end: '22:00', guestCount: 75, guaranteed: 72, status: 'confirmed', room: 'Terrace', roomId: null };
  const { doc } = mergeBeo(ts, b);
  assert.deepEqual([doc.name, doc.start, doc.end, doc.guestCount, doc.guaranteed, doc.room], ['Spring Gala', '18:30', '22:00', 75, 72, 'Terrace']);
  assert.ok(doc.beoSections.some((s) => s.key === 'decor') && doc.menu.length === 3);
});

test('headings to sections', () => {
  assert.deepEqual(['DECOR', 'Floral', 'ENTERTAINMENT', 'Valet & Coat Check', 'Run of Show', 'Kitchen Notes', 'STAFFING', 'LOUNGE FURNITURE', 'PHOTO BOOTH'].map(sectionKeyFor),
    ['decor', 'decor', 'av', 'parking', 'timeline', 'kitchen', 'staffing', 'rentals', 'other']);
});
