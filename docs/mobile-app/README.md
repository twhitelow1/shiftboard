# ShiftBoard phone app (iPhone and Android)

ShiftBoard's staff app for iPhone and Android, built with **Expo (React Native)**. DubLow Digital publishes it once in the **Apple App Store** and **Google Play**. Every restaurant uses the same app, and each person connects it to their own restaurant's ShiftBoard.

**Status (Nov 2026):** version 2 built (`mobile/`): what staff and floor managers do on the website, on the phone. Not yet in either store. The developer accounts and app records are next: see the [runbook](REGISTRATION-RUNBOOK.md).

## What's in the app

For staff first, then shift leads and managers on the floor:

| Screen | What it does |
|---|---|
| Restaurant address | Pick the restaurant: type its address, or open the invite link or QR code. The restaurants already on the phone are listed (someone can work at two; each keeps its own sign-in). |
| Sign in / Forgot password | Same email and password as the website, then the second step when the restaurant's server asks for it: the 6-digit code from an authenticator app (or a recovery code). People who haven't set one up finish in the browser, or set up an authenticator app right in the app. Passkeys are on the website for now. "Forgot password" emails a link, and the reset itself happens on the website. |
| My Shifts | The next shift (with my room and tables), requests waiting (leads and managers), the manager on duty, the 86 List, my tips this week, open shifts I can pick up, my shifts week by week, my time off. Works with no signal: shows the last copy, saying when it's from. |
| Schedule | The team's posted schedule: a day at a time (grouped by area and position) or the whole week (a row per person, scrolling sideways), with projected covers. |
| Shift | Details, my section on the room's floor plan (my tables highlighted), who's working with me, the event's BEO, trade or give it away, and "Can't make it? Call out" (the manager on duty's Call / Text buttons and the call-out procedure). |
| Trades | Trade or give away a shift. Accept trades, pick up giveaways and open shifts. My requests. Leads and managers approve or deny, see what's waiting on coworkers and what was decided. |
| Training (tab) | The manager on duty, what's waiting for me, the menu study guide (search, allergen and dietary filters, photos, 86'd badges, recipes and prep notes only when the server sends them), flashcards, quizzes graded on the server with results and history, the leaderboard (when the restaurant shows it), and the employee manual with "I've read this". Spanish where the restaurant wrote it. |
| Time Off | Request time off on a calendar; my requests; approvers approve or deny with a note and see the person's shifts then. A tab when the restaurant has no Training, otherwise opened from My Shifts and More. |
| My availability | When I can work, day by day: any time, some hours, or unavailable. |
| My tips | My own tip share by day and week, how it was worked out, estimate or final. |
| Events & BEOs | Upcoming and past events, read only; the BEO with staffing, menu, beverage, timeline and the team thread. The client's contact is only for the events team. |
| Today on the floor | Leads and managers: who's working now and later today, requests to approve, the 86 List, publishing a drafted week (with a confirmation), and a link to build schedules on the website. |
| 86 List | What's out or running low, with photos; report, update, back in stock. |
| Notifications | The bell list; tapping one opens its screen (a trade, time off, the 86 List, a quiz, a manual page, a tip week, an event). Push notifications to the phone too. |
| More | The floor tools, 86 List, my tips, events, availability, profile, language, notifications, calendar, the full website, restaurants (switch, add another), privacy, help, delete my account, sign out. |

