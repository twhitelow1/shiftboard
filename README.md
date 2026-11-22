# ShiftBoard

Restaurant scheduling built for how a busy restaurant and event venue actually runs. It replaces the weekly Excel schedule and does the job of 7shifts without the per-location fee.

Built by DubLow Digital.

## What it does

| | |
|---|---|
| **Sheet view** | The week drawn just like the house schedule PDF: colored area banners (colors read from the PDF on import, editable in Settings), a header row per section with the day names, names in capitals, yellow **OFF** cells, the dates, day notes (CLOSED, MEETING…) and events with guest counts, Projected Covers, and a Notes line. Names keep the sheet's order and labels. Managers click any cell to add or edit a shift. **Print** gives one portrait page like the PDF. On phones it scrolls sideways with names pinned. |
| **Weekly schedule** | Also as a grid grouped like the house Excel sheet: an **area** banner (Restaurant, Rabbit Hole, Moon Rabbit, Back Host Stand…), then each **position** worked there, or grouped by employee. A position and an area are separate: one Bartender can work the Restaurant bar one night and the Moon Rabbit the next. Supports "until close" shifts (`4p–CL`), section tags (LIB, RH, BC, PASSED…), the sheet's row order, draft vs. published, copy this week forward to build the next one, print, and CSV export. |
| **Mobile first** | Phones get a day-by-day view with a bottom nav. Staff can check their schedule and the whole team's schedule, and trade shifts, from their phone. |
| **Rooms & positions** | Settings → Rooms & positions (managers and up) sets up the schedule: its **rooms** (the colored banners: Restaurant, Rabbit Hole, Moon Rabbit…) in order, each with its banner color and the **positions** worked there, in order, with an optional name on the sheet ("Bar"). Add, rename (it carries through to shifts, people, colors and tip pools), reorder and remove rooms; add a position (or make a new one), reorder, **hide** it (it never shows on the schedule or when scheduling; one tap shows it again) or remove it, moving its people and shifts to another position or keeping them. Tapping a banner on the schedule opens the same editor for that room. If shifts land in a hidden or unlisted section, managers see one notice to move them or show the section. In Team, each person's **positions** list the rooms they work them in and the pay rate; the shift editor picks the room, then that room's positions, then the person (people who work it there first; "Show everyone" gives someone else the position). Imports and BEO shifts add new room/position pairs at the end of their room. Until a manager changes anything, the layout is the one the schedule always showed. |
| **Multiple job codes** | Each employee can hold any number of job codes, each with its own pay rate. Server + Banquet Captain, Food Runner + Barback, etc. |
| **Calendar** | Month view for your own shifts or the whole team, plus a day timeline with bars by position. |
| **Swaps & trades** | *Give away* a shift (everyone trained for it is notified), *trade* for a specific coworker's shift, or *pick up* an open shift. Coworker accepts, then a manager approves. Conflicts are checked automatically: double booking, time off, availability, training, overtime. Approval can be turned off in Settings. |
| **Time off & availability** | Requests go to managers for approval. Approved time off shows as **REQUEST OFF** on the grid, and any shift that conflicts with it is flagged. |
| **Forecasting & labor** | Forecasts covers and sales from your daily history (weighted same-weekday average with a trend), adds event guests from BEOs, and shows labor $ and labor % against your target. Labor rules like "1 server per 22 dinner covers" produce a scheduled-vs-recommended staffing grid. A one-click button fills the gaps with open shifts. |
| **Events & BEOs** | A full Banquet Event Order: guests, room, service style, banquet captain, menu, dietary notes, beverage package, **special drinks** with recipes, timeline, setup, and **staffing needs** (how many servers, runners, bartenders, BCs). The app suggests staffing from guest count using standard banquet ratios, turns staffing lines into open shifts staff can claim, tracks fill status (e.g. 13/14), and includes a team comment thread. Staff on an event are notified whenever the BEO changes. Events booked in **Tripleseat** come in by themselves (see below). |
| **Import BEOs (PDF)** | Upload a PDF that holds several BEOs back to back (Tripleseat's BEO export). Each one becomes an event: name, date, times, guests, room (matched to the venue's rooms), service style, menu with courses, quantities and dietary marks, special drinks with recipes, the timeline, dietary, arrival, setup and A/V notes, special instructions, and the client's contact details (managers and the events team only). A preview shows what's new and what updates an event already there before anything is saved. Re-importing a newer PDF updates the same events (by invoice number, else name and date) and keeps the staffing, captain, comments and shifts set in ShiftBoard. Prices, deposits and payment details are never imported. Afterwards, events with no staffing can get suggested staffing lines. |
| **Import your schedule** | Upload the PDF of your weekly schedule, or paste it straight from Excel. Banners (RESTAURANT, RABBIT HOLE…) become areas and section labels (Servers, Bar…) become positions; a section with no label gets its position from the same people's other sections. Names, the dates, and cells like `4PM`, `3:30PM BC`, `1-9PM*`, and `REQUEST OFF` are read automatically. Re-importing a week updates the shifts already there instead of doubling them, and **Merge** (on a job code) folds duplicate job codes together. Event notes with a guest count (`CHANG/SMITH WEDDING RECEPTION FULL BUYOUT 160PPL`) become events, and projected covers feed the forecast. People and job codes that don't exist yet can be created during the import, so a new restaurant can be set up from one PDF. CSV works too. |
| **Calendar sync** | Each employee gets a private iCal link for Google or Apple Calendar. |
| **Tip pooling** | Settings → Tip pool sets up one or more pools: an area (e.g. a separate Rabbit Hole pool), per day or per week, the positions that share it with their points (Server 1.0, Busser 0.5…), and how it's split: hours × points (default), points per shift, or equal. Pools can take all tips, card tips only, or a tip-out like 3% of server sales, and leave out managers (FLSA) by default. A live example shows the formula in words. Managers enter each day's card and cash tips (or use Toast's), add adjustments with a note, export CSV and finalize the week, which locks it and tells each person their share; only an admin can unlock it. Hours come from Toast punches when they're there, otherwise the schedule. Staff see only their own share and how it was worked out. Money is whole cents and the shares always add up to the pool. |
| **Notifications** | In-app notifications for schedule posted, shift changes, swap requests and approvals, open shifts, BEO updates, and comments. |
| **Branding & theme** | Settings → Branding & theme: upload the restaurant's logo (resized in the browser; PNG, JPG, SVG or WebP), pick a ready-made theme (Berry, Ocean, Forest, Sunset, Rose, Gold, Mono, Bright…) or set the brand, sidebar and background colors yourself, with a live preview and a "use logo color" shortcut, and choose light, dark or auto mode for everyone (each person can pick their own in My Shifts). The logo and colors show in the app, on phones, on the sign-in page, in the browser tab and at the top of emails. |
| **English and Spanish** | The web app, the phone app, notifications, emails, texts and error messages in English or Spanish (neutral Latin American, "tú"). Anyone can switch on any screen with the globe button at the top right (also on the sign-in page); signed in, the choice is saved on their account and My Shifts has it too. People who haven't picked follow the restaurant's default (Settings → Language: Auto, English or Español), else their phone or browser. Each notification, email and text goes out in its recipient's language. Restaurant data (names, positions, areas, notes) stays as entered. Words: `web/src/i18n/`, `core/messages.js`, `core/errors.js`; agreed terms in [docs/i18n/GLOSSARY.md](docs/i18n/GLOSSARY.md). |
| **People & sign-in** | Team & Job Codes shows everyone's role and sign-in status (Active, Invited, Not invited, No email). Send an invite link to one person or to everyone who hasn't signed in, email a password reset link, or set a temporary password for someone without email. |
| **Training** | A menu study guide: photos (several per dish, swipe on phones), description, allergens (the 9 major ones plus your own), dietary tags and an 86'd flag. Selling notes go to everyone; recipes and prep notes go to the kitchen and bar by default (managers always see everything, and each item can change who sees what). Search, "without nuts" allergen filters, and study flashcards. **Quizzes** are written from the menu for you (which dish is this photo, allergens, what's in it, which section) plus your own questions, assigned to positions with a due date, and graded on the server. A **leaderboard** (best, average, quizzes passed, items mastered; staff can see it or managers only) with each person's weak spots. The **employee manual** with "I've read this" and re-reads after an edit, including the call-out procedure. The **manager on duty** card (Call and Text buttons) on Training, My Shifts and your own upcoming shifts: it's the one coworker phone number staff can see. Managers can add a Spanish version of everything they write. |
| **86 List** | Staff report what's 86'd (out) or running low from their phones in a couple of taps: pick the list, search the Training menu (drinks for the Bar, food for the Kitchen) or type anything, add a count ("3 left"), a note ("use the other bourbon") or up to 3 photos (the empty bottle, the shelf; shrunk on the phone, kept in Postgres only and served to people who can see the list, deleted 30 days after the item comes off), and tap **86'd** or **Running low**. The Bar has its own list, shown apart from the rest, and admins can rename lists or add more in Settings (one per bar area, tagged with the schedule's areas), each with who can report and clear (Bar: the bar department; Kitchen: the kitchen and front of house; managers always) and who can see it (everyone by default). One tap marks something back in stock, with undo. Marking something 86'd tells the people working today who can see that list, in their language (never the reporter). An optional nightly reset clears a list at a set time. A banner on the Schedule's day view and My Shifts says what's out, Training's study guide shows an "86'd today" badge, and managers get the history and what was 86'd most in the last 30 days, for ordering. Also in the phone app. |
| **Venue & floor plans** | Locations (for multi-location groups; a one-room place needs no setup), levels, and rooms marked as dining, bar or event space with capacity. Draw each room's floor plan: round, square and long tables with seats, booths, bars with stools, stages, dance floors, DJ booth, host stand, walls, doors and labels. The editor works on phones: pinch to zoom, two fingers to pan, tap to select, long-press or **Select** to pick several, drag to move them together, undo and redo. **Sections**: for any day, managers tap tables on a room's plan and pick who of the people working gets them (or set the room and tables in the shift editor); each section shows in that person's color with their name, and **Copy last** repeats the same day of last week. Staff see their room and tables on My Shifts and on their shift, highlighted on the plan. An event picks its room from the venue's rooms (or Full Buyout), and its BEO shows the plan with the event staff's sections. |

