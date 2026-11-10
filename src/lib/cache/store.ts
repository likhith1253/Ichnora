import type { DB } from "../db";
import { BoundedLRUCache } from "./lru";
import { getSingleFlight } from "./singleflight";
import { buildExtractionCacheKey, buildSearchCacheKey } from "./keys";
import type { Extraction, SearchOutcome, SearchQuery } from "../search/types";

/**
 * Multi-layer cache store:
 * 1. Fast in-memory BoundedLRU cache
 * 2. Persistent SQLite cache (scoped table with bounded eviction)
 * 3. In-flight request coalescing (single-flight)
 */

export interface CacheStoreOptions {
  memoryMaxEntries?: number;
  memoryMaxBytes?: number;
  searchTtlMs?: number;      // Default: 30 minutes
  extractTtlMs?: number;     // Default: 2 hours
}

export class CacheStore {
  private memCache: BoundedLRUCache<string>;
  private searchTtlMs: number;
  private extractTtlMs: number;

  constructor(opts: CacheStoreOptions = {}) {
    this.memCache = new BoundedLRUCache<string>({
      maxEntries: opts.memoryMaxEntries ?? 500,
      maxBytes: opts.memoryMaxBytes ?? 5 * 1024 * 1024, // 5MB in memory
    });
    this.searchTtlMs = opts.searchTtlMs ?? 30 * 60 * 1000;
    this.extractTtlMs = opts.extractTtlMs ?? 2 * 60 * 60 * 1000;
  }

