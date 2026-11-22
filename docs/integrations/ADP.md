# ADP: worked hours from the restaurant's real time clock

ADP is where most of our restaurants' staff actually clock in, and payroll is paid from it, so ShiftBoard takes **actual worked hours** from ADP. They drive Labor review (scheduled vs. worked), the tip pool's hours, and the new **"From your actual hours"** staffing suggestions in Forecast & Labor. Toast stays the source of sales, covers and tips.

There are two ways in, and both are built:

| | CSV import | API sync |
|---|---|---|
| Works with | **Any** ADP product: RUN, Workforce Now, ADP Time & Attendance (ezLaborManager), Workforce Manager | Workforce Now with API Central (or a Marketplace partner app) |
| Setup | None | API Central add-on, a client certificate (CSR), 4 env vars |
| How | A manager exports a timecard report each week, then **Labor review → Import ADP hours** | Sync now, plus a daily Vercel Cron |
| Cost | Nothing extra | API Central is billed per employee per month (see below) |

> **Research caveat.** In this session the adp.com sites (developers.adp.com, apps.adp.com, www.adp.com) could not be fetched, so the findings below come from web search results: ADP's own API guide PDFs and Marketplace listings as summarized by the search engine, plus integration vendors' docs (Nango, Merge, CData, Apideck, Fivetran). Anything marked **verify** should be checked against developers.adp.com or with the ADP rep before we rely on it.

## 1. Which ADP products have time APIs

| Product | Typical restaurant | Time-card / time-entry API? |
|---|---|---|
| **RUN Powered by ADP** | Small (1–49 employees) | **No public time-card read API found.** RUN's API surface is workers and payroll input; time-tracking apps on the Marketplace (OnTheClock, Workyard, ClockShark, Timeero…) all *push* hours **into** RUN. RUN's own timekeeping (ADP Timekeeping for RUN, the Time Kiosk app, or ezLaborManager on RUN) exposes reports, not an API. Some vendors say RUN apps are created "in API Central through the RUN marketplace" (Nango), others only through the partner program (Merge): **verify**. Plan on **CSV** for RUN. |
| **ADP Workforce Now (WFN)** with Time & Attendance | Mid-size (50–1000) | **Yes.** `GET /time/v2/workers/{aoid}/team-time-cards` (a manager's team) and `GET /time/v2/workers/{aoid}/time-cards` (one worker; needs a `$filter`), with `$expand=dayEntries`; `GET /time/v2/workers/{aoid}/clock-entries` (today's punches). Scope: the `timeSheet.read` canonical URI. Requires Time & Attendance on for the client and the employees. **WFN Next Generation** has only "limited support" for the timecard use case per ADP's listing: **verify**. |
| **ADP Time & Attendance / ezLaborManager** (standalone, or inside WFN/RUN) | Any | Standalone: **no API** (GetApp lists none). Inside WFN, its timecards are what the WFN Time Cards API reads. Reports export to CSV. |
| **ADP Workforce Manager** | Larger / multi-unit | Partner-level APIs exist but we found no public, client-purchasable time API: **verify**. Reports (Dataviews & Reports → Report Library → *Time Detail*) export to **CSV/XLSX**. |
| ADP Vantage, Enterprise HR, Lyric | Enterprise | API Central exists for these too; unlikely for our restaurants. |

## 2. How one restaurant gets API access: ADP API Central

