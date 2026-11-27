// Ratings and skill mix (core/ratings.js): who sees and changes ratings (managers by default, supervisors when turned on,
// employees never, through any RPC or tool), the history, changing the scale (ratings and rules move to the new scale),
// evaluating skill-mix rules, and suggestions that respect availability, time off, days off, max hours/days and what's
// already scheduled. Everyone here is the demo's invented staff.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, OverlayStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { seedRatingsDemo, evaluateRule, ruleGroup, remap, cleanScale, RATING_COL, RULE_COL } from '../core/ratings.js';
import { ROLE_OFF, roleMatrix } from '../core/role-features.js';
import { dayOffId } from '../core/quick-shift.js';
import { translateError } from '../core/errors.js';
import { toolByName, runTool, createToolContext, visibleTools, TOOLS, READ, WRITE } from '../server/tools/index.js';
import { startApp } from './helpers/app.js';

const WEEK = '2026-09-28', FRI = '2026-10-02', SAT = '2026-10-03';
const RULE = 'skr_demo_fri_sat'; // Servers, Fri & Sat dinner: at least 2 rated 5

function demo() {
  const store = new MemoryStore();
  const now = new Date(2026, 8, 27, 12);
  seedDemo(store, { now });
  seedRatingsDemo(store);
  const svc = createService(store, { now: () => now });
  const of = (role, n = 0) => store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[n];
  const call = (u, m, a = {}) => svc.call(store.get('users', u.id), m, a);
  return { store, svc, of, call };
}
const refused = (fn, status, message) => assert.throws(fn, (e) => e.status === status && (!message || e.message === message));
const RATING_RPCS = [['ratings.get', {}], ['ratings.person.get', { userId: 'usr_andrea' }], ['ratings.set', { userId: 'usr_andrea', jobCodeId: 'job_srv', value: 1 }],
  ['ratings.setMany', { changes: [] }], ['ratings.scale.save', { min: 1, max: 3 }], ['skillRules.list', {}], ['skillRules.save', { jobCodeId: 'job_srv', type: 'atLeast', count: 1, rating: 3 }],
  ['skillRules.delete', { id: RULE }], ['skillMix.week', { weekStart: WEEK }], ['skillMix.suggestions.list', { date: SAT, ruleId: RULE }]];

