// SAMPLE OpenTable reservations, reviews (OpenTable, Google, Yelp) and kudos for the demo: Positive impact
// and the forecast's booked covers. Every guest, review and note here is invented; the staff are the demo's
// own people. Two seasons and more (Summer 2025, Winter 2025–26, Summer 2026, and the weeks before the
// demo's "today"), so the season picker, last year's comparison and the leaderboard all have something to
// show. Everything goes through the same import code as a real file (core/opentable.js), so it's scrubbed,
// shortened and matched exactly like a real import, and notifications go out for fresh 5-star mentions.
import { uid } from './store.js';
import { addDays, dow, range, todayStr } from './time.js';
import { createService } from './service.js';
import { hashKey } from './guest-csv.js';

const WEEK = '2026-09-28'; // the demo week (core/seed.js)

function mulberry(seed) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// [posted, dined, stars, source, reviewer, text]: fixed dates across three seasons.
const REVIEWS = [
  // Summer 2025 (last year's summer: the comparison)
  ['2025-06-14', '2025-06-12', 5, 'opentable', 'Priya Sandoval', 'Lovely anniversary dinner. Alex was our server and walked us through the whole menu. The halibut was perfect.'],
  ['2025-07-06', '2025-07-04', 5, 'opentable', 'Marcus Tellez', 'Fourth of July on the patio! Karen at the bar made the best spritz in town. Thanks Karen!'],
  ['2025-08-02', '2025-08-01', 4, 'google', 'Helen W.', 'Great food, a little loud. Our server Manny was attentive and funny.'],
  ['2025-08-23', '2025-08-22', 5, 'opentable', 'Grant Okafor', 'Flor took great care of us and remembered our son’s allergy without being asked. Will be back.'],
  ['2025-09-20', '2025-09-19', 5, 'yelp', 'Jo B.', 'Best night out in ages. Dante behind the Moon Rabbit bar is a wizard.'],
  // Winter 2025–26
  ['2025-11-29', '2025-11-28', 5, 'opentable', 'Lena Castillo', 'Thanksgiving weekend with the family. Andrea kept everything moving and the kids loved her.'],
  ['2025-12-13', '2025-12-12', 5, 'opentable', 'Owen Brightwater', 'Holiday party for six. Alex D. was wonderful, recommended a great bottle and timed every course.'],
  ['2025-12-31', '2025-12-30', 3, 'google', 'Sam R.', 'Food was good but slow. Victor was apologetic and comped dessert, which we appreciated.'],
  ['2026-01-17', '2026-01-16', 5, 'opentable', 'Dana Kimura', 'Mary Ann at the host stand found us a table on a packed Friday. Manny then took fantastic care of us.'],
  ['2026-02-15', '2026-02-14', 5, 'yelp', 'Rae L.', 'Valentine’s dinner was magic. Flor made us feel like regulars. The chocolate tart!'],
  ['2026-03-08', '2026-03-07', 4, 'opentable', 'Theo Marchetti', 'Solid brunch. Karen’s bloody mary is a must.'],
  ['2026-04-11', '2026-04-10', 5, 'google', 'Nadia F.', 'Celebrated a promotion. Hans and the events crew set up the Library beautifully.'],
  // Summer 2026 (the demo's season)
  ['2026-05-23', '2026-05-22', 5, 'opentable', 'Ivy Stanhope', 'Memorial Day kickoff. Manny remembered us from last year! Best dinner ever.'],
  ['2026-06-20', '2026-06-19', 5, 'opentable', 'Rafael Ortega', 'Nos atendió Flor y todo estuvo perfecto. ¡Volveremos pronto!'],
  ['2026-07-04', '2026-07-03', 5, 'yelp', 'Becca N.', 'Rooftop drinks then dinner. Dante and Romina at the Moon Rabbit bar were so much fun.'],
  ['2026-07-19', '2026-07-18', 5, 'opentable', 'Caleb Whitford', 'Tori was amazing, knew every wine on the list and paired our dinner perfectly.'],
  ['2026-08-08', '2026-08-07', 4, 'opentable', 'Mina Albright', 'Really nice evening. Andrea was great, the room was warm.'],
  ['2026-08-23', '2026-08-22', 5, 'opentable', 'Jonah Esposito', 'Alex made our tenth anniversary unforgettable. Thank you Alex!'],
  ['2026-08-30', '2026-08-29', 5, 'opentable', 'Sofia Lindqvist', 'Birthday dinner for my mom. Alex was so kind to her. Best night Ever!'],
  ['2026-09-05', '2026-09-04', 2, 'google', 'P. Grant', 'Waited 40 minutes past our reservation. Liz at the door was apologetic but it was a long wait.'],
  ['2026-09-12', '2026-09-11', 5, 'opentable', 'Wesley Huang', 'The best birthday dinner ever. Ever was our server and she was a delight from start to finish.'],
  ['2026-09-19', '2026-09-18', 5, 'google', 'Clara D.', 'Thanks to Styves and Jonathan for an amazing Friday. Book the Library for groups!'],
];
// Relative to the demo's "today": the weeks just before it ([days before today, stars, source, reviewer, text]).
const RECENT = [
  [3, 5, 'opentable', 'Hannah Pryce', 'Our server Alex D. was fantastic and the short rib melted. We will come back for brunch.'],
  [9, 5, 'opentable', 'Luis Carmona', 'Manny and Miguel kept the water and the jokes coming. 10/10.'],
  [15, 4, 'yelp', 'Kit M.', 'Fun bar. Karen made me a custom cocktail. A little crowded.'],
  [22, 5, 'opentable', 'Eleanor Voss', 'Mary Ann and Liz at the front were so welcoming. Andrea took wonderful care of our table.'],
  [30, 5, 'google', 'Ben T.', 'Chef Lucas came out to say hi. The rosé was crisp and the halibut was perfect.'],
  [41, 3, 'opentable', 'Gwen Rossi', 'Food fine, service slow. Victor tried his best.'],
];
// Special requests on past reservations: [date, time, size, notes, requestedServer].
const REQUESTS = [
  ['2025-07-11', '19:00', 4, 'Request Manny please. Anniversary.', ''],
  ['2025-08-15', '19:30', 2, 'Regulars, sit in Flor’s section', ''],
  ['2025-12-12', '20:00', 6, 'Holiday party. Ask for Alex D.', ''],
  ['2026-01-23', '18:30', 2, '', 'Manny'],
  ['2026-02-14', '19:00', 2, 'Valentine’s. Piden a Flor de mesera.', ''],
  ['2026-03-20', '19:15', 4, 'Birthday — high chair needed', ''],
  ['2026-06-12', '19:00', 3, 'Would like Karen at the bar again', ''],
  ['2026-07-10', '20:00', 2, 'Request Alex', ''],
  ['2026-08-14', '19:30', 5, 'Sit us in Manny’s section please. Gluten free x1', ''],
  ['2026-09-04', '18:45', 4, 'REQ: ANDREA', ''],
  ['2026-09-18', '19:00', 2, 'Celebrating Sarah’s birthday. Booth if possible', ''],
];
// Kudos a manager added: [date, person, source, stars, text].
const KUDOS = [
  ['2025-08-09', 'Liz', 'inPerson', null, 'A guest stopped by the host stand to say Liz made their mom’s night.'],
  ['2026-01-30', 'Hans', 'card', null, 'Thank-you card from the Larkspur group: “the setup was flawless”.'],
  ['2026-05-30', 'Dante', 'tripadvisor', 5, 'Dante is a master behind the bar. Ask him for something off menu.'],
  ['2026-07-25', 'Mary Ann', 'google', 5, 'Mary Ann at the door squeezed us in and remembered our names.'],
  ['2026-08-28', 'Alex D', 'yelp', 5, 'Alex D. is the reason we keep coming back.'],
];

