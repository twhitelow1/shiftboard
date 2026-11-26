// Import BEOs from a PDF (core/beo-import.js, events.importBeos): splitting a PDF of back-to-back BEOs,
// reading each one, keeping money out, matching rooms, re-imports that update instead of duplicating,
// permissions and the plan's Events feature. The PDF is test/fixtures/beo-pdf.js: invented BEOs laid out
// the way pdf.js reads a Tripleseat export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { parseBeos, matchRooms, beoToEvent, cleanBeoEvent, mergeBeo, isFinancial, parseTimeRange, parseTime, dietaryMarks } from '../core/beo-import.js';
import { featureForMethod, PLANS } from '../server/platform/plans.js';
import { beoItems } from './fixtures/beo-pdf.js';

const parsed = (o) => parseBeos(beoItems(o));

// ---------- reading the PDF ----------

test('splits back-to-back BEOs where the footer restarts at "1 of", with wrapped names and dates', () => {
  const evs = parsed();
  assert.equal(evs.length, 3);
  assert.deepEqual(evs.map((e) => e.pages), [[1, 3], [4, 5], [6, 11]]);
  assert.deepEqual(evs.map((e) => e.name), ['Rivera Rehearsal Dinner', 'Northside Robotics Holiday Party & Awards Night', 'Okafor Lindqvist Wedding']);
  assert.deepEqual(evs.map((e) => e.date), ['2026-12-04', '2026-12-05', '2026-12-06'], 'the long date, also when it wraps ("Saturday, December 5," / "2026")');
  assert.deepEqual(evs.map((e) => e.invoiceNumber), ['10000001', '10000002', '10000003']);
  assert.deepEqual(evs.map((e) => e.beoUpdatedAt), ['2026-11-28T14:15', '2026-11-29T09:05', '2026-11-20T16:40'], 'the "Updated:" stamp with its time');
  assert.deepEqual(evs.map((e) => e.warnings), [[], [], []]);

  // Without the footers, the BEO header (INVOICE # / BANQUET EVENT ORDER) still starts each event.
  const noFooters = beoItems().filter((i) => !/^\d+ of \d+/.test(i.str));
  assert.deepEqual(parseBeos(noFooters).map((e) => e.pages), [[1, 3], [4, 5], [6, 11]]);
  // A page missing from the 6-page BEO is flagged.
  const missing = parseBeos(beoItems().filter((i) => i.page !== 9));
  assert.deepEqual(missing[2].warnings, [{ code: 'pagesMissing', found: 5, expected: 6 }]);
});

test('the event summary: the row on the BEO’s date is the event, other rows are kept as other dates', () => {
  const [rivera, northside, okafor] = parsed();
  assert.deepEqual([rivera.start, rivera.end, rivera.guestCount, rivera.areas, rivera.fbMinimum], ['19:00', '22:00', 24, 'Main Dining and Garden Room', 1800]);
  assert.deepEqual(rivera.otherDates, [{ date: '2026-09-10', start: '18:00', end: '20:00', areas: 'Main Dining Large Party', guestCount: 4, type: '' }]);
  assert.deepEqual([northside.start, northside.end, northside.guestCount, northside.type, northside.areas], ['18:00', '23:00', 60, 'Holiday Party', 'Cellar Bar']);
  assert.deepEqual([okafor.start, okafor.end, okafor.guestCount, okafor.areas, okafor.otherDates], ['16:00', '22:00', 120, 'Copper Fox Full Buyout', []]);
  assert.deepEqual(parsed().map((e) => e.serviceStyle), ['family', 'plated', 'stations']);
});

test('the header: client contact in the private client fields, sales and event managers', () => {
  const [rivera, northside] = parsed();
  assert.deepEqual(
    [rivera.client, rivera.contactName, rivera.contactEmail, rivera.contactPhone, rivera.salesManager, rivera.eventManager],
    ['Jordan Rivera', 'Jordan Rivera', 'jordan.rivera@example.com', '555-010-2000', 'Pat Example', 'Sam Planner'],
    'the client’s EMAIL on the left, not the sales manager’s on the right',
  );
  assert.equal(northside.contactPhone, '(555) 010-3000');
  assert.equal(northside.eventManager, '');
});

