// Legal name vs. the name people go by (core/names.js). "CJ" in the demo has an invented legal name,
// Carlos Javier Ortiz. The name everyone sees stays `name`; the legal name is for payroll and only the
// person, admins and managers who manage them see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { aliasesOf, legalNameOf, nameWithLegal, nameMatches, payrollName, canSeeLegalName, legalNameFor, nameColumns } from '../core/names.js';
import { matchWorkers, apiWorkerDoc } from '../core/adp.js';
import { readAdpCsv } from '../core/adp-csv.js';
import { matchEmployees } from '../core/toast.js';
import { matchPeople } from '../core/importer.js';
import { tipsCsvRows, hoursCsvRows, toCsv } from '../core/exports.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';
import { hotp, stepAt } from '../server/totp.js';

const LEGAL = /Carlos|Ortiz/;

function setup() {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T10:00:00') });
  const u = (name) => store.get('users', ids.userId[name]);
  return { store, svc, ids, u };
}

test('names: aliases, payroll name, "CJ (Carlos Javier Ortiz)", and an empty legal name means the same as name', () => {
  const cj = { id: 'u1', name: 'CJ', legalFirstName: ' Carlos  Javier ', legalLastName: 'Ortiz' };
  assert.equal(legalNameOf(cj), 'Carlos Javier Ortiz');
  assert.deepEqual(aliasesOf(cj), ['CJ', 'Carlos Javier', 'Carlos Javier Ortiz']);
  assert.equal(payrollName(cj), 'Carlos Javier Ortiz');
  assert.equal(nameWithLegal(cj), 'CJ (Carlos Javier Ortiz)');
  const plain = { id: 'u2', name: 'Ana Rivera' };
  assert.deepEqual(aliasesOf(plain), ['Ana Rivera']);
  assert.equal(payrollName(plain), 'Ana Rivera');
  assert.equal(nameWithLegal(plain), 'Ana Rivera');
  assert.equal(nameWithLegal({ name: 'Ana Rivera', legalFirstName: 'Ana', legalLastName: 'Rivera' }), 'Ana Rivera', 'the same name twice is shown once');
  assert.deepEqual(aliasesOf({ name: 'Ana', legalFirstName: 'ana', legalLastName: '' }), ['Ana']);
});

test('search finds people by either name, but never by a legal name the viewer was not sent', () => {
  const { svc, u } = setup();
  const cjFor = (viewer) => svc.call(viewer, 'app.bootstrap').employees.find((e) => e.name === 'CJ');
  const admin = cjFor(u('Moe'));
  for (const q of ['cj', 'CJ', 'ortiz', 'carlos jav', 'Javier Ortiz', '']) assert.ok(nameMatches(admin, q), q);
  assert.ok(!nameMatches(admin, 'rivera'));
  const coworker = cjFor(u('Alex D'));
  assert.ok(nameMatches(coworker, 'cj'));
  assert.ok(!nameMatches(coworker, 'ortiz'), 'a coworker has no legal name to search');
  assert.ok(nameMatches({ name: 'Mary Ann', sheetName: 'MARYANN' }, 'maryann'), 'the name on the schedule too');
});

