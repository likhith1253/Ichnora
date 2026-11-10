# Minimi — Design

## How it works
Each user message runs one **turn** (`src/lib/agent/run.ts`), serialised per conversation:

1. **Persist** the raw user message (UTC timestamp + the browser's IANA timezone + derived *local* date). Messages are immutable; retries are idempotent via a client `requestId`.
2. **Analyse & retrieve (deterministic, no LLM)** — `memory/query.ts` parses dates ("3 November", "last Tuesday", "yesterday") in the *user's* timezone and detects recall ("what did I ask…"), freshness ("still correct", "changed since") and pronoun follow-ups. `memory/retrieval.ts` then combines: exact `local_date` lookup → recent thread → turns recalled by the previous reply (carry-over) → FTS5 over memory items and old messages → recent high-value items (shortlists, comparisons). Candidates are scored (same conversation, date match, distinctive-term hits, type, recency); a pronoun with two equally plausible referents yields a *clarify* intent instead of a guess.
3. **Route** — the application chooses `tool_choice`: `none` for greetings/pure recall/clarification (fast, no search), `required` for "has it changed since?" against a found baseline, `auto` otherwise.
4. **Prompt** — system rules + authoritative runtime date/timezone + a per-intent directive; retrieved memory goes in a separate, bounded `<memory_context>` block labelled untrusted (delimiters inside data are neutralised). Verbatim original questions, old answers, old source URLs and baseline facts are included so the model compares *then vs now* and labels each item *changed / no change found in checked sources / cannot verify*.
5. **Model + one tool** — Gemini `gemini-3.5-flash-lite` with Google Search grounding (`{ googleSearch: {} }`) by default; OpenAI Responses + `web_search` by env. If the provider refuses search (Google free tier → 429), the turn is retried without the tool, the model is told it has no web access, and the answer is labelled *web search unavailable* — never presented as verified. `assertSingleSearchTool` enforces that the model only ever receives one search tool; tests check every request body.
6. **Stream & persist** — SSE to the browser (phase, search queries, text deltas). The final answer, deduplicated sources (with provenance: *search*, *cited*, or *answer link not returned by search* → flagged), and latency metrics are stored.
7. **Distil memory** before releasing the lock: tables/lists become `shortlist`/`comparison` items with entities and baseline facts (`entity · attribute · value`), always linked to source message ids and the baseline date. A re-check creates a new dated snapshot; the old baseline is never overwritten.

## Why this architecture
- **Memory is application code, not a tool.** The challenge allows one model tool; it also makes retrieval testable and cheap. Dates in particular are resolved in code — models are unreliable at "last Tuesday" in a given timezone.
- **SQLite + FTS5** (`better-sqlite3`, WAL): durable, zero-ops, works on Windows, transactional. External-content FTS tables with triggers keep indexes consistent. Migrations are forward-only.
- **Free tier first.** Google's free tier does not include Search grounding for the Gemini 3.x models available to new keys (verified live: plain calls succeed, Search calls return 429), so the app degrades explicitly instead of failing. Free-tier rate limits shaped the design: deterministic routing avoids search when unnecessary, memory context and history are capped, and memory distillation is heuristic by default (`MEMORY_DISTILL=model` adds a small JSON-only LLM pass).
- **Citations are attached by code, not written by the model.** Gemini never sees URLs; the app inserts links after the exact sentence each `groundingSupport` covers, using only chunks the search returned — so a citation cannot be fabricated.
- **A provider boundary** (`agent/provider.ts`, `agent/gemini.ts`) isolates vendor shapes (Gemini `groundingMetadata`, OpenAI `web_search_call` sources) so the agent and tests use one event stream.

## Alternatives rejected
- *Memory lookup as a model tool* — violates the one-tool rule and adds a round-trip.
- *Vector DB / embeddings* — FTS + entity scoring + date indexes pass all scenarios; embeddings would need a second API or local model and are hard to justify without a failing case.
- *Provider-stored conversations* — not inspectable, not durable under our control.
- *Second search provider (Tavily, OpenRouter `:online`)* — breaks the one-tool contract; OpenRouter search is also not free.
- *LLM-based intent classification* — slower, costs tokens on a tight free tier, less predictable than regex + scoring for these patterns.

## Tradeoffs and limitations
- Turn serialisation is in-process (single Node server); multi-instance deployment would need a DB-level lock.
- Heuristic distillation captures tables and bold lists well, prose less well.
- Gemini search cannot be forced (`tool_choice` has no equivalent); change checks rely on an explicit instruction plus a visible "web checked" badge so a missed search is noticeable. `npm run probe` verifies grounding against a live key.
- Grounding links are Google redirect URLs, so old source URLs in memory are less useful as baselines than publisher URLs would be.
- Change classification is done by the model from supplied evidence; the app guarantees the baseline and dates, not the model's reading of a pricing page.

## With another week
- Live evaluation harness (scored runs of the PRD scenarios against the real model) and per-claim citation checking.
- Structured "then/now" extraction so the comparison table is computed in code, not prose.
- Optional local embeddings for paraphrased recall ("that database thing").
- Conflict detection between snapshots and a memory timeline view.