test('the menu: headings, dishes with descriptions, quantities and dietary marks; placeholders skipped', () => {
  const [rivera, northside, okafor] = parsed();
  assert.deepEqual(rivera.menu, [
    { course: '', item: 'FAMILY STYLE DINNER', notes: 'Serve Time: 7:30 pm / Set: ROOM · *Choice of (2) starters, (2) mains and (1) dessert for each table', qty: 24 },
    { course: 'FIRST COURSE', item: 'HEIRLOOM BEET SALAD', notes: 'whipped feta, blood orange, toasted pistachio, honey and white balsamic vinaigrette' },
    { course: 'FIRST COURSE', item: 'Charred Carrots', notes: '', dietary: ['GF', 'V'] },
    { course: 'MAIN COURSE', item: 'BRAISED SHORT RIB', notes: 'creamy polenta, gremolata, red wine jus' },
    { course: 'MAIN COURSE', item: 'SEARED SALMON', notes: 'Additional Entree Selection · lemon beurre blanc, shaved fennel', qty: 24 },
    { course: 'DESSERT COURSE', item: 'Chocolate Torte', notes: '', dietary: ['Contains Nuts'] },
  ]);
  assert.ok(!JSON.stringify(rivera.menu).includes('XXX'), 'Menu Heading: XXX is a placeholder');
  assert.deepEqual(northside.menu.map((m) => [m.course, m.item, m.notes]), [
    ['', 'PLATED STYLE DINNER', 'Serve Time: 7:00PM / Set: Cellar Bar'],
    ['Course 1', '“Winter Greens”', 'Pear, Candied Walnut, Blue Cheese'],
    ['Course 2', 'Roast Chicken', 'Root Vegetables, Thyme Jus'],
  ]);
  const byItem = Object.fromEntries(okafor.menu.map((m) => [m.item, m]));
  assert.deepEqual(byItem['Tuna Crudo'], { course: 'PASSED APPETIZERS', item: 'Tuna Crudo', notes: '', qty: 120, dietary: ['GF', 'DF'] });
  assert.equal(byItem['Grazing Stations'].notes, 'Serve Time: 5:00 - 7:00PM / Location: Main Dining, & Cellar Bar', 'a wrapped line continues its note');
  assert.equal(byItem['Chef Attended Station: Herb Roast Beef Carving'].notes, 'Set by: 5:00pm – 7:00pm / Room: Main Dining · Includes: horseradish cream, soft rolls · 2 carving stations', 'the chef fee lines are gone');
  assert.equal(byItem['Roasted Squash'].notes, 'Served with the Carving Station', 'a bold note after the dish name');
  assert.equal(byItem['Lemon Tart'].course, 'DESSERT DISPLAY');
  assert.deepEqual([byItem['Vendor Meal'].course, byItem['Vendor Meal'].qty], ['', 4]);
  assert.deepEqual(dietaryMarks('Roasted Beets (gf, DF, Contains Nuts)'), { item: 'Roasted Beets', dietary: ['GF', 'DF', 'Contains Nuts'] });
  assert.deepEqual(dietaryMarks('Ravioli (house made)'), { item: 'Ravioli (house made)', dietary: [] }, 'only real dietary marks come off');
});

test('beverage: package, bar, notes, and special drinks with their recipes', () => {
  const [rivera, northside, okafor] = parsed();
  assert.deepEqual(rivera.beverage, { package: 'On-Consumption Tab (Available: 7:00 pm – 10:00 pm)', bar: '', notes: 'Host covers guest drinks / Full drink menu available' });
  assert.deepEqual(northside.specialDrinks, [
    { name: 'Snowfall Spritz', recipe: '1.5 oz gin\n.5 oz elderflower liqueur\nTop with prosecco\nCoupe Glass', notes: 'gin, elderflower, prosecco' },
    { name: 'Signature Cocktail #2', recipe: '', notes: '' },
  ]);
  assert.equal(northside.beverage.package, 'Cash Bar');
  assert.deepEqual(okafor.beverage, { package: 'Premium Package Open Bar (Available: 4:00 - 10:00)', bar: 'Main Dining, Cellar Bar', notes: 'Passed - Serve Time: 4:00 - 4:30PM\nSparkling wine on arrival' });
  assert.deepEqual(okafor.specialDrinks, [{ name: 'Signature Cocktail #1 - Fox Old Fashioned', recipe: '', notes: '', qty: 120 }]);
});

