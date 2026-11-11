# Engineering audit — baseline `a06bd61` (10 Nov 2026)

Scope: the whole repository at commit `a06bd61` (~3.7K lines of TS in `src/`, 79 tests), plus live checks against the configured Groq and Tavily accounts. Findings marked **verified** were reproduced (test, live call, or code reading with a concrete failing input). Findings marked **risk** are plausible but not yet observed.

## 1. Existing architecture
- **Flow:** `POST /api/chat` (SSE) → `runTurn` (`lib/agent/run.ts`): persist user message → deterministic analysis and retrieval (`lib/memory/query.ts`, `retrieval.ts`) → prompt (`lib/agent/prompt.ts`) → Groq tool loop (`lib/agent/groq.ts`) → `web_search` tool (`lib/agent/webSearchTool.ts`) → Tavily (`lib/search/tavily.ts`) → persist answer and sources → heuristic memory distillation (`lib/memory/extract.ts`).
- **Storage:** SQLite (WAL) with `messages` (immutable, UTC + IANA tz + local date), `conversations`, `memory_items` (research shortlists and snapshots, facts as JSON), `turn_sources`, `turn_metrics`, and FTS5 over messages and memory items.
- **UI:** a single client component (`components/ChatApp.tsx`), a message renderer, and a read-only memory panel.

## 2. What works well (keep)
- **Immutable message log with a captured timezone.** Date recall is computed in code ("last Tuesday", "3 Nov" across UTC/IST midnight) and is tested.
- **Deterministic intent routing** decides `tool_choice` none/auto/required. Recall never spends search credits (verified live: 2.2 s, no tool).
- **Referent scoring with an ambiguity → clarify path.** Cross-conversation "them" resolution was verified live.
- **One-tool invariant** (`assertSingleSearchTool`), checked on every request body in tests.
- **Bounded tool loop** (3 rounds, query budget), with recovery from Groq tool-validation errors at start and mid-stream (verified live, then regression-tested).
- **Citation safety:** gpt-oss `【n†…】` markers and bare URLs are converted only to URLs the search returned; unknown URLs are dropped, never remapped (tested).
- **Idempotent retries, per-conversation FIFO lock, cancellation that persists partial answers.**

## 3. Verified defects and gaps
| # | Defect | Evidence | Impact |
|---|---|---|---|
| D1 | Memory stores research only. No commitments, decisions, preferences or personal facts. | `extract.ts` only parses tables and lists | Core Minimi behaviours (open loops, decision history) are impossible |
| D2 | Evidence is snippets only. No full-page reading. | Live CRM test cited blog snippets for vendor prices | Pricing comparisons rest on weak, sometimes third-party evidence |
| D3 | No official-source identification in code. Labelling is left to the prompt. | `sources.ts` has no notion of official | Third-party blog labelled as a vendor page (live, 10 Nov) |
| D4 | Change detection is model prose only. Baseline "facts" are table cells with no currency, period or tier semantics. | `FactSchema` is entity/attribute/value strings | Different billing bases get compared; nothing auditable in code |
| D5 | One date per research item (`baseline_date`). Publication, effective and retrieval dates are not separated in memory. | schema v1/v2 | "Announced Nov 5, effective Dec 1" cannot be represented |
| D6 | Entities are a JSON array per item. No entity table, no aliases, no people. | `memory_items.entities` | No "what did I promise Rahul?"; alias matching is ad hoc |
| D7 | The date parser is past-only. "By Friday" for a deadline would resolve to last Friday. | `parseDateRefs` resolves past occurrences | Wrong due dates would be invented |
| D8 | Tavily budget is not persisted. The circuit breaker is in-memory, and real usage is unknown to the app. | `tavily.ts` | Restarts forget quota state; no reservation for important turns |
| D9 | No pacing for Groq tokens per minute. We rely on SDK retries; token usage is not recorded. | 57 s turn that ended in 429 (live, 10 Nov) | Slow failures; no measurements |
| D10 | Claims are not linked to evidence. Sources are a flat list per message. | `turn_sources` | Cannot show which source supports which statement; no coverage metric |
| D11 | No export. Deletion cascades memory implicitly and the policy is undocumented. No log redaction helper. | API routes | Privacy requirements unmet |
| D12 | `listMessages` is unbounded. | `repo.ts` | Long conversations load everything |
| D13 | There is no default timezone setting. Invalid or missing client timezones are rejected rather than falling back. | `chat-handler.ts` | Directive requires Asia/Kolkata default, configurable |

## 4. Risks
- **R1:** Groq free limits (8K TPM, 1K RPD, verified via headers) make multi-round research fragile under bursts.
- **R2:** Regex intent analysis can misroute new phrasings (we already fixed "what did I ask today?"). It needs a broad fixture set.
- **R3:** Heuristic extraction may over-capture ("I'll think about it" as a promise). It needs adversarial tests.
- **R4:** Tavily `published_date` is an estimate and is often missing on non-news pages.