  /**
   * Initialize cache tables in SQLite if they don't already exist.
   */
  initSchema(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_cache (
        key           TEXT PRIMARY KEY,
        namespace     TEXT NOT NULL,
        workspace_id  TEXT,
        payload       TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        expires_at    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        last_accessed TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_cache_exp ON local_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_local_cache_ns ON local_cache(namespace, last_accessed);
    `);
  }

  /**
   * Get cached item from memory, fallback to SQLite.
   */
  get<T>(db: DB, key: string, now: Date = new Date()): T | null {
    const nowMs = now.getTime();
    const inMem = this.memCache.get(key, nowMs);
    if (inMem) {
      try {
        return JSON.parse(inMem) as T;
      } catch {
        this.memCache.delete(key);
      }
    }

    try {
      const row = db.prepare(
        "SELECT payload, expires_at FROM local_cache WHERE key = ?"
      ).get(key) as { payload: string; expires_at: string } | undefined;

      if (!row) return null;

      if (new Date(row.expires_at).getTime() <= nowMs) {
        db.prepare("DELETE FROM local_cache WHERE key = ?").run(key);
        return null;
      }

      // Update last_accessed in SQLite
      db.prepare("UPDATE local_cache SET last_accessed = ? WHERE key = ?").run(now.toISOString(), key);

      // Populate in-memory cache
      const ttlMs = Math.max(1000, new Date(row.expires_at).getTime() - nowMs);
      this.memCache.set(key, row.payload, ttlMs, nowMs);

      return JSON.parse(row.payload) as T;
    } catch {
      return null;
    }
  }

  /**
   * Store item in both memory and SQLite cache.
   */
  set<T>(
    db: DB,
    params: {
      key: string;
      namespace: string;
      workspaceId?: string;
      value: T;
      ttlMs: number;
      now?: Date;
    }
  ): void {
    const now = params.now ?? new Date();
    const nowMs = now.getTime();
    const expiresAt = new Date(nowMs + params.ttlMs);
    const payload = JSON.stringify(params.value);
    const sizeBytes = payload.length * 2;

    this.memCache.set(params.key, payload, params.ttlMs, nowMs);

    try {
      db.prepare(`
        INSERT INTO local_cache(key, namespace, workspace_id, payload, size_bytes, expires_at, created_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          payload = excluded.payload,
          size_bytes = excluded.size_bytes,
          expires_at = excluded.expires_at,
          last_accessed = excluded.last_accessed
      `).run(
        params.key,
        params.namespace,
        params.workspaceId ?? null,
        payload,
        sizeBytes,
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString()
      );
    } catch {
      // Non-fatal if persistent write fails
    }
  }

  /**
   * Delete item by key.
   */
  delete(db: DB, key: string): void {
    this.memCache.delete(key);
    try {
      db.prepare("DELETE FROM local_cache WHERE key = ?").run(key);
    } catch {
      /* ignore */
    }
  }

  /**
   * Invalidate all entries for a specific workspace.
   */
  invalidateWorkspace(db: DB, workspaceId: string): void {
    this.memCache.clear();
    try {
      db.prepare("DELETE FROM local_cache WHERE workspace_id = ?").run(workspaceId);
    } catch {
      /* ignore */
    }
  }

  /**
   * Prune expired rows and enforce maximum persistent cache size (e.g. 20MB).
   */
  prune(db: DB, maxTotalBytes: number = 20 * 1024 * 1024, now: Date = new Date()): { expired: number; evicted: number } {
    this.memCache.prune(now.getTime());
    let expired = 0;
    let evicted = 0;

    try {
      const expRes = db.prepare("DELETE FROM local_cache WHERE expires_at <= ?").run(now.toISOString());
      expired = expRes.changes;

      const totalSizeRow = db.prepare("SELECT SUM(size_bytes) as total FROM local_cache").get() as { total: number | null };
      let total = totalSizeRow?.total ?? 0;

      if (total > maxTotalBytes) {
        const rows = db.prepare("SELECT key, size_bytes FROM local_cache ORDER BY last_accessed ASC").all() as Array<{ key: string; size_bytes: number }>;
        const deleteStmt = db.prepare("DELETE FROM local_cache WHERE key = ?");
        for (const r of rows) {
          if (total <= maxTotalBytes) break;
          deleteStmt.run(r.key);
          this.memCache.delete(r.key);
          total -= r.size_bytes;
          evicted++;
        }
      }
    } catch {
      /* non-fatal */
    }

    return { expired, evicted };
  }

  /**
   * Single-flight cached web search execution.
   */
  async executeSearch(
    db: DB,
    q: SearchQuery,
    execFn: () => Promise<SearchOutcome>,
    bypassCache: boolean = false
  ): Promise<SearchOutcome> {
    const key = buildSearchCacheKey({
      query: q.query,
      topic: q.topic,
      searchDepth: "basic",
      includeDomains: q.includeDomains,
    });

    if (!bypassCache) {
      const hit = this.get<SearchOutcome>(db, key);
      if (hit && !hit.error) {
        return hit;
      }
    }

    const sf = getSingleFlight();
    const outcome = await sf.do(key, async () => {
      const res = await execFn();
      if (!res.error && res.hits.length > 0) {
        this.set(db, {
          key,
          namespace: "search",
          value: res,
          ttlMs: this.searchTtlMs,
        });
      }
      return res;
    });

    return outcome;
  }

  /**
   * Single-flight cached page extraction.
   */
  async executeExtract(
    db: DB,
    url: string,
    execFn: () => Promise<Extraction>,
    bypassCache: boolean = false
  ): Promise<Extraction> {
    const key = buildExtractionCacheKey({ url });

    if (!bypassCache) {
      const hit = this.get<Extraction>(db, key);
      if (hit && hit.ok) {
        return hit;
      }
    }

    const sf = getSingleFlight();
    const outcome = await sf.do(key, async () => {
      const res = await execFn();
      if (res.ok) {
        this.set(db, {
          key,
          namespace: "extract",
          value: res,
          ttlMs: this.extractTtlMs,
        });
      }
      return res;
    });

    return outcome;
  }

  getStats(db?: DB): { memory: ReturnType<BoundedLRUCache<string>["getStats"]>; persistentBytes: number; persistentRows: number } {
    let persistentBytes = 0;
    let persistentRows = 0;
    if (db) {
      try {
        const row = db.prepare("SELECT COUNT(*) as count, SUM(size_bytes) as total FROM local_cache").get() as { count: number; total: number | null };
        persistentRows = row.count;
        persistentBytes = row.total ?? 0;
      } catch {
        /* ignore */
      }
    }
    return {
      memory: this.memCache.getStats(),
      persistentBytes,
      persistentRows,
    };
  }
}

// Global cache store instance
const g = globalThis as unknown as { __minimiCacheStore?: CacheStore };
export function getCacheStore(): CacheStore {
  g.__minimiCacheStore ??= new CacheStore();
  return g.__minimiCacheStore;
}
