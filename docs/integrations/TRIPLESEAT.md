# Tripleseat: events booked in Tripleseat flow into Events & BEOs

Tripleseat is the events and private-dining sales software many restaurants use (Chasing Rabbits does). With this integration, every event booked there shows up in ShiftBoard's **Events & BEOs** without retyping: the date, times, guest count, room, status, event type, menu and drinks. Staffing lines, open shifts, floor-plan sections and the schedule's event notes then follow the real bookings.

- **Daily sync** (Vercel Cron) of everything from a week ago through 120 days ahead, plus whatever changed since the last sync.
- **Sync now** in **Settings → Integrations → Tripleseat**.
- **Webhook** for instant updates: Tripleseat nudges ShiftBoard, which reads that event back from the API.

Contacts, accounts and money are never read. Client contact details stay in Tripleseat.

## 1. Research: what Tripleseat's API offers

> Tripleseat's own pages (support.tripleseat.com, api.tripleseat.com) could not be fetched from the build environment. The findings below come from search-engine extracts of those pages, plus code and notes of third-party integrations on GitHub (listed under Sources). Points marked **verify** should be checked in the interactive API docs under **Settings → API** in the restaurant's Tripleseat account before going live.

### Auth

- **Historically: OAuth 1.0a, "two-legged".** Each request is signed with HMAC-SHA1 using the account's **public (consumer) key** and **secret key** from Tripleseat **Settings → API**, with no user token. A separate public key is used only for website lead forms.
- **Now: OAuth 2.0.** Tripleseat published an "OAuth 1.0 to OAuth 2.0 Migration Guide". Third-party sources say **OAuth 1.0 was switched off on July 1, 2026**, and old-style calls now answer **410**. ShiftBoard still supports the old keys for an account that has them, and shows a plain message when Tripleseat answers 410.
  - Token endpoint: `POST https://api.tripleseat.com/oauth2/token`. Sign-in and consent for the authorization-code flow happen on `login.tripleseat.com`.
  - Access tokens last **7200 seconds** (2 hours). Refresh tokens rotate: each refresh replaces the old one.
  - **Grant types:**
    - The authorization-code flow is confirmed by a Nango integration.
    - Two community integrations, and an API listing of the Leads API, say **client credentials** works for an account's own (private) application. Tripleseat's own text doesn't say so in what we could read: **verify**.
    - ShiftBoard uses **client credentials** (`grant_type=client_credentials`, form-encoded, client ID and secret in the body). That needs no browser redirect and no refresh token to store. If Tripleseat refuses it (`unsupported_grant_type` / `unauthorized_client`), the sync says so, and the authorization-code flow is the next step (see Decisions).
    - The migration guide also mentions an `oauth1_exchange` grant that swaps old keys for OAuth 2.0 tokens. We don't need it.
- **Who can create keys:** a Tripleseat **account admin**. OAuth 2.0 applications are made on the **API Applications** page under **Settings → API** (older help pages say **Settings → Tripleseat API & Webhooks → + New Application**). Regular users can't authorize an application.
- **Permissions:** for private applications created on or after **11/13/2026**, a new OAuth 2.0 application is **read-only by default**. Write access, and reading "sensitive data", stay locked until Tripleseat approves a **Request Expanded Access**. ShiftBoard only reads.
- **Cost:** Tripleseat publishes no API price.
  - One third-party profile says the REST API is included in the subscription.
  - A partner's onboarding page tells customers to "confirm your Tripleseat plan includes API access".
  - **Ask the Tripleseat rep.**

### Endpoints and fields

Base: `https://api.tripleseat.com/v1/<resource>.json` (`.xml` also exists). `site_id` picks one site (a group of venues) when the keys see several.

| Endpoint | What ShiftBoard uses |
|---|---|
| `GET /v1/sites` | the account (site) name, for Settings |
| `GET /v1/locations` | the venues and their **rooms** (areas); `GET /v1/rooms` is tried if locations come without rooms |
| `GET /v1/events/search` | `event_start_date`, `event_end_date` (MM/DD/YYYY), `location_id`, `order`, `sort_direction`, `page` |
| `GET /v1/events/{id}` | one event (the webhook, and events missing from a search); 404 = deleted |
| `GET /v1/events/{id}/menu_item_selections` | the menu items picked for an event: `menu_item_id`, `quantity`, `price`, `total_price`, `parent_id` (read-only) |
| `GET /v1/menus` | menu item names and categories, to name the selections |
| bookings, leads, contacts, accounts, users | **not used** (bookings have `booking_updated_start_date`; contacts and accounts hold client details) |

These are the **event fields** read, accepting the variants third parties report:

