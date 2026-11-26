# Ask ShiftBoard (built-in Claude)

People ask ShiftBoard in plain words, in English or Spanish: "Who's working tonight?", "When do I work next?",
"What's 86'd?", and managers "Who's over 40 hours this week?" or "Publish next week". Claude answers from
ShiftBoard's own tools, **as the signed-in person with exactly their permissions** (role, plan ∩ Roles & features,
privacy, contact visibility), the same tools the Claude connector uses (`server/tools/`).

- Web: **Ask ShiftBoard** in the menu (`#/ask`). Phone app and `/app`: **More → Ask ShiftBoard**.
- Model: Claude Haiku 5.5 (`claude-haiku-5-5`), low effort, with prompt caching on the rules and tools.
- Code: `server/ai/` (the one way into Claude: metering, caps, keys), `server/assistant/` (the chat, the tool loop,
  conversations), `web/src/pages/Assistant.jsx`, `mobile/src/app/(app)/ask.tsx`.
- Tests: `test/assistant.test.js`, `test/assistant-platform.test.js` (a fake Anthropic client; no network).

## What it does and doesn't do

- **Reads run on their own.** Claude looks things up with the person's read tools, up to 6 rounds per question,
  then answers. Text streams in on the web; the phone gets the whole answer at once.
- **Changes never run on their own.** When Claude calls a tool that changes something (publish a week, add or
  change a shift, request time off, trade, approve, 86 an item…), the loop stops and the app shows a card with what
  will happen and **Confirm / Cancel**. Only the tap runs it, once, as that person, with an audit log entry
  (`assistant.<tool>`, via `assistant`). Cards expire after an hour.
- **View as** is read-only: the assistant is off while viewing as someone, spends nothing, and never shows the viewed
  person's conversations.
- **Conversations** are the person's own (nobody else, admins included, can read them): the last 20, for 30 days,
  in the restaurant's own data. **Clear history** deletes them.
- "AI can make mistakes" is on every screen. It only answers about ShiftBoard.

## Setup (DubLow, once)

1. In the Anthropic Console (console.anthropic.com), create an API key for ShiftBoard in DubLow's organization.
   Under **Limits**, set a **monthly spend limit** a little above what you expect (see costs below): it's the last
   line of defense if something goes wrong with ShiftBoard's own caps.
2. In Vercel → the project → Settings → Environment Variables, add `ANTHROPIC_API_KEY` for Production (and Preview
   if you test there) and mark it **Sensitive**. Redeploy.
3. That's it: Pro and Beta restaurants have Ask ShiftBoard on (the plan feature `assistant`). Turn it on for one
   Starter restaurant in the console's Features if you want.

Optional env vars (all have defaults):

| Variable | Default | What |
|---|---|---|
| `AI_DISABLED` | off | `true` turns all AI off everywhere (a kill switch) |
| `AI_MONTHLY_CAP_USD` | 5 | the cap on a single-restaurant install (the platform uses the plan's, or the console's) |
| `AI_DAILY_MESSAGES` | 50 | messages per person per day |
| `AI_MESSAGES_PER_MINUTE` | 8 | messages per person per minute |
| `AI_CALLS_PER_MINUTE` | 120 | API calls per restaurant per minute (every AI feature together) |
| `AI_TURN_BUDGET_MS` | 22000 | no new tool round after this (Vercel's function limit is 30 s, `vercel.json`) |

## How usage and caps work

Every API call is recorded: restaurant, person (id), purpose (`assistant`, `review_reply`…), model, input, output
and cache tokens, the estimated cost in USD, who pays (DubLow's key or the restaurant's own), and ok or an error
code. **Never** the question, the answer or anything else people typed. On the platform the rows are in
`platform.ai_usage` tagged with the restaurant; a single-restaurant install keeps them in its own schema. Prices are
one constant, `server/ai/pricing.js` (Haiku 5.5: $0.10 / $0.50 per million input / output tokens, cache reads $0.01,
cache writes $0.125, 5x for prompts over 100K tokens).

- **Monthly cap per restaurant** on DubLow's key: the plan's (`aiMonthlyCapUsd` in `server/platform/plans.js`,
  $5 on Pro and Beta), unless DubLow sets one for the restaurant in the console (restaurant → **Ask ShiftBoard (AI)**:
  this month's spend, calls, errors and the cap; blank = the plan's, 0 = stop on DubLow's key). When it's reached,
  Ask ShiftBoard answers with a friendly message (EN/ES) until the 1st, and nothing is sent to Anthropic.
- **At 80%** the restaurant's admins get an in-app notification, once a month.
- **Per person**: 50 messages a day, 8 a minute (friendly messages, nothing spent).
- **Bring your own key**: an admin pastes the restaurant's own Anthropic key in **Settings → Integrations →
  Anthropic** (encrypted like Toast's and ADP's keys; only "set, ends in 1234" ever comes back). Its calls are still
  metered (shown separately) but don't count against DubLow's cap; Anthropic bills the restaurant.
- Admins see this month's use against the cap, and who uses it most, in **Settings → Ask ShiftBoard**, where they can
  also turn it off, or limit it to managers. Roles & features can turn it off for one role.

## Cost estimate per restaurant per month

Assumptions: a typical question takes 2 API calls (one round of tool reads, then the answer). Each call sends about
6,000 tokens of rules and tool definitions (read from the prompt cache after the first call in 5 minutes), about
3,000 uncached tokens (the person, the conversation, the tool results) and gets about 300 tokens back (low effort).

- Per call: 3,000 × $0.10/M + 6,000 × $0.01/M + 300 × $0.50/M ≈ $0.0005 (a cold cache adds ≈ $0.00075 once).
- Per question: ≈ **$0.001–0.002**.
- A restaurant with 25 people asking 3 questions a day each: ~2,250 questions → **≈ $2–4.50 a month**. A quieter
  restaurant (10 people, 1 a day): ≈ $0.30–0.60.
- The worst case is bounded: the $5 cap stops DubLow's spend; the daily limit stops one person running it up.

## Other features using AI

`aiFor({ db, tenant, env, now })` in `server/ai/index.js` is the contract: `available`, `reason`
(`no_key | off | cap | plan`), `complete({ purpose, system, messages, maxTokens, user, tools? })` →
`{ text, usage, stopReason }`, and `stream(...)`. Every call is metered and capped the same way. A new plan feature
that uses AI adds its key to `AI_FEATURES` there. Catch `AiUnavailable` and show its message.
