// The availability import from the house schedule workbook (an invented look-alike, built here: tabs, room banners,
// position headers, theme-coloured fills with tints, real Excel dates and times, merged cells). Every name is invented.
//   - colours: green REQ OFF = standing, yellow REQ OFF = that date only, light green = another room, OFF = nothing
//   - the standing tab replaces a sheet's standing requests (removals are asked), week tabs give dated time off
//   - matching by the sheet's names, the section's position to tell two people apart, never a new person
//   - flagged cells are decided, never guessed; room suggestions only when ticked
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { readWorkbook, colorFamily, readXlsx } from '../core/smart-import.js';
import { parseHouseTab, houseRecords, houseColors, isHouseWorkbook } from '../core/house-grid.js';
import { makeXlsx } from './helpers/xlsx.js';

const NOW = new Date(2026, 11, 28, 12);
const GREEN = { theme: 9, tint: 0.4 }; // accent6, 40% lighter: a standing request off
const LIGHT = { theme: 6, tint: 0.8 }; // accent3, 80% lighter: working in another room
const YELLOW = { rgb: 'FFFF00' };
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const WEEK = ['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08', '2027-01-09', '2027-01-10'];

/** One tab of the house grid. people: [[ 'ROOM/Position', name, [7 cells] ]]; dates: the week's, or null (standing tab). */
function houseTab(name, dates, people) {
  const rows = [[], [{ text: 'M.O.D.', fill: { rgb: 'FC3AD2' } }, ...Array(7).fill({ fill: { rgb: 'FC3AD2' } })],
    ['', ...(dates ? dates.map((d) => ({ date: d })) : Array(7).fill(''))], ['', ...DAYS],
    ['QUILL', 'WOH', '4PM', { time: '04:30' }, '', '', 'OFF', ''], ['', 'MEETING', 'CLOSED', '', '', '', '', ''], ['Projected Covers', '210', '180', '', '', '', '', '']];
  let section = null;
  for (const [sec, who, cells] of people) {
    if (sec !== section) {
      section = sec;
      const [room, position] = sec.split('/');
      const fill = room === 'RESTAURANT' ? { rgb: '0070C0' } : { rgb: 'A9D08E' };
      rows.push([{ text: room, fill }, ...Array(7).fill({ fill })]);
      rows.push([{ text: position, fill }, ...DAYS]);
    }
    rows.push([who, ...cells]);
  }
  return { name, rows, merges: ['C6:C7'] };
}
function workbook() {
  const standing = houseTab('STANDING REQUESTS OFF', null, [
    ['RESTAURANT/Servers', 'JUNO', [{ text: 'REQ OFF', fill: GREEN }, '', '', '', '', '', '']],
    ['RESTAURANT/Servers', 'ALEX ', ['', '', '', '', '', '', '']],
    ['RABBIT HOLE/Bar', 'PIPER', ['', '', '', '', '', '', { text: 'REQ OFF', fill: GREEN }]],
    ['RABBIT HOLE/Bar', 'SAM', ['', '', { text: 'REQ OFF', fill: GREEN }, '', '', '', '']],
    ['RABBIT HOLE/Bar', 'ZEPHYR', [{ text: 'REQ OFF', fill: GREEN }, '', '', '', '', '', '']],
  ]);
  const week = houseTab('1.4.2027-1.10.2027', WEEK, [
    ['RESTAURANT/Servers', 'JUNO', [{ text: 'REQ OFF', fill: GREEN }, '4PM', { time: '16:30' }, { text: 'OFF', fill: YELLOW }, { text: 'REQ OFF', fill: YELLOW }, { text: '5PM MOON', fill: LIGHT }, { text: 'REQ OFF or', fill: GREEN }]],
    ['RESTAURANT/Servers', 'ALEX ', ['', { text: 'REQ OFF', fill: GREEN }, '', '', '', '', '']],
    ['RABBIT HOLE/Bar', 'PIPER', ['3:30PM TRAIN', '1-9PM*', '', '', '', '', { text: 'REQ OFF', fill: GREEN }]],
    ['RABBIT HOLE/Bar', 'JUNO', ['4PM', '', '', '', '', '', '']], // also in the bar: one person, one cell per day
    ['RABBIT HOLE/Bar', 'ALEX', ['', '', '6:30PM', '', '', '', '']],
  ]);
  return makeXlsx([standing, week]);
}
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (doc) => store.insert('users', { role: 'employee', active: true, availability: {}, ...doc });
  add({ id: 'usr_t_juno', name: 'Juno Vale', sheetName: 'JUNO', jobCodes: [{ jobCodeId: 'job_srv', primary: true }, { jobCodeId: 'job_bar' }],
    availability: { 3: { available: false, standing: true, requestedAt: '2026-01-05T12:00:00.000Z', source: 'sheet', note: 'REQ OFF' } } });
  add({ id: 'usr_t_piper', name: 'Piper Lane', sheetName: 'PIPER', jobCodes: [{ jobCodeId: 'job_bar', primary: true }] });
  add({ id: 'usr_t_alexs', name: 'Alex Stone', sheetName: 'ALEX', jobCodes: [{ jobCodeId: 'job_bar', primary: true }] });
  add({ id: 'usr_t_alexr', name: 'Alex Rowe', sheetName: 'ALEX', jobCodes: [{ jobCodeId: 'job_srv', primary: true }] });
  add({ id: 'usr_t_sambar', name: 'Sam Pell', sheetName: 'SAM', jobCodes: [{ jobCodeId: 'job_bar', primary: true }] });
  add({ id: 'usr_t_samhost', name: 'Sam Ortiz', sheetName: 'SAM', jobCodes: [{ jobCodeId: 'job_host', primary: true }] });
  const mgr = store.list('users', (u) => u.role === 'manager')[0];
  return { store, mgr, call: (u, m, a = {}) => svc.call(store.get('users', u.id), m, a), user: (id) => store.get('users', id) };
}

