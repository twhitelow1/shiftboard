# Developing the phone app

The app is in `mobile/`: Expo **SDK 58** (React Native 0.88, React 19.3), Expo Router, TypeScript. It has its own `package.json` and install; the root of the repo (server + website) doesn't depend on it, and Vercel ignores it (`.vercelignore`, `vercel.json` `excludeFiles`).

## Layout

```
mobile/
  brand.js            the app's name, invite-link scheme and permission texts: the one place to rename it
  app.json            slug, bundle ID / package, icons, plugins (notifications, localization…)
  app.config.js       name, scheme and permission texts from brand.js; Firebase's google-services.json from EAS
  eas.json            build profiles (development, preview, production) and submit settings. No secrets.
  assets/images/      icon, adaptive icon, splash, notification icon (placeholders)
  src/app/            screens (Expo Router: every file is a route)
    _layout.tsx         providers: language, session, toasts, theme; opens tapped notifications
    index.tsx           start: → /shifts, /sign-in or /welcome
    join.tsx            invite links: <scheme>://join?server=https://…
    (auth)/             welcome (restaurant address, the restaurants on this phone), sign-in, forgot
    (app)/(tabs)/       shifts, schedule (day / week), swaps, training or time-off (see navigation.ts), more
    (app)/              shift/[id] (section on the floor plan, call-out), notifications, request-time-off,
                        availability, my-time-off (Time Off with Training), tips, events/ (list, [id]), floor,
                        menu/[id], study (flashcards), quiz/[id], manual/[id], eighty-six, report-86
  src/navigation.ts   the tab list: Training is the 4th tab when the plan includes it, Time Off otherwise
  src/brand.ts        APP_NAME and the invite-link schemes, from brand.js
  src/components/     Screen (header, language button, offline note), ui, ShiftRow, Icon, DateRangePicker,
                      TimeField, TimeOffView, ModCard (manager on duty), CallOutPanel, Markdown, TrainingPhoto,
                      FloorPlan (react-native-svg), ShiftSection, WeekGrid, training/ (menu, quizzes, board, manual)
  src/i18n/           en.ts, es.ts (every word the app shows), index.tsx (t, plurals, dates, {app})
  src/lib/            api (server calls), session (restaurants, sign-in, bootstrap), cache (offline copies),
                      features (plan features), links (notification links → screens), hooks (useRpc, useAction),
                      push, storage (SecureStore), theme, schedule, time, training, minimark, money, events
```

The app keeps small typed copies of the helpers it needs from `core/` and `web/` instead of importing them, so Metro and EAS Build only need the `mobile/` folder. Keep them in step with the originals:

| Copy in mobile/ | Original |
|---|---|
| `src/lib/time.ts` (dates, `shiftSpan`, `effectiveShift`) | `core/time.js`, `core/forecast.js` |
| area grouping in `src/lib/schedule.ts` | `core/areas.js`, `web/src/pages/Schedule.jsx` |
| `src/lib/training.ts` (`localizeItem`, `localize`, `categoryLabel`) | `core/training.js` |
| `src/lib/minimark.ts` (manual page formatting) | `web/src/minimark.js` |
| drawing in `src/components/FloorPlan.tsx` (shapes, seats, halos) | `web/src/pages/FloorPlan.jsx`, `web/src/venue.css` |
| `src/lib/money.ts` (`fmtCents`) | `core/tips.js` |

## Renaming the app

"ShiftBoard" is a working name. Everything people see comes from **`mobile/brand.js`**:

1. Change `name` (and `scheme` if invite links should change; keep the old one in `oldSchemes` so pasted old links still work).
2. Check the camera / photo permission texts in the same file (they say `{app}`).
3. Rebuild (`npx eas-cli@latest build`). `app.config.js` puts the name under the icon (iOS and Android, English and Spanish), the scheme and the permission texts into the build; the app's own words say `{app}` in `src/i18n/en.ts` and `es.ts`, and `translate()` fills in the name.
4. Update the store text in [STORE-LISTING.md](STORE-LISTING.md) by hand, then in App Store Connect and the Play Console.

