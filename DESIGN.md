# Minimi — Design

## How it works
Each user message runs one **turn** (`src/lib/agent/run.ts`). Turns in the same conversation run one at a time.

1. **Persist** the raw user message with its UTC timestamp, the browser's IANA timezone, and the derived *local* date. Messages are immutable. Retries are idempotent via a client `requestId`.
2. **Analyse and retrieve, in code (no LLM).**
   - `memory/query.ts` resolves dates ("3 November", "last Tuesday", "yesterday") in the *user's* timezone and detects recall ("what did I ask…"), freshness ("still correct", "changed since") and pronoun follow-ups.
   - `memory/retrieval.ts` combines: exact `local_date` lookup → recent thread → turns recalled by the previous reply (carry-over) → FTS5 over memory items and old messages → recent high-value items (shortlists, comparisons).
   - Candidates are scored on same conversation, date match, distinctive-term hits, type and recency. A pronoun with two equally plausible referents yields a *clarify* intent instead of a guess.
3. **Route.** The application chooses the tool policy: `none` for greetings, pure recall and clarification (fast, no search); `required` for "has it changed since?" against a found baseline; `auto` otherwise.
4. **Prompt.** System rules, the authoritative runtime date and timezone, and a per-intent directive. Retrieved memory goes in a separate, bounded `<memory_context>` message labelled untrusted; delimiters inside the data are neutralised. It includes the verbatim original questions, old answers, old source URLs and baseline facts, so the model compares *then vs now*. Each item is labelled *changed*, *no change found in checked sources* or *cannot verify*.
5. **Model and one tool.**
   - Groq `openai/gpt-oss-120b` is offered exactly one function, `web_search` (`agent/webSearchTool.ts`). `assertSingleSearchTool` enforces this, and tests check every request body.
   - The tool's implementation is the search layer (`search/tavily.ts`). gpt-oss on Groq has no parallel tool calls, so one call takes up to 5 queries; a five-product check is one round, not five.
   - `agent/groq.ts` runs a bounded loop: at most 3 model rounds and `MAX_SEARCHES_PER_TURN` queries. URLs are deduplicated across the turn, and the last round has no tools so an answer is guaranteed.
6. **Stream and persist.** SSE to the browser carries phase, search queries and text deltas. Pre-tool chatter is discarded with a `reset` event. The final answer, sources with provenance (*cited*, *searched*, or *linked but not returned by search*, which is flagged), snippet, published date, query, retrieval timestamp and latency metrics are stored.
7. **Distil memory** before releasing the lock. Tables and lists become `shortlist`/`comparison` items with entities and baseline facts (`entity · attribute · value`), always linked to source message ids and the baseline date. A re-check creates a new dated snapshot; the old baseline is never overwritten. Values produced without a web check are stored as *unverified*.

## Why this architecture
- **Memory is application code, not a tool.** The challenge allows one model tool, and code-side retrieval is testable and cheap. Dates in particular are resolved in code, because models are unreliable at "last Tuesday" in a given timezone.
- **Groq + Tavily on free tiers.** Google's free Gemini tier refuses Search grounding (verified live: 429 on every model). Groq's hosted `browser_search` has unclear free-tier status. An app-executed `web_search` function backed by Tavily gives a documented free quota, structured results (URL, snippet, published date) and full control over budgets and quota handling.
- **Owning the tool makes citations auditable.** Every source the model may cite came from our own search call. A link in the answer that search never returned is stored as `answer_link` and shown as unverified.
- **Budgets for the free tier.** Groq allows about 8K tokens per minute, so memory context, history and snippets are capped, and memory distillation is heuristic by default.
- **Quota exhaustion degrades instead of failing.** Tavily 432/433 trips a circuit breaker (no retries against an exhausted plan). The model is told search is unavailable, and the answer opens with a warning and carries a *web search unavailable* badge.
- **SQLite + FTS5** (`better-sqlite3`, WAL): durable, zero-ops, works on Windows, transactional. External-content FTS tables with triggers keep indexes consistent. Migrations are forward-only.

## Alternatives rejected
- *Memory lookup as a model tool:* violates the one-tool rule and adds a round-trip.
- *Provider-hosted search (Gemini grounding, Groq `browser_search`, OpenAI `web_search`):* not available or not documented on free tiers, and it hides result metadata we need for provenance.
- *Vector DB / embeddings:* FTS, entity scoring and date indexes pass all scenarios; embeddings would need another model and are hard to justify without a failing case.
- *LLM-based intent classification:* slower, spends scarce free-tier tokens, and is less predictable than rules plus scoring for these patterns.
- *Provider-stored conversations:* not inspectable and not durable under our control.

## Tradeoffs and limitations
- Turn serialisation is in-process (one Node server). Running several instances would need a lock at the database level.
- Snippets, not full pages, are the evidence. Pricing pages with dynamic content can yield thin snippets, in which case the model should mark items *cannot verify*.
- Tavily's `published_date` is an estimate and is often missing for non-news pages.
- Heuristic distillation captures tables and bold lists well, prose less well.

## With another week
- A scored live evaluation harness for the PRD scenarios and per-claim citation checking.
- Structured then/now extraction, so the comparison table is computed in code rather than written as prose.
- Fetching full official pages for top results (a second internal step behind the same single tool) to get stronger pricing evidence.
- Optional local embeddings for paraphrased recall ("that database thing").
