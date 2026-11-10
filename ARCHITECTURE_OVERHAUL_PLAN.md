# Minimi — Complete Architecture Overhaul Plan

## Executive Summary
Minimi is a **local-first, cloud-assisted** personal AI assistant designed to maintain personal memory, research history, commitments, and temporal knowledge over years. This overhaul addresses critical architectural gaps without introducing unnecessary distributed systems (no Redis, Kafka, vector databases, or microservices), preserving the single exposed model tool (`web_search`), maintaining all 231 existing tests, and satisfying the 20/20 evaluation baseline.

---

## 1. Existing Architecture & Identified Problems

### Current State
1. **Database & Storage:**
   - Single SQLite file (`minimi.db`) storing all raw messages, FTS5 indexes, memory items, personal memories, entities, research snapshots, observations, extractions, metrics, and demo data.
   - Forward-only migrations up to v5 (`identity_and_demo`).
   - No data lifecycle management or archival: over months/years, messages and full text extracts accumulate indefinitely, inflating disk usage and degrading FTS/index performance.
   - No crash-resilient backup/restore mechanism (only basic file operations).
   - Unmanaged disk space warnings or recovery mechanisms.

2. **Caching:**
   - Caching is currently ad-hoc and restricted to demo answers (`demo_answer_cache`).
   - No bounded in-memory LRU cache for high-frequency queries.
   - No persistent local cache for search results or page extractions.
   - Missing request coalescing (single-flight), allowing cache stampedes on concurrent identical requests.
   - Risk of stale cache usage on current/temporal verification queries (e.g. pricing re-checks).

3. **Agent Orchestration & Runtime:**
   - Logic in `runTurn` directly ties model streaming, extraction, citation handling, and observation comparison.
   - Needs explicit execution budgets (max tool rounds, max tokens, max provider requests, max search credit consumption per turn).
   - Lacks rolling conversation summaries for long threads.

4. **Reliability & Rate Limiting:**
   - Concurrency is managed via in-memory conversation locks (`acquireConversationLock`) and a simple token gate (`TokenGate`).
   - Lacks multi-tier quota management: provider-wide, workspace-level, and per-request budgets.
   - No atomic SQLite-backed budget reservations for concurrent requests.
   - Circuit breakers for Groq and Tavily are in-memory or basic; needs unified CLOSED/OPEN/HALF-OPEN state machines with proper exponential backoff and jitter.

5. **Durable Background Jobs:**
   - Maintenance (demo cleanup) occurs during database initialization in `openDatabase`/`getDb` on a loose in-memory interval.
   - No durable local job table with leasing, retry limits, and dead-letter handling.

6. **Backup and Disaster Recovery:**
   - No SQLite Online Backup API integration.
   - No manifest, checksum validation, or isolated restore testing.
   - Account deletion leaves dangling data if archives or caches exist.

---

## 2. Proposed Architecture & Target Subsystems

```text
Client / Chat Interface
        │
        ▼
API & Request Coordinator (HTTP / SSE / Idempotency / Workspace Resolution)
        │
        ▼
Agent Orchestration Runtime
  ├── Intent Classifier & Route Planner
  ├── Bounded Context Builder (Rolling Summaries + Provenance)
  ├── Execution Budget Manager
  └── Tool Loop (web_search: Search + Selective Extract + Ranking)
        │
        ├──► Memory Engine (SQL + FTS5 + Provenance + Temporal Comparisons)
        ├──► Research Engine (Tavily + Official Ranking + Evidence Ledger)
        └──► Reliability & Quota Layer
              ├── Atomic DB Budget Reservations
              ├── Circuit Breakers (Groq & Tavily)
              └── Provider & Workspace Rate Limiters
                    │
                    ▼
          Storage & Caching Layer
            ├── Active SQLite (WAL mode, busy timeout, health checks)
            ├── Crash-Safe Compressed Local Archival (gzip/zlib + SQLite catalog)
            ├── Persistent & In-Process Bounded Caches (LRU + Single-Flight)
            ├── Durable Local Job Worker (Leases, Retries)
            └── Verified Backup System (SQLite Online Backup + Manifest)
```

---

## 3. Milestones & Implementation Sequence

### Milestone 1: General-Purpose Caching Architecture (`src/lib/cache/`)
- **Components:**
  - `lru.ts`: In-memory LRU with max entry count, max bytes, and TTL.
  - `singleflight.ts`: In-process promise coalescing for concurrent requests.
  - `store.ts`: Bounded persistent SQLite cache store (`cache.db` or dedicated tables) for web search and page extraction.
  - `keys.ts`: Workspace-scoped, parameter-normalized, and revision-aware cache keys.
  - Freshness policy: Explicit temporal comparison queries bypass or force revalidation of cached web search.