test('visible to admins, the managers who manage that person, and the person themselves', () => {
  const { svc, u, store } = setup();
  // Admin: everyone's.
  const boot = svc.call(u('Moe'), 'app.bootstrap');
  const cj = boot.employees.find((e) => e.name === 'CJ');
  assert.deepEqual([cj.legalFirstName, cj.legalLastName], ['Carlos Javier', 'Ortiz']);
  assert.equal(boot.employees.find((e) => e.name === 'Alex D').legalFirstName, '', 'an empty legal name is sent as empty to those who may see it');
  // Themselves: in bootstrap's me and in My settings' saves.
  const mine = svc.call(u('CJ'), 'app.bootstrap');
  assert.equal(legalNameOf(mine.me), 'Carlos Javier Ortiz');
  assert.equal(legalNameOf(mine.employees.find((e) => e.id === u('CJ').id)), 'Carlos Javier Ortiz');
  assert.equal(legalNameOf(svc.call(u('CJ'), 'account.preferences', { appearance: 'dark' })), 'Carlos Javier Ortiz');
  assert.equal(legalNameOf(svc.call(u('CJ'), 'employees.setAvailability', { availability: {} })), 'Carlos Javier Ortiz');
  // A manager: the people they manage (employees, supervisors), not another manager.
  const kelly = u('Kelly');
  const added = svc.call(kelly, 'employees.save', { name: 'Dee', role: 'employee', legalFirstName: 'Dolores', legalLastName: 'Vega' });
  assert.equal(legalNameOf(added), 'Dolores Vega');
  const kb = svc.call(kelly, 'app.bootstrap').employees;
  assert.equal(legalNameOf(kb.find((e) => e.id === added.id)), 'Dolores Vega');
  assert.ok(!('legalFirstName' in kb.find((e) => e.name === 'CJ')), 'a peer manager does not see it');
  assert.ok(!canSeeLegalName(kelly, u('CJ')) && canSeeLegalName(u('Moe'), u('CJ')) && canSeeLegalName(u('CJ'), u('CJ')));
  // Saving someone without the legal-name fields (the phone app, an older page) leaves it as it was.
  const resaved = svc.call(kelly, 'employees.save', { id: added.id, name: 'Dee', role: 'employee', email: '' });
  assert.equal(legalNameOf(resaved), 'Dolores Vega');
  assert.equal(legalNameOf(store.get('users', added.id)), 'Dolores Vega');
  // Clearing it.
  svc.call(kelly, 'employees.save', { id: added.id, name: 'Dee', role: 'employee', legalFirstName: '', legalLastName: '' });
  assert.equal(legalNameOf(store.get('users', added.id)), '');
  // Merging: the legal name comes along when the person kept has none.
  const imported = svc.call(kelly, 'employees.save', { name: 'DEE', role: 'employee', legalFirstName: 'Dolores', legalLastName: 'Vega' });
  const merged = svc.call(kelly, 'employees.merge', { fromId: imported.id, intoId: added.id });
  assert.equal(legalNameOf(merged.into), 'Dolores Vega');
});

test('each person can correct their own legal name in My settings (saved as typed, with the date)', () => {
  const { svc, u, store } = setup();
  const r = svc.call(u('Alex D'), 'profile.update', { name: 'Alex D', legalFirstName: 'Alexander', legalLastName: 'Duarte' });
  assert.equal(legalNameOf(r), 'Alexander Duarte');
  assert.equal(r.name, 'Alex D', 'the name everyone sees is unchanged');
  const saved = store.get('users', u('Alex D').id);
  assert.ok(saved.legalNameChangedAt);
  // Only the fields sent change; the same value again is not a change.
  const at = saved.legalNameChangedAt;
  svc.call(u('Alex D'), 'profile.update', { phone: '' });
  svc.call(u('Alex D'), 'profile.update', { legalFirstName: 'Alexander' });
  assert.equal(store.get('users', u('Alex D').id).legalNameChangedAt, at);
  assert.equal(legalNameOf(store.get('users', u('Alex D').id)), 'Alexander Duarte');
});

