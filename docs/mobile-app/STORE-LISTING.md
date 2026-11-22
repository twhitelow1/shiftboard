# Store listing: text, screenshots, privacy answers, review notes

Drafts for the owner to review. Character limits are in brackets; counts were checked when written.
**The store name isn't final** (see [DECISION.md → Name risk](DECISION.md#name-risk)). "ShiftBoard" below is the working name; replace it everywhere once the owner picks one.

Languages:
- **Apple App Store Connect:** English (U.S.) primary, plus **Spanish (Mexico)**, which is the Spanish localization shown on the US App Store. (App Store Connect has no "Spanish (US)" or "Latin America"; confirm in the language menu.)
- **Google Play:** English (United States) – en-US default, plus **Spanish (Latin America) – es-419** and **Spanish (United States) – es-US** (same text in both).
- Spanish is neutral Latin American, using "tú". Terms follow [../i18n/GLOSSARY.md](../i18n/GLOSSARY.md).

---

## English (U.S.)

**App name** [30]: `ShiftBoard` (working name) · e.g. `ShiftBoard: Restaurant Shifts` (29)

**Subtitle (Apple)** [30]: `Your shifts, trades & time off` (30)

**Promotional text (Apple)** [170]:
> See this week's schedule, swap shifts with coworkers and ask for time off in a tap. Get a notification the moment the schedule is posted. In English and Spanish. (161)

**Short description (Google)** [80]:
> Restaurant shifts on your phone: schedule, trades, time off and alerts. (71)

**Keywords (Apple)** [100, comma-separated, no spaces after commas]:
> `restaurant,schedule,shifts,swap,trade,time off,staff,server,crew,roster,employee,work,horario,turnos` (100)

**Full description (Apple and Google)** [4000]:

> ShiftBoard is the schedule app for restaurant teams. Your restaurant posts the schedule; you see your shifts, trade with coworkers and ask for time off, right from your phone.
>
> Your restaurant must use ShiftBoard. Sign in with the email and password your manager set up, or open the invite link they sent.
>
> YOUR SHIFTS
> • Your next shift up front, and your shifts week by week with hours
> • "Until close" shifts, positions, areas and sections, just like the house schedule
> • Add your shifts to your phone's calendar
>
> THE WHOLE TEAM'S SCHEDULE
> • Day by day, grouped by area and position, so you know who's working with you
> • Event shifts and day notes
>
> TRADES AND GIVEAWAYS
> • Trade a shift with a coworker or give it away to anyone who works that position
> • Pick up open shifts and shifts coworkers are giving away
> • Conflicts are checked for you; a manager approves when your restaurant requires it
>
> TIME OFF
> • Pick the days on a calendar and send the request
> • See what's pending, approved or denied
>
> NOTIFICATIONS
> • Know the moment the schedule is posted, a shift changes, or someone wants your shift
>
> ENGLISH AND SPANISH
> • Switch languages from the button at the top of any screen
>
> Shift leads and managers can also approve trades and time off. Building and publishing the schedule happens on the ShiftBoard website.
>
> ShiftBoard is made by DubLow Digital.

**What's new (1.0)** [4000]:
> First release: your shifts, the team schedule, trades and giveaways, time off and notifications, in English and Spanish.

---

## Español (Apple: Spanish (Mexico) · Google: es-419 and es-US)

**Nombre** [30]: `ShiftBoard` (nombre provisional) · p. ej. `ShiftBoard: Turnos` (18)

**Subtítulo (Apple)** [30]: `Turnos, cambios y días libres` (29)

**Texto promocional (Apple)** [170]:
> Consulta el horario de la semana, intercambia turnos con tus compañeros y pide días libres con un toque. Recibe un aviso en cuanto se publique el horario. (154)

**Descripción breve (Google)** [80]:
> Tu horario del restaurante en el teléfono: cambios, días libres y avisos. (73)

**Palabras clave (Apple)** [100]:
> `horario,turnos,restaurante,cambio de turno,días libres,mesero,personal,empleados,trabajo,schedule` (97)

**Descripción completa (Apple y Google)** [4000]:

> ShiftBoard es la app de horarios para equipos de restaurante. Tu restaurante publica el horario y tú ves tus turnos, haces intercambios con tus compañeros y pides días libres desde tu teléfono.
>
> Tu restaurante debe usar ShiftBoard. Inicia sesión con el correo y la contraseña que te dio tu gerente, o abre el enlace de invitación que te mandó.
>
> TUS TURNOS
> • Tu próximo turno a la vista y tus turnos semana por semana, con tus horas
> • Turnos "hasta el cierre", puestos, áreas y secciones, igual que en el horario del restaurante
> • Agrega tus turnos al calendario de tu teléfono
>
> EL HORARIO DE TODO EL EQUIPO
> • Día por día, por área y por puesto, para que sepas quién trabaja contigo
> • Turnos de eventos y notas del día
>
> CAMBIOS Y TURNOS CEDIDOS
> • Intercambia un turno con un compañero o cédelo a cualquiera que trabaje ese puesto
> • Recoge turnos disponibles y turnos que tus compañeros están cediendo
> • La app revisa los conflictos por ti; un gerente aprueba cuando tu restaurante lo pide
>
> DÍAS LIBRES
> • Elige los días en el calendario y envía tu solicitud
> • Ve qué está pendiente, aprobado o rechazado
>
> NOTIFICACIONES
> • Entérate en cuanto se publica el horario, cambia un turno o alguien quiere tu turno
>
> EN ESPAÑOL Y EN INGLÉS
> • Cambia de idioma con el botón de arriba en cualquier pantalla
>
> Los supervisores y gerentes también pueden aprobar cambios y días libres. El horario se arma y se publica en el sitio web de ShiftBoard.
>
> ShiftBoard es creado por DubLow Digital.