export function seedImpactDemo(store, { userId, now = new Date() }) {
  const rand = mulberry(7);
  const clockDay = todayStr(now);
  const svc = createService(store, { now: () => now });
  const at = now.toISOString();

  // The doorman goes by "Alex" too: a manager added it, so "Alex" alone is ambiguous between two people.
  store.update('users', userId.Alessandro, { aka: ['Alex'] });
  // Who worked two past Saturdays (the worked-that-day check): on Aug 22 only Alex D, on Aug 29 both.
  const shift = (date, name, jobCodeId, area, start) => store.insert('shifts', { id: uid('shf'), date, start, end: null, jobCodeId, userId: userId[name], area, tag: '', notes: '', breakMin: 0, eventId: null, staffingLineId: null, published: true, createdAt: at });
  for (const [date, names] of [['2026-08-22', ['Alex D', 'Styves', 'Tori']], ['2026-08-29', ['Alex D', 'Styves', 'Alessandro']]]) {
    for (const n of names) shift(date, n, n === 'Alessandro' ? 'job_door' : 'job_srv', n === 'Alessandro' ? 'Back Host Stand' : 'Restaurant', n === 'Alessandro' ? '18:00' : '16:00');
  }

  // Reservations: the weeks before the demo week, as seated (for no-shows and walk-ins), and upcoming bookings.
  const items = [];
  const party = () => [2, 2, 2, 3, 4, 4, 2, 5, 6, 2, 3, 8][Math.floor(rand() * 12)];
  const times = ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'];
  const book = (date, covers, { status = 'done', noShow = 0.05, notes = () => '' } = {}) => {
    let n = 0;
    while (n < covers) {
      const size = party();
      const st = status === 'done' && rand() < noShow ? 'noShow' : status === 'booked' && rand() < 0.03 ? 'cancelled' : status;
      items.push({ key: `c_demo${hashKey(`${date}|${items.length}`)}`, externalId: `DEMO${items.length}`, date, time: times[Math.floor(rand() * times.length)], partySize: size, status: st, notes: notes(), requestedServer: '', guest: '' });
      n += size;
    }
  };
  for (const date of range(addDays(WEEK, -56), 56)) {
    const s = store.get('sales', date);
    if (s?.covers) book(date, Math.round(s.covers * (0.45 + rand() * 0.15)));
  }
  const upcoming = new Set([...range(WEEK, 14), ...range(clockDay, 14)].filter((d) => d >= clockDay || d >= WEEK));
  const busy = { 5: 1.3, 6: 1.6, 4: 0.85, 0: 0.7, 3: 0.55, 2: 0.45 }; // Saturdays book up early; closed Mondays
  const notesFor = (date) => () => { const r = rand(); return r < 0.02 ? 'Request Alex D' : r < 0.035 ? 'Sit us in Manny’s section' : r < 0.07 ? 'Birthday, candle on dessert' : ''; };
  for (const date of [...upcoming].sort()) {
    const f = busy[dow(date)];
    if (!f) continue;
    const from = date >= clockDay && clockDay > WEEK ? clockDay : addDays(WEEK, -1); // days out from the demo's "today" (or the real one, later)
    const daysOut = Math.max(0, (Date.parse(date) - Date.parse(from)) / 86400000);
    const base = { 5: 175, 6: 280, 4: 125, 0: 90, 3: 120, 2: 140 }[dow(date)];
    book(date, Math.round(base * 0.55 * f * Math.max(0.35, 1 - daysOut / 20)), { status: 'booked', notes: notesFor(date) });
  }
  for (const [date, time, size, notes, requestedServer] of REQUESTS) {
    items.push({ key: `c_demoreq${hashKey(date + time)}`, externalId: `DEMOREQ${hashKey(date + time)}`, date, time, partySize: size, status: 'done', notes, requestedServer, guest: '' });
  }
  const ot = svc.opentable;
  for (let i = 0; i < items.length; i += 1000) ot.applyReservations(items.slice(i, i + 1000), { origin: 'csv', importId: 'imp_demo_res' });

  // Reviews, through the same path as a file: OpenTable's through applyReviews, Google's and Yelp's as theirs.
  const reviewItems = [
    ...REVIEWS.map(([date, diningDate, rating, source, reviewer, text]) => ({ date, diningDate, rating, source, reviewer, text })),
    ...RECENT.map(([ago, rating, source, reviewer, text]) => ({ date: addDays(clockDay, -ago), diningDate: addDays(clockDay, -ago - 1), rating, source, reviewer, text })),
  ].map((r) => ({ ...r, key: `i_demo${hashKey(`${r.date}|${r.text}`)}`, externalId: '', food: null, service: null, ambience: null, value: null, server: '' }));
  ot.applyReviews(reviewItems.filter((r) => r.source === 'opentable'), { origin: 'csv', importId: 'imp_demo_rev' });
  for (const source of ['google', 'yelp']) svc.impact.applyReviews(reviewItems.filter((r) => r.source === source), { origin: 'csv', importId: `imp_demo_${source}` });

  for (const [date, name, source, stars, text] of KUDOS) {
    store.insert('kudos', { id: uid('kud'), userId: userId[name], source, stars, date, text, guest: '', createdBy: userId.Kelly, createdAt: `${date}T22:00:00.000Z` });
  }
  const rec = (id, kind, fileName, from, to, n) => ({ id, at, by: userId.Kelly, kind, fileName, counts: { new: n, updated: 0, same: 0, duplicate: 0 }, from, to });
  store.insert('integrations', { id: 'opentable', imports: [rec('imp_demo_rev', 'reviews', 'opentable-reviews-demo.csv', REVIEWS[0][0], clockDay, reviewItems.filter((r) => r.source === 'opentable').length),
    rec('imp_demo_res', 'reservations', 'opentable-reservations-demo.csv', addDays(WEEK, -56), addDays(clockDay > WEEK ? clockDay : WEEK, 13), items.length)] });
  return { reservations: items.length, reviews: reviewItems.length };
}
