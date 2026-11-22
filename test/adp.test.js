// ADP integration: the mTLS API client (fake transport, no network), the day-by-day sync, the CSV
// import (fixtures are invented data), matching, the clock-in source (ADP / Toast / both, never
// double counted), the staffing calibration math, and the cron secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { readAdpCsv, parseCsv, detectColumns, findHeader, parseTime, parseDate, parseHours, mappingToNames, mappingFromNames } from '../core/adp-csv.js';
import { planCsvImport, applyCsvImport, matchWorkers, timeCardPunches, payPeriodStart, csvWorkerKey } from '../core/adp.js';
import { pickEntries, resolveClockSource, clockEntries } from '../core/clock.js';
import { laborReview } from '../core/labor.js';
import { dayWork } from '../core/tips.js';
import { calibrate, fitHours, splitByDaypart, daypartWindows, overtimeRisk } from '../core/calibrate.js';
import { createAdpClient, adpConfig, mtlsAgent, readPem, _tokenCache, DEFAULT_HOST, DEFAULT_TOKEN_URL } from '../server/adp.js';
import { runAdpSync, cronRange } from '../server/adp-sync.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { addDays } from '../core/time.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adp');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ---------- FAKE credentials, for tests only. Not real keys or certificates: the bodies are plain words. ----------
const pem = (label, words) => [`-----BEGIN ${label}-----`, Buffer.from(words).toString('base64'), `-----END ${label}-----`, ''].join('\n');
const FAKE_CERT = pem('CERTIFICATE', 'FAKE TEST CERTIFICATE, NOT REAL');
const FAKE_KEY = pem('PRIVATE KEY', 'FAKE TEST KEY, NOT REAL');
const HOST = 'https://adp-api.example.test';
const TOKEN_URL = 'https://adp-accounts.example.test/auth/oauth/v2/token';
const ENV = { ADP_CLIENT_ID: 'fake-client', ADP_CLIENT_SECRET: 'fake-secret', ADP_CERT_PEM: FAKE_CERT, ADP_KEY_PEM: FAKE_KEY, ADP_API_HOST: HOST, ADP_TOKEN_URL: TOKEN_URL };
const noSleep = async () => {};

// ---------- a fake ADP API, as a transport function ----------
function fakeAdp({ workers = [], cards = {}, period = { startDate: '2026-09-14', endDate: '2026-09-27' }, expiresIn = 3600, team = false } = {}) {
  const log = { logins: 0, calls: [], agents: new Set(), tokenRequests: [] };
  let token = null;
  log.revoke = () => { token = null; };
  const reply = (status, body, headers = {}) => ({ status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: body == null ? '' : JSON.stringify(body) });
  const cardsFor = (aoid, filter) => (cards[aoid] || []).filter((c) => (/'current'/.test(filter) ? c.timePeriod.startDate === period.startDate : filter.includes(`'${c.timePeriod.startDate}'`)));
  const transport = async (url, init) => {
    const u = new URL(url);
    log.calls.push(u.pathname + u.search);
    log.agents.add(init.agent);
    if (url.startsWith(TOKEN_URL)) {
      log.tokenRequests.push(init);
      const basic = Buffer.from(`${ENV.ADP_CLIENT_ID}:${ENV.ADP_CLIENT_SECRET}`).toString('base64');
      if (init.method !== 'POST' || init.headers.Authorization !== `Basic ${basic}` || init.body !== 'grant_type=client_credentials') return reply(401, { error: 'invalid_client' });
      log.logins++;
      token = `adp-token-${log.logins}`;
      return reply(200, { access_token: token, token_type: 'Bearer', expires_in: expiresIn });
    }
    if (init.headers.Authorization !== `Bearer ${token}`) return reply(401, { error: 'invalid_token' });
    const top = Number(u.searchParams.get('$top') || 0), skip = Number(u.searchParams.get('$skip') || 0);
    const page = (rows) => (top ? rows.slice(skip, skip + top) : rows);
    if (u.pathname === '/hr/v2/workers') {
      const rows = page(workers);
      return rows.length ? reply(200, { workers: rows }) : reply(204, null);
    }
    const filter = u.searchParams.get('$filter') || '';
    let m = u.pathname.match(/^\/time\/v2\/workers\/([^/]+)\/team-time-cards$/);
    if (m && team) {
      const rows = page(Object.keys(cards).map((aoid) => ({ associateOID: aoid, timeCards: cardsFor(aoid, filter) })));
      return rows.length ? reply(200, { teamTimeCards: rows }) : reply(204, null);
    }
    m = u.pathname.match(/^\/time\/v2\/workers\/([^/]+)\/time-cards$/);
    if (m) return reply(200, { timeCards: cardsFor(decodeURIComponent(m[1]), filter) });
    return reply(404, { message: `No route ${u.pathname}` });
  };
  return { transport, log };
}
const worker = (aoid, given, family, { email = '', file = '', dept = '' } = {}) => ({
  associateOID: aoid, workerID: { idValue: file }, person: { legalName: { givenName: given, familyName1: family } },
  businessCommunication: { emails: email ? [{ emailUri: email }] : [] }, workerStatus: { statusCode: { codeValue: 'Active' } },
  workAssignments: [{ primaryIndicator: true, payrollFileNumber: file, homeOrganizationalUnits: dept ? [{ typeCode: { codeValue: 'Department' }, nameCode: { codeValue: dept, shortName: dept } }] : [] }],
});
const card = (aoid, startDate, endDate, days) => ({
  associateOID: aoid, timePeriod: { startDate, endDate },
  dayEntries: Object.entries(days).map(([date, entries]) => ({
    entryDate: date,
    timeEntries: entries.map(([id, start, end, totals]) => ({
      entryID: id, timePeriod: { startDateTime: start, endDateTime: end },
      totals: totals.map(([code, h]) => ({ payCode: { codeValue: code }, timeDuration: `PT${Math.floor(h)}H${Math.round((h % 1) * 60)}M` })),
    })),
  })),
});
const client = (fake, extra = {}) => createAdpClient({ env: ENV, transport: fake.transport, agent: extra.agent || { fake: 'agent' }, sleep: noSleep, ...extra });

// ---------- configuration and mutual TLS ----------