test('the timeline: times and ranges, the bar’s HOURS, am/pm from the rows before; XX:XX placeholders skipped', () => {
  const [rivera, northside, okafor] = parsed();
  assert.deepEqual(rivera.timeline, [
    { time: '18:30', item: 'Venue Open for Setup' }, { time: '19:00', item: 'Guest Arrival' }, { time: '19:00', end: '22:00', item: 'Bar Opens' },
    { time: '19:30', item: 'Food Service Begins' }, { time: '22:00', item: 'End of Event' }, { time: '22:30', item: 'Venue Available for Clean Up' },
  ], 'XX:XX Toasts is skipped, and the “additional charges” line too');
  assert.deepEqual(northside.timeline.map((x) => `${x.time} ${x.item}`), ['17:30 Venue Open for Setup', '18:00 Guest Arrival', '19:00 Dinner Service Begins', '21:00 Awards', '23:00 End of Event']);
  assert.deepEqual(okafor.timeline, [
    { time: '13:00', item: 'Venue Open for Setup' }, { time: '16:00', item: 'Guest Arrival' }, { time: '16:00', end: '22:00', item: 'Bar Opens' },
    { time: '16:00', end: '17:00', item: 'Passed Beverages & Apps Upon Arrival: Apps; Sparkling wine' },
    { time: '17:00', end: '19:00', item: 'Dinner Service Begins' }, { time: '19:20', item: 'First Dance' }, { time: '20:00', item: 'Cake Cutting' }, { time: '22:00', item: 'End of Event' },
  ], '"60" is not a time');
  assert.deepEqual(parseTimeRange('5:30 pm – 12:00 am'), { start: '17:30', end: '00:00' });
  assert.deepEqual(parseTimeRange('11 - 2 pm'), { start: '11:00', end: '14:00' });
  assert.equal(parseTimeRange('XX:XX - XX:XX'), null);
  assert.equal(parseTime('7:20', '19:00'), '19:20');
  assert.equal(parseTime('60'), '');
});

test('notes: arrival, dietary, host and vendor contacts, setup, special instructions, A/V', () => {
  const [rivera, northside, okafor] = parsed();
  assert.equal(rivera.arrivalNotes, 'Side door entrance / Hand out welcome cards');
  assert.equal(rivera.dietaryNotes, '', 'an empty bullet list');
  assert.equal(rivera.contactNotes, 'On-Site Contact: Jordan Rivera 555-010-2000');
  assert.equal(rivera.setupNotes, 'Garden Room - Private Room: 24 Guests\nLong family tables, candles only\nFloorplans:\nTwo tables of twelve');
  assert.equal(northside.dietaryNotes, '• Vegetarian - 4 guests\n• Shellfish allergy - 1 guest');
  assert.equal(northside.specialInstructions, 'Projector needed for the awards slideshow');
  assert.equal(okafor.arrivalNotes, 'Guests arrive by shuttle at the front door');
  assert.equal(okafor.dietaryNotes, '- Gluten Free - 6 People\n- Nut allergy - 2 people');
  assert.equal(okafor.contactNotes, 'Host/ Event Contact Details\n• Riley Okafor & Sam Lindqvist\n• 555 - 010 - 4001\nVendor Contact Details\n• Florist: Petal Example 555-010-5000');
  assert.equal(okafor.setupNotes, 'Copper Fox FULL Venue Buyout\nIncludes: All rooms, house tables and chairs\n• Garden Room\n◦ lounge seating, remove two tables', 'an empty Floorplans: label is left out');
  assert.equal(okafor.specialInstructions, 'Couple arrives at 4:45 for photos in the garden\nShuttle drop-off at the front door every 20 minutes');
  assert.equal(okafor.avNotes, 'DJ Information: DJ Example\nSet Time: 6:00-10:00PM\nMicrophone for toasts');
});

