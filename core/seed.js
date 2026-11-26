// Demo seed: the real week of 9/28/2026 transcribed from the house schedule PDF,
// plus SAMPLE sales history, pay rates and BEO details for demonstrating forecasting & events.
import { uid } from './store.js';
import { addDays, dow, range, prettyDate } from './time.js';
import { MSG } from './messages.js';
import { DEFAULT_SETTINGS } from './service.js';
import { findArea } from './areas.js';
import { seedDemoTips } from './tips.js';
import { seedTraining } from './training-seed.js';

const WEEK = '2026-09-28'; // Monday
const D = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };
const day = (k) => addDays(WEEK, D[k]);

// Positions (job codes). Where they're worked is the shift's area, not a separate job code.
const JOBS = [
  // key, name, short, department, color, rate, eventRole
  ['MGR', 'Manager', 'MGR', 'Leadership', '#334155', 28, false],
  ['CHEF', 'Chef', 'CHEF', 'Leadership', '#7c2d12', 30, false],
  ['BAR', 'Bartender', 'BAR', 'Bar', '#9333ea', 12, true],
  ['SRV', 'Server', 'SRV', 'Restaurant', '#2563eb', 12, true],
  ['FR', 'Food Runner', 'FR', 'Restaurant', '#16a34a', 14, true],
  ['BUS', 'Busser', 'BUS', 'Restaurant', '#65a30d', 14, true],
  ['BBK', 'Barback', 'BBK', 'Bar', '#a855f7', 15, false],
  ['COC', 'Cocktail Server', 'COC', 'Moon Rabbit', '#e11d48', 12, false],
  ['HOST', 'Host', 'HOST', 'Host', '#d97706', 17, true],
  ['DOOR', 'Doorman', 'DOOR', 'Host', '#475569', 18, false],
  ['BC', 'Banquet Captain', 'BC', 'Events', '#0f766e', 20, true],
];

// The schedule areas, in the house sheet's order (its banners).
const AREAS = ['Restaurant', 'Rabbit Hole', 'Moon Rabbit', 'Host Stand', 'Back Host Stand'];
// The house sheet's sections, as [position, area]. PEOPLE, SHIFTS and staffing below use these keys.
const SECTION = {
  MGR: ['MGR', ''], CHEF: ['CHEF', ''], BC: ['BC', ''],
  RBAR: ['BAR', 'Restaurant'], SRV: ['SRV', 'Restaurant'], FR: ['FR', 'Restaurant'], BUS: ['BUS', 'Restaurant'],
  BAR: ['BAR', 'Rabbit Hole'], BBK: ['BBK', 'Rabbit Hole'],
  MRB: ['BAR', 'Moon Rabbit'], COC: ['COC', 'Moon Rabbit'],
  HOST: ['HOST', 'Host Stand'], BHOST: ['HOST', 'Back Host Stand'], DOOR: ['DOOR', 'Back Host Stand'],
};

// name, role, sheet sections (see SECTION)
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

// [person, sheet section, day, start, end|null, tag, eventKey]
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

