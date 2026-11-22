// The schedule's layout (core/layout.js): rooms in order, each with its positions, managed in
// Settings → Rooms & positions. The schedule's sections, the shift editor's lists and the importer
// follow it; hidden positions never reach staff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { scheduleAreas, findArea, sameArea } from '../core/areas.js';
import { buildSections, shiftChoices, seedLayout, holdsIn, roomsForPosition, areaForRoom } from '../core/layout.js';
import { featureForMethod } from '../server/platform/plans.js';

const WEEK = '2026-11-16'; // a Monday
const END = '2026-11-22';
const day = (n) => `2026-11-${16 + n}`;

// The schedule's sections as web/src/pages/Schedule.jsx built them before the layout existed
// (commit 239d442), kept here to show the layout changes nothing until a manager edits it.
function legacySections({ data, employees, jobCodes, settings, isMgr }) {
  const jobs = Object.fromEntries(jobCodes.map((j) => [j.id, j]));
  const people = Object.fromEntries(employees.map((e) => [e.id, e]));
  const areaList = scheduleAreas(settings);
  const bannerOf = (s) => s.area || jobs[s.jobCodeId]?.department || '';
  const activeEmps = employees.filter((e) => e.active !== false && e.onSchedule !== false);
  const groups = new Map();
  const add = (banner, job) => {
    const name = findArea(banner, areaList) || banner || '';
    const k = `${name.toLowerCase()}|${job.id}`;
    if (!groups.has(k)) groups.set(k, { banner: name, isArea: !!findArea(name, areaList), job, users: new Set(), shifts: [] });
    return groups.get(k);
  };
  for (const sh of data.shifts) {
    const j = jobs[sh.jobCodeId];
    if (!j) continue;
    const g = add(bannerOf(sh), j);
    g.shifts.push(sh);
    if (sh.userId) g.users.add(sh.userId);
  }
  for (const e of activeEmps) {
    for (const entry of e.jobCodes || []) {
      const j = jobs[entry.jobCodeId];
      if (!j || j.archived) continue;
      for (const b of entry.areas?.length ? entry.areas : [j.department || '']) add(b, j).users.add(e.id);
    }
  }
  if (isMgr) for (const j of jobCodes) if (!j.archived && ![...groups.values()].some((g) => g.job.id === j.id)) add(j.department || '', j);
  const firstJob = {};
  for (const g of groups.values()) firstJob[g.banner] = Math.min(firstJob[g.banner] ?? 1e9, g.job.order ?? 1e9);
  const rank = (g) => (g.isArea ? 1e6 + areaList.findIndex((a) => sameArea(a, g.banner)) : firstJob[g.banner]);
  const byJob = (a, b) => (a.job.order ?? 0) - (b.job.order ?? 0) || a.job.name.localeCompare(b.job.name);
  const placeIn = (g) => { const i = (settings.sectionOrder?.[g.banner.toLowerCase()] || []).indexOf(g.job.id); return i < 0 ? 1e6 : i; };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.banner.localeCompare(b.banner) || placeIn(a) - placeIn(b) || byJob(a, b)).map((g) => {
    const area = g.isArea ? g.banner : '';
    const roster = (data.rosters || []).find((r) => r.jobCodeId === g.job.id && (r.area ? sameArea(r.area, area) : !area));
    const at = (id) => { const i = roster?.userIds?.indexOf(id) ?? -1; return i < 0 ? 1e9 : i; };
    const rows = [...g.users].map((id) => people[id]).filter(Boolean).map((u) => ({ user: u, shifts: g.shifts.filter((x) => x.userId === u.id) }));
    rows.sort((a, b) => at(a.user.id) - at(b.user.id) || (a.user.order ?? 1e9) - (b.user.order ?? 1e9) || a.user.name.localeCompare(b.user.name));
    return { key: `${g.banner}|${g.job.id}`, job: g.job, banner: g.banner, area, label: g.job.name, rows, open: g.shifts.filter((x) => !x.userId), sheetLabel: roster ? roster.label : null };
  });
}

/** What the schedule shows of a section list (the grid for managers, or only sections with someone in them). */
const shown = (sections, { all = false } = {}) => sections.filter((s) => all || s.rows.length || s.open.length).map((s) => ({
  key: s.key, banner: s.banner, job: s.job.id, label: s.sheetLabel || null,
  rows: s.rows.map((r) => [r.user.id, r.shifts.map((x) => x.id).sort()]), open: s.open.map((x) => x.id).sort(),
}));

