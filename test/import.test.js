import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';

// A brand-new restaurant: one admin, nothing else.
function fresh() {
  const store = new MemoryStore();
  store.insert('users', { id: 'usr_owner', name: 'Owner', email: 'o@r.co', role: 'super_admin', jobCodes: [], active: true });
  const svc = createService(store, { now: () => new Date('2026-11-14T10:00:00') });
  return { store, svc, owner: () => store.get('users', 'usr_owner') };
}

const IMPORT = {
  newJobCodes: [{ key: 'new:SRV', name: 'Server', department: 'Restaurant' }, { key: 'new:MOD', name: 'Manager', department: 'Leadership' }],
  newEmployees: [{ key: 'new:ALEX', name: 'Alex D', jobs: ['new:SRV'] }, { key: 'new:PAT', name: 'Pat', jobs: ['new:MOD'] }, { key: 'new:OFFWEEK', name: 'Off Week', jobs: ['new:SRV'] }],
  shifts: [
    { date: '2026-11-18', user: 'new:ALEX', job: 'new:SRV', start: '18:30', end: null, tag: '' },
    { date: '2026-11-19', user: 'new:ALEX', job: 'new:SRV', start: '15:30', end: null, tag: 'BC' },
    { date: '2026-11-18', user: 'new:ALEX', job: 'new:SRV', start: '18:30', end: null, tag: '' }, // listed in two sections
    { date: '2026-11-19', user: 'new:PAT', job: 'new:SRV', start: '12:00', end: null, tag: '' }, // Pat isn't a server yet
    { date: '2026-11-20', user: 'new:PAT', job: 'new:MOD', start: 'nope', end: null, tag: '' },
  ],
  timeOff: [{ user: 'new:ALEX', date: '2026-11-22' }],
  events: [{ date: '2026-11-19', name: 'Gala Night', room: 'Full Buyout', guestCount: 150, type: 'Buyout' }],
  covers: [{ date: '2026-11-19', covers: 100 }],
  skipDuplicates: true,
};

test('import.apply builds a restaurant from a schedule in one step', () => {
  const { svc, store, owner } = fresh();
  const r = svc.call(owner(), 'import.apply', IMPORT);
  assert.deepEqual(r, { jobCodes: 2, employees: 3, rolesLowered: 0, shifts: 3, updated: 0, duplicates: 1, invalid: 1, jobsAdded: 1, areas: 0, sheetNames: 0, timeOff: 1, events: 1, covers: 1, notes: 0 });
  const alex = store.list('users', (u) => u.name === 'Alex D')[0];
  assert.equal(alex.role, 'employee');
  assert.equal(alex.passwordHash, null, 'no password until they get a sign-in link');
  assert.equal(alex.sheetName, 'Alex D', 'the sheet spelling is kept, so a later rename still matches');
  assert.equal(store.list('shifts', (s) => s.userId === alex.id).length, 2);
  assert.ok(store.list('shifts').every((s) => s.published === false), 'imported as drafts');
  const pat = store.list('users', (u) => u.name === 'Pat')[0];
  assert.equal(pat.jobCodes.length, 2, 'got the Server job code they were scheduled for');
  assert.ok(store.list('users', (u) => u.name === 'Off Week').length, 'people with no shifts this week are still added');
  assert.equal(store.list('events')[0].status, 'confirmed');
  assert.equal(store.list('timeOff')[0].status, 'approved');

  // Importing the same thing again adds nothing new.
  const again = svc.call(owner(), 'import.apply', { ...IMPORT, newEmployees: [], shifts: IMPORT.shifts.map((s) => ({ ...s, user: s.user === 'new:ALEX' ? alex.id : pat.id })) });
  assert.equal(again.shifts, 0);
  assert.equal(again.jobCodes, 0, 'job codes matched by name');
  assert.equal(again.events, 0);
  assert.equal(again.timeOff, 0);
});

