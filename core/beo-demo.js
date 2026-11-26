// The web demo's BEO details (web/src/api.js runs it after seeding): invented, like all demo data.
//   seedBeoDemo(store)        the demo wedding as if its BEO PDF had been imported: every kind of section
//                             (timeline, menu, dietary, bar, rentals, decor, vendors, staffing, kitchen, parking,
//                             signatures, an unknown heading, the client's contact), plus a few on the happy hour
//   demoBeoSamples(events)    "Try a sample BEO" in the demo's import dialog: what reading a PDF would give, made to
//                             show the preview: an update with changes, the same BEO twice in one file, a possible
//                             duplicate to decide on, and a new event
// Kept out of core/seed.js so the role-parity fingerprint (test/fixtures/role-parity.json) stays as it was.
import { fingerprint } from './beo-sections.js';
import { addDays } from './time.js';

const WEDDING_SETUP = [
  // RENTAL (rentals section)
  'Full Venue Buyout: Restaurant, Library, Rabbit Hole, Patio',
  'Includes: house tables and chairs, flatware, glassware, house napkins',
  // Setup Details (setup section)
  'Rounds of 10, head table on the stage',
  'Gift & card table at the entry',
  'Floorplans:',
  '• Library: lounge seating for the cocktail hour',
  '◦ move two high tops to the patio',
];
const WEDDING_CONTACT = [
  'Host/ Event Contact Details',
  '• Rose Radunzel & Avery Jones',
  '• Day-of coordinator: Quinn Example 555-010-7788',
  'Vendor Contact Details',
  '• Florist: Bloom Example, arrives 1:00 PM, 555-010-6001',
  '• DJ: Sample Sound, load-in 3:30 PM, dj@sound.example',
  '• Photographer: Lens Example, arrives 4:30 PM',
];

