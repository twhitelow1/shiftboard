// The availability import (smart import's "availability" target): a spreadsheet with each person and the seven days.
//   - every kind of cell restaurants write (blank, OFF, X, AM, PM, Doubles, after 4, 4p-cl, 11-3, until 3, school until 2…)
//   - layouts: days as columns, "Name | Monday | Tuesday", a header two lines down, a merged title row (XLSX), Spanish days
//   - matching like the team import (email, legal name, nickname "check"), never a new person
//   - the preview (current vs new per day, flagged cells), apply (refused until decided), the log, notifying, effective date
// Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { readTable, readXlsx, textRows, findHeaderRow, autoMap, rowsToRecords, templateCsv, FIELDS, TARGETS } from '../core/smart-import.js';
import { parseAvailabilityCell, cleanAvailability, weekChanges, pmStart, parseLimit, LOG } from '../core/availability.js';
import { dayOfHeader } from '../core/weekdays.js';
import { translateError } from '../core/errors.js';

const NOW = new Date(2026, 8, 27, 12); // the demo's clock: Sunday noon

function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const add = (doc) => store.insert('users', { role: 'employee', active: true, jobCodes: [], availability: {}, ...doc });
  // Invented people.
  add({ id: 'usr_t_rowan', name: 'Rowan Pike', email: 'rowan.pike@example.com' });
  add({ id: 'usr_t_bea', name: 'Bea Calloway', legalFirstName: 'Beatriz', legalLastName: 'Calloway', availability: { 1: { available: false } } });
  add({ id: 'usr_t_michael', name: 'Michael Dorsey' });
  add({ id: 'usr_t_ines', name: 'Ines Valdivia', availability: { 2: { available: true, from: '16:00' } } });
  const mgr = store.list('users', (u) => u.role === 'manager')[0];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  const user = (id) => store.get('users', id);
  return { store, svc, mgr, call, user };
}
/** The wizard's steps without the browser: rows → header → columns → records. */
function recordsOf(rows) {
  const h = Math.max(0, findHeaderRow(rows, 'availability', { min: 1 }));
  const cols = autoMap(rows[h], 'availability', { samples: rows.slice(h + 1, h + 30) });
  return { header: h, cols, records: rowsToRecords(rows, h, cols) };
}
const fieldOf = (cols, header) => cols.find((c) => c.header === header)?.field || null;

test('every cell form restaurants write means what they mean', () => {
  const cases = [
    ['', true, '', '', false], ['OFF', false, '', '', false], ['X', false, '', '', false], ['N/A', false, '', '', false], ['unavailable', false, '', '', false],
    ['no', false, '', '', false], ['Libre', false, '', '', false], ['available', true, '', '', false], ['open', true, '', '', false], ['any', true, '', '', false],
    ['✓', true, '', '', false], ['Doubles', true, '', '', false], ['AM', true, '', '16:00', false], ['PM', true, '16:00', '', false], ['nights', true, '16:00', '', false],
    ['after 4', true, '16:00', '', false], ['4pm–close', true, '16:00', '', false], ['4p-cl', true, '16:00', '', false], ['4+', true, '16:00', '', false],
    ['until 3', true, '', '15:00', false], ['before 5', true, '', '17:00', false], ['11-3', true, '11:00', '15:00', false], ['9a-3p', true, '09:00', '15:00', false],
    ['de 4 a 10', true, '16:00', '22:00', false], ['desde las 5', true, '17:00', '', false], ['hasta las 3', true, '', '15:00', false],
    ['after 4:30pm', true, '16:30', '', false], ['5 to close', true, '17:00', '', false], ['open-2', true, '', '14:00', false],
    // Not fully sure: a guess, the text kept as the day's note, flagged for the manager.
    ['school until 2', true, '14:00', '', true], ['class 8-1', true, '13:00', '', true], ['after 8', true, '20:00', '', true], ['until 10', true, '', '22:00', true],
    ['7-11', true, '07:00', '11:00', true], ['only every other weekend', true, '', '', true], ['x (school)', false, '', '', true],
  ];
  for (const [cell, available, from, to, review] of cases) {
    const p = parseAvailabilityCell(cell);
    assert.deepEqual([p.available, p.from, p.to, p.review], [available, from, to, review], `“${cell}”: ${JSON.stringify(p)}`);
    if (review) assert.equal(p.note, cell, `“${cell}” keeps its text as the note`);
  }
  const ro = parseAvailabilityCell('Requested off');
  assert.deepEqual([ro.available, ro.note, ro.review], [false, 'Requested off', false], 'requested off: unavailable, the words kept');
  // AM / PM follow the restaurant's dinner start.
  const settings = { dayparts: [{ name: 'Lunch', start: '11:00' }, { name: 'Dinner', start: '17:00' }] };
  assert.equal(pmStart(settings), '17:00');
  assert.equal(parseAvailabilityCell('PM', settings).from, '17:00');
  assert.equal(parseAvailabilityCell('AM', settings).to, '17:00');
  assert.equal(parseLimit('32 hrs', 80), 32);
  assert.equal(parseLimit('5', 7), 5);
  assert.ok(Number.isNaN(parseLimit('lots', 80)));
});

