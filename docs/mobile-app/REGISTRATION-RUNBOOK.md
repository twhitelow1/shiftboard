# Registration runbook: developer accounts and app records for the ShiftBoard app

**Who this is for:** a browser-based AI agent (for example an AI driving Chrome on the owner's computer) working **with the owner of DubLow Digital**, who stays at the computer. The agent does the clicking and typing of non-secret information; the owner does everything in the [human-only list](#the-human-does-these).

**Researched:** November 2026, from developer.apple.com, App Store Connect Help, Google Play Console Help and docs.expo.dev. Screens change. Button names below are as of that research; match them by meaning, and **stop and ask when the screen doesn't match** (rule 5).

Related: [RECORD.md](RECORD.md) (write down IDs here), [STORE-LISTING.md](STORE-LISTING.md) (all store text and privacy answers), [DEVELOPING.md](DEVELOPING.md) (build commands), [DECISION.md](DECISION.md).

---

## Hard rules for the agent

1. **Never type a secret.** Passwords, two-factor codes, card numbers, bank details, tax IDs, API keys, private key files (`.p8`, `.p12`, `.json` service account keys, keystores), recovery codes. When a field asks for one, STOP and hand over.
2. **Never paste or repeat a secret** into chat, a document, RECORD.md, a commit, an issue or a ticket, even if it is on screen. If you see one, don't read it back.
3. **Only record non-secret IDs** in [RECORD.md](RECORD.md): team IDs, app IDs, bundle IDs, package names, project IDs, dates, statuses, who did what.
4. **Don't pay, sign, verify or publish.** Never click a button that pays, accepts a legal agreement, submits identity or organization verification, sends an app to review, or makes anything public. Those are the owner's clicks (see below). Stop right before them, say what the button is, and wait.
5. **Stop and ask when the screen differs from this doc**: a different button name, an extra question, an error, a warning, a price that doesn't match, or anything you're not sure about. Describe what you see. Don't guess.
6. **Use only DubLow Digital's accounts** that the owner signed in to. Don't create accounts in your own name or with personal details other than the owner's.
7. **One section at a time.** At each 🛑 STOP and at the end of each section, add a dated line to the RECORD.md log: what was done, by whom (agent / owner), and what is next.
8. **Don't change** anything outside this app: other apps, other users' roles, billing settings, existing domains or DNS (unless a step says so and the owner agrees).

### 🛑 STOP points

A STOP looks like this:

> 🛑 **STOP: owner.** What the owner must do. What to tell them. How to tell it's done.

At a STOP: tell the owner exactly what is needed, wait until they say it's done, check the success sign, then continue.

### The human does these

- Paying any fee (Apple 99 USD/year, Google 25 USD once, any Expo plan).
- Accepting any legal agreement or terms (Apple Program License Agreement, App Store Connect agreements, Google Developer Distribution Agreement, Expo terms).
- Entering passwords, two-factor codes, card numbers, bank or tax details.
- Identity and organization verification (ID photos, business documents, phone calls with Apple or D&B, D-U-N-S requests in DubLow's name).
- Answering legal declarations (EU trader status, export compliance, content rating, target audience, government/financial/health declarations) after the agent fills in the suggested answers.
- Anything that publishes publicly or sends to review: "Submit for Review", "Publish", "Start rollout to Production", making a test public.
- Downloading, uploading or moving key files (APNs `.p8`, Google service account `.json`, keystores).

---

## Values to use

| Item | Value | Notes |
|---|---|---|
| Developer (legal entity) | **[DubLow Digital's exact legal name, e.g. "DubLow Digital LLC"]** | Must match the D-U-N-S record and state registration. No DBAs or trade names (Apple refuses them). |
| D-U-N-S number | in RECORD.md (it's not secret, but only the owner confirms it) | |
| Company website | **[DubLow's public website on its own domain]** | Must be live with real content (Apple and Google check it). |
| Work email | **[an address on DubLow's domain]** | Apple asks for an email on the organization's domain. |
| App name (store) | **Working name: ShiftBoard.** 🛑 Owner picks the final store name first. | "Shiftboard" is an existing scheduling company's name (see [DECISION.md](DECISION.md#name-risk)). Max 30 characters. |
| iOS bundle ID | `com.dublowdigital.shiftboard` | Matches `mobile/app.json`. Can't change after the first upload. |
| Android package name | `com.dublowdigital.shiftboard` | Matches `mobile/app.json`. Permanent once uploaded. |
| SKU (Apple, internal) | `shiftboard-ios-001` | Only DubLow sees it. |
| Primary language | English (U.S.) | |
| Other listing languages | Apple: **Spanish (Mexico)**. Google: **Spanish (Latin America) es-419** and **Spanish (United States) es-US**. | Apple has no "Spanish (US)"; Spanish (Mexico) is the one that shows on the US store (confirm in the language menu). Text is in STORE-LISTING.md. |
| Category | **Business** (Apple primary; secondary optional: Productivity). Google: **Business**. | |
| Price | **Free**, no in-app purchases, no ads | |
| Availability | **United States** to start (owner decides) | Keeps the EU trader question simpler; add countries later. |
| Support URL | `https://[stable DubLow URL]/support` | Every ShiftBoard deployment serves `/support`. Use one DubLow controls, not a single restaurant's. |
| Privacy policy URL | `https://[stable DubLow URL]/privacy` | 🛑 The page is a DRAFT until the owner reviews it (`web/public/privacy.html`). |
| Account / data deletion URL (Google) | `https://[stable DubLow URL]/support#delete-account` | |
| Marketing URL (optional) | DubLow's website | |
| Store contact email | **[support email on DubLow's domain]** | Public on Google Play. |
| Store contact phone | **[optional; owner decides]** | |
| Review demo restaurant | `https://[demo deployment address]` | A deployment with `SEED_DEMO=true` that stays up. |
| Review demo account | `reviewer@[demo domain]` | **Password: the owner types it** in the review form. It lives in the password manager, never in docs. |
| Expo account | organization `dublowdigital` (proposed) | |
| EAS project slug | `shiftboard` | From `mobile/app.json`. |

---

## 1. D-U-N-S number (check or get one)

Apple and Google both need DubLow Digital's D-U-N-S number (a free 9-digit ID from Dun & Bradstreet) for an **organization** account.

1. Ask the owner for DubLow's **exact legal name**, **headquarters address**, **mailing address**, and a **work contact** (name, work email, phone).
   - Success: you have all four. If DubLow is a sole proprietorship, STOP: Apple only enrolls legal entities (LLC, corporation, partnership) as organizations, so the owner must decide (form an LLC, or enroll as an individual).
2. Open **https://developer.apple.com/enroll/duns-lookup/**. If asked to sign in, 🛑 STOP: the owner signs in with DubLow's Apple Account (step 2.1 covers making one).
3. Enter the legal entity name, headquarters address, mailing address and work contact. Look it up.
   - Success: a match with DubLow's legal name and address. Write "D-U-N-S on file: yes" and the number in RECORD.md (the number isn't secret, but ask the owner to confirm it's the right company).
   - "Your organization is not listed as a legal entity": STOP and tell the owner. D&B lists the business as something else (e.g. sole proprietorship); they fix it with D&B with registration documents.
4. **No match:** the page offers to submit the information to D&B for a free D-U-N-S number.
   > 🛑 **STOP: owner.** Submitting the request is done in DubLow's name and D&B may call or email the owner for documents (business registration). The owner reviews and submits. It takes **up to 5 business days**; expediting doesn't shorten it. Then allow **up to 2 more business days** before Apple can see it. If it takes over two weeks: https://support.dnb.com/?CUST=APPLEDEV.
5. Log in RECORD.md: date, D-U-N-S status, number (when issued).

## 2. Apple Developer Program (organization)

Cost: **99 USD per membership year** (shown in local currency). The person who enrolls becomes the **Account Holder** and must be able to sign contracts for DubLow (owner, founder, executive, or someone given that authority).

Before starting, check with the owner:
- an **Apple Account** for DubLow with **two-factor authentication on**, ideally using a DubLow work email, with the owner's **legal first and last name** (not a nickname or company name, which delays approval);
- the **D-U-N-S number** from step 1;
- DubLow's **website is live** on its own domain (not a social page or a parked domain);
- the owner can take a call or email from Apple to confirm their authority (if they aren't the owner/founder, Apple asks for a reference who confirms it).

Steps:
1. If DubLow has no Apple Account yet: 🛑 **STOP: owner** creates it at https://account.apple.com (password and 2FA are theirs), then signs in.
2. Open **https://developer.apple.com/programs/enroll/** and click **Start your enrollment**. (Organizations can also enroll in the **Apple Developer** app on iPhone/iPad/Mac. Either works.)
   > 🛑 **STOP: owner** signs in with DubLow's Apple Account (password + 2FA code).
3. Choose to enroll as an **organization** (company), not as an individual.
4. Fill in what's asked with the [values above](#values-to-use): legal entity name, D-U-N-S number, headquarters address and phone, website, work email, and the Account Holder's details as the owner tells you.
   - Success: a summary page to review.
   > 🛑 **STOP: owner** reviews the details and submits. Submitting starts Apple's verification of the organization and of the owner's authority.
5. Apple verifies (by email, sometimes a phone call or a request for documents). Apple gives no fixed time; developers report from a few days to several weeks. **Answer Apple's emails quickly**; enrollments are declined when requests go unanswered.
6. When Apple emails that verification is done:
   > 🛑 **STOP: owner** opens the email link, **accepts the Apple Developer Program License Agreement** and **pays 99 USD**. Then they get an order email and a confirmation email.
7. Check **https://developer.apple.com/account**: Membership details show **Apple Developer Program, Organization**, DubLow's name, and the **Team ID** (10 characters). Write the Team ID, enrollment date and renewal date in RECORD.md. If no confirmation within 24 hours of paying, the owner contacts Apple Developer Support with the Enrollment ID.

## 3. App Store Connect setup and the app record

App Store Connect: **https://appstoreconnect.apple.com**.

### 3.1 Agreements, trader status and team

1. Open **Business** (https://appstoreconnect.apple.com/business). Look at **Agreements**.
   - The free-apps agreement is the Apple Developer Program License Agreement (accepted at enrollment). ShiftBoard is free with no in-app purchases, so the **Paid Apps Agreement, tax forms and banking are not needed**.
   - If any agreement shows "pending" or "new terms": 🛑 **STOP: owner** reads and accepts it (new apps can't be added until the Account Holder accepts the latest agreement).
2. **EU Digital Services Act trader status.** Apple asks every developer to declare it, even with no EU distribution. It's under **Business → Agreements → Compliance → Complete Compliance Requirements** next to "Digital Services Act".
   > 🛑 **STOP: owner** answers. A business distributing apps is usually a trader; if DubLow declares trader status, its address, phone and email are shown on EU product pages and Apple verifies them. Distributing only in the US (our plan) avoids EU product pages for now. Apple can't decide this for the developer.
3. **Users and Access**: leave as is. If a developer (or a coding agent account) needs access, 🛑 the owner invites them with the **App Manager** or **Developer** role.

### 3.2 Register the bundle ID

(EAS can also do this during the first build. Doing it by hand first makes the app record step simpler.)

1. Open **https://developer.apple.com/account/resources/identifiers/list** (Certificates, Identifiers & Profiles → **Identifiers**). Click the **+** button.
2. Select **App IDs** → **Continue** → type **App** → **Continue**.
3. **Description:** `ShiftBoard`. **Bundle ID:** **Explicit**, `com.dublowdigital.shiftboard`.
4. Capabilities: tick **Push Notifications**. Leave the others as they are.
5. **Continue** → check the summary → **Register**.
   - Success: `com.dublowdigital.shiftboard` is in the Identifiers list. Write "bundle ID registered" + date in RECORD.md.

### 3.3 Create the app record

> 🛑 **STOP: owner** confirms the final **store name** (see Values; "ShiftBoard" is a working name with a trademark risk).

1. App Store Connect → **Apps** → the **+** button (top left) → **New App**. (Needs the Account Holder, Admin or App Manager role.)
2. Fill in:
   - **Platforms:** iOS
   - **Name:** the store name the owner chose (max 30 characters; must be unique in the App Store)
   - **Primary Language:** English (U.S.)
   - **Bundle ID:** `com.dublowdigital.shiftboard`
   - **SKU:** `shiftboard-ios-001`
   - **User Access:** Full Access
3. Click **Create**.
   - Success: the app opens with status **Prepare for Submission**. The **Apple ID** of the app (a number, under App Information → General Information) is the **App Store Connect app ID**. Write it in RECORD.md; a developer adds it to `mobile/eas.json` as `submit.production.ios.ascAppId` (it is not secret).
4. **App Information:** Subtitle (from STORE-LISTING.md), **Category: Business** (secondary: Productivity, optional), Content Rights: "No, it does not contain, show, or access third-party content" (confirm with the owner).
5. **Localizations:** add **Spanish (Mexico)** with the Spanish name, subtitle and texts from STORE-LISTING.md.
6. **Pricing and Availability:** Price **Free (USD 0)**. Availability: **United States** (owner may add more).
   > 🛑 **STOP: owner** confirms the countries.
7. **App Privacy** (sidebar). Click **Get Started** → "Yes, we collect data from this app" → **Next**. Select the data types listed in [STORE-LISTING.md → Apple App Privacy](STORE-LISTING.md#apple-app-privacy-nutrition-label) and answer each one's questions exactly as listed there. **Save**.
   - Next to **Privacy Policy**, click **Edit** and enter the privacy policy URL (and the Spanish one for Spanish (Mexico): same URL + `#es`).
   > 🛑 **STOP: owner** reviews the answers and clicks **Publish** (they go live with the product page).
8. **Age Rating** (App Information → Age Rating → Edit). Apple's questionnaire was updated in 2025–2026 (new 13+/16+/18+ tiers; new content descriptors from November 16, 2026, required for all apps by January 12, 2027). Suggested answers are in STORE-LISTING.md (all "None/No"; it's a workplace tool with no web browsing, gambling, mature content or public social features).
   > 🛑 **STOP: owner** confirms the answers, especially the questions about user-generated content and messaging (coworkers can add short notes to trade and time-off requests, seen only by people at the same restaurant).
9. **App Review Information** (on the version page, filled in at submission time in section 8): sign-in required = yes; the demo username; **the password is typed by the owner**; contact name/phone/email; notes from STORE-LISTING.md.
10. **Export compliance:** the app only uses standard HTTPS, and `ITSAppUsesNonExemptEncryption = false` is already set in `mobile/app.json`, so builds shouldn't ask. If App Store Connect asks anyway: 🛑 owner answers.

## 4. Google Play Console (organization)

Cost: **25 USD once**. Signup: **https://play.google.com/console/signup**.

Before starting, check with the owner:
- a **Google Account** for DubLow (ideally a shared DubLow address, not a personal Gmail), with 2-step verification;
- the **D-U-N-S number**; the legal name and address are taken from the D-U-N-S profile;
- DubLow's **website**, which Google verifies through **Google Search Console** (https://search.google.com/search-console);
- a **contact email and phone** that Google checks with one-time codes;
- the owner's **government ID**, and possibly an official organization document (certificate of incorporation, etc.).

Why organization: new **personal** accounts created after November 13, 2023 must run a **closed test with at least 12 testers opted in for 14 days in a row** before they can apply for production access. That rule is for personal accounts; organization accounts (registered with a D-U-N-S number) don't have it (third-party guides agree; 🛑 confirm on the signup page). The account type **can't be changed later**.

Steps:
1. Open https://play.google.com/console/signup.
   > 🛑 **STOP: owner** signs in to DubLow's Google Account (password, 2-step code).
2. Choose the account type **Organization** (the page may call it "an organization or business"). Double-check: this can't be changed.
3. Fill in the developer profile with the [values above](#values-to-use): developer name (shown on Google Play), organization details and D-U-N-S, website, contact name, email and phone, and the public developer email.
   - Website: if asked to verify it in **Google Search Console**: 🛑 **STOP: owner** (it needs a DNS record or a file on DubLow's site; the owner or their web person adds it).
   - Email and phone one-time codes: 🛑 **STOP: owner** types the codes.
4. > 🛑 **STOP: owner** accepts the **Developer Distribution Agreement** and Play Console terms, pays the **25 USD** registration fee, and completes **identity verification** (government ID; organization documents if asked).
5. Google verifies the organization. You'll see the status on the Play Console home page.
   - Success: Play Console opens with no verification banner. Write the **developer account ID** (in Play Console → **Settings → Developer account → Account details**, or in the address bar `…/developers/<number>/…`) and the dates in RECORD.md.

## 5. The Play app record and Data safety

Play Console: **https://play.google.com/console**.

> 🛑 **STOP: owner** confirms the final store name (same as Apple).

1. **Home → Create app.**
   - **App name:** the store name (max 30 characters)
   - **Default language:** English (United States) – en-US
   - **App or game:** App
   - **Free or paid:** Free (free apps can't become paid later)
   - **Declarations:** the Developer Program Policies and US export laws checkboxes.
   > 🛑 **STOP: owner** ticks the declarations and clicks **Create app**.
2. The app's **Dashboard** lists setup tasks. Do them in this order. Under **Policy and programs → App content** (names may vary slightly):
   - **Privacy policy:** the privacy policy URL.
   - **App access:** choose **All or some functionality is restricted** → add instructions: name "Demo restaurant", the demo username, "Any other information": the restaurant address and the steps from STORE-LISTING.md. **Password:** 🛑 the owner types it. Google wants credentials that are reusable, always valid, and work from any location, with no one-time codes.
   - **Ads:** No, the app has no ads.
   - **Content rating:** start the questionnaire. Email: DubLow's contact email. Category: the one closest to a business/utility app (not a game, not social media). Answer "No" to violence, sexual content, language, controlled substances, gambling. For "Do users interact or exchange content?": see STORE-LISTING.md.
     > 🛑 **STOP: owner** reviews and submits the questionnaire.
   - **Target audience and content:** suggested **18 and over** plus **16–17** (restaurant staff can be 16–17). Not designed for children; not in the Families program.
     > 🛑 **STOP: owner** confirms (ages under 18 add extra policy checks; under 13 would bring in the Families policy).
   - **News app:** No. **COVID-19 apps:** No. **Government app:** No. **Financial features:** none. **Health:** none. **Data safety:** below.
3. **Data safety** (App content → Data safety). Use the answers in [STORE-LISTING.md → Google Play Data safety](STORE-LISTING.md#google-play-data-safety). In short: the app collects personal info (name, email, phone), app activity (things people write in requests), device or other IDs (the push token); all encrypted in transit; nothing shared with third parties for their own use; nothing sold; people can ask for deletion. Account section: users sign in with accounts their employer creates; deletion URL: `https://[stable DubLow URL]/support#delete-account`.
   > 🛑 **STOP: owner** reviews and submits the form.
4. **Store presence → Main store listing:** short and full description, app icon (512×512 PNG), feature graphic (1024×500), phone screenshots. Text and sizes in STORE-LISTING.md. Then **Store settings**: Category **Business**, contact email (and website/phone).
5. **Translations:** add **Spanish (Latin America) – es-419** and **Spanish (United States) – es-US** with the Spanish text from STORE-LISTING.md.
6. **Countries / regions** (Test and release → Production → Countries/regions): United States (🛑 owner confirms). This doesn't publish anything.
7. **Internal testing** (Test and release → Testing → **Internal testing**):
   - **Testers** tab → **Create email list** → name "DubLow + Chasing Rabbits pilot" → add the testers' Google Account emails (up to 100) as the owner gives them → **Save**.
   - The first release is created in section 8.
   - Write the package name and dates in RECORD.md.

## 6. Expo / EAS account and project

EAS builds, signs and submits the app from the cloud. A **developer with a terminal** runs the commands (a coding agent can, in the repo). The browser agent only does the website parts.

1. Open **https://expo.dev/signup**.
   > 🛑 **STOP: owner** creates the Expo account with a DubLow email, chooses the password and turns on two-factor (Account settings → Security), and accepts the Expo terms.
2. Create an **organization** for DubLow: account menu → **Create organization** → name `dublowdigital` (or similar, owner decides). Invite the developer as a member if needed.
   - Success: `https://expo.dev/accounts/dublowdigital` exists. Write the account name in RECORD.md.
3. Plan: stay on **Free** at first (monthly build quota in a low-priority queue). If builds are slow or the quota runs out, the Starter plan is about 19 USD/month. 🛑 Any upgrade is the owner's purchase.
4. **Terminal (developer):** in `mobile/`:
   ```bash
   npm install
   npx eas-cli@latest login            # the owner signs in, or uses a robot access token stored as a secret
   npx eas-cli@latest init             # creates the EAS project "shiftboard" under the organization
   ```
   `eas init` writes `extra.eas.projectId` (and `owner`) to `mobile/app.json`; if it says it can't edit the dynamic config, add them to `app.json` by hand. Commit that change (the project ID is not secret).
   - Success: the project shows at `https://expo.dev/accounts/dublowdigital/projects/shiftboard`. Write the **EAS project ID** in RECORD.md.

## 7. Push credentials

Expo sends notifications through Apple (APNs) and Google (Firebase Cloud Messaging, FCM v1). Both credentials are stored **in EAS**, never in the repo.

### iOS (APNs key)

Easiest: let EAS create it during the first iOS build (section 8): when `eas build` asks "Generate a new Apple Push Notifications service key?", answer **yes**. It signs in to Apple as the owner (🛑 the owner types the Apple password and 2FA code in the terminal).
- Or later: `npx eas-cli@latest credentials` → iOS → production → **Push Notifications: Manage your Apple Push Notifications Key** → set up a new key.
- Success: in the Apple Developer site, **Keys** lists an "Expo push" key, and on expo.dev the project's **Credentials → iOS** shows the push key. Write "APNs key: in EAS" + date (and the Key ID, which is not secret) in RECORD.md. **Don't download or copy the `.p8` file.**

### Android (Firebase / FCM v1)

1. Open **https://console.firebase.google.com** (DubLow's Google Account; 🛑 owner signs in). **Create a project** (name "ShiftBoard"; Google Analytics: off, not needed).
2. In the project: **Add app → Android**. Package name `com.dublowdigital.shiftboard`, nickname "ShiftBoard Android". **Register app**.
3. Download **google-services.json** when offered.
   > 🛑 **STOP: owner** keeps the file (it isn't a password, but it stays out of git). A developer uploads it to EAS as a **file environment variable** named `GOOGLE_SERVICES_JSON` (expo.dev → project → **Environment variables** → add → type **File**, environments: production, preview, development). `mobile/app.config.js` uses it.
4. Firebase → **Project settings → Service accounts** → **Generate new private key** downloads a JSON **secret key**.
   > 🛑 **STOP: owner** generates and keeps the file. A developer uploads it with `npx eas-cli@latest credentials` → Android → production → **Google Service Account** → **Manage your Google Service Account Key for Push Notifications (FCM V1)** → upload. Then delete the downloaded copy. Never commit, email or paste it.
5. Success: expo.dev → project → **Credentials → Android** shows the FCM V1 service account key. Write "FCM v1 key: in EAS" + date in RECORD.md (and the Firebase project ID, not secret).

### Server side

Nothing to set up on the restaurants' servers: they send through Expo's Push API. Only if DubLow turns on Expo's "enhanced push security" does each deployment need an `EXPO_ACCESS_TOKEN` (a secret) in its Vercel environment variables.

## 8. First build and submit: TestFlight and Play internal testing

**Terminal (developer)**, in `mobile/`. See DEVELOPING.md for details.

1. **Build both:**
   ```bash
   npx eas-cli@latest build --platform all --profile production
   ```
   - iOS: EAS asks to sign in to Apple (🛑 owner types password and 2FA in the terminal) and to create the distribution certificate, provisioning profile and push key; answer yes and let EAS manage them.
   - Android: EAS asks to generate a new **Android keystore** (upload key); answer yes. It's stored in EAS. Google Play App Signing holds the real signing key.
   - Success: both builds finish on expo.dev (an `.ipa` and an `.aab`).
2. **iOS → TestFlight:**
   ```bash
   npx eas-cli@latest submit --platform ios --latest
   ```
   EAS asks for the App Store Connect app (or uses `ascAppId` in `eas.json`) and can create an **App Store Connect API key** for future uploads (🛑 owner approves with their Apple sign-in). After upload, App Store Connect processes the build (minutes to an hour).
   - In App Store Connect → the app → **TestFlight**: if asked about export compliance, 🛑 owner answers (it should be pre-answered). Create an **internal testing** group (up to 100 App Store Connect users; no review needed) and add the testers.
   - **External testers** (up to 10,000 people by email or public link) need **Beta App Review** for the first build of each version and a "What to Test" note (STORE-LISTING.md). 🛑 Owner submits.
   - Success: testers get the TestFlight invite and can install. Log build number and date.
3. **Android → Play internal testing:**
   - Google service account for uploads: in Google Cloud (https://console.cloud.google.com/iam-admin/serviceaccounts, the Firebase project is fine) create a service account, then in Play Console → **Users and permissions** → invite its email with release permissions for this app. 🛑 The owner creates its JSON key and a developer uploads it to EAS (`eas credentials` → Android → **Google Service Account → Manage your Google Service Account Key for Play Store Submissions**).
   - Then:
     ```bash
     npx eas-cli@latest submit --platform android --latest
     ```
     `eas.json` sends it to the **internal** track as a **draft**. If Google refuses the API upload because the app has never had a release, upload the first `.aab` by hand: Play Console → Test and release → Testing → **Internal testing** → **Create new release** → upload the `.aab` from expo.dev → release name "1.0.0 (1)" → notes from STORE-LISTING.md → **Next**.
     > 🛑 **STOP: owner** clicks **Save and publish** / **Start rollout to Internal testing** (internal testing isn't public, but it's a release).
   - Testers open the **opt-in link** (Testers tab → "Copy link") on their Android phone.
   - Success: testers can install from Google Play. Log version code and date.
4. **Smoke test on real phones** (iPhone and Android):
   - Restaurant address → sign in (English and Spanish) → My Shifts, Schedule, Trades, Time Off, More.
   - Allow notifications. From the website, a manager publishes a shift for the tester: the phone gets a push; tapping it opens My Shifts.
   - Language button top right switches instantly on every screen; More → Language too.
   - Sign out → no more pushes to that phone.
   - Write the results in RECORD.md.

## 9. Going public (later, not for the agent)

When the owner decides: fill the version page (screenshots, review notes, demo account), then 🛑 the owner clicks **Add for Review / Submit for Review** in App Store Connect and **Send for review / Start rollout to Production** in Play Console. Keep the demo restaurant up while the apps are in review.
