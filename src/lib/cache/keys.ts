import { createHash } from "node:crypto";

/**
 * Normalizes and hashes strings for deterministic cache keys.
 */
export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Constructs a workspace-scoped memory retrieval cache key.
 * Accounts for workspace, normalized query, revision timestamp or counter, and timezone.
 */
export function buildMemoryCacheKey(params: {
  workspaceId: string;
  query: string;
  revision: string | number;
  timeZone: string;
  retrievalVersion?: number;
}): string {
  const normQuery = params.query.toLowerCase().replace(/\s+/g, " ").trim();
  const raw = `mem:${params.workspaceId}:${params.revision}:${params.timeZone}:v${params.retrievalVersion ?? 1}:${normQuery}`;
  return hashKey(raw);
}

/**
 * Constructs a cache key for web search.
 * Accounts for query, topic, depth, and domains.
 */
export function buildSearchCacheKey(params: {
  query: string;
  topic?: string;
  searchDepth?: string;
  includeDomains?: string[];
  configVersion?: number;
}): string {
  const normQuery = params.query.toLowerCase().replace(/\s+/g, " ").trim();
  const sortedDomains = (params.includeDomains ?? []).map((d) => d.toLowerCase().trim()).sort().join(",");
  const raw = `search:v${params.configVersion ?? 1}:${params.topic ?? "general"}:${params.searchDepth ?? "basic"}:${sortedDomains}:${normQuery}`;
  return hashKey(raw);
}

/**
 * Constructs a cache key for web page extraction.
 * Accounts for canonical URL and extraction version.
 */
export function buildExtractionCacheKey(params: {
  url: string;
  extractionVersion?: number;
}): string {
  let canonicalUrl = params.url.trim();
  try {
    const u = new URL(canonicalUrl);
    // Remove transient tracking query params
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    canonicalUrl = u.toString();
  } catch {
    // Keep raw url if malformed
  }
  const raw = `extract:v${params.extractionVersion ?? 1}:${canonicalUrl}`;
  return hashKey(raw);
}
