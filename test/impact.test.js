// Positive impact: matching staff names in reviews (nicknames, also-known-as and legal names, two people with a
// name, who worked that day, everyday words like "Will" and "Rose"), guests asking for someone in reservations,
// season reports with last year's comparison, managers' decisions, notifications, and who sees what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { impactLinks, buildRoster, findMentions, findRequests, findRequestedServer, resolveHit, namesOf, periodRange, yearBefore } from '../core/impact.js';
import { DocDb } from '../server/db.js';
import { openPglite } from '../server/pglite.js';
import { createApp } from '../server/app.js';
import { jsonClient, signIn } from './helpers/signin.js';

const TEAM = [
  { id: 'alexd', name: 'Alex D' }, { id: 'alexm', name: 'Alexandra M' }, { id: 'will', name: 'Will' }, { id: 'rose', name: 'Rose' },
  { id: 'ever', name: 'Ever' }, { id: 'mike', name: 'Michael' }, { id: 'manny', name: 'Manny' }, { id: 'maryann', name: 'Mary Ann' },
  { id: 'lucas', name: 'Chef Lucas' }, { id: 'flor', name: 'Flor' }, { id: 'moe', name: 'Moe', legalFirstName: 'Louis', legalLastName: 'Moreau' },
  { id: 'events', name: 'Events Team', role: 'events' },
];
const roster = buildRoster(TEAM);
const who = (text, ctx = { worked: () => null }) => findMentions(text, roster, ctx).map((h) => `${h.token}:${h.candidates.join('|')}`);

test('names: first names, nicknames, full names, titles, legal names, also-known-as', () => {
  assert.deepEqual(who('Mike made it special. Manuel too.'), ['Mike:mike', 'Manuel:manny']);
  assert.deepEqual(who('Mary Ann at the host stand was lovely'), ['Mary Ann:maryann']);
  assert.deepEqual(who('Chef Lucas came out to say hi'), ['Lucas:lucas']);
  assert.deepEqual(who('Louis Moreau checked on every table'), ['Louis Moreau:moe'], 'the legal name');
  assert.deepEqual(who('the events team was great'), [], 'a shared account is not a person');
  const withAka = buildRoster([...TEAM, { id: 'jo', name: 'Josephine', aka: ['Big Jo'] }]);
  assert.deepEqual(findMentions('Big Jo is the best bartender', withAka).map((h) => h.candidates[0]), ['jo']);
  const n = namesOf({ name: 'Moe', legalFirstName: 'Louis', legalLastName: 'Moreau', aka: ['Mo'] });
  assert.deepEqual(n.names.map((x) => `${x.text}/${x.kind}`), ['moe/first', 'mo/aka', 'louis/legal', 'louis moreau/legal']);
});

test('everyday words are names only with a cue: Will the verb, Rose the wine, Ever the adverb', () => {
  assert.deepEqual(who('Will definitely be back! Will recommend.'), []);
  assert.deepEqual(who('Our server Will was fantastic.'), ['Will:will']);
  assert.deepEqual(who('We will come back, Will was great'), ['Will:will']);
  assert.deepEqual(who('will was great'), [], 'lower case is the word');
  assert.deepEqual(who('The Rose was crisp and paired well with the salmon.'), []);
  assert.deepEqual(who('Rose was crisp and dry.'), []);
  assert.deepEqual(who('A glass of rosé, and Rose took great care of us.'), ['Rose:rose']);
  assert.deepEqual(who('Best meal ever! Best night Ever!'), []);
  assert.deepEqual(who('Ever was our server and she was great. Thanks Ever!'), ['Ever:ever']);
  assert.deepEqual(who('la flor de calabaza estaba rica'), []);
  assert.deepEqual(who('Flor nos atendió muy bien'), ['Flor:flor']);
  // Capitalized mid-sentence with no cue: only if they worked that day, and then a manager confirms it.
  assert.deepEqual(who('We loved Ever and the food'), []);
  const hits = findMentions('We loved Ever and the food', roster, { worked: (id) => id === 'ever' });
  assert.equal(resolveHit(hits[0], { worked: () => true }).status, 'needsReview');
});

