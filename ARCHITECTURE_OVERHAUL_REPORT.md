# Minimi — Complete Architecture Overhaul Report

## Executive Summary
Minimi has undergone a comprehensive, production-grade architectural evolution. Guided by the principle **Local-First, Cloud-Assisted**, all personal data remains on the user's host machine with SQLite as the canonical source of truth. Every existing capability has been preserved with zero regressions:
- **Baseline preservation:** All 231 pre-existing tests continue to pass without modification or weakening.
- **New tests added:** 22 new comprehensive tests covering caching, archival, storage accounting, circuit breakers, atomic reservations, durable jobs, hot backups, and agent budgeting (bringing the total to 253 tests across 18 test files).
- **Deterministic Evaluation:** Remains **20/20** (`npm run eval`).
- **Production Build:** Passes cleanly (`npm run build`, `npm run check`).
- **The One-Tool Constraint:** Preserved strictly: the only model-visible tool is `web_search`.

---

## 1. Architecture Before and After

### Before
- **Storage:** Unbounded SQLite growth in `minimi.db`. No lifecycle management, transcripts and search extracts accumulated indefinitely.
- **Caching:** Only ad-hoc caching for demo prompts (`demo_answer_cache`). No in-memory LRU, no search/extract caching, and no single-flight protection against concurrent cache stampedes.
- **Orchestration:** Model calls directly managed tool loops with in-memory token rate gates; no formal per-turn execution budgets or rolling thread summaries.
- **Reliability:** Informal circuit breaker state; simple in-memory conversation locks; no atomic quota reservations across concurrent requests.
- **Maintenance:** Housekeeping piggybacked on database initialization without durability or crash recovery.
- **Disaster Recovery:** No hot backup API integration, checksums, or restoration test harnesses.

### After
- **Modular Monolith:** Clean TypeScript interfaces across request coordinator, orchestration runtime, memory engine, research engine, reliability layer, durable jobs, and storage/caching subsystems.
- **Storage Lifecycle:** Clear distinction between Canonical (permanent), Operational (recent), Archivable (older transcripts), and Ephemeral (caches, demo data) information.
- **Compressed Archival:** Crash-safe archival into checksummed gzip segments (`.json.gz`) with SQLite cataloging and transparent `archive_fts` search indexing, yielding **94.2% space reduction**.
- **Multi-Tier Caching:** In-memory `BoundedLRUCache` (entry count, max bytes, TTL) + persistent SQLite `local_cache` + in-process `SingleFlightGroup` request coalescing with workspace-scoped invalidation and freshness governance.
- **Reliability Layer:** Formal `CircuitBreaker` (CLOSED/OPEN/HALF-OPEN) for Groq & Tavily, plus database-backed atomic `QuotaReservationManager` preventing quota starvation.
- **Durable Local Jobs:** SQLite-backed queue (`durable_jobs`) with atomic leases (`lease_until`), exponential backoff retries, and dead-letter protection.
- **Disaster Recovery:** SQLite Online Hot Backup (`db.backup(...)`) with SHA-256 manifest verification and verified restoration.

---

## 2. Storage & Archival Benchmark Results
Synthetic benchmark executed via `scripts/benchmark-storage.ts` under realistic load:
- **Dataset:** 50 conversations, 2,000 messages (totaling ~1.96 MB active DB).
- **Archival Workload:** 30 conversations (~1,200 messages) archived to gzip segments.
- **Raw message payload:** 959 KB
- **Compressed archive payload:** 56 KB
- **Compression ratio:** **94.2% disk space reduction**
- **Date Recall Latency (Active DB):** 0.483 ms
- **Historical FTS Search Latency (Archive FTS):** 0.586 ms
- **Cache Hit Latency:** 0.109 ms
- **Database Integrity:** Verified clean (`PRAGMA integrity_check` = `ok`).

---

## 3. Caching Architecture & Freshness Policy
- **In-Memory LRU:** Configurable `maxEntries` (500) and `maxBytes` (5MB) with LRU eviction and TTL expiry.
- **Single-Flight Coalescing:** Identical concurrent search or extraction queries share an active Promise; only 1 external provider request is dispatched.
- **Freshness Governance:** General recall uses cached evidence; explicit current-information or temporal-comparison queries (*"Has pricing changed since Tuesday?"*) bypass or revalidate web search, comparing freshly observed data against the immutable baseline.
- **Workspace Isolation:** Cache keys are prefixed with workspace IDs and revision counters; clearing a workspace purges its cached records without leaking cross-tenant data.

---

## 4. Reliability, Quotas & Graceful Degradation
- **Atomic SQLite Quota Reservations:** Ensures concurrent requests cannot exceed shared Groq token or Tavily credit budgets. Reservations are committed upon actual usage or released on error/cancellation.
- **Circuit Breakers:** Groq and Tavily each have independent breakers that trip on repeated 429s or 5xxs, fast-failing during outages while leaving local memory, open loops, and decision tracking 100% operational.
- **Execution Budgets:** Turns are strictly bounded by `ExecutionBudgetTracker`: max 3 model rounds, max 5 search queries, max 3 extractions, and a 6000-token prompt safety ceiling.

---

## 5. Operations & Disaster Recovery
- **Storage Observability:** Real-time metrics via `GET /api/status` exposing DB bytes, WAL bytes, SHM bytes, archive bytes, cache statistics, and low-disk warnings (<50MB).
- **Durable Job Worker:** Handles background pruning, cache expiration, archive compaction, and WAL checkpoints with lease recovery.
- **Verified Backups:** Online hot backup snapshots with SHA-256 manifests tested and verified for isolated restoration.

---

## 6. Test Suite and Verification Baseline

| Gate | Status | Details |
| :--- | :---: | :--- |
| **Typecheck (`tsc --noEmit`)** | **PASS** | 0 TypeScript errors |
| **Lint (`eslint .`)** | **PASS** | 0 ESLint errors |
| **Unit & Integration Tests** | **PASS** | **253 / 253 passed** (18 test files) |
| **Deterministic Evaluation** | **PASS** | **20 / 20 passed** (`npm run eval`) |
| **Production Build (`next build`)** | **PASS** | Optimized Turbopack build succeeds |
| **The One-Tool Rule** | **PASS** | Verified only `web_search` is exposed |
| **Git Working Tree** | **PASS** | Clean, all milestones pushed to `main` |
