// The same review arriving twice (core/review-dedupe.js, through core/impact.js for every source): a file then the
// API, an excerpt then the full text, Yelp's excerpt then the pasted review. Confident matches merge (staff
// matches, managers' decisions and the reply stay; the API's id and the fuller text win), possible ones wait in
// "Possible duplicate — check" and count nowhere; two different reviews are never merged; nothing is counted or
// alerted twice; syncing again changes nothing. Every guest and review here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../core/store.js';
import { createService } from '../core/service.js';
import { seedDemo } from '../core/seed.js';
import { addDays, todayStr } from '../core/time.js';
import { textSimilarity, compareReviews, authorMatch, fullerText } from '../core/review-dedupe.js';
import { applyGoogleReviews } from '../core/google-reviews.js';

const NOW = new Date('2026-11-20T18:00:00Z');
const TODAY = todayStr(NOW);
const D = addDays(TODAY, -2);
const failWith = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const gReview = (id, stars, comment, date, name = 'Dana Kimura') => ({
  name: `accounts/9/locations/111/reviews/${id}`, reviewId: id, reviewer: { displayName: name }, starRating: stars, comment, createTime: `${date}T23:30:00Z`, updateTime: `${date}T23:30:00Z`,
});
function demo() {
  const store = new MemoryStore();
  seedDemo(store, { now: NOW });
  const svc = createService(store, { now: () => NOW });
  const moe = store.get('users', 'usr_moe');
  const google = (rows) => applyGoogleReviews({ store, impact: svc.impact, fail: failWith }, rows, { timeZone: 'UTC' });
  const csv = (source, items) => svc.call(moe, 'impact.importReviews', { source, items });
  const reviews = (source) => store.list('guestReviews', (r) => r.source === source);
  const alerts = () => store.list('notifications', (n) => n.userId === 'usr_kelly' && /^New \d-star review/.test(n.text));
  const counted = () => svc.call(moe, 'impact.summary', { period: 'range', from: addDays(TODAY, -10), to: TODAY }).totals.reviews;
  return { store, svc, moe, google, csv, reviews, alerts, counted };
}
const FULL = 'Manny took wonderful care of our table all night, the short rib was perfect and the dessert was even better. We will be back for brunch soon.';

test('comparing: excerpts, authors, dates, words', () => {
  assert.equal(textSimilarity(FULL, `${FULL.slice(0, 80)}...`).prefix, true, 'an excerpt cut with ...');
  assert.equal(textSimilarity(FULL, `${FULL.slice(0, 95)}…`).score, 1, 'cut mid-word with …');
  assert.equal(textSimilarity('Great food!!', 'great   FOOD').score, 1, 'case and punctuation');
  assert.ok(textSimilarity('Lovely dinner, Flor was great', 'Terrible wait and cold food').score < 0.3);
  assert.equal(authorMatch('Dana Kimura', 'Dana K.'), 'same');
  assert.equal(authorMatch('Dana Kimura', 'Dana L.'), 'different');
  assert.equal(authorMatch('A Google user', 'Dana K.'), 'unknown');
  assert.equal(fullerText(FULL, `${FULL.slice(0, 50)}...`), FULL);
  const a = { source: 'google', rating: 5, date: '2026-11-10', reviewer: 'Sam P', text: FULL };
  assert.equal(compareReviews(a, { ...a, date: '2026-11-11' }).level, 'confident', 'a day apart');
  assert.equal(compareReviews(a, { ...a, date: '2026-11-13' }).level, null, 'three days apart');
  assert.equal(compareReviews(a, { ...a, source: 'yelp' }).level, null, 'another site');
  assert.equal(compareReviews(a, { ...a, rating: 4 }).level, 'possible', 'other stars, same words: a manager checks');
});