## 5. Architectural weaknesses
- "Memory" conflates research snapshots and conversational facts in one weakly typed table.
- Research knowledge is not a ledger: there are no observations with dates and provenance, so "then vs now" cannot be computed.
- The UI is one large component, with no Memory/Open-loops views and no source inspection beyond a list.

## 6. Recommended changes
1. **Personal memory engine** (new tables `memories`, `memory_links`, `memory_events`, `entities`, `entity_mentions`):
   - typed records (FACT, PREFERENCE, DECISION, COMMITMENT, ACTION_ITEM, FOLLOW_UP, PROJECT, RELATIONSHIP)
   - verbatim quote, source message, explicit/inferred, confidence, status, due date, extraction version
   - links (SUPERSEDES, CONTRADICTS, SUPPORTS, RELATED_TO, COMPLETED_BY, FOLLOWS_FROM) and an event log for corrections
2. **Rule-based extractor with explicit intent classes** (promise / intention / suggestion / hypothetical / delegated / waiting / completion / cancellation / decision / preference / fact):
   - high precision and deterministic, so testable, and it spends no tokens on the 8K TPM tier
   - an optional LLM pass may only *add* low-confidence candidates
3. **Future-aware due-date resolver** ("by Friday", "tomorrow", "next week", "on 20 Nov").
4. **Open-loop and decision intents** answered from SQL (no search).
5. **Research ledger** (`observations`, `source_extractions`, `claim_evidence`, `api_usage`):
   - normalised price observations (amount, currency, period, unit, tier, effective date, evidence level)
   - comparison computed in code: CHANGED / NO MATERIAL CHANGE FOUND / UNABLE TO VERIFY, rendered as a card next to the model's prose
6. **Two-stage search inside the single tool:**
   - Tavily search → rank sources (official-domain match, page type, freshness, relevance) → selective Tavily Extract of at most 2 official pages per call (1 credit per 5 URLs)
   - keep only the relevant passages; label sources official/third-party and full-page/snippet
7. **Budgets:** a persisted Tavily credit ledger synced from the free `/usage` endpoint, with a reserve for change checks; a Groq TPM gate using live `x-ratelimit-*` headers; token usage recorded per turn.
8. **Privacy:** export endpoint, documented deletion policy (derived memories go with their source conversation; "forget everything"), log redaction, default timezone.
9. **Evaluation:** deterministic fixture suite with measured metrics (precision/recall etc.) written to `EVALUATION.md`, plus a live script for the three hiring examples.
10. **UI redesign** after the above: Chat / Memory / Open loops views, a research comparison card, source inspection.

## 7. Justification for replacements
- `memory_items` stays as the *research snapshot* store (it works, and the tests depend on it). Personal memory gets its own normalised tables rather than overloading it.
- Facts move from JSON to the `observations` rows needed for computed comparisons.
- Embeddings/vector DB rejected for now: every failing case above is structural (types, dates, links), not lexical.
- No multi-agent system: one model, one tool, deterministic pre- and post-processing are easier to test and cheaper on the free tier.

## 8. Prioritised plan
1. Memory engine (D1, D6, D7, D13)
2. Open loops and decisions
3. Research ledger, extract and ranking (D2–D5, D10)
4. Budgets, pacing, observability (D8, D9)
5. Privacy (D11, D12)
6. Evaluation suite and live evals
7. UI redesign and browser QA
8. Docs

## 9. Resolution status (after the improvement phases)
| # | Status | Where |
|---|---|---|
| D1 personal memory | Fixed: typed memories with quotes, links, events; open loops and decision timelines | `lib/personal/*`, migration v3 |
| D2 snippet-only evidence | Fixed: selective Tavily Extract of official pricing/changelog pages, labelled full page vs snippet | `agent/webSearchTool.ts`, `research/rank.ts` |
| D3 official sources | Fixed: vendor-domain and page-type provenance; third-party never labelled official (precision 1.0 on fixtures) | `research/official.ts` |
| D4 prose-only comparison | Fixed: normalised observations and an app-computed then/now report (CHANGED / NO MATERIAL CHANGE FOUND / UNABLE TO VERIFY) | `research/observations.ts` |
| D5 single date | Fixed: observed, published and effective dates stored separately | migration v4 `observations` |
| D6 no entity model | Fixed: `entities` and `entity_mentions` with aliases; person-scoped open loops | `personal/store.ts` |
| D7 past-only date parser | Fixed: future-aware deadline resolver; no deadline without a cue | `time/due.ts` |
| D8 unpersisted budget | Fixed: credit ledger synced from Tavily `/usage`, reserve for change checks | `search/budget.ts` |
| D9 no TPM pacing | Fixed: token gate plus real usage logging; separate daily and per-minute limit messages | `agent/rateGate.ts` |
| D10 no claim evidence | Fixed: `[n]` source IDs resolved to exact URLs, unknown links stripped, claim→source rows, coverage metric | `agent/sources.ts`, `research/claims.ts` |
| D11 privacy | Fixed: export, forget-everything, documented cascade deletion, log redaction | `server/export.ts`, `server/log.ts` |
| D12 unbounded lists | Partly fixed: personal-memory APIs paginated; a conversation still loads all its messages | `api/personal` |
| D13 default timezone | Fixed: `DEFAULT_TIMEZONE` (Asia/Kolkata) fallback | `server/chat-handler.ts` |

