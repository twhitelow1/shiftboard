# Claude connector (MCP)

People add ShiftBoard to Claude and ask it things like "When do I work this week?", "Who's the manager on tonight?",
"Request next Friday off", "86 the burrata" or, for managers, "Draft a server shift Saturday at 4 for Alex" and
"Publish next week". Claude acts **as the signed-in person, with exactly their permissions**: every tool calls the
same RPCs the app calls (`svc.call(user, method, args)`), so roles, plan features, privacy and contact visibility
are the app's own rules.

It works in claude.ai on the web, the Claude desktop apps, the Claude phone apps and Claude Code.

- Code: `server/mcp/` (the MCP endpoint and the OAuth 2.1 authorization server), `server/tools/` (the tools,
  usable by any AI integration), `web/src/pages/ConnectClaude.jsx`, `ConnectedApps.jsx`, `ClaudeConnector.jsx`.
- Tests: `test/mcp.test.js`, `test/mcp-platform.test.js`.

## The connector URL

Each restaurant has its own: its ShiftBoard address followed by `/mcp`, for example

```
https://bistro.shiftboard.app/mcp
https://schedule.yourrestaurant.com/mcp
```

Admins see it in **Settings → Claude connector** with a Copy button. The restaurant comes from the host, like the
rest of the app: a connection made at one restaurant's address works only there.

## Connect it

### claude.ai (Free, Pro, Max)

1. In claude.ai, open the connectors page (**Customize → Connectors**, `https://claude.ai/customize/connectors`;
   older accounts show it under **Settings → Connectors**). Choose **Add → Add custom connector**.
2. Name it `ShiftBoard`, paste the connector URL and click **Continue**.
3. Keep the authentication settings Claude marks **Detected**: **Sign in now** and **Register automatically**
   (Dynamic Client Registration). Don't pick "Use Claude's published identity": ShiftBoard doesn't support Client ID
   Metadata Documents yet. Leave the OAuth client ID and secret empty. Click **Add**.
4. Click **Connect**. A ShiftBoard page opens: sign in as yourself (password and your second step, or a passkey),
   look at what Claude will be able to do, optionally tick **Read only**, and click **Allow**.
5. In a chat, turn ShiftBoard on from the **+** menu (under Connectors) if it isn't already.

On the Free plan, an account can add one custom connector.

### Team and Enterprise

An **Owner** adds the connector once for the organization: **Organization settings → Connectors**
(`https://claude.ai/admin-settings/connectors`) → **Add → Custom** (type **Web** if asked), name and URL, keep the
detected settings, **Add**. It then shows in each member's connectors, labeled custom: each member clicks **Connect**,
which opens the same ShiftBoard sign-in and consent, so everyone connects as themselves.

### Desktop and phone apps

Connectors added on claude.ai sync to the Claude desktop apps (macOS, Windows) and the iPhone and Android apps
signed in to the same account. Nothing more to do; the first use may ask you to connect if you haven't.

### Claude Code

```bash
claude mcp add --transport http shiftboard https://bistro.shiftboard.app/mcp
```

Then in Claude Code run `/mcp`, pick **shiftboard** and **Authenticate**: your browser opens ShiftBoard's sign-in
and consent; Claude Code receives the connection on a `http://localhost:<port>/callback` address. Add `--scope user`
to have it in every project.

## What Claude can do (the tools)

A person only gets the tools their role and their restaurant's plan allow; a **read-only** connection gets only the
read tools. Every tool checks all of that again when it runs. Dates are `YYYY-MM-DD` in the restaurant's time zone;
the tools also understand "today", "tomorrow", "friday", "next friday", "this week" and "next week" (and the Spanish
words). `whoami` tells Claude today's date there.

