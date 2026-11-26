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

## Building
| Feature | Notes |
|---|---|
| Ask ShiftBoard (built-in Claude, Haiku; usage metered and capped per restaurant) | building |
| Google Business Profile + Yelp reviews: alerts, AI-drafted replies | building |

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
- OpenTable partner application (Sync API + Reviews API) / Google Business Profile / Yelp access
- Decide which plans get Positive impact and the Claude connector (now Pro and Beta)
- Resend rate vs. the 30-second function limit before turning on "attach PDF" for restaurants with more than ~50 staff
- GM questions doc: https://claude.ai/artifact/KAcj1WFSkXzktm78FX5zoC
