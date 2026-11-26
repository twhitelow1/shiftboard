// SAMPLE Google and Yelp data for the in-browser demo only (web/src/api.js): the demo's Google reviews look
// synced from Google (so "Post to Google" shows, saved in the demo only), two of them already answered, and
// three invented Yelp excerpts from "today". Not part of core/seed.js, so the hosted app's demo data and the
// role-parity fingerprint stay as they were. Every guest and word here is invented; the staff are the demo's own.
import { refOf } from './yelp-reviews.js';
import { addDays, todayStr } from './time.js';

const EXCERPTS = [
  [1, 5, 'Mira P.', 'Karen made me the best old fashioned I have had in years and Dante kept the playlist going. We sat at the bar all night and...'],
  [2, 2, 'Theo R.', 'Our table was ready 30 minutes late and nobody told us why. Food was good once it came but the wait soured the...'],
  [4, 4, 'Ana L.', 'Flor was so sweet with our kids and the short rib was perfect. Only wish the patio heaters were on, it got...'],
];
const REPLIES = [
  'Thank you for celebrating with us, and for the kind words about the team. We hope to see you again soon!',
  'Thanks so much for coming in. We’re glad the night was a hit and we’ll pass your note along to the crew.',
];

export function seedReviewsDemo(store, { now = new Date() } = {}) {
  const today = todayStr(now);
  const sign = `\n— The team at ${store.get('settings', 'settings')?.restaurantName || 'our restaurant'}`;
  const google = store.list('guestReviews', (r) => r.source === 'google').sort((a, b) => a.date.localeCompare(b.date));
  google.forEach((r, i) => {
    const answered = i < REPLIES.length;
    store.update('guestReviews', r.id, {
      google: { name: `accounts/demo/locations/demo/reviews/${r.id}`, reviewId: r.id, replyState: answered ? 'APPROVED' : null },
      ...(answered ? { replied: true, reply: `${REPLIES[i]}${sign}`, repliedAt: `${r.date}T18:00:00.000Z`, replySource: 'google' } : {}),
    });
  });
  for (const [days, rating, reviewer, text] of EXCERPTS) {
    const ref = refOf(`demo-${days}`);
    if (!store.get('yelpExcerpts', `yx_${ref}`)) store.insert('yelpExcerpts', { id: `yx_${ref}`, ref, rating, text, url: 'https://www.yelp.com/', date: addDays(today, -days), reviewer, fetchedAt: now.toISOString() });
  }
}