- **What it is:** a paid add-on in the ADP Marketplace ("ADP API Central for ADP Workforce Now and Workforce Now Next Generation") that gives the client self-service access to ADP's APIs and developer resources, so the client (or someone building for them) can create API credentials for their own company.
- **Cost:** billed monthly on the ADP invoice **per employee**. Two Marketplace listings disagreed: one showed **$3.00/employee/month**; another showed tiers of **$1.60** (first 999 employees), **$1.00** (1000–2999), **$0.80** (3000–4999). Optional consulting at **$250/hour**. A 60-person restaurant would pay roughly **$96–$180/month**. Confirm the current price with the rep.
- **Credentials:** in API Central the client creates a **project**, picks the APIs/use cases (Workers, and Time Cards / "Timecards" read), and gets a **client ID and client secret**. They also generate a private key and a **CSR**, upload it, and download the **signed client certificate** (see section 4).
- **Who owns it:** the restaurant. They hand us the client ID/secret and the certificate + key (we keep them only in env vars; with multi-tenancy, in that restaurant's encrypted secrets).

## 3. How a software vendor (DubLow) gets access for many restaurants: the ADP Marketplace partner program

- **Apply** at partners.adp.com / the ADP Marketplace partner portal. ADP's **Sales, Security and Legal** teams review the company and the app. ADP says it favors partners with a **substantial number of shared clients** and a differentiated HCM solution.
- **Security review:** a security questionnaire, your security and data-retention policies, then a call with ADP's security team; gaps get a remediation plan and timeline.
- **Legal:** a partner agreement. Marketplace apps are sold through the Marketplace; ADP collects from the client and **remits the partner's revenue share after taking ADP's share, typically 60–90 days** later. ADP's partner fee and revenue-share rates weren't in the public results: **ask**.
- **Build:** a development project in the **Partner Self-Service Portal** with target milestone dates (required to finalize agreements), sandbox ("IAT") credentials, then ADP's integration review against its *Marketplace Integration Standards*, then a listing.
- **Per-client consent:** each restaurant installs/approves the app in the Marketplace, which grants our partner app access to that client's data (one set of partner credentials and one certificate, many clients). Each client still needs Time & Attendance for time cards.
- **Timeline:** not published. Applications, security review, legal and integration certification commonly take **several months** (plan for 3–6+); it depends on ADP's interest and our shared-client count: **verify** with the partner team.
- **Recommendation:** start with the CSV import everywhere (works today), offer API Central to WFN restaurants that want automatic sync, and apply to the partner program once there are enough ADP restaurants to show ADP.

## 4. Auth: OAuth 2.0 client credentials over mutual TLS

Every ADP API call presents an X.509 **client certificate** on the TLS connection *and* an OAuth bearer token. The token request uses the same certificate.

```
POST https://accounts.adp.com/auth/oauth/v2/token        (with the client certificate)
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
→ { "access_token": "…", "token_type": "Bearer", "expires_in": 3600 }
```

Then `GET https://api.adp.com/...` with `Authorization: Bearer <token>`, also over mTLS. `server/adp.js` does this with one Node `https.Agent({ cert, key })`, caches the token until 5 minutes before `expires_in`, and shares one sign-in among concurrent requests.

### Making the certificate (CSR steps)

On a trusted computer (never commit these files):

```bash
# 1. A private key and a certificate signing request. Use the company name exactly as registered with ADP.
openssl req -new -newkey rsa:2048 -nodes \
  -keyout adp-client.key -out adp-client.csr \
  -subj "/C=US/ST=Colorado/L=Denver/O=Your Restaurant LLC/CN=your-restaurant-shiftboard"

# 2. Upload adp-client.csr: API Central project → Certificate (or ADP's Certificate Signing Tool,
#    type "Authentication and Transaction Signing"; partners: the self-service portal's Certificate tab).
# 3. Download the signed certificate ADP returns (adp-client.pem). It's valid about 2 years; ADP emails
#    a renewal notice 60 days before it expires: make a new CSR and swap ADP_CERT_PEM.
# 4. Check the key matches the certificate (the two hashes must be equal):
openssl x509 -noout -modulus -in adp-client.pem | openssl md5
openssl rsa  -noout -modulus -in adp-client.key | openssl md5
```

The key must be **unencrypted** (`-nodes`). If ADP gives a `.pfx`/`.p12`, extract both: `openssl pkcs12 -in file.pfx -nokeys -out adp-client.pem` and `openssl pkcs12 -in file.pfx -nocerts -nodes -out adp-client.key`.

### Env vars (Vercel → Settings → Environment Variables)

On the platform, a restaurant's admin pastes the same values in **Settings → Integrations → ADP → Connection** instead (stored encrypted; see the platform README). The table is for a single-restaurant install, or Chasing Rabbits' env fallback.

| Env var | Notes |
|---|---|
| `ADP_CLIENT_ID` | From the API Central project (or the partner app) |
| `ADP_CLIENT_SECRET` | **Sensitive** |
| `ADP_CERT_PEM` | The signed certificate: paste the PEM text, or base64 of it (`base64 -w0 adp-client.pem`), which survives one-line fields |
| `ADP_KEY_PEM` | The private key, same formats. **Sensitive** |
| `ADP_API_HOST` | Optional. Default `https://api.adp.com` |
| `ADP_TOKEN_URL` | Optional. Default `https://accounts.adp.com/auth/oauth/v2/token` |
| `ADP_MANAGER_AOID` | Optional. A manager's associate OID: read the whole team's time cards in one paged call (team-time-cards) instead of one call per worker |
| `CRON_SECRET` | Shared with Toast: protects `/api/cron/adp` |

All of these are read in one function, `adpConfig(env)` in `server/adp.js` (like `toastConfig`), so moving to per-restaurant encrypted secrets means changing that one place. Settings → Integrations → ADP shows which are present (names only) and points out a malformed PEM.

## 5. Endpoints we use

| Call | What for |
|---|---|
| `GET /hr/v2/workers?$top=100&$skip=n` | Associate OIDs (`associateOID`), names (`person.legalName`), emails (`businessCommunication.emails`), employee IDs (`workerID.idValue`, `workAssignments[].payrollFileNumber`), department (`homeOrganizationalUnits`), status. Paged with `$top`/`$skip` until a short page or **204 No Content**. |
| `GET /time/v2/workers/{managerAOID}/team-time-cards?$expand=dayEntries&$filter=timeCards/timePeriod/startDate eq 'YYYY-MM-DD'` | Everyone's time cards for one pay period (with `ADP_MANAGER_AOID`), paged. |
| `GET /time/v2/workers/{aoid}/time-cards?$expand=dayEntries&$filter=…` | One worker's time cards (without a manager AOID; 4 at a time). |
| `…$filter=timeCards/periodCode/codeValue eq 'current'` | The current pay period, to work out every other period (weekly, biweekly, semi-monthly, monthly). |

Time cards are read defensively (`timeCardPunches` in `core/adp.js`): `dayEntries[].entryDate`, `timeEntries[].timePeriod.startDateTime/endDateTime`, hours from `totals[].timeDuration` (ISO 8601, `PT6H30M`) by `payCode` (REG → regular, OT/DT → overtime, PTO/vacation/holiday… → left out), department from `laborAllocations`. **Verify the exact field names against the sandbox** before the first real client; the parser is the one place to adjust.

**Rate limits:** ADP doesn't publish fixed numbers; limits are per client application (a leaky bucket per third-party docs). Over the limit returns **429 with Retry-After**; the client waits (up to 10 s) and retries up to 3 times, and the sync works a day at a time inside an 18-second budget so each Vercel call finishes.

**RUN:** no time-card read endpoint found. RUN restaurants use the CSV import.

## 6. The CSV path (works today with any ADP product)

Where managers find the export (menu names vary by version and permissions):

- **RUN** (with ADP Time & Attendance / Timekeeping): Reports → Time (or the time tool's Reports) → a *Timecard* or *Hours Worked* report for the week → Export/Download → CSV (or Excel, saved as CSV).
- **Workforce Now** with Time & Attendance: Reports & Analytics, or Time & Attendance → Reports → *Timecard* / *Timecard Detail* → Export → CSV.
- **ezLaborManager / ADP Time & Attendance**: Reports → *Timecard Report* (in and out times, hours, earnings codes and labor charges per time pair) → save as CSV. (Its separate "Export" feature is payroll templates, not this.)
- **Workforce Manager**: Dataviews & Reports → Report Library → *Time Detail* (hours, punch times, absences) → export CSV.

What the importer handles (`core/adp-csv.js`, tests in `test/adp.test.js` with invented fixtures in `test/fixtures/adp/`):

- **Columns auto-detected** by name: employee name (or first/last), employee ID / file # / associate ID / person number, date (work/apply/punch date), time in and out (several In/Out pairs = one shift with a meal break), total hours (or regular + overtime), pay code, department / position / labor category, rate. Title lines above the header, repeated headers on each page, total lines, and names printed once per group are handled. The manager confirms or changes the columns; they're **remembered** for the next file.
- **Overnight punches:** a clock-out at or before the clock-in is the next morning; a cell with its own date (`09/19/2026 01:30 AM`) is used as is.
- **Pay codes:** PTO, vacation, sick, holiday, bereavement… are left out (not worked); an OT row moves that many hours to overtime on that day's punch; a day-total row is ignored when the day has punches.
- **Preview before saving:** new / updated / already in / twice in the file / already synced from the API, unmatched people (with a picker), past-midnight shifts, missing clock-outs.
- **Re-importing never doubles:** each punch is keyed on the person (employee ID, else name), the date and the time in. An earlier file without IDs is recognized by person + date + time in. A corrected export replaces that person's day (the old punch is removed), and a day the API already synced is skipped.
- Parsing happens in the browser; only punches go to the server (or to the in-browser demo, where the import works too).

## 7. People, positions and which clock counts

- **People:** ADP workers match ShiftBoard people by **email**, then the **employee ID / file number saved on the person** (`user.adpId`; set automatically when a manager matches someone by hand), then **name** (full name, first + last initial, first name alone, only when unambiguous). API and CSV identities can both point at one person. Manual matches stick (Settings → Integrations → ADP, or "Who is who" in the import preview).
- **Positions:** an ADP department / position / labor category matches a job code by name (or by hand); otherwise each punch takes the **position the person was scheduled for that day** (the shift nearest the clock-in), else their primary position.
- **Clock-in source** (Settings → Integrations → ADP, admins): **Automatic** (ADP once there's any ADP data, else Toast), **ADP**, **Toast**, or **Both (ADP wins)**. "Both" goes person by person and day by day; on a day ADP has an unmatched punch, Toast fills nothing that day (it could be the same shift). Toast punches that lose their hours stay as **tips-only** entries, so Toast's tips still reach the tip pool and Labor review. Every reader of `timeEntries` goes through `core/clock.js`, so one shift is never counted twice. Labor review says where each day's hours came from (ADP, Toast, or ADP + Toast).
- **Overtime:** ADP rows without an overtime split get overtime worked out from the weekly limit (Settings → Overtime after), noted on Labor review.

## 8. "From your actual hours" (Forecast & Labor)

`core/calibrate.js`, next to the existing rule-based staffing (which doesn't change):

- From the last **4, 6 or 8 weeks** of clock-ins against the schedule, per **position and daypart**: a least-squares line *hours = fixed + per-cover × covers* through every day (a manager comes out fixed, servers per cover; too few days → hours per cover), and each weekday's own average as the baseline. Suggested hours = that weekday's usual hours + the per-cover rate × (this week's forecast covers − that weekday's usual covers). With no covers in the history, $100s of sales are used instead.
- Event (BEO) shifts, and clock-ins that cover them, are left out on both sides: the BEO staffs events, and the forecast's restaurant covers don't include their guests.
- Shown as sentences ("Fridays you schedule 52 Server hours and actually use 47 for ~310 covers. This week: 54 scheduled for ~316 covers; suggested 48."), a scheduled / suggested grid by day (all day or per daypart), **over- and under-scheduling by weekday**, and **overtime risk** (this week's scheduled hours × how much longer than scheduled each person has worked lately).

## 9. What to ask the restaurant's ADP rep

1. Which ADP product and edition are we on (RUN, Workforce Now, Workforce Now Next Gen, Workforce Manager)? Is **Time & Attendance / Timekeeping** part of it, and do all hourly staff punch in it?
2. (Workforce Now) Can we add **ADP API Central**? What's our price per employee per month, and is there a contract term?
3. Does our API Central project get the **Workers** and **Time Cards / Timecards (read)** use cases (the `timeSheet.read` scope)? Is the timecard use case supported on our version (Next Gen has limited support)?
4. How do we submit the **CSR** and get the client certificate (API Central's certificate page, or the Certificate Signing Tool)? Who gets the renewal notice?
5. Is there a **sandbox** (IAT) we can test against first?
6. Which manager's **associate OID** sees all hourly employees' time cards (for `ADP_MANAGER_AOID`)? Or should we read each worker's time cards?
7. What are our API **rate limits**?
8. What's our **pay period** (weekly, biweekly, semi-monthly) and when does it start?
9. (RUN) Is there any way to read time cards through an API on our plan, or should we stay with the weekly CSV export? Which report gives in/out punches?
10. Do employees' ADP records have **work emails** or **file numbers** we can match to ShiftBoard?

## 10. Code map

| File | What |
|---|---|
| `server/adp.js` | Config (`adpConfig`), PEM reading, the mTLS agent, the client (token cache, `$top`/`$skip` paging, 429 Retry-After) |
| `server/adp-sync.js` | Day-by-day sync within a time budget, status, cron range |
| `server/adp-routes.js` | `GET /api/adp/status`, `POST /api/adp/sync`, `GET /api/cron/adp` (CRON_SECRET) |
| `core/adp-csv.js` | Reading the CSV: delimiter, header row, columns, times, dates, hours, overnight, pay codes |
| `core/adp.js` | Workers, matching, positions, time-card punches, the CSV import plan, the API day apply |
| `core/adp-api.js` | RPC: `adp.get`, `adp.saveMapping`, `adp.previewImport`, `adp.importCsv`, `clock.setSource` |
| `core/clock.js` | Which clock counts (ADP / Toast / both), tips-only entries |
| `core/calibrate.js` | Staffing from actual hours, trends, overtime risk; RPC `calibration.week` |
| `web/src/pages/AdpImport.jsx`, `AdpSettings.jsx`, `ActualHours.jsx` | Import ADP hours, Settings → Integrations → ADP (and Clock-in setup), From your actual hours |

## Sources

- [Team Time Cards API Guide for ADP Workforce Now](https://marketplace-cdn.adp.com/dev-portal/pdf/protected/Team_Time_Cards_API_Guide_for_ADP_Workforce_Now) · [developers.adp.com version](https://developers.adp.com/articles/preview/guide-team-time-cards-api-guide-foradp-workforce-now-1) · [Use case: team time card details](https://marketplace-cdn.adp.com/dev-portal/pdf/protected/Team_Time_Cards_API_Guide_for_ADP_Workforce_Now_chapter_2)
- [Time Entries Modify TLM API Guide for ADP Workforce Now](https://marketplace-cdn.adp.com/dev-portal/pdf/protected/Time_Entries_Modify_TLM_API_Guide_for_ADP_Workforce_Now_chapter_2) · [Workforce Now API inventory](https://developers.adp.com/articles/guides/workforce-now-api-inventory) · [Time Cards API explorer](https://developers.adp.com/apis/api-explorer/ta-offrg-gta/ta-offrg-gta-time-time-cards-v2-time-cards)
- [ADP API Central for Workforce Now (Marketplace listing, editions and pricing)](https://apps.adp.com/en-us/apps/410612/adp-api-central-for-adp-workforce-now/editions) · [API Central for Vantage, Enterprise HR and Lyric](https://apps.adp.com/en-US/apps/419897/adp-api-central-for-adp-vantage-hcm%2C-adp-enterprise-hr-and-adp-lyric/features) · [ADP API Central overview](https://www.adp.com/what-we-offer/integrations/api-central.aspx)
- [Becoming an ADP Marketplace partner](https://marketplace.adp.com/downloads/becoming-a-partner.pdf) · [Partner program](https://partners.adp.com/gettingstarted) · [Marketplace pricing and remittance](https://marketplace-cdn.adp.com/dev-portal/pdf/protected/ADP_Marketplace_Pricing_and_How_to_Setup_Free_Trial) · [Marketplace Integration Standards](https://marketplace-cdn.adp.com/dev-portal/pdf/protected/ADP_Marketplace_Integration_Standards)
- [Web API Gateway Rate Limit Policy](https://marketplace-cdn.adp.com/dev-portal/pdf/protected/Web_API_Gateway_Rate_Limit_Policy) · [Workers paging ($top/$skip)](https://marketplace-cdn.adp.com/dev-portal/pdf/ADP_Marketplace_ESI_-_Getting_started_chapter_4)
- mTLS and certificates, as integrators describe them: [Nango: ADP Workforce Now](https://nango.dev/docs/integrations/all/adp-workforce-now/connect) · [Nango: RUN](https://nango.dev/docs/integrations/all/adp-run/connect.md) · [Merge: ADP partner credentials](https://help.merge.dev/en/articles/5944400-how-to-set-up-adp-partner-credentials) · [Apideck: Workforce Now configuration](https://developers.apideck.com/apis/hris/adp-workforce-now/configuration) · [CData: before you connect](https://cdn.cdata.com/help/JDN/ado/pg_beforeyouconnect.htm) · [CData: TeamTimeCardsDayEntries](https://cdn.cdata.com/help/JDN/ado/pg_table-teamtimecardsdayentries.htm)
- RUN time data flows into RUN: [OnTheClock Connector for RUN](https://apps.adp.com/en-US/apps/416776/ontheclock-connector-for-run-powered-by-adp/features) · [ADP Timekeeping for RUN](https://apps.adp.com/en-US/apps/325308/adp-timekeeping-for-run-powered-by-adp/features) · [Fivetran: time cards endpoint request](https://support.fivetran.com/hc/en-us/community/posts/40380130170519-ADP-Workforce-Connector-Request-for-Time-Cards-endpoint)
- Report exports: [ezLaborManager: downloading reports (CSV)](https://otcdc1.adp.com/ezLMHelp/V18_30/Standalone/AUFeatureSet/SimpleUI/en-AU/as_help/reports/reports-downloading.htm) · [ezLaborManager: administrator reports (Timecard Report)](https://otcdc1.adp.com/ezlmhelp/v18_30/wfn/general/standardui/en-us/as_help/reports/reports-generic_administrator.htm) · [ezLaborManager exports FAQ](https://otcdc1.adp.com/ezLMHelp/V18_30/WFN/General/StandardUI/en-US/as_help/as/exports-faqs.htm) · [Workforce Manager Time Detail report (a client's help article)](https://teamschools.zendesk.com/hc/en-us/articles/4408238915991-Dataviews-and-Reports-for-tracking-timeliness)
