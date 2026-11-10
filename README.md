# Minimi

A personal research agent with **one tool, web search**, and memory built around three questions:
- **What did I ask, and when?** Exact recall of past questions by date or topic, across conversations.
- **What did I promise, and what is still open?** Commitments, waiting-on items and deadlines (open loops), plus how decisions evolved.
- **Has it changed since?** Dated research snapshots compared with fresh evidence, with official sources and validated citations.

Design rationale: [DESIGN.md](DESIGN.md) · audit of the earlier version: [ENGINEERING_AUDIT.md](ENGINEERING_AUDIT.md) · measured results: [EVALUATION.md](EVALUATION.md) and [eval/live.md](eval/live.md).

## Quick start (Windows, macOS, Linux)

Requires **Node.js 20.9+** (tested on Node 20.19 LTS, Windows 11).

```bash
npm install
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
# edit .env.local: set GROQ_API_KEY and TAVILY_API_KEY (both free, no card)
npm run dev
```

Open http://localhost:3000.

- **No `GROQ_API_KEY`:** the app still boots, and chat shows exactly which variable to set.
- **No `TAVILY_API_KEY`:** chat, memory and open loops work, and current facts are marked unverified.
- **Precedence:** values in `.env.local` override machine-wide environment variables and are re-read on every request, so no restart is needed after adding a key.
- **Check your keys:** `npm run probe` tests both keys live (one Groq answer, one Tavily search, one full tool-call round trip) without printing them.

## What to try

| Ask | What happens |
|---|---|
| "We're a 20-person sales team. Shortlist 5 CRMs with pricing." | Batched search, official pricing pages read in full, `[n]` citations, a dated snapshot saved |
| "Has any of them changed pricing since?" (new chat) | Resolves "them" to the shortlist; required search; app-computed Then/Now table |
| "What did I ask you on 3 November?" | Verbatim questions with local times; no search |
| "Is your answer still correct today?" | Re-verifies the recalled answer against current sources |
| "I'll send the proposal to Rahul by Friday." then "What's pending?" | Commitment with a real due date; answered from memory |
| "I sent Rahul the proposal." | Closes that commitment, with the evidence linked |
| "How has my thinking about the database changed?" | Decision timeline with superseded steps and stated reasons |

The **Open loops** and **Memory** views show the same records: their provenance (quote, date, conversation), corrections, and deletion.

## Accounts and the demo

Minimi is **local-first**: your conversations, memories, open loops and research history live in the local SQLite file. Signing in only establishes *identity* — it does not move your data to any cloud service, and there is no background sync.

### Two modes

- **LOCAL mode (default).** No OAuth keys configured: a single user, no sign-in screen, a random workspace id kept in the browser. Works exactly as before. This is a single-user trust model — do not expose it as a shared deployment.
- **AUTH mode.** Turns on automatically when `AUTH_SECRET` **and** at least one provider (`*_CLIENT_ID` + `*_CLIENT_SECRET`) are set. The workspace is then decided by the server-side session, and the browser-supplied header is ignored. Every route requires a session.

There is no email/password: sign-in is only via OAuth.

### GitHub (required for the button)

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Homepage URL: `http://localhost:3000`
3. Authorization callback URL: `http://localhost:3000/api/auth/callback/github`
4. Copy the client id/secret into `.env.local` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and set `AUTH_SECRET` to any long random string:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

### Google (optional)

1. Google Cloud console → **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
2. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Scopes are minimal (`read:user user:email` for GitHub, `openid email profile` for Google); tokens are used once to read your profile and never stored.

Behind a proxy or tunnel, set `PUBLIC_BASE_URL` to the public origin (e.g. `https://minimi.example`) so the callback URLs are built correctly. On first sign-in you are offered the chance to attach your existing local workspace to the account — this is never automatic. **Account deletion** removes the user, its workspaces and everything derived from them. The **"Your data"** menu also has an account section and a sign-out.

### Try demo