### Roles
Each role can do everything the roles below it can.
- **Super Admin**: the account owner. Everything, including managing other admins. There is always at least one.
- **Admin**: settings, approval rules, and everyone except Super Admins.
- **Manager**: builds and publishes schedules, approves requests, runs forecasting and events, adds and edits Supervisors and Employees, manages job codes and the schedule's rooms and positions (Settings → Rooms & positions; the rest of Settings is for admins).
- **Supervisor**: a shift lead. Approves trades, pickups and time off (never their own; can be switched off in Settings) and sees coworkers' phone and email. Can't edit the schedule.
- **Employee**: sees their own shifts and the full published schedule, trades and picks up shifts, requests time off, and reads BEOs.

**Events & BEOs access** is a separate switch on each person (Managers and up always have it), so an events coordinator can be a Supervisor or Employee. Each job code has a **default role**, used when people are added from an imported schedule, so roles come from your data rather than code.

Employees never see drafts, coworkers' contact info or pay rates, or client contact details on BEOs.

## Run it locally

```bash
npm install
npm run build
SEED_DEMO=true npm start      # http://localhost:3000 — sign in as moe@demo.shiftboard / demo1234
```

No database setup needed: without `DATABASE_URL`, the app uses an embedded Postgres (PGlite) stored in `./data/pglite`. To develop against Supabase or another real Postgres instead, set `DATABASE_URL`.