test('import.apply needs a manager and is all-or-nothing', () => {
  const { svc, store, owner } = fresh();
  store.insert('users', { id: 'usr_emp', name: 'Emp', role: 'employee', jobCodes: [], active: true });
  assert.throws(() => svc.call(store.get('users', 'usr_emp'), 'import.apply', IMPORT), /Managers only/);
  assert.throws(() => svc.call(owner(), 'import.apply', { ...IMPORT, newJobCodes: [{ key: 'x', name: ' ' }] }), /needs a name/);
});

test('projected covers without sales are priced at the usual average check', () => {
  const { svc, store, owner } = fresh();
  for (let w = 1; w <= 4; w++) {
    const d = new Date(Date.UTC(2026, 10, 19 - 7 * w)).toISOString().slice(0, 10);
    store.insert('sales', { id: d, date: d, covers: 100, sales: 5000 });
  }
  svc.call(owner(), 'import.apply', { covers: [{ date: '2026-11-19', covers: 80 }] });
  const thu = svc.call(owner(), 'forecast.week', { weekStart: '2026-11-16' }).days.find((d) => d.date === '2026-11-19');
  assert.equal(thu.covers, 80);
  assert.equal(thu.sales, 4000);
  assert.equal(thu.basis, 'Projected covers');
});

test('import gives new people the role from their section, keeps the sheet order, and respects who can give which role', () => {
  const { svc, store, owner } = fresh();
  const r = svc.call(owner(), 'import.apply', {
    newJobCodes: [{ key: 'new:MOD', name: 'Manager', department: 'Leadership', defaultRole: 'manager' }, { key: 'new:SRV', name: 'Server', department: 'Restaurant' }],
    newEmployees: [{ key: 'a', name: 'Lucas', jobs: ['new:MOD'], role: 'manager' }, { key: 'b', name: 'Alex D', jobs: ['new:SRV'], role: 'employee' }],
  });
  assert.equal(r.employees, 2);
  const byName = (n) => store.list('users', (u) => u.name === n)[0];
  assert.equal(byName('Lucas').role, 'manager');
  assert.equal(byName('Alex D').role, 'employee');
  assert.ok(byName('Lucas').order < byName('Alex D').order, 'sheet order kept');
  assert.equal(store.list('jobCodes', (j) => j.name === 'Manager')[0].defaultRole, 'manager');

  // A manager can't create managers: those people come in as Employees, and it's reported.
  const lucas = byName('Lucas');
  const out = svc.call(lucas, 'import.apply', { newEmployees: [{ key: 'c', name: 'Kelly', jobs: [], role: 'manager' }, { key: 'd', name: 'Lead', jobs: [], role: 'supervisor' }] });
  assert.equal(out.rolesLowered, 1);
  assert.equal(byName('Kelly').role, 'employee');
  assert.equal(byName('Lead').role, 'supervisor');
});

test('managers set a temporary password for people they manage, not for higher roles', () => {
  const { svc, store, owner } = fresh();
  svc.call(owner(), 'import.apply', { newEmployees: [{ key: 'm', name: 'Mgr', jobs: [], role: 'manager' }, { key: 'e', name: 'Emp', jobs: [], role: 'employee' }] });
  const mgr = store.list('users', (u) => u.name === 'Mgr')[0];
  const emp = store.list('users', (u) => u.name === 'Emp')[0];
  const { tempPassword } = svc.call(mgr, 'employees.resetPassword', { userId: emp.id });
  assert.match(tempPassword, /^[a-zA-Z2-9]{10}$/);
  assert.equal(store.get('users', emp.id).passwordHash, `plain:${tempPassword}`);
  assert.equal(store.get('users', emp.id).sessionVersion, 1, 'other sessions signed out');
  assert.throws(() => svc.call(mgr, 'employees.resetPassword', { userId: 'usr_owner' }), /higher role/);
  assert.throws(() => svc.call(emp, 'employees.resetPassword', { userId: mgr.id }), /Managers only/);
});

