/**
 * In-memory LRU cache with entry count, byte size, and TTL bounds.
 */

export interface CacheEntry<V> {
  value: V;
  sizeBytes: number;
  expiresAt: number;
  lastAccessed: number;
}

export interface LRUCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  defaultTtlMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  entryCount: number;
  totalBytes: number;
}

export class BoundedLRUCache<V> {
  private cache = new Map<string, CacheEntry<V>>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly defaultTtlMs: number;

  constructor(opts: LRUCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 1000;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024; // 10MB default
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60 * 1000; // 5 min default
  }

  private estimateSize(value: V): number {
    if (typeof value === "string") return value.length * 2;
    if (typeof value === "number") return 8;
    if (typeof value === "boolean") return 4;
    try {
      const json = JSON.stringify(value);
      return json ? json.length * 2 : 64;
    } catch {
      return 128;
    }
  }

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (entry.expiresAt > 0 && entry.expiresAt <= now) {
      this.cache.delete(key);
      this.totalBytes -= entry.sizeBytes;
      this.expirations++;
      this.misses++;
      return undefined;
    }

    // Refresh LRU order (delete & set)
    this.cache.delete(key);
    entry.lastAccessed = now;
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number, now: number = Date.now()): void {
    const sizeBytes = this.estimateSize(value);

    // If a single entry exceeds the maximum total cache capacity, do not cache
    if (sizeBytes > this.maxBytes) {
      return;
    }

    // Remove old entry if present
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.totalBytes -= existing.sizeBytes;
    }

    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? now + ttl : 0;

    const entry: CacheEntry<V> = {
      value,
      sizeBytes,
      expiresAt,
      lastAccessed: now,
    };

    this.cache.set(key, entry);
    this.totalBytes += sizeBytes;

    this.evictAsNeeded(now);
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.totalBytes -= entry.sizeBytes;
      return true;
    }
    return false;
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  prune(now: number = Date.now()): number {
    let expiredCount = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.cache.delete(key);
        this.totalBytes -= entry.sizeBytes;
        this.expirations++;
        expiredCount++;
      }
    }
    return expiredCount;
  }

  private evictAsNeeded(now: number): void {
    // Evict expired first
    if (this.cache.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      this.prune(now);
    }

    // Evict LRU (first key in Map iterator is the oldest accessed)
    while (this.cache.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.cache.delete(oldestKey);
        this.totalBytes -= entry.sizeBytes;
        this.evictions++;
      }
    }
  }

  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      entryCount: this.cache.size,
      totalBytes: this.totalBytes,
    };
  }
}