test('two people with a name: the last initial, the review’s server, then who worked that day; otherwise needs review', () => {
  const [alex] = findMentions('Alex was wonderful', roster);
  assert.deepEqual(alex.candidates.sort(), ['alexd', 'alexm']);
  assert.deepEqual(resolveHit(alex, {}), { userId: null, status: 'needsReview', reason: 'ambiguous', candidates: ['alexd', 'alexm'] }, 'never a guess');
  assert.equal(resolveHit(alex, { worked: (id) => id === 'alexm' }).userId, 'alexm');
  assert.equal(resolveHit(alex, { worked: (id) => id === 'alexm' }).reason, 'workedThatDay');
  assert.equal(resolveHit(alex, { worked: () => true }).status, 'needsReview', 'both worked: still a manager’s call');
  assert.equal(resolveHit(alex, { serverId: 'alexd' }).userId, 'alexd');
  assert.deepEqual(who('Alex D. was great'), ['Alex D:alexd'], 'the whole name is marked');
  // One person with the name, but not on shift that day (when the day has shifts): waits for a look.
  const [rose] = findMentions('Rose took care of us', roster);
  assert.equal(resolveHit(rose, { worked: () => false, dayHasData: true }).reason, 'notOnShift');
  assert.equal(resolveHit(rose, { worked: () => null, dayHasData: false }).status, 'confirmed');
});

test('reservation requests: request, ask for, someone’s section, requested-server field, Spanish; not birthdays', () => {
  const req = (t) => findRequests(t, roster).map((h) => h.candidates.join('|'));
  assert.deepEqual(req('Request Mike please'), ['mike']);
  assert.deepEqual(req('sit us in Manny’s section'), ['manny']);
  assert.deepEqual(req('REQ: ALEX D'), ['alexd']);
  assert.deepEqual(req('Would like Will as our server'), ['will']);
  assert.deepEqual(req('server: Rose'), ['rose']);
  assert.deepEqual(req('piden a Flor de mesera'), ['flor']);
  assert.deepEqual(req('en la sección de Manny'), ['manny']);
  assert.deepEqual(req('ask for a high chair'), []);
  assert.deepEqual(req('Birthday for Mike'), []);
  assert.deepEqual(req('Celebrating Rose’s birthday'), []);
  assert.deepEqual(req('request window table'), []);
  assert.deepEqual(findRequestedServer('Alex D.', roster).map((h) => h.candidates), [['alexd']]);
});

test('periods: seasons, months, dates, and the same dates last year', () => {
  const settings = {};
  const s = periodRange({}, { settings, today: '2026-09-27' });
  assert.deepEqual([s.seasonId, s.from, s.to, s.label, s.prev.from], ['summer-2026', '2026-05-01', '2026-10-31', 'Summer 2026', '2025-05-01']);
  const w = periodRange({ period: 'season', seasonId: 'winter-2025' }, { settings, today: '2026-09-27', lang: 'es' });
  assert.deepEqual([w.from, w.to, w.label], ['2025-11-01', '2026-04-30', 'Invierno 2025–26']);
  assert.deepEqual(periodRange({ period: 'month', month: '2024-02' }, { settings, today: '2026-09-27' }).prev, { from: '2023-02-01', to: '2023-02-28' });
  assert.equal(yearBefore('2024-02-29'), '2023-02-28');
  assert.throws(() => periodRange({ period: 'range', from: '2026-05-01', to: '2026-04-01' }, { settings, today: '2026-09-27', fail: (s, m) => { throw new Error(m); } }), /start and an end/);
});

function setup() {
  const store = new MemoryStore();
  const add = (id, name, role = 'employee') => store.insert('users', { id, name, role, email: `${id}@t.test`, jobCodes: [], active: true });
  add('kelly', 'Kelly', 'manager'); add('alexd', 'Alex D'); add('alexm', 'Alexandra M'); add('flor', 'Flor'); add('manny', 'Manny'); add('will', 'Will');
  store.insert('settings', { id: 'settings', restaurantName: 'Test Bistro' });
  const now = new Date('2026-09-27T12:00:00');
  const svc = createService(store, { now: () => now });
  return { store, svc, as: (id) => store.get('users', id) };
}
const review = (date, rating, text, source = 'opentable') => ({ key: `i_${date}${rating}${text.length}`, date, diningDate: date, rating, text, source, reviewer: 'Guest Person' });

