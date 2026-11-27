// Import from a calendar page (server/calendar/, core/calendar-import.js, server/tools/calendar.js), with a fake
// network and a fake AI. Every page, feed, venue and act here is invented.
//   - the SSRF guard: loopback, private, link-local / metadata addresses, a name that resolves to one, a redirect
//     to one, too many redirects, other schemes, credentials in the URL, the content type, the size cap, the timeout
//   - extraction, in order: The Events Calendar's REST API (paginated), iCal (RRULE, EXDATE, UNTIL), JSON-LD
//     (Event, EventSeries), then the page's text by AI (purpose import_calendar)
//   - suggestions: recurring by title/weekday/time, a category "slot" with acts that vary, every other week, rooms
//     matched by name (venue text, title, description, alias), Start date = first date, End date only when it ends,
//     duplicates of programming and events, pars copied only from a same-name item
//   - Settings → Programming's route and RPCs: managers with Edit programming only, nothing saved without apply,
//     rooms required, audit log with via; re-reading flags what was imported; the remembered page
//   - Ask ShiftBoard: the tool's card, Import now → Confirm, via 'assistant'; the import tool previews first
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { jsonClient, signIn } from './helpers/signin.js';
import { fakeAnthropic, text, toolUse } from './helpers/fake-anthropic.js';
import { setAiClientFactory } from '../server/ai/index.js';
import { todayOf } from '../server/tools/dates.js';
import { addDays, dow } from '../core/time.js';
import {
  safeFetch, isBlockedIp, checkUrl, readCalendarPage, parseIcs, jsonLdEvents, tribeEvents, CalendarError, MAX_BYTES,
} from '../server/calendar/web-calendar.js';
import { planFromEvents, cleanTitle, roomIn } from '../core/calendar-import.js';
import { TOOLS, runTool, createToolContext, READ, WRITE } from '../server/tools/index.js';

const KEY = 'sk-ant-test-platform-placeholder-0003'; // not a real key: the fake client never sends it anywhere
const TODAY = todayOf(Date.now());
/** The next date on or after `from` that is weekday d (0 = Sunday). */
const next = (d, from = TODAY) => { let x = from; while (dow(x) !== d) x = addDays(x, 1); return x; };
const weekly = (d, n, from = TODAY) => Array.from({ length: n }, (_, i) => addDays(next(d, from), 7 * i));

// ---------- a fake network ----------
/** routes: { url: { status?, type?, body?, location? } | (url) => that }. Records every request. */
function fakeNet(routes) {
  const seen = [];
  const transport = async (url, { signal } = {}) => {
    seen.push(url);
    let r = routes[url] ?? routes[url.replace(/\?.*$/, '')] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && url.startsWith(k.slice(0, -1)))?.[1];
    if (typeof r === 'function') r = await r(url, signal);
    if (!r) return { status: 404, headers: { get: () => 'text/html' }, body: '' };
    const h = { 'content-type': r.type || 'text/html; charset=utf-8', ...(r.location ? { location: r.location } : {}) };
    return { status: r.status || 200, headers: { get: (k) => h[String(k).toLowerCase()] ?? null }, body: r.body || '' };
  };
  const lookup = async (host) => [{ address: host.endsWith('.private.test') ? '10.0.0.7' : '93.184.216.34', family: 4 }];
  return { transport, lookup, seen };
}

// ---------- invented calendars ----------
const ev = (o) => ({ id: o.id, title: o.title, start_date: `${o.date} ${o.start}:00`, end_date: `${o.endDate || o.date} ${o.end}:00`, all_day: false, url: `https://lanterns.example/events/${o.id}/`,
  venue: o.venue ? { venue: o.venue } : [], categories: (o.cats || []).map((name) => ({ name })), excerpt: o.excerpt || '', description: '' });
