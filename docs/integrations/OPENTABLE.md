# OpenTable

What OpenTable offers, how ShiftBoard uses it, and what the owner has to do. Researched November 2026 with web
search and the pages this session could open. OpenTable's developer reference is only open to approved partners,
so anything about the API's exact paths, fields and limits is marked **unverified** below: ShiftBoard keeps all of
those guesses in one place (`server/opentable.js`, `DEFAULTS` and `PATHS`) so they can be corrected in minutes
once the real reference is in hand.

## Summary

| | |
|---|---|
| **Works today, no approval needed** | **Import mode**: export Reservations and Reviews from OpenTable as CSV and import them in Settings → Integrations → OpenTable (or Positive impact → Kudos for Google/Yelp files). |
| **Needs OpenTable's approval** | **API mode**: a partner application, a signed partner agreement, then the restaurant grants the partner access to its restaurant ID (RID). ShiftBoard then syncs every morning and on **Sync now**. |
| **Reviews by API** | Only through OpenTable's separate **Reviews API**, which a restaurant grants to an approved partner. No public reviews API. Import the reviews export until then. |
| **Webhooks** | Not publicly documented. Partners describe "real time" reservation updates, but the mechanism isn't public. ShiftBoard has no OpenTable webhook; the daily sync covers it. |
| **Plans** | `opentable` (Pro and Beta) for the integration; `impact` (Pro and Beta) for Positive impact. |

## OpenTable's APIs (research)

