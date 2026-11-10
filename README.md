# Minimi

A research chat agent that searches the web with **exactly one tool** and remembers **what you asked and when**. You can come back later and ask *"What did I ask you on 3 November? Is it still correct?"* or *"On Monday we shortlisted 5 CRMs — has any of them changed pricing since?"*

Design rationale: [DESIGN.md](DESIGN.md).

## Stack

| Concern | Choice | Free tier |
|---|---|---|
| LLM | Groq · `openai/gpt-oss-120b` (tool calling) | yes, no card (≈30 req/min, 8K tokens/min, 1K req/day) |
| Web search | Tavily Search API, behind the agent's single `web_search` tool | 1,000 credits/month, no card (1 credit per query) |
| Memory | SQLite + FTS5 (`better-sqlite3`), app-owned | local |
| App | Next.js App Router, React, TypeScript, SSE streaming | – |

No paid options are used: Tavily runs at `basic` depth (1 credit). When a quota runs out the app stops calling that service and says so in the answer. It never upgrades a plan.

## Quick start (Windows, macOS, Linux)

Requires **Node.js 20.9+** (tested on Node 20.19 LTS, Windows 11).

```bash
npm install
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
# edit .env.local: set GROQ_API_KEY and TAVILY_API_KEY
npm run dev
```

Open http://localhost:3000. The app boots without keys. Without `GROQ_API_KEY`, chat shows which variable to set. Without `TAVILY_API_KEY`, chat and memory still work, but current facts are marked unverified.

Values in `.env.local` take priority over machine-wide environment variables with the same name. They are re-read on every request, so no restart is needed after adding a key.

`npm run probe` checks both keys live (Groq answer, one Tavily search, one full tool-call round trip) without printing them.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | yes | – | Groq key (https://console.groq.com/keys) |
| `TAVILY_API_KEY` | for search | – | Tavily key (https://app.tavily.com) |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Must support tool calling |
| `GROQ_REASONING_EFFORT` | no | `low` | Raised to `medium` for change checks |
| `MAX_SEARCHES_PER_TURN` | no | `6` | Tavily queries per answer (credit guard) |
| `MEMORY_DISTILL` | no | `heuristic` | `model` adds one small LLM call per research turn |
| `MINIMI_DB_PATH` | no | `./data/minimi.db` | SQLite file (git-ignored) |
| `AGENT_TIMEOUT_MS` | no | `120000` | Per-turn timeout |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm test` | All tests (deterministic, no API key, no network) |
| `npm run eval` | Only the PRD acceptance scenarios |
| `npm run probe` | Live check of the Groq + Tavily keys |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run build` | Production build |
| `npm run check` | Typecheck, lint, tests and build |

## Architecture

```
src/
  app/api/chat             SSE endpoint → runTurn
  app/api/conversations    list / create / rename / delete
  app/api/memory           read-only memory inspector feed (UI only, not a model tool)
  lib/agent/run.ts         turn orchestration, persistence, idempotency, cancellation
  lib/agent/provider.ts    provider interface + single-tool invariant
  lib/agent/groq.ts        Groq adapter: streaming tool loop (max 4 rounds, search budget)
  lib/agent/webSearchTool.ts  the one tool: schema, arg validation, execution, result formatting
  lib/search/              search layer interface + Tavily implementation (quota circuit breaker)
  lib/agent/prompt.ts      system rules, intent directives, untrusted memory block
  lib/agent/sources.ts     source dedupe and provenance (cited / searched / unverified link)
  lib/memory/query.ts      intent and term analysis
  lib/memory/retrieval.ts  date lookup, FTS, referent scoring, ambiguity detection
  lib/memory/extract.ts    memory distillation (heuristic + validated model JSON)
  lib/time/dates.ts        timezone-correct date parsing ("last Tuesday", "3 November")
  lib/db/                  SQLite schema, migrations, FTS5, repository
  components/              chat UI, sources, recall badges, memory inspector
tests/                     scenarios + unit tests with scripted Groq and mocked Tavily
```

## Tests

- **PRD §8 scenarios** (`tests/scenarios.test.ts`), end to end with fixed clocks and a scripted model:
  - Monday CRM shortlist change check
  - 3 November exact recall plus re-check, including a UTC/IST date-boundary case
  - last-Tuesday Postgres pricing
  - no-memory honesty
  - prompt injection
  - persistence across restart
  - no-key behaviour
  - the one-tool surface
- **Groq + Tavily layer** (`tests/groq-tavily.test.ts`), with a scripted streaming Groq client and a mocked `fetch`:
  - the tool loop, search budget and round limit
  - malformed and unknown tool calls
  - `tool_use_failed` recovery
  - Tavily request shape and result mapping
  - quota exhaustion (circuit breaker), and auth, rate-limit and network errors
- **Other unit tests**: date parsing, FTS, referent ambiguity, idempotency, turn ordering, cancellation and error mapping.

## Limitations

- **Free tiers are small.** Groq allows about 8K tokens per minute, so several research turns in quick succession can hit 429; the UI then shows a retry message. Tavily gives 1,000 queries a month.
- **Source dates are estimates.** Tavily's `published_date` is its best guess and is often missing for non-news pages.
- **Single user, single process.** The workspace id lives in the browser's localStorage.