Don't change `slug`, the iOS bundle ID or the Android package in `app.json` after the first store release: they're the app's identity in Expo and the stores and are never shown. The keys the app keeps on the phone (`shiftboard.server`, `shiftboard.token.…`) stay too, so nobody is signed out by a rename.

## Several restaurants on one phone

Someone can work at two restaurants on the platform. The phone keeps a list of restaurants (`accounts` in secure storage: address, name, color, who's signed in) and **one session token per restaurant** (`token.<address>`). More → Restaurants switches between them without signing out; More → Add another restaurant goes back to the address screen, which lists the restaurants already on the phone (remove one with ×, which signs out of it there). Version 1's single saved restaurant and token are moved into the list on first launch.

Push keeps coming from every restaurant the person is signed in to (each server has the phone's push token). Tapping a notification from another restaurant opens that restaurant first: the notification's title is the restaurant's name. Signing out of one restaurant stops its notifications only.

## Plan features

On the multi-restaurant platform each restaurant's plan includes some features. The server sends them as `features` in `GET /api/config` and in `app.bootstrap` (`features` or `tenant.features`), e.g. `{ "training": true, "tips": false }`. `src/lib/features.ts` reads them; `has('tips')` is true unless the server says `false`, so **without a `features` object everything shows** (a restaurant on its own deployment, or an older server).

| Feature | What the app hides when it's off |
|---|---|
| `training` | the Training tab (Time Off becomes the 4th tab again), the manager on duty, the call-out panel |
| `tips` | My tips (More, My Shifts) |
| `eightySix` | the 86 List (More, My Shifts banner, Floor) and the "86'd today" badge in Training |
| `events` | Events & BEOs, links from the schedule and shifts |
| `forecast` | projected covers on the schedule |
| `venue` | sections and floor plans on shifts |

Notification links for a feature that's off open the notifications list. The server checks again: an RPC for a feature the plan doesn't include answers 403. Admins see the platform's billing note (`tenant.billing`: trial days left, payment failed) at the top of More.

## Offline

The last restaurant data the app loaded (`app.bootstrap`) and the data of My Shifts, the schedule (per week), the menu, the manual and the venue are kept on the phone (`src/lib/cache.ts`: small JSON files in the app's documents folder; `localStorage` on the web preview; no tokens). With no connection the app opens with them and says "No connection. Showing what you last saw (date, time)." Pull down to try again. `useRpc(method, args, deps, enabled, { cache: 'name' })` opts a screen in. Signing out of a restaurant deletes its copies.

## Notification links

Notifications carry the website's links; `src/lib/links.ts` turns them into screens:

| Link | Screen |
|---|---|
| `#/my`, `#/calendar` | My Shifts (`#/my/<shiftId>` or `#/shift/<id>` opens that shift) |
| `#/schedule[/<date>]` | Schedule |
| `#/swaps` | Trades |
| `#/timeoff`, `#/timeoff/availability` | Time Off (its tab, or `/my-time-off` with Training), My availability |
| `#/86[/<item or list id>]` | 86 List (that item highlighted) |
| `#/events[/<id>]` | Events, an event's BEO |
| `#/training/quizzes`, `/quiz/<attemptId>`, `/manual/<pageId>`, `/menu/<itemId>`, `/board` | Training tab, a quiz, a manual page, a menu item, the leaderboard |
| `#/tips[/<weekStart>]` | My tips for that week |
| anything else | Notifications |

Today the server links shift notifications to `#/my` (not to one shift); the app already opens a single shift if a link names it.

## Run it

```bash
cd mobile
npm install
npx expo start          # then: i (iOS simulator), a (Android emulator), or scan the QR code
```

- **Expo Go** (the store app) runs everything except push notifications: since SDK 53, Expo Go on Android can't receive push. Use Expo Go for screens and flows.
- **Development build** for push and anything native: `npx eas-cli@latest build --profile development --platform ios|android`, install it, then `npx expo start` and open it from the dev build. (Or locally: `npx expo run:ios` / `npx expo run:android` with Xcode / Android Studio.)

### In a browser: <restaurant>/app

Every deploy also builds the app's **browser version** into `dist/app` (`npm run build:app`: `expo export --platform web` with `WEB_BASE_URL=/app`), so it opens at **https://<restaurant's address>/app**, for example on an iPhone before there's a TestFlight build. It's the same screens and the same sign-in (with the second step); the restaurant is the site it's opened on (`src/lib/hosted.web.ts`), so there's no address to type, and the session stays in the browser's storage. No push notifications, camera or native modules there: it's for trying the app, not a replacement for the store app. Add it to the Home Screen from the browser's Share menu.

### On a phone, no computer (Expo Go + EAS Update)

Every push that changes `mobile/` runs **.github/workflows/expo-preview.yml**: it publishes the app to Expo with EAS Update (`eas update --auto`) under the expo.dev project **@dublow-digital/shiftboard**. Open the run in GitHub → Actions → "Phone app preview (Expo Go)": its summary has

- the `exp://u.expo.dev/<project id>/group/<update group>` link: open it on the phone (Expo Go installed) and the app loads,
- the update's page on expo.dev, and a QR code to scan from another screen.

On a pull request the same links go in a comment. It needs the **EXPO_TOKEN** repository secret (expo.dev → Account settings → Access tokens), and Expo Go from the store has to support the app's SDK (58): Expo Go only opens updates built for its own SDK (`runtimeVersion` policy `sdkVersion` → `exposdk:58.0.0`). Until the store's Expo Go is on SDK 58, use a development or preview build instead (`eas build --profile preview --platform android` gives an APK to install).

### Point it at a server

On the first screen, type the restaurant address:
- a deployment: `yourrestaurant.vercel.app` (https is added);
- your computer: start the API with demo data (`SEED_DEMO=true npm start` in the repo root, port 3000), then type your computer's LAN address, e.g. `192.168.1.20:3000` (plain http is allowed only for local addresses). The phone must be on the same Wi-Fi. If the phone refuses plain http, use an https tunnel to port 3000.

Sign in as `alexd@demo.shiftboard` / `demo1234` (employee) or `moe@demo.shiftboard` / `demo1234` (admin).

To test an invite link: `npx uri-scheme open "shiftboard://join?server=https%3A%2F%2Fyourrestaurant.vercel.app" --ios` (or `--android`), or make a QR code of that link and scan it with the phone's camera.

### Web preview (for quick checks and screenshots)

`npx expo export --platform web` builds `mobile/dist/` (a single-page app). Serve it **from the same origin as the API** so no CORS is needed, for example with the standalone server: `createApp({ db, staticDir: '<path to mobile/dist>' })` (see `server/index.js`), then open it and use that server's address. SecureStore isn't available in browsers, so the web build keeps the same values in `localStorage` (`src/lib/storage.web.ts`, `src/lib/cache.web.ts`), and push is off on web. (A second restaurant on another port needs CORS headers in the web preview only; phones don't use CORS.)

For upcoming shifts in the demo (its schedule is the week of Sept 28, 2026), sign in as an admin and copy that week forward: `shifts.copyWeek { fromWeek: '2026-09-28', toWeek: '<this week's Monday>' }`, then `shifts.publish { start, end }`. `sections.copy { fromDate: '2026-10-02', toDate: '<a Friday>' }` copies the Friday server sections.

Checking screens: walk them at 360 × 780 and 390 × 844, in English and Spanish, light and dark (Playwright against the web export works: `isMobile`, `locale: 'es-US'`, `colorScheme: 'dark'`). Look for text wider than the screen or cut off, and tap targets under 44 × 44.

## Checks

```bash
cd mobile
npx tsc --noEmit                      # types
npx expo-doctor                       # dependency and config checks (needs internet for 2 of the checks)
npx expo export --platform web        # web bundle
npx expo export --platform ios --platform android   # native JS bundles (Hermes)
```

Server side (repo root): `npm test` includes `test/mobile.test.js` (bearer sessions, device tokens, Expo push with a fake Expo API, language preference, deletion requests, the privacy/support pages).

## Languages (English and Spanish)

- Every string is in `src/i18n/en.ts` and `src/i18n/es.ts` (same keys; TypeScript fails if Spanish misses a key). No text in screens.
- `t('key', { name })` fills `{name}`; plurals are `{ one, other }` pairs used with `tn('key', count)`.
- Dates go through `Intl` (`date(d, 'short')` → "Thu, Dec 24" / "jue, 24 de dic"); times are written like the house schedule: `4p–CL` in English, `4 pm–cierre` in Spanish.
- Restaurant data (names, positions, areas, notes) and server texts (notifications, server error messages) are shown as they come. The server will localize notifications later using the `language` preference the app saves through `account.preferences`.
- The app follows the phone's language until the person picks one: the **language button at the top right of every screen** (globe + EN/ES, one tap switches), or More → Language (English / Español / same as my phone). One setting, saved on the phone and on the server.
- New words: add to both catalogs and to `docs/i18n/GLOSSARY.md` if it's a new term. Spanish runs 20–30% longer; check narrow screens (360 px).

## Talking to the server

| What | How |
|---|---|
| Is this a ShiftBoard server? Name, logo, color | `GET /api/config` → `{ email, brand: { name, color, logo, mode } }` |
| Sign in | `POST /api/auth/login` `{ email, password, client: 'mobile' }` → `{ ok, token, expiresIn }` (30 days) on one-step servers; on two-step servers `{ mfa: 'verify', ticket, methods }` or `{ mfa: 'enroll', ticket }` (see Two-step sign-in) |
| Second step | `POST /api/auth/mfa/verify` `{ ticket, method: 'totp' \| 'recovery', code, client: 'mobile' }` → `{ token, expiresIn }`; 401 / 429 carry `{ error }` |
| Set up an authenticator app in the app | `POST /api/auth/mfa/totp/setup { ticket }` → `{ secret, otpauthUrl }`, then `POST /api/auth/mfa/totp/confirm { ticket, code, client: 'mobile' }` → `{ recoveryCodes, token, expiresIn }` |
| Every call | `POST /api/rpc/<method>` with `Authorization: Bearer <token>` |
| Session ended | `401` → the app drops the token and shows sign-in |
| Password changed from the app | the response has `X-Session-Token`; the app keeps the new token |
| Forgot password | `POST /api/auth/forgot` `{ email }`; the emailed link opens the website's reset page |
| Push registration | `devices.register { token, platform }`, `devices.unregister { token }` (sign-out) |
| Menu and quiz photos | `GET /api/training/photos/:id`, `GET /api/training/quiz-photo/:attemptId/:key` with the bearer token (expo-image `headers`) |
| 86 List photos | `GET /api/eighty-six/photos/:id` with the bearer token |
| Plan features | `features` in `/api/config` and `app.bootstrap` (see Plan features) |
| Language | `account.preferences { language: 'en' \| 'es' \| '' }` |
| Delete my account | `account.requestDeletion` (notifies the person's managers) |
| Calendar link | `POST /api/rpc-ical-link` → opens as `webcal://` |

Old app versions stay on phones for weeks after a release, so server changes must stay backward compatible.

## Two-step sign-in

Sign-in is becoming two-step on the server (an authenticator-app code or a passkey after the password; never SMS codes). The app follows the contract above and works with both server versions (`src/lib/api.ts` `login()` returns `token`, `verify` or `enroll`; `src/app/(auth)/sign-in.tsx` shows the steps):

- **verify**: "Enter the 6-digit code from your authenticator app" (the phone offers the code from Messages/Mail autofill, `oneTimeCode`), with "Use a recovery code". A wrong code or too many tries shows the server's `{ error }`.
- **enroll** (no second step yet): "Finish setting up your account in the browser" opens `<server>/#/security-setup` in the system browser; "I'm done, sign in again" goes back to the password. Or "set up an authenticator app here": the setup key (and a button that opens the authenticator app with the `otpauth://` link), the first code, then the recovery codes, shown once with Share, before the app signs in.
- **Passkeys and email-link sign-in are web-only for now**: an account that only has a passkey gets "Sign in on the website". No native passkey modules.
- The ticket lasts 10 minutes. After that (or when the server says the sign-in expired) the app goes back to the password and says why.
- The session token that comes back is stored and used exactly as before (secure storage, `Authorization: Bearer`).

## Push notifications

1. After sign-in the app asks for permission (once), gets an **Expo push token** for this phone (needs the EAS project ID from `eas init`) and calls `devices.register`. The server stores `{ userId, token, platform, createdAt }` in `deviceTokens` (one owner per phone, at most 10 phones per person, tied to the session version so a password change stops pushes to old sessions).
2. Whenever a request creates in-app notifications, `server/app.js` `onCommit` emails them (if email is on) and calls `pushToPhones`: `server/expo-push.js` sends them through `https://exp.host/--/api/v2/push/send` in batches of 100, with the restaurant name as the title, the notification text as the body, the unread count as the badge and the link in `data`.
3. Tickets with `DeviceNotRegistered` delete the token. Ticket IDs are kept in `pushTickets`; on later sends, receipts older than 15 minutes are checked and `DeviceNotRegistered` receipts delete the token too.
4. Tapping a notification opens the matching screen (see Notification links), in the right restaurant when the phone has more than one.
5. Signing out calls `devices.unregister`.

Credentials: iOS APNs key and Android FCM v1 key live in EAS (runbook section 7). Server env: `EXPO_PUSH=off` turns push off; `EXPO_ACCESS_TOKEN` only if Expo enhanced push security is on.

## Build and submit with EAS

```bash
cd mobile
npx eas-cli@latest login
npx eas-cli@latest build --platform all --profile production     # store builds (.ipa + .aab)
npx eas-cli@latest submit --platform ios --latest                # → App Store Connect / TestFlight
npx eas-cli@latest submit --platform android --latest            # → Play internal testing (draft)
```

| Profile | For | Notes |
|---|---|---|
| `development` | developers | dev client (`expo-dev-client`), internal distribution (ad hoc on iOS: register test iPhones with `eas device:create`) |
| `preview` | quick internal installs | Android APK, iOS ad hoc; not for the stores |
| `production` | the stores | build numbers auto-increment |

Credentials (certificates, profiles, keystore, push keys, store API keys) are **managed by EAS**; nothing secret is in the repo. `eas.json` `submit.production.ios.ascAppId` can hold the App Store Connect app ID (not secret) once the app record exists.

## Versions

- `mobile/app.json` `version` is what people see (`1.0.0`). Bump it for each store release: patch for fixes (1.0.1), minor for features (1.1.0).
- Build numbers (iOS `buildNumber`, Android `versionCode`) are kept by EAS (`"appVersionSource": "remote"`) and go up on every production build (`autoIncrement`). Don't set them in app.json.
- Upgrading Expo: one SDK at a time (`npx expo install expo@^59 --fix`), read the SDK changelog, run the checks, test on both platforms. Google Play needs a recent target API level (Android 16 / API 36 for new apps since Aug 31, 2026).
- Over-the-air updates (`eas update`) aren't set up yet. Adding them needs `expo-updates` and a channel per profile.