test('money never comes through: prices, totals, fees, deposits, card digits and payment notes', () => {
  const evs = parsed();
  const text = JSON.stringify(evs.map(({ fbMinimum, ...e }) => e));
  assert.ok(!text.includes('$'), 'no prices');
  for (const word of ['4242', '1111', '9876', 'Deposit', 'Gratuity', 'Tax Rate', 'Grand Total', 'Amount Due', 'Subtotal', 'Fee', 'fee', 'CC on file', 'Discounted', 'Minimum', 'waived', 'Invoice', 'Per Hour', '1st Hour', 'Card on file', 'Client Signature']) {
    assert.ok(!text.includes(word), word);
  }
  // Only the F&B minimum and the guest count are kept.
  assert.deepEqual(evs.map((e) => [e.fbMinimum, e.guestCount]), [[1800, 24], [4000, 60], [15000, 120]]);
  assert.ok(isFinancial('Non-Refundable 50% Deposit (Credit Card 1234 Visa)'));
  assert.ok(isFinancial('card 4111 1111 1111 1111'));
  assert.ok(isFinancial('Visa ending in 4242'));
  assert.ok(!isFinancial('2 drink tickets per person'));
  assert.ok(!isFinancial('Toffee Martini'));

  // The server cleans what the browser sends again: unknown fields, prices, card numbers and payment lines go.
  const b = cleanBeoEvent({
    name: 'Gala $500', date: '2026-12-31', start: '19:00', guestCount: '80', deposit: 5000, estRevenue: 99999, cardNumber: '4111111111111111', payment: { last4: '4242' },
    contactPhone: '4111 1111 1111 1111', contactEmail: 'not an email', fbMinimum: '2500.5',
    menu: [{ course: 'Main', item: 'Steak $45', notes: 'Paid in full · medium rare' }],
    setupNotes: 'Round tables\nDeposit paid with Visa 4242\nCard 4111-1111-1111-1111',
    specialDrinks: [{ name: 'Spritz $14', recipe: '1 oz aperol\nCharge $14 per drink' }],
    timeline: [{ time: '19:00', item: 'Doors' }, { time: '25:00', item: 'Bad time' }, { time: '20:00', item: 'Collect balance due' }],
  });
  assert.ok(!('deposit' in b) && !('estRevenue' in b) && !('cardNumber' in b) && !('payment' in b));
  assert.deepEqual([b.name, b.contactPhone, b.contactEmail, b.fbMinimum, b.guestCount], ['Gala', '', '', 2500.5, 80]);
  assert.deepEqual(b.menu, [{ course: 'Main', item: 'Steak', notes: 'medium rare' }]);
  assert.equal(b.setupNotes, 'Round tables');
  assert.deepEqual(b.specialDrinks, [{ name: 'Spritz', recipe: '1 oz aperol', notes: '', batch: '' }]);
  assert.deepEqual(b.timeline, [{ time: '19:00', item: 'Doors' }]);
});

test('without font information (no bold or italic) the BEOs still read', () => {
  const evs = parsed({ bold: false });
  assert.deepEqual(evs.map((e) => [e.name, e.date, e.start, e.guestCount]), [
    ['Rivera Rehearsal Dinner', '2026-12-04', '19:00', 24], ['Northside Robotics Holiday Party & Awards Night', '2026-12-05', '18:00', 60], ['Okafor Lindqvist Wedding', '2026-12-06', '16:00', 120],
  ]);
  assert.ok(!JSON.stringify(evs.map(({ fbMinimum, ...e }) => e)).includes('$'));
});

// ---------- rooms ----------

