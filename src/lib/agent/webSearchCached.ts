import { hostOf, type PageType } from "../research/official";
import { pickForExtraction, rankHits } from "../research/rank";
import type { Extraction, SearchHit, SearchOutcome, SearchProvider } from "../search/types";
import { normalizeUrl } from "./sources";
import { parseToolArgs, type Evidence, type ToolContext, type ToolRun } from "./webSearchTool";
import { getCacheStore } from "../cache/store";
import type { DB } from "../db";

function renderEvidence(e: Evidence): string {
  const head = `[${e.sourceNo}] ${e.label} — ${e.title}\n  URL: ${e.url}\n  Published: ${e.publishedDate ?? "unknown"} · Retrieved: ${e.retrievedAt.slice(0, 10)}`;
  if (e.evidenceLevel === "full_page") return `${head}\n  Evidence: FULL PAGE READ — relevant passages:\n  """${e.excerpt}"""`;
  const note = e.extractError ? ` (full page could not be read: ${e.extractError})` : "";
  return `${head}\n  Evidence: search snippet only${note}\n  Snippet: ${e.snippet}`;
}

export interface CachedToolContext extends ToolContext {
  db?: DB;
  bypassCache?: boolean;
}

/**
 * Runs web search with caching and single-flight protection while preserving
 * the exact evidence and ranking contract.
 */
export async function runCachedWebSearch(
  rawArgs: string,
  search: SearchProvider,
  ctx: CachedToolContext
): Promise<ToolRun> {
  const args = parseToolArgs(rawArgs);
  if (args.list.length === 0) {
    return { content: 'Invalid arguments. Call web_search with {"queries": ["..."]}.', queries: [], hits: [], evidence: [], extractions: [], outcomes: [], unavailable: false };
  }
  const allowed = args.list.slice(0, Math.max(0, ctx.budget.remaining));
  if (allowed.length === 0) {
    return {
      content: "Search budget for this answer is used up. Answer now with the evidence you already have; mark anything unchecked as 'cannot verify'.",
      queries: [],
      hits: [],
      evidence: [],
      extractions: [],
      outcomes: [],
      unavailable: false,
    };
  }
  ctx.budget.remaining -= allowed.length;

  const cacheStore = ctx.db ? getCacheStore() : null;

  const outcomes = await Promise.all(
    allowed.map((query) => {
      const q = { query, topic: args.topic, timeRange: args.time_range, includeDomains: args.include_domains };
      if (cacheStore && ctx.db) {
        return cacheStore.executeSearch(ctx.db, q, () => search.search(q, ctx.signal), Boolean(ctx.bypassCache));
      }
      return search.search(q, ctx.signal);
    }),
  );

  const numbered = (ctx.numbered ??= []);
  const extracted = (ctx.extracted ??= new Set<string>());
  const fresh: Array<{ query: string; items: Evidence[] }> = [];
  const hits: SearchHit[] = [];
  const perQuery = outcomes.length > 2 ? 3 : 4;

  for (const o of outcomes) {
    if (o.error) continue;
    const ranked = rankHits(o.hits, { query: o.query, includeDomains: args.include_domains, entities: ctx.entities, today: ctx.today });
    const items: Evidence[] = [];
    for (const h of ranked) {
      if (items.length >= perQuery) break;
      const n = normalizeUrl(h.url);
      if (!n || ctx.seenUrls.has(n)) continue;
      ctx.seenUrls.add(n);
      hits.push(h);
      const ev: Evidence = {
        sourceNo: numbered.length + 1,
        title: h.title,
        url: h.url,
        normalizedUrl: n,
        domain: hostOf(h.url),
        snippet: h.snippet,
        publishedDate: h.publishedDate,
        retrievedAt: h.retrievedAt,
        official: h.official,
        pageType: h.pageType as PageType,
        evidenceLevel: "snippet",
        label: h.official ? "OFFICIAL" : "third-party",
        query: o.query,
      };
      numbered.push(ev);
      items.push(ev);
    }
    if (items.length) fresh.push({ query: o.query, items });
  }

  // Selective Tavily Extract of at most 2 official pricing/changelog pages per call
  const extractions: Extraction[] = [];
  if (search.extract && ctx.extractBudget && ctx.extractBudget.remaining > 0) {
    const toRead = pickForExtraction(
      fresh.flatMap((f) => f.items),
      ctx.extractBudget.remaining,
      extracted,
    );
    if (toRead.length) {
      const urls = toRead.map((i) => i.url);
      const focusQuery = allowed.join(" ");

      let outcome: { pages: Extraction[]; error?: unknown } | null = null;
      if (cacheStore && ctx.db) {
        // Individual extraction caching
        const extractedPages = await Promise.all(
          urls.map((u) =>
            cacheStore.executeExtract(
              ctx.db!,
              u,
              async () => {
                const singleRes = await search.extract!([u], focusQuery, ctx.signal);
                return singleRes.pages[0] ?? { url: u, ok: false, content: "", retrievedAt: new Date().toISOString(), error: "Not found" };
              },
              Boolean(ctx.bypassCache)
            )
          )
        );
        outcome = { pages: extractedPages };
      } else {
        outcome = await search.extract(urls, focusQuery, ctx.signal);
      }

      ctx.extractBudget.remaining -= outcome.pages.length;
      for (const p of outcome.pages) {
        extracted.add(p.url);
        extractions.push(p);
        const match = numbered.find((e) => e.url === p.url);
        if (!match) continue;
        if (p.ok && p.content.trim()) {
          match.evidenceLevel = "full_page";
          match.excerpt = p.content;
        } else if (p.error) {
          match.extractError = p.error;
        }
      }
    }
  }

  const unavailable = outcomes.some((o) => o.error?.kind === "quota" || o.error?.kind === "auth");
  let content = "";
  if (fresh.length === 0) {
    const err = outcomes.find((o) => o.error)?.error;
    content = err
      ? `Search could not be completed (${err.kind}: ${err.message}). Answer with what you know and clearly mark anything unchecked as 'unverified'.`
      : "No new relevant results found. Answer now using the evidence you already have, and note anything that could not be verified.";
  } else {
    content = fresh
      .map(
        (f) =>
          `Results for "${f.query}":\n` +
          f.items.map((i) => renderEvidence(numbered[i.sourceNo - 1] ?? i)).join("\n\n"),
      )
      .join("\n\n");
  }

  return {
    content,
    queries: allowed,
    hits,
    evidence: fresh.flatMap((f) => f.items),
    extractions,
    outcomes,
    unavailable,
  };
}
