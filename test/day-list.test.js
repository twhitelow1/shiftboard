// The day lists' sort orders (core/day-list.js, and its copy in the phone app, mobile/src/lib/dayList.ts):
// by room (the default), by position across rooms, by start time and by name, with open shifts, hidden and
// unlisted sections, "Just me", one person in two positions and rooms, and names sorted in Spanish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core/day-list.js';
import { visibleLayout } from '../core/layout.js';

// Node runs the phone app's TypeScript copy directly (type stripping); it imports nothing but types.
const phone = await import('../mobile/src/lib/dayList.ts');

const DAY = '2026-11-26';
const jobs = {
  host: { id: 'host', name: 'Host', department: 'Restaurant', order: 0 },
  srv: { id: 'srv', name: 'Server', department: 'Restaurant', order: 1 },
  bar: { id: 'bar', name: 'Bartender', department: 'Restaurant', order: 2 },
  cook: { id: 'cook', name: 'Line cook', department: 'Kitchen', order: 3 },
};
const layout = {
  rev: 3,
  rooms: [
    { room: 'Restaurant', positions: [{ jobCodeId: 'srv' }, { jobCodeId: 'bar' }, { jobCodeId: 'host', hidden: true }] },
    { room: 'Rooftop', positions: [{ jobCodeId: 'bar' }, { jobCodeId: 'srv' }] },
  ],
};
// Made-up people; the accents and ñ are there for the Spanish order.
const people = {
  p1: { id: 'p1', name: 'Zeta Uno' },
  p2: { id: 'p2', name: 'Ámbar Dos' },
  p3: { id: 'p3', name: 'Nube Tres' },
  p4: { id: 'p4', name: 'Ñandú Cuatro' },
  p5: { id: 'p5', name: 'Bruno Cinco' },
};
const sh = (id, userId, jobCodeId, start, area = '') => ({ id, date: DAY, userId, jobCodeId, start, end: null, area, published: true });
const shifts = [
  sh('s1', 'p1', 'srv', '16:00'), // Restaurant (the position's department)
  sh('s2', 'p2', 'bar', '17:00', 'Restaurant'),
  sh('s3', 'p3', 'bar', '16:00', 'ROOFTOP'), // spelled differently, same room
  sh('s4', null, 'srv', '18:00', 'Rooftop'), // open
  sh('s5', 'p4', 'host', '10:00'), // hidden position: never shows
  sh('s6', 'p5', 'cook', '09:00'), // Kitchen isn't a room: unlisted, never shows
  sh('s7', 'p2', 'srv', '11:00', 'Rooftop'), // Ámbar works two positions in two rooms today
  sh('s8', null, 'bar', '17:00'), // open, same time as s2
  sh('s9', 'p4', 'srv', '16:00'), // same time as s1
  sh('s10', 'gone', 'srv', '12:00'), // someone the reader can't see
];
const ids = (g) => g.items.map((x) => x.shift.id);