test('config: env names and problems only; PEMs as text, \\n-escaped or base64; defaults for host and token URL', () => {
  const none = adpConfig({});
  assert.deepEqual(none.missing, ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM']);
  assert.equal(none.configured, false);
  assert.equal(none.host, DEFAULT_HOST);
  assert.equal(none.tokenUrl, DEFAULT_TOKEN_URL);
  assert.equal(DEFAULT_HOST, 'https://api.adp.com');
  assert.equal(DEFAULT_TOKEN_URL, 'https://accounts.adp.com/auth/oauth/v2/token');

  const ok = adpConfig({ ...ENV, CRON_SECRET: 'x' });
  assert.equal(ok.configured, true);
  assert.equal(ok.host, HOST);
  assert.equal(ok.cron, true);
  assert.ok(!JSON.stringify(ok).includes('fake-secret') && !JSON.stringify(ok).includes('BEGIN'), 'no secret or PEM is echoed');

  assert.equal(readPem(FAKE_CERT, 'cert').pem, FAKE_CERT);
  assert.equal(readPem(FAKE_CERT.replace(/\n/g, '\\n'), 'cert').pem, FAKE_CERT, 'one-line with \\n escapes');
  assert.equal(readPem(Buffer.from(FAKE_KEY).toString('base64'), 'key').pem, FAKE_KEY, 'base64 of the PEM');
  assert.equal(readPem('not a pem', 'cert').problem, 'notPem');
  assert.equal(readPem(FAKE_KEY, 'cert').problem, 'notCertificate');
  assert.equal(readPem(pem('ENCRYPTED PRIVATE KEY', 'FAKE'), 'key').problem, 'encryptedKey');
  const bad = adpConfig({ ...ENV, ADP_KEY_PEM: 'nope' });
  assert.equal(bad.configured, false);
  assert.deepEqual(bad.problems, [{ env: 'ADP_KEY_PEM', problem: 'notPem' }]);
});

test('mTLS: the https.Agent carries the client certificate and key, and every request (token too) goes through it', async () => {
  const agent = mtlsAgent({ ...ENV, ADP_KEY_PEM: Buffer.from(FAKE_KEY).toString('base64') });
  assert.ok(agent instanceof https.Agent);
  assert.equal(agent.options.cert, FAKE_CERT);
  assert.equal(agent.options.key, FAKE_KEY);
  assert.equal(agent.options.minVersion, 'TLSv1.2');
  assert.throws(() => mtlsAgent({ ...ENV, ADP_CERT_PEM: '' }), /ADP_CERT_PEM and ADP_KEY_PEM/);

  // The client builds its agent from env when none is passed, and hands it to the transport on every call.
  _tokenCache.clear();
  const fake = fakeAdp({ workers: [worker('A1', 'Ana', 'Rivera')] });
  const c = createAdpClient({ env: ENV, transport: fake.transport, sleep: noSleep });
  await c.workers();
  assert.equal(fake.log.agents.size, 1);
  const used = [...fake.log.agents][0];
  assert.ok(used instanceof https.Agent && used.options.cert === FAKE_CERT && used.options.key === FAKE_KEY);
  assert.ok(fake.log.calls[0].startsWith('/auth/oauth/v2/token'), 'the token request is the first, over the same agent');
  _tokenCache.clear();
});

// ---------- token caching ----------

test('token: one sign-in shared by concurrent calls and new clients, renewed near expiry, refreshed once after a 401', async () => {
  _tokenCache.clear();
  let now = 5_000_000;
  const fake = fakeAdp({ workers: [worker('A1', 'Ana', 'Rivera')] });
  const a = client(fake, { now: () => now });
  await Promise.all([a.workers(), a.workers(), a.get('/hr/v2/workers')]);
  assert.equal(fake.log.logins, 1, 'concurrent requests share one sign-in');
  await client(fake, { now: () => now }).workers();
  assert.equal(fake.log.logins, 1, 'another client in this instance reuses the cached token');
  now += 3600 * 1000 - 4 * 60 * 1000; // within 5 minutes of expiry
  await a.workers();
  assert.equal(fake.log.logins, 2, 'renewed shortly before it expires');
  fake.log.revoke();
  await a.workers();
  assert.equal(fake.log.logins, 3, 'a 401 gets one fresh token and the request is retried');

  _tokenCache.clear();
  const wrong = createAdpClient({ env: { ...ENV, ADP_CLIENT_SECRET: 'wrong' }, transport: fake.transport, agent: {}, sleep: noSleep });
  await assert.rejects(wrong.workers(), /didn’t accept the client ID and secret/);
  await assert.rejects(createAdpClient({ env: {}, transport: fake.transport, agent: {} }).workers(), /ADP isn’t set up\. Missing: ADP_CLIENT_ID/);
  _tokenCache.clear();
});

// ---------- pagination and rate limits ----------

test('pagination: $top=100 and $skip until a short page, or 204 No Content', async () => {
  _tokenCache.clear();
  const many = Array.from({ length: 237 }, (_, i) => worker(`W${i}`, `First${i}`, `Last${i}`));
  const fake = fakeAdp({ workers: many });
  const got = await client(fake).workers();
  assert.equal(got.length, 237);
  const pages = fake.log.calls.filter((c) => c.startsWith('/hr/v2/workers'));
  assert.deepEqual(pages.map((p) => [new URL(`http://x${p}`).searchParams.get('$top'), new URL(`http://x${p}`).searchParams.get('$skip')]), [['100', '0'], ['100', '100'], ['100', '200']]);

  _tokenCache.clear();
  const exact = fakeAdp({ workers: many.slice(0, 200) }); // two full pages, then 204
  assert.equal((await client(exact).workers()).length, 200);
  assert.equal(exact.log.calls.filter((c) => c.startsWith('/hr/v2/workers')).length, 3);
  _tokenCache.clear();
});

test('rate limit: a 429 waits for Retry-After, then tries again', async () => {
  _tokenCache.clear();
  const fake = fakeAdp({ workers: [worker('A1', 'Ana', 'Rivera')] });
  let limited = 1;
  const waits = [];
  const transport = async (url, init) => (url.includes('/hr/v2/workers') && limited-- > 0
    ? { status: 429, headers: { get: (n) => (n === 'retry-after' ? '3' : null) }, text: '' } : fake.transport(url, init));
  const c = createAdpClient({ env: ENV, transport, agent: {}, sleep: async (ms) => { waits.push(ms); } });
  assert.equal((await c.workers()).length, 1);
  assert.deepEqual(waits, [3000]);
  _tokenCache.clear();
});

// ---------- the API's time cards → punches ----------

test('time cards: punches with overtime split, time off left out, ADP times in the restaurant’s zone; pay periods', () => {
  const payload = { teamTimeCards: [{ associateOID: 'A1', timeCards: [card('A1', '2026-09-14', '2026-09-27', {
    '2026-09-18': [['e1', '2026-09-18T16:00:00-06:00', '2026-09-19T01:30:00-06:00', [['REG', 8], ['OT', 1]]]],
    '2026-09-19': [['e2', '2026-09-19T17:00:00', '2026-09-19T23:00:00', [['REG', 6]]]],
    '2026-09-20': [['e3', null, null, [['PTO', 8]]]],
  })] }] };
  const p = timeCardPunches(payload, { timeZone: 'America/Denver' });
  assert.equal(p.length, 2, 'PTO is not worked time');
  assert.deepEqual([p[0].inLocal, p[0].outLocal, p[0].hours, p[0].overtimeHours, p[0].entryId], ['2026-09-18T16:00', '2026-09-19T01:30', 9, 1, 'e1']);
  assert.equal(p[0].inAt, '2026-09-18T22:00:00.000Z');
  assert.deepEqual([p[1].inLocal, p[1].outLocal, p[1].hours, p[1].inAt], ['2026-09-19T17:00', '2026-09-19T23:00', 6, null], 'no offset: already local');

  const two = { startDate: '2026-09-14', endDate: '2026-09-27' };
  assert.equal(payPeriodStart('2026-09-20', two), '2026-09-14');
  assert.equal(payPeriodStart('2026-09-28', two), '2026-09-28');
  assert.equal(payPeriodStart('2026-09-13', two), '2026-08-31');
  assert.equal(payPeriodStart('2026-10-20', { startDate: '2026-10-01', endDate: '2026-10-15' }), '2026-10-16', 'semi-monthly');
});

// ---------- the sync, against the real database layer ----------

async function freshDb() {
  const conn = await openPglite();
  const db = new DocDb(conn);
  await db.migrate();
  await db.run((s) => {
    s.insert('users', { id: 'u-ana', name: 'Ana Rivera', email: 'ana@example.test', role: 'employee', jobCodes: [{ jobCodeId: 'job-srv', rate: 12 }] });
    s.insert('users', { id: 'u-ben', name: 'Ben Okafor', email: '', role: 'employee', adpId: '2000', jobCodes: [{ jobCodeId: 'job-cook', rate: 18, primary: true }] });
    s.insert('jobCodes', { id: 'job-srv', name: 'Server', short: 'SRV', defaultRate: 12 });
    s.insert('jobCodes', { id: 'job-cook', name: 'Line Cook', short: 'LC', defaultRate: 18 });
  }, { write: true });
  return { db, close: () => conn.end() };
}

test('sync: day by day within a time budget, then continues; running it again changes nothing; the API replaces CSV copies', async () => {
  _tokenCache.clear();
  const { db, close } = await freshDb();
  try {
    const days = {};
    for (const d of ['14', '15', '16', '17']) days[`2026-09-${d}`] = [[`ana-${d}`, `2026-09-${d}T16:00:00`, `2026-09-${d}T22:30:00`, [['REG', 6.5]]]];
    const fake = fakeAdp({
      workers: [worker('A1', 'Ana', 'Rivera', { email: 'ANA@example.test', file: '001', dept: 'Servers' }), worker('B2', 'Ben', 'Okafor', { file: '002000' }), worker('C3', 'Cy', 'Nobody', { file: '003' })],
      cards: { A1: [card('A1', '2026-09-14', '2026-09-27', days)], B2: [card('B2', '2026-09-14', '2026-09-27', { '2026-09-15': [['ben-15', '2026-09-15T15:00:00', '2026-09-15T23:00:00', [['REG', 7.5]]]] })], C3: [] },
    });
    // A CSV import already has Ana on the 15th: the API's copy will replace it.
    await db.run((s) => applyCsvImport(s, planCsvImport(s, [{ row: 2, name: 'Rivera, Ana', employeeId: '', date: '2026-09-15', inMin: 960, outMin: 1350, hours: 6.5 }])), { write: true });
    assert.equal(db.store.list('timeEntries').length, 1);

    // A pretend clock: every database write "takes" 2 s and the pay period's time cards 1 s, so two
    // days fit in a 10 s budget.
    let clock = 0;
    const base = client(fake);
    const timed = { ...base, timeCards: async (o) => { clock += 1000; return base.timeCards(o); } };
    const env = { ...ENV, TIMEZONE: 'America/Denver' };
    const run = { id: 'r1', from: '2026-09-14', to: '2026-09-17' };
    const realRun = db.run.bind(db);
    db.run = async (fn, o) => { if (o?.write) clock += 2000; return realRun(fn, o); };
    const first = await runAdpSync({ db, env, client: timed, from: run.from, to: run.to, refresh: true, by: 'u-ana', run, budgetMs: 10_000, clock: () => clock });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.done.length, 2);
    assert.equal(first.next, '2026-09-16');
    assert.equal(first.lists.matched, 2, 'Ana by email, Ben by the file number on his profile');
    const second = await runAdpSync({ db, env, client: timed, from: first.next, to: run.to, by: 'u-ana', run, budgetMs: 10_000, clock: () => clock });
    assert.equal(second.next, null);
    db.run = realRun;

    const entries = db.store.list('timeEntries');
    assert.equal(entries.length, 5, 'four of Ana’s, one of Ben’s; the CSV copy of the 15th is gone');
    assert.ok(entries.every((e) => e.source === 'adp' && e.origin === 'api'));
    const ana15 = entries.find((e) => e.userId === 'u-ana' && e.date === '2026-09-15');
    assert.deepEqual([ana15.inLocal, ana15.outLocal, ana15.regularHours, ana15.overtimeHours, ana15.declaredCashTips, ana15.nonCashTips], ['2026-09-15T16:00', '2026-09-15T22:30', 6.5, 0, null, null]);
    const ben = entries.find((e) => e.userId === 'u-ben');
    assert.deepEqual([ben.jobCodeId, ben.jobFrom], ['job-cook', 'primary'], 'no department mapping, no shift: their primary position');
    const status = db.store.get('integrations', 'adp');
    assert.equal(status.lastSync.days, 4, 'chunks of one run add up');
    assert.equal(status.lastSync.finished, true);
    assert.deepEqual(status.payPeriod, { startDate: '2026-09-14', endDate: '2026-09-27' });

    const before = JSON.stringify(db.store.list('timeEntries').map(({ syncedAt, ...e }) => e).sort((a, b) => a.id.localeCompare(b.id)));
    const again = await runAdpSync({ db, env, client: client(fake), from: '2026-09-14', to: '2026-09-17', refresh: true, budgetMs: 60_000 });
    assert.ok(again.done.every((d) => d.added === 0 && d.updated === 0 && d.removed === 0));
    const after = JSON.stringify(db.store.list('timeEntries').map(({ syncedAt, ...e }) => e).sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(after, before);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM shiftboard.docs WHERE col = 'timeEntries' AND NOT deleted`);
    assert.equal(rows[0].n, 5);

    const broken = { ...client(fake), timeCards: async () => { throw new Error('boom'); } };
    const failed = await runAdpSync({ db, env, client: broken, from: '2026-09-14', to: '2026-09-14' });
    assert.equal(failed.ok, false);
    assert.equal(db.store.get('integrations', 'adp').lastSync.ok, false);
  } finally { await close(); _tokenCache.clear(); }
});

test('cron range: the last 3 days, catching up after missed runs (at most 14)', () => {
  const store = new MemoryStore();
  assert.deepEqual(cronRange(store, '2026-11-21'), { from: '2026-11-18', to: '2026-11-20' });
  store.insert('integrations', { id: 'adp', cronThrough: '2026-11-12' });
  assert.deepEqual(cronRange(store, '2026-11-21'), { from: '2026-11-13', to: '2026-11-20' });
  store.update('integrations', 'adp', { cronThrough: '2026-09-01' });
  assert.deepEqual(cronRange(store, '2026-11-21'), { from: '2026-11-07', to: '2026-11-20' });
});

// ---------- CSV ----------

test('CSV: columns found in RUN, Workforce Now and Workforce Manager style exports', () => {
  const run = readAdpCsv(fixture('run-timecard.csv'));
  assert.deepEqual([run.headerRow, run.problems], [0, []]);
  assert.deepEqual(mappingToNames(run.mapping, run.header), {
    name: 'Employee Name', firstName: null, lastName: null, employeeId: 'Employee ID', date: 'Date', in: ['Time In'], out: ['Time Out'],
    hours: 'Total Hours', regHours: null, otHours: null, payCode: null, department: 'Department', rate: null,
  });
  const wfn = readAdpCsv(fixture('wfn-timecard.csv'));
  assert.equal(wfn.headerRow, 4, 'title lines above the header are skipped');
  assert.deepEqual([wfn.mapping.in, wfn.mapping.out], [[4, 6], [5, 7]], 'In, Out, In, Out');
  assert.equal(wfn.header[wfn.mapping.employeeId], 'File Number');
  const wfm = readAdpCsv(fixture('wfm-time-detail.csv'));
  assert.deepEqual([wfm.header[wfm.mapping.employeeId], wfm.header[wfm.mapping.date], wfm.header[wfm.mapping.department]], ['Person Number', 'Apply Date', 'Labor Category']);
  assert.equal(parseCsv('a;b;c\n1;2;3')[1][2], '3', 'semicolons');
  assert.equal(findHeader([['Report'], ['Name', 'Date', 'In', 'Out']]), 1);
  // 'Date' wins over 'Day' whatever the order.
  const m = detectColumns(['Day', 'Employee', 'Date', 'Clock In', 'Clock Out']);
  assert.deepEqual([m.date, m.name, m.in, m.out], [2, 1, [3], [4]]);
  // The remembered columns apply only when they're all still there.
  const names = mappingToNames(run.mapping, run.header);
  assert.deepEqual(mappingFromNames(names, run.header), run.mapping);
  assert.equal(mappingFromNames(names, ['Something', 'Else']), null);
});

test('CSV: times, dates and hours in their usual spellings', () => {
  assert.deepEqual(['4:02 PM', '4:02p', '16:02', '1602', '402p', '04:02:00 PM', '09/18/2026 04:02 PM', '2026-09-18T16:02:00', '12:15 AM', '12:00 PM'].map(parseTime),
    [962, 962, 962, 962, 962, 962, 962, 962, 15, 720]);
  assert.equal(parseTime('MISSED'), null);
  assert.equal(parseTime('4'), null);
  assert.deepEqual(['9/18/2026', '09-18-26', 'Fri 09/18/2026', 'Sep 18, 2026', '18-Sep-2026', '2026-09-18'].map(parseDate), Array(6).fill('2026-09-18'));
  assert.equal(parseDate('13/45/2026'), null);
  assert.deepEqual(['6.5', '6:30', '6h 30m', 'PT6H30M', '1,200.5'].map(parseHours), [6.5, 6.5, 6.5, 6.5, 1200.5]);
});

test('CSV: overnight punches, meal breaks, missing clock-outs, overtime rows, time off and total lines', () => {
  const run = readAdpCsv(fixture('run-timecard.csv'));
  const ana15 = run.punches.find((p) => p.name === 'Rivera, Ana' && p.date === '2026-09-15');
  assert.deepEqual([ana15.inMin, ana15.outMin, ana15.overnight, ana15.hours], [17 * 60, 25.5 * 60, true, 8.5], '5 PM to 1:30 AM is 8.5 hours, the next morning');
  const benOpen = run.punches.find((p) => p.name === 'Okafor, Ben' && p.date === '2026-09-16');
  assert.deepEqual([benOpen.inMin, benOpen.outMin, benOpen.hours], [900, null, null], 'no clock-out');

  const wfn = readAdpCsv(fixture('wfn-timecard.csv'));
  const dario18 = wfn.punches.find((p) => p.date === '2026-09-18' && p.name === 'Mendez, Dario');
  assert.deepEqual([dario18.inMin, dario18.outMin, dario18.breakMinutes, dario18.overnight, dario18.hours], [960, 26 * 60, 30, true, 9], 'two pairs with a 30-minute break, out after midnight');
  const dario19 = wfn.punches.find((p) => p.date === '2026-09-19' && p.name === 'Mendez, Dario');
  assert.equal(dario19.employeeId, '004410', 'a row without a name belongs to the person above');
  assert.equal(dario19.overtimeHours, 1.25, 'the OT row is that day’s overtime');
  assert.ok(!wfn.punches.some((p) => p.date === '2026-09-20'), 'PTO is not worked time');
  assert.deepEqual(wfn.skipped.map((s) => s.reason).sort(), ['notWorked', 'overtimeMoved', 'total', 'total']);
  const eun19 = wfn.punches.find((p) => p.name === 'Park, Eun' && p.date === '2026-09-19');
  assert.deepEqual([eun19.inMin, eun19.hours], [null, 5], 'hours with no times are kept');

  const wfm = readAdpCsv(fixture('wfm-time-detail.csv'));
  const ben = wfm.punches.find((p) => p.name === 'Ben Okafor');
  assert.deepEqual([ben.inMin, ben.outMin, ben.overnight, ben.hours], [900, 24 * 60 + 15, true, 9.25], 'the out cell has its own (next) date');
});

function team() {
  const store = new MemoryStore();
  store.insert('users', { id: 'u-ana', name: 'Ana Rivera', email: 'ana@example.test', role: 'employee', jobCodes: [{ jobCodeId: 'job-srv', primary: true }] });
  store.insert('users', { id: 'u-ben', name: 'Ben Okafor', email: '', role: 'employee', jobCodes: [{ jobCodeId: 'job-cook' }] });
  store.insert('users', { id: 'u-cora', name: 'Cora L', email: '', role: 'employee', adpId: '3300', jobCodes: [] });
  store.insert('users', { id: 'u-mgr', name: 'Mo Manager', email: 'mo@example.test', role: 'manager', jobCodes: [] });
  store.insert('jobCodes', { id: 'job-srv', name: 'Server', short: 'SRV', defaultRate: 12 });
  store.insert('jobCodes', { id: 'job-cook', name: 'Line Cook', short: 'LC', defaultRate: 18 });
  store.insert('jobCodes', { id: 'job-host', name: 'Host', short: 'HST', defaultRate: 14 });
  store.insert('shifts', { id: 's-ben', userId: 'u-ben', date: '2026-09-14', start: '15:00', end: '23:00', jobCodeId: 'job-cook', published: true });
  return store;
}

test('CSV import: matching, unmatched rows flagged, and re-importing the same file or week never doubles', () => {
  const store = team();
  const svc = createService(store);
  const mgr = store.get('users', 'u-mgr');
  const { punches } = readAdpCsv(fixture('run-timecard.csv'));
  assert.throws(() => svc.call(store.get('users', 'u-ana'), 'adp.previewImport', { punches }), /Managers only/);
  assert.throws(() => svc.call(mgr, 'adp.importCsv', { punches: [] }), /no punches/);

  const preview = svc.call(mgr, 'adp.previewImport', { punches });
  assert.equal(store.list('timeEntries').length, 0, 'the preview saves nothing');
  assert.deepEqual([preview.counts.new, preview.counts.unmatched, preview.counts.overnight, preview.counts.noClockOut], [6, 1, 1, 1]);
  const byName = (n) => preview.rows.filter((r) => r.name.startsWith(n));
  assert.ok(byName('Ana').every((r) => r.userId === 'u-ana' && r.matchedBy === 'name'));
  assert.ok(byName('Ben').every((r) => r.userId === 'u-ben'));
  assert.equal(byName('Cora')[0].userId, 'u-cora', 'by the employee ID saved on the person');
  assert.equal(byName('Cora')[0].matchedBy, 'id');
  assert.equal(byName('Zed')[0].userId, null, 'nobody by that name or ID: flagged');
  assert.deepEqual(byName('Ana').map((r) => r.jobCodeId), ['job-srv', 'job-srv'], 'the Servers department matches the Server position');
  const ben14 = byName('Ben').find((r) => r.date === '2026-09-14');
  assert.equal(ben14.jobCodeId, 'job-cook', 'Line Cooks → Line Cook');

  const first = svc.call(mgr, 'adp.importCsv', { punches, fileName: 'run-timecard.csv', columns: { name: 'Employee Name', in: ['Time In'] } });
  assert.deepEqual([first.counts.new, first.from, first.to], [6, '2026-09-14', '2026-09-16']);
  const saved = store.list('timeEntries');
  assert.equal(saved.length, 6);
  const t = saved.find((e) => e.userId === 'u-ana' && e.date === '2026-09-15');
  for (const k of ['id', 'source', 'externalId', 'date', 'userId', 'jobCodeId', 'inAt', 'outAt', 'regularHours', 'overtimeHours', 'hourlyWage', 'declaredCashTips', 'nonCashTips']) assert.ok(k in t, `time entry has ${k}`);
  assert.deepEqual([t.source, t.origin, t.inLocal, t.outLocal, t.regularHours, t.overtimeHours, t.nonCashTips], ['adp', 'csv', '2026-09-15T17:00', '2026-09-16T01:30', 8.5, null, null]);
  assert.equal(store.get('integrations', 'adp').csvColumns.name, 'Employee Name', 'the columns are remembered');

  // The same file again: nothing new, nothing changed.
  const again = svc.call(mgr, 'adp.importCsv', { punches });
  assert.deepEqual([again.counts.new, again.counts.updated, again.counts.same], [0, 0, 6]);
  assert.equal(store.list('timeEntries').length, 6);
  // The same week exported again without the ID column (keyed by name now): still the same punches.
  const noIds = punches.map((p) => ({ ...p, employeeId: '' }));
  const third = svc.call(mgr, 'adp.previewImport', { punches: noIds });
  assert.equal(third.counts.new, 0, 'matched to the stored punches by person, date and time in');
  // A corrected export: Ana's 14th now starts at 4:15. Her old punch that day is replaced, not kept.
  const fixed = punches.map((p) => (p.name === 'Rivera, Ana' && p.date === '2026-09-14' ? { ...p, inMin: 975, hours: 6.25 } : p));
  const corrected = svc.call(mgr, 'adp.importCsv', { punches: fixed });
  assert.deepEqual([corrected.counts.new, corrected.counts.removed], [1, 1]);
  assert.equal(store.list('timeEntries', (e) => e.userId === 'u-ana' && e.date === '2026-09-14').length, 1);
  // Duplicate lines in one file count once.
  const wfn = readAdpCsv(fixture('wfn-timecard.csv'));
  const dup = svc.call(mgr, 'adp.previewImport', { punches: wfn.punches });
  assert.equal(dup.counts.duplicate, 1);

  // Matching Zed by hand: his clock-in follows, and his ADP ID is saved on the person.
  const zed = svc.call(mgr, 'adp.get').workers.find((w) => w.name === 'Zed Quill');
  assert.equal(zed.userId, null);
  const r = svc.call(mgr, 'adp.saveMapping', { workers: [{ id: zed.id, userId: 'u-mgr' }] });
  assert.equal(r.entriesUpdated, 1);
  assert.equal(store.get('users', 'u-mgr').adpId, '009999');
  assert.throws(() => svc.call(mgr, 'adp.saveMapping', { workers: [{ id: zed.id, userId: 'u-ana' }] }), /already matched to another ADP person/);
});

// ---------- matching ----------

test('matching: email first, then the employee ID on the person, then name; matches made by hand stay', () => {
  const users = [
    { id: 'u1', name: 'Ana Rivera', email: 'ana@example.test' }, { id: 'u2', name: 'Ben O', email: '', adpId: '00042' },
    { id: 'u3', name: 'Cora Lindqvist', email: '' }, { id: 'u4', name: 'Sam', email: '' }, { id: 'u5', name: 'Gone', email: '', active: false },
  ];
  const workers = [
    { id: 'w1', name: 'Anita Rivera', first: 'Anita', last: 'Rivera', email: 'ANA@example.test', ids: [] }, // email beats the different first name
    { id: 'w2', name: 'Benjamin Okafor', first: 'Benjamin', last: 'Okafor', email: '', ids: ['42'] }, // file number 000042 = 42
    { id: 'w3', name: 'Cora M Lindqvist', first: 'Cora M', last: 'Lindqvist', email: '', ids: ['77'] }, // middle initial dropped
    { id: 'w4', name: 'Sam One', first: 'Sam', last: 'One', email: '', ids: [] }, // two Sams in ADP: ambiguous
    { id: 'w5', name: 'Sam Two', first: 'Sam', last: 'Two', email: '', ids: [] },
    { id: 'w6', name: 'Gone Person', first: 'Gone', last: 'Person', email: '', ids: [] }, // only an inactive match
    { id: 'w7', name: 'Ana Rivera', first: 'Ana', last: 'Rivera', email: '', ids: [], userId: null, matchedBy: 'manual' }, // left unmatched on purpose
  ];
  const m = matchWorkers(workers, users);
  assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, `${v.userId}/${v.by}`])), { w1: 'u1/email', w2: 'u2/id', w3: 'u3/name' });
  assert.equal(csvWorkerKey({ employeeId: '000042', name: 'X' }), 'id:42');
  assert.equal(csvWorkerKey({ employeeId: '', name: 'Rivera, Ana' }), 'name:ana rivera');
});

// ---------- which clock counts ----------

const toastE = (id, userId, date, hours, extra = {}) => ({ id, source: 'toast', userId, date, jobCodeId: 'srv', inLocal: `${date}T16:00`, outLocal: `${date}T${String(16 + hours).padStart(2, '0')}:00`, regularHours: hours, overtimeHours: 0, hourlyWage: null, declaredCashTips: 10, nonCashTips: 90, ...extra });
const adpE = (id, userId, date, hours, extra = {}) => ({ id, source: 'adp', origin: 'csv', userId, date, jobCodeId: 'srv', inLocal: `${date}T16:00`, outLocal: `${date}T${String(16 + hours).padStart(2, '0')}:00`, regularHours: hours, overtimeHours: null, hourlyWage: null, declaredCashTips: null, nonCashTips: null, adpWorkerId: `w-${userId}`, adpName: userId, ...extra });

test('clock-in source: ADP, Toast, or both with ADP winning; Toast keeps the tips; automatic picks ADP once there is ADP data', () => {
  const entries = [
    toastE('t-ann', 'ann', '2026-09-14', 6), adpE('a-ann', 'ann', '2026-09-14', 6), // the same shift on both clocks
    toastE('t-bo', 'bo', '2026-09-14', 5), // only Toast has Bo
    toastE('t-ann2', 'ann', '2026-09-15', 4), // a day ADP doesn't have
    toastE('t-x', null, '2026-09-14', 3), // unmatched Toast on an ADP day
  ];
  const ids = (r) => r.entries.map((e) => `${e.id}${e.tipsOnly ? '(tips)' : ''}`).sort();
  assert.deepEqual(ids(pickEntries(entries, 'toast')), ['t-ann', 't-ann2', 't-bo', 't-x']);
  assert.deepEqual(ids(pickEntries(entries, 'adp')), ['a-ann', 't-ann(tips)', 't-ann2(tips)', 't-bo(tips)']);
  assert.deepEqual(ids(pickEntries(entries, 'both')), ['a-ann', 't-ann(tips)', 't-ann2', 't-bo']);
  assert.deepEqual(pickEntries(entries, 'both').ignored, { adp: 0, toast: 2 });
  const tipOnly = pickEntries(entries, 'both').entries.find((e) => e.tipsOnly);
  assert.deepEqual([tipOnly.regularHours, tipOnly.overtimeHours, tipOnly.inLocal, tipOnly.nonCashTips], [0, 0, null, 90]);
  // An unmatched ADP punch could be anyone: Toast fills nothing that day.
  const withUnmatched = [...entries, adpE('a-x', null, '2026-09-14', 4)];
  assert.deepEqual(ids(pickEntries(withUnmatched, 'both')), ['a-ann', 'a-x', 't-ann(tips)', 't-ann2', 't-bo(tips)']);

  assert.equal(resolveClockSource({}, true), 'adp');
  assert.equal(resolveClockSource({}, false), 'toast');
  assert.equal(resolveClockSource({ clockSource: 'both' }, false), 'both');
  assert.equal(resolveClockSource({ clockSource: 'nonsense' }, false), 'toast');
  const store = new MemoryStore();
  for (const e of entries.filter((x) => x.source === 'toast')) store.insert('timeEntries', e);
  assert.equal(clockEntries(store, {}).source, 'toast', 'automatic: Toast while there’s no ADP data');
  store.insert('timeEntries', adpE('a-late', 'bo', '2026-09-20', 5));
  assert.equal(clockEntries(store, {}).source, 'adp', 'automatic: ADP once ADP data exists');
});

test('no double counting: Labor review and the tip pool count one shift once, with the source shown', () => {
  const entries = [toastE('t-ann', 'ann', '2026-09-14', 6), adpE('a-ann', 'ann', '2026-09-14', 6, { regularHours: 6.25 }), toastE('t-bo', 'bo', '2026-09-14', 5)];
  const settings = { overtimeHours: 40, closedDays: [], hours: {} };
  const users = [{ id: 'ann', name: 'Ann', jobCodes: [{ jobCodeId: 'srv', rate: 10 }] }, { id: 'bo', name: 'Bo', jobCodes: [{ jobCodeId: 'srv', rate: 10 }] }];
  const shifts = [{ id: 's1', userId: 'ann', date: '2026-09-14', start: '16:00', end: '22:00', jobCodeId: 'srv', published: true }];
  const review = (source) => laborReview({ weekStart: '2026-09-14', shifts, entries: pickEntries(entries, source).entries, users, jobCodes: [{ id: 'srv', name: 'Server', defaultRate: 10 }], settings });
  const both = review('both');
  assert.equal(both.totals.actual.hours, 11.3, 'Ann 6.25 from ADP + Bo 5 from Toast; never 17.25');
  assert.equal(both.totals.actual.entries, 2);
  assert.equal(both.totals.actual.tips, 200, 'both Toast entries’ tips still count');
  assert.equal(both.days[0].source, 'adp+toast');
  assert.equal(both.people.find((p) => p.userId === 'ann').source, 'adp');
  assert.equal(review('toast').totals.actual.hours, 11);
  assert.equal(review('adp').totals.actual.hours, 6.3);
  assert.equal(review('adp').people.find((p) => p.userId === 'bo').actual.tips, 100, 'Bo’s Toast tips, with no hours');

  const pools = [{ id: 'p', name: 'House', areas: [], jobs: [{ jobCodeId: 'srv', points: 1 }], events: true, excludeRoles: [] }];
  const work = dayWork({ date: '2026-09-14', pools, shifts, timeEntries: pickEntries(entries, 'adp').entries, settings });
  const ann = work.find((r) => r.userId === 'ann');
  assert.deepEqual([ann.minutes, ann.source, ann.card, ann.cash], [375, 'adp', 9000, 1000], 'ADP hours, Toast tips, one row');
  const bo = work.find((r) => r.userId === 'bo');
  assert.deepEqual([bo.minutes, bo.card], [0, 9000], 'Bo: no ADP hours that day, unscheduled: tips only');
});

test('labor review: ADP hours without an overtime split get overtime from the weekly limit', () => {
  const entries = ['14', '15', '16', '17', '18'].map((d) => adpE(`a${d}`, 'ann', `2026-09-${d}`, 9));
  const r = laborReview({ weekStart: '2026-09-14', entries, users: [{ id: 'ann', name: 'Ann', jobCodes: [{ jobCodeId: 'srv', rate: 10 }] }], jobCodes: [{ id: 'srv', name: 'Server' }], settings: { overtimeHours: 40, closedDays: [], hours: {} } });
  assert.equal(r.totals.actual.hours, 45);
  assert.equal(r.totals.actual.ot, 5);
  assert.equal(r.totals.actual.cost, 40 * 10 + 5 * 15);
  assert.equal(r.otEstimated, true);
  assert.deepEqual(r.overtime.map((o) => [o.name, o.actualOt]), [['Ann', 5]]);
});

// ---------- calibration ----------

test('calibration math: the line through the days, dayparts, and "Fridays you schedule 52 and use 47 for ~310 covers; suggested 48"', () => {
  assert.deepEqual(fitHours([]), null);
  const line = fitHours([100, 150, 200, 250, 300, 350].map((x) => ({ x, y: 10 + 0.1 * x })));
  assert.deepEqual([Math.round(line.fixed * 100) / 100, Math.round(line.perUnit * 1000) / 1000, line.fit], [10, 0.1, 'line']);
  const flat = fitHours([100, 150, 200, 250, 300, 350].map((x, i) => ({ x, y: 20 + (i % 2 ? 0.5 : -0.5) - x * 0.001 })));
  assert.equal(flat.fit, 'flat', 'a manager works the same hours whatever the covers');
  assert.equal(fitHours([{ x: 100, y: 15 }, { x: 200, y: 30 }]).fit, 'ratio', 'too few days: hours per cover');

  const windows = daypartWindows('2026-09-18', [{ name: 'Lunch', start: '11:00', end: '16:00' }, { name: 'Dinner', start: '16:00', end: '23:00' }]);
  const base = windows[0].a - 11 * 60;
  const split = splitByDaypart([base + 10 * 60, base + 24 * 60], 13.5, windows);
  // 10am–midnight is 14 clock hours: 6 for lunch (with the hour of prep before it), 8 for dinner (with the hour after close).
  assert.deepEqual([split.Lunch, split.Dinner].map((x) => Math.round(x * 100) / 100), [5.79, 7.71], '10am–midnight: prep goes to lunch, close to dinner');
  assert.deepEqual(splitByDaypart(null, 10, [{ ...windows[0], share: 0.3 }, { ...windows[1], share: 0.7 }]), { Lunch: 3, Dinner: 7 });

  // Six Fridays: 52 server hours scheduled, 47 worked, 310 covers. Other days run at the same rate.
  const settings = { dayparts: [{ name: 'Dinner', start: '16:00', end: '23:30' }], closedDays: [], overtimeHours: 40, weekStartDow: 1, hours: {} };
  const weekStart = '2026-11-02';
  const shifts = [], entries = [], sales = [];
  for (let w = 1; w <= 6; w++) {
    for (const [offset, covers, sched, actual] of [[4, 310, 52, 47], [1, 150, 26, 22.74], [2, 180, 30, 27.29]]) {
      const date = addDays(weekStart, -7 * w + offset);
      sales.push({ date, covers, sales: covers * 60 });
      for (let i = 0; i < 4; i++) {
        shifts.push({ id: `s${date}${i}`, userId: `u${i}`, date, start: '16:00', end: fmt(16 * 60 + (sched / 4) * 60), jobCodeId: 'srv', published: true });
        entries.push({ id: `e${date}${i}`, source: 'adp', userId: `u${i}`, date, jobCodeId: 'srv', inLocal: `${date}T16:00`, outLocal: `${date}T${fmt(16 * 60 + (actual / 4) * 60)}`, regularHours: actual / 4, overtimeHours: 0 });
      }
      // A manager: 10 hours whatever the covers.
      entries.push({ id: `m${date}`, source: 'adp', userId: 'mgr', date, jobCodeId: 'mgr', inLocal: `${date}T14:00`, outLocal: `${date}T23:59`, regularHours: 10, overtimeHours: 0 });
    }
  }
  // An event that week: its shift and the clock-in covering it are left out.
  const eventDay = addDays(weekStart, -3);
  shifts.push({ id: 'evt', userId: 'u9', date: eventDay, start: '17:00', end: '23:00', jobCodeId: 'srv', published: true, eventId: 'e1' });
  entries.push({ id: 'evt-in', source: 'adp', userId: 'u9', date: eventDay, jobCodeId: 'srv', inLocal: `${eventDay}T17:00`, outLocal: `${eventDay}T23:00`, regularHours: 6, overtimeHours: 0 });
  // This Friday: 54 server hours scheduled for ~316 covers.
  const friday = addDays(weekStart, 4);
  for (let i = 0; i < 4; i++) shifts.push({ id: `n${i}`, userId: `u${i}`, date: friday, start: '16:00', end: fmt(16 * 60 + 13.5 * 60), jobCodeId: 'srv', published: false });
  const forecast = [{ date: friday, covers: 316, sales: 18960, totalCovers: 426 }]; // event guests aren't the restaurant's covers
  const c = calibrate({ weekStart, forecast, shifts, entries, sales, settings, weeks: 6, jobCodes: [{ id: 'srv', name: 'Server' }, { id: 'mgr', name: 'Manager' }] });
  assert.equal(c.sampleDays, 18);
  assert.equal(c.clockWeeks, 6);
  const fri = c.days.find((d) => d.date === friday);
  const srv = fri.rows.find((r) => r.jobCodeId === 'srv' && r.daypart === 'all');
  assert.deepEqual(srv.history, { days: 6, sched: 52, actual: 47, covers: 310, sales: 18600 });
  assert.equal(srv.scheduled, 54);
  assert.equal(srv.suggested, 48);
  assert.equal(srv.basis, 'weekday');
  const mgr = fri.rows.find((r) => r.jobCodeId === 'mgr' && r.daypart === 'all');
  assert.deepEqual([mgr.suggested, mgr.fit], [10, 'flat'], 'a fixed position stays fixed');
  assert.equal(fri.rows.find((r) => r.jobCodeId === 'srv' && r.daypart === 'Dinner').suggested, 48);
  assert.deepEqual(c.highlights.map((h) => [h.jobCodeId, h.scheduled, h.suggested]), [['srv', 54, 48]]);
  const fridays = c.byDow.find((d) => d.dow === 5);
  assert.deepEqual([fridays.sched, fridays.actual, fridays.diff], [52, 57, -5], 'servers 52 scheduled; 47 + the manager’s 10 worked');
  assert.equal(c.byPosition.find((p) => p.jobCodeId === 'srv').diff, Math.round(((52 + 26 + 30) - (47 + 22.74 + 27.29)) / 3 * 10) / 10);
  // Every other day of the planned week has no forecast here: no suggestion.
  assert.ok(c.days.filter((d) => d.date !== friday).every((d) => d.rows.every((r) => r.suggested == null)));
});
const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

test('overtime risk: scheduled hours times how much longer each person has worked lately', () => {
  const settings = { overtimeHours: 40, hours: {}, weekStartDow: 1 };
  const weekStart = '2026-11-02';
  const shifts = [], entries = [];
  for (let w = 1; w <= 2; w++) {
    for (let d = 0; d < 4; d++) {
      const date = addDays(weekStart, -7 * w + d);
      shifts.push({ id: `${date}a`, userId: 'ann', date, start: '10:00', end: '19:00', published: true }); // 9 h scheduled
      entries.push({ id: `${date}ae`, userId: 'ann', date, regularHours: 10, overtimeHours: 0 }); // works 10
      shifts.push({ id: `${date}b`, userId: 'bo', date, start: '10:00', end: '18:00', published: true });
      entries.push({ id: `${date}be`, userId: 'bo', date, regularHours: 8, overtimeHours: 0 });
    }
  }
  for (let d = 0; d < 4; d++) {
    shifts.push({ id: `n${d}a`, userId: 'ann', date: addDays(weekStart, d), start: '10:00', end: '19:00' }); // 36 h
    shifts.push({ id: `n${d}b`, userId: 'bo', date: addDays(weekStart, d), start: '10:00', end: '18:00' }); // 32 h
  }
  const risk = overtimeRisk({ weekStart, shifts, entries, users: [{ id: 'ann', name: 'Ann' }, { id: 'bo', name: 'Bo' }], settings, otAfter: 40, from: addDays(weekStart, -14), to: addDays(weekStart, -1) });
  assert.deepEqual(risk, [{ userId: 'ann', name: 'Ann', scheduled: 36, ratio: 1.11, projected: 40, level: 'close', otWeeks: 0 }]);
});

test('demo: ADP clock-ins for two days, "both (ADP wins)", nothing counted twice, and the calibration card has data', () => {
  const store = new MemoryStore();
  const ids = seedDemo(store);
  const svc = createService(store, { now: () => new Date('2026-09-27T12:00:00') });
  const moe = store.get('users', ids.userId.Moe);
  const adp = store.list('timeEntries', (t) => t.source === 'adp');
  assert.ok(adp.length >= 8 && adp.every((e) => e.userId && e.date < '2026-09-27' && e.nonCashTips === null));
  const users = new Set(store.list('users').map((u) => u.id));
  assert.ok(adp.every((e) => users.has(e.userId)), 'demo people only');
  const r = svc.call(moe, 'labor.week', { weekStart: '2026-09-21' });
  assert.equal(r.clock.source, 'both');
  assert.equal(r.clock.ignored.toast, adp.length, 'each ADP punch replaces that person’s Toast punch');
  for (const d of ['2026-09-25', '2026-09-26']) assert.equal(r.days.find((x) => x.date === d).source, 'adp+toast');
  const picked = clockEntries(store, store.get('settings', 'settings'), (t) => t.date >= '2026-09-21' && t.date <= '2026-09-27').entries.filter((e) => !e.tipsOnly);
  const keys = picked.map((e) => `${e.userId}|${e.date}|${e.source}`);
  for (const e of adp) assert.ok(!keys.includes(`${e.userId}|${e.date}|toast`), `${e.userId} ${e.date} counted once`);
  const c = svc.call(moe, 'calibration.week', { weekStart: '2026-09-28' });
  assert.ok(c.sampleDays > 5 && c.days.some((d) => d.rows.some((x) => x.suggested != null)));
  const info = svc.call(moe, 'adp.get');
  assert.equal(info.lastImport.fileName, 'timecard-report-demo.csv');
  assert.ok(info.workers.every((w) => w.userId));
  assert.throws(() => svc.call(moe, 'clock.setSource', { source: 'nope' }), /Pick ADP, Toast, both, or automatic/);
  assert.equal(svc.call(moe, 'clock.setSource', { source: 'toast' }).source, 'toast');
  assert.throws(() => svc.call(store.get('users', ids.userId.Styves), 'clock.setSource', { source: 'adp' }), /Admins only/);
});

// ---------- HTTP: the cron secret and permissions ----------

test('HTTP: ADP status and Sync now are for managers; the cron needs CRON_SECRET; without env vars nothing syncs', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true', CRON_SECRET: 'cron-test-value' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const req = (p, { cookie, method = 'GET', body, auth } = {}) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(auth ? { Authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    assert.equal((await req('/api/cron/adp')).status, 401);
    assert.equal((await req('/api/cron/adp', { auth: 'Bearer wrong' })).status, 401);
    assert.equal((await req('/api/cron/adp', { auth: 'cron-test-value' })).status, 401, 'the Bearer prefix is required');
    const cron = await req('/api/cron/adp', { auth: 'Bearer cron-test-value' });
    assert.equal(cron.status, 200);
    assert.match(cron.body.result.skipped, /not set up/);

    const moe = await login('moe@demo.shiftboard');
    const styves = await login('styves@demo.shiftboard');
    assert.equal((await req('/api/adp/status')).status, 401);
    assert.equal((await req('/api/adp/status', { cookie: styves })).status, 403);
    const st = await req('/api/adp/status', { cookie: moe });
    assert.equal(st.status, 200);
    assert.deepEqual(st.body.result.missing, ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM']);
    assert.equal(st.body.result.cron, true);
    const sync = await req('/api/adp/sync', { cookie: moe, method: 'POST', body: {} });
    assert.equal(sync.status, 400);
    assert.match(sync.body.error, /ADP_CLIENT_ID, ADP_CLIENT_SECRET, ADP_CERT_PEM, ADP_KEY_PEM/);
    // The import works over RPC (no ADP access needed), and errors come back in Spanish when asked.
    const es = await fetch(`${base}/api/rpc/adp.importCsv`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: moe, 'X-ShiftBoard-Language': 'es' }, body: JSON.stringify({ punches: [] }) });
    assert.equal(es.status, 400);
    assert.equal((await es.json()).error, 'Ese archivo no tiene checadas para importar');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});

test('HTTP: with credentials, Sync now and the cron run the sync through the mTLS client', async () => {
  _tokenCache.clear();
  const conn = await openPglite();
  const db = new DocDb(conn);
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const start = addDays(yesterday, -3);
  const fake = fakeAdp({
    workers: [worker('M1', 'Moe', 'Henson', { email: 'moe@demo.shiftboard', file: '77' })],
    cards: { M1: [card('M1', start, addDays(start, 13), { [yesterday]: [['m-1', `${yesterday}T09:00:00`, `${yesterday}T17:00:00`, [['REG', 7.5]]]] })] },
    period: { startDate: start, endDate: addDays(start, 13) },
  });
  const env = { SEED_DEMO: 'true', ...ENV, CRON_SECRET: 'cron-test-value' };
  const { mountAdp } = await import('../server/adp-routes.js');
  await createApp({ db, env }).locals.ready(); // the schema and the demo restaurant
  // The same routes, with a client whose transport is the fake ADP (same code path, no network).
  const express = (await import('express')).default;
  const outer = express();
  outer.use(express.json());
  mountAdp(outer, { db, env, userOf: () => db.store.list('users', (u) => u.email === 'moe@demo.shiftboard')[0], makeClient: () => createAdpClient({ env, transport: fake.transport, agent: {}, sleep: noSleep }) });
  const server = outer.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sync = await fetch(`${base}/api/adp/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: yesterday, to: yesterday }) }).then((r) => r.json());
    assert.equal(sync.result.ok, true, sync.error);
    assert.equal(sync.result.done[0].found, 1);
    assert.equal(sync.result.lists.matched, 1, 'Moe matched by email');
    const cron = await fetch(`${base}/api/cron/adp`, { headers: { Authorization: 'Bearer cron-test-value' } }).then((r) => r.json());
    assert.equal(cron.result.ok, true);
    assert.equal(db.store.get('integrations', 'adp').lastCron.by, 'cron');
    assert.equal(db.store.list('timeEntries', (t) => t.source === 'adp').length, 1 + 12, 'one synced, plus the demo’s; nothing doubled by the cron');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
    _tokenCache.clear();
  }
});