test('the model stays backward compatible: notes are optional, "any time" sent the old way is unchanged', () => {
  assert.deepEqual(cleanAvailability({ 1: { available: true, from: '', to: '' }, 4: { available: false }, 9: { available: false }, 2: { available: true, from: '25:00', note: ' school ' } }),
    { 1: { available: true, from: '', to: '' }, 4: { available: false }, 2: { available: true, from: '', note: 'school' } });
  assert.deepEqual(weekChanges({ 1: { available: true, from: '', to: '' } }, {}), [], 'any time, written two ways, is the same');
  assert.equal(weekChanges({}, { 3: { available: false } }).length, 1);
});

test('weekday headers: English and Spanish, full and short, with dates; never "Max hours" or "Do not schedule"', () => {
  const key = (h) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [h, d] of [['Monday', 1], ['Mon', 1], ['Mon 9/28', 1], ['Lunes', 1], ['Miércoles', 3], ['Mié', 3], ['Sáb', 6], ['Domingo', 0], ['Thurs', 4], ['Tu', 2]]) assert.equal(dayOfHeader(key(h)), d, h);
  for (const h of ['Max hours', 'Do not schedule', 'Name', 'Notes', 'Mark']) assert.equal(dayOfHeader(key(h)), -1, h);
  assert.ok(TARGETS.includes('availability'));
  assert.ok(FIELDS.availability.some((f) => f.key === 'mon') && FIELDS.availability.some((f) => f.key === 'maxDays'));
});

test('layouts: days as columns, pipes, a header two lines down, a merged title row (XLSX), Spanish days', () => {
  // 1. Plain CSV, days as columns, short names.
  let r = recordsOf(readTable('Employee,Mon,Tue,Wed,Thu,Fri,Sat,Sun\nRowan Pike,,OFF,after 4,after 4,4p-cl,Doubles,AM\n'));
  assert.equal(r.header, 0);
  assert.deepEqual(['Employee', 'Mon', 'Sun'].map((h) => fieldOf(r.cols, h)), ['name', 'mon', 'sun']);
  assert.equal(r.records[0].values.tue, 'OFF');
  // 2. "Name | Monday | Tuesday …" pasted as text.
  r = recordsOf(textRows('Name | Monday | Tuesday | Wednesday | Notes\nBea Calloway | 11-3 | X | | school\n'));
  assert.deepEqual(['Name', 'Monday', 'Wednesday', 'Notes'].map((h) => fieldOf(r.cols, h)), ['name', 'mon', 'wed', 'notes']);
  assert.equal(r.records[0].values.wed, '', 'a blank cell is kept (available all day)');
  // 3. A title, a blank line, then the header (TSV, with a date under each day).
  r = recordsOf(readTable('Fall availability\t\t\t\nPlease fill in by Friday\t\t\t\nName\tMon 9/28\tTue 9/29\tMax hours\nInes Valdivia\tPM\tuntil 3\t30\n'));
  assert.equal(r.header, 2, 'the header is the third row');
  assert.deepEqual(['Name', 'Mon 9/28', 'Tue 9/29', 'Max hours'].map((h) => fieldOf(r.cols, h)), ['name', 'mon', 'tue', 'maxHours']);
  // 4. An Excel sheet whose first row is a merged title (only A1 has text), Spanish day names, no "Name" header.
  const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const row = (n, vals) => `<row r="${n}">${vals.map((v, i) => (v ? cell(`${String.fromCharCode(65 + i)}${n}`, v) : '')).join('')}</row>`;
  const sheet = `<worksheet><sheetData>${row(1, ['Disponibilidad — otoño'])}${row(2, ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'])}${row(3, ['Michael Dorsey', 'libre', 'desde las 5', '', '', '', 'X', 'hasta las 3'])}</sheetData><mergeCells><mergeCell ref="A1:H1"/></mergeCells></worksheet>`;
  const rows = readXlsx(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) }));
  r = recordsOf(rows);
  assert.equal(r.header, 1);
  assert.equal(r.cols[0].field, 'name', 'no name header: the first column before the days is the name');
  assert.deepEqual(r.cols.slice(1).map((c) => c.field), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.equal(r.records[0].values.name, 'Michael Dorsey');
  // The downloadable template reads back as a preview with no problem rows of its own making.
  const t = recordsOf(readTable(templateCsv('availability')));
  assert.equal(t.records.length, 2);
  assert.ok(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'notes', 'maxHours'].every((f) => t.cols.some((c) => c.field === f)));
});