test('coworkers never get a legal name from any RPC (employee, supervisor, and a manager who can’t manage that person)', async () => {
  const { svc: probe, u: pu } = setup();
  const methods = Object.keys(probe.api);
  assert.ok(methods.length > 50);
  const ARGS = { start: '2026-09-21', end: '2026-10-11', weekStart: '2026-09-28', date: '2026-09-29', from: '2026-09-01', to: '2026-10-31', week: '2026-09-28' };
  // A positive control: the admin's bootstrap has it, so the check below would catch a leak.
  assert.match(JSON.stringify(probe.call(pu('Moe'), 'app.bootstrap')), LEGAL);
  for (const who of ['Alex D', 'Courtney', 'Kelly']) {
    const { svc, u, store } = setup(); // a fresh restaurant per viewer: some calls change things
    const viewer = u(who);
    let returned = 0;
    for (const m of methods) {
      let out;
      try { out = await svc.call(viewer, m, { ...ARGS }); } catch { continue; }
      returned++;
      const text = JSON.stringify(out ?? null);
      assert.doesNotMatch(text, LEGAL, `${who} got CJ's legal name from ${m}`);
    }
    assert.ok(returned > 20, `${who}: enough RPCs answered (${returned})`);
    const boot = svc.call(viewer, 'app.bootstrap');
    for (const e of boot.employees) {
      const may = canSeeLegalName(viewer, store.get('users', e.id)); // Kelly (a manager) does see the employees she manages
      assert.equal('legalFirstName' in e && 'legalLastName' in e, may, `${who} → ${e.name}`);
    }
  }
});

test('ADP: matched by legal name first, then the name they go by; API workers keep ADP’s legal first name', () => {
  const users = [
    { id: 'u-cj', name: 'CJ', legalFirstName: 'Carlos Javier', legalLastName: 'Ortiz', email: '' },
    { id: 'u-dee', name: 'Dee', legalFirstName: 'Dana', legalLastName: 'Ruiz', email: '' },
    { id: 'u-dana', name: 'Dana Ruiz', email: '' }, // goes by the same name as Dee's legal name
    { id: 'u-sam', name: 'Sam Lee', email: '' },
  ];
  const workers = [
    { id: 'w1', origin: 'csv', name: 'Carlos Javier Ortiz', first: 'Carlos Javier', last: 'Ortiz', email: '', ids: [] },
    { id: 'w2', origin: 'csv', name: 'Dana Ruiz', first: 'Dana', last: 'Ruiz', email: '', ids: [] },
    { id: 'w3', origin: 'csv', name: 'Sam Lee', first: 'Sam', last: 'Lee', email: '', ids: [] },
  ];
  const m = matchWorkers(workers, users);
  assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, `${v.userId}/${v.by}`])), { w1: 'u-cj/name', w2: 'u-dee/name', w3: 'u-sam/name' },
    'the legal name wins over someone who goes by that name; no legal name falls back to the common one');

  // The API sends a legal and a preferred name: the legal one matches the legal name saved here.
  const doc = apiWorkerDoc({ associateOID: 'G1', person: { legalName: { givenName: 'Carlos Javier', familyName1: 'Ortiz' }, preferredName: { givenName: 'CJ' } } }, null, 'now');
  assert.deepEqual([doc.name, doc.first, doc.legalFirst], ['CJ Ortiz', 'CJ', 'Carlos Javier']);
  const api = matchWorkers([doc], users);
  assert.equal(api.get('aoid:G1')?.userId, 'u-cj');
  // Someone with no legal name saved is still found by the name ADP calls them by.
  const sam = apiWorkerDoc({ associateOID: 'G2', person: { legalName: { givenName: 'Samuel', familyName1: 'Lee' }, preferredName: { givenName: 'Sam' } } }, null, 'now');
  assert.equal(matchWorkers([sam], users).get('aoid:G2')?.userId, 'u-sam');
});

test('ADP CSV import (a payroll file) finds the demo’s CJ by legal name', () => {
  const { svc, u } = setup();
  const csv = ['"Employee Name","Department","Date","Time In","Time Out","Total Hours"', '"Ortiz, Carlos Javier","Managers","09/22/2026","11:00 AM","7:00 PM","8.00"'].join('\n');
  const { punches } = readAdpCsv(csv);
  const preview = svc.call(u('Moe'), 'adp.previewImport', { punches });
  assert.equal(preview.rows[0].userId, u('CJ').id);
  assert.equal(preview.rows[0].matchedBy, 'name');
});