test('CSV then API: merged into the one review; staff matches, a manager’s decision and the reply stay; no second alert; re-sync is a no-op', () => {
  const { store, svc, moe, google, csv, reviews, alerts, counted } = demo();
  const before = reviews('google').length;
  csv('google', [{ date: D, rating: 2, text: 'Waited an hour for our food. Manny apologized and was kind about it, but the kitchen was slow.', reviewer: 'Dana Kimura' }]);
  const [r] = reviews('google').filter((x) => x.date === D);
  const m = store.list('impactMentions', (x) => x.sourceId === r.id)[0];
  svc.call(moe, 'impact.decide', { id: m.id, action: 'confirm', userId: 'usr_miguel' }); // a manager reassigns the match
  svc.call(moe, 'reviews.markReplied', { id: r.id, reply: 'We’re sorry, Dana. Please write to us.' });
  const alertsBefore = alerts().length;
  const countedBefore = counted();
  // The same review from Google's API: another key, the date a day later in UTC.
  const out = google([gReview('g-1', 'TWO', 'Waited an hour for our food. Manny apologized and was kind about it, but the kitchen was slow.', addDays(D, 1))]);
  assert.deepEqual([out.counts.new, out.counts.updated, out.counts.possibleDuplicate], [0, 1, 0]);
  assert.equal(reviews('google').length, before + 1, 'one review');
  const merged = store.get('guestReviews', r.id);
  assert.equal(merged.externalId, 'g-1', 'the API’s id');
  assert.equal(merged.origin, 'api');
  assert.equal(merged.google.reviewId, 'g-1', 'answerable on Google now');
  assert.equal(merged.replied, true);
  assert.equal(merged.reply, 'We’re sorry, Dana. Please write to us.');
  const ms = store.list('impactMentions', (x) => x.sourceId === r.id);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].userId, 'usr_miguel', 'the manager’s decision stands');
  assert.equal(alerts().length, alertsBefore, 'no second alert');
  assert.equal(counted(), countedBefore, 'counted once');
  // Syncing again, or importing the file again: nothing changes.
  const again = google([gReview('g-1', 'TWO', 'Waited an hour for our food. Manny apologized and was kind about it, but the kitchen was slow.', addDays(D, 1))]);
  assert.deepEqual([again.counts.new, again.counts.updated, again.counts.same], [0, 0, 1]);
  const file = csv('google', [{ date: D, rating: 2, text: 'Waited an hour for our food. Manny apologized and was kind about it, but the kitchen was slow.', reviewer: 'Dana Kimura' }]);
  assert.deepEqual([file.counts.new, file.counts.updated], [0, 0]);
  assert.equal(store.get('guestReviews', r.id).origin, 'api', 'a file never takes over a synced review');
  assert.equal(reviews('google').length, before + 1);
});

test('an excerpt then the full text (and the other way round): one review, the fuller text', () => {
  const { store, google, csv, reviews } = demo();
  const before = reviews('google').length;
  csv('google', [{ date: D, rating: 5, text: `${FULL.slice(0, 70)}...`, reviewer: 'Lee Park' }]);
  google([gReview('g-2', 'FIVE', FULL, D, 'Lee Park')]);
  assert.equal(reviews('google').length, before + 1);
  assert.equal(reviews('google').find((x) => x.externalId === 'g-2').text, FULL);
  // The full text first, then a cut-off export: the full text stays.
  csv('google', [{ date: D, rating: 5, text: `${FULL.slice(0, 60)}…`, reviewer: 'Lee P.' }]);
  assert.equal(reviews('google').length, before + 1);
  assert.equal(reviews('google').find((x) => x.externalId === 'g-2').text, FULL);
  assert.equal(store.list('impactMentions', (m) => m.sourceId === reviews('google').find((x) => x.externalId === 'g-2').id && m.userId === 'usr_manny').length, 1, 'Manny counted once');
});

test('Yelp: the API’s excerpt, then the pasted full review: kept once, the excerpt stops showing, no second alert', () => {
  const { store, svc, moe, alerts } = demo();
  const excerpt = `${FULL.slice(0, 120)}...`.replace('Manny took wonderful care', 'Nobody took care').replace('was perfect', 'was cold');
  const fullText = FULL.replace('Manny took wonderful care', 'Nobody took care').replace('was perfect', 'was cold');
  svc.reviews.applyYelp([{ id: 'yx-9', rating: 2, text: excerpt, time_created: `${D} 20:00:00`, url: 'https://www.yelp.com/biz/x?hrid=yx-9', user: { name: 'Robin T.' } }]);
  assert.equal(alerts().length, 1, 'the excerpt alerted');
  assert.equal(svc.call(moe, 'reviews.list', { source: 'yelp', period: 'range', from: addDays(TODAY, -10), to: TODAY }).yelp.length, 1);
  svc.call(moe, 'reviews.add', { source: 'yelp', rating: 2, date: D, text: fullText, reviewer: 'Robin Tate' });
  assert.equal(alerts().length, 1, 'the pasted review doesn’t alert again');
  const list = svc.call(moe, 'reviews.list', { source: 'yelp', period: 'range', from: addDays(TODAY, -10), to: TODAY });
  assert.equal(list.yelp.length, 0, 'the excerpt gives way to the full review');
  assert.equal(list.items.filter((x) => x.date === D).length, 1);
});