test('room matching: venue rooms in the order written, bookings like Full Buyout, or none', () => {
  const rooms = [{ id: 'r_main', name: 'Main Dining' }, { id: 'r_garden', name: 'Garden Room' }, { id: 'r_cellar', name: 'Cellar Bar' }, { id: 'r_lib', name: 'The Library' }];
  const names = ['Main Dining', 'Garden Room', 'Cellar Bar', 'The Library', 'Full Buyout'];
  assert.deepEqual(matchRooms('Cellar Bar', rooms, names), { roomId: 'r_cellar', room: 'Cellar Bar', how: 'one', matches: ['Cellar Bar'] });
  assert.deepEqual(matchRooms('Main Dining and Garden Room', rooms, names), { roomId: 'r_main', room: 'Main Dining', how: 'several', matches: ['Main Dining', 'Garden Room'] });
  assert.deepEqual(matchRooms('The Garden Room, Main Dining ; Chef’s Table', rooms, names).matches, ['Garden Room', 'Main Dining'], 'in the order the BEO names them');
  assert.equal(matchRooms('the library', rooms, names).roomId, 'r_lib', 'case and a leading "the" don’t matter');
  assert.deepEqual(matchRooms('Copper Fox Full Buyout', rooms, names), { roomId: null, room: 'Full Buyout', how: 'booking', matches: ['Full Buyout'] });
  assert.deepEqual(matchRooms('Chef’s Table', rooms, names), { roomId: null, room: '', how: 'none', matches: [] });
  assert.equal(matchRooms('Gardens', rooms, names).how, 'none', 'whole words only');
  // No venue set up: the room names from Settings.
  assert.deepEqual(matchRooms('Garden Room', [], names), { roomId: null, room: 'Garden Room', how: 'one', matches: ['Garden Room'] });
});

// ---------- importing ----------

function restaurant() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Copper Fox', rooms: ['Main Dining', 'Garden Room', 'Cellar Bar', 'Full Buyout'] });
  const person = (id, role, extra = {}) => store.insert('users', { id, name: id.slice(4), role, jobCodes: [{ jobCodeId: 'job_srv' }, { jobCodeId: 'job_cpt' }], active: true, ...extra });
  person('usr_mgr', 'manager');
  person('usr_mgr2', 'manager');
  person('usr_emp', 'employee');
  person('usr_sup', 'supervisor');
  person('usr_ev', 'employee', { eventsAccess: true });
  for (const [id, name] of [['job_srv', 'Server'], ['job_bar', 'Bartender'], ['job_cpt', 'Banquet Captain'], ['job_run', 'Food Runner'], ['job_bus', 'Busser']]) store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), order: 0 });
  let clock = new Date('2026-11-30T10:00:00');
  const svc = createService(store, { now: () => clock });
  const as = (id) => (method, args) => svc.call(store.get('users', id), method, args);
  const mgr = as('usr_mgr');
  const venue = mgr('venue.setup');
  const rooms = venue.rooms;
  const settings = store.get('settings', 'settings');
  /** What the import dialog sends: each parsed BEO with the room it matched. */
  const payload = (evs) => evs.map((e) => { const m = matchRooms(e.areas, rooms, settings.rooms); return beoToEvent(e, { roomId: m.roomId, room: m.room || e.areas }); });
  return { store, svc, mgr, emp: as('usr_emp'), sup: as('usr_sup'), ev: as('usr_ev'), rooms, payload, tick: (iso) => { clock = new Date(iso); } };
}

