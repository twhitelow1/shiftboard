// The printable schedule PDF (core/schedule-pdf.js): a valid file laid out like the house sheet, with the week's
// dates, the M.O.D. block, the rooms, OFF and REQ OFF, DRAFT on draft weeks, Spanish, paper options, and pages
// that never part a section's header from its rows. Plus the download route (server/schedule-pdf-routes.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MemoryStore } from '../core/store.js';
import { createService, DEFAULT_SETTINGS } from '../core/service.js';
import { loadSheetModel, schedulePdf, sheetModel, MIN_FONT, PAPER, pdfFileName } from '../core/schedule-pdf.js';
import { cleanPdfOptions } from '../core/pdf-options.js';
import { addDays } from '../core/time.js';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';

const WEEK = '2026-11-30'; // a Monday

/** A small restaurant with made-up people: two rooms, a hidden position, managers, OFF, REQ OFF and a tag. */
function fixture({ servers = 4 } = {}) {
  const store = new MemoryStore();
  store.insert('settings', { ...DEFAULT_SETTINGS, restaurantName: 'Test Bistro', startTimesOnly: true, areaColors: { 'Dining Room': '#1f4e9c', 'Garden Bar': '#2e7d32' } });
  const job = (id, name, department, defaultRole = 'employee') => store.insert('jobCodes', { id, name, short: name.slice(0, 3).toUpperCase(), department, defaultRole, order: 0, archived: false });
  job('job_mgr', 'Manager', 'Leadership', 'manager');
  job('job_srv', 'Server', 'Restaurant');
  job('job_bar', 'Bartender', 'Bar');
  job('job_hid', 'Polisher', 'Restaurant');
  const user = (id, name, role, jobs, extra = {}) => store.insert('users', { id, name, role, active: true, email: `${id}@test.local`, availability: {},
    jobCodes: jobs.map(([jobCodeId, areas]) => ({ jobCodeId, ...(areas ? { areas } : {}) })), ...extra });
  user('admin', 'Owner Person', 'admin', [], { onSchedule: false });
  user('mgr1', 'Quinn Harbor', 'manager', [['job_mgr', ['Dining Room']]]);
  user('mgr2', 'Rory Vale', 'manager', [['job_mgr', ['Dining Room']]]);
  for (let i = 1; i <= servers; i++) user(`srv${i}`, `Server Number${i}`, 'employee', [['job_srv', ['Dining Room']]]);
  user('bar1', 'Bea Tumbler', 'employee', [['job_bar', ['Garden Bar']]]);
  user('pol1', 'Hidden Polisher', 'employee', [['job_hid', ['Dining Room']]]);
  const shift = (userId, jobCodeId, area, date, start, extra = {}) => store.insert('shifts', { id: `shf_${userId}_${date}_${start}`, date, start, end: '23:00', jobCodeId, userId, area, tag: '', notes: '', published: true, ...extra });
  shift('mgr1', 'job_mgr', 'Dining Room', WEEK, '15:30');
  shift('mgr2', 'job_mgr', 'Dining Room', addDays(WEEK, 1), '12:00');
  shift('srv1', 'job_srv', 'Dining Room', WEEK, '16:00', { tag: 'TRAIN' });
  shift('srv2', 'job_srv', 'Dining Room', addDays(WEEK, 2), '17:30');
  shift('bar1', 'job_bar', 'Garden Bar', addDays(WEEK, 4), '18:00');
  shift('pol1', 'job_hid', 'Dining Room', addDays(WEEK, 4), '10:00');
  store.insert('timeOff', { id: 'tof1', userId: 'srv3', startDate: addDays(WEEK, 3), endDate: addDays(WEEK, 3), status: 'approved', reason: 'family' });
  store.insert('notes', { id: `day:${addDays(WEEK, 3)}`, kind: 'day', date: addDays(WEEK, 3), text: 'Holiday dinner service 3PM-8PM' });
  store.insert('notes', { id: `week:${WEEK}`, kind: 'week', date: WEEK, text: 'Staff meeting Monday at 3' });
  const svc = createService(store, { now: () => new Date('2026-11-26T12:00:00') });
  // The Polisher position is hidden in Rooms & positions: it never prints.
  const as = (id) => (m, a) => svc.call(store.get('users', id), m, a);
  const layout = as('admin')('layout.get');
  const rooms = layout.rooms.map((r) => ({ ...r, positions: r.positions.map((p) => (p.jobCodeId === 'job_hid' ? { ...p, hidden: true } : p)) }));
  as('admin')('layout.save', { rooms, rev: layout.rev });
  return { store, svc, as };
}