test('employees never see ratings: every ratings RPC refuses them, and no other answer carries a rating', () => {
  const { store, svc, of, call } = demo();
  const emp = of('employee');
  for (const [m, a] of RATING_RPCS) refused(() => call(emp, m, a), 403, ROLE_OFF);
  // Turning it on for employees isn't possible: not a switch for them.
  refused(() => call(of('admin'), 'roleFeatures.save', { roleFeatures: { employee: { ratingsView: true } } }), 400, 'That can’t be changed for this role');
  assert.equal(roleMatrix({}).employee.ratingsView, false);
  assert.equal(call(emp, 'app.bootstrap').features.ratingsView, false, 'the apps hide everything about ratings');
  // Every other method, as an employee (each on a throwaway copy): no rating, rule or scale anywhere in the answer.
  const leaks = [];
  for (const m of Object.keys(svc.api)) {
    const view = new OverlayStore(store);
    try {
      const out = JSON.stringify(createService(view, { now: () => new Date(2026, 8, 27, 12) }).call(store.get('users', emp.id), m, { weekStart: WEEK, start: WEEK, end: '2026-10-04', date: SAT }) ?? null);
      if (/rtg_|skr_|ratingConfig|ratingSignals|"history":\[\{"at"[^\]]*"source":"manual"/.test(out)) leaks.push(m);
    } catch { /* refused or needs other arguments: nothing returned */ }
  }
  assert.deepEqual(leaks, []);
  // A rating change notifies nobody.
  const before = store.list('notifications').length;
  call(of('manager'), 'ratings.set', { userId: 'usr_tori', jobCodeId: 'job_srv', value: 4 });
  assert.equal(store.list('notifications').length, before);
});

test('managers see and change ratings; supervisors only when turned on, and then employees only; nobody rates themselves', () => {
  const { store, of, call } = demo();
  const mgr = of('manager'), sup = of('supervisor'), admin = of('admin');
  for (const [m, a] of RATING_RPCS.filter(([m]) => m.endsWith('.get') || m.endsWith('.list') || m.endsWith('.week'))) assert.ok(call(mgr, m, a), m);
  for (const [m, a] of RATING_RPCS) refused(() => call(sup, m, a), 403, ROLE_OFF);
  call(admin, 'roleFeatures.save', { roleFeatures: { supervisor: { ratingsView: true } } });
  const grid = call(sup, 'ratings.get');
  assert.ok(grid.rows.length > 0 && grid.rows.every((r) => store.get('users', r.userId).role === 'employee'), 'supervisors see employees only');
  assert.equal(grid.canEdit, false);
  refused(() => call(sup, 'ratings.set', { userId: 'usr_andrea', jobCodeId: 'job_srv', value: 1 }), 403, ROLE_OFF);
  // Managers: not their own, not other managers.
  refused(() => call(mgr, 'ratings.set', { userId: mgr.id, jobCodeId: mgr.jobCodes[0].jobCodeId, value: 3 }), 403, 'Nobody rates themselves');
  refused(() => call(mgr, 'ratings.person.get', { userId: mgr.id }), 403);
  refused(() => call(mgr, 'ratings.set', { userId: of('manager', 1).id, jobCodeId: of('manager', 1).jobCodes[0].jobCodeId, value: 3 }), 403, 'You can’t rate this person');
  assert.ok(!call(mgr, 'ratings.get').rows.some((r) => r.userId === mgr.id));
  // Only positions they work, only on the scale; unrated is null, never 0.
  refused(() => call(mgr, 'ratings.set', { userId: 'usr_andrea', jobCodeId: 'job_mgr', value: 3 }), 400, 'They don’t work that position');
  refused(() => call(mgr, 'ratings.set', { userId: 'usr_andrea', jobCodeId: 'job_srv', value: 0 }), 400, 'Pick a rating on the scale');
  refused(() => call(mgr, 'ratings.set', { userId: 'usr_andrea', jobCodeId: 'job_srv', value: 6 }), 400, 'Pick a rating on the scale');
  assert.equal(translateError('Pick a rating on the scale', 'es'), 'Elige una calificación de la escala');
  // Managers can't change the scale (Admins only).
  refused(() => call(mgr, 'ratings.scale.save', { min: 1, max: 10 }), 403, 'Admins only');
});

test('history: who, when, from → to, with the note; clearing makes them unrated', () => {
  const { of, call } = demo();
  const mgr = of('manager');
  assert.equal(call(mgr, 'ratings.person.get', { userId: 'usr_tori' }).positions.find((p) => p.jobCodeId === 'job_srv').value, null, 'demo: Tori is unrated');
  call(mgr, 'ratings.set', { userId: 'usr_tori', jobCodeId: 'job_srv', value: 3, note: 'Strong first month' });
  call(mgr, 'ratings.set', { userId: 'usr_tori', jobCodeId: 'job_srv', value: 4 });
  assert.equal(call(mgr, 'ratings.set', { userId: 'usr_tori', jobCodeId: 'job_srv', value: 4 }).changed, false, 'same value, no note: nothing logged');
  call(mgr, 'ratings.set', { userId: 'usr_tori', jobCodeId: 'job_srv', value: null });
  const p = call(mgr, 'ratings.person.get', { userId: 'usr_tori' }).positions.find((x) => x.jobCodeId === 'job_srv');
  assert.equal(p.value, null);
  assert.deepEqual(p.history.map((h) => [h.from, h.to, h.byName, h.source]), [[4, null, mgr.name, 'manual'], [3, 4, mgr.name, 'manual'], [null, 3, mgr.name, 'manual']]);
  assert.equal(p.history[2].note, 'Strong first month');
  assert.ok(p.history.every((h) => /^\d{4}-\d{2}-\d{2}T/.test(h.at)));
  assert.equal(p.suggested, null, 'room for a computed rating later');
  assert.ok('quiz' in p.signals && 'kudos' in p.signals, 'signals for reference');
  // The bulk grid saves many at once, all checked first.
  refused(() => call(mgr, 'ratings.setMany', { changes: [{ userId: 'usr_tori', jobCodeId: 'job_srv', value: 2 }, { userId: 'usr_tori', jobCodeId: 'job_srv', value: 9 }] }), 400);
  assert.equal(call(mgr, 'ratings.person.get', { userId: 'usr_tori' }).positions.find((x) => x.jobCodeId === 'job_srv').value, null, 'nothing saved by a refused batch');
  assert.equal(call(mgr, 'ratings.setMany', { changes: [{ userId: 'usr_tori', jobCodeId: 'job_srv', value: 2 }, { userId: 'usr_victor', jobCodeId: 'job_srv', value: 5 }] }).changed, 2);
});

test('changing the scale re-maps ratings and rule thresholds, keeping their place; level names on the scale only', () => {
  const { store, of, call } = demo();
  const admin = of('admin');
  assert.equal(remap(5, { min: 1, max: 5 }, { min: 1, max: 10 }), 10);
  assert.equal(remap(3, { min: 1, max: 5 }, { min: 1, max: 10 }), 6);
  assert.equal(remap(1, { min: 1, max: 5 }, { min: 1, max: 10 }), 1);
  assert.equal(remap(4, { min: 1, max: 5 }, { min: 1, max: 3 }), 3);
  assert.equal(remap(3.5, { min: 1, max: 5 }, { min: 1, max: 10 }, false), 6.6);
  assert.throws(() => cleanScale({ min: 3, max: 3 }, (s, m) => { throw new Error(m); }));
  call(admin, 'skillRules.save', { jobCodeId: 'job_srv', type: 'minAvg', avg: 3.5, days: [5] });
  const r = call(admin, 'ratings.scale.save', { min: 1, max: 10, labels: { 10: 'Lead', 1: 'Trainee', 11: 'Nope' } });
  assert.deepEqual(r.scale, { min: 1, max: 10, labels: { 10: 'Lead', 1: 'Trainee' } });
  assert.ok(r.remapped > 0);
  const andrea = store.get(RATING_COL, 'rtg_usr_andrea_job_srv');
  assert.equal(andrea.value, 10);
  assert.deepEqual(andrea.history.at(-1).source, 'scale');
  assert.equal(store.get(RULE_COL, RULE).rating, 10, 'at least 2 rated 5 → rated 10');
  assert.equal(store.list(RULE_COL).find((x) => x.type === 'minAvg').avg, 6.6);
  // The rule still means the same: Saturday still fails, Friday still passes.
  const w = call(admin, 'skillMix.week', { weekStart: WEEK });
  const res = (d) => w.days.find((x) => x.date === d).results.find((x) => x.ruleId === RULE).status;
  assert.equal(res(FRI), 'ok');
  assert.equal(res(SAT), 'fail');
  // Names only (no re-map) when min/max stay.
  assert.equal(call(admin, 'ratings.scale.save', { min: 1, max: 10, labels: { 10: 'Captain' } }).remapped, 0);
});

test('rule evaluation: at least, at most (unrated never counted), minimum average, weekday, daypart and room', () => {
  const ratings = { a: 5, b: 3, c: 2, d: null };
  const ratingOf = (u) => ratings[u];
  const s = (id, userId, start, end, extra = {}) => ({ id, userId, date: SAT, start, end, jobCodeId: 'job_srv', area: 'Restaurant', ...extra });
  const shifts = [s('1', 'a', '16:00', '22:00'), s('2', 'b', '17:00', '23:00'), s('3', 'c', '11:00', '15:00'), s('4', 'd', '18:00', '23:00'), s('5', 'b', '11:00', '14:00')];
  const settings = { dayparts: [{ name: 'Lunch', start: '11:00', end: '16:00' }, { name: 'Dinner', start: '16:00', end: '23:00' }], closedDays: [1] };
  const ev = (rule) => { const g = ruleGroup(rule, SAT, shifts, { settings }); return g && evaluateRule(rule, { ...g, date: SAT }, ratingOf); };
  const base = { id: 'r', jobCodeId: 'job_srv', days: [], daypart: '', room: '', programmingId: '', active: true };
  assert.deepEqual(ev({ ...base, type: 'atLeast', count: 2, rating: 3 }).status, 'ok'); // a, b
  assert.equal(ev({ ...base, type: 'atLeast', count: 2, rating: 3 }).scheduled, 4, 'one person counts once');
  assert.equal(ev({ ...base, type: 'atLeast', count: 2, rating: 5 }).status, 'fail');
  const dinner = ev({ ...base, type: 'atLeast', count: 2, rating: 3, daypart: 'Dinner' });
  assert.deepEqual(dinner.people.map((p) => p.userId), ['a', 'b', 'd'], 'Dinner: shifts that overlap 16:00–23:00');
  assert.equal(ev({ ...base, type: 'atMost', count: 1, rating: 3 }).status, 'fail'); // b and c
  const lunchMost = ev({ ...base, type: 'atMost', count: 1, rating: 3, daypart: 'Lunch' }); // c and b (b's lunch shift)
  assert.equal(lunchMost.have, 2);
  const dinnerMost = ev({ ...base, type: 'atMost', count: 1, rating: 3, daypart: 'Dinner' });
  assert.deepEqual([dinnerMost.status, dinnerMost.have, dinnerMost.unrated], ['ok', 1, 1], 'd is unrated: not counted');
  assert.equal(ev({ ...base, type: 'minAvg', avg: 3.5, daypart: 'Dinner' }).avg, 4);
  assert.equal(ev({ ...base, type: 'minAvg', avg: 4.5, daypart: 'Dinner' }).status, 'fail');
  assert.equal(evaluateRule({ ...base, type: 'minAvg', avg: 3 }, { shifts: [s('9', 'd', '17:00', '22:00')], date: SAT }, ratingOf).status, 'na', 'nobody rated: no average');
  assert.equal(ev({ ...base, type: 'atLeast', count: 1, rating: 5, days: [5] }), null, 'Friday only: not Saturday');
  assert.equal(ev({ ...base, type: 'atLeast', count: 1, rating: 5, room: 'Patio' }).status, 'fail', 'nobody in that room');
  assert.equal(ruleGroup({ ...base, type: 'atLeast', count: 1, rating: 5 }, '2026-09-28', shifts, { settings }), null, 'closed day');
  assert.equal(ev({ ...base, type: 'atLeast', count: 1, rating: 5, active: false }), null, 'switched off');
});

test('the demo week: Saturday dinner fails, Friday passes; suggestions respect time off, days off, availability, max hours and days', () => {
  const { store, of, call } = demo();
  const mgr = of('manager');
  const w = call(mgr, 'skillMix.week', { weekStart: WEEK });
  const sat = w.days.find((d) => d.date === SAT).results.find((x) => x.ruleId === RULE);
  assert.deepEqual([sat.status, sat.have, sat.need], ['fail', 1, 2]);
  assert.equal(w.days.find((d) => d.date === FRI).results[0].status, 'ok');
  assert.equal(w.days.find((d) => d.date === '2026-09-29').results.length, 0, 'Tuesday: the rule doesn’t apply');
  assert.equal(w.failing, 1);
  // Who could fix it: Manny (rated 5, not working Saturday). Alex D (5) works the wedding then: left out.
  const names = () => call(mgr, 'skillMix.suggestions.list', { date: SAT, ruleId: RULE }).candidates.map((c) => c.name);
  const sug = call(mgr, 'skillMix.suggestions.list', { date: SAT, ruleId: RULE });
  assert.deepEqual(sug.candidates.map((c) => [c.name, c.rating]), [['Manny', 5]]);
  assert.ok(sug.candidates[0].add && sug.candidates[0].add.jobCodeId === 'job_srv');
  assert.equal(sug.candidates[0].swap, null, 'the scheduled servers are published: no swap (drafts only)');
  // Approved time off, a day off, unavailable that weekday, max hours, max days: each keeps him off the list.
  const manny = store.get('users', 'usr_manny');
  const to = store.insert('timeOff', { id: 'to_test', userId: manny.id, startDate: SAT, endDate: SAT, status: 'approved', reason: '' });
  assert.deepEqual(names(), []);
  store.update('timeOff', to.id, { status: 'pending' });
  assert.deepEqual(call(mgr, 'skillMix.suggestions.list', { date: SAT, ruleId: RULE }).candidates[0].warnings, ['timeOffPending'], 'pending: shown, with a warning');
  store.remove('timeOff', to.id);
  store.insert('daysOff', { id: dayOffId(manny.id, SAT), userId: manny.id, date: SAT });
  assert.deepEqual(names(), []);
  store.remove('daysOff', dayOffId(manny.id, SAT));
  store.update('users', manny.id, { availability: { 6: { available: false, standing: true } } });
  assert.deepEqual(names(), [], 'standing request off on Saturdays');
  store.update('users', manny.id, { availability: {} });
  const weekHours = store.list('shifts', (s) => s.userId === manny.id && s.date >= WEEK && s.date <= '2026-10-04').length;
  store.update('users', manny.id, { maxHours: weekHours ? 1 : 0.5 });
  assert.deepEqual(names(), [], 'over his max hours');
  store.insert('shifts', { id: 'shf_test_thu', date: '2026-10-01', start: '11:00', end: '15:00', jobCodeId: 'job_srv', userId: manny.id, area: '', published: false });
  store.update('users', manny.id, { maxHours: null, maxDays: Math.max(1, new Set(store.list('shifts', (s) => s.userId === manny.id && s.date >= WEEK && s.date <= '2026-10-04').map((s) => s.date)).size) });
  assert.deepEqual(names(), [], 'at his max days');
  store.update('users', manny.id, { maxDays: null });
  store.remove('shifts', 'shf_test_thu');
  // Already working then: left out.
  const busy = call(mgr, 'shifts.save', { date: SAT, start: '17:00', end: '23:00', jobCodeId: 'job_bus', userId: manny.id });
  assert.deepEqual(names(), []);
  call(mgr, 'shifts.delete', { id: busy.shift.id });
  assert.deepEqual(names(), ['Manny']);

  // "Add as draft shift": the app saves the suggested shift as a draft; the rule passes, nothing is published.
  const c = call(mgr, 'skillMix.suggestions.list', { date: SAT, ruleId: RULE }).candidates[0];
  const made = call(mgr, 'shifts.save', { ...c.add, userId: c.userId });
  assert.equal(made.shift.published, false);
  assert.equal(call(mgr, 'skillMix.week', { weekStart: WEEK }).days.find((d) => d.date === SAT).results[0].status, 'ok');

  // Swap: a draft shift held by someone rated lower; the suggestion swaps the better-rated person in.
  call(mgr, 'shifts.delete', { id: made.shift.id });
  const tori = store.list('shifts', (s) => s.date === SAT && s.userId === 'usr_tori' && s.jobCodeId === 'job_srv')[0];
  store.update('shifts', tori.id, { published: false });
  const swap = call(mgr, 'skillMix.suggestions.list', { date: SAT, ruleId: RULE }).candidates[0];
  assert.equal(swap.swap.userId, 'usr_tori', 'the unrated person on a draft');
  call(mgr, 'shifts.save', { ...swap.swap.shift, userId: swap.userId });
  assert.equal(store.get('shifts', tori.id).userId, 'usr_manny');
  assert.equal(store.get('shifts', tori.id).published, false);
});

test('rules: validation, programming items, and Spanish errors', () => {
  const { store, of, call } = demo();
  const mgr = of('manager');
  refused(() => call(mgr, 'skillRules.save', { jobCodeId: 'nope', type: 'atLeast', count: 1, rating: 3 }), 400, 'That position doesn’t exist');
  refused(() => call(mgr, 'skillRules.save', { jobCodeId: 'job_srv', type: 'most', count: 1, rating: 3 }), 400, 'Pick a kind of rule');
  refused(() => call(mgr, 'skillRules.save', { jobCodeId: 'job_srv', type: 'atLeast', count: 1, rating: 9 }), 400, 'Pick a rating on the scale');
  refused(() => call(mgr, 'skillRules.save', { jobCodeId: 'job_srv', type: 'atLeast', count: 1, rating: 3, daypart: 'Brunch' }), 400, 'Pick one of the dayparts');
  refused(() => call(mgr, 'skillRules.save', { jobCodeId: 'job_srv', type: 'atLeast', count: 1, rating: 3, programmingId: 'prg_nope' }), 404);
  assert.equal(translateError('Pick a kind of rule', 'es'), 'Elige un tipo de regla');
  // On a programming item: counts only when it runs, in its rooms and hours.
  const item = store.list('programming').find((x) => x.pars?.some((p) => p.jobCodeId === 'job_bar')) || store.list('programming')[0];
  const rule = call(mgr, 'skillRules.save', { jobCodeId: 'job_bar', type: 'atLeast', count: 9, rating: 1, programmingId: item.id }).rule;
  const w = call(mgr, 'skillMix.week', { weekStart: WEEK });
  const days = w.days.filter((d) => d.results.some((x) => x.ruleId === rule.id)).map((d) => new Date(`${d.date}T00:00:00Z`).getUTCDay());
  assert.ok(days.length > 0 && days.every((d) => item.days.includes(d)), 'only the item’s days');
  const listed = call(mgr, 'skillRules.list');
  assert.ok(listed.programming.some((p) => p.id === item.id) && listed.dayparts.includes('Dinner'));
  // Off: not evaluated. Delete: gone.
  call(mgr, 'skillRules.save', { ...rule, active: false });
  assert.ok(!call(mgr, 'skillMix.week', { weekStart: WEEK }).days.some((d) => d.results.some((x) => x.ruleId === rule.id)));
  call(mgr, 'skillRules.delete', { id: rule.id });
  assert.equal(store.get(RULE_COL, rule.id), null);
  // For the schedule generator: ratings by position, managers only.
  const ai = call(mgr, 'skillMix.week', { weekStart: WEEK, includeRatings: true });
  assert.ok(ai.ratingsByPosition.job_srv.some((p) => p.name === 'Andrea' && p.rating === 5));
});

// ---------- the Claude connector ----------

let A;
before(async () => { A = await startApp(); });
after(async () => { await A?.close(); });
const ctxFor = (user, { scopes = [READ, WRITE] } = {}) => createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, has: () => true, scopes, via: 'claude', client: 'Test client', now: () => Date.parse('2026-09-27T18:00:00Z') });