| Tool | Who | Plan feature | Changes something | Notes |
|---|---|---|---|---|
| `whoami` | everyone | | | person, role, restaurant, today, the week's first day, features, access |
| `get_my_shifts` | everyone | | | default: the next 14 days |
| `get_schedule` | everyone | | | a day or a week, by room or position; managers can include drafts |
| `get_open_shifts` | everyone | | | open shifts and giveaways, with "can you pick it up" |
| `who_is_working` | everyone | | | now, today or a date |
| `get_manager_on_duty` | everyone | Training | | with their phone and the call-out line |
| `get_time_off` / `request_time_off` | everyone | | request | approvers can list everyone's |
| `get_availability` / `set_availability` | everyone | | set | managers can read someone else's |
| `get_trade_requests` | everyone | | | mine, offered to me, waiting on approval |
| `offer_shift` / `pick_up_shift` / `cancel_request` | everyone | | yes | giveaway or trade; open shift or accept an offer |
| `get_86_list` / `report_86_item` / `mark_back_in_stock` | everyone | 86 List | report, clear | who can report on which list is the app's rule |
| `search_menu` / `search_handbook` | everyone | Training | | recipes and prep only if the person's position may see them |
| `get_events` / `get_event` | everyone | Events | | client details only for managers and the events team |
| `get_notifications` | everyone | | | doesn't mark them read |
| `get_my_tips` | everyone | Tip pool | | their own share only |
| `get_pending_approvals` / `approve_request` / `deny_request` | managers, and supervisors when Settings allows | | approve, deny | never their own requests |
| `create_shift` / `update_shift` / `delete_shift` | managers | | yes | drafts; changing or deleting a **published** shift needs `confirm: true` |
| `publish_week` | managers | | yes | needs `confirm: true`; the description tells Claude to ask first |
| `get_team` | managers | | | contact details only where the app shows them |
| `get_forecast` / `get_labor_summary` | managers | Forecast & labor | | |
| `get_86_history` | managers | 86 List | | |
| `save_event` / `suggest_event_staffing` | managers and the events team | Events | save | create or update a BEO; staff on it are notified |

What Claude changes notifies people exactly as when it's done in the app (in-app, email, phone, texts), and every
change is written to the restaurant's audit log as `claude.<tool>` with `via: 'claude'` and the client's name.

**Adding tools.** Tools live in `server/tools/<feature>.js` as `defineTool({ name, description, input (zod), write,
confirm, role, feature, consent, handler(user, args, ctx) })` and are listed in `server/tools/index.js`. The
registry is transport-agnostic: `toClaudeTool(tool)` gives `{ name, description, input_schema }` for the Claude
Messages API, and `createToolContext` / `runTool` run a tool for a person outside MCP (an in-app assistant).
`setRoleFeatureCheck(fn)` is the hook for role features when the role editor lands. Reports, Announcements (send
needs `confirm: true`) and the new Trades & pickups RPCs are a file each when those branches merge.

## Settings (admins)

**Settings → Claude connector**, shown when the plan includes it:

- **Let people connect ShiftBoard to Claude**: on by default. Off: nobody can connect, and existing connections stop
  working until it's back on (they aren't deleted).
- **Staff connections are read-only**: Employees and Supervisors get read-only connections; managers and admins can
  still make changes through Claude.
- The connector URL to copy, how many people are connected, and the steps above.

Everyone sees their own connections in **My settings → Sign-in & security → Connected apps**: "Claude, connected
<date>, last used <date>", with **Disconnect**.

**Plans** (`server/platform/plans.js`): the `mcp` feature is in **Pro** and **Beta**. Not in **Starter**: most of
what the connector adds for a restaurant is managers' work (drafts, approvals, forecast, events) that's Pro already,
and keeping Starter simple keeps its price simple. DubLow can switch it on for one Starter restaurant in the console
(features override). The demo build has no server, so its Settings card only says it works in the hosted app.

## How sign-in works (OAuth 2.1)

```
Claude ── GET /mcp (no token) ─────────────► 401 WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"
Claude ── GET /.well-known/oauth-protected-resource/mcp ─► { resource: https://<host>/mcp, authorization_servers: [https://<host>] }
Claude ── GET /.well-known/oauth-authorization-server ──► endpoints, S256, scopes
Claude ── POST /oauth/register (DCR) ─────► client_id (signed, nothing stored)
Browser ─ GET /oauth/authorize?…&code_challenge=…&state=… ─► 302 /#/authorize?r=<signed request>
          ShiftBoard's sign-in (password + second step, or a passkey) → the consent screen → Allow
Browser ◄─ https://claude.ai/api/mcp/auth_callback?code=…&state=…&iss=https://<host>
Claude ── POST /oauth/token (code + code_verifier) ─► access token (1 hour) + refresh token (30 days, rotating)
Claude ── POST /mcp  Authorization: Bearer … ─► tools
```

