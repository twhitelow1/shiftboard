# ShiftBoard roadmap: planned features and progress

The one list of what's planned, what's being built and what's live. Updated with every merge.
Status: **Live** (merged, deployed) · **Building** (a branch/PR in progress) · **Next** (queued) · **Planned** · **Owner** (waiting on Todd/the GM).

_Working name "ShiftBoard"; a new product name is still to be chosen (see Business)._

## Live
| Feature | PR | Notes |
|---|---|---|
| Scheduling, swaps, time off, forecasting, events & BEOs, venue/floor plans | ≤ #10 | |
| Training portal, 86 List, tips, Spanish everywhere, phone-friendly web, PWA push, Twilio texts, Toast | ≤ #10 | |
| Multi-restaurant platform (phase 1), DubLow console, ADP | #11 | |
| Tripleseat sync, BEO PDF import, Rooms & positions, Settings → Integrations, phone app v2 | #12 | |
| Events: tentative counts as confirmed within 2 weeks | #12 | |
| Onboarding, consent records, STOP handling, two-step sign-in | #13 | |
| Phone app in a browser at /app; Expo Go publishing via GitHub | #14 | |
| Roadmap, seasons for reports, legal name vs common name | #15 | |
| View as + Roles & features; Reports + 86 List report (86 List for stock/supplies); Unpublish (notify on/off); Trades & pickups by season; Announcements | #16 | live Nov 26 |
| OpenTable (CSV import today; API once OpenTable approves DubLow as a partner) + Positive impact (5-star mentions, guest requests, kudos; a card in Reports, My Kudos for staff) | #16 | live Nov 26 |
| Claude connector (MCP) for claude.ai / Claude Code: OAuth with two-step sign-in, 36 tools by role | #16 | first real Claude connection still to do |
| Beta error tracking + "Report a problem", console Errors & reports, email alerts + daily digest | #16 | live Nov 26 |
| Schedule PDF (like the wall sheet), Publish options (notify on/off, attach PDF), editable notification emails (EN/ES), all managers on duty | #16 | live Nov 26 |
| **Ask ShiftBoard** (built-in Claude chat for staff and managers, EN/ES, web + phone app + /app): Claude Haiku 5.5, the connector's tools as the signed-in person, changes only on Confirm (audited); **usage metered and capped per restaurant** ($5/month default on Pro and Beta, console override, 80% warning, 50 messages/person/day, bring-your-own key); `server/ai/` for every AI feature | #18 | live Nov 26 |
| Google Business Profile + Yelp reviews: daily sync, staff mentions, review alerts (all / ≤3★ / off), replies posted to Google, **AI-drafted replies** (via `server/ai/`; Yelp: copy and open Yelp, its API can't reply) | #18 | live Nov 26 |
| Day list sorting: who's on by room, position, start time or name (web day view, new desktop Day view, phone app schedule and Today on the floor); desktop grid By position | #18 | live Nov 26 |
| Phone app matches the website's Branding: brand, nav and background colors, light/dark, logo, room-colored banners (website day view and grid too), sign-in backdrop, live refresh | #18 | live Nov 26 |
| Full BEO import: every non-money detail (timeline, menus, dietary, bar, setup, rentals/AV, vendors, notes), shown only where the BEO has it; re-import shows what changed; AI reading for non-Tripleseat BEOs | #19 | live Nov 26 |
| Smart import for employees and menu items: CSV / PDF / DOCX, field matching, preview with changes, AI reading for unstructured files; connector tools to import menus and employees from Claude | #19 | live Nov 26 |

## Building
| Feature | Notes |
|---|---|
| Admins can make themselves Super Admin (re-auth, audited, others alerted), with a Super-Admin-only switch to turn it off | built and tested; in PR #20 |
| Floor plan: import from Toast / a picture or PDF (AI) / CSV, Toast-style editor (shapes, bar seats, walls, sections), export + "set this up in Toast" helper | building |
| Employee sync from other platforms | later (after the import) |

## Next
| Feature | Notes |
|---|---|
| Push notifications in the /app browser version | the website already has them |

## Planned: AI
- Schedule drafting for managers (draft → review → publish)
- Monday digest (labor vs forecast, 86 trends, trades, kudos, upcoming events)
- Review insights (themes, sentiment) on top of review matching
- Writing helper (announcements, SMS-length, Spanish versions)
- Training generator (quiz questions, flashcards, menu translations; manager approves)
- AI BEO parsing for PDFs that aren't Tripleseat's format

## Planned: product and platform
- Stripe billing (card, monthly) + self-serve sign-up with free trial (phase 2)
- Per-restaurant time zones
- Tip pool formula (with the GM)
- App Store / Google Play: developer accounts, TestFlight build, store listing (skill: app-store-registration)
- Verify dublowdigital.com in Resend (email from platform@dublowdigital.com)

## Business / owner
- New product name
- Terms page at dublowdigital.com/terms; privacy policy SMS clause; Anthropic listed as a service provider
- Twilio inbound webhook + 10DLC campaign text
- Anthropic API key in Vercel (`ANTHROPIC_API_KEY`) with a spend limit
- OpenTable partner application (Sync API + Reviews API)
- Google: Cloud project, Business Profile API access form, OAuth consent screen + verification, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, a redirect URI per restaurant host; Yelp: Places API Enhanced plan + `YELP_API_KEY` ([GOOGLE-YELP.md](../integrations/GOOGLE-YELP.md))
- Decide which plans get Positive impact and the Claude connector (now Pro and Beta)
- Resend rate vs. the 30-second function limit before turning on "attach PDF" for restaurants with more than ~50 staff
- GM questions doc: https://claude.ai/artifact/KAcj1WFSkXzktm78FX5zoC
