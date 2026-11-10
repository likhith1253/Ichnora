# Minimi — Design & Architecture

**One model, one tool, and a deterministic modular monolith around them.** Groq `openai/gpt-oss-120b` gets exactly one model-visible function: `web_search`. Everything else is ordinary, testable application code: memory, dates, open loops, decisions, compressed archival, multi-tier caching, durable jobs, evidence, and budgets. The model only ever sees a bounded, labelled slice of that context.

---

## 1. Overall Architecture
Minimi is organized as a **local-first modular monolith**:
- **API & Request Coordinator:** Authenticates via PKCE OAuth or local session, guarantees request idempotency via `client_request_id`, enforces admission control, and streams Server-Sent Events with end-to-end cancellation.
- **Agent Orchestration Runtime:** Bounded context builder, rolling conversation summaries, execution budget tracker (max 3 rounds, max 5 queries, max 3 extracts), and strict tool argument schema validation.
- **Memory Engine:** SQLite FTS5 full-text indexing, exact-date matching, referent resolution without LLM hallucination, typed personal facts, and immutable provenance pointing to verbatim quotes.
- **Research Engine:** `web_search` tool loop, Tavily search, selective official full-page extraction, domain ranking, citation validation with untrusted link stripping, and dated Then/Now/Status comparison reports.
- **Reliability & Caching:** Bounded LRU + persistent SQLite cache, in-process single-flight request coalescing, formal CLOSED/OPEN/HALF-OPEN circuit breakers, and atomic SQLite quota reservations.
- **Storage Lifecycle & DR:** Crash-safe compressed local archival (gzip segments + search index), durable SQLite-backed background job queue with leases, and SQLite Online Hot Backup with SHA-256 manifests.

---

## 2. Why Local-First SQLite & Why Modular Monolith
- **Local-First Privacy:** Persistent personal knowledge stays on the machine running Minimi. SQLite is the canonical source of truth. External cloud services (Groq for inference, Tavily for public web search) receive only sanitized, minimal context.
- **Deterministic Structural Queries:** Questions like *"What did I ask on 3 November?"*, *"What is overdue?"*, or *"Which decision superseded MongoDB?"* require exact relational integrity and date constraints. Vector databases introduce non-determinism, embedding latency, and ongoing cloud costs.
- **Modular Monolith over Microservices:** Minimi serves single users and private teams. Microservices and message brokers (Kafka/RabbitMQ) add network latency, distributed transaction complexity, and operational failure modes with zero benefit for this workload. Clean TypeScript boundaries provide all the modularity needed.

---

## 3. Storage Lifecycle and Local Archival
Unbounded transcript growth degrades performance over years. Minimi introduces explicit lifecycle classes:
- **Canonical / Permanent:** Memories, entities, decisions, unresolved commitments, and baseline observations stay permanent.
- **Compressed Archival:** Older transcripts are packaged into immutable, checksummed gzip segments (`.json.gz`), cataloged in SQLite, and indexed into `archive_fts`. Raw messages are compacted from the active DB, achieving **~94.2% space reduction** while preserving sub-millisecond date recall and full-text search.
- **Ephemeral:** Caches and demo data have explicit TTL expiration and size budgets.

---

## 4. General-Purpose Caching & Freshness Rules
- **Multi-layer Cache:** In-memory `BoundedLRUCache` (entry count, byte size, TTL) backed by a bounded persistent SQLite cache store (`local_cache`).
- **Single-Flight Coalescing:** Concurrent identical queries share one promise, preventing cache stampedes to external APIs.
- **Freshness Governance:** General queries benefit from cached search/extract. However, for explicit current or temporal-comparison queries (*"Has their pricing changed since Monday?"*), the system bypasses search cache or forces revalidation, comparing against the immutable historical baseline.

---

## 5. Rate Limits, Quotas & Circuit Breakers
- **Atomic Quota Reservations:** Concurrent requests reserve Groq token and Tavily credit allocations atomically in SQLite before executing, preventing over-consumption and race conditions.
- **Circuit Breakers:** Independent state machines for Groq and Tavily detect consecutive failures, trip to `OPEN` to fail fast and protect quotas, and probe in `HALF_OPEN` for recovery.
- **Graceful Degradation:** When Groq or Tavily are unavailable, local memory recall, open loops, and decision history continue functioning completely offline.

---

## 6. Durable Background Jobs & Hot Backups
- **Durable Local Jobs:** SQLite-backed queue with atomic leases (`lease_until`), exponential backoff retries, and dead-letter protection for routine housekeeping (demo pruning, cache expiry, archive compaction, WAL checkpoints).
- **Verified Backups:** Uses SQLite Online Backup API for safe snapshots during live WAL writes, bundles archive segments, verifies SHA-256 integrity, and supports verified restoration.

---

## 7. Migration Criteria: When Would We Leave SQLite?
Minimi will remain on SQLite until measured conditions justify migration:
1. Multi-region or multi-host horizontally scaled deployments requiring concurrent write replication across separate physical nodes.
2. Sustained concurrent write contention exceeding SQLite WAL throughput (>500 writes/sec sustained).
3. Explicit client-server sync architecture requiring server-side distributed consensus.
Until these conditions occur, SQLite provides higher throughput, lower latency, simpler operational reliability, and unmatched local privacy.
