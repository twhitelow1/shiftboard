// Demo seed: the real week of 9/28/2026 transcribed from the house schedule PDF,
// plus SAMPLE sales history, pay rates and BEO details for demonstrating forecasting & events.
import { uid } from './store.js';
import { addDays, dow, range } from './time.js';
import { DEFAULT_SETTINGS } from './service.js';

const WEEK = '2026-09-28'; // Monday
const D = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };
const day = (k) => addDays(WEEK, D[k]);

const JOBS = [
  // key, name, short, department, color, rate, eventRole
  ['MGR', 'Manager', 'MGR', 'Leadership', '#334155', 28, false],
  ['CHEF', 'Chef', 'CHEF', 'Leadership', '#7c2d12', 30, false],
  ['RBAR', 'Restaurant Bar', 'RBAR', 'Restaurant', '#0891b2', 12, false],
  ['SRV', 'Server', 'SRV', 'Restaurant', '#2563eb', 12, true],
  ['FR', 'Food Runner', 'FR', 'Restaurant', '#16a34a', 14, true],
  ['BUS', 'Busser', 'BUS', 'Restaurant', '#65a30d', 14, true],
  ['BAR', 'Bartender', 'BAR', 'Bar', '#9333ea', 12, true],
  ['BBK', 'Barback', 'BBK', 'Bar', '#a855f7', 15, false],
  ['MRB', 'MR Bartender', 'MRB', 'Moon Rabbit', '#dc2626', 12, false],
  ['COC', 'Cocktail Server', 'COC', 'Moon Rabbit', '#e11d48', 12, false],
  ['HOST', 'Restaurant Host', 'HOST', 'Host', '#d97706', 17, true],
  ['BHOST', 'Back Host Stand', 'BHST', 'Host', '#ca8a04', 17, false],
  ['DOOR', 'Doorman', 'DOOR', 'Host', '#475569', 18, false],
  ['BC', 'Banquet Captain', 'BC', 'Events', '#0f766e', 20, true],
];

// name, role, job keys
const PEOPLE = [
  ['Moe', 'admin', ['MGR']], ['Chef Lucas', 'manager', ['CHEF']], ['Kelly', 'manager', ['MGR']], ['Ben', 'manager', ['MGR']],
  ['CJ', 'manager', ['MGR']], ['Courtney', 'manager', ['MGR']], ['Tatiana', 'manager', ['MGR']],
  ['Torie', 'employee', ['RBAR']], ['Karen', 'employee', ['RBAR', 'BAR']],
  ['Alex D', 'employee', ['SRV', 'BC']], ['Styves', 'employee', ['SRV']], ['Victor', 'employee', ['SRV']], ['Tori', 'employee', ['SRV']],
  ['Andrea', 'employee', ['SRV', 'COC']], ['Ever', 'employee', ['SRV', 'FR']], ['Manny', 'employee', ['SRV']], ['Jonathan', 'employee', ['SRV']],
  ['Flor', 'employee', ['FR', 'COC']], ['Miguel', 'employee', ['FR']], ['Wilder', 'employee', ['FR', 'BBK']],
  ['Nicolas', 'employee', ['BUS']], ['Andres', 'employee', ['BUS', 'FR']], ['Maciel', 'employee', ['BUS']],
  ['Mak', 'employee', ['BAR']], ['Yair', 'employee', ['BAR']], ['Dante', 'employee', ['BAR', 'MRB']], ['Ciaran', 'employee', ['BAR', 'MRB']],
  ['Hans', 'employee', ['BBK', 'BC']], ['Arthur', 'employee', ['BBK']], ['Luciano', 'employee', ['BBK']],
  ['Todd', 'employee', ['MRB']], ['Romina', 'employee', ['MRB']],
  ['Svetlana', 'employee', ['COC']], ['Alan', 'employee', ['COC']], ['Agustina', 'employee', ['COC', 'BHOST']], ['Payton', 'employee', ['COC']],
  ['Maca', 'employee', ['COC']], ['Samantha', 'employee', ['COC']],
  ['Liz', 'employee', ['HOST']], ['Daniela', 'employee', ['HOST', 'BHOST']], ['Mary Ann', 'employee', ['HOST']], ['Antuanette', 'employee', ['BHOST', 'HOST']],
  ['Juan', 'employee', ['DOOR']], ['Bobby', 'employee', ['DOOR']], ['Diop', 'employee', ['DOOR']], ['Alessandro', 'employee', ['DOOR']], ['Jorge', 'employee', ['DOOR']],
  ['Events Team', 'events', []],
];

