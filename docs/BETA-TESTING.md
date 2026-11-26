# Beta testing: reporting problems and reading errors

During the beta, DubLow Digital finds out about problems as they happen, in two ways:

1. **Errors are caught by themselves**: on the server (a request that answers 500, a failed daily sync, a failed Sync now), in the web app and the DubLow console (anything uncaught, and React crashes), and in the phone app (iPhone, Android, and its browser version at `/app`).
2. **People tell us**: **Report a problem** in every app, and **Report this** on the "Something went wrong" screen.

Both land in the DubLow console under **Errors & reports**, and both email DubLow right away.

## For people using ShiftBoard: how to report a problem

| Where | How |
|---|---|
| Website, on a computer | The menu on the left, at the bottom: **Report a problem** (above Sign out). |
| Website, on a phone | **More** (bottom right) → **Report a problem**. |
| Phone app (and `/app` in a browser) | **More** → **Report a problem**. |
| When a screen crashes | It shows **Something went wrong** with **Reload** and **Report this**. Report this sends the error with what you write. |

The form is short:
- **What happened?** (required): what you were trying to do and what went wrong.
- **Which page?** (optional): filled in with the page you were on; change it if you mean another one.
- **Screenshot** (optional): **Add a screenshot** picks a picture. On a computer you can also paste one (take it with your computer's screenshot tool, then Ctrl+V or ⌘V while the form is open). On a phone, take the screenshot first, then pick it from your photos. It's shrunk on your device before it's sent (about 1,400 px, under 700 KB on the website; 1,200 px, under 480 KB in the phone app).

Then **Send**. You'll see **Thanks, we got it**. It works signed in or out (the sign-in page can break too). Everything is in English and Spanish.

## Where errors appear (DubLow Digital)

**Console → Errors & reports** (`https://admin.<PLATFORM_DOMAIN>/platform#/errors`, or `/platform#/errors` on a legacy host). Only DubLow staff signed in to the console see it: restaurant accounts, admins included, have no way in (no page, no RPC; the API answers only on the console's host, behind the console's own sign-in).

- **The list** is grouped by fingerprint (one row per problem, however many times it happened). Filters: restaurant, status (open = new and acknowledged; or one status; or any), type (server, browser, phone app, report), when (24 hours, 7 days, 30 days, all time) and a search over the message, top frame, route and fingerprint. Each row shows how many times it happened in the period (and in all), how many signed-in people it hit, the restaurants and when it was last seen.
- **The detail**: the latest stack, where it happened (route or page), the top frame, the message as grouped, people affected, app versions, devices, which restaurants and how often, the last 50 occurrences (when, restaurant, user id, route or page, version, device). For a report: what they wrote, the page they named and where the app really was, the **screenshot**, and what the app attached (its recent errors and last calls to the server).
- **Acknowledge / Mark fixed / Ignore / Reopen**. Every change is in the audit log.
  - **New**: nobody has looked yet. Alerts keep coming (at most hourly) while it's new.
  - **Acknowledged**: someone's on it. No more alert emails; it still counts.
  - **Fixed**: remembers the app version it was seen on last. If it happens again on a **different** version, it's back to New and emails again ("Back again"). Occurrences from the old version (a browser that hasn't reloaded yet) don't reopen it.
  - **Ignored**: never alerts again, still counted.
- **Copy as issue text**: a markdown summary (title, fingerprint, where, restaurants, counts, versions, devices, status, the stack, what the app attached, the latest occurrences) ready to paste into a GitHub issue or a chat with Claude. It has no user ids.

## Alerts

- **Email, right away**, to `PLATFORM_ADMIN_EMAIL` (comma-separate several), from `PLATFORM_EMAIL_FROM` through the platform's Resend key:
  - a **new fingerprint** (an error never seen before), or one that came back after being fixed;
  - **every report**;
  - an error that's still **New** gets **at most one email per hour** ("Still happening (N times)"). Acknowledge, fix or ignore it to stop them.
  - At most 20 alert emails an hour in all; the daily digest covers anything over that.
