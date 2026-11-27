// Positions in several rooms ("Who works where"): a person holds a position in each room they work, with a primary room
// among them. They're listed in every one of those rooms' sections; the primary room must be one of them; the bulk grid
// saves everyone at once; the team import takes a "Rooms" column. People nobody edited keep the department room.
// Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { buildSections, entryRooms } from '../core/layout.js';
import { readTable, findHeaderRow, autoMap, rowsToRecords } from '../core/smart-import.js';
import { translateError } from '../core/errors.js';

const NOW = new Date(2026, 8, 27, 12);
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const mgr = store.list('users', (u) => u.role === 'manager')[0];
  const call = (m, a) => svc.call(store.get('users', mgr.id), m, a);
  const add = (id, name, entry) => store.insert('users', { id, name, role: 'employee', active: true, availability: {}, jobCodes: [entry] });
  return { store, call, add };
}
const sectionsOf = (store, call, id) => {
  const boot = call('app.bootstrap', {});
  const jobs = Object.fromEntries(boot.jobCodes.map((j) => [j.id, j]));
  const { sections } = buildSections({ layout: boot.layout, jobs, employees: boot.employees, shifts: [], rosters: [], settings: boot.settings });
  return sections.filter((s) => s.rows.some((r) => r.user.id === id)).map((s) => `${s.banner}/${s.job.name}`).sort();
};

test('the grid: tick a bartender into three bars with a primary one; listed in each room’s section', () => {
  const { store, call, add } = demo();
  add('usr_t_one', 'Wes Harlan', { jobCodeId: 'job_bar' }); // nobody has edited them: the department's room only
  add('usr_t_two', 'Ora Lindqvist', { jobCodeId: 'job_bar' });
  const bar = store.get('jobCodes', 'job_bar');
  assert.deepEqual(entryRooms(store.get('users', 'usr_t_two').jobCodes[0], bar), [bar.department], 'the default stays the department room');
  const grid = call('layout.whoWorksWhere', { jobCodeId: 'job_bar' });
  for (const r of ['Restaurant', 'Rabbit Hole', 'Moon Rabbit']) assert.ok(grid.rooms.includes(r), `${r} lists Bartender`);
  assert.ok(grid.people.some((p) => p.id === 'usr_t_one' && !p.explicit));
  const out = call('layout.saveWhoWorksWhere', { jobCodeId: 'job_bar', people: [{ id: 'usr_t_one', rooms: ['Restaurant', 'Rabbit Hole', 'moon rabbit'], primaryRoom: 'Rabbit Hole' }] });
  assert.equal(out.saved, 1);
  const one = store.get('users', 'usr_t_one').jobCodes[0];
  assert.deepEqual([one.areas, one.primaryRoom], [['Restaurant', 'Rabbit Hole', 'Moon Rabbit'], 'Rabbit Hole']);
  assert.deepEqual(sectionsOf(store, call, 'usr_t_one'), ['Moon Rabbit/Bartender', 'Rabbit Hole/Bartender', 'Restaurant/Bartender']);
  assert.equal(store.get('users', 'usr_t_two').jobCodes[0].areas, undefined, 'untouched people stay as they were');
  const logged = store.list('auditLog', (e) => e.action === 'schedule.rooms.change');
  assert.equal(logged.length, 1);
  assert.match(logged[0].details.changes[0].after, /Restaurant, Rabbit Hole, Moon Rabbit \(Rabbit Hole\)/);
  // The primary room must be one of them.
  assert.throws(() => call('layout.saveWhoWorksWhere', { jobCodeId: 'job_bar', people: [{ id: 'usr_t_one', rooms: ['Restaurant'], primaryRoom: 'Moon Rabbit' }] }),
    (e) => e.status === 400 && e.message === 'The primary room has to be one of the rooms they work');
  assert.throws(() => call('layout.saveWhoWorksWhere', { jobCodeId: 'job_bar', people: [{ id: 'usr_t_one', rooms: [] }] }), (e) => e.status === 400 && /^Pick at least one room for Wes Harlan$/.test(e.message));
  assert.equal(translateError('Pick at least one room for Wes Harlan', 'es'), 'Elige al menos un salón para Wes Harlan');
});

test('Team → person: rooms and primary room per position, the primary must be one of them, changes logged', () => {
  const { store, call } = demo();
  const u = call('employees.save', { name: 'Tova Reyes', jobCodes: [{ jobCodeId: 'job_bar', areas: ['Restaurant', 'Rabbit Hole'], primaryRoom: 'Rabbit Hole' }] });
  assert.equal(store.get('users', u.id).jobCodes[0].primaryRoom, 'Rabbit Hole');
  assert.throws(() => call('employees.save', { ...store.get('users', u.id), jobCodes: [{ jobCodeId: 'job_bar', areas: ['Restaurant'], primaryRoom: 'Rabbit Hole' }] }),
    (e) => e.status === 400 && e.message === 'The primary room has to be one of the rooms they work');
  assert.equal(translateError('The primary room has to be one of the rooms they work', 'es'), 'El salón principal tiene que ser uno de los salones donde trabaja');
  call('employees.save', { ...store.get('users', u.id), jobCodes: [{ jobCodeId: 'job_bar', areas: ['Restaurant', 'Rabbit Hole', 'Moon Rabbit'], primaryRoom: 'Moon Rabbit' }] });
  const e = store.list('auditLog', (x) => x.action === 'schedule.rooms.change').at(-1);
  assert.deepEqual([e.details.changes[0].before, e.details.changes[0].after], ['Restaurant, Rabbit Hole (Rabbit Hole)', 'Restaurant, Rabbit Hole, Moon Rabbit (Moon Rabbit)']);
  // With no rooms of their own, the department's room counts (a primary room there is fine).
  const v = call('employees.save', { name: 'Uma Pell', jobCodes: [{ jobCodeId: 'job_srv', primaryRoom: 'Restaurant' }] });
  assert.equal(store.get('users', v.id).jobCodes[0].primaryRoom, 'Restaurant');
});

test('the team import: a "Rooms" column (comma or semicolon) and "Primary room"', () => {
  const { store, call, add } = demo();
  add('usr_t_imp', 'Zane Hollis', { jobCodeId: 'job_bar' });
  const rows = readTable('Name,Positions,Rooms,Primary room\nZane Hollis,Bartender,Restaurant; Moon Rabbit,Moon Rabbit\nCyd Marlow,Bartender,"Rabbit Hole, Restaurant",Restaurant\n');
  const h = findHeaderRow(rows, 'employees');
  const cols = autoMap(rows[h], 'employees', { samples: rows.slice(h + 1) });
  assert.deepEqual(cols.map((c) => c.field), ['name', 'positions', 'rooms', 'primaryRoom']);
  call('employees.importApply', { records: rowsToRecords(rows, h, cols) });
  const z = store.get('users', 'usr_t_imp').jobCodes[0];
  assert.deepEqual([z.areas, z.primaryRoom], [['Bar', 'Restaurant', 'Moon Rabbit'], 'Moon Rabbit'], 'their department room stays, the file’s join it');
  const c = store.list('users', (u) => u.name === 'Cyd Marlow')[0].jobCodes[0];
  assert.deepEqual([c.areas, c.primaryRoom], [['Rabbit Hole', 'Restaurant'], 'Restaurant']);
});