test('reading it: theme fills with tints, real dates and times, banners, sections, merged cells', () => {
  const bytes = workbook();
  const book = readWorkbook(bytes);
  assert.deepEqual(book.map((s) => s.name), ['STANDING REQUESTS OFF', '1.4.2027-1.10.2027']);
  assert.ok(isHouseWorkbook(book));
  assert.ok(readXlsx(bytes).length > 5, 'the plain reader still reads the first tab');
  const juno = book[1].rows[9];
  assert.equal(juno[0].text, 'JUNO');
  assert.equal(colorFamily(juno[1].fill), 'green', 'theme 9 with a 0.4 tint');
  assert.equal(colorFamily(juno[5].fill), 'yellow');
  assert.equal(colorFamily(juno[6].fill), 'lightGreen', 'theme 6 with a 0.8 tint');
  assert.equal(juno[3].time, '16:30');
  assert.equal(book[1].rows[2][1].date, '2027-01-04');
  assert.ok(book[1].rows[6][2].merged, 'C7 is covered by C6:C7');
  const tabs = book.map(parseHouseTab);
  assert.deepEqual([tabs[0].kind, tabs[1].kind, tabs[1].weekOf], ['standing', 'week', '2027-01-04']);
  assert.deepEqual(tabs[1].people.map((p) => p.name), ['QUILL', 'JUNO', 'ALEX', 'PIPER'], 'no trailing space; JUNO and ALEX once each');
  assert.deepEqual(tabs[1].people.find((p) => p.name === 'JUNO').sections.map((s) => `${s.room}/${s.position}`), ['RESTAURANT/Servers', 'RABBIT HOLE/Bar']);
  const recs = houseRecords(tabs);
  const h = (n) => recs.find((r) => r.values.name === n).house;
  assert.deepEqual(h('JUNO').standing, [1], 'green REQ OFF on the standing tab');
  assert.deepEqual(h('JUNO').dated.map((x) => x.date), ['2027-01-08'], 'yellow REQ OFF on a week tab: that Friday only');
  assert.deepEqual(h('JUNO').otherRoom.map((x) => x.dow), [6], 'light green on a shift: another room');
  assert.deepEqual(h('JUNO').flags.map((f) => f.text), ['REQ OFF or'], 'never guessed');
  assert.deepEqual(h('QUILL').flags.map((f) => [f.text, f.tab]), [['WOH', 'STANDING REQUESTS OFF'], ['WOH', '1.4.2027-1.10.2027']], 'flagged on each tab');
  assert.deepEqual(h('ALEX').mismatch, [{ dow: 2, tab: '1.4.2027-1.10.2027', kind: 'extra' }], 'a week tab green the standing tab doesn’t have');
  assert.deepEqual(h('PIPER').mismatch, [], 'matches the standing tab');
  assert.deepEqual(houseColors(tabs).map((c) => c.family).sort(), ['green', 'lightGreen', 'yellow']);
});