- **The daily digest** (Vercel Cron `/api/cron/errors-digest`, 13:15 UTC, needs `CRON_SECRET`): occurrences in the last 24 hours by type and restaurant, new fingerprints, reports, the five most frequent, and how many are still new or acknowledged. Nothing happened and nothing waiting: no email. The same run trims old data (see Retention).
- **A text (optional)** for **new server errors that answered 500** only, when Twilio is set up (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and a sender) and `PLATFORM_ALERT_PHONE` is set. Once per new fingerprint, never for browser or phone errors, reports or repeats.
  - **Consent**: these texts go to DubLow's own on-call phone, not to restaurant staff. The person who sets `PLATFORM_ALERT_PHONE` is the recipient and chooses to get them, so the staff consent records (the opt-in screen, STOP and START, the consent log in Settings → Text messages) don't apply. Use a number DubLow controls, and remove the variable to stop them. They go out through the platform's Twilio account and Messaging Service like other texts; if the carrier campaign is registered only for staff schedule notifications, ask Twilio whether internal alerts fit it, or use a separate number.

Recording happens after the response, in the background: a slow email or a database problem never slows or breaks the request that failed (it still answers 500 with "Something went wrong").

## What's captured

| | When | What's kept |
|---|---|---|
| **Server** | An RPC or route answers 500 (the exception the code logs); a **Sync now** for Toast, ADP or Tripleseat answers 502; a restaurant's **daily sync** fails | Error name, message and stack (scrubbed), route (`/api/rpc/shifts.save`, or the route's pattern like `/api/users/:id/invite`), method, HTTP status, the restaurant, the signed-in person's **user id**, the server's version (`VERCEL_GIT_COMMIT_SHA`, first 7), the browser or app it came from (e.g. "Chrome 131 · Android phone") |
| **Browser** (web app, console) | `window.onerror`, unhandled promise rejections, a React screen crash | Name, message, stack, the React component stack, the page (`/#/events/:id/edit`), the app version, the browser, the user id if signed in |
| **Phone app** (and `/app`) | React Native's global error handler, unhandled promise rejections (release builds), a screen crash; in the browser version `window.onerror` and rejections | The same, plus the app version, OS version and phone model ("Phone app 1.0.3 · iOS 18.1 · iPhone 15") |
| **Report** | Report a problem, Report this | What they wrote, the page they named, the screenshot, and what the app attached: its version, where it was, screen size, language, online or not, its last 10 errors (name, message, when) and its last 20 calls to the server (**method name, status and time only**) |

Repeats are grouped by fingerprint; each group keeps a count, first and last seen, the latest stack, the restaurants, the app versions (last 20) and the distinct people (up to 500). Each occurrence is kept too (the last 200 per fingerprint).

**Noise that's dropped** before it's stored: browser extensions (`chrome-extension://`, `moz-extension://`…), `ResizeObserver loop…`, cross-origin `Script error.`, a lost connection (`Failed to fetch`, `Load failed`, `Network request failed`), aborted requests, in-app browsers' own scripts, and API answers the screen already shows (a 4xx like "Please sign in"). A 503 (the database is unreachable) isn't recorded either: there's nowhere to put it.

**Limits**: `/api/client-errors` takes 20 a minute per address and person and 120 an hour per address (then 429); each page load or app run sends at most 10, each distinct error once. Reports: 5 per 10 minutes and 30 a day per person (or address when signed out). Each server instance records at most 300 errors a minute.

## What's never captured (privacy)

