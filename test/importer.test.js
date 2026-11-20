import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parseSchedule, readSections, matchPosition, positionName, departmentFor, matchEmployee, suggestRole, personName, titleCase } from '../core/importer.js';
import { scheduleAreas, findArea, uniqueAreas } from '../core/areas.js';

test('parseCell handles restaurant shorthand', () => {
  assert.deepEqual(parseCell('4PM'), { start: '16:00', end: null, tag: '' });
  assert.deepEqual(parseCell('3:30PM BC'), { start: '15:30', end: null, tag: 'BC' });
  assert.deepEqual(parseCell('12-4PM'), { start: '12:00', end: '16:00', tag: '' });
  assert.deepEqual(parseCell('3:00PM-9PM'), { start: '15:00', end: '21:00', tag: '' });
  assert.deepEqual(parseCell('10AM-6PM'), { start: '10:00', end: '18:00', tag: '' });
  assert.deepEqual(parseCell('4:30PM BACK HOST*'), { start: '16:30', end: null, tag: 'BACK HOST*' });
  assert.deepEqual(parseCell('11AM'), { start: '11:00', end: null, tag: '' });
  assert.equal(parseCell('OFF'), null);
  assert.equal(parseCell('REQUEST OFF').timeOff, true);
});

test('parseSchedule reads a pasted grid with banners and a mistyped header', () => {
  const t = [
    'RESTAURANT',
    '########\t9/29/2026\t9/30/2026\t10/1/2026\t10/2/2026\t10/3/2026\t########',
    'SERVER\tMONDAY\tTUESDAY\tWEDNESDAY\tTHURSDAY\tFRIDAY\tSATURDAY\tSUNDAY',
    'ALEX D\tOFF\t3:30PM BC\tOFF\t4PM\t4:30PM*\t3:30PM BC\tOFF',
    'VICTOR\tREQUEST OFF\tREQUEST OFF\t4:30PM\t4:30PM\tOFF\t4PM\tREQUEST OFF',
    'MOON RABBIT',
    'BAR\tOFF\tTUESDAY\tWEDNESDAY\tTHURSDAY\tFRIDAY\tSATURDAY\tSUNDAY',
    'TODD\tOFF\t4PM\tOFF\t5PM\tOFF\t4PM\tOFF',
  ].join('\n');
  const r = parseSchedule(t);
  assert.equal(r.mode, 'grid');
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[0].label, 'RESTAURANT · SERVER');
  assert.deepEqual([r.sections[0].banner, r.sections[0].role], ['RESTAURANT', 'SERVER']);
  const alex = r.sections[0].rows[0];
  assert.deepEqual(alex.cells.map((c) => c.dow), [2, 4, 5, 6]);
  assert.equal(r.sections[0].rows[1].cells.filter((c) => c.parsed.timeOff).length, 3);
  assert.equal(r.sections[1].label, 'MOON RABBIT · BAR');
  assert.deepEqual(r.sections[1].rows[0].cells.map((c) => c.dow), [2, 4, 6]);
  assert.equal(matchPosition(r.sections[0].role, [{ name: 'Server', short: 'SRV' }]).name, 'Server');
});

test('parseSchedule reads CSV', () => {
  const r = parseSchedule('date,employee,job,area,start,end,tag\n10/6/2026,Alex D,Server,Restaurant,4PM,,LIB\n2026-10-07,Kelly,Manager,,11:00,17:00,');
  assert.equal(r.mode, 'csv');
  assert.equal(r.csvRows[0].date, '2026-10-06');
  assert.equal(r.csvRows[0].start, '16:00');
  assert.equal(r.csvRows[1].end, '17:00');
  assert.deepEqual(r.csvRows.map((x) => x.area), ['Restaurant', '']);
});

// The shape of a real sheet (synthetic names): banners are areas, section labels are positions.
const SECTIONS = [
  { label: 'M.O.D.', banner: 'M.O.D.', role: '', rows: [{ name: 'PAT' }] },
  { label: 'RESTAURANT', banner: 'RESTAURANT', role: '', rows: [{ name: 'LOU' }, { name: 'KAI' }, { name: 'SAM' }] },
  { label: 'RESTAURANT · Servers', banner: 'RESTAURANT', role: 'Servers', rows: [{ name: 'ALEX D' }] },
  { label: 'RABBIT HOLE · Bar', banner: 'RABBIT HOLE', role: 'Bar', rows: [{ name: 'MAX' }, { name: 'SAM' }] },
  { label: 'RABBIT HOLE · Barbacks', banner: 'RABBIT HOLE', role: 'Barbacks', rows: [{ name: 'HAN' }] },
  { label: 'MOON RABBIT · Bar', banner: 'MOON RABBIT', role: 'Bar', rows: [{ name: 'SAM' }] },
  { label: 'BACK HOST STAND · Hosts', banner: 'BACK HOST STAND', role: 'Hosts', rows: [{ name: 'NIA' }] },
  { label: 'BACK HOST STAND · Doormen', banner: 'BACK HOST STAND', role: 'Doormen', rows: [{ name: 'JON' }] },
  { label: 'BAKERY', banner: 'BAKERY', role: '', rows: [{ name: 'NEW PERSON' }] },
];