**Novedades (1.0)**:
> Primera versión: tus turnos, el horario del equipo, cambios y turnos cedidos, días libres y notificaciones, en español y en inglés.

---

## Screenshots

Take them from a TestFlight / internal-testing build signed in to the **demo restaurant** (demo names only, never real staff). One set in English, one in Spanish.

| # | Screen | Shows |
|---|---|---|
| 1 | My Shifts | the next-shift card, open shifts, the week list |
| 2 | Schedule | a busy day grouped by area and position |
| 3 | Trade | "Can't make it?" choices, or picking a coworker's shift |
| 4 | Trades | a giveaway to pick up and an open shift |
| 5 | Time Off | the calendar with days picked |
| 6 | Notifications | the list, or a push on the lock screen |
| 7 (optional) | More / language | English ↔ Español button |

Sizes (portrait, no transparency):

| Store | Required | Size | Count |
|---|---|---|---|
| Apple | iPhone **6.9"** display | **1320 × 2868** px (1290 × 2796 and 1260 × 2736 also accepted) | 1–10 per language |
| Apple | iPad | not needed: the app is iPhone-only (`supportsTablet: false`) | |
| Google | Phone screenshots | PNG or JPEG, each side 320–3840 px, long side at most 2× the short side; 1080 × 1920 or larger recommended | 2–8 per language |
| Google | App icon | **512 × 512** PNG, up to 1 MB | 1 |
| Google | Feature graphic | **1024 × 500** PNG or JPEG, no transparency | 1 |

Apple takes the App Store icon from the build (`mobile/assets/images/icon.png`, 1024 × 1024, no transparency). The current icons are placeholders.

Tip: a 6.9" iPhone simulator screenshot is already 1320 × 2868 (iPhone 16/17 Pro Max). On Android, a Pixel phone screenshot works as is.

---

## What the app collects (the source for both forms)

| Data | Where it comes from | Why | Linked to the person | Shared / sold | Tracking |
|---|---|---|---|---|---|
| Name | the restaurant's records (shown in the app) | show schedules, requests | yes | no / no | no |
| Email | typed at sign-in; the restaurant's records | sign-in, account | yes | no / no | no |
| Phone number (optional) | the restaurant's records; shown to shift leads | finding coverage | yes | no / no | no |
| User ID | the account | the app working | yes | no / no | no |
| Work schedule, availability, time-off dates | the restaurant; the person's requests | the app working | yes | no / no | no |
| Notes the person types (trade notes, time-off reason, 86 List notes) | typed in the app | requests and approvals, the 86 List | yes | no / no | no |
| Photos (optional) | taken or picked by the person for an 86 List report (up to 3, e.g. an empty bottle); shrunk on the phone; deleted 30 days after the item comes off the list | showing coworkers what's out | yes | no / no | no |
| Push token + phone type (iOS/Android) | the phone, after the person allows notifications | sending notifications | yes | no / no | no |
| Language choice | the person | showing the app in their language | yes | no / no | no |

