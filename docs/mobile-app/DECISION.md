# Decision: a real phone app with Expo, one app for every restaurant

- **Status:** decided by DubLow Digital (owner), November 2026
- **Applies to:** `mobile/`, the server's mobile support (`server/app.js` bearer sign-in, `server/expo-push.js`, `devices.*` RPCs), the store listings

## Context

ShiftBoard is a restaurant scheduling app (7shifts-style). Chasing Rabbits uses it first, and DubLow Digital will resell it to other restaurants. Today it is a React web app plus an Express API on Vercel; each restaurant has **its own deployment** (its own web address and database). Staff mostly use it on their phones, in the browser.

Staff ask for a "real app": an icon on the home screen, sign in once, and a buzz when the schedule is posted or someone wants their shift. 7shifts, Homebase and When I Work all have store apps, and restaurants expect one.

## Decision

1. **Build a native app with Expo (React Native)** and publish it in the **Apple App Store** and **Google Play**.
2. **One app for all restaurants.** Each person points the app at their restaurant once, with a **restaurant address** or an **invite link / QR code**. See [Restaurant address](#restaurant-address) below.
3. **Published under DubLow Digital's own developer accounts**: an Apple Developer Program **organization** membership and a Google Play Console **organization** account, both in DubLow's legal name. The Expo (EAS) account that builds the app also belongs to DubLow.
4. **Same server and API as the website.** The app is another client of `POST /api/rpc/<method>`. Every permission check stays in `core/service.js`. The server got small additions: a bearer token at sign-in, push token registration, and Expo push after each change.
5. **English and Spanish from day one**, with a language button on every screen.

## Alternatives considered

| Option | Why not (for now) |
|---|---|
| **PWA only** (add the website to the home screen) | Cheapest, and we keep it: the website still works on phones. But on iPhone, web push only works after the person adds the site to the home screen (iOS 16.4+), which most staff never do. No store presence, so restaurants can't tell staff to "get the app". Sign-in is lost more often (Safari clears site data). Others are adding web push to the website anyway, so both paths exist. |
| **Capacitor** (wrap the existing React website in a native shell) | Fast to ship, reuses the web UI. But Apple rejects apps that are mostly a repackaged website (App Review Guideline 4.2, "Minimum Functionality"), so we'd need native screens anyway. The web UI is built for a manager's desktop as much as for phones. A wrapper also inherits the cookie session, which is awkward across many restaurant domains. |
| **One app per restaurant** (white-label: "Chasing Rabbits Schedule") | Each restaurant's own name and icon in the store. But every restaurant needs its own store listing, review, screenshots, privacy forms and updates: N times the work for every release. Apple's Guideline 4.3 (spam) discourages many near-identical apps from one developer; the usual answer is to publish under each client's own developer account, which makes every restaurant buy and run accounts. Not worth it at our size. We can revisit for a large chain. |
| **Flutter or fully native (Swift + Kotlin)** | Good results, but a second language and codebase. Expo uses the TypeScript/React skills the web app already uses, and EAS builds and signs iOS apps without a Mac. |

## Restaurant address

Each restaurant is its own deployment (for example `https://shiftboard-gamma.vercel.app`), so the app must learn which one to use.

- **First launch:** "Your restaurant's ShiftBoard address". People type the web address they already use (`yourrestaurant.vercel.app`; `https://` is added). The app checks it really is ShiftBoard (`GET /api/config`) and shows the restaurant's name and logo on the sign-in screen.
- **Invite link / QR code:** `shiftboard://join?server=https://<address>`. Opening it (or scanning a QR code of it with the phone's camera) opens the app on a "Join <restaurant>?" screen that shows the name and address before switching, so a link can't quietly point the app somewhere else.
- **Remembered on the phone** (secure storage), with the sign-in token. **Easy to change:** More → Change restaurant, or "Not your restaurant? Change" on the sign-in screen.
- **Rules:** `https://` only, except `http://` for test servers on a local network. Pasting a full link (`https://…/#/my`) or an invite link into the field works too.
- **Later:** an `https://<restaurant>/app` page with store badges and the QR code, and universal links (Apple) / app links (Android). Those need each restaurant's domain to publish `apple-app-site-association` and `assetlinks.json` files, which is more setup per restaurant, so v1 uses the custom scheme. If DubLow moves to one shared multi-restaurant server, the address step becomes a restaurant picker.

## Sign-in and sessions

- `POST /api/auth/login` with `{ email, password, client: 'mobile' }` returns `{ token }` instead of setting a cookie. It is the same JWT the website keeps in its cookie, with the same 30-day expiry and the same rule that a password change or reset signs out every device (`sessionVersion`).
- The app sends `Authorization: Bearer <token>`. It keeps the token in the phone's secure storage (Keychain / Android Keystore via `expo-secure-store`).
- An expired or revoked session gives `401`; the app drops the token and goes back to sign-in with a note.
- Changing the password from the app returns a fresh token in the `X-Session-Token` header.

## Name risk

"**Shiftboard**" is already the name of a workforce scheduling company (Shiftboard, Inc., now with "ScheduleFlex by Shiftboard" and "UKG Shiftboard" apps in the App Store), in the same category. Publishing a scheduling app named "ShiftBoard" risks a trademark complaint and store rejection or removal. **The owner must pick the store name** after a trademark search, before creating the app records. The bundle ID `com.dublowdigital.shiftboard` doesn't show to users and can stay either way. The app's display name is one line in `mobile/app.json`.

## Consequences and costs

**Money (2026 prices, check at signup):**

| Item | Cost | Notes |
|---|---|---|
| Apple Developer Program (organization) | **99 USD per year** | Renews yearly. If it lapses, the app leaves the App Store. |
| Google Play Console | **25 USD once** | Organization account. |
| D-U-N-S number | Free | From Dun & Bradstreet. Up to 5 business days, plus up to 2 for Apple to see it. |
| Expo EAS | Free plan to start | The free plan has a monthly build quota in a low-priority queue (about 30 builds a month, fewer for iOS). Starter is about 19 USD/month if builds get slow or frequent. |
| Push (Expo Push API, APNs, FCM) | Free | |

**Time:** organization enrollment needs D-U-N-S and identity checks. Apple gives no fixed time (developers report days to several weeks). Google verifies the organization, website and phone. Plan 2 to 4 weeks before the first public release. App Review usually takes a day or two per version. Google Play's 12-testers-for-14-days rule applies to new *personal* accounts, so we use an *organization* account (confirm on the signup page).

**Upkeep:**
- Renew Apple every year. Keep the agreements accepted in App Store Connect (new versions of the license agreement block uploads until accepted).
- Upgrade the Expo SDK about twice a year. Google Play requires apps to target a recent Android version (new apps must target Android 16, API 36, since August 31, 2026), and Apple requires recent Xcode/iOS SDKs. Old SDKs stop being accepted.
- Keep the store privacy answers, age rating questionnaire (Apple added new questions in 2025–2026) and screenshots current.
- Each server change that the app relies on must stay backward compatible, because phones run older app versions for weeks after a release.
- A demo restaurant and demo account must stay up for App Review.

**Good:** a real app with push, one codebase for iOS and Android, no Mac needed (EAS builds in the cloud), the same rules as the website because the server does the checks.

**Watch:** two clients to keep in step with the API; translation of new strings (English and Spanish catalogs in `mobile/src/i18n/`); notifications from the server are still English only (the server will send Spanish ones later, using the `language` preference the app saves).