- `id`, `name`
- `status`: Prospect, Tentative, Definite, Closed or Lost; any letter case
- `event_start` / `event_end`: `MM/DD/YYYY hh:mm AM/PM`, local; ISO times with an offset are moved into the restaurant's zone
- `guest_count`, `guaranteed_guest_count`
- `event_type` (object or name)
- `rooms` (a collection), `room`, `room_ids`
- `location_id`, `booking_id`
- `owner` (the sales manager)
- `updated_at`
- `event_notes` / `notes` / `description`
- a link to the event if the API gives one (`url` and similar; https only)

`documents` (BEO links) and financial totals (`show_financial`) aren't used.

**Statuses**, per Tripleseat's help:

| Status | Meaning |
|---|---|
| **Prospect** | early, nothing sent to the client, may overlap other events |
| **Tentative** | a proposal or contract has gone out; holds the room |
| **Definite** | signed contract and deposit |
| **Closed** | it happened, nothing left to do |
| **Lost** | it fell through (with a lost reason) |

### Pagination, limits, "changed since"

- **Pagination:** `?page=N`, **50 per page**. Answers look like `{ results: [...], total_pages }`. A bare array is accepted too, and an API that ignores `page` (answers page 1 again) stops the loop.
- **Rate limits:** **10 requests a second, 1,200 a minute, 18,000 an hour.** Over that, Tripleseat answers **429**. ShiftBoard spaces its requests (about 9 a second) and waits for `Retry-After`, up to 10 s.
- **Changed since:** events carry `updated_at`, but we found no documented "updated since" parameter for the event search (**verify**). ShiftBoard does three things instead:
  - It asks for events ordered by `updated_at`, newest first, and stops at the last finished sync. If Tripleseat doesn't support that order, it just carries on with the date window.
  - It searches the date window.
  - It fetches on their own any events it has in that window that the search didn't list, which catches deletes and moves without a webhook.

### Webhooks

- **Set up** in Tripleseat under **Settings → API & Webhooks**: a URL, and a checkbox per trigger. Each trigger sends its own POST.
- **Event triggers:** `CREATE_EVENT`, `UPDATE_EVENT`, `DELETE_EVENT`, `STATUS_CHANGE_EVENT`, `CHANGE_EVENT_GUEST_COUNTS`, `CHANGE_EVENT_DATETIME`, `REASSIGN_EVENT_LOCATION`, `REASSIGN_EVENT_AREAS`, and in newer help also `REASSIGN_EVENT_OWNERSHIP`, `REASSIGN_EVENT_CONTACT`, `REASSIGN_EVENT_ACCOUNT`.
- **Other triggers:** lead and booking triggers such as `CREATE_LEAD`, `CONVERT_LEAD` and `CONVERT_LEAD_TO_BOOKING`.
- **Body:** JSON with `webhook_trigger_type`, `message`, and `event` (or `lead`) data.
- **Verification:** an `X-Signature: t=<timestamp>,v1=<hex>` header.
  - The hex is an HMAC-SHA256 keyed with the **webhook endpoint's signing key**, over the raw body. Tripleseat says the timestamp is part of what's signed and recommends a constant-time comparison.
  - It doesn't publish the exact signed string. ShiftBoard uses `"<t>.<raw body>"` (the Stripe-style form the `t=`/`v1=` header implies) with 5 minutes of clock tolerance.
  - **Caution:** one third-party team logged real Tripleseat deliveries in November 2026 and couldn't make any construction verify. So ShiftBoard doesn't rely on the signature alone (next section). **Verify with the first real delivery.**

## 2. What syncs, and who owns which field

| Field | Owner | Notes |
|---|---|---|
| name, date, start, end, guest count, room, status | **Tripleseat** | always |
| guaranteed count, event type, Tripleseat notes | **Tripleseat** when Tripleseat has a value | otherwise the manager's |
| menu (food lines), drinks package (`beverage.package`) | **Tripleseat** when Tripleseat has menu lines | an event with no menu in Tripleseat keeps what a manager types |
| staffing lines, who works each shift, captain, service style, comments, floor-plan sections, setup / A/V / attire / dietary notes, timeline, special drinks, bar setup, client, contact fields | **ShiftBoard** | never touched by the sync |

A manager can still edit a Tripleseat field in ShiftBoard, but the next sync puts Tripleseat's value back. The BEO says **"From Tripleseat: edit it there."** and lists exactly which fields come from Tripleseat; the editor says it too.

Menu lines are named from the menus. A beverage category (Bar, Wine, Cocktails…) goes to the drinks package; everything else goes to the menu with its category as the course and `× quantity` after the name. Lines Tripleseat gives no name for are left out.

**Statuses**: Settings → Integrations → Tripleseat → "What each Tripleseat status does". Admins change these; managers see them.