test('the preview: standing days, dated requests off, removals asked, rooms offered, flags decided; then apply', () => {
  const { store, mgr, call, user } = demo();
  const before = store.list('users').length;
  const records = houseRecords(readWorkbook(workbook()).map(parseHouseTab));
  const p = call(mgr, 'availability.importPreview', { records, options: { weekOffStatus: 'approved' } });
  const row = (name) => p.rows.find((r) => r.label === name);
  assert.equal(row('SAM').match.id, 'usr_t_sambar', 'two SAMs: the bar section picks the bartender');
  assert.equal(row('SAM').match.by, 'position');
  assert.equal(row('ALEX').status, 'check', 'two ALEXes in two sections: ask');
  assert.equal(row('ALEX').candidates.length, 2);
  assert.equal(row('ZEPHYR').problems[0].code, 'notOnTeam');
  const juno = row('JUNO');
  assert.equal(juno.status, 'check');
  assert.deepEqual([...juno.flagged].sort(), ['1.0', 'wed']);
  assert.equal(juno.days.find((d) => d.day === 1).after.standing, true);
  assert.equal(juno.days.find((d) => d.day === 3).removal, true, 'Wednesday’s standing request isn’t on the sheet any more: asked');
  assert.deepEqual(juno.timeOff.map((t) => [t.date, t.status, t.fromImport]), [['2027-01-08', 'approved', true]]);
  assert.deepEqual(juno.roomSuggestions.map((x) => [x.position, x.room]), [['Server', 'Restaurant'], ['Bartender', 'Rabbit Hole']]);
  assert.throws(() => call(mgr, 'availability.importApply', { records }), (e) => e.status === 409);
  const decisions = { [juno.key]: { cells: { '1.0': 'ignore', wed: 'keep' }, primaryRoom: 'accept', requestedAt: '2026-12-20' },
    [row('ALEX').key]: { action: 'skip' }, [row('QUILL').key]: { action: 'skip' } };
  const out = call(mgr, 'availability.importApply', { records, decisions, fileName: 'winter.xlsx' });
  assert.equal(out.created, 0);
  assert.equal(out.timeOffAdded, 1);
  assert.equal(store.list('users').length, before, 'nobody is ever created');
  const j = user('usr_t_juno');
  assert.deepEqual([j.availability[1].available, j.availability[1].standing, j.availability[1].source], [false, true, 'sheet']);
  assert.equal(j.availability[3].requestedAt, '2026-01-05T12:00:00.000Z', 'kept, with the date it was first asked');
  assert.deepEqual(j.jobCodes.map((x) => x.primaryRoom), ['Restaurant', 'Rabbit Hole']);
  const t = store.list('timeOff', (x) => x.userId === 'usr_t_juno')[0];
  assert.deepEqual([t.startDate, t.status, t.source, t.requestedAt.slice(0, 10)], ['2027-01-08', 'approved', 'import', '2026-12-20']);
  assert.deepEqual(Object.keys(user('usr_t_piper').availability), ['0'], 'Sunday standing; the shifts weren’t imported as availability');
  const again = call(mgr, 'availability.importApply', { records, decisions });
  assert.equal(again.timeOffAdded, 0, 'the same file again adds nothing');
});