- **Verification:** Unit tests for hits, misses, TTL expiry, byte limits, stampede suppression, and workspace isolation.

### Milestone 2: Storage Lifecycle, Observability & Compressed Archival (`src/lib/storage/`)
- **Components:**
  - Migration v6: Archive catalog, storage metrics, and job queue schema.
  - `accounting.ts`: Disk footprint tracking (DB, WAL, SHM, Archive, Cache, Backup) and disk threshold guards.
  - `archive.ts`: Crash-safe archival state machine (`ELIGIBLE` -> `ARCHIVE_PENDING` -> `COPYING` -> `VERIFYING` -> `ARCHIVED` -> `SOURCE_COMPACTION` -> `COMPLETED`).
  - Compressed immutable segment storage (zlib/gzip json lines) with checksum verification.
  - Transparent search: Memory engine searches active records + archive catalog/segments seamlessly.
- **Verification:** Archive large synthetic conversation, verify compression ratio, assert message IDs and timestamps preserved, test query recall across archived items, test crash recovery.

### Milestone 3: Durable Local Job System (`src/lib/jobs/`)
- **Components:**
  - `queue.ts`: SQLite-backed job queue with atomic lease acquisition (`lease_until`), exponential retry, and status tracking.
  - `worker.ts`: Single-worker local runner executing background tasks:
    - Archive eligible conversations
    - Clean expired caches
    - Prune demo data and rate limits
    - Check database integrity (`PRAGMA integrity_check`)
    - Verify archives & create scheduled backups
- **Verification:** Job lease recovery after interruption, dead-letter transitions, idempotency under concurrent triggers.

### Milestone 4: Backup & Disaster Recovery (`src/lib/storage/backup/`)
- **Components:**
  - `backup.ts`: SQLite Online Backup (`db.backup(...)`), archive manifest inclusion, checksum generation, and retention rotation.
  - `restore.ts`: Atomic restore to target path with schema and manifest validation.
  - Account deletion cascade across active DB, archives, and cache tombstones.
- **Verification:** Backup during live writes, verify restore into isolated directory, test corrupt backup rejection, verify account deletion cleanliness.

### Milestone 5: Quota Management, Rate Limiting & Circuit Breakers (`src/lib/reliability/`)
- **Components:**
  - `circuit-breaker.ts`: Formal state machine (CLOSED, OPEN, HALF-OPEN) with probe limits and failure thresholds.
  - `reservations.ts`: Atomic SQLite budget reservations for Groq tokens and Tavily search credits.
  - `rate-limiter.ts`: Sliding window / token bucket rate limiter for workspace and provider concurrency.
  - Graceful degradation: Local memory recall remains functional during Groq/Tavily outages.
- **Verification:** Concurrent reservation starvation tests, circuit breaker trip and probe recovery, provider 429/500 simulation.

### Milestone 6: Agent Orchestration, Rolling Summaries & Bounded Context (`src/lib/agent/`)
- **Components:**
  - `orchestrator.ts`: Refactor `runTurn` to orchestrate through dedicated layers.
  - `budgets.ts`: Explicit turn execution budgets (max tool rounds = 3, max queries = 5, max extracts = 3, token bounds).
  - `summaries.ts`: Incremental rolling conversation summaries for long threads.
  - Strictly enforce the single model tool (`web_search`).
- **Verification:** Token budgeting, tool round enforcement, prompt injection defense in search results, zero regression on existing agent tests.

### Milestone 7: Diagnostics, Observability & Verification
- **Components:**
  - `/api/status`: Enhanced health and storage diagnostics (footprint, cache hit rates, circuit breaker states, job queue health).
  - Synthetic stress benchmark script (`scripts/benchmark-storage.ts`).
  - Full suite verification: `npm run check`, `npm run eval`, browser QA.
  - Updated `DESIGN.md`, `OPERATIONS.md`, and `ARCHITECTURE_OVERHAUL_REPORT.md`.

---

## 4. Dependencies & Safety Guarantees
- Zero new external cloud dependencies.
- Zero breaking changes to existing migrations v1–v5.
- All new tables introduced via forward-only migration v6.
- All 231 tests and 20/20 evaluation maintained at every milestone.
- Git commits will be clean, logical, and tested.