test('importing creates one event per BEO; importing a newer PDF updates them and keeps what managers added', () => {
  const { store, mgr, emp, ev, rooms, payload, tick } = restaurant();
  const first = payload(parsed());

  const dry = mgr('events.importBeos', { events: first, dryRun: true });
  assert.deepEqual(dry.events.map((x) => x.status), ['new', 'new', 'new']);
  assert.equal(store.list('events').length, 0, 'a dry run saves nothing');

  const made = ev('events.importBeos', { events: first }).events;
  assert.deepEqual(made.map((x) => x.status), ['new', 'new', 'new']);
  const evts = made.map((x) => store.get('events', x.id));
  assert.deepEqual(evts.map((e) => [e.name, e.date, e.start, e.guestCount, e.status, e.source, e.invoiceNumber]), [
    ['Rivera Rehearsal Dinner', '2026-12-04', '19:00', 24, 'confirmed', 'beo-pdf', '10000001'],
    ['Northside Robotics Holiday Party & Awards Night', '2026-12-05', '18:00', 60, 'confirmed', 'beo-pdf', '10000002'],
    ['Okafor Lindqvist Wedding', '2026-12-06', '16:00', 120, 'confirmed', 'beo-pdf', '10000003'],
  ]);
  const garden = rooms.find((r) => r.name === 'Main Dining');
  assert.deepEqual([evts[0].roomId, evts[0].room], [garden.id, 'Main Dining'], 'the first room the BEO names');
  assert.deepEqual([evts[2].roomId, evts[2].room], [null, 'Full Buyout']);
  assert.equal(evts[0].menu.length, 6);
  assert.ok(store.list('notifications', (n) => n.userId === 'usr_mgr' && n.text.startsWith('New event: Rivera')).length, 'managers hear about new events');

  // Managers staff the dinner in ShiftBoard: staffing lines, a captain, shifts, someone assigned, a comment, attire.
  const rivera = mgr('events.get', { id: evts[0].id });
  const lines = mgr('events.suggestStaffing', rivera);
  mgr('events.save', { ...rivera, staffing: lines, captainId: 'usr_mgr2', attire: 'All black', status: 'confirmed' });
  mgr('events.generateShifts', { id: rivera.id, publish: true });
  const shift = store.list('shifts', (s) => s.eventId === rivera.id && s.jobCodeId === 'job_srv')[0];
  mgr('shifts.save', { ...shift, userId: 'usr_emp' });
  emp('events.comment', { eventId: rivera.id, text: 'Where do the place cards go?' });
  const staffed = store.get('events', rivera.id);

  // The same PDF again: nothing to do.
  assert.deepEqual(mgr('events.importBeos', { events: first, dryRun: true }).events.map((x) => x.status), ['same', 'same', 'same']);

  // A newer PDF: the dinner moved to 7:30 pm with 30 guests.
  tick('2026-12-01T12:00:00');
  const newer = payload(parsed({ newer: true }));
  const preview = mgr('events.importBeos', { events: newer, dryRun: true }).events;
  assert.equal(preview[0].status, 'update');
  assert.deepEqual(preview[0].changes.sort(), ['guestCount', 'start']);
  assert.equal(preview[0].staffing, lines.length);
  const before = store.list('notifications', (n) => n.userId === 'usr_emp').length;
  const again = mgr('events.importBeos', { events: newer }).events;
  assert.deepEqual(again.map((x) => x.id), made.map((x) => x.id), 'matched by invoice number: the same events');
  assert.equal(store.list('events').length, 3, 'never duplicated');
  const after = store.get('events', rivera.id);
  assert.deepEqual([after.start, after.guestCount, after.beoUpdatedAt], ['19:30', 30, '2026-12-01T09:10']);
  assert.deepEqual(after.staffing, staffed.staffing, 'staffing lines kept');
  assert.deepEqual([after.captainId, after.attire, after.status], ['usr_mgr2', 'All black', 'confirmed']);
  assert.equal(store.get('shifts', shift.id).userId, 'usr_emp', 'assignments kept');
  assert.equal(store.list('eventComments', (c) => c.eventId === rivera.id).length, 1, 'comments kept');
  const told = store.list('notifications', (n) => n.userId === 'usr_emp').slice(before);
  assert.deepEqual(told.map((n) => n.text), ['BEO updated: Rivera Rehearsal Dinner (Fri, Dec 4). Review the latest details.'], 'staff on the event hear about the new time and guest count');
  assert.ok(store.list('notifications', (n) => n.userId === 'usr_mgr2' && n.text.startsWith('BEO updated: Rivera')).length, 'and the captain');

  // An older PDF of the dinner is flagged, not quietly applied.
  assert.equal(mgr('events.importBeos', { events: payload(parsed({ older: true })), dryRun: true }).events[0].status, 'older');
});