function tribeFixture() {
  const list = [];
  let id = 100;
  for (const d of weekly(4, 6)) list.push(ev({ id: id++, title: 'Velvet Jazz Hour in Moon Rabbit', date: d, start: '19:00', end: '22:00', cats: ['Live Music'] }));
  for (const d of weekly(1, 5)) list.push(ev({ id: id++, title: 'Paper Lantern Quiz', date: d, start: '18:30', end: '20:30', excerpt: '<p>Teams of four in the Rabbit Hole.</p>', cats: ['Games'] }));
  const acts = ['Selector One', 'Kiko Wave', 'Night Owl Trio', 'Mira Static', 'Low Tide', 'Copper Hum', 'The Pinwheels', 'Glass Arcade', 'Saffron Beat', 'North Lights'];
  [...weekly(5, 5), ...weekly(6, 5)].forEach((d, i) => list.push(ev({ id: id++, title: acts[i], date: d, start: '23:00', end: '02:00', venue: 'Lower Lounge', cats: ['DJ'] })));
  for (const d of weekly(2, 3)) list.push(ev({ id: id++, title: 'Trivia Night', date: d, start: '19:00', end: '21:00', cats: ['Games'] }));
  list.push(ev({ id: id++, title: 'Lantern Festival Gala feat. The Paper Cranes', date: addDays(next(3), 14), start: '20:00', end: '23:30', venue: 'Moon Rabbit', cats: ['Special Event'] }));
  list.push(ev({ id: id++, title: 'Silent Film Brunch', date: addDays(next(0), 7), start: '11:00', end: '13:00', cats: ['Films'] }));
  list.sort((a, b) => a.start_date.localeCompare(b.start_date));
  return list;
}
const PAGE = 'https://lanterns.example/events/';
function tribeRoutes() {
  const list = tribeFixture();
  const half = Math.ceil(list.length / 2);
  return {
    [PAGE]: { body: `<html><head><link rel="alternate" href="https://lanterns.example/wp-json/tribe/events/v1/"></head><body class="tribe-events-page">Events</body></html>` },
    'https://lanterns.example/wp-json/tribe/events/v1/events': (url) => {
      const page = Number(new URL(url).searchParams.get('page')) || 1;
      return { type: 'application/json', body: JSON.stringify({ events: page === 1 ? list.slice(0, half) : list.slice(half), total: list.length, total_pages: 2, ...(page === 1 ? { next_rest_url: `${url}&page=2` } : {}) }) };
    },
  };
}
const ics = (date) => date.replace(/-/g, '');
function icsFeed() {
  const first = next(3);
  const skip = addDays(first, 7);
  const until = addDays(first, 35);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Invented//EN',
    'BEGIN:VEVENT', 'UID:series-1@lanterns.example', `DTSTART;TZID=America/Denver:${ics(first)}T170000`, `DTEND;TZID=America/Denver:${ics(first)}T190000`,
    'SUMMARY:Garden Hour', 'LOCATION:Restaurant patio', `RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=${ics(until)}T235959Z`, `EXDATE;TZID=America/Denver:${ics(skip)}T170000`,
    'DESCRIPTION:Long table\\, small plates', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:one-1@lanterns.example', `DTSTART:${ics(addDays(TODAY, 10))}T200000Z`, 'SUMMARY:Poetry Slam', 'LOCATION:Moon Rabbit', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
}
function jsonLdPage() {
  const graph = [
    ...weekly(2, 4).map((d) => ({ '@type': 'MusicEvent', name: 'Tuesday Strings', startDate: `${d}T18:00:00-07:00`, endDate: `${d}T20:00:00-07:00`, location: { '@type': 'Place', name: 'Library' } })),
    { '@type': 'Event', name: 'Book Swap', startDate: `${addDays(TODAY, 12)}T15:00:00-07:00`, location: 'Library' },
  ];
  return `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script></head><body>x</body></html>`;
}

