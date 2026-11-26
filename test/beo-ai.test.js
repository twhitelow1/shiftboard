// "Read it with AI" for a BEO that isn't Tripleseat's layout (server/beo-ai-routes.js): the AI's JSON is cleaned like
// any import (money stripped, known fields only), comes back for the preview, goes through the same duplicate checks,
// and a friendly reason comes back when AI can't run. A fake Anthropic client answers (no network, no real key).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { cookieFor } from './helpers/signin.js';
import { fakeAnthropic, text } from './helpers/fake-anthropic.js';
import { eventsFromReply, jsonFrom } from '../server/beo-ai-routes.js';
import { beoText } from '../core/beo-import.js';
import { beoItems } from './fixtures/beo-pdf.js';

const KEY = 'sk-ant-test-platform-placeholder-0002'; // not a real key: the fake client never sends it anywhere
const fake = fakeAnthropic();
let A, B;
const cookies = {};

const reply = (date) => JSON.stringify({ events: [{
  name: 'Harbor Lights Retirement Party', date, start: '18:00', end: '21:00', guestCount: 45, guaranteed: 42, type: 'Retirement', serviceStyle: 'buffet',
  areas: 'Moon Rabbit', client: 'Harbor Lights Co', contactPhone: '555-010-9900',
  menu: [{ course: 'Buffet', item: 'Carving station $28 pp', notes: 'horseradish cream', dietary: ['GF'] }],
  timeline: [{ time: '18:00', item: 'Doors' }, { time: '19:00', item: 'Speeches' }],
  dietaryNotes: '3 gluten free\nPay deposit of $500 by Friday',
  setupNotes: 'Cocktail rounds\nRoom fee $250',
  specialInstructions: 'Gift table by the door',
  sections: [
    { key: 'vendors', title: 'VENDORS', kind: 'list', items: ['Balloons: Pop Example, arrives 4 pm, 555-010-1234', 'Rental invoice total $1,200'] },
    { key: 'other', title: 'PAYMENT', kind: 'text', items: ['Balance due on arrival'] },
    { key: 'timeline', title: 'Run of show', kind: 'timeline', items: [{ time: '18:00', text: 'Doors' }] },
    { key: 'staffing', title: 'STAFF', kind: 'list', items: ['2 bartenders requested'] },
  ],
  deposit: 500, totals: { grand: 3400 },
}] });

before(async () => {
  A = await startApp({ env: { ANTHROPIC_API_KEY: KEY }, aiClient: fake.factory });
  B = await startApp({}); // no key: AI reading isn't set up
  const pick = (app, role) => app.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[0];
  cookies.manager = await cookieFor(A.base, pick(A, 'manager').email);
  cookies.employee = await cookieFor(A.base, pick(A, 'employee').email);
  cookies.managerB = await cookieFor(B.base, pick(B, 'manager').email);
});
after(async () => { await A.close(); await B.close(); });

const post = async (base, cookie, path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rpc = (base, cookie, method, args) => post(base, cookie, `/api/rpc/${method}`, args);

test('the AI’s BEO is cleaned like any import: money out, known fields only, timeline/menu in their fields', async () => {
  const wedding = A.db.store.list('events', (e) => /Radunzel/.test(e.name))[0];
  fake.reply(text(reply(wedding.date)));
  const r = await post(A.base, cookies.manager, '/api/events/read-beo', { text: beoText(beoItems()) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [e] = r.body.events;
  assert.deepEqual([e.name, e.start, e.guestCount, e.guaranteed, e.serviceStyle, e.via], ['Harbor Lights Retirement Party', '18:00', 45, 42, 'buffet', 'ai']);
  assert.equal(e.menu[0].item, 'Carving station');
  assert.equal(e.dietaryNotes, '3 gluten free');
  assert.equal(e.setupNotes, 'Cocktail rounds');
  assert.deepEqual(e.sections.map((s) => [s.key, s.items]), [['vendors', ['Balloons: Pop Example, arrives 4 pm, 555-010-1234']], ['staffing', ['2 bartenders requested']]], 'the PAYMENT section and the money lines are gone; a timeline section folds into the field');
  const all = JSON.stringify(r.body);
  for (const w of ['$', 'deposit', 'Deposit', 'totals', 'Balance due']) assert.ok(!all.includes(w), w);
  // What was sent: the PDF's text with the price column left out, and the rules (no money, as written).
  const sent = fake.calls.at(-1).params;
  assert.match(sent.system[0].text, /NO MONEY/);
  assert.ok(!sent.messages[0].content.includes('$2,568.00'), 'price-only cells never leave the browser');
  assert.ok(sent.messages[0].content.includes('Rivera Rehearsal Dinner'));
  // Then the same preview and duplicate checks as a PDF: nothing saved yet.
  const before = A.db.store.list('events').length;
  const dry = await rpc(A.base, cookies.manager, 'events.importBeos', { events: [{ ...e, name: 'Radunzel & Jones Wedding', start: wedding.start, room: wedding.room }], dryRun: true });
  assert.equal(dry.body.result.events[0].status, 'duplicate', 'the AI path goes through the same duplicate checks');
  assert.equal(A.db.store.list('events').length, before);
});

test('when AI can’t run, a reason the app turns into a friendly sentence; staff can’t use it', async () => {
  const off = await post(B.base, cookies.managerB, '/api/events/read-beo', { text: 'BEO text' });
  assert.deepEqual([off.status, off.body], [503, { error: 'ai_unavailable', reason: 'no_key' }]);
  const staff = await post(A.base, cookies.employee, '/api/events/read-beo', { text: 'BEO text' });
  assert.equal(staff.status, 403);
  const empty = await post(A.base, cookies.manager, '/api/events/read-beo', { text: '  ' });
  assert.equal(empty.status, 400);
  fake.reply(text('Sorry, I can’t read that.'));
  const junk = await post(A.base, cookies.manager, '/api/events/read-beo', { text: 'BEO text' });
  assert.deepEqual([junk.status, junk.body.error], [502, 'ai_unreadable']);
});

test('the reply’s JSON, even in a code fence or after a sentence', () => {
  assert.deepEqual(jsonFrom('```json\n{"events":[]}\n```'), { events: [] });
  assert.deepEqual(jsonFrom('Here it is: {"events":[{"name":"A"}]} done'), { events: [{ name: 'A' }] });
  assert.equal(jsonFrom('nope'), null);
  assert.equal(eventsFromReply('{"events":[{"name":"Brunch","date":"2027-01-02","fee":"$50"}]}')[0].fee, undefined);
});