test('without an invoice number, an event with the same name and date is a possible duplicate: the manager decides once', () => {
  const { store, mgr, payload } = restaurant();
  const typed = mgr('events.save', { name: 'Rivera  rehearsal DINNER', date: '2026-12-04', start: '18:00', guestCount: 20, status: 'confirmed', setupNotes: 'Typed in ShiftBoard', notes: 'Manager notes' });
  const [rivera] = payload(parsed());
  const noInvoice = { ...rivera, invoiceNumber: '' };
  // Not an identifier match: the preview asks, and nothing is saved until someone decides.
  const dry = mgr('events.importBeos', { events: [noInvoice], dryRun: true }).events[0];
  assert.equal(dry.status, 'duplicate');
  assert.deepEqual(dry.candidates.map((c) => [c.id, c.confidence]), [[typed.id, 'high']]);
  assert.ok(dry.candidates[0].reasons.includes('sameName') && dry.candidates[0].reasons.includes('typedIn'));
  assert.throws(() => mgr('events.importBeos', { events: [noInvoice] }), /Decide what to do with each possible duplicate first/);
  assert.equal(store.list('events').length, 1);
  const r = mgr('events.importBeos', { events: [{ ...noInvoice, decision: { action: 'update', id: typed.id } }] }).events[0];
  assert.deepEqual([r.status, r.id], ['update', typed.id]);
  assert.equal(store.list('events').length, 1);
  const e = store.get('events', typed.id);
  assert.deepEqual([e.name, e.start, e.guestCount, e.notes], ['Rivera Rehearsal Dinner', '19:00', 24, 'Manager notes']);
  // Decided once, remembered: the same BEO again needs no decision and changes nothing.
  assert.deepEqual(mgr('events.importBeos', { events: [noInvoice], dryRun: true }).events.map((x) => [x.status, x.id]), [['same', typed.id]]);
  // The same booking with an invoice number, twice in one file: one decision, one event, and it takes the number.
  const other = mgr('events.importBeos', { events: [{ ...rivera, invoiceNumber: '99999999', decision: { action: 'update', id: typed.id } }, { ...rivera, invoiceNumber: '99999999' }] }).events;
  assert.deepEqual(other.map((x) => [x.status, x.id || x.into]), [['merged', 1], ['same', typed.id]]);
  assert.equal(store.get('events', typed.id).invoiceNumber, '99999999');
  // A BEO with another invoice number is another event: no question asked.
  const more = mgr('events.importBeos', { events: [{ ...rivera, invoiceNumber: '88888888' }] }).events[0];
  assert.equal(more.status, 'new');
  assert.equal(store.list('events').length, 2);
});

test('an event synced from Tripleseat keeps Tripleseat’s booking; the BEO PDF adds its menu and notes', () => {
  const { store, mgr, payload } = restaurant();
  const [rivera] = payload(parsed());
  // The same booking, already synced from Tripleseat (core/tripleseat.js owns its id, source and booking fields).
  store.insert('events', { id: 'evt_ts_4242', source: 'tripleseat', externalId: 4242, name: 'Rivera Rehearsal Dinner', date: rivera.date,
    start: '18:30', end: '21:00', guestCount: 30, status: 'confirmed', room: 'Library', roomId: null, staffing: [], captainId: null, menu: [] });
  const ask = mgr('events.importBeos', { events: [{ ...rivera, invoiceNumber: '' }], dryRun: true }).events[0];
  assert.equal(ask.status, 'duplicate', 'a name-and-date match is checked by a person, Tripleseat or not');
  assert.ok(ask.candidates[0].reasons.includes('fromTripleseat'));
  const r = mgr('events.importBeos', { events: [{ ...rivera, invoiceNumber: '', decision: { action: 'update', id: 'evt_ts_4242' } }] }).events[0];
  assert.deepEqual([r.status, r.id], ['update', 'evt_ts_4242']);
  assert.equal(store.list('events').length, 1, 'not a second copy');
  const e = store.get('events', 'evt_ts_4242');
  assert.equal(e.source, 'tripleseat', 'the next Tripleseat sync still owns it');
  assert.deepEqual([e.start, e.end, e.guestCount, e.room], ['18:30', '21:00', 30, 'Library'], 'Tripleseat’s booking stays');
  assert.ok(e.menu.length > 0, 'the BEO’s menu came in');
  // A Tripleseat BEO whose invoice number is the Tripleseat event id is the same event, no question asked.
  const again = mgr('events.importBeos', { events: [{ ...rivera, invoiceNumber: '4242' }], dryRun: true }).events[0];
  assert.deepEqual([again.status, again.id, again.match.how], ['same', 'evt_ts_4242', 'tripleseat']);
});