/** The wedding's BEO as imported: its fields and its own sections. */
function weddingBeo(date) {
  const fields = {
    source: 'beo-pdf', invoiceNumber: 'DEMO-1042', beoUpdatedAt: `${addDays(date, -6)}T15:20`, importedAt: `${addDays(date, -6)}T16:02:00.000Z`,
    location: 'Our Restaurant', areas: 'Full Buyout: Restaurant, Library, Rabbit Hole, Patio', guaranteed: 108,
    salesManager: 'Kelly', client: 'Radunzel & Jones Wedding', contactName: 'Rose Radunzel', contactPhone: '555-010-7700', contactEmail: 'rose@wedding.example',
    contactNotes: WEDDING_CONTACT.join('\n'),
    setupNotes: WEDDING_SETUP.join('\n'),
    dietaryNotes: ['3 gluten free (place cards marked GF)', '1 nut allergy, table 4: severe, no nuts at that table', '2 vegan: risotto with no butter or cheese', '1 shellfish allergy (the bride’s aunt, table 2)'].join('\n'),
    arrivalNotes: 'Guests use the front entrance. Shuttle drop-off every 20 minutes from 5:00 PM.',
    specialInstructions: ['Couple arrives at 5:45 for photos on the patio', 'No confetti or sparklers indoors', 'Cake cutting at 8:00; the DJ announces it'].join('\n'),
    avNotes: ['Wireless microphone for toasts', 'Slideshow on the Rabbit Hole screens at 9:00', 'DJ: Sample Sound, 6:00 PM to 11:00 PM'].join('\n'),
    timeline: [
      { time: '13:00', item: 'Florist and decor load-in' }, { time: '15:30', item: 'DJ load-in, sound check' },
      { time: '17:15', item: 'Guests arrive, cocktail hour on the patio' }, { time: '18:15', item: 'Grand entrance' }, { time: '18:30', item: 'Dinner service' },
      { time: '19:30', item: 'Toasts & champagne' }, { time: '20:00', item: 'Cake cutting, first dance' }, { time: '22:30', item: 'Last call' }, { time: '23:00', item: 'Last dance, sparkler exit outside' },
    ],
    menu: [
      { course: 'Cocktail hour (passed)', item: 'Tuna crudo on rice crisp', notes: '', dietary: ['GF', 'DF'] },
      { course: 'Cocktail hour (passed)', item: 'Wild mushroom toast', notes: 'truffle, thyme', dietary: ['V'] },
      { course: 'First', item: 'Burrata salad', notes: 'heirloom tomato, basil oil, grilled bread', dietary: ['V'] },
      { course: 'Entrée (plated, by place card)', item: 'Filet', notes: 'potato gratin, red wine jus', qty: 52, dietary: ['GF'] },
      { course: 'Entrée (plated, by place card)', item: 'Salmon', notes: 'lemon beurre blanc, fennel', qty: 38, dietary: ['GF'] },
      { course: 'Entrée (plated, by place card)', item: 'Mushroom risotto', notes: 'vegan on request', qty: 20, dietary: ['V'] },
      { course: 'Dessert', item: 'Wedding cake (client provided)', notes: 'served on the house plates' },
    ],
  };
  const beoSections = [
    { key: 'rentals', title: 'RENTAL', kind: 'list', items: WEDDING_SETUP.slice(0, 2), from: ['setupNotes'] },
    { key: 'setup', title: 'Setup Details', kind: 'text', items: WEDDING_SETUP.slice(2), from: ['setupNotes'] },
    { key: 'contacts', title: '', kind: 'keyvalue', items: [{ value: 'Rose Radunzel & Avery Jones' }, { value: 'Day-of coordinator: Quinn Example 555-010-7788' }], from: ['contactNotes'] },
    { key: 'vendors', title: '', kind: 'list', items: WEDDING_CONTACT.slice(4).map((x) => x.slice(2)), from: ['contactNotes'] },
    { key: 'decor', title: 'LINENS & DECOR', kind: 'list', items: ['Ivory floor-length linens on the rounds', 'Gold chargers (client provided)', '12 low arrangements, 1 tall on the head table'] },
    { key: 'staffing', title: 'STAFFING', kind: 'list', items: ['1 bartender per 75 guests plus a satellite bar on the patio', 'Captain on the floor from 3:30'] },
    { key: 'kitchen', title: 'KITCHEN NOTES', kind: 'list', items: ['Vendor meals (DJ, photographer): 2 at 7:15', 'Fire entrées at 18:45 by place card count'] },
    { key: 'parking', title: 'PARKING & COAT CHECK', kind: 'list', items: ['Valet at the front door from 5:00', 'Coat check in the Library hallway'] },
    { key: 'other', title: 'PHOTO BOOTH', kind: 'text', items: ['Booth in the Library corner, 7:00–10:00', 'Props and a guest book next to it'] },
    { key: 'signatures', title: 'Client Signature', kind: 'keyvalue', items: [{ labelKey: 'signed', value: 'Rose Radunzel' }, { labelKey: 'updated', value: addDays(date, -6) }] },
  ];
  return { fields, beoSections };
}

export function seedBeoDemo(store) {
  const w = store.get('events', 'evt_wedding');
  if (w) {
    const { fields, beoSections } = weddingBeo(w.date);
    store.update('events', w.id, { ...fields, beoSections, beoPrints: { setupNotes: fingerprint(fields.setupNotes), contactNotes: fingerprint(fields.contactNotes) }, importKeys: ['inv:DEMO-1042'] });
  }
  const a = store.get('events', 'evt_aspen');
  if (a) {
    store.update('events', a.id, {
      dietaryNotes: '2 vegetarian, 1 dairy free',
      beoSections: [
        { key: 'vendors', title: 'VENDORS', kind: 'list', items: ['Name tags: client brings them, table at the entrance'] },
        { key: 'other', title: 'GIVEAWAYS', kind: 'text', items: ['Raffle at 6:30, the client draws the names', 'Prizes stay behind the host stand until then'] },
      ],
    });
  }
}

