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

export interface SearchOutcome {
  query: string;
  hits: SearchHit[];
  /** Set when the engine refused or failed; hits is then empty. */
  error?: { kind: "quota" | "rate_limit" | "auth" | "failed"; message: string };
}

export interface SearchProvider {
  readonly name: string;
  search(q: SearchQuery, signal: AbortSignal): Promise<SearchOutcome>;
}