test('matching: email, legal name, a nickname is a check; unknown names are problems and nobody is ever created', () => {
  const { store, mgr, call } = demo();
  const before = store.list('users').length;
  const { records } = recordsOf(readTable([
    'Name,Email,Mon,Tue',
    'R. Pike,rowan.pike@example.com,OFF,',
    'Beatriz Calloway,,11-3,',
    'Mike Dorsey,,PM,PM',
    'Zed Quarry,,AM,AM',
  ].join('\n')));
  const p = call(mgr, 'availability.importPreview', { records });
  const by = Object.fromEntries(p.rows.map((r) => [r.label, r]));
  assert.equal(by['R. Pike'].match.id, 'usr_t_rowan');
  assert.equal(by['R. Pike'].match.by, 'email');
  assert.equal(by['Beatriz Calloway'].match.id, 'usr_t_bea');
  assert.equal(by['Beatriz Calloway'].match.by, 'legalName');
  assert.equal(by['Mike Dorsey'].status, 'check', 'a nickname: Possible duplicate — check');
  assert.equal(by['Mike Dorsey'].candidates[0].id, 'usr_t_michael');
  assert.ok(by['Mike Dorsey'].candidates[0].reasons.includes('nickname'));
  assert.equal(by['Zed Quarry'].status, 'problem');
  assert.equal(by['Zed Quarry'].problems[0].code, 'notOnTeam');
  // Asking to add them as someone new is refused too.
  const decisions = { [by['Zed Quarry'].key]: { action: 'new' }, [by['Mike Dorsey'].key]: { action: 'new' } };
  const p2 = call(mgr, 'availability.importPreview', { records, decisions });
  assert.equal(p2.rows.find((r) => r.label === 'Mike Dorsey').status, 'problem');
  assert.equal(p2.rows.find((r) => r.label === 'Mike Dorsey').problems[0].code, 'noCreate');
  const out = call(mgr, 'availability.importApply', { records, decisions });
  assert.equal(out.created, 0);
  assert.equal(store.list('users').length, before, 'no one is ever created by an availability import');
  // Only managers (and with Team) import.
  const emp = store.list('users', (u) => u.role === 'employee')[0];
  assert.throws(() => call(emp, 'availability.importPreview', { records }), (e) => e.status === 403);
});

test('the preview shows current vs new per day, unchanged days, and flagged cells to fix before applying', () => {
  const { store, mgr, call, user } = demo();
  const { records } = recordsOf(readTable([
    'Name,Mon,Tue,Wed,Notes,Max hours',
    'Bea Calloway,OFF,school until 2,,Prefers bar,30',
    'Ines Valdivia,,PM,,,',
  ].join('\n')));
  const p = call(mgr, 'availability.importPreview', { records });
  const bea = p.rows.find((r) => r.label === 'Bea Calloway');
  assert.deepEqual(p.dayFields, ['mon', 'tue', 'wed']);
  assert.equal(bea.status, 'check');
  assert.deepEqual(bea.needs, ['cells']);
  assert.deepEqual(bea.flagged, ['tue']);
  const mon = bea.days.find((d) => d.field === 'mon');
  assert.equal(mon.changed, false, 'Monday was already unavailable: unchanged (dimmed)');
  const tue = bea.days.find((d) => d.field === 'tue');
  assert.deepEqual([tue.review, tue.raw, tue.after.from, tue.after.note], [true, 'school until 2', '14:00', 'school until 2']);
  const ines = p.rows.find((r) => r.label === 'Ines Valdivia');
  assert.equal(ines.status, 'unchanged', 'Tuesday PM is what she has; blank days are any time, as she has');
  // Apply is refused while a flagged cell is undecided.
  assert.throws(() => call(mgr, 'availability.importApply', { records }), (e) => e.status === 409 && e.message === 'Decide on every possible duplicate first');
  assert.equal(translateError('Decide on every possible duplicate first', 'es') !== 'Decide on every possible duplicate first', true);
  // The manager fixes the cell inline: from 3 PM, with the note.
  const decisions = { [bea.key]: { cells: { tue: { available: true, from: '15:00', note: 'school until 2' } } } };
  const fixed = call(mgr, 'availability.importPreview', { records, decisions }).rows.find((r) => r.key === bea.key);
  assert.equal(fixed.status, 'update');
  assert.equal(fixed.days.find((d) => d.field === 'tue').fixed, 'edit');
  // Or takes the reading as it is.
  const accepted = call(mgr, 'availability.importPreview', { records, decisions: { [bea.key]: { cells: { tue: 'accept' } } } }).rows.find((r) => r.key === bea.key);
  assert.equal(accepted.status, 'update');
  assert.deepEqual(accepted.changes.map((c) => c.field).sort(), ['maxHours', 'notes', 'tue']);
  assert.deepEqual(user('usr_t_bea').availability, { 1: { available: false } }, 'nothing saved by a preview');
  assert.equal(store.list(LOG).length, 0);
});

