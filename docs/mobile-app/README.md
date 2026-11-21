# ShiftBoard phone app (iPhone and Android)

ShiftBoard's staff app for iPhone and Android, built with **Expo (React Native)**. DubLow Digital publishes it once in the **Apple App Store** and **Google Play**. Every restaurant uses the same app, and each person connects it to their own restaurant's ShiftBoard.

**Status (Nov 2026):** first version built (`mobile/`), with its server support (bearer sign-in, push). Not yet in either store. The developer accounts and app records are next: see the [runbook](REGISTRATION-RUNBOOK.md).

## What's in v1

For staff first:

| Screen | What it does |
|---|---|
| Restaurant address | Pick the restaurant once: type its ShiftBoard address, or open the invite link or QR code. The app remembers it. Change it in More. |
| Sign in / Forgot password | Same email and password as the website. "Forgot password" emails a link, and the reset itself happens on the website. |
| My Shifts | The next shift, open shifts I can pick up, my shifts week by week, my time off. |
| Schedule | The whole team's posted schedule, one day at a time, grouped by area and position like the website's day view. |
| Trades | Trade or give away a shift. Accept trades, pick up giveaways and open shifts. My requests. Shift leads and managers also see requests to approve. |
| Time Off | Request time off on a calendar. See and cancel my requests. Approvers can approve. |
| Notifications | The bell list. Push notifications to the phone too. |
| More | Profile, language, notifications, add my shifts to my calendar, Training (coming soon), open the full website, change restaurant, privacy, help, delete my account, sign out. |

- **English and Spanish** on every screen. Switch with the language button at the top right of every screen (globe + EN/ES), or in More → Language. Spanish is neutral Latin American (es-419), using "tú". See the [glossary](../i18n/GLOSSARY.md).
- **The restaurant's look**: its brand color and logo (from Settings → Branding on the website), and light or dark mode.
- **Not in the app yet**, still on the website: building and publishing schedules, settings, team, forecasting, events/BEOs, venue. The app links to the full website in More. Others are building web push, text messages, Toast, tip pool, rooms/tables and the Training portal. Training gets a tab when it's ready (see `mobile/src/navigation.ts`).

## How the pieces fit

```
                 ┌───────────── one app in the stores (DubLow Digital) ─────────────┐
                 │  mobile/  Expo React Native · iOS + Android                        │
                 │  remembers: restaurant address, sign-in token (secure storage),    │
                 │  push token, language                                              │
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
- **One app, many restaurants.** Each restaurant is its own deployment with its own address and database. The app asks for the restaurant's address once, or takes it from an invite link `shiftboard://join?server=https://<address>` (a QR code can hold the same link). See [DECISION.md](DECISION.md#restaurant-address).
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