test('season report: per person, by stars, requests and kudos, against the same season last year; staff see only their own', () => {
  const { store, svc, as } = setup();
  svc.impact.applyReviews([
    review('2025-07-10', 5, 'Flor was amazing'),
    review('2026-06-01', 5, 'Flor was amazing again, and Manny too'),
    review('2026-06-15', 4, 'Manny was great'),
    review('2026-07-01', 5, 'Our server Alex D. remembered us'),
    review('2026-07-02', 2, 'Manny was slow'),
    review('2026-01-10', 5, 'Flor took care of us in winter'),
  ], {});
  svc.opentable.applyReservations([
    { key: 'c_1', date: '2026-08-01', time: '19:00', partySize: 2, status: 'done', notes: 'Request Flor please' },
    { key: 'c_2', date: '2026-08-02', time: '19:00', partySize: 2, status: 'cancelled', notes: 'Request Flor please' },
    { key: 'c_3', date: '2026-08-03', time: '19:00', partySize: 4, status: 'done', notes: 'ask for Alex' },
  ], {});
  svc.call(as('kelly'), 'impact.saveKudos', { userId: 'manny', source: 'inPerson', stars: null, date: '2026-09-01', text: 'A regular said thanks' });
  const r = svc.call(as('kelly'), 'impact.summary', {});
  assert.equal(r.range.seasonId, 'summer-2026');
  const row = (id) => r.rows.find((x) => x.userId === id);
  assert.deepEqual([row('flor').fiveStar, row('flor').mentions, row('flor').requests, row('flor').prev.fiveStar], [1, 1, 1, 1], 'a cancelled booking’s request doesn’t count');
  assert.deepEqual(row('manny').byRating, { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 });
  assert.equal(row('manny').kudos, 1);
  assert.equal(row('alexd').fiveStar, 1);
  assert.equal(r.pending, 1, '"ask for Alex" has two Alexes: waits for a manager');
  assert.equal(r.rows[0].userId, 'manny', 'ranked by 5-star mentions + requests + kudos');
  assert.ok(r.seasons.some((s) => s.id === 'winter-2025') && r.seasons.some((s) => s.id === 'summer-2025'));
  const winter = svc.call(as('kelly'), 'impact.summary', { period: 'season', seasonId: 'winter-2025' });
  assert.deepEqual(winter.rows.map((x) => x.userId), ['flor']);
  // Managers settle the Alex request; it then counts, and the decision survives a rescan.
  const q = svc.call(as('kelly'), 'impact.list', { what: 'queue' });
  assert.deepEqual(q.items[0].candidates.map((c) => c.id).sort(), ['alexd', 'alexm']);
  svc.call(as('kelly'), 'impact.decide', { id: q.items[0].id, action: 'confirm', userId: 'alexm' });
  svc.call(as('kelly'), 'impact.rescan');
  assert.equal(svc.call(as('kelly'), 'impact.summary', {}).rows.find((x) => x.userId === 'alexm').requests, 1);
  // Staff: their own only, without the guest's name or the rest of a booking's notes.
  const mine = svc.call(as('flor'), 'impact.get', {});
  assert.equal(mine.counts.fiveStar, 1);
  assert.ok(mine.items.every((i) => !('reviewer' in i) && !('guest' in i) && !('mentions' in i)));
  assert.throws(() => svc.call(as('flor'), 'impact.get', { userId: 'manny' }), /only see your own/);
  for (const m of ['impact.summary', 'impact.list', 'impact.decide', 'impact.saveKudos', 'impact.setAka', 'impact.rescan']) assert.throws(() => svc.call(as('flor'), m, {}), /Managers only/, m);
  assert.throws(() => svc.call(as('kelly'), 'impact.saveSettings', { notify: false }), /Admins only/);
});

