# Signing in, invitations and consent

How people get into ShiftBoard, how their sign-in is protected, and how their consent to texts and email is
kept. Code: `server/auth.js` (sign-in and sign-in settings), `server/onboarding.js` (the invitation wizard),
`server/totp.js`, `server/secret-box.js`, `core/auth-factors.js`, `core/consent.js`, `core/profile.js`.
Tests: `test/auth.test.js`, `test/onboarding.test.js`, `test/consent.test.js`, `test/stop.test.js`.

## The rules

- **Every sign-in has two steps.** A password plus one of: a 6-digit code from an authenticator app
  (TOTP), a one-time recovery code, or a passkey. A passkey on its own counts as both steps (something you
  have, unlocked with your face, fingerprint or screen lock: user verification is required).
- **No SMS codes, anywhere.** Texts are only shift alerts for people who agreed to them.
- **Without a second step yet, sign-in sets one up first** (a passkey or an authenticator app, then 10
  recovery codes). No session exists before that.
- **Recovery:** the recovery codes, or a manager or admin resetting the person's second step in Team (their
  sessions end, they get a security email, it's in the audit log, and they set up a new one at their next sign-in).
- **Sessions from before this change stay valid.** Nobody is signed out at deploy; people set up a second step
  at their next sign-in.
- **Passwords** have at least 10 characters and can't contain the person's name or email or be a common one
  (`passwordProblem` in `core/auth-factors.js`). Changing or resetting a password signs out every other session.
- "Sign in as owner" from the platform console works as before (no second step; a support session can't change
  the owner's sign-in settings or consent).

## The contract (web app and phone app)

All bodies are JSON. Errors are `{ "error": "…" }` in the caller's language (English unless the person or the
`X-ShiftBoard-Language` header says Spanish). A **session** is the `sb_session` cookie, or, when the request
says `"client": "mobile"`, `{ "ok": true, "token": "<JWT>", "expiresIn": 2592000 }` in the body (send it back as
`Authorization: Bearer <token>`). Responses that sign in also carry `ok: true`.

### Password, then the second step

| Request | Answer |
|---|---|
| `POST /api/auth/login {email, password, client?}` | `401` wrong email or password (rate-limited: 10 per IP + email per 15 min, then `429`). Otherwise `200` and **no session**: `{ mfa: 'verify', ticket, methods: ['totp','recovery','passkey'] }` (the methods they have) or `{ mfa: 'enroll', ticket }` (no second step yet). |
| `POST /api/auth/mfa/verify {ticket, method: 'totp'\|'recovery', code, client?}` | session. `401` wrong code (`That code didn’t work…`) or an expired ticket; `429` after 5 wrong codes per ticket **or** per person in 15 minutes. |
| `POST /api/auth/mfa/totp/setup {ticket}` | `{ secret, otpauthUrl }` (base32, SHA-1, 6 digits, 30 s). Only with an **enroll** ticket (`403` once they have a second step). |
| `POST /api/auth/mfa/totp/confirm {ticket, code, client?}` | `{ recoveryCodes: [10 codes] }` + session. |
| `POST /api/auth/passkey/register/options {ticket?}` | `{ options }` (`PublicKeyCredentialCreationOptionsJSON`; discoverable, user verification required). With an enroll ticket, or signed in. |
| `POST /api/auth/passkey/register/verify {ticket?, response, name?, client?}` | With a ticket: `{ recoveryCodes }` + session. Signed in: `{ ok, passkey: {id,type,name,createdAt,lastUsedAt}, recoveryCodes }` (`[]` when they already have codes). |

The **ticket** is a JWT signed with the session secret: `{ p: 'mfa', k: 'verify'|'enroll', sub: <user id>,
v: <sessionVersion>, t: <restaurant>, jti }`, valid **10 minutes**. A password change invalidates it; it is never
accepted as a session (cookie or bearer).

### Passwordless