/** What reading a sample PDF gives in the demo (core/beo-import.js shape), on the demo's dates. */
export function demoBeoSamples(events = []) {
  const byName = (re) => events.find((e) => re.test(e.name || ''));
  const wedding = byName(/radunzel/i);
  const aspen = byName(/aspen grove/i);
  const base = { otherDates: [], warnings: [], specialDrinks: [], avNotes: '', arrivalNotes: '', contactNotes: '', setupNotes: '', specialInstructions: '', dietaryNotes: '', beverage: { package: '', bar: '', notes: '' }, timeline: [], menu: [], sections: [], client: '', contactName: '', contactEmail: '', contactPhone: '', salesManager: 'Kelly', eventManager: '', fbMinimum: 0, type: '', serviceStyle: '' };
  const out = [];
  if (wedding) {
    // The same BEO, re-exported: 4 more guests, one more gluten free, more flowers, a late-night snack; no parking notes.
    const { fields, beoSections } = weddingBeo(wedding.date);
    const { source, importedAt, ...beo } = fields;
    const w = {
      ...base, ...beo, name: 'Radunzel & Jones Wedding Reception', date: wedding.date, start: '17:15', end: '23:00', guestCount: 114, guaranteed: 110, type: 'Wedding', serviceStyle: 'plated',
      beoUpdatedAt: `${addDays(wedding.date, -2)}T10:05`, pages: [1, 6],
      beverage: { package: 'Premium open bar, 5 hrs', bar: 'Main bar + patio satellite', notes: 'Champagne toast at 7:30' },
      specialDrinks: [{ name: 'The Radunzel', recipe: 'Gin, elderflower, lemon, cucumber', notes: '', batch: 'Batch 4 gallons' }],
      dietaryNotes: beo.dietaryNotes.replace('3 gluten free', '4 gluten free'),
      sections: [
        ...beoSections.filter((x) => x.key !== 'parking').map((x) => (x.key === 'decor' ? { ...x, items: ['Ivory floor-length linens on the rounds', 'Gold chargers (client provided)', '14 low arrangements, 1 tall on the head table'] } : x)),
        { key: 'kitchen', title: 'LATE NIGHT', kind: 'list', items: ['Sliders and fries passed at 10:00, 60 pieces'] },
      ],
    };
    out.push({ ...w, name: 'Radunzel & Jones Wedding Reception', beoUpdatedAt: `${addDays(wedding.date, -9)}T09:00`, guestCount: 110, pages: [7, 12] }); // an older copy, same file
    out.push(w);
  }
  if (aspen) {
    out.push({
      ...base, name: 'Aspen Grove Company Happy Hour', date: aspen.date, start: '17:00', end: '19:30', guestCount: 55, type: 'Corporate', serviceStyle: 'reception', areas: 'Moon Rabbit', invoiceNumber: '', beoUpdatedAt: '', pages: [13, 14],
      menu: [{ course: 'Passed', item: 'Chef’s selection of 4 passed appetizers', notes: '' }], dietaryNotes: '2 vegetarian',
      sections: [{ key: 'other', title: 'GIVEAWAYS', kind: 'text', items: ['Raffle at 6:30'] }],
    });
  }
  const day = wedding ? addDays(wedding.date, 1) : aspen?.date;
  if (day) {
    out.push({
      ...base, name: 'Lindqvist Retirement Lunch', date: day, start: '12:00', end: '14:30', guestCount: 26, type: 'Private lunch', serviceStyle: 'family', areas: 'Library', invoiceNumber: 'DEMO-1077', beoUpdatedAt: `${addDays(day, -3)}T14:40`, pages: [15, 16],
      menu: [{ course: 'Family style', item: 'Roast chicken', notes: 'herb jus' }, { course: 'Family style', item: 'Charred carrots', notes: '', dietary: ['GF', 'V'] }],
      timeline: [{ time: '12:00', item: 'Guests arrive' }, { time: '12:30', item: 'Lunch served' }, { time: '13:30', item: 'Speeches' }],
      dietaryNotes: '1 celiac', sections: [{ key: 'av', title: 'A/V', kind: 'list', items: ['Microphone for speeches'] }],
    });
  }
  return out;
}