test('a blank BEO field keeps what someone typed in ShiftBoard, and clears what the last import wrote', () => {
  const b = cleanBeoEvent({ name: 'Gala', date: '2026-12-31', dietaryNotes: 'No nuts', guestCount: 50 });
  const { doc: firstDoc } = mergeBeo(null, b);
  const imported = { id: 'e1', ...firstDoc };
  // Next BEO: no dietary note, no guest count. Both came from the last import, so both clear.
  const blank = cleanBeoEvent({ name: 'Gala', date: '2026-12-31' });
  assert.deepEqual(mergeBeo(imported, blank).doc.dietaryNotes, '');
  // But a dietary note a manager typed in ShiftBoard stays.
  const typed = { ...imported, dietaryNotes: 'No nuts, 2 vegans', guestCount: 55 };
  const out = mergeBeo(typed, blank);
  assert.deepEqual([out.doc.dietaryNotes, out.doc.guestCount], ['No nuts, 2 vegans', 55]);
  assert.deepEqual(out.keyChanges, []);
  assert.deepEqual(mergeBeo(typed, { ...blank, guestCount: 60 }).keyChanges, ['guestCount']);
});

// ---------- permissions and the plan ----------

test('managers and the events team import; staff can’t, and never see the client’s details or the F&B minimum', () => {
  const { mgr, emp, sup, ev, payload } = restaurant();
  const events = payload(parsed());
  assert.throws(() => emp('events.importBeos', { events }), /Events team or managers only/);
  assert.throws(() => sup('events.importBeos', { events, dryRun: true }), /Events team or managers only/);
  assert.throws(() => mgr('events.importBeos', { events: [] }), /Pick at least one event to import/);
  assert.throws(() => mgr('events.importBeos', { events: [{ name: 'No date' }] }), /Event date is required/);
  assert.deepEqual(mgr('events.importBeos', { events: [{ name: 'No date' }], dryRun: true }).events, [{ index: 0, status: 'invalid' }]);
  assert.throws(() => mgr('events.importBeos', { events: [{ ...events[0], roomId: 'room_gone' }] }), /That room is gone/);
  const id = ev('events.importBeos', { events }).events[0].id;

  const staffView = emp('events.get', { id });
  for (const k of ['client', 'contactName', 'contactEmail', 'contactPhone', 'contactNotes', 'fbMinimum']) assert.equal(staffView[k], undefined, k);
  assert.equal(staffView.arrivalNotes, 'Side door entrance / Hand out welcome cards', 'staff see what they need to work it');
  assert.equal(emp('events.list', { start: '2026-12-01' }).find((e) => e.id === id).client, undefined);
  const teamView = ev('events.get', { id });
  assert.deepEqual([teamView.client, teamView.contactPhone, teamView.fbMinimum], ['Jordan Rivera', '555-010-2000', 1800]);
  assert.equal(teamView.beoPrints, undefined, 'bookkeeping stays inside');
  assert.equal(mgr('events.list', { start: '2026-12-01' }).find((e) => e.id === id).client, 'Jordan Rivera');
});

test('the import belongs to the plan’s Events & BEOs feature', () => {
  assert.equal(featureForMethod('events.importBeos'), 'events');
  assert.ok(!PLANS.starter.features.includes('events') && PLANS.pro.features.includes('events'));
});