test('copy a week forward into the next week, skipping people who left', () => {
  const { svc, store, owner } = fresh();
  svc.call(owner(), 'import.apply', {
    newJobCodes: [{ key: 'j', name: 'Server' }],
    newEmployees: [{ key: 'a', name: 'Stays', jobs: ['j'] }, { key: 'b', name: 'Leaves', jobs: ['j'] }],
    shifts: [{ date: '2026-11-18', user: 'a', job: 'j', start: '16:00' }, { date: '2026-11-19', user: 'b', job: 'j', start: '16:00' }],
  });
  store.update('users', store.list('users', (u) => u.name === 'Leaves')[0].id, { active: false });
  const r = svc.call(owner(), 'shifts.copyWeek', { fromWeek: '2026-11-16', toWeek: '2026-11-23' });
  assert.deepEqual([r.copied, r.skipped], [1, 1]);
  const next = store.list('shifts', (s) => s.date >= '2026-11-23');
  assert.deepEqual(next.map((s) => [s.date, s.start, s.published]), [['2026-11-25', '16:00', false]]);
  assert.throws(() => svc.call(owner(), 'shifts.copyWeek', { fromWeek: '2026-11-16', toWeek: '2026-11-16' }), /different week/);
});

// The sheet's banners are areas, its section labels are positions. Synthetic names only.
test('import keeps area and position apart, and re-importing fixes an earlier import', () => {
  const { svc, store, owner } = fresh();
  // What the first version of the importer did: a job code named after the banner.
  store.insert('jobCodes', { id: 'job_rest', name: 'Restaurant', short: 'REST', department: 'Restaurant', order: 1 });
  store.insert('users', { id: 'usr_kai', name: 'Kai', role: 'employee', active: true, jobCodes: [{ jobCodeId: 'job_rest', rate: 21, primary: true }] });
  store.insert('shifts', { id: 'shf_old', date: '2026-11-19', start: '15:30', end: null, userId: 'usr_kai', jobCodeId: 'job_rest', tag: '', published: true });

  const r = svc.call(owner(), 'import.apply', {
    newJobCodes: [{ key: 'new:bartender', name: 'Bartender', department: 'Restaurant' }],
    newEmployees: [{ key: 'new:SAM', name: 'Sam', jobs: ['new:bartender'] }],
    areas: ['Restaurant', 'Rabbit Hole', 'Moon Rabbit'],
    jobOrder: ['new:bartender'], // first section on the sheet
    assignments: [
      { user: 'usr_kai', job: 'new:bartender', area: 'Restaurant' },
      { user: 'new:SAM', job: 'new:bartender', area: 'Restaurant' },
      { user: 'new:SAM', job: 'new:bartender', area: 'Rabbit Hole' },
      { user: 'new:SAM', job: 'new:bartender', area: 'Moon Rabbit' }, // off all week there, still listed
    ],
    shifts: [
      { date: '2026-11-19', user: 'usr_kai', job: 'new:bartender', area: 'Restaurant', start: '15:30', end: null, tag: '' },
      { date: '2026-11-18', user: 'new:SAM', job: 'new:bartender', area: 'Restaurant', start: '18:30', end: null, tag: '' },
      { date: '2026-11-18', user: 'new:SAM', job: 'new:bartender', area: 'RABBIT HOLE', start: '18:30', end: null, tag: '' }, // same shift, second section
      { date: '2026-11-20', user: 'new:SAM', job: 'new:bartender', area: 'rabbit hole', start: '17:00', end: null, tag: 'MR' },
    ],
  });
  assert.equal(r.shifts, 2);
  assert.equal(r.updated, 1, "Kai's earlier shift now has the right position and area");
  assert.equal(r.duplicates, 1);
  const bartender = store.list('jobCodes', (j) => j.name === 'Bartender')[0];
  assert.deepEqual([bartender.order, store.get('jobCodes', 'job_rest').order], [0, 1], "job codes follow the sheet's section order");
  assert.deepEqual(store.get('shifts', 'shf_old'), { ...store.get('shifts', 'shf_old'), jobCodeId: bartender.id, area: 'Restaurant', published: true });
  assert.equal(store.list('shifts', (s) => s.date === '2026-11-20')[0].area, 'Rabbit Hole', 'saved spelling of the area');
  assert.deepEqual(store.get('settings', 'settings').areas, ['Restaurant', 'Rabbit Hole', 'Moon Rabbit'], "the sheet's order");
  const sam = store.list('users', (u) => u.name === 'Sam')[0];
  assert.deepEqual(sam.jobCodes.map((j) => [j.jobCodeId, j.areas]), [[bartender.id, ['Restaurant', 'Rabbit Hole', 'Moon Rabbit']]], 'one position, three areas');
  const kai = store.get('users', 'usr_kai');
  assert.deepEqual(kai.jobCodes.map((j) => [j.jobCodeId, j.rate, j.areas || null]), [['job_rest', 21, null], [bartender.id, null, ['Restaurant']]]);

  // Then the old banner job code is merged away: Kai keeps the old pay rate on Bartender.
  store.insert('events', { id: 'evt_1', name: 'Gala', date: '2026-11-21', staffing: [{ id: 'stf_1', jobCodeId: 'job_rest', count: 2 }] });
  store.update('settings', 'settings', { laborRules: [{ id: 'rule_1', jobCodeId: 'job_rest', per: 40 }] });
  const m = svc.call(owner(), 'jobCodes.merge', { fromId: 'job_rest', intoId: bartender.id });
  assert.deepEqual(m, { shifts: 0, people: 1, events: 1, rules: 1 });
  assert.equal(store.get('jobCodes', 'job_rest'), null);
  assert.deepEqual(store.get('users', 'usr_kai').jobCodes, [{ jobCodeId: bartender.id, rate: 21, primary: true, areas: ['Restaurant'] }]);
  assert.equal(store.get('events', 'evt_1').staffing[0].jobCodeId, bartender.id);
  assert.equal(store.get('settings', 'settings').laborRules[0].jobCodeId, bartender.id);
  assert.throws(() => svc.call(owner(), 'jobCodes.merge', { fromId: bartender.id, intoId: bartender.id }), /different job code/);
  store.insert('users', { id: 'usr_e', name: 'E', role: 'employee', active: true, jobCodes: [] });
  assert.throws(() => svc.call(store.get('users', 'usr_e'), 'jobCodes.merge', { fromId: bartender.id, intoId: 'job_x' }), /Managers only/);
});

