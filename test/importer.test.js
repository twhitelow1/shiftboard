import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parseSchedule, matchJob, matchEmployee, suggestJob, suggestRole, personName, titleCase } from '../core/importer.js';

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
  const alex = r.sections[0].rows[0];
  assert.deepEqual(alex.cells.map((c) => c.dow), [2, 4, 5, 6]);
  assert.equal(r.sections[0].rows[1].cells.filter((c) => c.parsed.timeOff).length, 3);
  assert.equal(r.sections[1].label, 'MOON RABBIT · BAR');
  assert.deepEqual(r.sections[1].rows[0].cells.map((c) => c.dow), [2, 4, 6]);
  assert.equal(matchJob('RESTAURANT · SERVER', [{ name: 'Server', short: 'SRV' }]).name, 'Server');
});

test('parseSchedule reads CSV', () => {
  const r = parseSchedule('date,employee,job,start,end,tag\n10/6/2026,Alex D,Server,4PM,,LIB\n2026-10-07,Kelly,Manager,11:00,17:00,');
  assert.equal(r.mode, 'csv');
  assert.equal(r.csvRows[0].date, '2026-10-06');
  assert.equal(r.csvRows[0].start, '16:00');
  assert.equal(r.csvRows[1].end, '17:00');
});

const JOBS = [['Manager', 'MGR'], ['Chef', 'CHEF'], ['Restaurant Bar', 'RBAR'], ['Server', 'SRV'], ['Food Runner', 'FR'], ['Busser', 'BUS'], ['Bartender', 'BAR'],
  ['Barback', 'BBK'], ['MR Bartender', 'MRB'], ['Cocktail Server', 'COC'], ['Restaurant Host', 'HOST'], ['Back Host Stand', 'BHST'], ['Doorman', 'DOOR']].map(([name, short]) => ({ name, short }));

test('section labels match the right job codes', () => {
  const cases = {
    'M.O.D.': 'Manager', RESTAURANT: 'Restaurant Bar', 'RESTAURANT · Servers': 'Server', 'RESTAURANT · Runners': 'Food Runner',
    'RESTAURANT · Bussers': 'Busser', 'RABBIT HOLE · Bar': 'Bartender', 'RABBIT HOLE · Barbacks': 'Barback', 'MOON RABBIT · Bar': 'MR Bartender',
    'MOON RABBIT · Cocktail': 'Cocktail Server', 'RESTAURANT HOST · Hosts': 'Restaurant Host', 'BACK HOST STAND · Hosts': 'Back Host Stand',
    'BACK HOST STAND · Doormen': 'Doorman',
  };
  for (const [label, job] of Object.entries(cases)) assert.equal(matchJob(label, JOBS)?.name, job, label);
  assert.equal(matchJob('PASTRY', JOBS), null);
});

test('new job code names and people names from a schedule', () => {
  const labels = ['M.O.D.', 'RESTAURANT · Servers', 'RABBIT HOLE · Bar', 'MOON RABBIT · Bar', 'RESTAURANT HOST · Hosts', 'BACK HOST STAND · Hosts', 'BACK HOST STAND · Doormen'];
  const s = (l) => suggestJob(l, labels);
  assert.deepEqual(s('M.O.D.'), { name: 'Manager', department: 'Leadership' });
  assert.deepEqual(s('RESTAURANT · Servers'), { name: 'Server', department: 'Restaurant' });
  assert.equal(s('RABBIT HOLE · Bar').name, 'Rabbit Hole Bartender');
  assert.equal(s('MOON RABBIT · Bar').name, 'Moon Rabbit Bartender');
  assert.equal(s('RESTAURANT HOST · Hosts').name, 'Restaurant Host');
  assert.equal(s('BACK HOST STAND · Hosts').name, 'Back Host Stand');
  assert.equal(s('BACK HOST STAND · Doormen').name, 'Doorman');
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