| Request | Answer |
|---|---|
| `POST /api/auth/passkey/login/options {email?}` | `{ options }`. Discoverable passkeys only: the email is ignored, so the answer never says whether an account (or a passkey) exists. |
| `POST /api/auth/passkey/login/verify {response, client?}` | session; `401` otherwise (20 failures per IP per 15 min). Each challenge works once (5 minutes). |
| `POST /api/auth/link {email, code}` | Always `{ ok: true }` (same answer and timing whether or not the account exists; `400` only when email isn't set up at all; `429` after 5 requests per IP + email in 15 min). If the account exists and `code` is a current authenticator code, a **one-time link** (15 minutes) is emailed: `<app>/#/link?token=…`. The code is used up. |
| `POST /api/auth/link/consume {token, client?}` | session; `400` expired or used. |

### Reset and forgotten password

| Request | Answer |
|---|---|
| `POST /api/auth/forgot {email}` | Always `{ ok: true }`; emails a reset link (1 hour) to `/#/reset?token=…`. |
| `POST /api/auth/reset {token, password}` | Sets the password (the link stays good if the password is refused), ends every session, then answers **like login**: `{ mfa: 'verify'\|'enroll', ticket, methods? }`. It never signs in by itself. |

### My sign-in settings (signed in)

`GET /api/auth/security` → `{ result: { twoStep: { on, totp, passkeys, recoveryLeft }, factors: [{ id, type, name?, createdAt, lastUsedAt?, left? }] } }`;
`POST /api/auth/mfa/totp/setup {}` and `/confirm {code}` (replaces the current app); `POST /api/auth/mfa/totp/remove`;
`POST /api/auth/passkey/register/options {}` and `/verify`; `POST /api/auth/passkey/rename {id, name}`; `POST /api/auth/passkey/remove {id}`;
`POST /api/auth/mfa/recovery/regenerate` → `{ result: { recoveryCodes, … } }`. The last second step can't be removed (add another first).
Managers and admins: `POST /api/users/:id/reset-2fa` (anyone they can manage, never themselves).

### The second step again, for one action (web only)

Making yourself Super Admin (`POST /api/rpc/account.becomeSuperAdmin`, core/super-admin.js) needs the second step
**entered with the request**: `{ code }` (a current authenticator code, not one already used, not a recovery code) or
`{ passkey }` (the answer to `POST /api/auth/step-up/passkey/options {}`, a challenge for this person's own passkeys,
5 minutes, used once). Wrong ones count toward the same limit as sign-in codes (5 per 15 minutes). Refused before any
code is checked when the person can't do it anyway, and always refused from the phone app, in View as, in a DubLow
support session, and through the Claude connector or Ask ShiftBoard.

### The invitation wizard

Team → Add employee (or `employees.save` with `invite: true`) creates the person **without a password** and emails
an invitation (7 days, single use) to `/#/welcome?token=…`. Invitations are only ever emailed, never texted.
The wizard's routes take an onboarding session (cookie `sb_onboard`, 1 hour, renewed by `start`):

`POST /api/onboarding/start {token}` → progress `{ steps: { password, factor, recoverySaved, profile }, consent, sms, legal, … }` ·
`/password {password}` · `/totp/setup` · `/totp/confirm {code}` → `{ recoveryCodes }` · `/passkey/options` · `/passkey/verify {response}` ·
`/recovery/regenerate` · `/recovery/ack {saved: true}` · `/profile {name, phone}` · `/photo {dataUrl}` ·
`/complete {terms: true, sms?, email?, phone?, lang}` → session (cookie).

Progress is kept on the server, so a reload (or another tab with the same link) continues. The password and
the factors made in the wizard are *pending* and don't work for signing in until it completes; completing needs
the password, a second step, the recovery codes acknowledged and `terms: true`. Only then is the invitation used up.
A newer invitation starts over.

## Data

| Where | What |
|---|---|
| `authFactors` (doc collection) | Every factor, never on the user: `totp` (`secretEnc`, `lastStep`), `recovery` (10 × `{ salt, hash: sha256(salt:code), usedAt }`), `passkey` (`credentialId`, `publicKey` COSE base64url, `counter`, `transports`, `name`, `rpId`, `createdAt`, `lastUsedAt`), `onboarding` (the wizard's progress and pending password hash). `pending` marks the wizard's unfinished ones; `unconfirmed` an app set up but not confirmed. |
| `auth_tokens` (table) | Hashes of invitation, reset and sign-in link tokens, and passkey challenges (single use, expiring). |
| `login_attempts` (table) | Rate limits; keys are hashes (no IPs or emails stored). |
| `auditLog` (doc collection) | Security events: second step reset by a manager, factors added or removed, recovery codes used or renewed. |
| `users` | `passwordHash` (bcrypt, as before), `sessionVersion`, `onboardedAt`, `photoId`, `smsConsent`, `emailConsent`, `smsWelcomedAt`… |

**Nothing secret leaves the server.** User views strip `passwordHash` and any factor field (`SECRET_FIELDS`); factor
views carry names and dates only; consent IPs are never sent (the admin CSV shows them shortened, `203.0.113.x`).
`test/auth.test.js` calls every read RPC as other people and checks for secrets, hashes, public keys, tickets and IPs.

**Authenticator secrets are encrypted** with AES-256-GCM (`server/platform/secrets.js`), bound to the restaurant and
the person. The key is `PLATFORM_ENCRYPTION_KEY` when set (values start `k1.`), else one derived with HKDF from the
session secret (`JWT_SECRET`, or the one in the database; values start `s1.`), so setting the platform key later keeps
older values readable. **Changing `JWT_SECRET` without `PLATFORM_ENCRYPTION_KEY`, or losing `PLATFORM_ENCRYPTION_KEY`,
makes authenticator apps stop working**: people then sign in with a recovery code or passkey, or a manager resets them.

## Passkeys and domains

Passkeys belong to the address they were made on: the RP ID is the request's host name and the expected origin
is the app's address (`APP_URL`, else the request's own). **Each restaurant's passkeys work on its own host only.
Moving a restaurant to a new domain means everyone adds their passkeys again** (their password and authenticator
app keep working; a passkey made on `bistro.shiftboard.app` won't work on `schedule.bistro.com`). Keep `APP_URL` equal
to the address people use.

## Consent

- Three separate boxes, **never pre-ticked** (`core/consent.js`, `web/src/consent-form.js`): the Privacy Policy and
  Terms (required), shift schedule texts (optional), notification emails (optional). The server only counts a box
  that is exactly `true`.
- Each choice is an **append-only** record in `consents`: `{ userId, channel, granted, version, lang, text (the exact
  words shown), phone, ip, userAgent, source: 'onboarding'|'settings'|'keyword'|'migration', at }`; terms records keep
  the `links` that were shown. Spanish speakers see and record the Spanish words (STOP and HELP stay in English).
- `users.smsConsent === true` gates every text and is checked again right before each send. The welcome text goes out
  once, on the first opt-in ever: exactly "ShiftBoard by DubLow Digital: You're subscribed to shift schedule alerts. Msg
  freq varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel." (Spanish for Spanish speakers).
- `users.emailConsent` gates notification emails only. Invitations, password resets, sign-in links and security
  notices always go out.
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE turn texts off; START, YES, UNSTOP turn them back on
  (`/api/twilio/inbound`, signature checked on every request, `403` otherwise). Each is a `keyword` record.
- People from before consent records keep what they had: a one-time migration sets `smsConsent` from the old
  `smsNotifications` (with a `migration` record) and `emailConsent` from the old email setting, and retires the old
  fields. At their next sign-in, anyone without a terms record sees the consent screen once.
- Legal links: `LEGAL_LINKS` in `core/consent.js` (`https://dublowdigital.com/privacy-policy/`, `https://dublowdigital.com/terms`),
  overridden by `PRIVACY_URL` / `TERMS_URL`, given to the apps in `/api/config` (`legal`, plus `consent.text` and
  `consent.versions` with the exact words). Changing the words means a new version in `CONSENT_VERSION`.
- Admins download every record as CSV in Settings → Text messages (`GET /api/consents.csv`).
- `/sms-opt-in` is the public page for carrier and Twilio review.

## The phone app (mobile/) must

The phone app is being reworked on another branch; until it does the following, its sign-in stops working
(`/api/auth/login` no longer returns a token).

1. **Sign-in:** send `{ email, password, client: 'mobile' }`. On `mfa: 'verify'`, show a code step: a 6-digit field
   (`textContentType="oneTimeCode"`), a "Use a recovery code" switch, and a note that a manager can reset it. Post
   `/api/auth/mfa/verify { ticket, method, code, client: 'mobile' }` and keep the `token`. Handle `401` (wrong code,
   or "That sign-in step expired": start over) and `429`.
2. **First sign-in (`mfa: 'enroll'`):** set up an authenticator app natively: `/api/auth/mfa/totp/setup { ticket }`,
   show the key (grouped in fours, copy button) and an "Open in my authenticator app" button for `otpauthUrl` (a QR
   code is no use on the same phone), then `/api/auth/mfa/totp/confirm { ticket, code, client: 'mobile' }` → token
   and `recoveryCodes`: show them once with copy/share and an "I saved these" checkbox before going on.
3. **Passkeys: through the web.** Passkeys are tied to each restaurant's web address, and a native passkey would need
   associated domains for every restaurant host. So the app offers "Add a passkey" / "Sign in with a passkey" by
   opening the restaurant's address in the system browser (`<restaurant>/#/account`, or the sign-in page); in the app
   itself people use their password plus a code.
4. **Consent:** after sign-in, if `app.bootstrap` says `me.needsTerms`, show the consent screen before anything
   else: the three boxes unticked, the words from `/api/config` → `consent.text[lang]` (terms with the `legal` links),
   texts and email only for channels not already on (`me.consent`), then RPC `consent.accept { terms: true, sms, email, phone, lang }`.
5. **Texts:** `sms.preferences { on: true, phone, consent: true, lang }` needs the consent box (same words); read
   `me.smsConsent` / `me.smsStatus` (`on`, `off`, `stopped`) instead of `smsNotifications`.
6. **Email:** `account.preferences { emailConsent: true|false, lang }` (`emailNotifications` still works as the old name).
7. **Links:** invitations (`/#/welcome`), reset links and sign-in links (`/#/link`) open the web app.
8. **Profile:** `profile.update { name, phone }`, `profile.setPhoto { dataUrl }` (a square JPEG about 256 px), photos at
   `GET /api/photos/<photoId>` with the bearer token.

## Owner's checklist

1. **Environment** (Vercel → Settings → Environment Variables, then redeploy):
   - `PLATFORM_ENCRYPTION_KEY`: 32 random bytes (`openssl rand -base64 32`), **Sensitive**. Encrypts authenticator
     app secrets. Set it before people start setting up apps, and never lose or change it.
   - `JWT_SECRET`: keep it as it is (changing it signs everyone out and, without the key above, breaks authenticator apps).
   - `APP_URL`: the address people use (passkeys belong to it).
   - Optional: `PRIVACY_URL`, `TERMS_URL` when the documents move (defaults: `https://dublowdigital.com/privacy-policy/`
     and `https://dublowdigital.com/terms`; the Terms page still has to be published there).
   - Email (Resend) must be set up for invitations, reset links and sign-in links.
   - Node.js 22 or later (`@simplewebauthn/server` needs it; Vercel's default is fine).
2. **Twilio Messaging Service:**
   - Incoming messages webhook: `POST https://<your app>/api/twilio/inbound` (set `TWILIO_WEBHOOK_URL` if Twilio calls
     another address than `APP_URL`).
   - Keep **Advanced Opt-Out** on, with the default STOP/START words. Set the HELP reply, for example: "ShiftBoard by
     DubLow Digital: shift schedule alerts for restaurant staff. Help: <support email or https://<your app>/support>.
     Reply STOP to cancel. Msg & data rates may apply." Leave the opt-in (START) reply on: ShiftBoard doesn't send its
     own welcome text on START.
3. **A2P 10DLC campaign** (use case: Account Notification / Mixed for staff alerts). Paste:
   - **Campaign description:** "ShiftBoard by DubLow Digital sends restaurant employees alerts about their own work
     schedule: new or changed shifts, shift trades, time-off decisions and event staffing. Only employees who opt in
     receive texts. No marketing."
   - **How do end users consent:** "Employees are added by their manager and receive an email invitation (never a
     text). While setting up their account in the ShiftBoard web app, they see a consent screen with three separate,
     unchecked checkboxes. Texts require ticking the optional box that reads: 'I agree to receive shift schedule text
     messages from DubLow Digital through ShiftBoard. Message frequency varies. Message and data rates may apply. Reply
     STOP to cancel, HELP for help. Consent is not a condition of employment.' and entering their own mobile number.
     They can also opt in or out later in the app (My Shifts → Text messages) with the same wording. Each opt-in is
     recorded with the time, IP address, wording version and number. Screenshots and details:
     https://<your app>/sms-opt-in. Privacy Policy: https://dublowdigital.com/privacy-policy/"
   - **Opt-in message:** "ShiftBoard by DubLow Digital: You're subscribed to shift schedule alerts. Msg freq varies.
     Msg & data rates may apply. Reply HELP for help, STOP to cancel."
   - **Sample messages:** "Our Restaurant: New shift: Server Fri, Oct 2 4p-10p https://<your app>/#/my" and
     "Our Restaurant: Approved: trade of Server Sat, Oct 3 4p-10p. Check your updated schedule. https://<your app>/#/my"
   - **Opt-out / help keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT (plus OPTOUT, REVOKE); START, YES, UNSTOP; HELP.
   - Embedded links: yes (the app's own address). Embedded phone numbers: no. Age-gated or lending content: no.
4. **Review:** a native Spanish speaker should read the Spanish consent words and welcome text in `core/consent.js`
   (and the new screens) before launch; the Privacy Policy should mention texts and that mobile numbers aren't shared
   for marketing.

## Demo build

The demo (core in the browser) signs in without a second step and skips the consent screen. Admins get
**Preview onboarding** and **Preview the consent screen** in Team, which walk through the wizard with sample data
and no server calls (`#/welcome?preview=1`). My settings shows a sample.
