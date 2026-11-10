# Minimi

A research chat agent that searches the web with **exactly one tool** and remembers **what you asked and when** — so you can later ask *"What did I ask you on 3 November? Is it still correct?"* or *"On Monday we shortlisted 5 CRMs — has any of them changed pricing since?"*

Design rationale: [DESIGN.md](DESIGN.md).

## Quick start (Windows, macOS, Linux)

Requires **Node.js 20.9+** (tested on Node 20.19 LTS, Windows 11).

```bash
npm install
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
# edit .env.local and set GROQ_API_KEY (free key: https://console.groq.com/keys)
npm run dev
```

Open http://localhost:3000. The app boots without a key; chatting then shows which variable to set.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_PROVIDER` | no | `groq` | `groq` or `openai` |
| `GROQ_API_KEY` | yes (groq) | – | Free Groq key |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Must support Groq's `browser_search` tool |
| `GROQ_REASONING_EFFORT` | no | `low` | Raised to `medium` automatically for change checks |
| `OPENAI_API_KEY` | yes (openai) | – | Only if `LLM_PROVIDER=openai` |
| `OPENAI_MODEL` | no | `gpt-5-mini` | Responses API model with `web_search` |
| `MEMORY_DISTILL` | no | `heuristic` | `model` adds one small LLM call per research turn |
| `MINIMI_DB_PATH` | no | `./data/minimi.db` | SQLite file (git-ignored) |
| `AGENT_TIMEOUT_MS` | no | `120000` | Per-turn timeout |

`npm run probe` sends one live request to verify the search tool works with your key (prints shapes and timings, never the key).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm test` | All tests (deterministic, no API key, no network) |
| `npm run eval` | Only the PRD acceptance scenarios |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run build` | Production build |
| `npm run check` | All of the above |

## Architecture

```
src/
  app/api/chat            SSE endpoint → runTurn
  app/api/conversations   list / create / rename / delete
  app/api/memory          read-only memory inspector feed (UI only, not a model tool)
  lib/agent/run.ts        turn orchestration, persistence, idempotency, cancellation
  lib/agent/provider.ts   Groq + OpenAI adapters, single-search-tool invariant
  lib/agent/prompt.ts     system rules, intent directives, untrusted memory block
  lib/agent/sources.ts    source dedupe/provenance, citation-marker rewriting
  lib/memory/query.ts     intent + term analysis
  lib/memory/retrieval.ts date lookup, FTS, referent scoring, ambiguity detection
  lib/memory/extract.ts   memory distillation (heuristic + validated model JSON)
  lib/time/dates.ts       timezone-correct date parsing ("last Tuesday", "3 November")
  lib/db/                 SQLite schema, migrations, FTS5, repository
  components/             chat UI, sources, recall badges, memory inspector
tests/                    scenarios + unit tests with a scripted fake model
```

## Tests

`tests/scenarios.test.ts` covers PRD §8 end to end with fixed clocks and a scripted model: Monday CRM shortlist change check, 3 November exact recall + re-check (including a UTC/IST date-boundary case), last-Tuesday Postgres pricing, no-memory honesty, prompt injection, persistence across restart, no-key behaviour and the one-tool surface. Further unit tests cover date parsing, FTS, referent ambiguity, source provenance, idempotency, turn ordering, cancellation and error mapping.

## Limitations

- Groq's free tier is about 30 requests and 8K tokens per minute; heavy multi-entity checks may hit it (the UI shows a retry message).
- Whether a free Groq key may use `browser_search`, and how its results appear in streamed chunks, is verified with `npm run probe`; OpenAI is a drop-in fallback.
- Single-user, single-process; the workspace id lives in the browser's localStorage.