/** The schedule's sections for a viewer, the way the web app builds them from bootstrap + shifts.list. */
function scheduleFor(svc, actor, start = WEEK, end = END) {
  const boot = svc.call(actor, 'app.bootstrap');
  const data = svc.call(actor, 'shifts.list', { start, end });
  const jobs = Object.fromEntries(boot.jobCodes.map((j) => [j.id, j]));
  const out = buildSections({ layout: boot.layout, jobs, employees: boot.employees, shifts: data.shifts, rosters: data.rosters, settings: boot.settings });
  const legacy = legacySections({ data, employees: boot.employees, jobCodes: boot.jobCodes, settings: boot.settings, isMgr: ['admin', 'super_admin', 'manager'].includes(boot.me.role) });
  return { boot, data, jobs, ...out, legacy };
}

// A small restaurant with made-up people: a Leadership department banner, three rooms, an arranged
// Restaurant, the imported sheet's labels and name order, and the owner's case: "Staff" and
// "Restaurant" positions from an old import listed under the Restaurant.
function restaurant() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, areas: ['Restaurant', 'Rabbit Hole', 'Moon Rabbit'], rooms: ['Restaurant', 'Rabbit Hole', 'Moon Rabbit', 'Full Buyout'],
    sectionOrder: { restaurant: ['job_srv', 'job_bar'] }, areaColors: { 'Moon Rabbit': '#ff0000' } });
  const job = (id, name, department, order, extra = {}) => store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), department, color: '#2563eb', defaultRate: 15, order, eventRole: false, archived: false, defaultRole: 'employee', ...extra });
  job('job_mgr', 'Manager', 'Leadership', 0, { defaultRole: 'manager' });
  job('job_bar', 'Bartender', 'Bar', 1);
  job('job_srv', 'Server', 'Restaurant', 2);
  job('job_coc', 'Cocktail Server', 'Moon Rabbit', 3);
  job('job_dish', 'Dishwasher', 'Kitchen', 4); // nobody yet: managers see it under Kitchen
  job('job_staff', 'Staff', 'Restaurant', 5); // made by an old import
  job('job_rest', 'Restaurant', 'Restaurant', 6); // made by an old import
  const person = (id, name, role, jobCodes, order) => store.insert('users', { id, name, role, active: true, onSchedule: true, order, email: `${id}@test.local`, jobCodes, availability: {}, passwordHash: 'plain:x' });
  person('usr_owner', 'Owner Test', 'admin', [{ jobCodeId: 'job_mgr', rate: null, primary: true }], 1);
  person('usr_mgr', 'Manager Test', 'manager', [{ jobCodeId: 'job_mgr', rate: null, primary: true }], 2);
  person('usr_sa', 'Server A', 'employee', [{ jobCodeId: 'job_srv', rate: 12, primary: true, areas: ['Restaurant'] }], 3);
  person('usr_sb', 'Server B', 'employee', [{ jobCodeId: 'job_srv', rate: null, primary: true }], 4); // no areas: the department (Restaurant)
  person('usr_sc', 'Server C', 'supervisor', [{ jobCodeId: 'job_srv', rate: null, primary: true, areas: ['Restaurant', 'Moon Rabbit'] }], 5);
  person('usr_ba', 'Bartender A', 'employee', [{ jobCodeId: 'job_bar', rate: 14, primary: true, areas: ['Restaurant', 'Rabbit Hole'] }, { jobCodeId: 'job_staff', rate: 16, primary: false, areas: ['Restaurant'] }], 6);
  person('usr_bb', 'Bartender B', 'employee', [{ jobCodeId: 'job_bar', rate: null, primary: true, areas: ['Moon Rabbit'] }, { jobCodeId: 'job_rest', rate: null, primary: false, areas: ['Restaurant'] }], 7);
  person('usr_ca', 'Cocktail A', 'employee', [{ jobCodeId: 'job_coc', rate: null, primary: true, areas: ['Moon Rabbit'] }], 8);
  const shift = (id, userId, jobCodeId, area, date, start = '16:00', extra = {}) => store.insert('shifts', { id, date, start, end: null, jobCodeId, userId, area, tag: '', notes: '', breakMin: 0, published: true, ...extra });
  shift('s_mgr', 'usr_mgr', 'job_mgr', '', day(1), '15:00');
  shift('s_sa', 'usr_sa', 'job_srv', 'Restaurant', day(1));
  shift('s_sb', 'usr_sb', 'job_srv', '', day(2));
  shift('s_sc', 'usr_sc', 'job_srv', 'Moon Rabbit', day(3));
  shift('s_open', null, 'job_srv', 'Restaurant', day(4));
  shift('s_ba', 'usr_ba', 'job_bar', 'Rabbit Hole', day(2));
  shift('s_bb', 'usr_bb', 'job_bar', 'Moon Rabbit', day(4));
  shift('s_ca', 'usr_ca', 'job_coc', 'Moon Rabbit', day(4));
  shift('s_staff', 'usr_ba', 'job_staff', 'Restaurant', day(5)); // the junk sections have shifts this week
  shift('s_rest', 'usr_bb', 'job_rest', 'Restaurant', day(6));
  shift('s_next', 'usr_ba', 'job_staff', 'Restaurant', '2026-11-25'); // and next week
  shift('s_past', 'usr_ba', 'job_staff', 'Restaurant', '2026-11-04', '16:00', { published: true }); // and before
  // The imported sheet: Leadership's names in its order (kept under no area, a department banner), a label.
  store.insert('rosters', { id: '|job_mgr', area: '', jobCodeId: 'job_mgr', label: 'M.O.D.', banner: 'M.O.D.', userIds: ['usr_mgr', 'usr_owner'] });
  store.insert('rosters', { id: 'restaurant|job_srv', area: 'Restaurant', jobCodeId: 'job_srv', label: 'Floor', banner: 'RESTAURANT', userIds: ['usr_sc', 'usr_sb', 'usr_sa'] });
  const svc = createService(store, { now: () => new Date('2026-11-15T10:00:00') });
  const u = (id) => store.get('users', id);
  const as = (id) => (method, args) => svc.call(u(id), method, args);
  return { store, svc, u, as };
}