// ---------- the SSRF guard ----------
test('the guard refuses private, loopback, link-local and metadata addresses, and other schemes', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
  const net = fakeNet({});
  const refused = async (url, code) => assert.rejects(safeFetch(url, net), (e) => e instanceof CalendarError && e.code === code, url);
  await refused('http://127.0.0.1/events', 'blocked');
  await refused('http://10.0.0.5/', 'blocked');
  await refused('http://169.254.169.254/latest/meta-data/', 'blocked');
  await refused('http://[::1]:80/', 'blocked');
  await refused('http://localhost/', 'blocked');
  await refused('https://calendar.private.test/', 'blocked'); // a name that resolves to 10.x
  await refused('https://lanterns.example:22/', 'blocked');
  await refused('file:///etc/passwd', 'scheme');
  await refused('ftp://lanterns.example/x.ics', 'scheme');
  await refused('https://user:secret@lanterns.example/', 'url');
  assert.equal(net.seen.length, 0, 'nothing was requested');
  assert.equal(checkUrl('webcal://lanterns.example/cal.ics').protocol, 'https:');
});

test('the guard checks every redirect, caps the redirects, the type, the size and the time', async () => {
  const net = fakeNet({
    'https://lanterns.example/a': { status: 302, location: 'http://192.168.1.5/admin' },
    'https://lanterns.example/b': { status: 301, location: 'https://lanterns.example/c' },
    'https://lanterns.example/c': { status: 302, location: 'https://lanterns.example/d' },
    'https://lanterns.example/d': { status: 302, location: 'https://lanterns.example/e' },
    'https://lanterns.example/e': { status: 302, location: 'https://lanterns.example/f' },
    'https://lanterns.example/meta': { status: 302, location: 'http://169.254.169.254/' },
    'https://lanterns.example/pic.png': { type: 'image/png', body: 'x' },
    'https://lanterns.example/big': { body: 'x'.repeat(MAX_BYTES + 10) },
    'https://lanterns.example/slow': (url, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    'https://lanterns.example/ok': { status: 302, location: '/events/' },
    [PAGE]: { body: '<html>ok</html>' },
  });
  await assert.rejects(safeFetch('https://lanterns.example/a', net), { code: 'blocked' });
  await assert.rejects(safeFetch('https://lanterns.example/meta', net), { code: 'blocked' });
  assert.ok(!net.seen.some((u) => /192\.168|169\.254/.test(u)), 'the private address was never requested');
  await assert.rejects(safeFetch('https://lanterns.example/b', net), { code: 'redirects' });
  await assert.rejects(safeFetch('https://lanterns.example/pic.png', net), { code: 'type' });
  await assert.rejects(safeFetch('https://lanterns.example/big', net), { code: 'tooBig' });
  await assert.rejects(safeFetch('https://lanterns.example/slow', { ...net, timeoutMs: 30 }), { code: 'timeout' });
  const ok = await safeFetch('https://lanterns.example/ok', net);
  assert.equal(ok.url, PAGE);
});

// ---------- extraction ----------
test('The Events Calendar: its REST API, paginated, over the next 8 weeks', async () => {
  const net = fakeNet(tribeRoutes());
  const r = await readCalendarPage(PAGE, { ...net, today: TODAY, tz: 'America/Denver' });
  assert.equal(r.source, 'tribe');
  assert.equal(r.events.length, tribeFixture().length);
  assert.ok(net.seen.some((u) => /page=2/.test(u)), 'read the second page');
  const api = new URL(net.seen.find((u) => /wp-json/.test(u)));
  assert.equal(api.searchParams.get('start_date'), TODAY);
  assert.equal(api.searchParams.get('end_date'), addDays(TODAY, 56));
  const jazz = r.events.find((e) => /Velvet/.test(e.title));
  assert.deepEqual([jazz.start, jazz.end, jazz.categories[0]], ['19:00', '22:00', 'Live Music']);
  assert.equal(tribeEvents({ events: [{ title: 'A &#8211; B', start_date: `${TODAY} 10:00:00`, end_date: `${TODAY} 11:00:00` }] })[0].title, 'A – B');
});

test('iCal: a weekly RRULE with EXDATE and UNTIL, and a one-off in UTC', async () => {
  const feed = 'https://lanterns.example/cal.ics';
  const net = fakeNet({
    [PAGE]: { body: `<a href="https://www.google.com/calendar/render?cid=webcal%3A%2F%2Fx">Google</a><a href="/cal.ics">Subscribe</a>` },
    [feed]: { type: 'text/calendar', body: icsFeed() },
  });
  const r = await readCalendarPage(PAGE, { ...net, today: TODAY, tz: 'Asia/Tokyo' });
  assert.equal(r.source, 'ics');
  const garden = r.events.filter((e) => e.title === 'Garden Hour');
  assert.equal(garden.length, 5, 'six Wednesdays to UNTIL, one excluded');
  assert.ok(garden.every((e) => e.start === '17:00' && e.end === '19:00' && dow(e.date) === 3));
  assert.equal(garden[0].description, 'Long table, small plates');
  const slam = r.events.find((e) => e.title === 'Poetry Slam');
  assert.deepEqual([slam.date, slam.start], [addDays(TODAY, 11), '05:00'], 'a UTC time is shown in the venue’s clock (Tokyo: +9)');
});

test('JSON-LD Events, and the AI only when nothing else is there', async () => {
  const net = fakeNet({ [PAGE]: { body: jsonLdPage() } });
  const r = await readCalendarPage(PAGE, { ...net, today: TODAY });
  assert.equal(r.source, 'jsonld');
  assert.equal(r.events.length, 5);
  assert.equal(r.events[0].room, 'Library');
  const series = jsonLdEvents(`<script type="application/ld+json">${JSON.stringify({ '@type': 'EventSeries', name: 'Sunday Supper', eventSchedule: { byDay: 'https://schema.org/Sunday', startTime: '17:00', endTime: '20:00', startDate: TODAY } })}</script>`);
  assert.deepEqual(series[0].recurrence.days, [0]);

  // A page with only text: the AI reads it (strict JSON), metered as import_calendar.
  const plain = fakeNet({ [PAGE]: { body: `<html><body><h1>What's on</h1><p>${addDays(TODAY, 3)} Candle Making 6pm in the Library</p><script>var x=1</script></body></html>` } });
  const calls = [];
  const ai = { available: true, complete: async (o) => { calls.push(o); return { text: JSON.stringify({ events: [{ title: 'Candle Making', date: addDays(TODAY, 3), start: '18:00', end: '', room: 'Library' }, { title: 'Bad', date: 'soon' }] }) }; } };
  const r2 = await readCalendarPage(PAGE, { ...plain, today: TODAY, ai });
  assert.equal(r2.source, 'ai');
  assert.equal(calls[0].purpose, 'import_calendar');
  assert.ok(!calls[0].messages[0].content.includes('var x'), 'scripts are left out');
  assert.deepEqual(r2.events.map((e) => [e.title, e.start, e.room]), [['Candle Making', '18:00', 'Library']]);
  await assert.rejects(readCalendarPage(PAGE, { ...plain, today: TODAY, ai: { available: false, reason: 'cap' } }), (e) => e.code === 'none' && e.notes.includes('ai_cap'));
});

// ---------- suggestions ----------
const ROOMS = ['Restaurant', 'Rabbit Hole', 'Moon Rabbit', 'Library'];
test('suggestions: recurring by title, weekday and time; a slot; one-offs; rooms; dates', async () => {
  const net = fakeNet(tribeRoutes());
  const r = await readCalendarPage(PAGE, { ...net, today: TODAY });
  const p = planFromEvents(r.events, { rooms: ROOMS, windowTo: r.to, aliases: { 'lower lounge': 'Rabbit Hole' } });
  const by = (n) => p.recurring.find((x) => x.name === n);
  const jazz = by('Velvet Jazz Hour');
  assert.ok(jazz, 'the room phrase leaves the name');
  assert.deepEqual([jazz.days, jazz.start, jazz.end, jazz.room, jazz.roomFrom, jazz.count, jazz.repeat], [[4], '19:00', '22:00', 'Moon Rabbit', 'title', 6, 'weekly']);
  assert.equal(jazz.from, next(4), 'Start date: the first matched date');
  assert.equal(jazz.to, '', 'End date blank: it keeps running');
  assert.deepEqual(jazz.pars, [], 'no pars invented');
  const quiz = by('Paper Lantern Quiz');
  assert.equal(quiz.room, 'Rabbit Hole');
  assert.equal(quiz.roomFrom, 'description');
  const dj = p.recurring.find((x) => x.kind === 'slot');
  assert.deepEqual([dj.name, dj.days, dj.start, dj.end, dj.count, dj.room], ['DJ', [5, 6], '23:00', '02:00', 10, 'Rabbit Hole']);
  assert.equal(dj.acts.length, 8);
  assert.equal(by('Trivia Night').count, 3);
  assert.deepEqual(p.oneOffs.map((o) => o.name).sort(), ['Lantern Festival Gala feat. The Paper Cranes', 'Silent Film Brunch']);
  assert.equal(p.oneOffs.find((o) => /Gala/.test(o.name)).room, 'Moon Rabbit');
  assert.equal(p.oneOffs.find((o) => /Brunch/.test(o.name)).room, '', 'no room named: the manager picks');

  // Without the alias the DJ slot's venue text matches nothing: ask.
  const p2 = planFromEvents(r.events, { rooms: ROOMS, windowTo: r.to });
  assert.equal(p2.recurring.find((x) => x.kind === 'slot').room, '');
  assert.ok(p2.unmatched.includes('Lower Lounge'));
});

test('suggestions: every other week, an end date, duplicates and pars copied from a same-name item', () => {
  const mk = (title, date, start = '20:00', end = '22:00', room = '') => ({ title, date, start, end, room, description: '', url: '', categories: [], uid: '' });
  const alt = [0, 1, 2, 3].map((w) => mk('Salsa Social', addDays(next(2), 14 * w)));
  const ends = weekly(1, 3).map((d) => mk('Winter Workshop', d, '17:00', '18:00', 'Library'));
  const later = mk('Far Away Show', addDays(TODAY, 50));
  const p = planFromEvents([...alt, ...ends, later, mk('Old Favorite', addDays(TODAY, 5), '19:00', '21:00', 'Moon Rabbit')], {
    rooms: ROOMS, windowTo: addDays(TODAY, 56),
    items: [{ id: 'p1', name: 'Winter workshop', rooms: ['Library'], days: [1], start: '17:00', end: '18:00', pars: [{ jobCodeId: 'job_x', count: 2 }] }],
    existingEvents: [{ id: 'e1', name: 'Old Favorite', date: addDays(TODAY, 5) }],
  });
  const salsa = p.recurring.find((x) => x.name === 'Salsa Social');
  assert.deepEqual([salsa.repeat, salsa.anchor], ['biweekly', alt[0].date]);
  const ws = p.recurring.find((x) => x.name === 'Winter Workshop');
  assert.equal(ws.to, ends.at(-1).date, 'the calendar goes on past its last date: it ends there');
  assert.deepEqual(ws.duplicateOf, { id: 'p1', name: 'Winter workshop', why: 'name' });
  assert.equal(ws.include, false, 'duplicates start unticked');
  assert.deepEqual(ws.pars, [{ jobCodeId: 'job_x', count: 2 }], 'pars come only from a same-name item');
  assert.equal(salsa.to, '', 'still running at the end of the window');
  assert.equal(p.oneOffs.find((o) => o.name === 'Old Favorite').duplicateOf.kind, 'event');
  assert.equal(cleanTitle('Hip Hop Nights ft. Someone'), 'Hip Hop Nights');
  assert.equal(cleanTitle('Magic with Someone Famous'), 'Magic');
  assert.equal(cleanTitle('Film Night 2'), 'Film Night');
  assert.equal(roomIn('Dinner in the moon rabbit speakeasy', ROOMS).room, 'Moon Rabbit');
  assert.equal(roomIn('Bunny hop', ROOMS), null);
});

// ---------- the app: Settings → Programming and Ask ShiftBoard ----------
const fake = fakeAnthropic();
let A;
const people = {};
const browsers = new Map();
before(async () => {
  const routes = { ...tribeRoutes(), 'https://lanterns.example/cal.ics': { type: 'text/calendar', body: icsFeed() }, 'https://lanterns.example/hop': { status: 302, location: 'http://10.9.9.9/' } };
  const net = fakeNet(routes);
  A = await startApp({ env: { ANTHROPIC_API_KEY: KEY, AI_MESSAGES_PER_MINUTE: '100', AI_CALLS_PER_MINUTE: '500' }, aiClient: fake.factory, calendarReader: { transport: net.transport, lookup: net.lookup } });
  const pick = (role) => A.db.store.list('users', (u) => u.role === role && u.active !== false).sort((a, b) => a.order - b.order)[0];
  for (const r of ['admin', 'manager', 'employee', 'supervisor']) people[r] = pick(r);
});
after(async () => { setAiClientFactory(null); await A.close(); });
async function as(who) {
  if (!browsers.has(who)) {
    browsers.set(who, (async () => {
      const c = jsonClient(A.base);
      const r = await signIn(c.post, people[who].email);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { ...c, rpc: (m, a = {}) => c.post(`/api/rpc/${m}`, a) };
    })());
  }
  return browsers.get(who);
}

test('Settings → Programming: read, review, apply; managers only; audited; re-reading flags what was imported', async () => {
  const emp = await as('employee');
  const r0 = await emp.post('/api/programming/calendar/read', { url: PAGE });
  assert.equal(r0.status, 403);
  assert.equal((await emp.rpc('programming.calendar.get')).status, 403);
  assert.equal((await emp.rpc('programming.calendar.apply', { id: 'x' })).status, 403);

  const mgr = await as('manager');
  const bad = await mgr.post('/api/programming/calendar/read', { url: 'https://lanterns.example/hop' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'blocked');
  assert.equal((await mgr.post('/api/programming/calendar/read', { url: 'http://127.0.0.1:5432/' })).body.reason, 'blocked');

  const before = A.db.store.list('programming').length;
  const eventsBefore = A.db.store.list('events').length;
  const r = await mgr.post('/api/programming/calendar/read', { url: PAGE, remember: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const imp = r.body.result.import;
  assert.equal(imp.source, 'tribe');
  assert.equal(r.body.result.source.url, PAGE, 'the page is remembered');
  assert.equal(A.db.store.list('programming').length, before, 'reading saves nothing');
  const trivia = imp.recurring.find((x) => x.name === 'Trivia Night');
  assert.equal(trivia.duplicateOf.name, 'Trivia night', 'the demo already has Trivia night');
  const slot = imp.recurring.find((x) => x.kind === 'slot');
  assert.equal(slot.room, '', 'the demo has no "Lower Lounge"');

  // A recurring suggestion without a room isn't saved.
  const noRoom = await mgr.rpc('programming.calendar.apply', { id: imp.id });
  assert.equal(noRoom.status, 400);
  assert.match(noRoom.body.error, /Pick a room for “DJ”/);
  assert.equal(A.db.store.list('programming').length, before);

  const brunch = imp.oneOffs.find((o) => /Brunch/.test(o.name));
  const selections = { recurring: { [slot.key]: { room: 'Rabbit Hole', name: 'Late DJ', to: addDays(TODAY, 40) } }, oneOffs: { [brunch.key]: { include: false } } };
  const dry = await mgr.rpc('programming.calendar.apply', { id: imp.id, selections, dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(A.db.store.list('programming').length, before, 'a dry run saves nothing');
  const ok = await mgr.rpc('programming.calendar.apply', { id: imp.id, selections });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const added = A.db.store.list('programming').filter((x) => ok.body.result.items.includes(x.id));
  assert.deepEqual(added.map((x) => x.name).sort(), ['Late DJ', 'Paper Lantern Quiz', 'Velvet Jazz Hour']);
  const dj = added.find((x) => x.name === 'Late DJ');
  assert.deepEqual([dj.rooms, dj.days, dj.start, dj.end, dj.to, dj.pars], [['Rabbit Hole'], [5, 6], '23:00', '02:00', addDays(TODAY, 40), []]);
  assert.equal(added.find((x) => x.name === 'Velvet Jazz Hour').from, next(4));
  const evs = A.db.store.list('events').filter((e) => ok.body.result.events.includes(e.id));
  assert.equal(A.db.store.list('events').length, eventsBefore + 1);
  assert.deepEqual([evs[0].status, evs[0].room, evs[0].source], ['confirmed', 'Moon Rabbit', 'calendar']);
  const audit = A.db.store.list('auditLog', (x) => x.action === 'programming.calendarImport');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].via, 'web');
  assert.equal(audit[0].details.items, 3);
  assert.equal(A.db.store.list('auditLog', (x) => x.action === 'programming.saved' && ok.body.result.items.includes(x.targetId)).length, 3);
  assert.equal(A.db.store.get('calendarSources', 'main').aliases['lower lounge'], 'Rabbit Hole', 'the room picked for the venue text is remembered');

  // Check for new events: the remembered page; what was imported is flagged now, and the alias matches.
  const again = await mgr.post('/api/programming/calendar/read', {});
  assert.equal(again.status, 200);
  const imp2 = again.body.result.import;
  assert.ok(imp2.recurring.filter((x) => x.kind !== 'slot').every((x) => x.duplicateOf), 'every recurring one is already there');
  assert.equal(imp2.recurring.find((x) => x.kind === 'slot').room, 'Rabbit Hole');
  assert.equal(imp2.oneOffs.find((o) => /Gala/.test(o.name)).duplicateOf.why, 'imported');
  assert.equal(imp2.oneOffs.find((o) => /Brunch/.test(o.name)).include, true, 'the one left out is still new');
  assert.equal((await mgr.rpc('programming.calendar.forget')).status, 200);
  assert.equal((await mgr.post('/api/programming/calendar/read', {})).body.reason, 'noUrl');

  // Edit programming off for managers: refused.
  await A.db.run((s) => s.update('settings', 'settings', { roleFeatures: { manager: { programmingEdit: false } } }), { write: true });
  assert.equal((await mgr.post('/api/programming/calendar/read', { url: PAGE })).status, 403);
  await A.db.run((s) => s.update('settings', 'settings', { roleFeatures: {} }), { write: true });
});

test('Ask ShiftBoard: a pasted link → the card; Import now → Confirm; via assistant; staff never get the tool', async () => {
  const mgr = await as('manager');
  fake.clear();
  fake.reply(toolUse('read_events_calendar', { url: 'https://lanterns.example/cal.ics' }), text('I found a weekly Garden Hour and one event.'));
  const r = await mgr.post('/api/assistant', { message: 'build programming from https://lanterns.example/cal.ics', stream: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.result.message;
  assert.ok(m.calendar, 'the reply carries the card');
  assert.equal(m.calendar.source, 'ics');
  const garden = m.calendar.recurring.find((x) => x.name === 'Garden Hour');
  assert.deepEqual([garden.days, garden.start, garden.end, garden.room], [[3], '17:00', '19:00', 'Restaurant']);
  assert.equal(garden.to, addDays(next(3), 35), 'the RRULE’s UNTIL is its End date');
  assert.equal(m.calendar.oneOffs, 1);
  assert.ok(fake.calls[0].params.tools.some((t) => t.name === 'read_events_calendar'));
  const conv = r.body.result.conversationId;

  const before = A.db.store.list('programming').length;
  const p = await mgr.post(`/api/assistant/calendar/${m.calendar.id}/propose`, { conversationId: conv, selections: { recurring: { [garden.key]: { name: 'Garden Supper' } } } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const action = p.body.result.message.actions.at(-1);
  assert.equal(action.status, 'proposed');
  assert.equal(A.db.store.list('programming').length, before, 'nothing saved before Confirm');
  const c = await mgr.post(`/api/assistant/actions/${action.id}`, { conversationId: conv, decision: 'confirm' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.result.ok, true, JSON.stringify(c.body));
  const item = A.db.store.list('programming').find((x) => x.name === 'Garden Supper');
  assert.ok(item);
  assert.deepEqual([item.rooms, item.repeat, item.to, item.pars], [['Restaurant'], 'weekly', addDays(next(3), 35), []]);
  const audit = A.db.store.list('auditLog', (x) => x.action === 'programming.calendarImport').at(-1);
  assert.equal(audit.via, 'assistant');
  const chat = A.db.store.get('assistantChats', conv);
  assert.equal(chat.messages.find((x) => x.calendar)?.calendar.status, 'done');

  // Staff: the tool isn't offered, and the routes refuse.
  const emp = await as('employee');
  fake.clear();
  fake.reply(text('I can’t do that.'));
  await emp.post('/api/assistant', { message: 'build programming from https://lanterns.example/events/', stream: false });
  assert.ok(!fake.calls[0].params.tools.some((t) => /calendar/.test(t.name)), 'staff never see the calendar tools');
  assert.equal((await emp.post(`/api/assistant/calendar/${m.calendar.id}/propose`, { conversationId: conv })).status, 403);
});

test('the import tool previews first and saves only with confirm: true; read-only connections can’t save', async () => {
  const user = A.db.store.get('users', people.manager.id);
  const reader = { read: async (u, o) => { const { createCalendarReading } = await import('../server/calendar/index.js'); const net = fakeNet({ 'https://lanterns.example/cal.ics': { type: 'text/calendar', body: icsFeed() } });
    return createCalendarReading({ db: A.db, env: {}, reader: { transport: net.transport, lookup: net.lookup } }).read(u, o); } };
  const ctx = createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, scopes: [READ, WRITE], via: 'claude', client: 'Test', calendar: reader });
  const tool = TOOLS.find((t) => t.name === 'import_programming_from_calendar');
  const before = A.db.store.list('programming').length;
  const preview = await runTool(tool, { url: 'https://lanterns.example/cal.ics', include: ['Garden Hour'] }, ctx);
  assert.equal(preview.ok, true, preview.error);
  assert.match(preview.summary, /Preview only, nothing saved/);
  assert.equal(A.db.store.list('programming').length, before);
  const ro = createToolContext({ db: A.db, userId: user.id, v: user.sessionVersion || 0, scopes: [READ], via: 'claude', client: 'Test', calendar: reader });
  const refused = await runTool(tool, { importId: preview.data.importId, confirm: true }, ro);
  assert.equal(refused.ok, false);
  const done = await runTool(tool, { importId: preview.data.importId, include: ['Garden Hour'], rooms: [{ key: 'Garden Hour', room: 'Restaurant' }], changes: [{ key: 'Garden Hour', name: 'Garden Hour (connector)' }], confirm: true }, ctx);
  assert.equal(done.ok, true, done.error);
  assert.ok(A.db.store.list('programming').some((x) => x.name === 'Garden Hour (connector)'));
  assert.equal(A.db.store.list('auditLog', (x) => x.action === 'programming.calendarImport').at(-1).via, 'connector');
  const emp = A.db.store.get('users', people.employee.id);
  const ectx = createToolContext({ db: A.db, userId: emp.id, v: emp.sessionVersion || 0, scopes: [READ, WRITE], via: 'claude', calendar: reader });
  assert.equal((await runTool(TOOLS.find((t) => t.name === 'read_events_calendar'), { url: PAGE }, ectx)).ok, false);
  void parseIcs;
});
