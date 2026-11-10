import { describe, expect, it, vi } from "vitest";
import { BoundedLRUCache } from "../src/lib/cache/lru";
import { SingleFlightGroup } from "../src/lib/cache/singleflight";
import { buildExtractionCacheKey, buildMemoryCacheKey, buildSearchCacheKey } from "../src/lib/cache/keys";
import { CacheStore } from "../src/lib/cache/store";
import { openDatabase } from "../src/lib/db";

describe("Caching Subsystem", () => {
  describe("BoundedLRUCache", () => {
    it("handles basic get/set, hit and miss metrics", () => {
      const lru = new BoundedLRUCache<string>({ maxEntries: 3, defaultTtlMs: 10_000 });
      lru.set("k1", "v1");
      expect(lru.get("k1")).toBe("v1");
      expect(lru.get("k2")).toBeUndefined();

      const stats = lru.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.entryCount).toBe(1);
    });

    it("evicts oldest entry when maxEntries is exceeded", () => {
      const lru = new BoundedLRUCache<string>({ maxEntries: 2 });
      lru.set("k1", "v1");
      lru.set("k2", "v2");
      lru.set("k3", "v3"); // triggers eviction of k1

      expect(lru.get("k1")).toBeUndefined();
      expect(lru.get("k2")).toBe("v2");
      expect(lru.get("k3")).toBe("v3");
      expect(lru.getStats().evictions).toBe(1);
    });

    it("evicts by LRU access order, not insert order", () => {
      const lru = new BoundedLRUCache<string>({ maxEntries: 2 });
      lru.set("k1", "v1");
      lru.set("k2", "v2");
      lru.get("k1"); // k1 is now most recently accessed, making k2 the oldest
      lru.set("k3", "v3"); // should evict k2

      expect(lru.get("k1")).toBe("v1");
      expect(lru.get("k2")).toBeUndefined();
      expect(lru.get("k3")).toBe("v3");
    });

    it("respects TTL expiration", () => {
      const lru = new BoundedLRUCache<string>({ defaultTtlMs: 50 });
      lru.set("k1", "v1", 50, 1000);
      expect(lru.get("k1", 1020)).toBe("v1");
      expect(lru.get("k1", 1060)).toBeUndefined();
      expect(lru.getStats().expirations).toBe(1);
    });

    it("evicts when maxBytes is exceeded", () => {
      // 100 bytes max
      const lru = new BoundedLRUCache<string>({ maxBytes: 100, maxEntries: 100 });
      const bigString = "x".repeat(30); // ~60 bytes
      lru.set("k1", bigString);
      lru.set("k2", bigString); // ~120 bytes -> evicts k1

      expect(lru.get("k1")).toBeUndefined();
      expect(lru.get("k2")).toBe(bigString);
    });
  });

  describe("SingleFlightGroup", () => {
    it("coalesces concurrent requests for the exact same key", async () => {
      const sf = new SingleFlightGroup();
      let executionCount = 0;

      const task = async () => {
        executionCount++;
        await new Promise((r) => setTimeout(r, 20));
        return "shared_result";
      };

      const [res1, res2, res3] = await Promise.all([
        sf.do("query-1", task),
        sf.do("query-1", task),
        sf.do("query-1", task),
      ]);

      expect(res1).toBe("shared_result");
      expect(res2).toBe("shared_result");
      expect(res3).toBe("shared_result");
      expect(executionCount).toBe(1);
    });

    it("executes independently for different keys", async () => {
      const sf = new SingleFlightGroup();
      let count = 0;
      const task = async () => {
        count++;
        return count;
      };

      const [r1, r2] = await Promise.all([
        sf.do("k1", task),
        sf.do("k2", task),
      ]);

      expect(r1).not.toBe(r2);
      expect(count).toBe(2);
    });
  });

  describe("Cache Keys Normalization", () => {
    it("normalizes search query casing and domain sorting", () => {
      const k1 = buildSearchCacheKey({ query: "Neon Postgres  Pricing", includeDomains: ["neon.tech", "github.com"] });
      const k2 = buildSearchCacheKey({ query: "neon postgres pricing ", includeDomains: ["github.com", "neon.tech"] });
      expect(k1).toBe(k2);
    });

    it("normalizes extraction URLs by removing tracking parameters", () => {
      const k1 = buildExtractionCacheKey({ url: "https://neon.tech/pricing?utm_source=twitter" });
      const k2 = buildExtractionCacheKey({ url: "https://neon.tech/pricing" });
      expect(k1).toBe(k2);
    });

    it("scopes memory cache key to workspace and revision", () => {
      const k1 = buildMemoryCacheKey({ workspaceId: "ws-1", query: "my tasks", revision: 1, timeZone: "Asia/Kolkata" });
      const k2 = buildMemoryCacheKey({ workspaceId: "ws-2", query: "my tasks", revision: 1, timeZone: "Asia/Kolkata" });
      const k3 = buildMemoryCacheKey({ workspaceId: "ws-1", query: "my tasks", revision: 2, timeZone: "Asia/Kolkata" });
      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
    });
  });

  describe("CacheStore Persistence & Single-Flight Integration", () => {
    it("stores and retrieves search and extract outcomes, preventing duplicate calls", async () => {
      const db = openDatabase(":memory:");
      const store = new CacheStore();
      store.initSchema(db);

      let searchCalls = 0;
      const searchFn = async () => {
        searchCalls++;
        return {
          query: "neon pricing",
          hits: [{ title: "Pricing", url: "https://neon.tech/pricing", domain: "neon.tech", content: "Details" }],
        };
      };

      // First call executes searchFn
      const res1 = await store.executeSearch(db, { query: "neon pricing" }, searchFn);
      expect(searchCalls).toBe(1);
      expect(res1.hits.length).toBe(1);

      // Second call hits cache
      const res2 = await store.executeSearch(db, { query: "neon pricing" }, searchFn);
      expect(searchCalls).toBe(1); // Cached!
      expect(res2.hits.length).toBe(1);

      // Bypassing cache forces re-execution
      const res3 = await store.executeSearch(db, { query: "neon pricing" }, searchFn, true);
      expect(searchCalls).toBe(2);
      expect(res3.hits.length).toBe(1);
    });

    it("invalidates workspace entries without affecting other workspaces", () => {
      const db = openDatabase(":memory:");
      const store = new CacheStore();
      store.initSchema(db);

      store.set(db, { key: "ws1-key", namespace: "mem", workspaceId: "ws1", value: { text: "hello ws1" }, ttlMs: 10_000 });
      store.set(db, { key: "ws2-key", namespace: "mem", workspaceId: "ws2", value: { text: "hello ws2" }, ttlMs: 10_000 });

      expect(store.get(db, "ws1-key")).toEqual({ text: "hello ws1" });
      expect(store.get(db, "ws2-key")).toEqual({ text: "hello ws2" });

      store.invalidateWorkspace(db, "ws1");
      expect(store.get(db, "ws1-key")).toBeNull();
      expect(store.get(db, "ws2-key")).toEqual({ text: "hello ws2" });
    });

    it("prunes expired and over-budget persistent cache items", () => {
      const db = openDatabase(":memory:");
      const store = new CacheStore();
      store.initSchema(db);

      const past = new Date(Date.now() - 5000);
      store.set(db, { key: "expired-key", namespace: "test", value: "old", ttlMs: 100, now: past });
      store.set(db, { key: "valid-key", namespace: "test", value: "new", ttlMs: 60_000 });

      const pruneRes = store.prune(db, 1024 * 1024);
      expect(pruneRes.expired).toBeGreaterThanOrEqual(1);
      expect(store.get(db, "expired-key")).toBeNull();
      expect(store.get(db, "valid-key")).toBe("new");
    });
  });
});
