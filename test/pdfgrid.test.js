import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToGridText, fillRects, labelColors } from '../core/pdfgrid.js';
import { parseSchedule, notesToEvents } from '../core/importer.js';

// Same geometry as the house schedule exported from Excel to PDF (letter page, 4.6pt cells,
// 3.7pt notes, banners in merged cells mid-table). Names are made up.
const COLS = [127, 200, 274, 340, 404, 473, 532];
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const it = (str, cx, y, h = 4.6) => ({ str, x: cx - str.length * 1.2, y, w: str.length * 2.4, h });
const row = (y, name, cells, label = name) => [
  ...(label ? [it(label, 70, y)] : []),
  ...cells.map((c, i) => (c == null ? null : it(c, COLS[i], y))).filter(Boolean),
];

function samplePage() {
  return [
    it('M.O.D.', 305, 61, 7.4),
    ...['11/16/2026', '11/17/2026', '11/18/2026', '11/19/2026', '11/20/2026', '11/21/2026', '11/22/2026'].map((d, i) => it(d, COLS[i], 70.8)),
    ...DAYS.map((d, i) => it(d, COLS[i], 77.1)),
    ...row(83.3, 'PAT', ['OFF', 'OFF', '6PM', '12PM', '12PM', '12PM', 'OFF']),
    ...row(89.5, 'SAM', ['WOH', '11AM', '12PM', 'OFF', 'OFF', 'OFF', 'OFF']),
    // Event notes: Thursday has two events, Friday a note then an event.
    it('GALA NIGHT FULL BUYOUT', COLS[3], 133.1, 3.7), it('150 PPL', COLS[3], 138, 3.7),
    it('OPENING DAY', COLS[4], 143.7, 3.7),
    it('ART RECEPTION', COLS[3], 151.8, 3.7), it('100 PPL MOON RABBIT', COLS[3], 156.7, 3.7),
    it('SMITH BIRTHDAY PARTY', COLS[4], 151.8, 3.7), it('16PPL RESTAURANT', COLS[4], 156.7, 3.7),
    it('CLOSED', COLS[0], 151.9, 3.7), it('CLOSED', COLS[1], 151.9, 3.7),
    it('Projected Covers', 70, 176.9), ...[0, 0, 0, 250, 83, 160, 16].map((n, i) => it(String(n), COLS[i], 177.4, 3.7)),
    it('RESTAURANT', 70, 183.1, 6.1),
    ...DAYS.map((d, i) => it(d, COLS[i], 190)),
    ...row(196, 'JO', ['OFF', 'OFF', '6:30PM', '3:30PM', '3:30PM', '3PM', 'OFF']),
    ...row(216, 'Servers', DAYS),
    ...row(224.2, 'ALEX Q', ['OFF', 'OFF', '6:30PM', '3:30PM BC', 'OFF', '2:30PM BC', 'REQUEST OFF']),
    it('RABBIT HOLE', 181, 385.7, 6.6), // banner sits over the Tuesday column
    ...row(392.6, 'Bar', DAYS),
    ...row(407, 'RIO', ['OFF', 'OFF', '6:30PM', '3:30PM MR', '5PM', '3PM MR', 'OFF']),
    ...row(425.7, 'KAI', ['OFF', 'OFF', '6:30PM', null, 'OFF', 'OFF', 'OFF']), // blank Thursday cell
    it('RESTAURANT HOST', 181, 564.2, 6.1),
    ...row(570.2, 'Hosts', DAYS),
    ...row(578.4, 'LIV', ['OFF', 'OFF', '1-9PM*', '1-9PM', '1-9PM', '1-9PM', '1-9PM']),
    it('Notes:', 70, 685.9),
  ];
}