test('must NOT match: two different 5-star reviews the same day by two people with the same first name', () => {
  const { google, csv, reviews } = demo();
  const before = reviews('google').length;
  csv('google', [{ date: D, rating: 5, text: 'Flor made our anniversary special, she picked a perfect wine.', reviewer: 'Sam Ortiz' }]);
  const r = google([gReview('g-3', 'FIVE', 'Best brunch in town, the chilaquiles are a must and the coffee is great.', D, 'Sam Ortiz')]);
  assert.deepEqual([r.counts.new, r.counts.possibleDuplicate], [1, 0]);
  csv('google', [{ date: D, rating: 5, text: 'Dante made us the best margaritas, the patio was lovely at sunset.', reviewer: 'Sam B.' }]);
  assert.equal(reviews('google').length, before + 3);
  assert.equal(reviews('google').filter((x) => x.possibleDuplicateOf).length, 0);
});

test('a possible duplicate waits for a manager, counts nowhere, then merge or keep both', () => {
  const { store, svc, moe, google, csv, reviews, alerts, counted } = demo();
  csv('google', [{ date: D, rating: 4, text: 'Karen at the bar was fun and the burger was good, the fries were a bit cold though.', reviewer: 'Jo Lane' }]);
  const countedBefore = counted();
  const alertsBefore = alerts().length;
  const mentionsBefore = store.list('impactMentions').length;
  // Same person, day and stars, words changed a fair bit (edited on Google): possible, not confident.
  const r = google([gReview('g-4', 'FOUR', 'Karen at the bar was so fun, burger good, fries cold, music too loud for us honestly.', D, 'Jo Lane')]);
  assert.equal(r.counts.possibleDuplicate, 1);
  const dup = reviews('google').find((x) => x.possibleDuplicateOf);
  assert.ok(dup);
  assert.equal(counted(), countedBefore, 'not counted');
  assert.equal(alerts().length, alertsBefore, 'not alerted');
  assert.equal(store.list('impactMentions').length, mentionsBefore, 'no names matched yet');
  const list = svc.call(moe, 'reviews.list', { period: 'range', from: addDays(TODAY, -10), to: TODAY });
  assert.equal(list.possibleDuplicates.length, 1);
  assert.equal(list.possibleDuplicates[0].of.id, dup.possibleDuplicateOf);
  assert.ok(!list.items.some((x) => x.id === dup.id), 'not in the list until checked');
  // Syncing again changes nothing.
  assert.equal(google([gReview('g-4', 'FOUR', 'Karen at the bar was so fun, burger good, fries cold, music too loud for us honestly.', D, 'Jo Lane')]).counts.same, 1);
  // Merge: one review, the API's id, Google-answerable, Karen counted once.
  const origId = dup.possibleDuplicateOf;
  svc.call(moe, 'reviews.resolveDuplicate', { id: dup.id, action: 'merge' });
  assert.equal(store.get('guestReviews', dup.id), null);
  assert.equal(store.get('guestReviews', origId).externalId, 'g-4');
  assert.equal(store.list('impactMentions', (m) => m.sourceId === origId && m.userId === 'usr_karen').length, 1);
  assert.equal(counted(), countedBefore);
  assert.equal(google([gReview('g-4', 'FOUR', 'Karen at the bar was so fun, burger good, fries cold, music too loud for us honestly.', D, 'Jo Lane')]).counts.new, 0, 'answers to its Google id now');
  // Keep both: two reviews, both counted, and it isn't asked again.
  csv('google', [{ date: D, rating: 3, text: 'Andrea was our server, the pasta was fine but the room was very cold and loud.', reviewer: 'Kim Wu' }]);
  google([gReview('g-5', 'THREE', 'Andrea was our server, the pasta fine, room cold, but we loved the dessert and coffee a lot.', D, 'Kim Wu')]);
  const d2 = reviews('google').find((x) => x.possibleDuplicateOf);
  const c2 = counted();
  svc.call(moe, 'reviews.resolveDuplicate', { id: d2.id, action: 'keepBoth' });
  assert.equal(counted(), c2 + 1);
  assert.equal(google([gReview('g-5', 'THREE', 'Andrea was our server, the pasta fine, room cold, but we loved the dessert and coffee a lot.', D, 'Kim Wu')]).counts.same, 1);
  assert.throws(() => svc.call(moe, 'reviews.resolveDuplicate', { id: d2.id, action: 'merge' }), /isn’t waiting/);
  assert.throws(() => svc.call(store.get('users', 'usr_karen'), 'reviews.resolveDuplicate', { id: d2.id, action: 'merge' }), (e) => e.status === 403);
});
