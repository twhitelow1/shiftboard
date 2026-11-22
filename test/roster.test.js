import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';

// Demo: Svetlana is a Cocktail Server (job_coc) and Victor a Server (job_srv), both with areas.
function setup() {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const u = (name) => store.get('users', ids.userId[name]);
  const as = (name) => (method, args) => svc.call(u(name), method, args);
  return { store, svc, ids, u, as };
}
const entry = (u, jobId) => (u.jobCodes || []).find((e) => e.jobCodeId === jobId);

test('roster: a cocktail server wrongly listed under Restaurant servers comes off, shifts moved', () => {
  const { store, u, as } = setup();
  const moe = as('Moe');
  const sv = u('Svetlana');
  const coc = entry(sv, 'job_coc');
  assert.ok(coc, 'Svetlana is a cocktail server in the demo');
  const cocArea = coc.areas?.[0] || '';

  // The mix-up: she ends up as a Server in the Restaurant, with a shift there next week.
  moe('roster.add', { userId: sv.id, jobCodeId: 'job_srv', area: 'Restaurant' });
  assert.deepEqual(entry(u('Svetlana'), 'job_srv').areas, ['Restaurant']);
  const s = store.insert('shifts', { id: 'shf_mixup', date: '2026-10-02', start: '17:00', end: null, jobCodeId: 'job_srv', userId: sv.id, area: 'Restaurant', published: true });

  // Before removing: she'd lose the Server position, 1 shift there, and her own cocktail spot is offered first.
  const plan = moe('roster.get', { userId: sv.id, jobCodeId: 'job_srv', area: 'Restaurant', from: '2026-09-28' });
  assert.equal(plan.removesJob, true);
  assert.equal(plan.shifts, 1);
  assert.equal(plan.targets[0].jobCodeId, 'job_coc');

  const r = moe('roster.remove', { userId: sv.id, jobCodeId: 'job_srv', area: 'Restaurant', from: '2026-09-28', shifts: 'move', moveTo: { jobCodeId: 'job_coc', area: cocArea } });
  assert.equal(r.removedJob, true);
  assert.equal(r.moved, 1);
  assert.equal(entry(u('Svetlana'), 'job_srv'), undefined, 'no Server position any more');
  assert.ok(entry(u('Svetlana'), 'job_coc'), 'still a cocktail server');
  const moved = store.get('shifts', s.id);
  assert.equal(moved.jobCodeId, 'job_coc');
  assert.equal(moved.area, cocArea);
});

test('roster: removing one area keeps the position for the others; keep leaves shifts', () => {
  const { store, u, as } = setup();
  const moe = as('Moe');
  const v = u('Victor');
  moe('roster.add', { userId: v.id, jobCodeId: 'job_srv', area: 'Rabbit Hole' });
  const areas = entry(u('Victor'), 'job_srv').areas;
  assert.ok(areas.includes('Rabbit Hole') && areas.length >= 2);
  store.insert('shifts', { id: 'shf_rh', date: '2026-10-03', start: '18:00', end: null, jobCodeId: 'job_srv', userId: v.id, area: 'Rabbit Hole', published: true });
  const r = moe('roster.remove', { userId: v.id, jobCodeId: 'job_srv', area: 'Rabbit Hole', from: '2026-09-28', shifts: 'keep' });
  assert.equal(r.removedJob, false);
  assert.equal(r.kept, 1);
  assert.ok(!entry(u('Victor'), 'job_srv').areas.includes('Rabbit Hole'));
  assert.ok(entry(u('Victor'), 'job_srv'), 'still a server elsewhere');
  assert.equal(store.get('shifts', 'shf_rh').area, 'Rabbit Hole', 'kept shifts are untouched');
});

test('roster: order is saved; only managers; a manager can’t edit a higher role', () => {
  const { store, u, as, ids } = setup();
  const moe = as('Moe');
  moe('roster.order', { jobCodeId: 'job_srv', area: 'Restaurant', userIds: [u('Victor').id, u('Styves').id, 'nobody'] });
  const doc = store.list('rosters', (r) => r.jobCodeId === 'job_srv' && r.area === 'Restaurant')[0];
  assert.deepEqual(doc.userIds, [u('Victor').id, u('Styves').id]);
  assert.throws(() => as('Alex D')('roster.add', { userId: u('Victor').id, jobCodeId: 'job_srv', area: 'Rabbit Hole' }), /Managers only/);
  assert.throws(() => as('Kelly')('roster.remove', { userId: ids.userId.Moe, jobCodeId: 'job_mgr', area: '' }), /higher role/);
  assert.throws(() => moe('roster.add', { userId: u('Victor').id, jobCodeId: 'job_nope' }), /position doesn’t exist/);
});