For development with hot reload: `npm run dev:demo` (the API runs on :3000, and Vite prints its own URL).

Start without the demo data: `ADMIN_EMAIL=you@restaurant.com ADMIN_PASSWORD=choose-one npm start`. This creates the first admin account. Everything else is set up from the app: add job codes, add employees, then import or build the first week.

Tests: `npm test` (uses the embedded database). To run them against a real Postgres, point `TEST_DATABASE_URL` at a throwaway database; the tests drop and recreate its `shiftboard` schema.

## Deploy to Vercel + Supabase

The web app is static (served from Vercel's CDN) and the API runs as one Vercel Function (`api/index.js`). Data lives in Postgres. Supabase is the default; Neon or any Postgres 13+ works the same way.

1. **Import the repo in Vercel** (Add New → Project → `shiftboard`). The settings come from `vercel.json`; leave them as they are.
2. **Add the database**: in the project, open **Storage → Connect Database → Supabase**, create a database in **East US (North Virginia)** (the same region as the function, `iad1` in `vercel.json`), and connect it to all environments. This sets `POSTGRES_URL` for you.
3. **Add environment variables** (Settings → Environment Variables):
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (and optionally `ADMIN_NAME`): the first admin account
   - `TIMEZONE`: the restaurant's time zone, e.g. `America/Denver`
   - `JWT_SECRET` (optional): a long random string (`openssl rand -hex 48`). If you skip it, the app generates one and stores it in the database.
4. **Deploy** (or redeploy, so the new variables apply). The first request creates the tables in a `shiftboard` schema and the admin account. Then sign in.

The tables have row-level security turned on with no policies, so Supabase's public REST API (the `anon` key) can't read them. The app connects as the database owner.

### Email (Resend)

Email is optional. Without it, everything still works in the app. With it:
- staff get an email copy of their notifications (new schedule, shift changes, trades, time off, event updates). The restaurant can turn this off in Settings, and each person can turn it off in My Shifts.
- new people added with an email get a link to set their password.
- anyone can reset a forgotten password from the sign-in page (a one-time link that expires after 1 hour).

Setup:
1. In Resend, verify the domain you'll send from (e.g. `mail.yourrestaurant.com`), and create an API key with **sending access** for that domain.
2. In Vercel, add `RESEND_API_KEY` (mark it **Sensitive**) and `EMAIL_FROM`, e.g. `Chasing Rabbits Schedule <schedule@mail.yourrestaurant.com>`. Optionally add `EMAIL_REPLY_TO` (where replies go) and `APP_URL` (the link in emails, e.g. `https://schedule.yourrestaurant.com`).
3. Redeploy, then use **Settings → Email → Send me a test email**. If something is wrong, the error from Resend is shown there.

Emails are sent after the change is saved, so a failed request never emails anyone. Batches go through Resend's batch API with idempotency keys.

### Phone notifications and text messages

Both are optional and work like email: each new in-app notification is also sent as a phone notification and/or a text, after the change is saved. A failed or slow send never fails or slows anyone's request; it's logged and skipped. Each person turns them on for themselves in **My Shifts**. Code: `server/channels.js` (sending after the commit), `server/push.js`, `server/sms.js`, `core/notify-prefs.js` (the rules and RPCs), `web/public/sw.js` (the service worker).

**Phone notifications (Web Push)** work on Android (Chrome) and on iPhone (iOS 16.4+) once the app is added to the Home Screen (Share → Add to Home Screen, then open it from there). My Shifts explains this on an iPhone.
1. Run `npm run vapid-keys` (or `node scripts/vapid-keys.js`) once. It prints a key pair.
2. In Vercel, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (mark it **Sensitive**) and `VAPID_SUBJECT` (`mailto:` one of your addresses, or your site's `https://` URL). Redeploy.
3. Keep the same keys afterwards: new keys mean everyone has to turn notifications on again.

Phones the push service reports as gone are removed automatically. Signing out stops notifications on that phone.

**Text messages (Twilio)** are off for everyone until each person turns them on with their own mobile number (managers can't do it for them). Admins have a restaurant-wide switch and a **Send me a test text** button in Settings.
1. Create a Twilio account and buy a phone number (or a toll-free number).
2. **Register for A2P 10DLC** (Twilio Console → Messaging → Regulatory Compliance): a brand, then a campaign for staff notifications, and add the number to the campaign's Messaging Service. US carriers block or filter business texts from unregistered 10-digit numbers. A toll-free number needs toll-free verification instead. Approval can take days to a few weeks. Describe opt-in as "employees turn on texts in the app's My Shifts page with their own mobile number".
3. In Vercel, add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (**Sensitive**), and `TWILIO_MESSAGING_SERVICE_SID` (recommended) or `TWILIO_FROM_NUMBER` (e.g. `+17205550100`). Redeploy, then use **Settings → Texts & phone notifications → Send me a test text**; Twilio's error, if any, is shown there.
4. For STOP/START replies, set the number's (or Messaging Service's) incoming message webhook to `POST https://<your app>/api/twilio/inbound`. It checks Twilio's signature with the auth token. STOP turns that person's texts off in the app and START turns them back on; Twilio itself sends the replies and won't deliver to anyone who replied STOP. If the app sits behind a different public URL than `APP_URL`, set `TWILIO_WEBHOOK_URL` to the exact URL configured in Twilio.

Numbers are stored in E.164; numbers typed without a country code are taken as US/Canada (+1). Texts are kept short (one 160-character segment when possible) and end with the app link (`APP_URL`).

### Toast POS (optional)

Pulls each day's net sales and covers from Toast into the sales history the forecast uses, and Toast clock-ins (time entries) for **Forecast & Labor → Labor review**: scheduled vs. worked hours and cost by day, person and position, labor % of actual sales, overtime, and who worked without a shift or missed one.

1. In Toast Web, someone with the Manage Integrations permission creates **Standard API** credentials for the location (read-only; needs Restaurant Management Suite Essentials or higher) with the scopes `orders:read`, `labor:read`, `labor.employees:read` and `restaurants:read`.
2. In Vercel, add `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` (Sensitive), `TOAST_RESTAURANT_GUID`, and `TOAST_API_HOST` only if Toast gives a host other than `https://ws-api.toasttab.com`. Add `CRON_SECRET` (a long random string) for the daily sync. Redeploy.
3. **Settings → Integrations → Toast**: Sync now (the last 14 days by default), then check how Toast's employees and jobs were matched to people (by email, then name) and positions, and fix the rest.

A Vercel Cron (`vercel.json`) calls `/api/cron/toast` every morning and syncs the last 3 days. Syncs run a day at a time within the 30-second limit and can be repeated safely. Days typed in by hand under Sales history are kept unless you choose to replace them. Credentials live only in env vars; the code is in `server/toast*.js`, `core/toast.js`, `core/labor.js` and `core/labor-api.js`.

### ADP (optional): actual worked hours

ADP is the restaurant's real time clock, so worked hours come from it: Labor review, the tip pool's hours, and **Forecast & Labor → From your actual hours** (staffing suggested from what each position really took per cover over the last 4–8 weeks, over- and under-scheduling by weekday, overtime risk; the forecast itself doesn't change). Toast stays the source of sales, covers and tips. Research, both access paths, the certificate steps and what to ask the ADP rep: [docs/integrations/ADP.md](docs/integrations/ADP.md).

- **Any ADP product, today:** export a timecard report as CSV from RUN, Workforce Now, ezLaborManager or Workforce Manager, then **Labor review → Import ADP hours**. Columns are detected (and remembered), people and departments matched, and a preview flags what needs a look. Re-importing the same file or week never doubles anything. Works in the demo too.
- **API sync (Workforce Now with API Central, or a Marketplace partner app):** add `ADP_CLIENT_ID`, `ADP_CLIENT_SECRET` (Sensitive), `ADP_CERT_PEM` and `ADP_KEY_PEM` (Sensitive; the client certificate ADP signs from your CSR and its key, as PEM text or base64), optionally `ADP_API_HOST`, `ADP_TOKEN_URL` and `ADP_MANAGER_AOID`, and `CRON_SECRET`. Then **Settings → Integrations → ADP → Sync now**; `/api/cron/adp` syncs the last 3 days every morning.
- **Clock-in source** (Settings → Integrations → ADP): Automatic (ADP once there's ADP data), ADP, Toast, or both with ADP winning per person per day. One shift is never counted twice. Code: `server/adp*.js`, `core/adp*.js`, `core/clock.js`, `core/calibrate.js`.

### Tripleseat (optional): events from your sales software

Events booked in Tripleseat come into **Events & BEOs** by themselves: date, times, guests, room, status, event type, menu and drinks. Staffing lines, open shifts, floor-plan sections and the schedule's event notes then follow the real bookings. Tripleseat owns the booking fields (a change made in ShiftBoard is replaced at the next sync, and the BEO says "From Tripleseat: edit it there"); staffing, who works it, the captain, comments, sections and notes stay ShiftBoard's. Definite events come in confirmed, Tentative ones as tentative (managers and the events team only); Prospect, Closed and Lost follow rules an admin sets. An event with people scheduled is never deleted by a sync: it's marked cancelled and flagged. Staff on an event hear when its date, time, guests or room change. Client contacts and money are never read. Research, statuses, field ownership, the webhook and what to ask Tripleseat: [docs/integrations/TRIPLESEAT.md](docs/integrations/TRIPLESEAT.md).

1. In Tripleseat, an account admin creates an **OAuth 2.0 application** under Settings → API (read access). Tripleseat turned off its old OAuth 1.0 keys on July 1, 2026.
2. Paste its client ID and secret (and the location ID if the account has several venues) in **Settings → Integrations → Tripleseat**. On a single-restaurant install, add `TRIPLESEAT_CLIENT_ID`, `TRIPLESEAT_CLIENT_SECRET` (Sensitive), optionally `TRIPLESEAT_LOCATION_ID`, and `CRON_SECRET` in Vercel instead.
3. **Sync now**, match the rooms, check the status rules. `/api/cron/tripleseat` syncs every morning (a week back through 120 days ahead). Optionally add the webhook link shown there in Tripleseat for instant updates. Code: `server/tripleseat*.js`, `core/tripleseat.js`.

### Settings → Integrations

On the platform, each restaurant's admins connect their own integrations in **Settings → Integrations**: ADP, Toast, Tripleseat, the text sender and the email From, with a panel each (status, the fields to paste credentials into, help on where to find them, Save, and Sync now or a test where there is one). Only the integrations in the restaurant's plan show. The text-message sending number and the email From address are DubLow's to set (in the console): texts go out under DubLow Digital's registered Twilio texting program, and a From address only works on a domain verified in DubLow's Resend account, so restaurant admins see those two but can't change them (they can change the From name and reply-to). Keys are stored encrypted and only ever shown as "set, ends in 1234"; every change goes in the platform's audit log. It's the same storage the DubLow console edits. Chasing Rabbits keeps its env vars as a fallback, and values saved in Settings take their place. A single-restaurant install shows what its env vars set, read-only. Code: `server/integrations-routes.js`, `server/platform/integrations.js`, `web/src/pages/IntegrationsSettings.jsx`.

### Moving data from the old SQLite version

If ShiftBoard has been running on Render or Docker with SQLite, copy its `shiftboard.db` file locally, then:

```bash
DATABASE_URL="<Supabase connection string>" npm run db:import-sqlite -- ./shiftboard.db
```

Set `JWT_SECRET` on Vercel to the old server's secret (its `JWT_SECRET`, or the contents of `DATA_DIR/.secret`) so employees' calendar links keep working.

### Self-hosting with Docker

```bash
docker build -t shiftboard .
docker run -d -p 3000:3000 -e DATABASE_URL=postgres://... \
  -e ADMIN_EMAIL=you@restaurant.com -e ADMIN_PASSWORD=change-me shiftboard
```
Put it behind HTTPS (Caddy, Cloudflare, or the platform's TLS). Session cookies are `Secure` when `NODE_ENV=production`.

### Environment variables

| Env var | Default | Notes |
|---|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | | Postgres connection string. Vercel's Supabase integration sets `POSTGRES_URL` (the pooled connection, which is what you want); Neon sets `DATABASE_URL`. Without either, local runs use the embedded database. |
| `TIMEZONE` | `America/Denver` | The restaurant's IANA time zone. Vercel runs in UTC and reserves `TZ`, so the app applies this itself. |
| `JWT_SECRET` | auto | Signs sessions and calendar links. If unset, one is generated and stored in the database. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | | First-run admin account (used only while there are no users) |
| `SEED_DEMO` | | `true` loads the demo restaurant on first run |
| `RESEND_API_KEY` | | Optional. Resend API key (sending access). Email is off without it |
| `EMAIL_FROM` | | Sender, e.g. `Chasing Rabbits Schedule <schedule@mail.yourrestaurant.com>`. The domain must be verified in Resend |
| `EMAIL_REPLY_TO` | | Optional reply-to address |
| `APP_URL` | production URL | Base URL for links in emails. Defaults to Vercel's production domain |
| `DATABASE_CA_CERT` | | Optional. Your provider's CA certificate (PEM) to verify the database's TLS certificate. Without it, the connection is encrypted per `sslmode=require` but the certificate isn't checked. |
| `PG_POOL_MAX` | 5 | Connections per running instance |
| `PORT` | 3000 | Standalone server only |

Back up with `pg_dump "$DATABASE_URL" -n shiftboard > backup.sql`, or use your database provider's backups.

## Phone app (iPhone and Android)

`mobile/` is the staff app, built with Expo (React Native), in English and Spanish. One app in the App Store and Google Play serves every restaurant: people enter their restaurant's ShiftBoard address once (or open an invite link) and sign in. It uses the same API with a bearer token, and gets push notifications through Expo. Every deployment serves draft `/privacy` and `/support` pages for the store listings. See [docs/mobile-app/](docs/mobile-app/README.md): the decision, the store registration runbook, the store listing and how to develop it.

## Architecture

```
core/       Business logic shared by server + demo (pure JS, no I/O)
  service.js   every API method, with its permission checks
  forecast.js  covers/sales forecast, labor math, "until close" estimates
  beo.js       banquet staffing ratios
  beo-import.js  BEOs from a PDF: splitting, reading, room matching, server-side cleaning, re-import merge
  tips.js      tip pools: the split (whole cents, leftover cents by rule), Toast or scheduled hours, week report, locking
  importer.js  schedule parser (pasted spreadsheet, CSV, or a PDF grid), area/position reading, name matching, events from notes
  areas.js     schedule areas (where a shift is worked), kept apart from positions (job codes)
  layout.js    Rooms & positions: the schedule's rooms and their positions, the sections built from them, the shift editor's lists
  roster.js    who is listed in each schedule section and in what order
  venue-links.js  rooms ↔ schedule: an event's room by id, and server sections (each shift's room and tables, per day)
  tripleseat.js  Tripleseat events → BEOs: status rules, who owns which field, rooms, staff notifications, cancellations
  pdfgrid.js   rebuilds the schedule grid from a PDF's positioned text (read in the browser with pdf.js)
  store.js     in-memory document store + a copy-on-write overlay used per request
  seed.js      demo data (the real week of 9/28/2026)
  eighty-six.js  the 86 List: lists (Bar, Kitchen…), who reports and sees each, items out or low, the nightly reset, history
  training.js  menu study guide, quizzes, leaderboard, employee manual, manager on duty (training-seed.js: its demo data)
server/     Express API (one RPC endpoint + auth) and iCal feed
  app.js       one restaurant's API: routes, sessions, login rate limiting, plan features
  db.js        Postgres persistence (see below), one schema per restaurant
  platform/    many restaurants on one deployment: host routing, the tenant registry, the console's API (docs/platform)
  billing.js   phase 2 (Stripe), documented only
  email.js     Resend email sender and email templates
  training-routes.js  menu and quiz photos, for signed-in people only
  eighty-six-routes.js  86 List photos, for people who can see the item's list (cookie or bearer token)
  index.js     standalone server (local, Docker)
api/        Vercel Function entry point (wraps server/platform/)
web/        React UI (Vite). DEMO=1 builds a self-contained single-file demo that runs core/ in the browser
  console/     the platform console for DubLow Digital (platform.html)
scripts/    one-off tools (SQLite → Postgres import)
test/       node:test suites for scheduling, swaps, forecast, events, importer, store, database and API
```

The API is `POST /api/rpc/<method>` with a JSON body. Every method enforces its own role check in `core/service.js`, so the web app, the demo, and any future mobile app or integration share one set of rules.

**How data is stored.** Each record (shift, user, event…) is a JSON document in one Postgres table, `shiftboard.docs` (each restaurant on the platform has its own schema with the same tables; see [docs/platform](docs/platform/README.md)), stamped with an ever-increasing sequence number. Each running instance keeps a cache and, before every request, pulls only the rows that changed since its last look (usually none: one indexed query). Writes run in a transaction that holds a single lock: the instance catches up, re-runs the operation on the latest data, and saves every change in one statement. That keeps check-then-act operations correct when Vercel runs several instances at once, for example two people grabbing the same open shift. The business logic stays synchronous and unchanged, and a failed request never leaves partial writes.
## Roadmap ideas
- POS integration (Toast / Square) to pull daily sales automatically
- Time clock and tip pooling
- Multi-location
