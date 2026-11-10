# Minimi

A research chat agent that searches the web with **exactly one tool** and remembers **what you asked and when** — so you can later ask *"What did I ask you on 3 November? Is it still correct?"* or *"On Monday we shortlisted 5 CRMs — has any of them changed pricing since?"*

Design rationale: [DESIGN.md](DESIGN.md).

## Quick start (Windows, macOS, Linux)

Requires **Node.js 20.9+** (tested on Node 20.19 LTS, Windows 11).

```bash
npm install
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
# edit .env.local and set GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)
npm run dev
```

Open http://localhost:3000. The app boots without a key; chatting then shows which variable to set.

Values in `.env.local` take priority over machine-wide environment variables with the same name (so an old system `GEMINI_API_KEY` cannot shadow the project key), and are re-read on each request — no restart needed after adding a key.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_PROVIDER` | no | `gemini` | `gemini` or `openai` |
| `GEMINI_API_KEY` | yes (gemini) | – | Free Google AI Studio key |
| `GEMINI_FALLBACK_MODELS` | no | `gemini-3.1-flash-lite` | Tried in order when the primary model is overloaded or unavailable |
| `GEMINI_MODEL` | no | `gemini-3.5-flash-lite` | Must support the Google Search tool on your tier (`npm run models` checks) |
| `OPENAI_API_KEY` | yes (openai) | – | Only if `LLM_PROVIDER=openai` |
| `OPENAI_MODEL` | no | `gpt-5-mini` | Responses API model with `web_search` |
| `MEMORY_DISTILL` | no | `heuristic` | `model` adds one small LLM call per research turn |
| `MINIMI_DB_PATH` | no | `./data/minimi.db` | SQLite file (git-ignored) |
| `AGENT_TIMEOUT_MS` | no | `120000` | Per-turn timeout |

`npm run probe` sends one live search request with your key; `npm run models` lists the Gemini models your key can use and whether Google Search grounding is enabled for each (neither prints the key).

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
  lib/agent/provider.ts   provider interface, OpenAI adapter, single-search-tool invariant
  lib/agent/gemini.ts     Gemini adapter: googleSearch grounding, citation insertion
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

- Free tiers are rate-limited (requests per minute/day); the UI shows a clear retry message when a limit is hit.
- Gemini cannot be *forced* to search; for "has it changed?" turns the app instructs it to, and the answer is labelled when no web check happened.
- Gemini grounding links are Google redirect URLs; the publisher domain is shown alongside each source.
- **Free Gemini keys cannot use Google Search** (verified 10 Nov 2026: every model available to a new free key returns 429 when the Search tool is attached; `gemini-3.6/3.7/3.8-flash` were also 503-overloaded, Gemini 2.5 is closed to new users). The default `gemini-3.5-flash-lite` (fallback `gemini-3.1-flash-lite`) works for chat and memory. The app then answers without search and labels the reply **web search unavailable**; enable billing on the key (or use `LLM_PROVIDER=openai`) for verified, cited answers.
- Single-user, single-process; the workspace id lives in the browser's localStorage.