test('rebuilds the grid from PDF text positions', () => {
  const lines = itemsToGridText(samplePage()).split('\n').map((l) => l.split('\t'));
  assert.deepEqual(lines[0], ['M.O.D.']);
  assert.equal(lines[1][1], '11/16/2026');
  assert.deepEqual(lines.find((l) => l[0] === 'SAM'), ['SAM', 'WOH', '11AM', '12PM', 'OFF', 'OFF', 'OFF', 'OFF']);
  // Note paragraphs: one row per stacked event, per day column.
  const notes = lines.filter((l) => l[0] === '' && l.slice(1).some((c) => /PPL|CLOSED|OPENING/.test(c)));
  assert.deepEqual(notes[0].slice(1, 6), ['CLOSED', 'CLOSED', '', 'GALA NIGHT FULL BUYOUT 150 PPL', 'OPENING DAY']);
  assert.deepEqual(notes[1].slice(4, 6), ['ART RECEPTION 100 PPL MOON RABBIT', 'SMITH BIRTHDAY PARTY 16PPL RESTAURANT']);
  assert.deepEqual(lines.find((l) => l[0] === 'RABBIT HOLE'), ['RABBIT HOLE'], 'mid-table banner moved to the name column');
  assert.deepEqual(lines.find((l) => l[0] === 'KAI'), ['KAI', 'OFF', 'OFF', '6:30PM', '', 'OFF', 'OFF', 'OFF'], 'blank cell keeps its column');
  assert.equal(itemsToGridText([it('Just a memo', 100, 100)]), '', 'no day header → not a schedule');
});

test('a PDF schedule parses into sections, the week, notes, events and covers', () => {
  const p = parseSchedule(itemsToGridText(samplePage()));
  assert.equal(p.mode, 'grid');
  assert.equal(p.weekOf, '2026-11-16');
  assert.deepEqual(p.sections.map((s) => s.label), ['M.O.D.', 'RESTAURANT', 'RESTAURANT · Servers', 'RABBIT HOLE · Bar', 'RESTAURANT HOST · Hosts']);
  const alex = p.sections[2].rows[0];
  assert.deepEqual(alex.cells.map((c) => [c.dow, c.parsed.start, c.parsed.timeOff ? true : c.parsed.tag]), [[3, '18:30', ''], [4, '15:30', 'BC'], [6, '14:30', 'BC'], [0, undefined, true]]);
  assert.deepEqual(p.sections[3].rows[1].cells.map((c) => c.dow), [3], 'KAI only works Wednesday');
  assert.deepEqual(p.sections[4].rows[0].cells[0].parsed, { start: '13:00', end: '21:00', tag: '*' });
  assert.deepEqual(p.problems, [`SAM (monday): couldn't read "WOH"`]);
  assert.deepEqual(p.covers.map((c) => c.covers), [0, 0, 0, 250, 83, 160, 16]);
  const { events, dayNotes } = notesToEvents(p.notes, ['Restaurant', 'Moon Rabbit', 'Full Buyout']);
  assert.deepEqual(events.map((e) => [e.dow, e.name, e.room, e.guestCount, e.type]), [
    [4, 'Gala Night', 'Full Buyout', 150, 'Fundraiser'],
    [4, 'Art Reception', 'Moon Rabbit', 100, ''],
    [5, 'Smith Birthday Party', 'Restaurant', 16, 'Party'],
  ]);
  assert.deepEqual(dayNotes.map((n) => n.text), ['CLOSED', 'CLOSED', 'OPENING DAY']);
});

test('reads cell colors behind labels from the PDF drawing', () => {
  const OPS = { save: 1, restore: 2, setFillRGBColor: 3, constructPath: 4, fill: 5, eoFill: 6, eoClip: 7, setFillGray: 8 };
  const fn = [OPS.save, OPS.constructPath, OPS.setFillRGBColor, OPS.constructPath, OPS.restore, OPS.setFillRGBColor, OPS.constructPath, OPS.setFillRGBColor, OPS.constructPath];
  const args = [null, [OPS.eoClip, [], [0, 0, 600, 800]], ['#FC3AD2'], [OPS.fill, [], [50, 700, 550, 712]], null,
    [255, 255, 0], [OPS.fill, [], [90, 680, 230, 690]], ['#a9d08e'], [OPS.fill, [], [50, 600, 550, 612]]];
  const rects = fillRects(fn, args, OPS, 792);
  assert.deepEqual(rects.map((r) => [r.color, r.top, r.bottom]), [['#fc3ad2', 80, 92], ['#ffff00', 102, 112], ['#a9d08e', 180, 192]], 'clip paths are not fills');
  const words = [{ str: 'M.O.D.', x: 290, y: 82, w: 20, h: 8 }, { str: 'OFF', x: 150, y: 103, w: 10, h: 6 }, { str: 'Rabbit  Hole', x: 280, y: 182, w: 40, h: 8 }, { str: 'LUCAS', x: 60, y: 300, w: 20, h: 6 }];
  assert.deepEqual(labelColors(words, rects), { 'M.O.D.': '#fc3ad2', 'RABBIT HOLE': '#a9d08e' }, 'yellow OFF cells and uncolored text are left out');
});
