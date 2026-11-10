/**
 * Search layer contract. The agent exposes exactly one tool to the model
 * (`web_search`); this interface is its implementation boundary, so the
 * backing engine (Tavily today) can change without touching the agent.
 */

export interface SearchQuery {
  query: string;
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
}

export interface SearchHit {
  title: string;
  url: string;
  /** Short extract (untrusted web content). */
  snippet: string;
  /** Publisher date as estimated by the engine (YYYY-MM-DD), when known. */
  publishedDate: string | null;
  score: number | null;
  /** When we fetched it (ISO, UTC). */
  retrievedAt: string;
  /** The query that produced this hit. */
  query: string;
}

export type SearchErrorKind = "quota" | "rate_limit" | "auth" | "failed" | "budget";

export interface SearchOutcome {
  query: string;
  hits: SearchHit[];
  /** Set when the engine refused or failed; hits is then empty. */
  error?: { kind: SearchErrorKind; message: string };
}

export interface Extraction {
  url: string;
  ok: boolean;
  /** Relevant passages only (query-focused), bounded. Untrusted. */
  content: string;
  retrievedAt: string;
  error?: string;
}

export interface ExtractOutcome {
  pages: Extraction[];
  error?: { kind: SearchErrorKind; message: string };
}

export interface SearchProvider {
  readonly name: string;
  search(q: SearchQuery, signal: AbortSignal): Promise<SearchOutcome>;
  /** Full-page read of selected URLs (optional capability). */
  extract?(urls: string[], query: string, signal: AbortSignal): Promise<ExtractOutcome>;
}