for (const [label, lib] of [['core', core], ['phone app', phone]]) {
  const list = (opts) => lib.dayList({ shifts, jobs, people, layout, lang: 'es', ...opts });

  test(`${label}: by room is the default: banners and positions in Rooms & positions order, by time then name`, () => {
    const r = list({});
    assert.equal(r.mode, 'room');
    assert.deepEqual(r.groups.map((g) => g.key), ['Restaurant|srv', 'Restaurant|bar', 'Rooftop|bar', 'Rooftop|srv']);
    assert.deepEqual(r.groups.map(ids), [['s9', 's1'], ['s2', 's8'], ['s3'], ['s7', 's4']]);
    assert.deepEqual(r.groups.map((g) => g.count), [2, 2, 1, 2]);
    assert.deepEqual(r.groups.map((g) => g.roomCount), [4, 4, 3, 3]);
    assert.deepEqual(r.groups.map((g) => g.room), ['Restaurant', 'Restaurant', 'Rooftop', 'Rooftop']);
    assert.equal(r.count, 7);
    assert.equal(r.groups[2].items[0].room, 'Rooftop', 'the layout’s spelling');
  });

  test(`${label}: by position: one group per position across rooms, in the positions' order, each line with its room`, () => {
    const r = list({ mode: 'position' });
    assert.deepEqual(r.groups.map((g) => g.job.id), ['srv', 'bar'], 'Host comes first in order but is hidden');
    assert.deepEqual(r.groups.map(ids), [['s7', 's9', 's1', 's4'], ['s3', 's2', 's8']]);
    assert.deepEqual(r.groups[0].items.map((x) => x.room), ['Rooftop', 'Restaurant', 'Restaurant', 'Rooftop']);
    assert.deepEqual(r.groups.map((g) => g.count), [4, 3]);
    assert.ok(r.groups.every((g) => g.room === null));
  });

  test(`${label}: by time: one list by start, then name, open shifts after people at the same time`, () => {
    const r = list({ mode: 'time' });
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].count, 7);
    assert.deepEqual(ids(r.groups[0]), ['s7', 's3', 's9', 's1', 's2', 's8', 's4']);
    const s8 = r.groups[0].items.find((x) => x.shift.id === 's8');
    assert.equal(s8.open, true);
    assert.equal(s8.person, null);
    assert.equal(s8.job.id, 'bar');
    assert.equal(s8.room, 'Restaurant');
  });

  test(`${label}: by name: A–Z in the reader's language, a person's shifts by time, open shifts last by time`, () => {
    const es = list({ mode: 'name' });
    assert.deepEqual(ids(es.groups[0]), ['s7', 's2', 's3', 's9', 's1', 's8', 's4'], 'Spanish: Ámbar, Nube, Ñandú, Zeta');
    const en = list({ mode: 'name', lang: 'en' });
    assert.deepEqual(ids(en.groups[0]), ['s7', 's2', 's9', 's3', 's1', 's8', 's4'], 'English reads Ñ as N: Ñandú before Nube');
    // Same in the time order's tie-break.
    assert.deepEqual(ids(list({ mode: 'time', lang: 'en' }).groups[0]), ['s7', 's9', 's3', 's1', 's2', 's8', 's4']);
  });

  test(`${label}: Spanish name order ignores case and accents but keeps ñ after n`, () => {
    const cmp = lib.nameCompare('es');
    assert.deepEqual(['nube', 'Ñandú', 'Óscar', 'andrés', 'Ámbar', 'Nico', 'zoe'].sort(cmp), ['Ámbar', 'andrés', 'Nico', 'nube', 'Ñandú', 'Óscar', 'zoe']);
    assert.equal(lib.nameCompare('xx-not-a-language')('a', 'b') < 0, true, 'an unknown language falls back');
  });

  test(`${label}: a person in two positions and rooms the same day shows in each place`, () => {
    const where = (r) => r.groups.flatMap((g) => g.items.filter((x) => x.person?.id === 'p2').map((x) => `${g.key}:${x.shift.id}`));
    assert.deepEqual(where(list({})), ['Restaurant|bar:s2', 'Rooftop|srv:s7']);
    assert.deepEqual(where(list({ mode: 'position' })), ['pos|srv:s7', 'pos|bar:s2']);
    assert.deepEqual(where(list({ mode: 'time' })), ['all:s7', 'all:s2']);
    assert.deepEqual(where(list({ mode: 'name' })), ['all:s7', 'all:s2']);
  });

  test(`${label}: hidden and unlisted sections never show, in any order; staff's layout gives the same list`, () => {
    for (const mode of lib.DAY_SORTS) {
      const r = list({ mode });
      const all = r.groups.flatMap(ids);
      assert.ok(!all.includes('s5') && !all.includes('s6') && !all.includes('s10'), mode);
      assert.equal(all.length, 7, mode);
      assert.deepEqual(lib.dayList({ shifts, jobs, people, layout: visibleLayout(layout), mode, lang: 'es' }), r, `${mode}: staff`);
    }
    assert.deepEqual(lib.dayList({ shifts, jobs, people, layout: undefined }).groups, [], 'no layout, nothing placed');
  });

  test(`${label}: Just me keeps only the reader's shifts (no open shifts) in every order`, () => {
    for (const mode of lib.DAY_SORTS) {
      const r = list({ mode, mine: true, meId: 'p2' });
      assert.deepEqual(r.groups.flatMap(ids).sort(), ['s2', 's7'], mode);
      assert.ok(r.groups.every((g) => g.items.every((x) => !x.open)), mode);
    }
    assert.deepEqual(list({ mine: true, meId: 'p2' }).groups.map((g) => g.key), ['Restaurant|bar', 'Rooftop|srv']);
    assert.deepEqual(list({ mine: true, meId: 'nobody' }).groups, []);
  });

  test(`${label}: one room only, and open shifts stay in every order`, () => {
    const r = list({ room: 'rooftop', mode: 'position' });
    assert.deepEqual(r.groups.map(ids), [['s7', 's4'], ['s3']]);
    for (const mode of lib.DAY_SORTS) assert.ok(list({ mode }).groups.flatMap(ids).includes('s4') && list({ mode }).groups.flatMap(ids).includes('s8'), mode);
  });

  test(`${label}: last night's shift sorts before today's by time`, () => {
    const late = { ...sh('y1', 'p3', 'srv', '22:00'), date: '2026-11-25' };
    const r = lib.dayList({ shifts: [sh('t1', 'p1', 'srv', '08:00'), late], jobs, people, layout, mode: 'time' });
    assert.deepEqual(ids(r.groups[0]), ['y1', 't1']);
  });

  test(`${label}: an unknown order falls back`, () => {
    assert.equal(lib.daySort('bogus'), 'room');
    assert.equal(lib.daySort('bogus', 'position'), 'position');
    assert.equal(lib.daySort('name'), 'name');
    assert.equal(list({ mode: 'bogus' }).mode, 'room');
  });
}