test('apply writes each person’s week, logs it (via import), notifies only when asked, and is idempotent', () => {
  const { store, mgr, call, user } = demo();
  const csv = ['Name,Email,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Max days', 'Rowan Pike,rowan.pike@example.com,,OFF,after 4,after 4,4p-cl,Doubles,AM,5', 'Bea Calloway,,11-3,X,,,,,,'].join('\n');
  const { records } = recordsOf(readTable(csv));
  const notesBefore = store.list('notifications').length;
  const out = call(mgr, 'availability.importApply', { records, fileName: 'fall.csv' });
  assert.deepEqual([out.created, out.updated, out.failed.length], [0, 2, 0]);
  assert.deepEqual(user('usr_t_rowan').availability, {
    2: { available: false }, 3: { available: true, from: '16:00' }, 4: { available: true, from: '16:00' }, 5: { available: true, from: '16:00' },
    0: { available: true, to: '16:00' },
  });
  assert.equal(user('usr_t_rowan').maxDays, 5);
  assert.deepEqual(user('usr_t_bea').availability, { 1: { available: true, from: '11:00', to: '15:00' }, 2: { available: false } });
  const log = store.list(LOG, (e) => e.userId === 'usr_t_rowan');
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].via, log[0].actorId, log[0].fileName], ['import', mgr.id, 'fall.csv']);
  assert.equal(log[0].days.find((d) => d.day === 2).after.available, false);
  assert.ok(log[0].fields.some((f) => f.field === 'maxDays' && f.after === 5));
  assert.equal(store.list('notifications').length, notesBefore, 'notifying people is off by default for an import');
  assert.ok(store.list('auditLog', (a) => a.action === 'import.availability').length === 1);
  // The same file again changes nothing.
  const again = call(mgr, 'availability.importApply', { records, fileName: 'fall.csv' });
  assert.deepEqual([again.updated, again.unchanged], [0, 2]);
  assert.equal(store.list(LOG).length, 2);
  // With "Tell them", each person changed is notified, in their language.
  store.update('users', 'usr_t_bea', { language: 'es' });
  const next = recordsOf(readTable('Name,Mon\nBea Calloway,PM\n')).records;
  call(mgr, 'availability.importApply', { records: next, options: { notify: true } });
  const told = store.list('notifications', (n) => n.userId === 'usr_t_bea');
  assert.equal(told.length, 1);
  assert.match(told[0].text, /actualizó tu disponibilidad/);
});

test('an effective date: the new week applies from that date; earlier shifts are checked against the old one', () => {
  const { store, mgr, call, user } = demo();
  const { records } = recordsOf(readTable('Name,Mon,Tue,Wed,Thu,Fri,Sat,Sun\nRowan Pike,OFF,OFF,OFF,OFF,OFF,OFF,OFF\n'));
  call(mgr, 'availability.importApply', { records, options: { effectiveFrom: '2026-10-12' } });
  const u = user('usr_t_rowan');
  assert.equal(u.availabilityFrom, '2026-10-12');
  assert.deepEqual(u.availabilityBefore, {});
  const job = store.list('jobCodes')[0];
  const shift = (date) => ({ date, start: '16:00', end: '22:00', jobCodeId: job.id, userId: u.id, area: '' });
  const conflicts = (date) => {
    const s = store.insert('shifts', { ...shift(date), published: false });
    const w = call(mgr, 'shifts.list', { start: date, end: date }).warnings[s.id] || [];
    store.remove('shifts', s.id);
    return w.join(' ');
  };
  assert.doesNotMatch(conflicts('2026-10-05'), /unavailable|not available/i, 'before the date: the old week (any time)');
  assert.match(conflicts('2026-10-12'), /unavailable|not available/i, 'from the date: the new week');
  const a = call(mgr, 'availability.get', { userId: u.id });
  assert.equal(a.effectiveFrom, '2026-10-12');
  assert.deepEqual(a.previous, {});
});