async function textOf(bytes) {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map((x) => x.str).join(' '));
  }
  return { pages, all: pages.join('\n'), count: doc.numPages };
}

const modelFor = (f, who = 'admin', opts = {}) => loadSheetModel((m, a) => f.as(who)(m, a), { weekStart: WEEK, lang: 'en', isMgr: who === 'admin', ...opts });

test('the PDF: a valid file with the dates, M.O.D., rooms, red tags, OFF, REQ OFF, events and notes; hidden positions left out', async () => {
  const f = fixture();
  const model = await modelFor(f);
  const { bytes, pages } = await schedulePdf(model, { paper: 'letter', orientation: 'portrait', fit: 'fit' });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.ok(bytes.length < 120_000, `small enough to email (${bytes.length} bytes)`);
  assert.equal(pages.length, 1);
  const { all, count } = await textOf(bytes);
  assert.equal(count, 1);
  for (const s of ['Test Bistro', '11/30/2026', '12/6/2026', 'MONDAY', 'SUNDAY', 'M.O.D.', 'QUINN HARBOR', 'DINING ROOM', 'GARDEN BAR', 'Servers', 'Bartenders',
    'SERVER NUMBER1', '4PM', 'TRAIN', 'OFF', 'REQ OFF', 'HOLIDAY DINNER SERVICE', 'Notes:', 'Staff meeting Monday at 3', 'Projected Covers']) {
    assert.ok(all.includes(s), `has ${s}`);
  }
  assert.ok(!all.includes('HIDDEN POLISHER') && !all.includes('Polishers'), 'a hidden position never prints');
  assert.ok(!all.includes('DRAFT'), 'a posted week');
  // Managers print in the M.O.D. block, not again as a Managers section.
  assert.ok(!all.includes('Managers'));
  // Start times only (the restaurant's setting); with it off, start–end.
  f.store.update('settings', 'settings', { startTimesOnly: false });
  assert.ok((await textOf((await schedulePdf(await modelFor(f))).bytes)).all.includes('4-11PM'));
  assert.equal(pdfFileName(model), 'schedule-2026-11-30.pdf');
});

test('a draft week is watermarked DRAFT; staff get the published week only, never drafts', async () => {
  const f = fixture();
  f.store.insert('shifts', { id: 'shf_draft', date: addDays(WEEK, 5), start: '11:00', end: '19:00', jobCodeId: 'job_srv', userId: 'srv4', area: 'Dining Room', tag: 'BRUNCH', published: false });
  const mgr = await modelFor(f);
  assert.equal(mgr.draft, true);
  const { all } = await textOf((await schedulePdf(mgr)).bytes);
  assert.ok(all.includes('DRAFT') && all.includes('BRUNCH'));
  const staff = await modelFor(f, 'srv1');
  assert.equal(staff.draft, false);
  const s = await textOf((await schedulePdf(staff)).bytes);
  assert.ok(!s.all.includes('DRAFT') && !s.all.includes('BRUNCH'), 'no draft shift, no watermark');
  assert.equal(pdfFileName(mgr), 'schedule-2026-11-30-draft.pdf');
});

test('Spanish: weekday names and LIBRE / PIDIÓ LIBRE; one room or a few', async () => {
  const f = fixture();
  const es = await modelFor(f, 'admin', { lang: 'es' });
  const { all } = await textOf((await schedulePdf(es)).bytes);
  for (const s of ['LUNES', 'MIÉRCOLES', 'SÁBADO', 'LIBRE', 'PIDIÓ LIBRE', 'Notas:', 'Cubiertos proyectados']) assert.ok(all.includes(s), s);
  assert.ok(!all.includes('MONDAY'));
  const one = await modelFor(f, 'admin', { rooms: ['garden bar'] });
  assert.deepEqual(one.groups.map((g) => g.title), ['Garden Bar']);
  const t = await textOf((await schedulePdf(one)).bytes);
  assert.ok(t.all.includes('BEA TUMBLER') && !t.all.includes('SERVER NUMBER1'));
  assert.equal(pdfFileName(one), 'schedule-2026-11-30-garden-bar.pdf');
});

