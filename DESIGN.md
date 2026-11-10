# Minimi — Design

**One model, one tool, and a deterministic application around them.** Groq `openai/gpt-oss-120b` gets exactly one function, `web_search`. Everything else is ordinary, testable application code: memory, dates, open loops, decisions, evidence and budgets. The model only ever sees a bounded, labelled slice of that context.

## How a turn works (`lib/agent/run.ts`)
1. **Persist and extract.** The user message is saved immutably with UTC time, IANA timezone (default `Asia/Kolkata`) and local date. A rule-based classifier (`lib/personal/classify.ts`) then records commitments, intentions, waiting-on items, decisions, preferences and facts. Each record keeps its verbatim quote, source message, confidence and explicit/inferred flag. Completion or cancellation evidence ("I sent Rahul the report yesterday") closes a matching item only when the verb, object or person match unambiguously; otherwise it is logged, not applied. Assistant text is never mined, so a model suggestion cannot become the user's promise.
2. **Retrieve with SQL and FTS5, no LLM.**
   - Dates are resolved in code: "3 November", "last Tuesday" and the future-aware "by Friday".
   - Exact-date lookup on the captured local date, the active thread, a carry-over of turns just recalled, and FTS over messages, memories and research snapshots.
   - Open-loop and decision queries are structured SQL over statuses, due dates and supersession links.
   - Pronouns ("them") resolve by scoring candidates on conversation, date, distinctive terms and recency. Two genuinely different topics produce a clarifying question instead of a guess.
3. **Route.** The app picks the tool policy. `none` covers chat, recall, open loops, decisions and clarification; `required` covers "has it changed since?" against a found baseline; `auto` covers everything else. Recall never spends search credits.
4. **Answer.** At most 3 model rounds. The single tool runs inside the app: Tavily search (≤5 queries per call) → rank sources (official vendor domain, page type such as pricing or changelog, freshness) → selective Tavily Extract of at most 2 official pricing or changelog pages per call (≤3 per turn), using query-focused passages only. Results are numbered and labelled *OFFICIAL* or *third-party* and *full page* or *snippet*.
5. **Validate evidence.** The model cites `[n]`, and the app maps each number to that result's exact URL. Links to anything not returned by search, and not a previously validated source, are stripped. Claims are linked to the sources beside them, and coverage of factual claims is recorded.
6. **Temporal ledger.** Answer tables become dated observations: amount, currency, period, monthly or annual billing, seat or user, tier, effective date, source, and evidence level. On a re-check the app compares the baseline snapshot with today's observations *in code* and labels each item CHANGED, NO MATERIAL CHANGE FOUND or UNABLE TO VERIFY.
   - Different plans, billing bases or currencies are never compared.
   - Missing or unsourced evidence is never "no change".
   - A future effective date is reported as scheduled.
   - A re-check writes a new snapshot; old baselines are never overwritten.

## Why this architecture
- **One exposed tool** keeps the model's action space tiny and auditable, and satisfies the challenge. Memory as a tool would add round-trips, spend tokens on the 8K-TPM free tier, and let the model decide *whether* to remember. Retrieval in code is deterministic and unit-tested.
- **SQL/FTS5 over a vector DB.** The hard questions are structural: "what did I ask *on 3 November*", "what is *overdue*", "what *superseded* MongoDB", "which *five* products". Dates, statuses and links are exact in SQL. Embeddings would help paraphrase recall but add a model, a dependency and nondeterminism, and no fixture failed for lack of them.
- **Rules before LLM extraction.** Commitment extraction must be high-precision (never invent a promise or a deadline). Rules are explicit, cost no tokens, and are measured: 100% precision on 30 labelled statements (`EVALUATION.md`).
- **Selective extraction.** Full pages cost credits and tokens. Reading only the top official pricing or changelog page per query gives authoritative evidence where it matters, and snippets elsewhere are labelled as such.
- **Provenance against hallucination.** Every memory points to a quote, every citation to a returned URL, every comparison to dated observations, so the model cannot invent history, sources or changes without the app detecting it.

## Reliability and limits
- **Groq.** A token gate paces requests within the 8K tokens/min limit (verified via `x-ratelimit-*` headers), and real usage from `x_groq.usage` is recorded per turn.
  - Tool-validation failures are recovered (`required`→`auto`→`none`), at request time or mid-stream, as are stray tool calls on the final round.
  - Timeouts, cancellation (partial answer saved), idempotent retries via `requestId`, and a per-conversation FIFO lock.
- **Tavily.** A persisted credit ledger synced from the free `/usage` endpoint, with a reserve kept for change checks. Quota errors (432/433) trip a circuit breaker; the answer is then labelled *web search unavailable* and its values stored as *unverified*. No paid options are used.
- **Privacy.**
  - Groq receives the question, a bounded memory slice and search results; Tavily receives only search queries and selected URLs. Nothing runs on-device beyond SQLite.
  - Deleting a conversation deletes everything derived from it. Users can export all data or forget everything.
  - Logs carry sizes and latencies only, with secrets redacted.

## Rejected
Multi-agent orchestration, because it adds cost and opacity without a measured gain. A second search provider, because it would break the one-tool contract. Provider-hosted search: Gemini grounding is refused on the free tier and Groq `browser_search` is undocumented on it, and both hide provenance. LLM intent routing, because it is slower and less predictable than rules plus scoring on these fixtures.

## Another week
- Recall paraphrases ("that database thing") with optional local embeddings.
- Extract structured then/now values with the model under schema validation, so tables do not depend on answer formatting.
- Detect conflicts between sources.
- Use the model as a reviewer of low-confidence memories, under user confirmation.
- Use multi-user auth and a DB-level lock for multi-instance deployment.
