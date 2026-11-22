# Developing the phone app

The app is in `mobile/`: Expo **SDK 58** (React Native 0.88, React 19.3), Expo Router, TypeScript. It has its own `package.json` and install; the root of the repo (server + website) doesn't depend on it, and Vercel ignores it (`.vercelignore`, `vercel.json` `excludeFiles`).

## Layout

```
mobile/
  app.json            name, bundle ID / package, scheme "shiftboard", icons, plugins (notifications, localization…)
  app.config.js       adds Firebase's google-services.json from EAS (Android push); everything else is app.json
  eas.json            build profiles (development, preview, production) and submit settings. No secrets.
  assets/images/      icon, adaptive icon, splash, notification icon (placeholders)
  src/app/            screens (Expo Router: every file is a route)
    _layout.tsx         providers: language, session, toasts, theme
    index.tsx           start: → /shifts, /sign-in or /welcome
    join.tsx            invite links: shiftboard://join?server=https://…
    (auth)/             welcome (restaurant address), sign-in, forgot
    (app)/              signed-in screens; (tabs)/ shifts, schedule, swaps, time-off, more
                        shift/[id], notifications, request-time-off, training (placeholder)
  src/navigation.ts   the tab list (Training slots in here)
  src/components/     Screen (header with language button), ui, ShiftRow, Icon, DateRangePicker
  src/i18n/           en.ts, es.ts (every word the app shows), index.tsx (t, plurals, dates)
  src/lib/            api (server calls), session, push, storage (SecureStore), theme, schedule helpers,
                      time (a typed copy of core/time.js)
```

The app keeps small typed copies of the helpers it needs from `core/` (`src/lib/time.ts`, the area grouping in `src/lib/schedule.ts`) instead of importing `../core`, so Metro and EAS Build only need the `mobile/` folder. Keep them in step with `core/time.js` and `core/areas.js`.

## Run it

```bash
cd mobile
npm install
npx expo start          # then: i (iOS simulator), a (Android emulator), or scan the QR code
```

- **Expo Go** (the store app) runs everything except push notifications: since SDK 53, Expo Go on Android can't receive push. Use Expo Go for screens and flows.
- **Development build** for push and anything native: `npx eas-cli@latest build --profile development --platform ios|android`, install it, then `npx expo start` and open it from the dev build. (Or locally: `npx expo run:ios` / `npx expo run:android` with Xcode / Android Studio.)

### Point it at a server

On the first screen, type the restaurant address:
- a deployment: `yourrestaurant.vercel.app` (https is added);
- your computer: start the API with demo data (`SEED_DEMO=true npm start` in the repo root, port 3000), then type your computer's LAN address, e.g. `192.168.1.20:3000` (plain http is allowed only for local addresses). The phone must be on the same Wi-Fi. If the phone refuses plain http, use an https tunnel to port 3000.

Sign in as `alexd@demo.shiftboard` / `demo1234` (employee) or `moe@demo.shiftboard` / `demo1234` (admin).

To test an invite link: `npx uri-scheme open "shiftboard://join?server=https%3A%2F%2Fyourrestaurant.vercel.app" --ios` (or `--android`), or make a QR code of that link and scan it with the phone's camera.

### Web preview (for quick checks and screenshots)

`npx expo export --platform web` builds `mobile/dist/` (a single-page app). Serve it **from the same origin as the API** so no CORS is needed, for example with the standalone server: `createApp({ db, staticDir: '<path to mobile/dist>' })` (see `server/index.js`), then open it and use that server's address. SecureStore isn't available in browsers, so the web build keeps the same values in `localStorage` (`src/lib/storage.web.ts`), and push is off on web.

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
| Sign in | `POST /api/auth/login` `{ email, password, client: 'mobile' }` → `{ token, expiresIn }` (30 days) |
| Every call | `POST /api/rpc/<method>` with `Authorization: Bearer <token>` |
| Session ended | `401` → the app drops the token and shows sign-in |
| Password changed from the app | the response has `X-Session-Token`; the app keeps the new token |
| Forgot password | `POST /api/auth/forgot` `{ email }`; the emailed link opens the website's reset page |
| Push registration | `devices.register { token, platform }`, `devices.unregister { token }` (sign-out) |
| Language | `account.preferences { language: 'en' \| 'es' \| '' }` |
| Delete my account | `account.requestDeletion` (notifies the person's managers) |
| Calendar link | `POST /api/rpc-ical-link` → opens as `webcal://` |

Old app versions stay on phones for weeks after a release, so server changes must stay backward compatible.

## Push notifications

1. After sign-in the app asks for permission (once), gets an **Expo push token** for this phone (needs the EAS project ID from `eas init`) and calls `devices.register`. The server stores `{ userId, token, platform, createdAt }` in `deviceTokens` (one owner per phone, at most 10 phones per person, tied to the session version so a password change stops pushes to old sessions).
2. Whenever a request creates in-app notifications, `server/app.js` `onCommit` emails them (if email is on) and calls `pushToPhones`: `server/expo-push.js` sends them through `https://exp.host/--/api/v2/push/send` in batches of 100, with the restaurant name as the title, the notification text as the body, the unread count as the badge and the link in `data`.
3. Tickets with `DeviceNotRegistered` delete the token. Ticket IDs are kept in `pushTickets`; on later sends, receipts older than 15 minutes are checked and `DeviceNotRegistered` receipts delete the token too.
4. Tapping a notification opens the matching screen (`#/my` → My Shifts, `#/swaps` → Trades, `#/timeoff` → Time Off; others → Notifications).
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
