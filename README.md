# ShiftBoard

Restaurant scheduling built for how a busy restaurant and event venue actually runs. It replaces the weekly Excel schedule and does the job of 7shifts without the per-location fee.

Built by DubLow Digital.

## What it does

| | |
|---|---|
| **Weekly schedule** | Grid grouped by job code (the same layout as the house Excel sheet) or by employee. Supports "until close" shifts (`4p–CL`), section tags (LIB, RH, BC, PASSED…), draft vs. published, copy week, print, and CSV export. |
| **Mobile first** | Phones get a day-by-day view with a bottom nav. Staff can check their schedule and the whole team's schedule, and trade shifts, from their phone. |
| **Multiple job codes** | Each employee can hold any number of job codes, each with its own pay rate. Server + Banquet Captain, Food Runner + Barback, etc. |
| **Calendar** | Month view for your own shifts or the whole team, plus a day timeline with bars by position. |
| **Swaps & trades** | *Give away* a shift (everyone trained for it is notified), *trade* for a specific coworker's shift, or *pick up* an open shift. Coworker accepts, then a manager approves. Conflicts are checked automatically: double booking, time off, availability, training, overtime. Approval can be turned off in Settings. |
| **Time off & availability** | Requests go to managers for approval. Approved time off shows as **REQUEST OFF** on the grid, and any shift that conflicts with it is flagged. |
| **Forecasting & labor** | Forecasts covers and sales from your daily history (weighted same-weekday average with a trend), adds event guests from BEOs, and shows labor $ and labor % against your target. Labor rules like "1 server per 22 dinner covers" produce a scheduled-vs-recommended staffing grid. A one-click button fills the gaps with open shifts. |
| **Events & BEOs** | A full Banquet Event Order: guests, room, service style, banquet captain, menu, dietary notes, beverage package, **special drinks** with recipes, timeline, setup, and **staffing needs** (how many servers, runners, bartenders, BCs). The app suggests staffing from guest count using standard banquet ratios, turns staffing lines into open shifts staff can claim, tracks fill status (e.g. 13/14), and includes a team comment thread. Staff on an event are notified whenever the BEO changes. |
| **Import your spreadsheet** | Paste your existing Excel schedule directly. Sections, names, and cells like `4PM`, `3:30PM BC`, `12-4PM`, and `REQUEST OFF` are read automatically. CSV works too. |
| **Calendar sync** | Each employee gets a private iCal link for Google or Apple Calendar. |
| **Notifications** | In-app notifications for schedule posted, shift changes, swap requests and approvals, open shifts, BEO updates, and comments. |

### Roles
- **Admin**: everything, including settings.
- **Manager**: builds and publishes schedules, approves swaps and time off, runs forecasting, manages the team.
- **Events team**: creates and edits BEOs and staffing needs. Doesn't touch the schedule.
- **Employee**: sees their own shifts and the full published schedule, trades and picks up shifts, requests time off, and reads BEOs.

Employees never see drafts, coworkers' contact info or pay rates, or client contact details on BEOs.

## Run it locally

```bash
npm install
npm run build
SEED_DEMO=true npm start      # http://localhost:3000 — sign in as moe@demo.shiftboard / demo1234
```

For development with hot reload: `npm run dev:demo` (the API runs on :3000, and Vite prints its own URL).

Start without the demo data: `ADMIN_EMAIL=you@restaurant.com ADMIN_PASSWORD=choose-one npm start`. This creates the first admin account. Everything else is set up from the app: add job codes, add employees, then import or build the first week.

Tests: `npm test`

## Deploy

It's a single Node service with a SQLite file, so it runs anywhere with a persistent disk.

**Render**: the repo includes `render.yaml`. Create a new Blueprint from the repo, then set `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The 1 GB disk at `/data` holds the database.

**Docker / any VPS**
```bash
docker build -t shiftboard .
docker run -d -p 3000:3000 -v shiftboard-data:/data \
  -e ADMIN_EMAIL=you@restaurant.com -e ADMIN_PASSWORD=change-me shiftboard
```
Put it behind HTTPS (Caddy, Cloudflare, or the platform's TLS). Session cookies are `Secure` when `NODE_ENV=production`.

| Env var | Default | Notes |
|---|---|---|
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | SQLite DB and auto-generated secret |
| `JWT_SECRET` | auto | Generated and saved to `DATA_DIR/.secret` if not set |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | | First-run admin account |
| `SEED_DEMO` | | `true` loads the demo restaurant on first run |
| `TZ` | | Set to the restaurant's time zone (e.g. `America/Denver`) |

Back up by copying `DATA_DIR/shiftboard.db` (it uses SQLite WAL, so `sqlite3 shiftboard.db ".backup backup.db"` is safest).

## Architecture

```
core/       Business logic shared by server + demo (pure JS, no I/O)
  service.js   every API method, with its permission checks
  forecast.js  covers/sales forecast, labor math, "until close" estimates
  beo.js       banquet staffing ratios
  importer.js  spreadsheet/CSV schedule parser
  store.js     in-memory document store
  seed.js      demo data (the real week of 9/28/2026)
server/     Express API (one RPC endpoint + auth), SQLite write-through persistence, iCal feed
web/        React UI (Vite). DEMO=1 builds a self-contained single-file demo that runs core/ in the browser
test/       node:test suites for scheduling, swaps, forecast, events, importer
```

The API is `POST /api/rpc/<method>` with a JSON body. Every method enforces its own role check in `core/service.js`, so the web app, the demo, and any future mobile app or integration share one set of rules.

## Roadmap ideas
- SMS/email notifications (Twilio / SendGrid) alongside the in-app ones
- POS integration (Toast / Square) to pull daily sales automatically
- Time clock and tip pooling
- Multi-location
- Push notifications via PWA