test('banners become areas and section labels become positions', () => {
  const r = readSections(SECTIONS);
  assert.deepEqual(r.map((x) => [x.area, x.position, x.inferred]), [
    ['', 'M.O.D.', false], // a banner that names a position, not a place
    ['RESTAURANT', 'Bar', true], // no label: Sam works "Bar" in two other sections
    ['RESTAURANT', 'Servers', false],
    ['RABBIT HOLE', 'Bar', false],
    ['RABBIT HOLE', 'Barbacks', false],
    ['MOON RABBIT', 'Bar', false],
    ['BACK HOST STAND', 'Hosts', false],
    ['BACK HOST STAND', 'Doormen', false],
    ['BAKERY', 'Staff', true], // nobody to learn from
  ]);
  assert.deepEqual(['M.O.D.', 'Bar', 'Servers', 'Runners', 'Barbacks', 'Cocktail', 'Hosts', 'Doormen', 'Banquet Captains'].map(positionName),
    ['Manager', 'Bartender', 'Server', 'Food Runner', 'Barback', 'Cocktail Server', 'Host', 'Doorman', 'Banquet Captain']);
  assert.equal(departmentFor('M.O.D.', ''), 'Leadership');
  assert.equal(departmentFor('Bar', 'RABBIT HOLE'), 'Rabbit Hole');
});

test('positions match job codes by position only', () => {
  const JOBS = [['Manager', 'MGR'], ['Server', 'SRV'], ['Food Runner', 'FR'], ['Busser', 'BUS'], ['Bartender', 'BAR'], ['Barback', 'BBK'],
    ['Cocktail Server', 'COC'], ['Host', 'HOST'], ['Doorman', 'DOOR']].map(([name, short]) => ({ name, short }));
  const cases = { 'M.O.D.': 'Manager', Servers: 'Server', Runners: 'Food Runner', Bussers: 'Busser', Bar: 'Bartender', Barbacks: 'Barback',
    Cocktail: 'Cocktail Server', Hosts: 'Host', Doormen: 'Doorman' };
  for (const [label, job] of Object.entries(cases)) assert.equal(matchPosition(label, JOBS)?.name, job, label);
  assert.equal(matchPosition('Pastry', JOBS), null);
  // Job codes named after a banner (from the first importer) are not positions: Bar → new Bartender.
  const old = ['Restaurant', 'Rabbit Hole Bartender', 'Moon Rabbit Bartender', 'Barback', 'Restaurant Host', 'Back Host Stand'].map((name) => ({ name, short: '' }));
  assert.equal(matchPosition('Bar', old), null, '"Bar" never matches Barback or a banner job');
  assert.equal(matchPosition('Hosts', old), null);
  assert.equal(matchPosition('Barbacks', old)?.name, 'Barback');
});

test('schedule areas: the sheet order first, then rooms', () => {
  const st = { areas: ['Restaurant', 'Back Host Stand'], rooms: ['Restaurant', 'Library', 'Full Buyout'] };
  assert.deepEqual(scheduleAreas(st), ['Restaurant', 'Back Host Stand', 'Library'], 'no duplicates, booking-only rooms left out');
  assert.equal(findArea('BACK HOST STAND', scheduleAreas(st)), 'Back Host Stand');
  assert.equal(findArea('Patio', scheduleAreas(st)), null);
  assert.deepEqual(uniqueAreas([' Moon  Rabbit ', 'moon rabbit', '', 'Patio']), ['Moon Rabbit', 'Patio']);
});

test('people names and matching', () => {
  assert.deepEqual(['ALEX D', 'CJ', 'MARYANN'].map(personName), ['Alex D', 'CJ', 'Maryann']);
  assert.equal(titleCase('CHANG/SMITH WEDDING RECEPTION OF THE YEAR'), 'Chang/Smith Wedding Reception of the Year');
  const people = [{ name: 'Mary Ann' }, { name: 'Chef Lucas' }, { name: 'Alex D' }];
  assert.equal(matchEmployee('MARYANN', people)?.name, 'Mary Ann');
  assert.equal(matchEmployee('LUCAS', people)?.name, 'Chef Lucas');
  assert.equal(matchEmployee('ALEX S', people), null);
});

test('role guesses for new sections', () => {
  assert.deepEqual(['M.O.D.', 'RESTAURANT · Servers', 'EVENTS · Banquet Captain', 'BAR · Bar Lead', 'Manager'].map(suggestRole),
    ['manager', 'employee', 'supervisor', 'supervisor', 'manager']);
});