test('paper and pages: Letter, Legal, Tabloid, landscape; split pages repeat the weekdays and keep each section header with its rows', async () => {
  assert.deepEqual(cleanPdfOptions({ paper: 'a4', orientation: 'sideways', fit: 'x', rooms: 'A, B' }), { paper: 'letter', orientation: 'portrait', fit: 'fit', rooms: ['A', 'B'], lang: null });
  const f = fixture({ servers: 140 });
  const model = await modelFor(f);
  for (const [paper, orientation] of [['letter', 'portrait'], ['legal', 'portrait'], ['tabloid', 'landscape']]) {
    const { bytes } = await schedulePdf(model, { paper, orientation, fit: 'split' });
    const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
    const { view } = await doc.getPage(1);
    const [w, h] = orientation === 'landscape' ? [...PAPER[paper]].reverse() : PAPER[paper];
    assert.deepEqual([view[2], view[3]], [w, h], `${paper} ${orientation}`);
  }
  const split = await schedulePdf(model, { paper: 'letter', fit: 'split' });
  assert.ok(split.pages.length >= 3, `${split.pages.length} pages`);
  split.pages.forEach((rows, i) => {
    if (i > 0) assert.equal(rows[0].type, 'dates', `page ${i + 1} starts with the weekday header`);
    const last = rows[rows.length - 1];
    assert.ok(!['head', 'banner'].includes(last.type), `page ${i + 1} doesn't end on a header`);
    // Every person on a page sits under a section header on that same page.
    const firstPerson = rows.findIndex((r) => r.type === 'person');
    const firstHead = rows.findIndex((r) => r.type === 'head');
    if (i > 0 && firstPerson >= 0) assert.ok(firstHead >= 0 && firstHead < firstPerson, `page ${i + 1}: header before its rows`);
  });
  const cont = split.pages.slice(1).flat().filter((r) => r.cont);
  assert.ok(cont.some((r) => r.type === 'head' && r.label === 'Servers'), 'the long section carries on under its header');
  assert.ok(cont.some((r) => r.type === 'banner'), 'and its room banner');
  const { count } = await textOf(split.bytes);
  assert.equal(count, split.pages.length);
  // Fit to one page never shrinks the text below MIN_FONT: it splits instead.
  const fit = await schedulePdf(model, { paper: 'letter', fit: 'fit' });
  assert.ok(fit.pages.length > 1 && fit.fontSize >= MIN_FONT);
  const small = await schedulePdf(await modelFor(fixture()), { paper: 'tabloid', fit: 'fit' });
  assert.equal(small.pages.length, 1);
  assert.ok(small.fontSize >= MIN_FONT);
});

test('names the standard fonts can’t print come out readable, never crash', async () => {
  const f = fixture();
  f.store.update('users', 'srv1', { name: 'Zoë Łukasz 王' });
  const model = sheetModel({ boot: f.as('admin')('app.bootstrap'), week: f.as('admin')('shifts.list', { start: WEEK, end: addDays(WEEK, 6) }), weekStart: WEEK });
  const { all } = await textOf((await schedulePdf(model)).bytes);
  assert.ok(all.includes('ZOË LUKASZ ?'), all.slice(0, 400));
});

test('GET /api/schedule/pdf: signed in only; managers get the week as it stands, staff the published one', async () => {
  const A = await startApp({ email: false, sms: false });
  try {
    const admin = A.db.store.list('users').find((u) => u.role === 'admin' || u.role === 'superadmin');
    const c = jsonClient(A.base);
    assert.equal((await fetch(`${A.base}/api/schedule/pdf?week=2026-09-28`)).status, 401);
    assert.equal((await signIn(c.post, admin.email)).status, 200);
    const get = (q) => fetch(`${A.base}/api/schedule/pdf?${q}`, { headers: { Cookie: c.cookie() } });
    assert.equal((await get('week=nope')).status, 400);
    const res = await get('week=2026-09-28&paper=tabloid&fit=fit&lang=es');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="schedule-2026-09-28(-draft)?\.pdf"/);
    const { all, count } = await textOf(Buffer.from(await res.arrayBuffer()));
    assert.equal(count, 1);
    assert.ok(all.includes('LUNES') && all.includes('9/28/2026'));
  } finally { await A.close(); }
});