- **Discovery**: RFC 9728 at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`,
  RFC 8414 at `/.well-known/oauth-authorization-server`, and `WWW-Authenticate` with `resource_metadata` and `scope`
  on every 401 from `/mcp`. Each restaurant host is its own issuer.
- **Dynamic Client Registration** (RFC 7591) at `/oauth/register`, stateless: the client's metadata is signed into its
  `client_id` (HMAC with a per-restaurant key), so Claude registering on every new connection stores nothing. Only these
  redirect URIs are accepted, compared exactly: `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`, and `http://localhost:<port>/callback` / `http://127.0.0.1:<port>/callback`
  (any port: Claude Code picks one each time, RFC 8252). Public clients (`none`) and confidential clients
  (`client_secret_post` / `client_secret_basic`, the secret derived from the client id) both work. Rate-limited per
  address and per restaurant.
- **Authorize**: `response_type=code`, **PKCE S256 required**, **state required**, `scope` and `resource` (RFC 8707)
  checked. Problems with the client or redirect URI show a page; anything else goes back to the app with an error.
  The request is signed and sent to the app's `#/authorize` page (15 minutes).
- **Sign-in and consent**: ShiftBoard's own sign-in screens (`SignIn.jsx`, the second step, passkeys). Connecting
  needs a sign-in from the last 10 minutes, even if the browser was already signed in, never a "Sign in as owner"
  support session, and the terms accepted. The consent screen says who Claude will act as (name, role, restaurant),
  what it will be able to do (from the tools this person would get), the address it returns to (and a warning for
  apps on this computer), with **Read only**, **Allow** and **Deny**. Bilingual and phone-first.
- **Codes**: random, stored as SHA-256 hashes, single use, 5 minutes, bound to the client, redirect URI and PKCE
  challenge. A failed exchange spends the code; a code used twice revokes the connection it made.
- **Access tokens**: HS256 JWTs, 1 hour, signed with a key derived for this restaurant's schema, carrying the
  restaurant (`t`), this host's `/mcp` (`aud`), the issuer, the person, their `sessionVersion`, the connection and the
  scopes. Every request also checks the stored connection, so revoking is immediate.
- **Refresh tokens**: random, stored as hashes, 30 days from issue, **rotated** on every use and bound to the client.
  Presenting an already-rotated refresh token ends the connection (reuse detection), except within 30 seconds of the
  rotation, which is treated as two refreshes racing (that one just fails). Errors are RFC 6749 `invalid_grant`.