### Access: a partner program, not self-serve
- OpenTable publishes its partner API reference at [docs.opentable.com](https://docs.opentable.com/view/metadata/2sAXxTcWRy) (a Postman workspace) and runs a Partner Portal at [dev.opentable.com](https://dev.opentable.com). The public part of the docs lists the sandbox collections **Authorization**, **Directory API** and **Sync API (all tiers)**, and says production access needs an approved agreement and that "not all APIs are available to every partner type".
- The same page says an application "will undergo a comprehensive review by our partnerships team" and that partners must pass a review "to ensure compatibility" before production access.
- Third-party summaries ([Jentic](https://jentic.com/apis/opentable.com/opentable.md), [APIs.io](https://apis.io/providers/opentable/)) agree: OAuth 2.0, partner approval, a signed partner agreement, terms and rate limits set during contracting. OpenTable's own partner page ([opentable.com/restaurant-solutions/api-partners](https://www.opentable.com/restaurant-solutions/api-partners/)) answered 503 to this session and wasn't read.
- **How a restaurant grants a partner access** (from a partner's help article, [Marqii](https://help.marqii.com/articles/7997024306-connecting-your-opentable-reviews)): in OpenTable for Restaurants, open **Restaurant Integrations → API Partners**, search the partner, enter the partner's 6-character partner code, pick the **API offer** (e.g. "Reviews API"), and submit the access request for the restaurant's **RID**. The granted APIs then show under **Integrations Management → My Integrations**. Another partner (Peoplevine, per search results) says Sync API access is requested by email and takes several days. **Unverified** for ShiftBoard specifically: it depends on what OpenTable approves.
- Klaviyo's OpenTable integration says partner integrations need an OpenTable **Core or Pro** plan, not Basic ([Klaviyo: Getting started with OpenTable](https://help.klaviyo.com/hc/en-us/articles/23112971772699)). Likely the same for any API partner (**unverified**).

### Authentication
- OAuth 2.0; "an access token must be obtained and submitted with all requests"; HTTPS only (TLS 1.3 supported); `Accept: application/json`; a unique `X-Request-Id` on POST/PUT/PATCH for idempotent retries; partners should subscribe to the API status page (status-api.opentable.com) ([docs.opentable.com](https://docs.opentable.com/view/metadata/2sAXxTcWRy)).
- The token endpoint is listed as `/api/v2/oauth/token` ([Jentic](https://jentic.com/apis/opentable.com/opentable.md)). The host and grant type aren't public. ShiftBoard assumes the OAuth 2.0 **client credentials** grant with HTTP Basic auth at `https://oauth.opentable.com/api/v2/oauth/token` (**unverified**; settable per restaurant as `OPENTABLE_TOKEN_URL`).

### Sync API: reservations and guests
- OpenTable describes the Sync API as syncing third-party systems (CRMs, POS) with real-time reservations and guest info. The endpoint reference isn't public. A QA copy of a "Guest Center Sync API" guide exists (inventory-api-documentation.otqa.com) but its host is blocked from this session and it looks like a staging site.
- **What a reservation carries**, from a partner that receives it ([Klaviyo: OpenTable data reference](https://help.klaviyo.com/hc/en-us/articles/23113172847259)): ID, State (created, confirmed, completed, cancelled, no-show), CreatedDate, ScheduledTime, PartySize, TableNumber, TableCategory, VisitTags, Origin, **GuestRequest** (the guest's special request), **VenueNotes**, **OpenTableNotes**, **Server**, AddedToWaitlistTime, ArrivedTime, SeatedTime, DoneTime, POS check data when a POS is connected; guest profiles carry name, email, phone, birthday, notes. Klaviyo also says reservations sync "in real time" and pulled two years of history at setup.
- **No "requested server" field** is documented anywhere public. Guests ask in the special request ("request Sarah", "sit in Mike's section"); hosts note it in venue notes. ShiftBoard reads both, and also a `requested_server`-style field if OpenTable's export or API ever has one.
- ShiftBoard's guesses (**unverified**): `GET https://platform.opentable.com/sync/v2/reservations?rid=…&updated_after=…&offset=…&limit=…` answering `{ items, hasNextPage }` (other shapes are read too); field names in any of the spellings above.

### Reviews
- **No public reviews API.** OpenTable offers a **Reviews API** to approved partners, granted per restaurant ([Marqii](https://help.marqii.com/articles/7997024306-connecting-your-opentable-reviews)). Its fields aren't public. OpenTable's own reviews carry an overall rating and food, service, ambience, value and noise ratings, the text, the dining date and the diner's display name ([ReviewTrackers on GuestCenter](https://www.reviewtrackers.com/?p=3999), [SerpApi's OpenTable reviews output](https://serpapi.com/open-table-reviews-api)).
- Scrapers (SerpApi, Apify actors) pull public OpenTable reviews, but they sit outside OpenTable's terms as far as can be told, so ShiftBoard doesn't use them.
- One partner credits a review to "the server on that reservation" by linking the review to its reservation ([Reviewflowz](https://www.reviewflowz.com/for/opentable)); OpenTable's review data may carry the reservation's server. ShiftBoard keeps a review's server when a file or the API has it and uses it to settle which of two same-named people a review means.
- A diner reports OpenTable removing a review because it named the server ([blog post found by search](https://bbqboy.net/?p=2471)): a single anecdote, **unverified** as policy. If it's policy, fewer OpenTable reviews will name staff than Google or Yelp ones, and reservation requests and the review's server matter more.
- ShiftBoard's guess (**unverified**): `GET {host}/sync/v2/reviews?rid=…&updated_after=…`. A 403 or 404 there is treated as "no Reviews API grant": a warning, and the sync carries on.

### Webhooks and rate limits
- Rate limits "apply to all API requests and may vary by endpoint and use case"; the numbers come from your OpenTable representative ([docs.opentable.com](https://docs.opentable.com/view/metadata/2sAXxTcWRy)). ShiftBoard spaces requests, retries 429 after `Retry-After` and 5xx twice, and works in 18-second chunks.
- No public webhook documentation. ShiftBoard has no OpenTable webhook route; the morning cron (`/api/cron/opentable`, 11:30 UTC) and Sync now keep it current.

### What a restaurant can export by hand
- **Reservations**: Guest Center → **Reporting → Reservations**, pick the dates, then Export ([ResDiary's migration guide](https://resdiary.freshdesk.com/support/solutions/articles/4000098514-export-your-open-table-reservations); another version says **Reports → Reservations & Cancellations → Generate Report → Export**, with options to include guest notes). Older guides say OpenTable emails the download link for some reports (it expires after 48 hours).
- **Reviews**: GuestCenter has a **Reviews** section with filters by rating, date and comments, and scheduled review reports by email ([ReviewTrackers](https://www.reviewtrackers.com/?p=3999)); a user review says the newer system requires downloading the report each time ([G2](https://g2.com/products/opentable-for-restaurants/reviews)). Whether it's CSV or Excel isn't confirmed: save it as CSV if needed.
- **Column names aren't published.** ShiftBoard recognizes the usual ones (Visit Date, Time, Party Size / Covers, Status, Guest Name, Special Requests / Notes, Visit Notes, Server, Table, Conf #, Date Made…; for reviews Date Submitted, Dined On, Overall, Food, Service, Ambience, Value, Review / Comments, Diner Name), lets the manager pick any column by hand, and remembers the choice. The test fixtures in `test/fixtures/opentable-*.csv` are invented approximations.

### Google Business Profile, Yelp, TripAdvisor
- **Google Business Profile** reviews have an API: `accounts.locations.reviews.list` (`GET https://mybusiness.googleapis.com/v4/{parent=accounts/*/locations/*}/reviews`), for verified locations, with OAuth ([Google: reviews.list](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list), [working with review data](https://developers.google.com/my-business/content/review-data)). It needs Google's API access approval for the Business Profile APIs. A Google connector can come later: reviews are one model in ShiftBoard (`guestReviews`, any `source`), so a connector only has to fetch and call `applyReviews()`.
- Until then, **Positive impact → Kudos → Import Google or Yelp reviews** takes any CSV with a date, stars and text, and managers can add a single shout-out by hand.

## How ShiftBoard uses it

### Data kept (privacy)
- **Reservations** (`otReservations`): date, time, party size, status (booked, seated, done, cancelled, no-show), special requests and host notes, requested server and server if present, table and area, the date booked. The guest is kept only as a first name and last initial ("Dana K."), and only for managers' drill-down.
- **Reviews** (`guestReviews`, any source): stars (overall, food, service, ambience, value), posted date, dining date, text, the reviewer as "Dana K.", the server if given, `replied` and `reply` (for a later replies feature).
- **Never kept**: phone numbers and email addresses. Phone and email columns are recognized in the browser only so they can be left out (the column step says so); phone numbers and emails typed inside notes or reviews are replaced with `[phone]` / `[email]` before saving; the server cleans again, whatever it's sent. A test checks the stored data for both.
- **Idempotent**: a reservation is keyed by its confirmation number (`otr_c_<conf>`), else a one-way hash of date, time and guest name (the name itself isn't stored); a review by its id, else a hash of date, reviewer, text and stars, plus a fingerprint of date + text + stars so the same review arriving later from the API with an id lands on the same document. Re-importing a file, or syncing after an import, never double-counts.

### Forecast: booked covers
For each upcoming day with bookings (`core/opentable.js`, `bookingBlend`):

projected = booked covers × (1 − no-show rate) + usual walk-ins for that weekday

and the forecast takes it **when it's higher** than the forecast from sales history: bookings keep coming in until the day, so they're a floor, never a reason to forecast less. The no-show rate and walk-ins come from the last `forecastWeeks` weeks that have both reservations and actual covers (walk-ins = actual covers − covers seated from reservations); with no such history both are 0. A manager's override still wins. Forecast & Labor shows "142 booked on OpenTable + 40 usual walk-ins (history alone: 160)", and staff "projected covers" (the house sheet's row) follow, since they come from the same forecast.

### Positive impact
See the matching approach in `core/impact.js` (top comment) and the README. Reviews from every source and reservation requests go through the same matching.

## What the owner has to do

1. **Today (no approval needed)**: in OpenTable, export **Reservations** (Reporting → Reservations; include special requests / guest notes; the past few months and the coming weeks) and **Reviews** (Reviews → download/export the report), and import both in **Settings → Integrations → OpenTable**. Repeat weekly, or whenever: re-imports never double-count. For Google/Yelp, use Positive impact → Kudos → Import, or add shout-outs by hand.
2. **For automatic sync**: DubLow applies as an OpenTable API partner (Partner Portal at dev.opentable.com / opentable.com/restaurant-solutions/api-partners), asking for the **Sync API (reservations)** and the **Reviews API**, read-only. Ask OpenTable for: the token URL and grant type, the reservations and reviews endpoints, paging and "changed since" parameters, rate limits, whether there are webhooks, and the sandbox. Each restaurant then grants DubLow access to its RID (Restaurant Integrations → API Partners) and its admin pastes the client ID, secret and RID in Settings → Integrations → OpenTable. Then fix `server/opentable.js` (`DEFAULTS`, `PATHS`) and the field readers in `core/opentable.js` against the real reference, and run `test/opentable.test.js`.
3. Keep `CRON_SECRET` set in Vercel for the morning sync.
