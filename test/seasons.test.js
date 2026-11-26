import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonOf, seasonById, seasonsBetween, seasonsOf, DEFAULT_SEASONS } from '../core/seasons.js';

test('default seasons: winter Nov–Apr crosses New Year, summer May–Oct', () => {
  assert.deepEqual(seasonOf('2026-01-15', {}), { id: 'winter-2025', key: 'winter', startYear: 2025, start: '2025-11-01', end: '2026-04-30', label: 'Winter 2025–26' });
  assert.equal(seasonOf('2025-11-01', {}).id, 'winter-2025');
  assert.equal(seasonOf('2026-04-30', {}).id, 'winter-2025');
  assert.deepEqual(seasonOf('2026-05-01', {}), { id: 'summer-2026', key: 'summer', startYear: 2026, start: '2026-05-01', end: '2026-10-31', label: 'Summer 2026' });
  assert.equal(seasonOf('2026-11-26', {}, 'es').label, 'Invierno 2026–27');
  assert.equal(seasonOf('2024-02-29', {}).end, '2024-04-30');
});

test('a season by id, and the seasons between two dates newest first', () => {
  assert.equal(seasonById('summer-2026', {}).end, '2026-10-31');
  assert.equal(seasonById('nope', {}), null);
  assert.deepEqual(seasonsBetween('2025-06-01', '2026-11-26', {}).map((s) => s.id), ['winter-2026', 'summer-2026', 'winter-2025', 'summer-2025']);
});

test('custom seasons must cover each month once; otherwise the defaults', () => {
  const four = { seasons: [{ key: 'spring', startMonth: 3, endMonth: 5 }, { key: 'summer', startMonth: 6, endMonth: 8 }, { key: 'fall', startMonth: 9, endMonth: 11 }, { key: 'winter', startMonth: 12, endMonth: 2, label: 'Ski season' }] };
  assert.equal(seasonOf('2027-01-10', four).label, 'Ski season 2026–27');
  assert.equal(seasonOf('2026-10-01', four, 'es').label, 'Otoño 2026');
  assert.deepEqual(seasonsOf({ seasons: [{ key: 'a', startMonth: 1, endMonth: 6 }] }).map((s) => s.key), DEFAULT_SEASONS.map((s) => s.key), 'gaps fall back');
});
