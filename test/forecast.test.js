// Forecast RPCs called without a week (or with a malformed one) answer 400 "Pick a week" instead of crashing.
// The beta error log (server/errors.js) caught forecast.week called with no week answering 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';

function fixture() {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Bistro' });
  const mgr = store.insert('users', { id: 'u_mgr', name: 'Mara Lead', role: 'manager', active: true, availability: {}, jobCodes: [] });
  const emp = store.insert('users', { id: 'u_emp', name: 'Eli Floor', role: 'employee', active: true, availability: {}, jobCodes: [] });
  return { svc: createService(store), mgr, emp };
}

test('forecast RPCs without a week answer 400 "Pick a week", not a crash', () => {
  const { svc, mgr, emp } = fixture();
  for (const method of ['forecast.week', 'forecast.summary', 'forecast.covers', 'forecast.fillGaps']) {
    for (const args of [undefined, {}, { weekStart: 'next week' }]) {
      assert.throws(() => svc.call(mgr, method, args), (e) => e.status === 400 && e.message === 'Pick a week', `${method} ${JSON.stringify(args)}`);
    }
  }
  // Who may call it is still checked first.
  assert.throws(() => svc.call(emp, 'forecast.week', {}), (e) => e.status === 403);
  assert.throws(() => svc.call(null, 'forecast.covers', {}), (e) => e.status === 401);
  // A real week still works.
  assert.ok(svc.call(mgr, 'forecast.week', { weekStart: '2026-11-23' }));
});