test('shifts keep their area, and a new area joins the schedule list', () => {
  const { svc, store, owner } = fresh();
  store.insert('jobCodes', { id: 'job_bar', name: 'Bartender', short: 'BAR', department: 'Bar', order: 1 });
  const { shift } = svc.call(owner(), 'shifts.save', { date: '2026-11-19', start: '16:00', jobCodeId: 'job_bar', area: '  Moon   rabbit ' });
  assert.equal(shift.area, 'Moon Rabbit', "matched the default room's spelling");
  assert.deepEqual(store.get('settings', 'settings').areas, ['Moon Rabbit']);
  svc.call(owner(), 'shifts.save', { date: '2026-11-19', start: '17:00', jobCodeId: 'job_bar', area: 'Back Host Stand' });
  assert.deepEqual(svc.call(owner(), 'app.bootstrap').settings.areas, ['Moon Rabbit', 'Back Host Stand']);
  const plain = svc.call(owner(), 'shifts.save', { date: '2026-11-19', start: '18:00', jobCodeId: 'job_bar' }).shift;
  assert.equal(plain.area, '', 'area is optional');
  // Copying the week keeps each shift's area.
  svc.call(owner(), 'shifts.copyWeek', { fromWeek: '2026-11-16', toWeek: '2026-11-23' });
  assert.deepEqual(store.list('shifts', (s) => s.date === '2026-11-26').map((s) => s.area).sort(), ['', 'Back Host Stand', 'Moon Rabbit']);
  // People's job codes keep their areas when saved from Team.
  const u = svc.call(owner(), 'employees.save', { name: 'Rae', role: 'employee', jobCodes: [{ jobCodeId: 'job_bar', rate: '', areas: ['Moon Rabbit', 'moon rabbit', ''] }] });
  assert.deepEqual(store.get('users', u.id).jobCodes[0].areas, ['Moon Rabbit']);
});