- **English and Spanish** on every screen. Switch with the language button at the top right of every screen (globe + EN/ES), or in More → Language. Spanish is neutral Latin American (es-419), using "tú". See the [glossary](../i18n/GLOSSARY.md).
- **The restaurant's look**: its brand color and logo (from Settings → Branding on the website), and light or dark mode.
- **The restaurant's plan**: on the multi-restaurant platform, features the plan doesn't include (Training, tips, 86 List, events, forecast, venue) are hidden. See [DEVELOPING.md → Plan features](DEVELOPING.md#plan-features).
- **The app's name** ("ShiftBoard" is a working name) is in one place: `mobile/brand.js`. See [DEVELOPING.md → Renaming the app](DEVELOPING.md#renaming-the-app).
- **Still on the website**: building and editing schedules (the app publishes a drafted week and links to the website), settings, team, forecasting and labor, editing events/BEOs and posting to their threads, the venue and assigning sections, tip pool entry, and editing Training content. The app links to the full website in More and on the floor screen.

## How the pieces fit

```
                 ┌───────────── one app in the stores (DubLow Digital) ─────────────┐
                 │  mobile/  Expo React Native · iOS + Android                        │
                 │  remembers: the restaurants it uses, a sign-in token for each      │
                 │  (secure storage), push token, language, last data (offline)       │
                 └───────────────┬───────────────────────────────┬───────────────────┘
       https://<restaurant A>/api │                               │ https://<restaurant B>/api
                 ┌───────────────▼──────────┐          ┌──────────▼───────────────┐
                 │ ShiftBoard deployment A  │          │ ShiftBoard deployment B  │
                 │ Vercel: web app + API    │   ...    │ Vercel: web app + API    │
                 │ Postgres (own database)  │          │ Postgres (own database)  │
                 └───────────────┬──────────┘          └──────────────────────────┘
                                 │ push: Expo Push API → Apple (APNs) / Google (FCM v1)
```

- **Same API as the website.** Every call is `POST /api/rpc/<method>` (see `core/service.js`). The app signs in with `POST /api/auth/login` and `{ client: 'mobile' }`, gets a token (the same 30-day session the website keeps in a cookie), and sends it as `Authorization: Bearer <token>`. All permission checks stay on the server.
- **One app, many restaurants.** Each restaurant has its own address (its own deployment, or its address on the platform). The app asks for the restaurant's address, or takes it from an invite link `shiftboard://join?server=https://<address>` (a QR code can hold the same link). Someone who works at two restaurants adds both and switches in More. See [DECISION.md](DECISION.md#restaurant-address).
- **Push.** After sign-in the app asks for permission and registers the phone (`devices.register`). Whenever the server creates an in-app notification, it also pushes it to that person's phones through Expo (`server/expo-push.js`). Restaurants don't need any push setup; DubLow's Apple and Google credentials live in the Expo (EAS) account.
- **Privacy and support pages.** Every deployment serves `/privacy` and `/support` (`web/public/`). Both are **drafts for DubLow to review**.

## The docs

| File | For | What |
|---|---|---|
| [DECISION.md](DECISION.md) | Owner, developers | Why Expo store apps, the alternatives, costs and upkeep, the restaurant-address design. |
| [REGISTRATION-RUNBOOK.md](REGISTRATION-RUNBOOK.md) | A browser AI agent + the owner | Step by step: D-U-N-S, Apple Developer Program, App Store Connect, Google Play Console, Expo/EAS, push credentials, first builds to TestFlight and Play internal testing. With STOP points for the human. |
| [RECORD.md](RECORD.md) | Agents and owner | The log of non-secret IDs and who did what. Never secrets. |
| [STORE-LISTING.md](STORE-LISTING.md) | Owner, agents | Store text in English and Spanish, screenshots, privacy answers, review notes. |
| [DEVELOPING.md](DEVELOPING.md) | Developers | Run it locally, point it at a server, build and submit with EAS, versions, push. |
| [../i18n/GLOSSARY.md](../i18n/GLOSSARY.md) | Spanish reviewer | English → Spanish terms the app uses. |

## Before publishing (open items)

1. **The store name.** "Shiftboard" is already a workforce scheduling company with apps in the App Store (Shiftboard, Inc., "ScheduleFlex by Shiftboard", "UKG Shiftboard"). Pick a store name after a trademark check before creating the app records. See [DECISION.md](DECISION.md#name-risk).
2. **Privacy policy and support pages**: fill in DubLow's legal name, address and support email, have them reviewed, and remove the DRAFT boxes (`web/public/privacy.html`, `web/public/support.html`).
3. **A stable public URL for those pages** on a DubLow domain (not one restaurant's deployment).
4. **A demo restaurant and demo account for App Review** (both stores sign in as a reviewer).
5. Real app icon and screenshots (the icons in `mobile/assets/images` are placeholders).