// ---------- the first use: nothing moves ----------

test('layout: until a manager edits it, the schedule shows exactly the sections it did (the demo week, managers and staff)', () => {
  const store = new MemoryStore();
  seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const admin = store.list('users', (x) => x.role === 'admin')[0];
  const employee = store.list('users', (x) => x.role === 'employee' && x.jobCodes?.length)[0];
  const areasBefore = store.get('settings', 'settings').areas;
  for (const viewer of [admin, employee]) {
    const s = scheduleFor(svc, viewer, '2026-09-28', '2026-10-04');
    const isMgr = viewer === admin;
    assert.deepEqual(shown(s.sections, { all: isMgr }), shown(s.legacy, { all: isMgr }), `same sections, rows and order for ${viewer.role}`);
    assert.ok(s.sections.length > 10);
    assert.deepEqual(s.stray, [], 'every shift of the demo week is in a section');
  }
  assert.equal(store.get('layout', 'layout'), null, 'reading never writes: the layout is saved by the first change');
  assert.deepEqual(store.get('settings', 'settings').areas, areasBefore);
  // Its rooms: the department banners (Leadership, Events) first, then the areas, like the sheet.
  const lay = svc.call(admin, 'layout.get');
  assert.deepEqual(lay.rooms.map((r) => r.room), ['Leadership', 'Events', 'Restaurant', 'Rabbit Hole', 'Moon Rabbit', 'Host Stand', 'Back Host Stand']);
  assert.equal(lay.rev, 0);
  assert.equal(lay.saved, false);
});

test('layout: seeded from today’s data with the sheet’s labels, name order and arranged sections; saving changes nothing on the schedule', () => {
  const { store, svc, u } = restaurant();
  for (const id of ['usr_owner', 'usr_sa']) {
    const s = scheduleFor(svc, u(id));
    const isMgr = id === 'usr_owner';
    assert.deepEqual(shown(s.sections, { all: isMgr }), shown(s.legacy, { all: isMgr }), `same sections for ${id}`);
  }
  const before = scheduleFor(svc, u('usr_owner'));
  assert.deepEqual(before.sections.map((x) => x.key), [
    'Leadership|job_mgr', 'Kitchen|job_dish', // department banners first, by their positions' order
    'Restaurant|job_srv', 'Restaurant|job_bar', 'Restaurant|job_staff', 'Restaurant|job_rest', // the arranged order, then the rest
    'Rabbit Hole|job_bar', 'Moon Rabbit|job_bar', 'Moon Rabbit|job_srv', 'Moon Rabbit|job_coc', // the positions' own order
  ]);
  const floor = before.sections.find((x) => x.key === 'Restaurant|job_srv');
  assert.equal(floor.sheetLabel, 'Floor');
  assert.deepEqual(floor.rows.map((r) => r.user.id), ['usr_sc', 'usr_sb', 'usr_sa'], 'the sheet’s name order');
  assert.deepEqual(before.sections[0].rows.map((r) => r.user.id), ['usr_mgr', 'usr_owner'], 'a department banner keeps its names');
  assert.equal(before.sections[0].sheetLabel, 'M.O.D.');
  assert.equal(before.sections[0].area, '', 'not an area yet: new shifts there get no area, as before');

  // The first save (here, saving it as it is) stores it and makes every room an area.
  const lay = svc.call(u('usr_owner'), 'layout.get');
  const saved = svc.call(u('usr_owner'), 'layout.save', { rev: lay.rev, rooms: lay.rooms });
  assert.equal(saved.rev, 1);
  assert.deepEqual(store.get('settings', 'settings').areas, ['Leadership', 'Kitchen', 'Restaurant', 'Rabbit Hole', 'Moon Rabbit']);
  assert.ok(store.get('rosters', 'leadership|job_mgr'), 'the department banner’s names moved under its room');
  const after = scheduleFor(svc, u('usr_owner'));
  assert.deepEqual(shown(after.sections, { all: true }), shown(before.sections, { all: true }), 'nothing moved');
  assert.equal(after.sections[0].area, 'Leadership');
  assert.deepEqual(shown(scheduleFor(svc, u('usr_sa')).sections), shown(scheduleFor(svc, u('usr_sa')).legacy).filter((x) => x.job !== 'job_dish'));
  assert.throws(() => svc.call(u('usr_owner'), 'layout.save', { rev: 0, rooms: lay.rooms }), /Someone else just changed the rooms/);
});