test("the sheet's day notes, the week's notes and banner colors", () => {
  const { svc, store, owner } = fresh();
  const r = svc.call(owner(), 'import.apply', {
    dayNotes: [{ date: '2026-11-16', text: 'CLOSED' }, { date: '2026-11-18', text: 'MEETING' }, { date: '2026-11-18', text: 'MEETING' }, { date: 'nope', text: 'x' }],
    areaColors: { 'moon rabbit': '#FF0000', 'M.O.D.': '#fc3ad2', Patio: 'red' },
  });
  assert.equal(r.notes, 2);
  const week = { start: '2026-11-16', end: '2026-11-22' };
  const byDate = (list) => list.map((n) => [n.kind, n.date, n.text]).sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0]));
  assert.deepEqual(byDate(svc.call(owner(), 'shifts.list', week).notes), [['day', '2026-11-16', 'CLOSED'], ['day', '2026-11-18', 'MEETING']]);
  assert.deepEqual(store.get('settings', 'settings').areaColors, { 'Moon Rabbit': '#ff0000', 'M.O.D.': '#fc3ad2' }, 'saved spelling, bad colors dropped');

  // A color picked in Settings isn't overwritten by the next import.
  svc.call(owner(), 'settings.update', { areaColors: { 'Moon Rabbit': '#123456', 'M.O.D.': '#fc3ad2', '': '#000000' } });
  svc.call(owner(), 'import.apply', { areaColors: { 'Moon Rabbit': '#ff0000', Restaurant: '#0070c0' } });
  assert.deepEqual(store.get('settings', 'settings').areaColors, { 'Moon Rabbit': '#123456', 'M.O.D.': '#fc3ad2', Restaurant: '#0070c0' });

  // Managers write notes; everyone reads them. Empty text removes a note.
  svc.call(owner(), 'notes.save', { kind: 'week', date: '2026-11-16', text: '  Inventory Sunday  ' });
  svc.call(owner(), 'notes.save', { kind: 'day', date: '2026-11-16', text: '' });
  store.insert('users', { id: 'usr_e', name: 'E', role: 'employee', active: true, jobCodes: [] });
  const emp = store.get('users', 'usr_e');
  assert.throws(() => svc.call(emp, 'notes.save', { kind: 'day', date: '2026-11-17', text: 'hi' }), /Managers only/);
  assert.throws(() => svc.call(owner(), 'notes.save', { kind: 'month', date: '2026-11-17', text: 'hi' }), /Unknown note/);
  assert.deepEqual(byDate(svc.call(emp, 'shifts.list', week).notes), [['week', '2026-11-16', 'Inventory Sunday'], ['day', '2026-11-18', 'MEETING']]);
});