test('tools: get_skill_mix reads, set_rating previews then saves; employees get neither, and get refused', async () => {
  const store = A.db.store;
  const mgr = store.get('users', 'usr_moe'), emp = store.get('users', 'usr_karen');
  assert.ok(store.get(RULE_COL, RULE), 'the demo server seeds a rule');
  const names = (u) => visibleTools(TOOLS, u, { has: () => true, scopes: [READ, WRITE], settings: store.get('settings', 'settings') }).map((t) => t.name);
  assert.ok(names(mgr).includes('get_skill_mix') && names(mgr).includes('set_rating'));
  assert.ok(!names(emp).includes('get_skill_mix') && !names(emp).includes('set_rating'));
  assert.equal((await runTool(toolByName('get_skill_mix'), { week: WEEK }, ctxFor(emp))).ok, false);
  assert.equal((await runTool(toolByName('set_rating'), { person: 'Andrea', position: 'Server', rating: 1, confirm: true }, ctxFor(emp))).ok, false);
  assert.equal(store.get(RATING_COL, 'rtg_usr_andrea_job_srv').value, 5, 'unchanged');

  const got = await runTool(toolByName('get_skill_mix'), { week: WEEK, includeRatings: true }, ctxFor(mgr));
  assert.equal(got.ok, true, got.error);
  const sat = got.data.days.find((d) => d.date === SAT).results[0];
  assert.equal(sat.status, 'fail');
  assert.match(sat.why, /1 scheduled rated 5\+ \(needs 2\)/);
  assert.ok(sat.suggestions.some((s) => s.name === 'Manny' && s.add));
  assert.ok(got.data.ratingsByPosition.Server.length > 0);

  const prev = await runTool(toolByName('set_rating'), { person: 'Tori', position: 'Server', rating: 4 }, ctxFor(mgr));
  assert.equal(prev.ok, true, prev.error);
  assert.match(prev.summary, /Preview only/);
  assert.equal(store.get(RATING_COL, 'rtg_usr_tori_job_srv'), null, 'nothing saved by the preview');
  const done = await runTool(toolByName('set_rating'), { person: 'Tori', position: 'Server', rating: 4, note: 'Test', confirm: true }, ctxFor(mgr));
  assert.equal(done.ok, true, done.error);
  assert.equal(store.get(RATING_COL, 'rtg_usr_tori_job_srv').value, 4);
});