export function seedDemo(store, { hashPassword = (p) => `plain:${p}`, password = 'demo1234', now: clock = new Date() } = {}) {
  const rand = mulberry(42);
  const jobId = {};
  JOBS.forEach(([key, name, short, department, color, rate, eventRole], i) => {
    const defaultRole = ['MGR', 'CHEF'].includes(key) ? 'manager' : key === 'BC' ? 'supervisor' : 'employee';
    jobId[key] = store.insert('jobCodes', { id: `job_${key.toLowerCase()}`, name, short, department, color, defaultRate: rate, order: i, eventRole, archived: false, defaultRole }).id;
  });
  const position = (section) => jobId[SECTION[section][0]];
  const areaOf = (section) => SECTION[section][1];
  // One job code per position, listing every area the person works it in.
  const entriesFor = (sections) => {
    const out = [];
    for (const k of sections) {
      let e = out.find((x) => x.jobCodeId === position(k));
      if (!e) out.push(e = { jobCodeId: position(k), rate: null, primary: !out.length });
      if (areaOf(k) && !(e.areas || []).includes(areaOf(k))) e.areas = [...(e.areas || []), areaOf(k)];
    }
    return out;
  };

  const userId = {};
  const hash = hashPassword(password);
  for (const [i, [name, listedRole, jobs]] of PEOPLE.entries()) {
    const slug = name.toLowerCase().replace(/[^a-z]/g, '');
    const role = name === 'Courtney' ? 'supervisor' : listedRole; // a shift lead, to show the Supervisor role in the demo
    userId[name] = store.insert('users', {
      id: `usr_${slug}`, name, role, order: i + 1, email: `${slug}@demo.shiftboard`, phone: '',
      jobCodes: entriesFor(jobs),
      active: true, availability: {}, passwordHash: hash, createdAt: new Date().toISOString(),
    }).id;
  }
  // Sample availability
  store.update('users', userId['Liz'], { availability: { 4: { available: false } } });
  // A legal name for payroll that isn't the name everyone uses (core/names.js): Team shows "CJ (Carlos Javier Ortiz)" to admins.
  store.update('users', userId['CJ'], { legalFirstName: 'Carlos Javier', legalLastName: 'Ortiz' });

  const laborRules = [
    { jobCodeId: jobId.SRV, daypart: 'Dinner', basis: 'covers', per: 22, min: 2 },
    { jobCodeId: jobId.SRV, daypart: 'Lunch', basis: 'covers', per: 25, min: 1 },
    { jobCodeId: jobId.FR, daypart: 'Dinner', basis: 'covers', per: 45, min: 1 },
    { jobCodeId: jobId.BUS, daypart: 'Dinner', basis: 'covers', per: 55, min: 1 },
    { jobCodeId: jobId.BAR, daypart: 'Dinner', basis: 'sales', per: 4000, min: 1 },
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
    areas: AREAS,
    demo: true,
  });

  // Events
  const eventId = {};
  for (const [key, e] of Object.entries(EVENTS)) {
    const { day: d, captain, staffing = [], ...rest } = e;
    eventId[key] = store.insert('events', {
      id: `evt_${key}`, ...rest, date: day(d), captainId: captain ? userId[captain] : null,
      staffing: staffing.map(([section, count, start], i) => ({ id: `stf_${key}_${i}`, jobCodeId: position(section), count, start, end: '', notes: '' })),
      menu: rest.menu || [], specialDrinks: rest.specialDrinks || [], timeline: rest.timeline || [], beverage: rest.beverage || {},
      createdAt: new Date().toISOString(),
    }).id;
  }

  // Shifts (published — this is the posted schedule)
  for (const [person, section, d, start, end, tag, evKey] of SHIFTS) {
    let staffingLineId = null;
    if (evKey) {
      const ev = store.get('events', eventId[evKey]);
      staffingLineId = ev.staffing.find((l) => l.jobCodeId === position(section))?.id || null;
    }
    store.insert('shifts', {
      id: uid('shf'), date: day(d), start, end: end || null, jobCodeId: position(section), area: areaOf(section), userId: userId[person], tag: tag || '', notes: '', breakMin: 0,
      eventId: evKey && staffingLineId ? eventId[evKey] : null, staffingLineId, published: true, createdAt: new Date().toISOString(),
    });
  }
  // Unfilled event slots as open shifts
  for (const key of Object.keys(EVENTS)) {
    const ev = store.get('events', eventId[key]);
    for (const line of ev.staffing) {
      const have = store.list('shifts', (s) => s.staffingLineId === line.id).length;
      for (let i = have; i < line.count; i++) {
        store.insert('shifts', { id: uid('shf'), date: ev.date, start: line.start, end: null, jobCodeId: line.jobCodeId, userId: null, area: findArea(ev.room, AREAS) || '', tag: 'EVT', notes: ev.name, breakMin: 0, eventId: ev.id, staffingLineId: line.id, published: true, createdAt: new Date().toISOString() });
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

  // Welcome notifications, in both languages like the ones the app writes (core/service.js notify)
  const posted = { en: MSG.en.schedulePosted('Sep 28', 'Oct 4'), es: MSG.es.schedulePosted(prettyDate('2026-09-28', { lang: 'es', dow: false }), prettyDate('2026-10-04', { lang: 'es', dow: false })) };
  for (const id of Object.values(userId)) {
    store.insert('notifications', { id: uid('ntf'), userId: id, text: posted.en, i18n: posted, link: '#/my', read: false, at: now });
  }
  // SAMPLE venue: one location, rooms on three levels, floor plans for the Restaurant and Moon Rabbit
  store.insert('locations', { id: 'loc_main', name: 'Our Restaurant', address: '', order: 0 });
  const plan = (items) => ({
    width: 1000, height: 700,
    items: items.map(([type, x, y, w, h, label = '', seats = 0, r = 0], i) => ({ id: `itm_${i + 1}`, type, x, y, w, h, r, label, seats })),
  });
  const fourTops = [];
  [170, 310, 450].forEach((y, row) => [70, 210, 350].forEach((x, col) => fourTops.push(['table-square', x, y, 70, 70, `T${row * 3 + col + 1}`, 4])));
  const restaurantPlan = plan([
    ['door', 20, 620, 60, 60, 'Entry'],
    ['host', 100, 630, 80, 40, 'Host'],
    ['bar', 560, 40, 400, 60, 'Bar', 10],
    ...fourTops,
    ['booth', 560, 190, 150, 70, 'B1', 4],
    ['booth', 560, 310, 150, 70, 'B2', 4],
    ['booth', 560, 430, 150, 70, 'B3', 4],
    ['table-round', 790, 200, 100, 100, 'T10', 6],
    ['table-round', 790, 380, 100, 100, 'T11', 6],
    ['plant', 500, 630, 40, 40],
    ['wall', 0, 0, 1000, 10],
  ]);
  const moonPlan = plan([
    ['stage', 330, 20, 340, 130, 'Stage'],
    ['dj', 700, 50, 90, 60, 'DJ'],
    ['dancefloor', 360, 200, 280, 240, 'Dance floor'],
    ['bar', 30, 120, 60, 420, 'Bar', 8],
    ['door', 900, 620, 60, 60, 'Entry'],
    ...[[180, 200], [180, 330], [180, 460], [740, 220], [740, 350], [740, 480]].map(([x, y], i) => ['table-round', x, y, 60, 60, `HT${i + 1}`, 2]),
    ['label', 380, 600, 240, 40, 'Moon Rabbit'],
  ]);
  [
    ['room_restaurant', 'Restaurant', 'Main floor', ['dining'], 120, restaurantPlan],
    ['room_library', 'Library', 'Main floor', ['dining', 'events'], 40],
    ['room_patio', 'Patio', 'Main floor', ['dining'], 60],
    ['room_rabbithole', 'Rabbit Hole', 'Lower level', ['bar', 'events'], 150],
    ['room_moonrabbit', 'Moon Rabbit', 'Upstairs', ['bar', 'events'], 120, moonPlan],
  ].forEach(([id, name, level, kinds, capacity, p], order) => store.insert('rooms', {
    id, locationId: 'loc_main', name, level, kinds, capacity, order, plan: p || { width: 1000, height: 700, items: [] },
  }));
  // SAMPLE server sections (see core/venue-links.js): Friday dinner and the Saturday wedding in the
  // Restaurant, and Tuesday's happy hour in the Moon Rabbit. Table numbers are the plans' item numbers.
  const shiftOn = (person, d) => store.list('shifts', (s) => s.userId === userId[person] && s.date === day(d))[0];
  const sections = (roomId, d, list) => store.insert('sections', {
    id: `${roomId}|${day(d)}`, roomId, date: day(d), updatedAt: now, updatedBy: userId.Moe,
    entries: list.map(([person, items]) => ({ shiftId: shiftOn(person, d).id, tableIds: items.map((n) => `itm_${n}`) })),
  });
  sections('room_restaurant', 'FRI', [['Alex D', [4, 7, 10]], ['Styves', [5, 8, 11]], ['Andrea', [6, 9, 12]], ['Jonathan', [13, 14, 15, 16, 17]], ['Karen', [3]]]);
  sections('room_restaurant', 'SAT', [['Styves', [4, 5, 6]], ['Victor', [7, 8, 9]], ['Tori', [10, 11, 12]], ['Andrea', [13, 14, 15]], ['Jonathan', [16, 17]], ['Karen', [3]], ['Alex D', []]]);
  sections('room_moonrabbit', 'TUE', [['Todd', [4]], ['Romina', []], ['Agustina', [6, 7, 8]], ['Andrea', [9, 10, 11]], ['Alex D', []]]);

  // SAMPLE tips: a house pool and a Rabbit Hole pool, with tips entered for the demo week (core/tips.js).
  seedDemoTips(store, { week: WEEK, jobId, userId });

  // SAMPLE clock-ins (as if synced from Toast) for Forecast & Labor → Labor review: core/labor-demo.js
  seedLaborDemo(store, { week: WEEK });
  // SAMPLE training: an invented menu with placeholder photos, quizzes and tries, the employee manual (core/training-seed.js)
  seedTraining(store, { userId, jobId });
  // SAMPLE 86 List: Bar, Moon Rabbit bar and Kitchen, a few items out or low now, and a month of history (core/eighty-six.js)
  seedEightySix(store, { userId, now: clock });
  // SAMPLE ADP clock-ins for two days, from a pretend timecard import (seedAdpDemo, at the end of this file)
  seedAdpDemo(store, { week: WEEK });
  // SAMPLE event from Tripleseat (Events & BEOs), as a sync brings it in: seedTripleseatDemo, at the end of this file
  seedTripleseatDemo(store, { week: WEEK, userId });

  return { userId, jobId, eventId };
}

import { seedLaborDemo } from './labor-demo.js';
import { seedEightySix } from './eighty-six.js';

// ---------- SAMPLE ADP time entries (Forecast & Labor, Settings → Integrations → ADP) ----------
// As if last Friday's and Saturday's ADP timecard export had been imported (core/adp.js): demo people
// only, invented employee IDs, punches rounded to the quarter hour the way time clocks round them,
// no tips (ADP time data has none; Toast's tips still count). The clock-in source is "both (ADP
// wins)", so these replace those people's Toast clock-ins on those two days and Toast covers the rest.
function seedAdpDemo(store, { week }) {
  const days = [addDays(week, -3), addDays(week, -2)]; // Fri and Sat of the week before
  const people = ['Alex D', 'Styves', 'Andrea', 'Jonathan', 'Karen', 'Victor', 'Tori', 'Chef Lucas'];
  const users = store.list('users').filter((u) => people.includes(u.name));
  const q = (stamp) => { // round a local 'YYYY-MM-DDTHH:MM' to the quarter hour
    const [d, t] = stamp.split('T');
    let m = Math.round((Number(t.slice(0, 2)) * 60 + Number(t.slice(3))) / 15) * 15;
    const day = m >= 1440 ? addDays(d, 1) : d;
    m %= 1440;
    return `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const mins = (a, b) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
  const at = `${addDays(week, -1)}T15:00:00.000Z`;
  const depts = new Map();
  let n = 0;
  for (const [i, u] of users.entries()) {
    const fileNo = String(1001 + i * 7).padStart(6, '0');
    const workerId = `id:${Number(fileNo)}`;
    store.update('users', u.id, { adpId: fileNo });
    store.insert('adpWorkers', { id: workerId, origin: 'csv', aoid: null, name: u.name, first: u.name.split(' ')[0], last: u.name.split(' ')[1] || '',
      email: '', ids: [String(Number(fileNo))], employeeId: fileNo, department: '', deleted: false, userId: u.id, matchedBy: 'id', seenAt: at });
    for (const date of days) {
      const toast = store.list('timeEntries', (t) => t.source === 'toast' && t.userId === u.id && t.date === date)[0];
      if (!toast?.inLocal || !toast?.outLocal) continue;
      const job = store.get('jobCodes', toast.jobCodeId);
      const dept = job ? `${job.name}s` : '';
      if (dept && !depts.has(dept)) depts.set(dept, { id: `dept:${dept.toLowerCase()}`, title: dept, jobCodeId: job.id, matchedBy: 'name', seenAt: at });
      const inLocal = q(toast.inLocal), outLocal = q(toast.outLocal);
      const breakMinutes = mins(inLocal, outLocal) > 6 * 60 ? 30 : 0;
      const hours = Math.round(((mins(inLocal, outLocal) - breakMinutes) / 60) * 100) / 100;
      store.insert('timeEntries', {
        id: `adp_demo_${++n}`, source: 'adp', origin: 'csv', externalId: `demo-${n}`, demo: true, date, userId: u.id, jobCodeId: toast.jobCodeId, jobFrom: dept ? 'dept' : 'schedule',
        adpWorkerId: workerId, adpName: u.name, adpEmployeeId: fileNo, adpJobId: dept ? `dept:${dept.toLowerCase()}` : null, adpDept: dept, payCode: 'REG',
        inAt: null, outAt: null, inLocal, outLocal, regularHours: hours, overtimeHours: null, hourlyWage: null,
        declaredCashTips: null, nonCashTips: null, breakMinutes, autoClockedOut: false, noClockOut: false, importId: 'imp_demo', syncedAt: at,
      });
    }
  }
  for (const d of depts.values()) store.insert('adpJobs', d);
  const counts = { rows: n, new: n, updated: 0, same: 0, duplicate: 0, fromApi: 0, unmatched: 0, noPosition: 0, overnight: 0, noClockOut: 0, removed: 0 };
  const lastImport = { id: 'imp_demo', at, by: null, fileName: 'timecard-report-demo.csv', from: days[0], to: days[1], counts };
  store.insert('integrations', { id: 'adp', lastImport, imports: [lastImport] });
  store.update('settings', 'settings', { clockSource: 'both' });
  return { entries: n };
}

// ---------- SAMPLE event from Tripleseat (Events & BEOs; core/tripleseat.js) ----------
// One invented booking the way a Tripleseat sync stores it: the booking fields from "Tripleseat" (date,
// times, guests, room, status, type, menu, drinks, notes), no staffing yet so the BEO offers "Suggest
// staffing", and no link (there's no real Tripleseat account behind the demo). Demo data only.
function seedTripleseatDemo(store, { week, userId }) {
  const at = `${addDays(week, -1)}T16:00:00.000Z`;
  store.insert('events', {
    id: 'evt_ts_900001', source: 'tripleseat', externalId: '900001',
    name: 'Larkspur Book Club Anniversary Dinner', date: addDays(week, 10), start: '18:30', end: '21:30', guestCount: 40, guaranteed: 38,
    status: 'confirmed', type: 'Private dinner', room: 'Library', roomId: 'room_library', serviceStyle: 'plated', client: '', captainId: null,
    menu: [
      { course: 'Passed appetizers', item: 'Seasonal crostini × 40', notes: '' },
      { course: 'First course', item: 'Little gem salad × 40', notes: '' },
      { course: 'Entrée', item: 'Roast chicken or mushroom risotto × 40', notes: 'Counts by entrée a week out' },
      { course: 'Dessert', item: 'Olive oil cake × 40', notes: '' },
    ],
    beverage: { package: 'House wine pairing × 40 · Sparkling toast × 40', bar: '', notes: '' },
    specialDrinks: [], staffing: [], timeline: [], setupNotes: '', dietaryNotes: '', avNotes: '', attire: '', notes: '',
    tsNotes: 'Anniversary toast at 8:00. Two guests are vegetarian.',
    createdAt: at, createdBy: 'tripleseat',
    tripleseat: {
      id: '900001', status: 'definite', bookingId: '700001', locationId: '1', locationName: 'Our Restaurant', rooms: [{ id: '5001', name: 'Library' }],
      owner: store.get('users', userId['Kelly'])?.name || '', url: null, updatedAt: at, menuFor: at,
      owns: ['name', 'date', 'start', 'end', 'guestCount', 'status', 'room', 'guaranteed', 'type', 'tsNotes', 'menu', 'beverage'], review: [], syncedAt: at,
    },
  });
  store.insert('tripleseatRooms', { id: 'tsr_5001', tsId: '5001', name: 'Library', locationId: '1', locationName: 'Our Restaurant', roomId: 'room_library', matchedBy: 'name', seenAt: at });
}