| Tripleseat | ShiftBoard (default) | Other choice |
|---|---|---|
| Definite | **confirmed** (everyone sees it) | — |
| Tentative | **tentative**: only managers and the events team see it, as ShiftBoard already does | leave out |
| Prospect | **left out** | bring in as tentative |
| Closed | **kept, marked completed** (it happened) | leave out |
| Lost, or deleted in Tripleseat | **marked cancelled** | deleted, only when nobody is scheduled |

- **"Leave out"** also takes an event back off ShiftBoard if it was brought in earlier.
- **An event with people scheduled is never deleted by a sync.** It's marked cancelled, flagged for the events team ("Needs a look"), and managers get a notification. Its open shifts are taken down; shifts people have stay until a manager decides.
- An event that comes back (Lost → Definite) is confirmed again and its flag cleared. Its staffing lines were kept, so "Create open shifts" brings the shifts back.

**Rooms**:

- Tripleseat's rooms are matched to the venue's rooms (core/venue-links.js, `roomId`) **by name**, or **by hand** in Settings → Integrations → Tripleseat → Rooms. A match made by hand stays.
- Changing a match moves the events in that room right away.
- An unmatched room keeps Tripleseat's name as free text.
- An event in two rooms gets their names joined ("Library & Rabbit Hole") and no single floor plan.

**Changes that matter to staff** (date, start or end time, guest count, room) notify the people on that event's published shifts and the captain. This goes through the same path as a BEO edit: in-app, email, push and text, each in the person's language. For example: *"BEO updated from Tripleseat: Smith Wedding (Sat, Dec 5). 95 guests; Room: Library. Review the latest details."* Tentative events don't notify staff (they can't see them).

When an event **moves to another day**:

- its open shifts move with it;
- shifts people already have stay put, the event is flagged, and the events team is told how many people are still on the old day.

**New events:**

- A new event is announced to managers and the events team, except during the very first sync.
- It has no staffing yet. Its BEO offers **"Suggest staffing"**: the existing suggestion from the guest count and service style. The lines are added only when someone taps **Add these lines**, and open shifts are created only when a manager taps **Create open shifts**.

**Deleted here:** deleting a Tripleseat event in ShiftBoard means the sync leaves it alone afterwards. Settings → Integrations → Tripleseat → "Deleted here" lists those events, and an admin can bring them back.

## 3. How the sync runs