// ---------- the owner's case: hide, unhide ----------

test('layout: hiding "Staff" and "Restaurant" under the Restaurant takes them off the sheet; unhide puts them back where they were', () => {
  const { store, svc, u, as } = restaurant();
  const owner = as('usr_owner');
  const sheet = (id) => shown(scheduleFor(svc, u(id)).sections).map((x) => x.key);
  for (const id of ['usr_owner', 'usr_sa']) {
    assert.ok(sheet(id).includes('Restaurant|job_staff') && sheet(id).includes('Restaurant|job_rest'), 'they show today');
  }
  owner('layout.hide', { room: 'Restaurant', jobCodeId: 'job_staff' });
  owner('layout.hide', { room: 'restaurant', jobCodeId: 'job_rest' });
  for (const id of ['usr_owner', 'usr_sa', 'usr_sc']) {
    const s = scheduleFor(svc, u(id));
    assert.ok(!s.sections.some((x) => ['job_staff', 'job_rest'].includes(x.job.id)), `gone from the schedule for ${id}`);
    assert.ok(!s.sections.some((x) => x.rows.some((r) => r.shifts.some((sh) => ['s_staff', 's_rest'].includes(sh.id)))), 'their shifts too');
    assert.deepEqual(s.stray.flatMap((x) => x.shifts.map((sh) => sh.id)).sort(), ['s_rest', 's_staff'], 'the shifts there are set aside');
  }
  // Managers see them as hidden (and the notice); everyone else never gets them at all.
  const mgr = scheduleFor(svc, u('usr_owner'));
  assert.ok(mgr.stray.every((x) => x.hidden));
  assert.equal(mgr.boot.layout.rooms.find((r) => r.room === 'Restaurant').positions.filter((p) => p.hidden).length, 2);
  for (const id of ['usr_sa', 'usr_sc']) {
    const boot = svc.call(u(id), 'app.bootstrap');
    assert.ok(!JSON.stringify(boot.layout).includes('job_staff') && !JSON.stringify(boot.layout).includes('"hidden"'), `no hidden positions for ${id}`);
  }
  // Not offered when scheduling.
  const choices = shiftChoices({ layout: mgr.boot.layout, jobs: mgr.jobs, employees: mgr.boot.employees, room: 'Restaurant' });
  assert.deepEqual(choices.positions.map((j) => j.id), ['job_srv', 'job_bar']);
  // Unhide: back in its place.
  owner('layout.unhide', { room: 'Restaurant', jobCodeId: 'job_staff' });
  const keys = shown(scheduleFor(svc, u('usr_owner')).sections).map((x) => x.key);
  assert.deepEqual(keys.slice(keys.indexOf('Restaurant|job_srv'), keys.indexOf('Restaurant|job_srv') + 3), ['Restaurant|job_srv', 'Restaurant|job_bar', 'Restaurant|job_staff']);
  assert.ok(!keys.includes('Restaurant|job_rest'));
  assert.ok(store.get('layout', 'layout').rev >= 3);
  // Shifts in a hidden section move to one that shows (the notice's "Move"), and their people get that position.
  const r = owner('layout.moveShifts', { room: 'Restaurant', jobCodeId: 'job_rest', start: WEEK, end: END, to: { room: 'Restaurant', jobCodeId: 'job_bar' } });
  assert.equal(r.moved, 1);
  assert.deepEqual([store.get('shifts', 's_rest').jobCodeId, store.get('shifts', 's_rest').area], ['job_bar', 'Restaurant']);
  assert.ok(holdsIn(u('usr_bb'), store.get('jobCodes', 'job_bar'), 'Restaurant'));
  assert.deepEqual(scheduleFor(svc, u('usr_owner')).stray, []);
  assert.throws(() => owner('layout.moveShifts', { room: 'Restaurant', jobCodeId: 'job_staff', start: WEEK, end: END, to: { room: 'Restaurant', jobCodeId: 'job_rest' } }), /shows on the schedule/);
  assert.throws(() => as('usr_sa')('layout.hide', { room: 'Restaurant', jobCodeId: 'job_srv' }), /Managers only/);
  assert.throws(() => owner('layout.hide', { room: 'Patio', jobCodeId: 'job_srv' }), /isn’t on the schedule/);
});

// ---------- add, reorder, remove (move or keep) ----------

