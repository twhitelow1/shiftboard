# Feedback box

Anyone signed in (staff, supervisors, managers) leaves a **Suggestion**, **Feedback**, a **Concern / report** or a
**Shout-out**, with an optional topic. It is **anonymous by default**; a "Sign it with my name" switch (off) signs it.
Readers work through an inbox: statuses, a reply thread with the writer, internal notes, and an optional
"You said, we did" board the whole team sees.

- Code: `core/feedback.js` (rules, data, RPCs), `core/sha256.js`, `core/feedback-seed.js` (demo samples).
- Web: `web/src/pages/Feedback.jsx` (`#/feedback`, `#/feedback/mine`, `#/feedback/board`),
  `FeedbackInbox.jsx` (`#/feedback-inbox`), `FeedbackSettings.jsx` (`#/settings/feedback`),
  words in `web/src/i18n/en-feedback.js` / `es-feedback.js`.
- Phone app: More → Feedback box (`mobile/src/app/(app)/feedback*.tsx`), words in `mobile/src/i18n/en.ts` / `es.ts`.
- Tests: `test/feedback.test.js`.
- Plan feature `feedback` (Starter, Pro, Beta). Role features (Settings → Roles & features): `feedback` (write,
  My feedback, the board; every role) and `feedbackInbox` (read; managers and Admins, switchable).
- No AI reads entries, and the Claude connector and Ask ShiftBoard have no tools for it (see `server/tools/index.js`).

## Who reads what

| | Reads the inbox | Concern / report |
|---|---|---|
| Staff | no | no |
| Supervisors | only when an Admin turns on "Supervisors can read it too" (Settings → Feedback box) | no |
| Managers | yes (unless turned off in Roles & features) | only if an Admin unticks "Admins only" on that kind |
| Admins, Super Admins | yes | yes |

Each kind can be renamed, added, turned off, marked **Admins only**, or given the **safety note**. Concern / report is
Admins only and has the safety note by default. The safety note (editable in English and Spanish) is shown when that
kind is picked, with the restaurant's call-out line and today's managers on duty, and says urgent safety issues are
reported in person.

View as (a Super Admin viewing as someone) reads the inbox and opens entries, read-only: every change is refused.

## Real anonymity: what is stored

An anonymous entry is `{ id, kind, topic, message, date, signed: false, codeHash, status, thread, notes, shared }`.

- **No user id, name, email, IP, user agent, device, push token or language**, on the entry or anywhere else:
  - no audit log entry is written for submissions or follow-ups;
  - the readers' notifications carry no `by` (who acted) and are sent to **the same readers whoever wrote it** (a
    reader who writes one is notified too, so the recipient list never hints at the writer);
  - error tracking (`server/errors-routes.js`) records a failed `feedback.*` call with **no user id and no device**;
    the apps' "last 20 server calls" breadcrumbs for Report a problem keep the method name and status (never the
    arguments, as before) and, for `feedback.*`, no time;
  - the server's request logs: ShiftBoard logs nothing per request (only 500s, with the method name and the error);
  - there is no analytics in ShiftBoard.
- **The date only, never the time of day**, so an entry can't be matched against who was on shift or on break. The
  writer's follow-up messages keep the date only too. The entry's ids are random (`core/store.js` `uid()` ends with
  the clock, so it isn't used). The database's own `updated_at` for these rows is the day at midnight
  (`server/db.js` `DATE_ONLY`). Readers' replies and notes keep their time: readers aren't anonymous.
- **Within a day the inbox orders entries by their random id**, never by arrival.
- **Rate limit without identity**: at most 5 entries and 30 follow-up messages per person per day. One document,
  `feedbackLimits/today`, holds `{ day, counts: { HMAC-SHA-256(key, userId|day|what): n } }`. The key is
  `FEEDBACK_SECRET` (env) when set, otherwise derived from the server's signing secret. The counts are wiped by the
  first Feedback box call after the day ends, and the HMAC is never on an entry. The document's id is fixed
  (`today`), so no HMAC is left behind as a deleted row's id.
- **Follow-up code**: an anonymous writer gets a code once (`XXXX-XXXX-XXXX-XXXX`, 80 random bits). The entry keeps
  only its SHA-256. With the code anyone holding it can open the entry, read replies and write back, still
  anonymously. A wrong code gets "No entry has that code".
- **On the writer's device**: the codes of their anonymous entries are kept in `localStorage` (web) or the phone's
  secure storage (app), per restaurant, with how many replies they've read, for a "New reply" badge checked when
  they open the Feedback box (`feedback.codes.summary`, which writes nothing). Clearing the browser's data, deleting
  the app or switching devices loses that list; the code itself still works.
- **Signed entries** keep the user id; readers see the name; the writer follows them up in My feedback and is
  notified (in-app, push, email per their preferences) when a reader replies, changes the status or shares it.

## Notifications

- A new entry, or a follow-up from its writer: every reader of that kind gets an in-app notification, a push, and an
  email per their own email settings, saying **only the kind and topic** ("New in the Feedback box: Suggestion ·
  Kitchen"). The message is never in a notification, push or email.
- **Never texted**: these notifications carry `noText`, and `server/channels.js` skips them for texts.
- An anonymous writer is never notified (there's nobody to notify); their device shows the badge.

## "You said, we did"

A reader can share an entry, plus what was done, on the team board. Nothing is shared by default; the reader edits
the text first (the original stays private). A signed entry is shared anonymously unless its writer has said yes
("OK to show my name…" in My feedback); a reader can ask them with one tap. The board shows the share date only.

## What it can't protect against (said plainly in the app too)

- **Writing style and details**: how someone writes, or a detail only they would know (a shift, a table, something said
  to them), can identify them. The form says so.
- **Arrival time**: readers are notified when an entry arrives, so someone watching their phone knows roughly when it
  was sent and could compare with who was on break. The app stores the date only, but the notification itself is
  timely. (A daily digest instead of instant alerts would close this; see decisions below.)
- **For the rest of that day, someone with both database access and the server's secret** (DubLow staff with
  production access) could compute the HMAC for every person and see who sent *something* today, and the database
  writes the entry and the counter in the same transaction. The counter is wiped the next day.
- **Hosting logs**: Vercel's own request logs (outside ShiftBoard) record each request's path, time and IP address;
  someone with access to both those logs and the database could correlate a `feedback.submit` call with an entry.
  Database backups keep yesterday's counter until they expire.
- **The follow-up code**: anyone who gets someone's code can read their entry and reply as them. The code is kept in
  the browser or phone, so someone using their unlocked device could find it.
- **Small teams**: with only a few people on a shift, even "the date and the topic" can narrow it down.
