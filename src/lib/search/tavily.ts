import type { SearchHit, SearchOutcome, SearchProvider, SearchQuery } from "./types";

/**
 * Tavily Search API (https://docs.tavily.com). Free plan: 1,000 credits/month,
 * `basic` depth = 1 credit per query. We never use paid-only options.
 *
 * Quota safety: when Tavily reports a plan/credit limit (432/433) or 401, a
 * circuit breaker stops further calls for a while instead of hammering the API;
 * the agent then answers without search and says so.
 */

const ENDPOINT = "https://api.tavily.com/search";
const SNIPPET_CHARS = 320;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

/** Process-wide breaker: engine refusals that will not clear by retrying now. */
const breaker = { until: 0, kind: null as null | "quota" | "auth", message: "" };

export function resetTavilyBreaker(): void {
  breaker.until = 0;
  breaker.kind = null;
  breaker.message = "";
}

export function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";
  constructor(
    private apiKey: string,
    private opts: { maxResults?: number; fetchImpl?: FetchLike; now?: () => Date } = {},
  ) {}

  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchOutcome> {
    const now = this.opts.now ?? (() => new Date());
    if (breaker.until > now().getTime() && breaker.kind) {
      return { query: q.query, hits: [], error: { kind: breaker.kind, message: breaker.message } };
    }
    const body: Record<string, unknown> = {
      query: q.query.slice(0, 400),
      topic: q.topic ?? "general",
      search_depth: "basic", // 1 credit; "advanced" costs 2
      max_results: this.opts.maxResults ?? 5,
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
    };
    if (q.timeRange) body.time_range = q.timeRange;
    if (q.includeDomains?.length) body.include_domains = q.includeDomains.slice(0, 10);

    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      return { query: q.query, hits: [], error: { kind: "failed", message: "Search request failed (network)." } };
    }

    if (!res.ok) {
      const s = res.status;
      if (s === 432 || s === 433) {
        breaker.until = now().getTime() + 6 * 3600_000;
        breaker.kind = "quota";
        breaker.message = "The free Tavily search quota is used up for now.";
        return { query: q.query, hits: [], error: { kind: "quota", message: breaker.message } };
      }
      if (s === 401 || s === 403) {
        breaker.until = now().getTime() + 5 * 60_000;
        breaker.kind = "auth";
        breaker.message = "The Tavily API key was rejected (check TAVILY_API_KEY).";
        return { query: q.query, hits: [], error: { kind: "auth", message: breaker.message } };
      }
      if (s === 429) return { query: q.query, hits: [], error: { kind: "rate_limit", message: "Search is rate-limited right now." } };
      return { query: q.query, hits: [], error: { kind: "failed", message: `Search failed (${s}).` } };
    }

    let json: { results?: TavilyResult[] };
    try {
      json = (await res.json()) as { results?: TavilyResult[] };
    } catch {
      return { query: q.query, hits: [], error: { kind: "failed", message: "Search returned malformed data." } };
    }
    const retrievedAt = now().toISOString();
    const hits: SearchHit[] = [];
    for (const r of Array.isArray(json.results) ? json.results : []) {
      if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
      hits.push({
        title: typeof r.title === "string" && r.title.trim() ? clip(r.title, 160) : r.url,
        url: r.url,
        snippet: typeof r.content === "string" ? clip(r.content, SNIPPET_CHARS) : "",
        publishedDate: normalizeDate(r.published_date),
        score: typeof r.score === "number" ? r.score : null,
        retrievedAt,
        query: q.query,
      });
    }
    return { query: q.query, hits };
  }
}