- **Window:** 7 days back through 120 days ahead.
- **Phases:** `lists` (site, locations, rooms, menus), `changed` (newest-first since the last finished run), `window` (page by page), then `missing` (events ShiftBoard has in the window that the search didn't list, fetched one by one; a 404 means deleted).
- **Time budget:** each call stops starting new work after about 18 seconds, so it fits Vercel's 30-second limit, and hands back a cursor:
  - **Sync now** keeps calling until it's done.
  - The **cron** saves the cursor and resumes it on its next run.
- **Idempotent:** an event is always `evt_ts_<Tripleseat id>`, and a run that finds nothing new writes nothing. A menu is read again only when the event's `updated_at` changed.
- **Cron:** `GET /api/cron/tripleseat` at 11:00 UTC (`vercel.json`), with `Authorization: Bearer <CRON_SECRET>`. On the platform it loops over every active restaurant with Tripleseat in its plan and set up, each with its share of the time, and skips any whose last cron run worked in the last 20 hours.
- **Webhook:** `POST /api/tripleseat/webhook/<token>`.
  - The token is the restaurant's own, random. Admins see the whole link in Settings and can make a new one. Each restaurant also has its own host, so one restaurant's link does nothing on another's.
  - When a signing key is set, `X-Signature` must verify too.
  - The body is treated as a nudge: only the event id is used, and the event is read back from Tripleseat with the restaurant's keys. A forged body can't change any data.
  - It answers 200 once the request is authentic, even if the sync failed; the daily sync retries.
  - Limited to 120 a minute per restaurant.

## 4. Setting it up

**On the platform (any restaurant on Pro or Beta), the restaurant's admin does it:**

1. In Tripleseat, an **account admin** opens **Settings → API** and creates an **OAuth 2.0 application** (read access is enough). Copy its **client ID** and **client secret**.
2. If the Tripleseat account has more than one venue, note this venue's **location ID**.
3. In ShiftBoard, **Settings → Integrations → Tripleseat (events) → Connection**: paste the client ID, the secret and the location ID, then **Save**. The keys are stored encrypted and show only as "set, ends in 1234". DubLow can do the same from the platform console.
4. Tap **Sync now**. Check **Rooms** (match any Tripleseat room the names didn't match) and **What each Tripleseat status does**.
5. Optional, for instant updates:
   1. Under **Webhook**, tap **Show the webhook link** and copy it.
   2. In Tripleseat (**Settings → API & Webhooks**), add a webhook with that link and tick the event triggers (`CREATE_EVENT`, `UPDATE_EVENT`, `DELETE_EVENT`, `STATUS_CHANGE_EVENT`, `CHANGE_EVENT_GUEST_COUNTS`, `CHANGE_EVENT_DATETIME`, `REASSIGN_EVENT_AREAS`, `REASSIGN_EVENT_LOCATION`).
   3. Paste the webhook's **signing key** under Connection.

Chasing Rabbits (the default restaurant) can also keep using env vars. Anything saved in Settings takes their place.

**Single-restaurant install (Vercel env vars):**

| Env var | |
|---|---|
| `TRIPLESEAT_CLIENT_ID`, `TRIPLESEAT_CLIENT_SECRET` (Sensitive) | the OAuth 2.0 application |
| `TRIPLESEAT_LOCATION_ID` | optional: only this venue's events |
| `TRIPLESEAT_SITE_ID` | optional: when the keys see several sites |
| `TRIPLESEAT_WEBHOOK_SECRET` (Sensitive) | optional: the webhook's signing key |
| `TRIPLESEAT_PUBLIC_KEY`, `TRIPLESEAT_SECRET_KEY` (Sensitive) | only for an account still on the old OAuth 1.0 keys |
| `TRIPLESEAT_API_HOST` | default `https://api.tripleseat.com` |
| `TRIPLESEAT_TOKEN_URL` | default `{host}/oauth2/token` |
| `CRON_SECRET` | the daily sync |
| `TIMEZONE` | the restaurant's zone (event times are read as local) |

The platform console's **Tripleseat (events)** group has the same fields. The keys are encrypted secrets. A restaurant whose plan lacks Tripleseat gets none of them, and no restaurant ever inherits the default restaurant's values.

## 5. Questions to ask Tripleseat

1. Does a private OAuth 2.0 application support the **client credentials** grant for reading our own account? If not, we add the authorization-code flow, storing the rotating refresh token encrypted.
2. Is API access included in our plan, or is it extra?
3. What exactly is signed in `X-Signature`: `"<t>.<body>"`? Is the key the webhook's signing key as shown, or base64 of it?
4. Is there an "updated since" parameter for `GET /events/search`, and does `order=updated_at` work there?
5. Do events carry a link to open them in Tripleseat (a web URL field)?
6. Are BEO menu lines always `menu_item_selections`, or do some venues keep menus only in event documents?

## 6. Code map

```
server/tripleseat.js           API client: config, OAuth 2.0 token, OAuth 1.0a signing, pages, 429/Retry-After
server/tripleseat-sync.js      the sync run (phases, budget, cursor) and syncOneEvent (webhook)
server/tripleseat-routes.js    /api/tripleseat/status, /sync, /webhook/:token, /api/cron/tripleseat; signature check
core/tripleseat.js             reading events, status rules, ownership, rooms, notifications, cancellations, tripleseat.* RPCs
server/platform/index.js       tripleseatCronAll (the per-restaurant cron loop)
server/platform/tenant-env.js  the per-restaurant fields (INTEGRATION_FIELDS, group 'tripleseat')
server/platform/integrations.js, server/integrations-routes.js   Settings → Integrations (restaurant admins)
web/src/pages/TripleseatSettings.jsx   the panel, the event badge, the BEO card, the editor note
test/tripleseat.test.js, test/platform-tripleseat.test.js
```

## Sources

- Tripleseat help center, API section: https://support.tripleseat.com/hc/en-us/sections/200821727-Tripleseat-API (API Overview & Resources, Events Endpoint, Bookings Endpoint, Contacts Endpoint, OAuth 2.0 Implementation, OAuth 1.0 to OAuth 2.0 Migration Guide, Menus & Menu Item Selections Endpoints)
- Tripleseat help: Webhooks (https://support.tripleseat.com/hc/en-us/articles/40075780832919-Webhooks), Tripleseat Webhooks, Webhooks: Troubleshooting Tips & Common Issues, "What does each event status mean?"
- OpenAPI spec (referenced by Tripleseat's help): https://api.tripleseat.com/api-docs/v1/openapi.yaml
- github.com/bonroyage/tripleseat-php: OAuth 1.0a HMAC-SHA1 signing, `site_id`, 50 per page
- github.com/mattcretzman/tripleseat-mcp: `https://api.tripleseat.com/oauth2/token`, `/v1` paths, search parameters
- github.com/NangoHQ/nango pull 8141: OAuth 2.0 URLs, 2-hour tokens, rotating refresh tokens, `?page` + `total_pages`
- github.com/Tribowl-LLC/PG-CDP-Webhook pulls 35 and 37: real-delivery notes on `X-Signature`
- The OAuth Core 1.0 spec (Appendix A), the worked example the signing test uses