test("each section keeps the sheet's heading, label and order of names, through a merge", () => {
  const { svc, store, owner } = fresh();
  store.insert('jobCodes', { id: 'job_old', name: 'Moon Rabbit Bartender', short: 'MRB', department: 'Moon Rabbit', order: 0 });
  svc.call(owner(), 'import.apply', {
    newJobCodes: [{ key: 'new:bar', name: 'Bartender' }, { key: 'new:mgr', name: 'Manager', department: 'M.O.D.' }],
    newEmployees: ['Max', 'Sam', 'Kai', 'Pat'].map((n) => ({ key: `new:${n}`, name: n, jobs: [n === 'Pat' ? 'new:mgr' : 'new:bar'] })),
    rosters: [
      { area: 'Rabbit Hole', job: 'new:bar', label: 'Bar', banner: 'RABBIT HOLE', users: ['new:Max', 'new:Sam', 'new:Kai'] },
      { area: 'Rabbit Hole', job: 'new:bar', label: 'Bar 2', banner: 'RABBIT HOLE', users: ['new:Kai', 'new:Pat'] }, // same section again: names appended
      { area: '', job: 'new:mgr', label: '', banner: 'M.O.D.', users: ['new:Pat'] },
      { area: 'Nowhere', job: 'nope', users: [] },
    ],
  });
  const bar = store.list('jobCodes', (j) => j.name === 'Bartender')[0];
  const id = (n) => store.list('users', (u) => u.name === n)[0].id;
  const rosters = svc.call(owner(), 'shifts.list', { start: '2026-11-16', end: '2026-11-22' }).rosters;
  const rh = rosters.find((r) => r.area === 'Rabbit Hole');
  assert.deepEqual([rh.jobCodeId, rh.label, rh.banner, rh.userIds], [bar.id, 'Bar', 'RABBIT HOLE', [id('Max'), id('Sam'), id('Kai'), id('Pat')]]);
  assert.deepEqual(rosters.filter((r) => !r.area).map((r) => [r.label, r.banner]), [['', 'M.O.D.']]);
  // An old banner job code's section folds into Bartender's.
  store.insert('rosters', { id: 'moon rabbit|job_old', area: 'Moon Rabbit', jobCodeId: 'job_old', label: 'Bar', banner: 'MOON RABBIT', userIds: [id('Sam')] });
  svc.call(owner(), 'jobCodes.merge', { fromId: 'job_old', intoId: bar.id });
  assert.equal(store.get('rosters', 'moon rabbit|job_old'), null);
  assert.deepEqual(store.get('rosters', `moon rabbit|${bar.id}`).userIds, [id('Sam')]);
});

test('clear a week: drafts by default, posted shifts and notes when asked, never event shifts or other weeks', () => {
  const { svc, store, owner } = fresh();
  store.insert('jobCodes', { id: 'job_srv', name: 'Server', short: 'SRV', department: 'Restaurant', order: 0 });
  store.insert('users', { id: 'usr_a', name: 'A', role: 'employee', active: true, jobCodes: [{ jobCodeId: 'job_srv' }] });
  store.insert('users', { id: 'usr_b', name: 'B', role: 'employee', active: true, jobCodes: [{ jobCodeId: 'job_srv' }] });
  const add = (id, date, extra = {}) => store.insert('shifts', { id, date, start: '16:00', end: null, jobCodeId: 'job_srv', userId: 'usr_a', published: false, ...extra });
  add('d1', '2026-11-18'); add('d2', '2026-11-22');
  add('p1', '2026-11-19', { published: true });
  add('e1', '2026-11-20', { published: true, eventId: 'evt_x' });
  add('next', '2026-11-23');
  store.insert('requests', { id: 'req_1', type: 'drop', shiftId: 'p1', requesterId: 'usr_a', status: 'open' });
  svc.call(owner(), 'notes.save', { kind: 'day', date: '2026-11-18', text: 'MEETING' });

  store.insert('users', { id: 'usr_e', name: 'E', role: 'employee', active: true, jobCodes: [] });
  assert.throws(() => svc.call(store.get('users', 'usr_e'), 'shifts.clearWeek', { weekStart: '2026-11-16' }), /Managers only/);

  assert.deepEqual(svc.call(owner(), 'shifts.clearWeek', { weekStart: '2026-11-16' }), { removed: 2, published: 0, notes: 0, kept: 2 });
  assert.deepEqual(store.list('shifts').map((x) => x.id).sort(), ['e1', 'next', 'p1']);
  assert.equal(store.list('notifications', (n) => n.userId === 'usr_a').length, 0, 'drafts were never seen, so nobody is told');

  assert.deepEqual(svc.call(owner(), 'shifts.clearWeek', { weekStart: '2026-11-16', published: true, notes: true }), { removed: 1, published: 1, notes: 1, kept: 1 });
  assert.deepEqual(store.list('shifts').map((x) => x.id).sort(), ['e1', 'next'], 'event shifts and next week stay');
  assert.equal(store.get('requests', 'req_1').status, 'cancelled');
  assert.equal(store.list('notifications', (n) => n.userId === 'usr_a' && /taken off the schedule/.test(n.text)).length, 1);
  assert.throws(() => svc.call(owner(), 'shifts.clearWeek', {}), /Pick a week/);
});