New defects found during evaluation and fixed (each with a regression test):
- duplicate snapshots of the same shortlist treated as ambiguous
- "what did I ask today?" routed as a freshness check
- deadline words used as event dates
- person filter taken from statements rather than the question
- gpt-oss `【n】` markers dropped
- citations written as "(search snippet)" labels instead of links
- stray tool calls on the final round
- daily-limit 429 misreported as a per-minute limit

## 10. Identity and demo phase (local-first, cloud-assisted)

Added optional authentication and a disposable demo **without** changing the
storage model: SQLite remains the source of truth, and the cloud stays
inference-only (Groq) and research-only (Tavily). See `DESIGN.md`
for the full review; outcome **CASE A** (architecture correct).

- **Migration v5** (`identity_and_demo`, forward-only): `users`, `oauth_accounts`
  (unique `provider, provider_user_id`), `sessions` (hashed token), and
  `workspaces` gains `owner_user_id`, `kind` (`local|user|demo`) and `expires_at`.
  Demo tables: `demo_budgets`, `demo_answer_cache`, `demo_ip_events`. Indexes on
  the new lookup columns.
- **Two modes.** LOCAL (default) is behaviourally unchanged. AUTH activates on
  `AUTH_SECRET` + one provider; a single `resolveWorkspace()` decides the
  workspace for every route — from the session in AUTH (client header ignored,
  401 without a session), from the header in LOCAL.
- **Sign-in.** GitHub (required for the button) + Google (optional), authorization
  code + PKCE(S256) + signed `state`; hand-rolled on `fetch` instead of `arctic`
  (two providers, one flow — a smaller audit surface, and every step is mockable).
  Access tokens are used once for the profile and never persisted.
- **Sessions.** Stored locally; only the SHA-256 hash is kept; httpOnly /
  SameSite=Lax / Secure-in-prod cookie with rotation and sign-out revocation.
  Same-origin (CSRF) check on state-changing requests in AUTH mode.
- **Demo.** Isolation by `kind='demo'` only; deterministic seeding through the
  app's own storage functions (refuses non-demo workspaces); per-session turn and
  credit budgets; per-IP rate limit; cached guided answers; 24 h TTL with startup
  + periodic cleanup. Budget exhaustion leaves memory/recall working.
- **Security/privacy tests added** (`tests/auth.test.ts` 30, `tests/demo.test.ts`
  17): cross-user IDOR across chat/conversations/memory/personal/workspace, CSRF,
  session fixation/rotation/hashing, open-redirect, cookie flags, claim/delete
  cascade, demo determinism/budgets/expiry, rate-limit windows.
- **Defect found and fixed:** model-drafted Tavily queries left the machine
  verbatim. Added `search/sanitize.ts` (strips emails at the egress boundary) and
  applied it in `search()` and `extract()`; a pure-identity query now makes no
  network call (`tests/groq-tavily.test.ts`).
- **Documented limits:** SQLite is not encrypted at rest; LOCAL mode is a
  single-user trust model; a remote deployment keeps SQLite on the host, not on
  the user's device.



## 10. Final review (11 Nov 2026)
- **Unwired infrastructure removed.** A cache layer, a durable job queue, archival, backups, circuit breakers, quota reservations, rolling summaries and per-turn budgets (about 2,000 lines) were not reachable from any API route or the agent pipeline, and the docs claimed behaviour they did not have. Two of them would have been harmful if switched on: archival deleted raw messages (breaking exact recall), and the cache would have served stale results to "is it still correct today?". All were removed with their tests and docs.
- **Identity and demo fixes:**
  - The demo rate limit no longer trusts client-supplied forwarding headers, and a global cap was added.
  - The bare workspace header can no longer open demo or account workspaces.
  - Demo answers are cached only from pristine seed data, so nothing is shared between visitors.
  - "Reset demo" can no longer sign out a real user.
  - Starting a demo revokes the session it replaces.
  - Guest cleanup never deletes an OAuth user.
  - Demo seeding is atomic.
  - `/api/status` reports configuration only.
  - Claiming a workspace requires the browser that holds it.
  - Regression tests: `tests/security-fixes.test.ts`.
- **UI:**
  - The document could scroll behind the app shell, because hidden labels were absolutely positioned without a positioned ancestor. Fixed.
  - Citation coverage is now shown only for web-backed answers.
