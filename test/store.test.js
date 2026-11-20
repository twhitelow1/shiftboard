import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, OverlayStore } from '../core/store.js';

function base() {
  const s = new MemoryStore();
  s.insert('shifts', { id: 'a', date: '2026-10-01', userId: 'u1' });
  s.insert('shifts', { id: 'b', date: '2026-10-02', userId: 'u2' });
  return s;
}

test('overlay reads fall through to the base store', () => {
  const ov = new OverlayStore(base());
  assert.equal(ov.get('shifts', 'a').userId, 'u1');
  assert.deepEqual(ov.list('shifts').map((s) => s.id), ['a', 'b']);
  assert.equal(ov.get('shifts', 'zzz'), null);
  assert.equal(ov.dirty, false);
});

test('overlay writes are visible to the request but not to the base', () => {
  const b = base();
  const ov = new OverlayStore(b);
  ov.update('shifts', 'a', { userId: 'u9' });
  ov.remove('shifts', 'b');
  const c = ov.insert('shifts', { date: '2026-10-03' });

  assert.equal(ov.get('shifts', 'a').userId, 'u9');
  assert.equal(ov.get('shifts', 'b'), null);
  assert.deepEqual(ov.list('shifts').map((s) => s.id), ['a', c.id]);
  assert.deepEqual(ov.list('shifts', (s) => s.userId === 'u9').map((s) => s.id), ['a']);

  assert.equal(b.get('shifts', 'a').userId, 'u1', 'base untouched');
  assert.equal(b.list('shifts').length, 2);
  assert.equal(ov.dirty, true);
  assert.deepEqual(ov.changeList().map((x) => [x.id, x.doc === null]).sort(), [['a', false], ['b', true], [c.id, false]].sort());
});

test('overlay returns copies, not references', () => {
  const ov = new OverlayStore(base());
  const got = ov.get('shifts', 'a');
  got.userId = 'mutated';
  assert.equal(ov.get('shifts', 'a').userId, 'u1');
  const ins = ov.insert('shifts', { id: 'n', tags: ['x'] });
  ins.tags.push('y');
  assert.deepEqual(ov.get('shifts', 'n').tags, ['x']);
});

test('overlay update/remove of a missing doc is a no-op', () => {
  const ov = new OverlayStore(base());
  assert.equal(ov.update('shifts', 'nope', { x: 1 }), null);
  assert.equal(ov.remove('shifts', 'nope'), false);
  assert.equal(ov.dirty, false);
});