- **Connections end** when the person's `sessionVersion` changes (password change or reset, second step reset,
  "sign out everywhere"), when they're deactivated, when they Disconnect, when the app revokes (RFC 7009
  `/oauth/revoke`), or when an admin turns the connector off (until it's back on). Connecting Claude again replaces the
  person's earlier Claude connection (Claude registers a new client each time); Claude Code connections stay separate.
- **Scopes**: `shiftboard.read` and `shiftboard.write` (`offline_access` is accepted and ignored; refresh tokens are
  always issued). Read-only connections list no write tools, and every tool checks its scope when it runs.
- **Rate limits** (shared across instances, hashed keys): 60 tool calls a minute per connection and 600 per
  restaurant; 60 token requests per client and 1200 per restaurant per 15 minutes; 20 registrations an hour per
  address and 200 per restaurant. `MCP_CALLS_PER_TOKEN`, `MCP_CALLS_PER_RESTAURANT`, `MCP_TOKEN_PER_CLIENT`,
  `MCP_TOKEN_PER_RESTAURANT`, `MCP_REGISTER_PER_IP`, `MCP_REGISTER_PER_RESTAURANT` change them.
- **Audit log**: `claude.authorized`, `claude.denied`, `claude.connected`, `claude.revoked` (with the reason),
  `claude.settings`, and `claude.<tool>` for every change, each with `via: 'claude'` and the client's name.

### Security notes

- Tokens and codes are never stored in plain text and never logged; comparisons of secrets are constant-time.
- Tenant isolation: keys are derived per restaurant schema, tokens carry the restaurant and the host's resource,
  and connections live in the restaurant's own data. A token, client id, refresh token or consent request from one
  restaurant is refused on any other host (tested on the platform).
- `/mcp` accepts the token only in the `Authorization` header, never in the URL. It uses no cookies, so it answers any
  origin (CORS `*`) without DNS-rebinding risk; the consent and settings APIs use the session cookie and refuse
  other origins.
- The MCP endpoint is stateless (the SDK's `StreamableHTTPServerTransport` with no session ids, JSON responses):
  each request builds a server with this person's tools, so it runs on Vercel's serverless functions.
- Publishing a week, and changing or deleting a published shift, need `confirm: true`; the tool descriptions and the
  server's instructions tell Claude to ask the user first.
- Errors are helpful sentences in the person's language (English or Spanish).

### Claude's callback URLs (checked November 2026)

Anthropic's connector docs ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication))
say the hosted apps (claude.ai, Desktop, phone, Cowork) use exactly `https://claude.ai/api/mcp/auth_callback`, and
Claude Code uses a loopback redirect on a port that changes, declaring `http://localhost/callback` and
`http://127.0.0.1/callback` (match them port-agnostic). Anthropic's help center says the callback may move to
`https://claude.com/api/mcp/auth_callback`, so both are allowed. The same docs say: return 401 with
`resource_metadata` to start sign-in, list the issuer first in `authorization_servers`, accept
`application/x-www-form-urlencoded` at the token endpoint, answer within 10 seconds (30 for refresh), use
`invalid_grant` for dead refresh tokens, and rotate refresh tokens for public clients. All of that is done.
Claude can also use a Client ID Metadata Document instead of DCR when the server advertises it; ShiftBoard
doesn't yet (DCR works everywhere), see "Later" below.

## Deploying

`vercel.json` sends `/mcp`, `/oauth/*`, `/.well-known/oauth-protected-resource[/…]` and
`/.well-known/oauth-authorization-server[/…]` to the API function. No new environment variables are needed: keys are
derived from `JWT_SECRET` (or the generated secret). Changing `JWT_SECRET` ends every Claude connection (people
connect again). Anthropic's requests come from `160.79.104.0/21`, if a firewall needs to allow them.

## Troubleshooting

- **"Couldn't reach the MCP server" in Claude**: check `https://<host>/.well-known/oauth-protected-resource/mcp`
  answers JSON. A 404 there means the restaurant's plan doesn't include the connector (or the URL is for another
  address); a 403 means an admin turned it off or the account is paused.
- **The ShiftBoard page says the request expired**: it's valid for 15 minutes; start again from Claude.
- **"Sign in again to connect"**: connecting needs a sign-in from the last 10 minutes. Sign in on that page.
- **"Your ShiftBoard connection has ended"**: the password was changed, the second step was reset, the person was
  deactivated, or someone disconnected it. In Claude: Settings → Connectors → ShiftBoard → Connect.
- **Claude says it can't make changes**: the connection is read-only (chosen at Allow, or the restaurant made staff
  read-only). Disconnect and connect again without Read only.
- **A manager tool is missing**: tools follow the role and the plan. Check the person's role in Team, and the plan.
- **Claude Code**: `claude mcp list` shows the server; `/mcp` re-authenticates; the redirect must be
  `http://localhost:<port>/callback` or `http://127.0.0.1:<port>/callback`.
- **Too many requests**: 60 tool calls a minute per connection; wait a minute.

## Later

- Client ID Metadata Documents (CIMD), so Claude needn't register: advertise `client_id_metadata_document_supported`
  and fetch and cache Claude's metadata document (allowlisting its hosts).
- Reports, Announcements and the new Trades & pickups tools when those branches merge; role features through
  `setRoleFeatureCheck`.