test('Toast employees: legal name first, then chosen and common names', () => {
  const users = [
    { id: 'u-cj', name: 'CJ', legalFirstName: 'Carlos Javier', legalLastName: 'Ortiz', email: '' },
    { id: 'u-cj2', name: 'Carlos Javier Ortiz', email: '' }, // a different person who goes by that name
    { id: 'u-bo', name: 'Bo Diaz', email: '' },
  ];
  const toast = [
    { id: 't1', firstName: 'Carlos Javier', chosenName: 'CJ', lastName: 'Ortiz', email: '' },
    { id: 't2', firstName: 'Bo', lastName: 'Diaz', email: '' },
  ];
  const m = matchEmployees(toast, users);
  assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, v.userId])), { t1: 'u-cj', t2: 'u-bo' });
});

test('schedule importer: the name on the sheet first, then the legal name', () => {
  const people = [
    { id: 'cj', name: 'CJ', legalFirstName: 'Carlos Javier', legalLastName: 'Ortiz' },
    { id: 'moe', name: 'Moe', sheetName: 'MOE', legalFirstName: 'Maurice', legalLastName: 'Banks' },
    { id: 'tess', name: 'Tess', legalFirstName: 'Teresa', legalLastName: 'Quinn' },
  ];
  const m = matchPeople(['CJ', 'CARLOS JAVIER ORTIZ', 'MOE', 'MAURICE BANKS', 'TERESA'], people);
  const got = Object.fromEntries([...m].map(([k, v]) => [k, `${v.id}:${v.how}`]));
  assert.deepEqual(got, { CJ: 'cj:name', MOE: 'moe:sheet', TERESA: 'tess:legalFirst' }, 'one person per name: the common name took CJ and Moe first');
  const legalOnly = matchPeople(['CARLOS JAVIER ORTIZ', 'MAURICE BANKS'], people);
  assert.deepEqual(Object.fromEntries([...legalOnly].map(([k, v]) => [k, `${v.id}:${v.how}`])), { 'CARLOS JAVIER ORTIZ': 'cj:legal', 'MAURICE BANKS': 'moe:legal' });
});

test('exports: tips and hours CSVs carry a legal name column and a name column', () => {
  const people = {
    cj: { id: 'cj', name: 'CJ', legalFirstName: 'Carlos Javier', legalLastName: 'Ortiz' },
    ana: { id: 'ana', name: 'Ana', legalFirstName: '', legalLastName: '' }, // empty: same as the name
    kim: { id: 'kim', name: 'Kim' }, // held back from this manager: blank, never guessed
  };
  const person = (userId, name, amount) => ({ userId, name, jobs: [{ jobCodeId: 'srv' }], minutes: 300, source: 'schedule', estimated: false, shifts: 1, points: 1, sharePct: 50, split: amount, adjustment: 0, adjustments: [], amount });
  const rep = { weekStart: '2026-09-28', label: 'Sep 28 – Oct 4', total: 30000,
    pools: [{ pool: { name: 'Servers', method: 'hours_points' }, periods: [{ label: 'Mon', people: [person('cj', 'CJ', 10000), person('ana', 'Ana', 10000), person('kim', 'Kim', 10000)] }] }],
    people: [person('cj', 'CJ', 10000), person('ana', 'Ana', 10000), person('kim', 'Kim', 10000)] };
  const rows = tipsCsvRows(rep, { people, jobName: () => 'Server' });
  assert.deepEqual(rows[0].slice(0, 5), ['Pool', 'Period', 'Legal name', 'Name', 'Positions']);
  assert.ok(rows.filter((r) => r.length).every((r) => r.length === rows[0].length), 'every row lines up with the header');
  assert.deepEqual(rows.slice(1, 4).map((r) => r.slice(2, 4)), [['Carlos Javier Ortiz', 'CJ'], ['Ana', 'Ana'], ['', 'Kim']]);
  assert.deepEqual(rows.at(-3).slice(2, 4), ['Carlos Javier Ortiz', 'CJ'], 'the week rows too');
  assert.match(toCsv(rows), /"Carlos Javier Ortiz","CJ"/);

  const part = (h, cost) => ({ hours: h, cost, ot: 0, tips: 0 });
  const review = { weekStart: '2026-09-28', people: [
    { key: 'cj', userId: 'cj', name: 'CJ', matched: true, jobs: ['mgr'], sched: part(30, 600), actual: part(31.5, 630), source: 'adp' },
    { key: 'x', userId: null, name: 'Zed Quill', matched: false, jobs: [], sched: part(0, 0), actual: part(4, 60), source: 'adp' },
  ] };
  const hours = hoursCsvRows(review, { people, jobName: (id) => (id === 'mgr' ? 'Manager' : '') });
  assert.deepEqual(hours[0].slice(0, 4), ['Week of', 'Legal name', 'Name', 'Positions']);
  assert.deepEqual(hours[1].slice(0, 6), ['2026-09-28', 'Carlos Javier Ortiz', 'CJ', 'Manager', 30, 31.5]);
  assert.deepEqual(hours[2].slice(1, 3), ['', 'Zed Quill'], 'a clock-in nobody is matched to has no legal name here');
  assert.deepEqual(nameColumns(legalNameFor({ id: 'x', role: 'employee' }, people.cj)), ['', 'CJ']);
});

