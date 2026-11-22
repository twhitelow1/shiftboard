# ShiftBoard as a platform (phase 1)

One ShiftBoard deployment serves many restaurants. DubLow Digital sells it per restaurant; Chasing Rabbits, the restaurant it was built for, is the first client and keeps all of its data where it is.

Phase 1 (this): tenancy, routing by host, the platform console for DubLow, per-restaurant integration settings, and features by plan. Phase 2: Stripe billing and self-serve sign-up (see [Phase 2](#phase-2-billing-and-sign-up)).

## How it works

```
                       ┌──────────────── one Vercel deployment ────────────────┐
 bistro.shiftboard.app │ host ─► restaurant (server/platform/hosts.js)           │
 schedule.bistro.com   │   └─► its runtime, opened on first use, kept in an LRU: │      one Postgres database
 shiftboard-gamma…app  │        DocDb(schema) + server/app.js (unchanged rules)  │ ──►  platform   (registry)
 admin.shiftboard.app  │ admin.<domain> or /platform ─► platform console         │      shiftboard (Chasing Rabbits)
                       └─────────────────────────────────────────────────────────┘      t_bistro, t_…  (one per restaurant)
```

- **A Postgres schema per restaurant.** Every restaurant has the same tables as today (`docs`, `meta`, `auth_tokens`, `login_attempts`, row-level security on, no policies) in its own schema: `t_<slug>` (dashes become underscores). Chasing Rabbits keeps `shiftboard`. Each schema has its own write lock (an advisory lock keyed by a hash of the schema name; `shiftboard` keeps the key it always had), so restaurants never wait on each other.
- **The registry** is the `platform` schema: `tenants` (slug, name, schema, status, plan, feature overrides, domains, owner, trial end, notes, non-secret integration settings, `billing`), `tenant_secrets` (AES-256-GCM encrypted), `admins` (DubLow staff), `audit_log`, `support_grants`, `login_attempts`, `meta`. Code: `server/platform/registry.js`.
- **The business logic doesn't know.** `core/` is unchanged: each request runs against its restaurant's store and service. `server/app.js` is still the API for one restaurant; the platform (`server/platform/index.js`) creates one per restaurant on its first request and keeps the most recently used ones (`TENANT_CACHE_MAX`, default 25). An evicted restaurant just reloads its documents on its next request.
- **Routing by host** (`server/platform/hosts.js`), in this order:
  1. an exact match on a restaurant's **domains** (a custom domain, or a spare `*.vercel.app` alias);
  2. `admin.<PLATFORM_DOMAIN>`: the **platform console**;
  3. **legacy hosts** (`LEGACY_HOSTS`), or **any host when `PLATFORM_DOMAIN` isn't set**: the default restaurant (Chasing Rabbits). That keeps today's address, local development, tests and single-restaurant installs working as before;
  4. `<slug>.<PLATFORM_DOMAIN>`;
  5. anything else: **"Restaurant not found"** (a page, or `{ error, notFound: true }` from the API). Never another restaurant's data. Reserved subdomains (`admin`, `www`, `api`, `app`, … in `server/platform/slugs.js`) are never restaurants.

  Routing reads the `Host` header (Vercel passes the requested domain), not `X-Forwarded-Host`.
- **Sessions belong to a restaurant.** The session token (cookie, and the phone app's bearer token) carries the restaurant's id (`t`) and is refused on any other restaurant's host. A token without `t` is from before the platform and belongs to the default restaurant, so nobody at Chasing Rabbits is signed out. Each restaurant other than the default also signs with its own key (derived from `JWT_SECRET`, or generated in its schema), so its iCal links only work on its own host. Password-reset and invite links are tokens in the restaurant's own `auth_tokens` table.
- **Each restaurant's `/api/config`** returns its own name, colors and logo, its features, and `paused` when its account is paused. The phone app already asks for a "restaurant address": a restaurant's address is its host (`https://bistro.shiftboard.app`).

### Plans and features

Defined in one place, `server/platform/plans.js` (also where phase 2 maps Stripe prices to plans):

| Plan | Price (working) | Features |
|---|---|---|
| `starter` | $49 / month | Training, Tip pool, 86 List |
| `pro` | $99 / month | Starter + Events & BEOs, Forecast & labor, Toast, ADP, Tripleseat, Text messages, Venue & floor plans |
| `beta` | free | everything (Chasing Rabbits) |

Scheduling, trades, time off, notifications, email, phone notifications, team and settings are in every plan. `multiLocation` is a placeholder (no plan has it except beta; nothing uses it yet). The console can switch any feature on or off for one restaurant on top of its plan.

Enforced on the server: an RPC of a feature the restaurant doesn't have answers **403 "Not included in your plan"** (in Spanish too), and so do its routes (Toast, ADP, Tripleseat and its webhook, Training photos, 86 photos, test text, Twilio webhook). The web app hides those pages, nav items and cards, and a link to one goes to the schedule.

### Statuses

`trialing` (until `trial_ends_at`), `active`, `past_due` (a payment failed; still open), `suspended`, `canceled`. A suspended or canceled restaurant can't sign in: the app shows "This restaurant's account is paused. Contact DubLow Digital." and every API call (other than its branding) answers 403. Its data is kept; set it back to `active` and everything is as it was.

The restaurant's **admins** (never staff) see a slim, dismissible banner: "Your free trial ends in N days" while trialing, "Payment failed. Update your card…" when past due. Its button calls `POST /api/billing/portal`, a stub until phase 2 (the app says to contact DubLow Digital).

### Integrations per restaurant

Each restaurant's app gets its own copy of the platform's env with its own settings from the console (`server/platform/tenant-env.js`):

| | Per restaurant (console) | Platform-wide (env) |
|---|---|---|
| Toast | client ID and secret (encrypted), restaurant GUID, API host | — |
| ADP | client ID and secret, certificate and key (encrypted), manager AOID | — |
| Tripleseat | client ID and secret, webhook signing key, old OAuth 1.0 keys (encrypted), location ID, site ID, API host | — |
| Texts | sender: Messaging Service SID or From number | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (DubLow's one Twilio account; each restaurant is its own brand and campaign) |
| Email | From name and address, reply-to | `RESEND_API_KEY`; `PLATFORM_EMAIL_FROM` as the default address ("<Restaurant> <schedule@…>") |
| Phone notifications | — | `VAPID_*`, Expo push |

The restaurant's own admins (Admin and up) set these in **Settings → Integrations** (`GET`/`PUT /api/integrations`, `server/integrations-routes.js`): the same storage as the console (`server/platform/integrations.js` `saveIntegrations()` serves both), only for the integrations in its plan (anything else is a 403), audited with the restaurant user as the actor (`tenant.integrations`, `details.via: 'restaurant settings'`), and the restaurant runs with the new settings from its next request. A single-restaurant install has no registry, so its page shows what env sets, read-only.

Secrets are encrypted with AES-256-GCM (`PLATFORM_ENCRYPTION_KEY`; each value is bound to its restaurant and setting) and never sent to a browser: the console shows "set" and the last 4 characters. The default restaurant falls back to the env vars it uses today for anything not set in the console, so production keeps working unchanged. No other restaurant ever sees those env values (its admin account, Toast keys, sender, From address, `APP_URL`). A feature not in the plan is switched off at the source too (no Toast or Twilio settings at all).

The daily crons (`/api/cron/toast`, `/api/cron/adp`, `/api/cron/tripleseat`, `CRON_SECRET`) loop over every active restaurant with that integration in its plan and set up, each with its share of the time budget, starting at a different restaurant each hour and skipping any already synced in the last 20 hours. A restaurant left out of one run catches up on the next (the sync reaches back up to 14 days).

### The platform console

For DubLow staff, at `https://admin.<PLATFORM_DOMAIN>` and at `/platform` on a legacy host (so `https://shiftboard-gamma.vercel.app/platform` works before there's a domain). English only. Code: `web/console/` (page) and `server/platform/console.js` (API, `/api/platform/*`).

- **Its own sign-in**: platform admins in `platform.admins`, separate from every restaurant's accounts. The first is created from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` while there are none (add more under Admins). 12-hour session, cookie scoped to `/api/platform`, SameSite=Strict, JSON-only changes, sign-in rate-limited (10 tries per 15 minutes per IP and email).
- **Restaurants**: name, slug, address, status, plan, active staff, last activity, created.
- **New restaurant**: name, slug (checked live for format, reserved names and uniqueness), owner name and email, plan, status, trial end. It creates the schema, settings with the restaurant's name (and neutral room/area/tag names), the owner as Super Admin, and invites the owner through the app's own invite flow: by email when email is set up, otherwise the console shows the invite link once.
- **A restaurant's page**: status, plan, trial end, owner; feature overrides; domains; integrations (Toast, Twilio sender, email From); notes; **Sign in as owner** (a one-time link, valid 3 minutes, that opens a support session of 15–120 minutes with a banner everyone in the restaurant sees; password changes are blocked in it); **Resend owner invite**; billing fields (phase 2); its activity.
- **Audit log**: every sign-in, creation, change, pause/resume, integration change, invite and support sign-in, with who did it.

Restaurant creation is one server-side function, `createTenant()` in `server/platform/onboard.js`, that doesn't depend on a console session: self-serve sign-up will call it in phase 2.

## Chasing Rabbits: schema `shiftboard`

Nothing is copied or moved. On the first request after this deploys:

1. The `platform` schema is created (only `CREATE … IF NOT EXISTS`).
2. Chasing Rabbits is registered: one row in `platform.tenants` with id `default`, slug `DEFAULT_TENANT_SLUG` (default `chasing-rabbits`), `schema_name = 'shiftboard'`, status `active`, plan `beta`. Its name is read from its settings. The `shiftboard` schema is only read.
3. Its app runs on `shiftboard` exactly as before: same tables (schema version 2, so no migration runs), the same write-lock key, the same `JWT_SECRET` (or the secret already in `shiftboard.meta`).
4. Existing cookies and phone-app tokens (no restaurant in them) keep working on its hosts; iCal links, invite and reset links keep working; integrations keep coming from the env vars.
5. Until `PLATFORM_DOMAIN` is set, every host is Chasing Rabbits, as today. When it is set, keep its hosts in `LEGACY_HOSTS`.

The tests check this (`test/platform.test.js`, "the default restaurant keeps schema shiftboard"): a session, phone token, iCal link and reset link made by the old single-restaurant app keep working after the platform boots, and the `shiftboard` schema's documents and meta are byte-for-byte unchanged.

## Environment variables

New (all optional; without them the deployment behaves as a single restaurant):

| Env var | Notes |
|---|---|
| `PLATFORM_DOMAIN` | e.g. `shiftboard.app`. Restaurants get `<slug>.<PLATFORM_DOMAIN>`, the console `admin.<PLATFORM_DOMAIN>`. Unset: every host is the default restaurant. Set it for **Production only** (preview URLs aren't restaurants), or add the preview host to `LEGACY_HOSTS`. |
| `LEGACY_HOSTS` | Comma-separated hosts that keep going to the default restaurant: at least `shiftboard-gamma.vercel.app`, plus any custom domain Chasing Rabbits uses. The console also answers at `/platform` on these. |
| `DEFAULT_TENANT_SLUG` | The default restaurant's slug (default `chasing-rabbits`). Only read when it's first registered. `DEFAULT_TENANT_NAME` overrides the name read from its settings. |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | The first platform admin, created while there are none (like `ADMIN_EMAIL`). `PLATFORM_ADMIN_NAME` optional. |
| `PLATFORM_ENCRYPTION_KEY` | 32 random bytes, base64 or hex (`openssl rand -base64 32`). Encrypts per-restaurant secrets. Mark it Sensitive. Keep it: losing it means re-entering those secrets. |
| `PLATFORM_EMAIL_FROM` | The default sender for restaurants without their own, e.g. `ShiftBoard <schedule@mail.dublowdigital.com>` (domain verified in Resend). Restaurants get "<Restaurant name> <that address>". |
| `TENANT_CACHE_MAX` | Restaurants each instance keeps open (default 25). |
| `TENANT_REGISTRY_TTL_MS` | How long an instance trusts its copy of the registry (default 5000). Console changes apply at once on the instance that made them, and on the others within this time. |
| `CRON_BUDGET_MS` | Time the Toast cron spends per run, across restaurants (default 18000, inside the 30 s function limit). |

Unchanged and platform-wide: `DATABASE_URL`/`POSTGRES_URL`, `JWT_SECRET`, `TIMEZONE`, `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `VAPID_*`, `CRON_SECRET`, `EXPO_*`. Still used by the default restaurant only (as the fallback for its console settings): `ADMIN_*`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `APP_URL`, `TOAST_*`, `TWILIO_MESSAGING_SERVICE_SID` / `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`.

## Rolling it out

1. **Deploy as is.** No new env vars: Chasing Rabbits works exactly as before; the `platform` schema and its registry row appear.
2. **Add** `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ENCRYPTION_KEY` (Sensitive) and `PLATFORM_EMAIL_FROM`; redeploy. Sign in at `https://shiftboard-gamma.vercel.app/platform`.
3. **Before a platform domain exists**, a new restaurant can be reached on a spare alias: add e.g. `bistro-shiftboard.vercel.app` to the Vercel project (Settings → Domains), then to the restaurant's Domains in the console.
4. **Set up the platform domain** (below), then set `PLATFORM_DOMAIN` and `LEGACY_HOSTS=shiftboard-gamma.vercel.app` in Production and redeploy.

## Wildcard subdomains on Vercel

`<slug>.<PLATFORM_DOMAIN>` needs a wildcard domain (`*.shiftboard.app`) on the project. Vercel issues wildcard certificates with a DNS challenge, so it has to manage that DNS:

1. Use a domain only for the platform (e.g. `shiftboard.app`), bought through Vercel or elsewhere.
2. **Point its nameservers at Vercel** (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`), the simplest way. If the DNS has to stay elsewhere, **delegate `_acme-challenge.<domain>` to Vercel** with NS records instead; check with `dig NS _acme-challenge.shiftboard.app +short`. Without one of these, Vercel can't create the records it needs to issue the wildcard certificate.
3. In the project, **Settings → Domains**: add `shiftboard.app`, `*.shiftboard.app` and `admin.shiftboard.app` (the wildcard covers it, but listing it makes the console's certificate independent).
4. Check with `vercel domains inspect shiftboard.app` / `vercel certs ls`, then open `https://admin.shiftboard.app`.
5. Set `PLATFORM_DOMAIN=shiftboard.app` (Production) and redeploy.

**Custom domains for one restaurant** (`schedule.bistro.com`): add it to the Vercel project (Settings → Domains, or the API's `projects.addProjectDomain`), have the restaurant point a CNAME at the target Vercel shows (if the domain is in use elsewhere on Vercel, they add the TXT verification record), wait for the certificate, then add it under the restaurant's Domains in the console. A domain can belong to one restaurant only; legacy hosts and anything under the platform domain are refused.

Selling ShiftBoard is commercial use, which Vercel's Hobby plan doesn't allow; use Pro. Pro also allows the Toast cron to run more often than daily (see Limits).

## Onboarding a restaurant

1. Console → **New restaurant**: name, address (slug), owner's name and email, plan, trial end. The owner gets the invite email (or copy the link shown once and send it).
2. The owner opens the link, sets a password, and is the Super Admin. From there it's the app as always: job codes, people, import the first schedule.
3. **Toast** (Pro): their Toast admin creates Standard API credentials (read-only) for the location; enter the client ID, client secret and the location's GUID on the restaurant's page. The owner runs **Settings → Integrations → Sync now**; the daily cron takes over.
4. **Texts** (Pro): in DubLow's Twilio account, register the restaurant's A2P 10DLC brand and campaign and create a Messaging Service for it (or verify a toll-free number). Set its incoming webhook to `https://<slug>.<PLATFORM_DOMAIN>/api/twilio/inbound`, then enter the Messaging Service SID on the restaurant's page.
5. **Tripleseat** (Pro): their Tripleseat account admin creates an OAuth 2.0 application (Settings → API) and the owner pastes the client ID and secret (and location ID) in **Settings → Integrations → Tripleseat**, or you enter them on the restaurant's page. Then Sync now, rooms and status rules; optionally the webhook link shown there. See [docs/integrations/TRIPLESEAT.md](../integrations/TRIPLESEAT.md).
6. **Email**: by default email comes from "<Restaurant> <PLATFORM_EMAIL_FROM's address>". For the restaurant's own address, verify its domain in DubLow's Resend account and set the From address (and name, reply-to) on its page.
7. **Phone app**: staff enter `https://<slug>.<PLATFORM_DOMAIN>` (or the custom domain) as the restaurant address, or open an invite link.
8. Need to look at something as them? **Sign in as owner** (logged, with a banner they see).

## Backups

Each restaurant is one schema, so it can be backed up and restored on its own:

```bash
pg_dump "$DATABASE_URL" -n shiftboard   > chasing-rabbits.sql   # the first client
pg_dump "$DATABASE_URL" -n t_bistro     > bistro.sql            # one restaurant
pg_dump "$DATABASE_URL" -n platform     > platform.sql          # the registry, admins, audit log, encrypted secrets
pg_dump "$DATABASE_URL" -n shiftboard -n platform -n 't_*' > everything.sql
```

Restoring a schema replaces that restaurant only (drop or rename the current schema first; the dump recreates it with its tables and row-level security). Then redeploy, so every instance reloads that restaurant: instances keep its documents in memory and only fetch rows newer than the last sequence number they saw. Secrets in `platform.tenant_secrets` need the same `PLATFORM_ENCRYPTION_KEY`. Supabase's own daily backups cover the whole database.

Removing a restaurant is deliberately not a console button: back up its schema, then `DROP SCHEMA t_<slug> CASCADE` and `DELETE FROM platform.tenants WHERE slug = '<slug>'`.

## Limits and decisions for later

- **One time zone per deployment.** The app works in wall-clock time from `TIMEZONE` for the whole process (`server/tz.js`; `core/` reads the local clock), so every restaurant on a deployment shares it. A restaurant in another time zone needs per-restaurant clocks in `core/` or its own deployment.
- **Toast cron capacity.** About 3–6 restaurants fit in one 30-second run. On Vercel Pro, run the cron hourly (`vercel.json` → `"schedule": "7 * * * *"`) and/or raise `maxDuration` with `CRON_BUDGET_MS`: each run skips restaurants already synced in the last 20 hours. Vercel Hobby only allows daily crons.
- **Memory.** Each open restaurant keeps its documents in memory (photos excluded), bounded by `TENANT_CACHE_MAX`. The database pool (`PG_POOL_MAX`) is shared by all restaurants.
- **Trials don't end by themselves** in phase 1: `trial_ends_at` drives the admins' banner; phase 2's Stripe webhooks change the status.

## Phase 2: billing and sign-up

Decided: restaurants sign up on their own, start a free trial, and pay monthly by card through Stripe. Phase 1 leaves the hooks:

- `createTenant()` (`server/platform/onboard.js`): the sign-up endpoint calls it with no admin (`actor: null`, `source: 'signup'`), `status: 'trialing'` and the trial end.
- Slug rules and reserved names: `server/platform/slugs.js`.
- Plans, prices and `planForPrice()` / `stripePriceFor()` (`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`): `server/platform/plans.js`.
- `tenants.billing`: `stripeCustomerId`, `subscriptionId`, `priceId`, `status`, `currentPeriodEnd`, `cancelAtPeriodEnd`.
- Statuses and the admins' banners are already driven by `status` and `trial_ends_at`; `POST /api/billing/portal` is the button's endpoint.
- `server/billing.js` documents the flow: Checkout for sign-up, webhooks (`/api/billing/webhook`, at the platform level like the cron) updating status and plan, the customer portal. No Stripe code or keys yet.

## Code map

```
server/platform/
  index.js        createPlatformApp: host routing, the LRU of restaurant runtimes, the console, the per-restaurant cron loops (Toast, ADP, Tripleseat)
  hosts.js        which restaurant a host is; domains; a restaurant's address
  slugs.js        slug rules, reserved names, schema names
  registry.js     the platform schema: tenants, encrypted secrets, admins, audit log, support grants
  tenant-env.js   each restaurant's integration settings as the env server/app.js reads
  integrations.js saving them (console and Settings → Integrations alike) and what a restaurant's Settings page sees
  plans.js        plans, prices, statuses, features, which RPCs and routes need which feature, billing banners
  onboard.js      createTenant(): schema, settings, owner, invite
  console.js      the console's API (/api/platform/*)
  secrets.js      AES-256-GCM
  tenant-cache.js the LRU
server/billing.js phase 2 (documented stub)
web/console/      the console page (web/platform.html)
test/platform.test.js
```