test('the week grid by position: sections merged across rooms, one row per person, in the positions’ order', () => {
  const u = (id) => ({ id, name: people[id].name });
  const s = (id) => shifts.find((x) => x.id === id);
  const sections = [
    { key: 'Restaurant|srv', job: jobs.srv, banner: 'Restaurant', room: 'Restaurant', area: '', rows: [{ user: u('p4'), shifts: [s('s9')] }, { user: u('p1'), shifts: [s('s1')] }], open: [] },
    { key: 'Restaurant|bar', job: jobs.bar, banner: 'Restaurant', room: 'Restaurant', area: '', rows: [{ user: u('p2'), shifts: [s('s2')] }], open: [s('s8')] },
    { key: 'Rooftop|bar', job: jobs.bar, banner: 'Rooftop', room: 'Rooftop', area: 'Rooftop', rows: [{ user: u('p3'), shifts: [s('s3')] }, { user: u('p2'), shifts: [] }], open: [] },
    { key: 'Rooftop|srv', job: jobs.srv, banner: 'Rooftop', room: 'Rooftop', area: 'Rooftop', rows: [{ user: u('p2'), shifts: [s('s7')] }, { user: u('p1'), shifts: [] }], open: [s('s4')] },
  ];
  const out = core.positionSections(sections);
  assert.deepEqual(out.map((x) => x.key), ['pos|srv', 'pos|bar']);
  assert.deepEqual(out[0].rooms, ['Restaurant', 'Rooftop']);
  assert.deepEqual(out[0].rows.map((r) => [r.user.id, r.shifts.map((x) => x.id), r.area]), [['p4', ['s9'], ''], ['p1', ['s1'], ''], ['p2', ['s7'], 'Rooftop']]);
  assert.deepEqual(out[1].rows.map((r) => [r.user.id, r.shifts.map((x) => x.id), r.area]), [['p2', ['s2'], ''], ['p3', ['s3'], 'Rooftop']]);
  assert.deepEqual(out[0].open.map((x) => x.id), ['s4']);
  assert.equal(out[0].roomOf.s7, 'Rooftop');
  assert.equal(out[1].roomOf.s8, 'Restaurant');
  assert.equal(out[0].banner, '', 'no room banners in this view');
});