test("names on the schedule: remembered on import, unique, and duplicates merge into one person", () => {
  const { svc, store, owner } = fresh();
  store.insert('jobCodes', { id: 'job_mgr', name: 'Manager', short: 'MGR', department: 'M.O.D.', order: 0 });
  store.insert('jobCodes', { id: 'job_bar', name: 'Bartender', short: 'BAR', department: 'Restaurant', order: 1 });
  const louis = svc.call(owner(), 'employees.save', { name: 'Louis Henson', role: 'manager', email: 'louis@r.co', jobCodes: [{ jobCodeId: 'job_mgr', rate: 30 }] });
  // The import made "Moe" as a separate person, with shifts, before anyone knew.
  store.insert('users', { id: 'usr_moe', name: 'Moe', role: 'employee', active: true, order: 3, passwordHash: null,
    jobCodes: [{ jobCodeId: 'job_mgr', rate: null, areas: [] }, { jobCodeId: 'job_bar', rate: 18, areas: ['Restaurant'] }] });
  store.insert('shifts', { id: 's1', date: '2026-11-18', start: '18:00', jobCodeId: 'job_mgr', userId: 'usr_moe', published: true });
  store.insert('timeOff', { id: 't1', userId: 'usr_moe', startDate: '2026-11-22', endDate: '2026-11-22', status: 'approved' });
  store.insert('requests', { id: 'r1', type: 'drop', shiftId: 's1', requesterId: 'usr_moe', status: 'open' });
  store.insert('rosters', { id: '|job_mgr', area: '', jobCodeId: 'job_mgr', label: '', banner: 'M.O.D.', userIds: ['usr_x', 'usr_moe'] });

  const r = svc.call(owner(), 'employees.merge', { fromId: 'usr_moe', intoId: louis.id });
  assert.deepEqual([r.shifts, r.timeOff, r.requests], [1, 1, 1]);
  assert.equal(store.get('users', 'usr_moe'), null);
  const kept = store.get('users', louis.id);
  assert.equal(kept.sheetName, 'Moe', "the duplicate's name becomes the name on the schedule");
  assert.deepEqual(kept.jobCodes.map((j) => [j.jobCodeId, j.rate, j.areas || null]), [['job_mgr', 30, null], ['job_bar', 18, ['Restaurant']]]);
  assert.equal(store.get('shifts', 's1').userId, louis.id);
  assert.equal(store.get('timeOff', 't1').userId, louis.id);
  assert.equal(store.get('requests', 'r1').requesterId, louis.id);
  assert.deepEqual(store.get('rosters', '|job_mgr').userIds, ['usr_x', louis.id]);
  assert.throws(() => svc.call(owner(), 'employees.merge', { fromId: 'usr_owner', intoId: louis.id }), /yourself|Super Admin/);

  // Names on the schedule are unique, and an import remembers them only for people without one.
  assert.throws(() => svc.call(owner(), 'employees.save', { name: 'Someone', role: 'employee', sheetName: ' moe ' }), /already goes by/);
  const kai = svc.call(owner(), 'employees.save', { name: 'Kai Morgan', role: 'employee' });
  const out = svc.call(owner(), 'import.apply', { sheetNames: [{ user: kai.id, name: 'KAI M' }, { user: louis.id, name: 'LOU' }] });
  assert.equal(out.sheetNames, 1);
  assert.equal(store.get('users', kai.id).sheetName, 'KAI M');
  assert.equal(store.get('users', louis.id).sheetName, 'Moe', 'never overwritten by an import');
  // Saving from Team without the field keeps it; clearing it works.
  svc.call(owner(), 'employees.save', { id: kai.id, name: 'Kai Morgan', role: 'employee' });
  assert.equal(store.get('users', kai.id).sheetName, 'KAI M');
  svc.call(owner(), 'employees.save', { id: kai.id, name: 'Kai Morgan', role: 'employee', sheetName: '' });
  assert.equal(store.get('users', kai.id).sheetName, '');
});