"Try the demo" appears on the sign-in screen and, in LOCAL mode, in the sidebar. It creates a throwaway, seeded workspace (a CRM shortlist snapshot, a later re-check with a computed change report, a dated Node.js question, commitments/waiting/intentions and a MongoDB→PostgreSQL decision history). Everything on screen is labelled synthetic, and it only ever lives in a `kind='demo'` workspace. Demo sessions have their own budget (default 8 model turns, 15 Tavily credits) and a per-IP creation limit, suggested answers are cached, and the workspace expires after 24 h. When the live budget is spent, memory, open loops and history keep working. Use **Reset demo** to start over, or **Sign in** to keep your own data.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | yes | – | Groq key (https://console.groq.com/keys) |
| `TAVILY_API_KEY` | for search | – | Tavily key (https://app.tavily.com) |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Must support tool calling |
| `GROQ_REASONING_EFFORT` | no | `low` | Raised to `medium` for change checks |
| `GROQ_TPM_LIMIT` | no | `8000` | Tokens/min used for request pacing |
| `MAX_SEARCHES_PER_TURN` | no | `6` | Tavily queries per answer |
| `MAX_EXTRACTS_PER_TURN` | no | `3` | Full-page reads per answer |
| `TAVILY_MONTHLY_CREDITS` / `TAVILY_RESERVE_CREDITS` | no | `1000` / `100` | Credit budget, and the reserve kept for change checks |
| `DEFAULT_TIMEZONE` | no | `Asia/Kolkata` | Used when the browser sends no timezone |
| `MEMORY_DISTILL` | no | `heuristic` | `model` adds one LLM call per research turn |
| `MINIMI_DB_PATH` | no | `./data/minimi.db` | SQLite file (git-ignored) |
| `AGENT_TIMEOUT_MS` | no | `120000` | Per-turn timeout |
| `AUTH_SECRET` | for AUTH mode | – | Signs the session cookie and OAuth state. Any long random string |
| `PUBLIC_BASE_URL` | no | request origin | Public origin used to build OAuth callback URLs |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | for GitHub sign-in | – | GitHub OAuth app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Google sign-in | – | Google OAuth client |
| `DEMO_ENABLED` | no | `true` | Show and allow "Try demo" |
| `DEMO_TTL_HOURS` | no | `24` | How long a demo workspace lives |
| `DEMO_MAX_TURNS` / `DEMO_MAX_CREDITS` | no | `8` / `15` | Per-demo model turns and Tavily credits |
| `DEMO_CACHE_TTL_MINUTES` | no | `240` | Freshness of cached guided answers |
| `DEMO_RATE_LIMIT_MAX` / `DEMO_RATE_LIMIT_WINDOW_MINUTES` | no | `5` / `60` | Demo creations allowed per IP |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm test` | All deterministic tests (no keys, no network) |
| `npm run eval` | Labelled evaluation suite → writes `EVALUATION.md` and `eval/results.json` |
| `npm run eval:live` | The three hiring examples plus open loops against real Groq and Tavily → `eval/live.md` (uses about 30 credits) |
| `npm run probe` | Live check of both keys |
| `npm run check` | Typecheck, lint, tests and production build |

## Architecture

```
src/lib/
  agent/       run.ts (turn pipeline) · groq.ts (bounded tool loop, token gate) · webSearchTool.ts (the one tool:
               search → rank → selective extract) · prompt.ts · sources.ts (citation resolution & validation) · provider.ts
  search/      tavily.ts (search + extract, quota breaker) · budget.ts (credit ledger, usage sync, reserve)
  research/    official.ts (vendor-domain & page-type) · rank.ts · observations.ts (price normalisation, then/now
               comparison) · claims.ts (claim→evidence, coverage) · ledger.ts (persistence)
  personal/    classify.ts (commitments/intentions/decisions/preferences/facts) · store.ts (dedupe, supersession,
               lifecycle, corrections, events) · queries.ts (open loops, decision timelines, personal context)
  memory/      query.ts (intent & terms) · retrieval.ts (dates, FTS, referents, routing) · context.ts · extract.ts
  time/        dates.ts (timezone-correct past refs) · due.ts (future deadlines)
  auth/        providers.ts (GitHub/Google code+PKCE) · sessions.ts (hashed tokens) · accounts.ts · csrf.ts · cookies.ts ·
               flow.ts (signed state) · sign.ts · pkce.ts · tokens.ts
  demo/        store.ts (lifecycle, cache, cleanup) · seed.ts (deterministic, demo-only) · budget.ts · rate.ts · prompts.ts
  db/          schema.ts (forward-only migrations v1–v5) · repo.ts
src/app/api/   chat (SSE) · conversations · memory · personal (open loops, corrections) · workspace (export / forget) · status ·
               auth (login, callback/[provider], me, signout, claim, account) · demo (start, reset)
src/app/       page (chat) · signin (shown only in AUTH mode)
src/components/ chat view, sources & evidence, Then/Now card, open loops view, memory view, settings, sign-in, demo bar
```

**Data model:**
- `messages`: immutable; UTC timestamp, timezone and local date.
- `memories`: typed, with quote, confidence, status and due date. Supporting tables are `memory_links` (SUPERSEDES, CONTRADICTS, COMPLETED_BY…), `memory_events` (audit trail and corrections), `entities` and `entity_mentions`.
- `memory_items`: research snapshots; their dated, normalised values live in `observations`.
- Answer evidence: `turn_sources` (official flag, evidence level, source number), `source_extractions`, `claim_evidence`, `change_reports`.
- Budgets and metrics: `api_usage` (credit ledger) and `turn_metrics` (tokens, credits, latency).
- Identity (v5): `users`, `oauth_accounts` (unique provider + provider user id), `sessions` (hashed token), and `workspaces.owner_user_id` / `kind` / `expires_at`. Demo tables: `demo_budgets`, `demo_answer_cache`, `demo_ip_events`.

## Privacy

- **SQLite is the only store.** It is local, under `./data`, and git-ignored. There is no cloud database and no automatic sync.
- **Groq** receives the question, a bounded slice of *retrieved* memory, and search results — never the whole database.
- **Tavily** receives search queries and selected URLs only, never your memories or conversations. Queries are stripped of emails at the egress boundary, and questions answerable from memory ("what did I ask on 3 November?") never trigger a search.
- **Signing in** establishes identity only. Sessions live in SQLite and only the **SHA-256 hash** of the session token is stored; OAuth access tokens are read once for your profile and never persisted.
- **Deleting a conversation** deletes every memory, research snapshot and observation derived from it.
- **The "Your data" menu** exports everything as JSON or forgets everything.
- **Logs** contain sizes and latencies, with secrets redacted.
- **Not encrypted at rest.** SQLite is a plain file: confidentiality relies on OS file permissions and full-disk encryption. If the app is hosted on a remote server, the database sits on that host — that is not "local to the end user".

## Troubleshooting

- **"The API key was rejected"**: check `.env.local`. It takes priority over machine-wide variables with the same name.
- **"Rate limit reached" or slow answers**: Groq's free tier allows about 8K tokens per minute. The app paces requests to stay under it, so a burst of research questions waits instead of failing.
- **"Web search unavailable"**: the Tavily key is missing, or the monthly credits (or the reserve) are used up. The answer is then marked unverified.
- **OAuth `redirect_uri_mismatch` or `state` errors**: the callback URL must match exactly — `http://localhost:3000/api/auth/callback/github` (or `/google`). Behind a proxy/tunnel set `PUBLIC_BASE_URL` to the public origin. A `state` error also appears if the sign-in tab was left open more than 10 minutes (the handshake cookie expired).
- **Sign-in never appears**: AUTH mode needs `AUTH_SECRET` **and** a full provider pair. Without them the app stays in LOCAL mode, by design.
- **The demo says its live budget is spent**: that demo session used its small turn/credit allowance. Memory, open loops and history still work; **Reset demo** starts a fresh one.
- **`better-sqlite3` fails to install**: use Node 20 LTS with the standard Windows build tools, or a Node version with prebuilt binaries.

## Limitations

- Statement extraction is rule-based. It is precise on the patterns it knows, but misses unusual phrasings (see `EVALUATION.md`).
- Then/now values are parsed from the answer's tables. If the model writes prose instead, the computed report says it cannot verify.
- Tavily `published_date` is an estimate and is often missing for non-news pages.
- In LOCAL mode the app is single-user and single-process: the workspace id lives in the browser's localStorage, and turns are serialised in process. Plain HTTP only; it is a single-user trust model, not a hardened multi-tenant deployment, and SQLite is not encrypted at rest.
- Authentication is OAuth-only (GitHub, optionally Google); there is no email/password and no account recovery beyond signing in with the same provider again.