// [person, job, day, start, end|null, tag, eventKey]
const SHIFTS = [
  ['Moe', 'MGR', 'THU', '16:00'], ['Moe', 'MGR', 'FRI', '17:00'], ['Moe', 'MGR', 'SAT', '17:00'], ['Moe', 'MGR', 'SUN', '20:00'],
  ...['WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => ['Chef Lucas', 'CHEF', d, '12:00']),
  ...['TUE', 'WED', 'FRI', 'SAT'].map((d) => ['Kelly', 'MGR', d, '16:00']),
  ...['WED', 'THU', 'FRI', 'SAT'].map((d) => ['Ben', 'MGR', d, '16:00']),
  ['CJ', 'MGR', 'TUE', '12:00'], ['CJ', 'MGR', 'WED', '11:00'], ['CJ', 'MGR', 'THU', '11:00'], ['CJ', 'MGR', 'FRI', '10:00'], ['CJ', 'MGR', 'SAT', '13:00'],
  ['Courtney', 'MGR', 'TUE', '11:00'], ...['WED', 'THU', 'FRI', 'SAT'].map((d) => ['Courtney', 'MGR', d, '12:00']),
  ['Tatiana', 'MGR', 'TUE', '13:00'], ['Tatiana', 'MGR', 'WED', '13:00'], ['Tatiana', 'MGR', 'THU', '14:30'], ['Tatiana', 'MGR', 'FRI', '15:00'], ['Tatiana', 'MGR', 'SAT', '14:00'],
  // Restaurant bar
  ['Torie', 'RBAR', 'WED', '16:00'], ...['TUE', 'THU', 'FRI'].map((d) => ['Karen', 'RBAR', d, '16:00']), ['Karen', 'RBAR', 'SAT', '16:00', null, '', 'wedding'],
  // Servers
  ['Alex D', 'BC', 'TUE', '15:30', null, 'BC', 'aspen'], ['Alex D', 'SRV', 'THU', '16:00'], ['Alex D', 'SRV', 'FRI', '16:30', null, '*'], ['Alex D', 'BC', 'SAT', '15:30', null, 'BC', 'wedding'],
  ['Styves', 'SRV', 'TUE', '16:00', null, 'LIB', 'grandfam'], ['Styves', 'SRV', 'WED', '16:00'], ['Styves', 'SRV', 'FRI', '16:00'], ['Styves', 'SRV', 'SAT', '16:00', null, '', 'wedding'],
  ['Victor', 'SRV', 'WED', '16:30'], ['Victor', 'SRV', 'THU', '16:30'], ['Victor', 'SRV', 'SAT', '16:00', null, '', 'wedding'],
  ['Tori', 'SRV', 'TUE', '16:30'], ['Tori', 'SRV', 'THU', '16:30', null, 'LIB', 'bison'], ['Tori', 'SRV', 'SAT', '16:00', null, '', 'wedding'],
  ['Andrea', 'SRV', 'TUE', '16:00', null, 'PASSED', 'aspen'], ['Andrea', 'SRV', 'THU', '16:30', null, 'LIB', 'bison'], ['Andrea', 'SRV', 'FRI', '16:30', null, '*'], ['Andrea', 'SRV', 'SAT', '16:00', null, '', 'wedding'],
  ['Jonathan', 'SRV', 'TUE', '16:00'], ['Jonathan', 'SRV', 'THU', '16:30'], ['Jonathan', 'SRV', 'FRI', '16:30', null, '*'], ['Jonathan', 'SRV', 'SAT', '16:00', null, '', 'wedding'],
  // Food runners
  ['Flor', 'FR', 'WED', '16:00', null, 'FR'], ['Flor', 'FR', 'THU', '16:30'], ['Flor', 'FR', 'SAT', '16:00', null, 'FR**', 'wedding'],
  ['Ever', 'FR', 'FRI', '16:00'], ['Ever', 'FR', 'SAT', '16:30', null, '', 'wedding'],
  ['Miguel', 'FR', 'TUE', '16:30', null, 'FR'], ['Miguel', 'FR', 'THU', '17:00', null, 'PASSES', 'sundance'], ['Miguel', 'FR', 'FRI', '16:30'], ['Miguel', 'FR', 'SAT', '16:30', null, '', 'wedding'],
  ['Wilder', 'FR', 'TUE', '16:00', null, 'FR'], ['Wilder', 'FR', 'WED', '16:30'], ['Wilder', 'FR', 'THU', '16:30'], ['Wilder', 'FR', 'FRI', '16:30'],
  // Bussers
  ['Nicolas', 'BUS', 'TUE', '16:00'], ['Nicolas', 'BUS', 'THU', '16:30'], ['Nicolas', 'BUS', 'FRI', '16:30'], ['Nicolas', 'BUS', 'SAT', '16:30', null, '', 'wedding'],
  ['Andres', 'BUS', 'TUE', '16:30'], ['Andres', 'BUS', 'THU', '17:00', null, 'LIB', 'bison'], ['Andres', 'BUS', 'SAT', '16:00', null, 'FR', 'wedding'],
  ['Maciel', 'BUS', 'WED', '16:00'], ['Maciel', 'BUS', 'THU', '16:30'], ['Maciel', 'BUS', 'FRI', '16:30'], ['Maciel', 'BUS', 'SAT', '16:30', null, '*', 'wedding'],
  // Bar
  ['Mak', 'BAR', 'TUE', '16:00'], ['Mak', 'BAR', 'THU', '16:00'], ['Mak', 'BAR', 'FRI', '16:00'], ['Mak', 'BAR', 'SAT', '19:00'],
  ['Yair', 'BAR', 'THU', '16:00'], ['Yair', 'BAR', 'FRI', '21:00', null, 'RH', 'pride'], ['Yair', 'BAR', 'SAT', '19:00'],
  ['Dante', 'BAR', 'TUE', '17:00'], ['Dante', 'BAR', 'WED', '16:00'], ['Dante', 'BAR', 'FRI', '18:00', null, 'RH', 'pride'],
  // Barback
  ['Hans', 'BC', 'THU', '16:00', null, 'BC', 'bison'], ['Hans', 'BBK', 'FRI', '21:00', null, 'RH', 'pride'],
  ['Arthur', 'BBK', 'TUE', '16:00'], ['Arthur', 'BBK', 'WED', '16:00'], ['Arthur', 'BBK', 'THU', '16:00', null, 'RH', 'bison'], ['Arthur', 'BBK', 'FRI', '16:00'], ['Arthur', 'BBK', 'SAT', '18:00'],
  ['Luciano', 'BBK', 'TUE', '16:00'], ['Luciano', 'BBK', 'THU', '17:00', null, 'MOON'], ['Luciano', 'BBK', 'FRI', '21:00', null, 'RH', 'pride'], ['Luciano', 'BBK', 'SAT', '19:00', null, 'RH'],
  // Moon Rabbit bar
  ['Todd', 'MRB', 'TUE', '16:00', null, '', 'aspen'], ['Todd', 'MRB', 'THU', '17:00'], ['Todd', 'MRB', 'SAT', '16:00'],
  ['Romina', 'MRB', 'TUE', '16:00', null, '', 'aspen'], ['Romina', 'MRB', 'THU', '17:00'], ['Romina', 'MRB', 'SAT', '16:00'],
  // Cocktail
  ['Agustina', 'COC', 'TUE', '16:00', null, 'PASSED', 'aspen'], ['Agustina', 'COC', 'THU', '17:00', null, 'PASSED', 'sundance'], ['Agustina', 'COC', 'FRI', '20:00', null, '', 'pride'], ['Agustina', 'BHOST', 'SAT', '16:30', null, 'BACK HOST*'],
  ['Maca', 'COC', 'FRI', '20:00', null, '', 'pride'],
  // Host
  ['Liz', 'HOST', 'TUE', '12:00', '16:00'], ['Liz', 'HOST', 'WED', '15:00', '21:00'], ['Liz', 'HOST', 'FRI', '14:30', '18:00'], ['Liz', 'HOST', 'SAT', '10:00', '18:00'],
  ['Mary Ann', 'HOST', 'THU', '16:00'], ['Mary Ann', 'HOST', 'FRI', '17:00'], ['Mary Ann', 'HOST', 'SAT', '16:30'],
  // Back host stand
  ['Daniela', 'BHOST', 'FRI', '20:30', null, '', 'pride'],
  ...['TUE', 'WED', 'THU', 'FRI'].map((d) => ['Antuanette', 'BHOST', d, '16:30']),
  // Doorman
  ['Juan', 'DOOR', 'TUE', '17:00'], ['Juan', 'DOOR', 'FRI', '20:30', null, '', 'pride'], ['Juan', 'DOOR', 'SAT', '20:00'],
  ['Bobby', 'DOOR', 'THU', '17:30'], ['Bobby', 'DOOR', 'FRI', '20:30', null, '', 'pride'],
  ['Diop', 'DOOR', 'FRI', '20:30', null, '', 'pride'], ['Diop', 'DOOR', 'SAT', '20:00'],
  ['Alessandro', 'DOOR', 'THU', '17:30'], ['Alessandro', 'DOOR', 'SAT', '20:00'],
];

const TIME_OFF = [
  ['Victor', 'MON', 'TUE'], ['Victor', 'SUN', 'SUN'], ['Tori', 'FRI', 'FRI'], ['Manny', 'SUN', 'SUN'], ['Jonathan', 'WED', 'WED'],
  ['Nicolas', 'WED', 'WED'], ['Andres', 'WED', 'WED'], ['Wilder', 'SAT', 'SAT'], ['Antuanette', 'SAT', 'SAT'],
];

// Events from the schedule's EVENTS row. Menus / drinks / contacts are SAMPLE details.
const EVENTS = {
  aspen: {
    name: 'Aspen Grove Happy Hour', type: 'Corporate', day: 'TUE', start: '17:00', end: '19:30', room: 'Moon Rabbit', guestCount: 50, serviceStyle: 'reception', status: 'confirmed', captain: 'Alex D',
    client: 'Aspen Grove', menu: [{ course: 'Passed', item: 'Chef’s selection of 4 passed appetizers', notes: '2 pieces per guest per hour' }, { course: 'Display', item: 'Charcuterie & cheese board', notes: 'Set by 4:45' }],
    beverage: { package: 'Beer & wine + 1 signature cocktail', bar: 'Hosted bar, 2 hrs', notes: 'Switch to cash bar at 7:00' },
    specialDrinks: [{ name: 'Aspen Mule', recipe: 'Vodka, lime, ginger beer, rosemary sprig', batch: 'Batch 3 gallons' }],
    staffing: [['BC', 1, '15:30'], ['MRB', 2, '16:00'], ['COC', 1, '16:00'], ['SRV', 1, '16:00']],
    timeline: [{ time: '15:30', item: 'BC walkthrough, bar set' }, { time: '17:00', item: 'Doors, passed apps begin' }, { time: '19:00', item: 'Last call for hosted bar' }],
    setupNotes: 'Cocktail rounds, high tops along windows. Name tag table at entrance.',
  },
  grandfam: {
    name: 'Grand Fam Reception & Dinner', type: 'Private dinner', day: 'TUE', start: '17:00', end: '20:00', room: 'Rabbit Hole & Library', guestCount: 20, serviceStyle: 'family', status: 'confirmed',
    menu: [{ course: 'Reception', item: 'Passed bites', notes: '' }, { course: 'Dinner', item: 'Family-style 3 courses', notes: '2 vegetarian' }],
    beverage: { package: 'Wine service with dinner', bar: 'Consumption', notes: '' }, specialDrinks: [],
    staffing: [['SRV', 1, '16:00']], timeline: [{ time: '17:00', item: 'Reception in Rabbit Hole' }, { time: '18:00', item: 'Seated dinner in Library' }],
    setupNotes: 'One long table in the Library, 20 covers.',
  },
  bingo: { name: 'Bingo', type: 'In-house promo', day: 'TUE', start: '19:00', end: '21:00', room: 'Restaurant', guestCount: 0, serviceStyle: 'cocktail', status: 'confirmed', staffing: [] },
  bison: {
    name: 'Bison Oil & Gas', type: 'Corporate', day: 'THU', start: '17:30', end: '21:00', room: 'Patio / RH / LIB', guestCount: 35, serviceStyle: 'reception', status: 'confirmed', captain: 'Hans',
    menu: [{ course: 'Stations', item: 'Slider & taco stations', notes: '' }],
    beverage: { package: 'Bottle service', bar: 'Bottles pre-selected by client', notes: 'Btl service Patio / RH / LIB' },
    specialDrinks: [{ name: 'Well Water', recipe: 'Bourbon, honey, lemon, soda', batch: '' }],
    staffing: [['BC', 1, '16:00'], ['SRV', 2, '16:30'], ['BUS', 1, '17:00'], ['BBK', 1, '16:00']],
    timeline: [{ time: '17:30', item: 'Guests arrive, bottle service begins' }], setupNotes: 'Heaters on patio if under 60°F.',
  },
  sundance: {
    name: 'Sundance Movie Screening', type: 'Screening', day: 'THU', start: '18:00', end: '21:00', room: 'Library', guestCount: 30, serviceStyle: 'reception', status: 'confirmed',
    menu: [{ course: 'Passed', item: 'Popcorn bar + passed snacks', notes: '' }], beverage: { package: 'Cash bar', bar: '', notes: '' }, specialDrinks: [],
    staffing: [['FR', 1, '17:00'], ['COC', 1, '17:00']], avNotes: 'Projector & screen, test at 5:30.',
  },
  pride: {
    name: 'Mountain Pride Halloween', type: 'Party', day: 'FRI', start: '21:00', end: '01:00', room: 'Rabbit Hole', guestCount: 250, serviceStyle: 'cocktail', status: 'confirmed',
    menu: [], beverage: { package: 'Cash bar', bar: '2 wells', notes: 'Costume contest at 11:30' },
    specialDrinks: [{ name: 'Poison Apple', recipe: 'Apple vodka, sour apple, grenadine float', batch: 'Batch 5 gallons' }, { name: 'Witches Brew', recipe: 'Gin, blue curaçao, lemon, prosecco', batch: '' }],
    staffing: [['BAR', 3, '20:30'], ['BBK', 2, '21:00'], ['DOOR', 3, '20:30'], ['COC', 2, '20:00'], ['BHOST', 1, '20:30']],
    setupNotes: 'No BC. Wristbands at door, ID check 21+.',
  },
  wedding: {
    name: 'Radunzel & Jones Wedding Reception', type: 'Wedding', day: 'SAT', start: '17:15', end: '23:00', room: 'Full Buyout', guestCount: 110, serviceStyle: 'plated', status: 'confirmed', captain: 'Alex D',
    menu: [{ course: 'Cocktail hour', item: 'Passed apps (4 selections)', notes: '' }, { course: 'First', item: 'Burrata salad', notes: '' }, { course: 'Entrée', item: 'Choice of filet / salmon / risotto', notes: 'Place cards marked by entrée' }, { course: 'Dessert', item: 'Wedding cake (client provided)', notes: 'Cake cutting fee' }],
    beverage: { package: 'Premium open bar, 5 hrs', bar: 'Main bar + satellite', notes: 'Champagne toast at 7:30' },
    specialDrinks: [{ name: 'The Radunzel', recipe: 'Gin, elderflower, lemon, cucumber', batch: 'Batch 4 gallons' }, { name: 'Jones Old Fashioned', recipe: 'Bourbon, demerara, orange & angostura bitters', batch: '' }],
    staffing: [['BC', 1, '15:30'], ['SRV', 6, '16:00'], ['RBAR', 1, '16:00'], ['FR', 3, '16:00'], ['BUS', 3, '16:00']],
    timeline: [{ time: '17:15', item: 'Guests arrive, cocktail hour' }, { time: '18:15', item: 'Grand entrance' }, { time: '18:30', item: 'Dinner service' }, { time: '19:30', item: 'Toasts & champagne' }, { time: '20:00', item: 'Cake & dancing' }, { time: '23:00', item: 'Last dance' }],
    setupNotes: 'FULL BUYOUT. Rounds of 10, head table on stage. Gift & card table at entry.', dietaryNotes: '3 gluten-free, 1 nut allergy (table 4).', attire: 'All black',
  },
};

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function seedDemo(store, { hashPassword = (p) => `plain:${p}`, password = 'demo1234' } = {}) {
  const rand = mulberry(42);
  const jobId = {};
  JOBS.forEach(([key, name, short, department, color, rate, eventRole], i) => {
    const defaultRole = ['MGR', 'CHEF'].includes(key) ? 'manager' : key === 'BC' ? 'supervisor' : 'employee';
    jobId[key] = store.insert('jobCodes', { id: `job_${key.toLowerCase()}`, name, short, department, color, defaultRate: rate, order: i, eventRole, archived: false, defaultRole }).id;
  });

  const userId = {};
  const hash = hashPassword(password);
  for (const [i, [name, listedRole, jobs]] of PEOPLE.entries()) {
    const slug = name.toLowerCase().replace(/[^a-z]/g, '');
    const role = name === 'Courtney' ? 'supervisor' : listedRole; // a shift lead, to show the Supervisor role in the demo
    userId[name] = store.insert('users', {
      id: `usr_${slug}`, name, role, order: i + 1, email: `${slug}@demo.shiftboard`, phone: '',
      jobCodes: jobs.map((k, i) => ({ jobCodeId: jobId[k], rate: null, primary: i === 0 })),
      active: true, availability: {}, passwordHash: hash, createdAt: new Date().toISOString(),
    }).id;
  }
  // Sample availability
  store.update('users', userId['Liz'], { availability: { 4: { available: false } } });

  const laborRules = [
    { jobCodeId: jobId.SRV, daypart: 'Dinner', basis: 'covers', per: 22, min: 2 },
    { jobCodeId: jobId.SRV, daypart: 'Lunch', basis: 'covers', per: 25, min: 1 },
    { jobCodeId: jobId.FR, daypart: 'Dinner', basis: 'covers', per: 45, min: 1 },
    { jobCodeId: jobId.BUS, daypart: 'Dinner', basis: 'covers', per: 55, min: 1 },
    { jobCodeId: jobId.RBAR, daypart: 'Dinner', basis: 'sales', per: 4000, min: 1 },
    { jobCodeId: jobId.HOST, daypart: '', basis: 'fixed', per: 1, min: 1 },
    { jobCodeId: jobId.MGR, daypart: 'Dinner', basis: 'fixed', per: 2, min: 2 },
  ].map((r) => ({ id: uid('rule'), max: 0, ...r }));

  store.insert('settings', {
    ...DEFAULT_SETTINGS,
    restaurantName: 'Our Restaurant',
    closedDays: [1],
    hours: {
      0: { open: '10:00', close: '22:00' }, 1: { open: '', close: '' }, 2: { open: '11:00', close: '22:00' }, 3: { open: '11:00', close: '22:00' },
      4: { open: '11:00', close: '23:00' }, 5: { open: '11:00', close: '01:00' }, 6: { open: '10:00', close: '01:00' },
    },
    dayparts: [
      { name: 'Lunch', start: '11:00', end: '16:00', peak: '12:30', share: 0.15 },
      { name: 'Dinner', start: '16:00', end: '23:00', peak: '19:00', share: 0.85 },
    ],
    laborRules,
    demo: true,
  });

  // Events
  const eventId = {};
  for (const [key, e] of Object.entries(EVENTS)) {
    const { day: d, captain, staffing = [], ...rest } = e;
    eventId[key] = store.insert('events', {
      id: `evt_${key}`, ...rest, date: day(d), captainId: captain ? userId[captain] : null,
      staffing: staffing.map(([job, count, start], i) => ({ id: `stf_${key}_${i}`, jobCodeId: jobId[job], count, start, end: '', notes: '' })),
      menu: rest.menu || [], specialDrinks: rest.specialDrinks || [], timeline: rest.timeline || [], beverage: rest.beverage || {},
      createdAt: new Date().toISOString(),
    }).id;
  }

  // Shifts (published — this is the posted schedule)
  for (const [person, job, d, start, end, tag, evKey] of SHIFTS) {
    let staffingLineId = null;
    if (evKey) {
      const ev = store.get('events', eventId[evKey]);
      staffingLineId = ev.staffing.find((l) => l.jobCodeId === jobId[job])?.id || null;
    }
    store.insert('shifts', {
      id: uid('shf'), date: day(d), start, end: end || null, jobCodeId: jobId[job], userId: userId[person], tag: tag || '', notes: '', breakMin: 0,
      eventId: evKey && staffingLineId ? eventId[evKey] : null, staffingLineId, published: true, createdAt: new Date().toISOString(),
    });
  }
  // Unfilled event slots as open shifts
  for (const key of Object.keys(EVENTS)) {
    const ev = store.get('events', eventId[key]);
    for (const line of ev.staffing) {
      const have = store.list('shifts', (s) => s.staffingLineId === line.id).length;
      for (let i = have; i < line.count; i++) {
        store.insert('shifts', { id: uid('shf'), date: ev.date, start: line.start, end: null, jobCodeId: line.jobCodeId, userId: null, tag: 'EVT', notes: ev.name, breakMin: 0, eventId: ev.id, staffingLineId: line.id, published: true, createdAt: new Date().toISOString() });
      }
    }
  }

  for (const [person, a, b] of TIME_OFF) {
    store.insert('timeOff', { id: uid('tof'), userId: userId[person], startDate: day(a), endDate: day(b), reason: 'Request off', status: 'approved', createdAt: new Date().toISOString() });
  }
  store.insert('timeOff', { id: uid('tof'), userId: userId['Miguel'], startDate: addDays(WEEK, 12), endDate: addDays(WEEK, 13), reason: 'Family visiting', status: 'pending', createdAt: new Date().toISOString() });

  // Sample swap activity
  const find = (person, d) => store.list('shifts', (s) => s.userId === userId[person] && s.date === day(d))[0];
  const now = new Date().toISOString();
  const vThu = find('Victor', 'THU'), sFri = find('Styves', 'FRI');
  store.insert('requests', { id: uid('req'), type: 'swap', shiftId: vThu.id, targetShiftId: sFri.id, requesterId: userId['Victor'], targetUserId: userId['Styves'], status: 'pending_approval', note: 'Have a class Thursday night', createdAt: now, acceptedAt: now });
  const tSat = find('Tori', 'SAT');
  store.insert('requests', { id: uid('req'), type: 'drop', shiftId: tSat.id, requesterId: userId['Tori'], status: 'open', note: 'Anyone want the wedding? Great tips!', createdAt: now });
  const openWed = store.list('shifts', (s) => s.eventId === eventId.wedding && !s.userId && s.jobCodeId === jobId.SRV)[0];
  if (openWed) store.insert('requests', { id: uid('req'), type: 'pickup', shiftId: openWed.id, requesterId: userId['Manny'], pickupUserId: userId['Manny'], status: 'pending_approval', note: '', createdAt: now });

  // SAMPLE sales history: 16 weeks before the demo week (restaurant only, closed Mondays)
  const base = { 0: [85, 52], 2: [135, 58], 3: [120, 58], 4: [165, 61], 5: [235, 66], 6: [265, 68] };
  const rows = [];
  for (const date of range(addDays(WEEK, -7 * 16), 7 * 16 + 1)) {
    const b = base[dow(date)];
    if (!b) continue;
    const weeksAgo = Math.floor((new Date(WEEK) - new Date(date)) / (7 * 86400000));
    const growth = 1 + (16 - weeksAgo) * 0.004;
    const covers = Math.round(b[0] * growth * (0.88 + rand() * 0.24));
    rows.push({ id: date, date, covers, sales: Math.round(covers * b[1] * (0.95 + rand() * 0.1)), notes: '' });
  }
  for (const r of rows) store.insert('sales', r);

  // Welcome notifications
  for (const id of Object.values(userId)) {
    store.insert('notifications', { id: uid('ntf'), userId: id, text: 'The schedule for Sep 28 – Oct 4 is posted. Check your shifts.', link: '#/my', read: false, at: now });
  }
  return { userId, jobId, eventId };
}