test('layout: add a position (existing or new), reorder, and remove one moving its people and shifts, or keeping them', () => {
  const { store, svc, u, as } = restaurant();
  const mgr = as('usr_mgr'); // a manager (not an admin) runs Rooms & positions
  let lay = mgr('layout.addPosition', { room: 'Kitchen', newPosition: { name: 'Expo' } });
  const expo = store.get('jobCodes', lay.jobCodeId);
  assert.deepEqual([expo.name, expo.department], ['Expo', 'Kitchen']);
  assert.deepEqual(lay.rooms.find((r) => r.room === 'Kitchen').positions.map((p) => p.jobCodeId), ['job_dish', expo.id]);
  assert.equal(mgr('layout.addPosition', { room: 'Kitchen', newPosition: { name: 'expo' } }).jobCodeId, expo.id, 'the same name reuses it');
  lay = mgr('layout.addPosition', { room: 'Moon Rabbit', jobCodeId: 'job_dish' });
  assert.deepEqual(lay.rooms.find((r) => r.room === 'Moon Rabbit').positions.map((p) => p.jobCodeId), ['job_bar', 'job_srv', 'job_coc', 'job_dish']);

  // Reorder rooms and positions, rename a section on the sheet, pick a banner color.
  const rooms = lay.rooms.map((r) => (r.room === 'Moon Rabbit' ? { ...r, color: '#00ff00', positions: [...r.positions].reverse() } : r));
  rooms.unshift(rooms.splice(rooms.findIndex((r) => r.room === 'Moon Rabbit'), 1)[0]);
  rooms[0].positions[1].label = 'Cocktail';
  lay = mgr('layout.save', { rev: lay.rev, rooms });
  assert.equal(lay.rooms[0].room, 'Moon Rabbit');
  assert.equal(store.get('settings', 'settings').areaColors['Moon Rabbit'], '#00ff00');
  const s = scheduleFor(svc, u('usr_mgr'));
  assert.deepEqual(s.sections.filter((x) => x.banner === 'Moon Rabbit').map((x) => [x.job.id, x.sheetLabel]),
    [['job_dish', null], ['job_coc', 'Cocktail'], ['job_srv', null], ['job_bar', null]]);
  assert.deepEqual(store.get('settings', 'settings').areas[0], 'Moon Rabbit', 'settings.areas follows the rooms');
  assert.throws(() => mgr('layout.save', { rooms: [{ room: 'Bar', positions: [] }, { room: 'BAR', positions: [] }] }), /already a room called BAR/);
  assert.throws(() => mgr('layout.save', { rooms: [{ room: 'Bar', positions: [{ jobCodeId: 'job_nope' }] }] }), /position doesn’t exist/);
  assert.throws(() => mgr('layout.save', { rooms: [{ room: '  ', positions: [] }] }), /needs a name/);

  // Remove "Staff" from the Restaurant, moving its people and shifts (from this week on) to Bartender there.
  const r = mgr('layout.removePosition', { room: 'Restaurant', jobCodeId: 'job_staff', mode: 'move', to: { room: 'Restaurant', jobCodeId: 'job_bar' }, from: WEEK });
  assert.deepEqual(r.moved, { people: 1, shifts: 2 });
  assert.ok(!r.rooms.find((x) => x.room === 'Restaurant').positions.some((p) => p.jobCodeId === 'job_staff'));
  const ba = u('usr_ba');
  assert.ok(!ba.jobCodes.some((e) => e.jobCodeId === 'job_staff'), 'no Staff position any more');
  assert.ok(holdsIn(ba, store.get('jobCodes', 'job_bar'), 'Restaurant'));
  assert.deepEqual(['s_staff', 's_next', 's_past'].map((id) => store.get('shifts', id).jobCodeId), ['job_bar', 'job_bar', 'job_staff'], 'earlier weeks stay as they were');

  // Remove "Restaurant" from the Restaurant, keeping its people and shifts: they stay, off the schedule.
  const k = mgr('layout.removePosition', { room: 'Restaurant', jobCodeId: 'job_rest', mode: 'keep' });
  assert.deepEqual(k.moved, { people: 0, shifts: 0 });
  assert.ok(u('usr_bb').jobCodes.some((e) => e.jobCodeId === 'job_rest'));
  assert.equal(store.get('shifts', 's_rest').jobCodeId, 'job_rest');
  const stray = scheduleFor(svc, u('usr_mgr')).stray;
  assert.deepEqual(stray.map((x) => [x.room, x.jobCodeId, x.hidden, x.shifts.length]), [['Restaurant', 'job_rest', false, 1]], 'unlisted, for the notice');
  // Unhide on an unlisted section adds it back, shown, at the end of its room.
  lay = mgr('layout.unhide', { room: 'Restaurant', jobCodeId: 'job_rest' });
  assert.equal(lay.rooms.find((x) => x.room === 'Restaurant').positions.at(-1).jobCodeId, 'job_rest');
  assert.throws(() => mgr('layout.removePosition', { room: 'Restaurant', jobCodeId: 'job_srv', mode: 'move', to: { room: 'Restaurant', jobCodeId: 'job_srv' } }), /different position/);
  assert.throws(() => mgr('layout.removePosition', { room: 'Restaurant', jobCodeId: 'job_srv', mode: 'sideways' }), /Pick what happens/);
  assert.throws(() => as('usr_sc')('layout.removePosition', { room: 'Restaurant', jobCodeId: 'job_srv' }), /Managers only/);
});

