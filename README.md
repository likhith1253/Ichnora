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
  db/          schema.ts (forward-only migrations v1–v4) · repo.ts
src/app/api/   chat (SSE) · conversations · memory · personal (open loops, corrections) · workspace (export / forget) · status
src/components/ chat view, sources & evidence, Then/Now card, open loops view, memory view, settings
```

**Data model:**
- `messages`: immutable; UTC timestamp, timezone and local date.
- `memories`: typed, with quote, confidence, status and due date. Supporting tables are `memory_links` (SUPERSEDES, CONTRADICTS, COMPLETED_BY…), `memory_events` (audit trail and corrections), `entities` and `entity_mentions`.
- `memory_items`: research snapshots; their dated, normalised values live in `observations`.
- Answer evidence: `turn_sources` (official flag, evidence level, source number), `source_extractions`, `claim_evidence`, `change_reports`.
- Budgets and metrics: `api_usage` (credit ledger) and `turn_metrics` (tokens, credits, latency).

## Privacy

- **SQLite is the only store.** It is local, under `./data`, and git-ignored.
- **Groq** receives the question, a bounded slice of relevant memory, and search results.
- **Tavily** receives search queries and selected URLs only, never your memories or conversations.
- **Deleting a conversation** deletes every memory, research snapshot and observation derived from it.
- **The "Your data" menu** exports everything as JSON or forgets everything.
- **Logs** contain sizes and latencies, with secrets redacted.

## Troubleshooting

- **"The API key was rejected"**: check `.env.local`. It takes priority over machine-wide variables with the same name.
- **"Rate limit reached" or slow answers**: Groq's free tier allows about 8K tokens per minute. The app paces requests to stay under it, so a burst of research questions waits instead of failing.
- **"Web search unavailable"**: the Tavily key is missing, or the monthly credits (or the reserve) are used up. The answer is then marked unverified.
- **`better-sqlite3` fails to install**: use Node 20 LTS with the standard Windows build tools, or a Node version with prebuilt binaries.

## Limitations

- Statement extraction is rule-based. It is precise on the patterns it knows, but misses unusual phrasings (see `EVALUATION.md`).
- Then/now values are parsed from the answer's tables. If the model writes prose instead, the computed report says it cannot verify.
- Tavily `published_date` is an estimate and is often missing for non-news pages.
- Single user and single process: the workspace id lives in the browser's localStorage, and turns are serialised in process.
