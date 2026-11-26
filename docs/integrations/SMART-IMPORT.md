# Smart import: people and menu items from a file

Team → **Import** (people) and Training → Menu → **Import** (menu items), for managers. One pipeline for both, also
used by the Claude connector and Ask ShiftBoard.

| Step | Where | What happens |
|---|---|---|
| File | browser: `core/smart-import.js`, `web/src/pdf.js` | CSV, TSV, semicolons, cells pasted from a spreadsheet, Excel `.xlsx` (first sheet), Word `.docx` (tables, else paragraphs), PDF (pdf.js text; columns lined up under the header). Up to 5 MB, read in the browser; nothing is uploaded. |
| Not a table | `server/import-routes.js` | **Read it with AI**: the text (≤ 40,000 characters, sent in parts of 3,500) goes through `server/ai` (purposes `menu_import`, `employee_import`; metered and capped like Ask ShiftBoard). Or the **simple reader**: section headings and prices for a menu, emails/phones for a list of people. The demo never calls the AI. |
| Columns | `autoMap()`, `<target>.importMapping` | Each column → a field or *ignore*, guessed from the header (English and Spanish), else the values (emails, phones, prices), with a confidence. Remembered per restaurant and target. Social security, tax and bank columns are never imported or remembered. |
| Check | `<target>.importPreview` (`core/import-api.js`) | Every row: **new**, **update** (field by field, before → after), **unchanged**, **check** (needs a decision), **skip**, **problem** (why). Options: create missing positions (off) / menu sections (on), blank cells clear (off), send invitations now (off). Nothing is saved. |
| Import | `<target>.importApply` | The preview is recomputed from the records (never trusted from the browser), refused while a check row has no decision, then each row is saved through `employees.save` / `menu.save` (their validation, notifications and permissions). Audit log: `import.employees` / `import.menu` with counts and the file name. The same file again changes nothing. |

## Duplicates: verify, never guess

**Exact** (used without asking): equal after folding case, accents, spacing and punctuation — an email, an employee
ID (or the ADP file number, leading zeros ignored), a phone (+1, dots, dashes, spaces ignored), the full name, the
legal name or the name on the schedule; a menu item's name in its section. More than one exact match → a check row
("matches more than one: pick").

**Possible duplicate** (a check row, side by side with the existing record, why and how confident):

| People | score | Menu items | score |
|---|---|---|---|
| the same Gmail mailbox written differently (dots, `+tag`) | 90 | a plural, `&`/`and`, a size or price on the end (same section) | 85 |
| first and last name swapped; a middle initial | 85 | a typo: edit distance ≤ 15% of the length, 5+ letters, same first letter | 70 |
| a nickname (`core/impact.js` `nicknamesOf`) or a prefix (Chris / Christopher) | 75 / 65 | the exact name in another section | 65 |
| the same name but nothing else to go on | 70 | plural / size in another section | 60 |
| a one-letter typo in a last name of 4+ letters | 60 | a typo in another section | 50 |
| only a first name on one side | 45 | | |

Same birthday +10, same hire date +5. Shown from 45 up (high ≥ 80, medium ≥ 60, low below). **Never** the same
person: both have an email (or an employee ID) and they differ — two people called Alex with different emails stay
two people. Not typos in first names (Maria / Mario), not short menu names (Beer / Bees), not another first letter
(Coffee / Toffee). Tuned on the cases in `test/smart-import.test.js`; the numbers are in `nameLikeness`,
`personLikeness` and `menuLikeness`.

The choices for a check row: **Update this one** (each changed field can keep its current value), **Skip**, or
**Create as new** (only by an explicit tap; never a default). Rows of the same file that are the same person (same
email, ID or phone, or the same name with nothing that disagrees) or the same item (same name and section) are
merged; values that disagree are shown to pick from (the saved value counts as a pick). Decisions are remembered
(`importLinks`), so the next import of the same file matches, skips and keeps exactly the same way.

## People

Fields: name (or first + last), legal first/last name, email, phone, positions (matched by name, short name or a
synonym: Waiter/Mesero = Server…), role, hire date, birthday (`MM-DD` without a year), employee ID, pay rate (the
per-position rate ShiftBoard already stores: on the row's positions, else their only or main one), managers' notes,
active. Hire date, birthday, employee ID and notes are new profile fields (Team → a person → Employment details);
the notes are never sent to the person themselves.

- Empty cells keep what's saved unless *blank cells clear* is on (never names, roles or positions). Positions are
  added, never removed.
- Never an Admin or Super Admin role (the role stays as it is), and only roles the manager may give.
- Never consent: `smsConsent` / `emailConsent` stay off and no consent record is written; texts are never sent.
- New people have no password and aren't emailed unless **Send invitations now** is on (then the usual invitation
  email, after the save). Otherwise invite them from Team when ready.

## Menu items

Fields: name, section (created if missing), description, ingredients, allergens (free text → the 9 majors: "contains
nuts, dairy" → tree nuts, milk; anything else as written), dietary tags (GF, V, VG, DF, spicy, in English or
Spanish), price (the item's existing price field), selling notes, pairings, recipe steps, prep notes, Spanish name and
description, 86'd / available. Who sees recipes and prep notes follows Settings → Training as for any item.

## Claude

`save_menu_item`, `import_menu_items`, `import_employees` (`server/tools/import.js`). The import tools are
`preview: true`: without `confirm` they only read (a read-only connection can preview), and Ask ShiftBoard runs that
call like a read and shows the result to the model; `confirm: true` with `decisions: [{ row, action, id?, keep? }]`
applies (in Ask ShiftBoard: the card the person confirms). A confirm without a decision for every check row is
refused with the rows that need one.

## Later: syncing people from other platforms

Toast and ADP already sync people with their own matching (`core/toast.js matchEmployees`, `core/adp.js
matchWorkers`, which this import's rules follow). A platform sync can feed this pipeline: build records
`{ row, values: { field: text }, present, id? }` from the platform's people (`id` when the platform record is already
linked to a ShiftBoard person) and call `employees.importPreview` / `employees.importApply` as a manager, so the
same duplicate checks, "empty keeps" and audit log apply.