// ---------- rename ----------

test('layout: renaming a room carries through to shifts, people, positions, colors, the sheet’s names and tip pools', () => {
  const { store, svc, u, as } = restaurant();
  const owner = as('usr_owner');
  store.insert('tipPools', { id: 'pool_mr', name: 'Lounge pool', areas: ['Moon Rabbit'], jobs: [], order: 0 });
  store.insert('rosters', { id: 'moon rabbit|job_coc', area: 'Moon Rabbit', jobCodeId: 'job_coc', label: 'Cocktail', banner: 'MOON RABBIT', userIds: ['usr_ca'] });
  const before = shown(scheduleFor(svc, u('usr_owner')).sections, { all: true });
  owner('layout.renameRoom', { from: 'moon rabbit', to: 'The Lounge' });
  assert.equal(store.get('shifts', 's_sc').area, 'The Lounge');
  assert.deepEqual(u('usr_ca').jobCodes[0].areas, ['The Lounge']);
  assert.deepEqual(u('usr_sc').jobCodes[0].areas, ['Restaurant', 'The Lounge']);
  assert.equal(store.get('jobCodes', 'job_coc').department, 'The Lounge', 'a position whose department was the room');
  const st = store.get('settings', 'settings');
  assert.equal(st.areaColors['The Lounge'], '#ff0000');
  assert.ok(!('Moon Rabbit' in st.areaColors));
  assert.ok(st.areas.includes('The Lounge') && !st.areas.includes('Moon Rabbit'));
  assert.deepEqual(store.get('rosters', 'the lounge|job_coc').userIds, ['usr_ca']);
  assert.deepEqual(store.get('tipPools', 'pool_mr').areas, ['The Lounge']);
  const after = shown(scheduleFor(svc, u('usr_owner')).sections, { all: true });
  const rename = (x) => ({ ...x, key: x.key.replace('Moon Rabbit|', 'The Lounge|'), banner: x.banner === 'Moon Rabbit' ? 'The Lounge' : x.banner });
  assert.deepEqual(after, before.map(rename), 'the same sections under the new name');
  owner('layout.renameRoom', { from: 'The Lounge', to: 'THE LOUNGE' }); // spelling only
  assert.equal(store.get('shifts', 's_sc').area, 'THE LOUNGE');
  assert.throws(() => owner('layout.renameRoom', { from: 'THE LOUNGE', to: 'restaurant' }), /already a room called restaurant/);
  assert.throws(() => owner('layout.renameRoom', { from: 'Nowhere', to: 'X' }), /isn’t on the schedule/);
});

// ---------- the shift editor ----------