test('HTTP: the welcome wizard asks for the name you go by and an optional legal name', async () => {
  const A = await startApp();
  try {
    const mgr = jsonClient(A.base);
    assert.equal((await signIn(mgr.post, 'moe@demo.shiftboard')).status, 200);
    const added = (await mgr.post('/api/rpc/employees.save', { role: 'employee', invite: true, name: 'Nina', email: 'nina@rabbits.co' })).body.result;
    await A.settled();
    const token = /#\/welcome\?token=([\w-]+)/.exec(A.resend.emails().find((m) => m.to[0] === 'nina@rabbits.co').text)[1];
    const nina = jsonClient(A.base);
    assert.equal((await nina.post('/api/onboarding/start', { token })).status, 200);
    await nina.post('/api/onboarding/password', { password: 'blue-harbor-lantern' });
    const setup = (await nina.post('/api/onboarding/totp/setup', {})).body.result;
    await nina.post('/api/onboarding/totp/confirm', { code: hotp(setup.secret, stepAt(Date.now())) });
    await nina.post('/api/onboarding/recovery/ack', { saved: true });
    const p = await nina.post('/api/onboarding/profile', { name: 'Nina', phone: '', legalFirstName: 'Antonina', legalLastName: 'Petrova' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.result.profile.name, p.body.result.profile.legalFirstName, p.body.result.profile.legalLastName], ['Nina', 'Antonina', 'Petrova']);
    // The manager sees it in Team; a coworker doesn't.
    const team = (await mgr.post('/api/rpc/app.bootstrap')).body.result.employees.find((e) => e.id === added.id);
    assert.equal(legalNameOf(team), 'Antonina Petrova');
    const alex = jsonClient(A.base);
    assert.equal((await signIn(alex.post, 'alexd@demo.shiftboard')).status, 200);
    const seen = (await alex.post('/api/rpc/app.bootstrap')).body.result.employees.find((e) => e.id === added.id);
    assert.equal(seen.name, 'Nina');
    assert.doesNotMatch(JSON.stringify(seen), /Antonina|Petrova/);
    // Skipping it is fine.
    const again = await nina.post('/api/onboarding/profile', { name: 'Nina', phone: '' });
    assert.equal(again.status, 200);
    assert.equal(again.body.result.profile.legalFirstName, 'Antonina', 'not sent: left as it was');
  } finally {
    await A.close();
  }
});