**Not collected:** location, contacts, other photos (only the photo the person picks is uploaded), microphone, health, payment or financial info (pay rates aren't shown or collected in the app), browsing or search history, analytics, crash reports, advertising IDs. No ads, no third-party SDKs that collect data, no tracking. Data goes over HTTPS to the restaurant's own ShiftBoard server; service providers (Vercel, the database host, Resend, Expo/Apple/Google for push) process it on DubLow's behalf, which both stores don't count as "sharing".

## Apple App Privacy (nutrition label)

"Do you or your third-party partners collect data from this app?" **Yes.**

| Category → type | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| Contact Info → Name | Yes | Yes | No | App Functionality |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| Contact Info → Phone Number | Yes | Yes | No | App Functionality |
| Identifiers → User ID | Yes | Yes | No | App Functionality |
| Identifiers → Device ID (push token) | Yes | Yes | No | App Functionality |
| User Content → Photos or Videos (optional 86 List photos) | Yes | Yes | No | App Functionality |
| User Content → Other User Content (notes on requests) | Yes | Yes | No | App Functionality |
| Other Data → Other Data Types (work schedule, availability, time off) | Yes | Yes | No | App Functionality |

Everything else: not collected. Expected label: **Data Linked to You** (Contact Info, Identifiers, User Content, Other Data); **no Data Used to Track You**.

Privacy policy URL: `https://[stable DubLow URL]/privacy` (Spanish (Mexico): `…/privacy#es`).

## Google Play Data safety

**Data collection and security**
- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes**
- Account creation: people sign in with an **email and password** that their restaurant (employer) created on the ShiftBoard website. Suggested answer: **Username and password** (conservative: it brings the account deletion requirement, which we meet). 🛑 Owner confirms.
- Delete account URL: `https://[stable DubLow URL]/support#delete-account`
- Can users request that some or all of their data be deleted without deleting their account? **Yes** (email support; see the support page).

**Data types** (all: collected **yes**, shared **no**, processed ephemerally **no**, required)

| Data type | Purposes |
|---|---|
| Personal info → Name | App functionality, Account management |
| Personal info → Email address | App functionality, Account management |
| Personal info → Phone number (optional: mark "users can choose") | App functionality |
| Personal info → User IDs | App functionality, Account management |
| App activity → Other user-generated content | App functionality |
| Photos and videos → Photos (optional: mark "users can choose") | App functionality |
| Device or other IDs | App functionality (push notifications) |

Not collected: location, financial info, health and fitness, messages (emails, SMS), videos, audio, files and docs, calendar (the app adds a calendar subscription only when the person taps it; it doesn't read their calendar), contacts, web browsing, app info and performance (no crash logs or diagnostics).

## Age and content rating (suggested answers; 🛑 owner confirms)

**Apple age rating:** none / no for violence, sexual content, nudity, profanity, horror, alcohol/tobacco/drugs (job titles like "Bartender" aren't drug or alcohol content), medical, gambling, contests, ads, unrestricted web access (the app only opens the restaurant's own website), social media, messaging/chat. **User-generated content:** short notes on trade and time-off requests, and 86 List notes and optional photos of stock (e.g. an empty bottle), seen only by coworkers at the same restaurant, removable by managers. 🛑 Owner confirms the alcohol answer: photos of the bar's bottles are work records, not alcohol promotion. Expected rating: 4+ (lowest).

**Google content rating (IARC):** category: utility / productivity / other (not a game, not social). No violence, sexuality, language, controlled substances or gambling. "Users can interact or exchange content": the honest answer is yes (notes between coworkers), which may add a "Users Interact" note. Doesn't share location, no digital purchases. Expected: Everyone / ESRB Everyone.

**Google target audience:** 18 and over, and 16–17 (staff can be 16–17). Not for children.

---

## App Review notes

### Apple (App Review Information → Notes)

> ShiftBoard is a scheduling app for restaurant staff. Each restaurant runs its own ShiftBoard server, so the first screen asks for the restaurant's address.
>
> To review:
> 1. Restaurant address: `[demo deployment address, e.g. shiftboard-demo.vercel.app]` → Continue
> 2. Sign in with the demo account below (an employee at a demo restaurant with sample data).
> 3. My Shifts: tap the next shift → "Trade with a coworker" or "Give it away".
> 4. Trades, Time Off (request days on the calendar), Notifications (bell), More.
> 5. The language button (globe, top right) switches between English and Spanish.
>
> Accounts are created by the restaurant (the employer) on the website; there is no sign-up in the app. People can ask to delete their account in the app: More → Delete my account, which notifies their managers; the support page explains the rest (`https://[stable DubLow URL]/support#delete-account`).
>
> Push notifications: after sign-in the app asks permission. To trigger one, sign in to the website as the demo manager (`[manager demo username]`, same password) and publish a shift for the demo employee.

- **Sign-in required:** yes. **User name:** `reviewer@[demo domain]`. **Password:** 🛑 typed by the owner from the password manager.
- **Contact:** owner's name, phone and email (🛑 owner fills in).

### Google (App access → instructions)

- **Name:** Demo restaurant
- **Username:** `reviewer@[demo domain]`
- **Password:** 🛑 typed by the owner
- **Any other information:** "First screen: enter the restaurant address `[demo deployment address]` and tap Continue, then sign in. Accounts are created by the employer; no sign-up in the app. The credentials work from any location and don't need a one-time code."

### TestFlight "What to Test"

> First build. Please check: restaurant address and sign-in, My Shifts, Schedule (by day), trading and giving away a shift, picking up an open shift, requesting time off, notifications (allow them, then have a manager publish a shift for you), and the English/Spanish button at the top of every screen. Tell us anything that's confusing, cut off, or wrong in Spanish.

> Primera versión. Revisa: la dirección del restaurante y el inicio de sesión, Mis turnos, el Horario por día, intercambiar y ceder un turno, recoger un turno disponible, pedir días libres, las notificaciones (permítelas y pide a un gerente que publique un turno para ti) y el botón de español/inglés arriba en cada pantalla. Cuéntanos si algo se ve cortado, confuso o mal escrito en español.

### Demo account checklist (owner)

- A deployment with `SEED_DEMO=true` that stays up during review (for example a separate Vercel project), restaurant name "Demo Restaurant".
- An employee account with a few shifts in the coming weeks (the demo data is the week of Sep 28, 2026; a manager can use "Copy week" on the website to bring it forward before each review).
- Set the reviewer password in the password manager; change it after review.