test('shift editor: room first, then that room’s shown positions, then the people who work it there; anyone else gets the position', () => {
  const { store, svc, u, as } = restaurant();
  const owner = as('usr_owner');
  owner('layout.hide', { room: 'Restaurant', jobCodeId: 'job_staff' });
  owner('jobCodes.save', { ...store.get('jobCodes', 'job_rest'), archived: true });
  const boot = svc.call(u('usr_owner'), 'app.bootstrap');
  const jobs = Object.fromEntries(boot.jobCodes.map((j) => [j.id, j]));
  const pick = (room, jobCodeId) => shiftChoices({ layout: boot.layout, jobs, employees: boot.employees, room, jobCodeId });
  const c = pick('Restaurant', 'job_srv');
  assert.deepEqual(c.rooms.map((r) => r.room), ['Leadership', 'Kitchen', 'Restaurant', 'Rabbit Hole', 'Moon Rabbit']);
  assert.deepEqual(c.positions.map((j) => j.name), ['Server', 'Bartender'], 'shown positions only: not hidden, not archived');
  assert.deepEqual(c.holders.map((p) => p.id), ['usr_sa', 'usr_sb', 'usr_sc'], 'people who hold Server in the Restaurant (or by its department)');
  assert.ok(c.others.some((p) => p.id === 'usr_ca') && !c.others.some((p) => c.holders.includes(p)));
  assert.deepEqual(pick('Moon Rabbit', 'job_srv').holders.map((p) => p.id), ['usr_sc']);
  assert.deepEqual(pick('Rabbit Hole', 'job_bar').holders.map((p) => p.id), ['usr_ba']);
  assert.deepEqual(pick('Nowhere', 'job_srv').positions, []);
  assert.deepEqual(roomsForPosition(boot.layout, 'job_bar').map((r) => r.room), ['Restaurant', 'Rabbit Hole', 'Moon Rabbit']);
  // Once the layout is saved every room is an area, and a shift's area is its room. Before (a department's
  // banner that isn't an area yet), a shift there keeps no area, as the schedule has always done.
  assert.equal(areaForRoom('Leadership', jobs.job_mgr, boot.settings), 'Leadership');
  assert.equal(areaForRoom('Moon Rabbit', jobs.job_srv, boot.settings), 'Moon Rabbit');
  const untouched = restaurant().store.get('settings', 'settings');
  assert.equal(areaForRoom('Leadership', jobs.job_mgr, untouched), '');
  assert.equal(areaForRoom('Leadership', jobs.job_srv, untouched), 'Leadership');

  // Picking someone from "Show everyone" gives them the position in that room.
  const r = owner('shifts.save', { date: day(5), start: '17:00', jobCodeId: 'job_srv', userId: 'usr_ca', area: 'Moon Rabbit', listPerson: true });
  assert.ok(r.shift.id);
  assert.ok(holdsIn(u('usr_ca'), store.get('jobCodes', 'job_srv'), 'Moon Rabbit'));
  assert.deepEqual(u('usr_ca').jobCodes.find((e) => e.jobCodeId === 'job_srv').areas, ['Moon Rabbit']);
  // Without it, nothing changes on the person (the old warning still says they aren't trained).
  const w = owner('shifts.save', { date: day(6), start: '17:00', jobCodeId: 'job_coc', userId: 'usr_sa', area: 'Moon Rabbit' });
  assert.ok(w.warnings.some((x) => /isn't trained/.test(x)));
  assert.ok(!u('usr_sa').jobCodes.some((e) => e.jobCodeId === 'job_coc'));
});

// ---------- the importer ----------

test('import: a sheet’s new room and positions land in the layout, shown, at the end of their room; hidden ones stay hidden', () => {
  const { store, svc, u, as } = restaurant();
  const owner = as('usr_owner');
  owner('layout.hide', { room: 'Restaurant', jobCodeId: 'job_staff' });
  owner('import.apply', {
    newJobCodes: [{ key: 'new:host', name: 'Host', department: 'Host Stand' }],
    newEmployees: [{ key: 'new:H', name: 'Host Test', jobs: ['new:host'] }],
    shifts: [
      { user: 'new:H', job: 'new:host', area: 'Host Stand', date: day(1), start: '16:00' },
      { user: 'usr_sa', job: 'job_coc', area: 'Rabbit Hole', date: day(2), start: '16:00' },
      { user: 'usr_ba', job: 'job_staff', area: 'Restaurant', date: day(3), start: '16:00' },
    ],
    assignments: [{ user: 'new:H', job: 'new:host', area: 'Host Stand' }, { user: 'usr_sa', job: 'job_coc', area: 'Rabbit Hole' }],
    rosters: [{ area: 'Rabbit Hole', job: 'job_coc', label: 'Cocktail', banner: 'RABBIT HOLE', users: ['usr_sa'] }],
  });
  const lay = owner('layout.get');
  const host = store.list('jobCodes', (j) => j.name === 'Host')[0];
  assert.deepEqual(lay.rooms.at(-1).room, 'Host Stand', 'a new room at the end');
  assert.deepEqual(lay.rooms.at(-1).positions.map((p) => p.jobCodeId), [host.id]);
  const rh = lay.rooms.find((r) => r.room === 'Rabbit Hole');
  assert.deepEqual(rh.positions.map((p) => [p.jobCodeId, p.label, p.hidden]), [['job_bar', '', false], ['job_coc', 'Cocktail', false]], 'at the end of its room, with the sheet’s label');
  assert.ok(lay.rooms.find((r) => r.room === 'Restaurant').positions.find((p) => p.jobCodeId === 'job_staff').hidden, 'still hidden');
  const s = scheduleFor(svc, u('usr_owner'));
  assert.ok(s.sections.some((x) => x.key === 'Rabbit Hole|job_coc' && x.rows.some((r) => r.user.id === 'usr_sa')));
  assert.ok(s.sections.some((x) => x.key === `Host Stand|${host.id}`));
  assert.ok(store.get('settings', 'settings').areas.includes('Host Stand'));
});

// ---------- positions that merge or go away; events ----------

test('layout: merging or deleting a job code, a BEO’s shifts and a new job code keep the layout in step', () => {
  const { store, svc, u, as } = restaurant();
  const owner = as('usr_owner');
  owner('jobCodes.merge', { fromId: 'job_rest', intoId: 'job_bar' });
  let lay = owner('layout.get');
  const rest = lay.rooms.find((r) => r.room === 'Restaurant').positions.map((p) => p.jobCodeId);
  assert.deepEqual(rest, ['job_srv', 'job_bar', 'job_staff'], 'merged into Bartender, which the Restaurant already had');
  owner('layout.addPosition', { room: 'Kitchen', newPosition: { name: 'Prep Cook' } });
  const prep = store.list('jobCodes', (j) => j.name === 'Prep Cook')[0];
  owner('jobCodes.delete', { id: prep.id });
  assert.ok(!owner('layout.get').rooms.some((r) => r.positions.some((p) => p.jobCodeId === prep.id)), 'a deleted position leaves every room');
  // A new job code shows in its department's room, when there is one.
  const line = owner('jobCodes.save', { name: 'Line Cook', department: 'Kitchen' });
  assert.ok(owner('layout.get').rooms.find((r) => r.room === 'Kitchen').positions.some((p) => p.jobCodeId === line.id));
  const solo = owner('jobCodes.save', { name: 'Valet', department: 'Curb' });
  assert.ok(!owner('layout.get').rooms.some((r) => r.room === 'Curb'), 'no new room just for a new job code');
  assert.deepEqual(roomsForPosition(owner('layout.get'), solo.id), []);
  // A BEO's shifts in a room that doesn't list the position yet: added at the end of that room.
  store.insert('events', { id: 'evt_t', name: 'Test party', date: day(5), start: '18:00', room: 'Rabbit Hole', guestCount: 40, status: 'confirmed',
    staffing: [{ id: 'stf_1', jobCodeId: 'job_srv', count: 2, start: '17:00', end: '', notes: '' }] });
  assert.equal(owner('events.generateShifts', { id: 'evt_t' }).created, 2);
  lay = owner('layout.get');
  assert.deepEqual(lay.rooms.find((r) => r.room === 'Rabbit Hole').positions.map((p) => p.jobCodeId), ['job_bar', 'job_srv']);
  assert.equal(scheduleFor(svc, u('usr_owner')).sections.find((x) => x.key === 'Rabbit Hole|job_srv').open.length, 2);
});

// ---------- privacy: hidden sections never reach staff ----------

const READ_ONLY = new RegExp(fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8').match(/const READ_ONLY = \/(.+)\/;/)[1]);

test('hidden sections never reach staff through any read, and only managers manage the layout (in every plan)', () => {
  const { store, svc, u, as } = restaurant();
  as('usr_owner')('layout.hide', { room: 'Restaurant', jobCodeId: 'job_staff' });
  as('usr_owner')('layout.hide', { room: 'Restaurant', jobCodeId: 'job_rest' });
  const args = { weekStart: WEEK, start: WEEK, end: END, date: day(1), id: 's_staff', shiftId: 's_staff', userId: 'usr_ba' };
  for (const id of ['usr_sa', 'usr_sc']) {
    for (const method of Object.keys(svc.api).filter((m) => READ_ONLY.test(m))) {
      let out;
      try { out = svc.call(u(id), method, args); } catch { continue; }
      const json = JSON.stringify(out ?? null);
      assert.ok(!/"hidden":true/.test(json), `${method} sends ${id} a hidden section`);
      if (out?.layout) assert.ok(!/job_staff|job_rest/.test(JSON.stringify(out.layout)), `${method}: the layout without hidden positions`);
    }
    assert.throws(() => svc.call(u(id), 'layout.get'), /Managers only/);
    assert.throws(() => svc.call(u(id), 'layout.save', { rooms: [] }), /Managers only/);
    assert.throws(() => svc.call(u(id), 'layout.unhide', { room: 'Restaurant', jobCodeId: 'job_staff' }), /Managers only/);
  }
  for (const m of ['layout.get', 'layout.save', 'layout.hide', 'layout.unhide', 'layout.removePosition', 'layout.renameRoom', 'layout.addPosition', 'layout.moveShifts']) {
    assert.equal(featureForMethod(m), null, `${m} is in every plan`);
    assert.equal(READ_ONLY.test(m), m === 'layout.get', `${m}: the server treats only layout.get as a read`);
  }
  assert.ok(store.get('layout', 'layout'), 'saved by the first hide');
});

test('seedLayout: an empty restaurant has no rooms; areas with nothing in them yet are rooms', () => {
  assert.deepEqual(seedLayout({}), []);
  assert.deepEqual(seedLayout({ settings: { areas: ['Patio', 'Bar'] } }).map((r) => [r.room, r.positions.length]), [['Patio', 0], ['Bar', 0]]);
  const { store, svc, u } = restaurant();
  store.insert('users', { id: 'usr_gone', name: 'Gone Test', role: 'employee', active: false, jobCodes: [{ jobCodeId: 'job_srv', areas: ['Patio'] }] });
  assert.ok(!svc.call(u('usr_owner'), 'layout.get').rooms.some((r) => r.room === 'Patio'), 'inactive people don’t make sections');
});
