import type { Source, SourceOrigin } from "../db/repo";

/** A source as reported by the provider's web-search tool output. */
export interface RawSource {
  url: string;
  title?: string | null;
  origin: Exclude<SourceOrigin, "answer_link">;
  snippet?: string | null;
  publishedDate?: string | null;
  query?: string | null;
  retrievedAt?: string;
}

const TRACKING = /^(utm_\w+|gclid|fbclid|mc_eid|mc_cid|ref|ref_src|srsltid)$/i;

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Markdown links that appear in the answer text. */
export function answerLinks(text: string): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  for (const m of text.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) out.push({ title: m[1]!, url: m[2]! });
  return out;
}

/**
 * Merge and deduplicate sources. Links in the answer that the search tool did
 * not return are kept but marked `answer_link` so the UI can flag them as
 * unverified rather than silently presenting them as evidence.
 */
export function collectSources(raw: RawSource[], answer: string, retrievedAt: string): Source[] {
  const byUrl = new Map<string, Source>();
  const rank: Record<SourceOrigin, number> = { citation: 0, search: 1, answer_link: 2 };
  const add = (url: string, title: string | null | undefined, origin: SourceOrigin, extra: Partial<RawSource> = {}) => {
    const n = normalizeUrl(url);
    if (!n) return;
    const prev = byUrl.get(n);
    if (prev && rank[prev.origin] <= rank[origin]) {
      if (!prev.title && title) prev.title = title;
      return;
    }
    byUrl.set(n, {
      url: n,
      title: title?.trim() || prev?.title || null,
      domain: domainOf(n),
      retrievedAt: extra.retrievedAt ?? retrievedAt,
      origin,
      snippet: extra.snippet ?? prev?.snippet ?? null,
      publishedDate: extra.publishedDate ?? prev?.publishedDate ?? null,
      query: extra.query ?? prev?.query ?? null,
    });
  };
  for (const s of raw) add(s.url, s.title, s.origin, s);
  const fromTool = new Set(byUrl.keys());
  for (const l of answerLinks(answer)) {
    const n = normalizeUrl(l.url);
    if (!n) continue;
    if (fromTool.has(n)) {
      const s = byUrl.get(n)!;
      if (s.origin === "search") s.origin = "citation"; // actually cited in the answer
      if (!s.title) s.title = l.title;
    } else add(n, l.title, "answer_link");
  }
  return [...byUrl.values()].sort((a, b) => rank[a.origin] - rank[b.origin]).slice(0, 40);
}