test('start times only: notifications show just the in time when the restaurant turns it on', () => {
  const { svc, store, owner } = fresh();
  store.insert('jobCodes', { id: 'job_srv', name: 'Server', short: 'SRV', department: 'Restaurant', order: 0 });
  store.insert('users', { id: 'usr_a', name: 'A', role: 'employee', active: true, jobCodes: [{ jobCodeId: 'job_srv' }] });
  const add = (start) => svc.call(owner(), 'shifts.save', { date: '2026-11-19', start, end: '22:00', jobCodeId: 'job_srv', userId: 'usr_a', published: true });
  const last = () => store.list('notifications', (n) => n.userId === 'usr_a').map((n) => n.text).pop();
  add('16:00');
  assert.match(last(), /4p–10p$/);
  svc.call(owner(), 'settings.update', { startTimesOnly: true });
  assert.equal(svc.call(owner(), 'app.bootstrap').settings.startTimesOnly, true);
  add('17:00');
  assert.match(last(), /Nov 19 5p$/, 'no end time');
  store.insert('users', { id: 'usr_m', name: 'M', role: 'manager', active: true, jobCodes: [] });
  assert.throws(() => svc.call(store.get('users', 'usr_m'), 'settings.update', { startTimesOnly: false }), /Admins only|admin/i);
});

test('an admin who also works shifts: their sign-in and the imported employee connect into one person', () => {
  const { svc, store, owner } = fresh();
  store.insert('jobCodes', { id: 'job_bar', name: 'Bartender', short: 'BAR', department: 'Restaurant', order: 0 });
  store.update('users', 'usr_owner', { onSchedule: false });
  // The import made "Todd" (no email) with shifts.
  store.insert('users', { id: 'usr_todd', name: 'Todd', sheetName: 'Todd', role: 'employee', active: true, email: '', passwordHash: null,
    jobCodes: [{ jobCodeId: 'job_bar', rate: null, primary: true, areas: ['Rabbit Hole', 'Moon Rabbit'] }] });
  store.insert('shifts', { id: 's1', date: '2026-11-19', start: '15:30', jobCodeId: 'job_bar', area: 'Moon Rabbit', userId: 'usr_todd', published: true });
  // Typing the admin's email on that record says whose sign-in it is.
  assert.throws(() => svc.call(owner(), 'employees.save', { id: 'usr_todd', name: 'Todd', role: 'employee', email: 'O@r.co' }), /already Owner's sign-in/);
  // Connecting folds the employee into the admin's own account.
  svc.call(owner(), 'employees.merge', { fromId: 'usr_todd', intoId: 'usr_owner' });
  const me = store.get('users', 'usr_owner');
  assert.equal(store.get('users', 'usr_todd'), null);
  assert.equal(me.role, 'super_admin', 'keeps the admin role and sign-in');
  assert.equal(me.email, 'o@r.co');
  assert.equal(me.onSchedule, true, 'now shows on the schedule');
  assert.equal(me.sheetName, 'Todd');
  assert.deepEqual(me.jobCodes.map((j) => [j.jobCodeId, j.areas]), [['job_bar', ['Rabbit Hole', 'Moon Rabbit']]]);
  assert.equal(store.get('shifts', 's1').userId, 'usr_owner');
});