- **No request bodies**: not the RPC arguments, not what anyone typed into a form (only the text of a report, which they wrote for us).
- **No passwords, tokens or secrets**: every message, stack and report is scrubbed. `password=…`, `token: …`, "my password is …", `Authorization: Bearer …`, JWTs, API keys (`sk_…`, `re_…`, Twilio SIDs), PEM keys, long random strings, hex digests, and tokens in URLs (`?token=`, `?code=`, `/api/ical/<token>`, the Tripleseat webhook token) are replaced with `[redacted]`, `[jwt]`, `[key]` and the like.
- **No email addresses or phone numbers** in messages or reports (`[email]`, `[number]`). Alerts and the console show the **user id**, never a name or email. "Copy as issue text" has no user ids at all.
- **No full addresses or user agents**: pages and routes are paths with ids taken out (`/#/events/:id`), never query strings; devices are a short description, not the user agent; no IP addresses are stored (they're only used, in memory, for rate limits).
- Allowlisted fields only: anything else an app sends is dropped by the server.
- Screenshots are what the person chose to send. They're served only to signed-in DubLow console admins, with a sandboxing content policy.

**Retention**: occurrences 90 days, screenshots 60 days, fixed or ignored groups nobody has seen in 180 days are deleted (by the daily digest run).

## How to read a fingerprint

A fingerprint is 16 hex digits, like `2d4175884759ad1e`: the start of a SHA-256 of

```
kind | error name | normalized message | top frame
```

- **kind**: server, browser, phone or report (the same bug in the web app and the phone app is two groups).
- **normalized message**: the scrubbed message with ids (`shf_ab12cd` → `<id>`), UUIDs, dates and numbers (`<n>`) replaced, so "Shift 42 not found" and "Shift 43 not found" group together. The console shows it as **Grouped as**.
- **top frame**: the first stack frame that isn't Node's own, as **function (file)**, *without* line and column, and without the build hash in file names (`assets/index-B2x9Kq.js` → `assets/index.js`). A deploy that moves code around doesn't start a new group; a different function does. The console shows it with the line and column of the latest occurrence.
- Errors with no stack (a failed sync or cron, a 500 nothing explained) use their source and route instead of a frame.
- Each report is its own entry (`rep_…`), never grouped.

So two rows with different fingerprints are different problems (or the same message thrown from different functions). In the web app's minified build, function names are short (`Ab`) and can change between builds; the message and file still say where to look, and the version tells you which build.

## Setting it up (env vars)

| Env var | Notes |
|---|---|
| `PLATFORM_ADMIN_EMAIL` | Where alerts and the digest go (already the first console admin's email). Comma-separate several. Without it, errors are still recorded and shown in the console, just not emailed. |
| `PLATFORM_EMAIL_FROM` | The sender (domain verified in Resend), with `RESEND_API_KEY`. Falls back to `EMAIL_FROM`. |
| `CRON_SECRET` | Already set for the daily syncs; the digest cron uses it too. |
| `PLATFORM_ALERT_PHONE` | Optional. DubLow's own phone, E.164 (`+17205550100`), for a text on each new server 500. Needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`). |
| `VERCEL_GIT_COMMIT_SHA` | Set by Vercel. The app version on every error (server, web, console and `/app` builds). Phone app builds use their version plus the EAS build's commit. |

The tables are created on first use: `platform.errors`, `platform.error_events`, `platform.error_files` (row-level security on, like the rest). A single restaurant running `server/app.js` without the platform keeps them in its own schema and emails the same way; there's no console page for it.

## Code

- `server/errors.js`: scrubbing, fingerprints, the error log (record, list, detail, status, screenshot, digest, retention), alert and digest emails, the issue text.
- `server/errors-routes.js`: catching 500s and failed syncs for each request, `POST /api/client-errors`, `POST /api/report-problem`, the noise filter, the rate limits.
- `server/platform/errors-console.js`: the console's API (`/api/platform/errors…`), the digest cron, recording failed daily syncs per restaurant.
- `web/src/errors.js`, `web/src/ErrorBoundary.jsx`, `web/src/pages/ReportProblem.jsx`: the web app (and the console's error reporting).
- `web/console/Errors.jsx`: the console page.
- `mobile/src/lib/errors.ts`, `mobile/src/components/CrashScreen.tsx`, `mobile/src/app/(app)/report-problem.tsx`: the phone app.
- Tests: `test/errors.test.js`.