test('notifications: once per confirmed 5-star mention, fresh reviews only, and none when switched off; managers hear about low ratings', () => {
  const { store, svc, as } = setup();
  const notes = (id) => store.list('notifications', (n) => n.userId === id);
  svc.impact.applyReviews([review('2026-09-20', 5, 'Flor was fantastic'), review('2025-09-20', 5, 'Flor last year'), review('2026-09-21', 4, 'Flor good')], {});
  assert.equal(notes('flor').length, 1);
  assert.match(notes('flor')[0].text, /You were mentioned in a 5-star review/);
  assert.match(notes('flor')[0].i18n.es, /Te mencionaron en una reseña de 5 estrellas/);
  svc.impact.applyReviews([review('2026-09-20', 5, 'Flor was fantastic')], {});
  svc.call(as('kelly'), 'impact.rescan');
  assert.equal(notes('flor').length, 1, 'never twice');
  // Ambiguous, then confirmed by a manager: notified then.
  svc.impact.applyReviews([review('2026-09-22', 5, 'Alex was the best')], {});
  assert.equal(notes('alexd').length + notes('alexm').length, 0);
  const m = svc.call(as('kelly'), 'impact.list', { what: 'queue' }).items[0];
  svc.call(as('kelly'), 'impact.decide', { id: m.id, action: 'confirm', userId: 'alexd' });
  assert.equal(notes('alexd').length, 1);
  // Switched off.
  store.update('users', 'kelly', { role: 'admin' });
  svc.call(as('kelly'), 'impact.saveSettings', { notify: false });
  svc.impact.applyReviews([review('2026-09-23', 5, 'Manny was the best')], {});
  assert.equal(notes('manny').length, 0);
  // A new 1-star review: the managers hear about it (alert hook), not the staff named.
  svc.impact.applyReviews([review('2026-09-24', 1, 'Will was rude to us', 'google')], {});
  assert.match(notes('kelly').at(-1).text, /New 1-star review on Google/);
  assert.equal(notes('will').length, 0);
});

test('reviews from any source go through one model: Google CSV through impact.importReviews, replies recorded', () => {
  const { store, svc, as } = setup();
  const r = svc.call(as('kelly'), 'impact.importReviews', { source: 'google', items: [{ date: '2026-09-10', rating: 5, text: 'Manny was our server, so friendly', reviewer: 'Becca Nolan', key: 'h_g1' }] });
  assert.equal(r.counts.new, 1);
  const doc = store.list('guestReviews')[0];
  assert.deepEqual([doc.source, doc.reviewer, doc.replied, doc.reply], ['google', 'Becca N.', false, '']);
  svc.call(as('kelly'), 'impact.saveReply', { id: doc.id, reply: 'Thank you! Manny says hi.' });
  assert.equal(store.get('guestReviews', doc.id).replied, true);
  const list = svc.call(as('kelly'), 'impact.list', { what: 'reviews' });
  assert.deepEqual(list.items[0].people.map((p) => p.name), ['Manny']);
  // A connector (Google, Yelp, an AI reply drafter) registers a hook: it hears about every new review with its matches.
  const seen = [];
  const store2 = new MemoryStore();
  store2.insert('users', { id: 'manny', name: 'Manny', role: 'employee', active: true });
  const links = impactLinks({ store: store2, api: {}, fail: (s, msg) => { throw new Error(msg); }, needAuth() {}, needMgr() {}, needAdmin() {}, notify() {},
    now: () => new Date('2026-09-27T12:00:00'), settings: () => ({}), langOf: () => 'en', onReview: [(x) => seen.push(x)] });
  links.applyReviews([review('2026-09-12', 5, 'Manny rocks', 'yelp')], {});
  links.applyReviews([review('2026-09-12', 5, 'Manny rocks', 'yelp')], {});
  assert.equal(seen.length, 1, 'new reviews only');
  assert.deepEqual([seen[0].review.source, seen[0].mentions[0].userId], ['yelp', 'manny']);
});

test('over HTTP with the demo: staff see only their own kudos; managers see everyone', async () => {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const app = createApp({ db, env: { SEED_DEMO: 'true' } });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const emp = jsonClient(base);
    assert.equal((await signIn(emp.post, 'alexd@demo.shiftboard')).status, 200);
    const mine = await emp.post('/api/rpc/impact.get', {});
    assert.equal(mine.status, 200);
    assert.equal(mine.body.result.person.name, 'Alex D');
    assert.equal((await emp.post('/api/rpc/impact.get', { userId: 'usr_manny' })).status, 403);
    assert.equal((await emp.post('/api/rpc/impact.summary', {})).status, 403);
    assert.equal((await emp.post('/api/rpc/impact.list', { what: 'queue' })).status, 403);
    const mgr = jsonClient(base);
    assert.equal((await signIn(mgr.post, 'kelly@demo.shiftboard')).status, 200);
    const all = await mgr.post('/api/rpc/impact.summary', { period: 'season', seasonId: 'summer-2026' });
    assert.ok(all.body.result.rows.length > 5, 'the demo has two seasons and more of data');
    const other = await mgr.post('/api/rpc/impact.get', { userId: 'usr_manny', period: 'season', seasonId: 'summer-2026' });
    assert.ok(other.body.result.items.some((i) => i.kind === 'request'));
  } finally {
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await conn.end();
  }
});
