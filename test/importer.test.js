import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parseSchedule, matchJob } from '../core/importer.js';

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
