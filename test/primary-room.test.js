// A primary room per position (Team → person, the team import's "Primary room" column); shifts in another room show
// light green on the schedule and the printed PDF, with a legend line. Every person here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { offPrimary } from '../core/layout.js';
import { readTable, findHeaderRow, autoMap, rowsToRecords } from '../core/smart-import.js';
import { sheetModel, schedulePdf } from '../core/schedule-pdf.js';

const NOW = new Date(2026, 8, 27, 12);

test('primary rooms: saved per position, set by the team import, and shifts elsewhere marked', async () => {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const mgr = store.list('users', (u) => u.role === 'manager')[0];
  const call = (m, a) => svc.call(store.get('users', mgr.id), m, a);
  const u = call('employees.save', { name: 'Briar Holt', jobCodes: [{ jobCodeId: 'job_bar', primaryRoom: 'Restaurant', areas: ['Restaurant', 'Rabbit Hole'] }, { jobCodeId: 'job_srv' }] });
  assert.equal(store.get('users', u.id).jobCodes[0].primaryRoom, 'Restaurant');
  assert.equal(store.get('users', u.id).jobCodes[1].primaryRoom, undefined);
  const person = store.get('users', u.id);
  const bar = store.get('jobCodes', 'job_bar');
  assert.equal(offPrimary({ jobCodeId: 'job_bar', area: 'Rabbit Hole' }, person, bar), true);
  assert.equal(offPrimary({ jobCodeId: 'job_bar', area: 'restaurant' }, person, bar), false);
  assert.equal(offPrimary({ jobCodeId: 'job_srv', area: 'Rabbit Hole' }, person, store.get('jobCodes', 'job_srv')), false, 'no primary room: never marked');
  // The team import's "Primary room" column (an unknown room is a note, not a change).
  const rows = readTable('Name,Positions,Primary room\nBriar Holt,Bartender,Rabbit Hole\nNell Ward,Server,Atlantis\n');
  const h = findHeaderRow(rows, 'employees');
  const cols = autoMap(rows[h], 'employees', { samples: rows.slice(h + 1) });
  assert.equal(cols[2].field, 'primaryRoom');
  const records = rowsToRecords(rows, h, cols);
  const p = call('employees.importPreview', { records, options: { createPositions: false } });
  const briar = p.rows.find((r) => r.label === 'Briar Holt');
  assert.ok(briar.changes.some((c) => c.field === 'primaryRoom' && /Rabbit Hole/.test(c.after)));
  assert.ok(p.rows.find((r) => r.label === 'Nell Ward').notes.some((n) => n.code === 'unknownRoom'));
  call('employees.importApply', { records, options: { createPositions: false } });
  assert.equal(store.get('users', u.id).jobCodes.find((j) => j.jobCodeId === 'job_bar').primaryRoom, 'Rabbit Hole');
  // The printed schedule: a shift outside it is light green, with the legend line.
  store.insert('shifts', { id: 'shf_t_elsewhere', date: '2026-09-29', start: '16:00', jobCodeId: 'job_bar', userId: u.id, area: 'Restaurant', published: true });
  const boot = call('app.bootstrap', {});
  const week = call('shifts.list', { start: '2026-09-28', end: '2026-10-04' });
  const model = sheetModel({ boot, week, weekStart: '2026-09-28' });
  assert.equal(model.elsewhere, true);
  const cells = model.groups.flatMap((g) => g.sections.flatMap((s) => s.rows)).filter((r) => r.name === 'BRIAR HOLT').flatMap((r) => r.cells);
  assert.ok(cells.some((c) => c.elsewhere));
  const pdf = await schedulePdf(model);
  assert.ok(pdf.bytes.length > 1000, 'it prints, with the legend row');
});
