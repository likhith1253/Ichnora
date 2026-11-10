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
  official?: boolean;
  evidenceLevel?: "snippet" | "full_page";
  sourceNo?: number;
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
      official: extra.official ?? prev?.official ?? false,
      evidenceLevel: extra.evidenceLevel ?? prev?.evidenceLevel ?? "snippet",
      sourceNo: extra.sourceNo ?? prev?.sourceNo ?? null,
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

/**
 * gpt-oss sometimes cites in its native format — 【1†https://x】, 【3†L10-L20】,
 * 【turn0search2】 — instead of Markdown. Convert to links ONLY when the URL is
 * one the search returned (directly, or by result number); otherwise drop the
 * marker. Never invents a link.
 */
export function rewriteCitationMarkers(text: string, resultUrls: string[]): string {
  const known = new Map(resultUrls.map((u) => [normalizeUrl(u), u] as const));
  return text.replace(/\s?【([^】]{1,400})】/g, (_m, inner: string) => {
    const direct = inner.match(/https?:\/\/[^\s†】]+/)?.[0];
    let url: string | undefined;
    // A URL the search never returned is dropped — never remapped by number.
    if (direct) url = known.get(normalizeUrl(direct));
    else {
      const n = Number(inner.match(/^(\d{1,3})†|search(\d{1,3})/)?.slice(1).find(Boolean));
      if (Number.isInteger(n) && n >= 1) url = resultUrls[n - 1];
    }
    return url ? ` ([${domainOf(url)}](${url}))` : "";
  });
}

/**
 * Turn bare URLs that the search returned — "(https://x)" or "https://x" —
 * into Markdown links so they render and count as citations. URLs the search
 * did not return are left untouched (and later flagged as unverified links).
 */
/**
 * Remove links whose target is not an allowed (previously validated) source:
 * the anchor text stays, the URL goes. Unsupported links are never presented
 * as evidence. Code blocks are left untouched.
 */
export function stripUnknownLinks(text: string, allowedUrls: Iterable<string>): { text: string; removed: number } {
  const allowed = new Set([...allowedUrls].map((u) => normalizeUrl(u)).filter(Boolean));
  let removed = 0;
  const parts = text.split(/(```[\s\S]*?```)/g);
  const out = parts.map((part) =>
    part.startsWith("```")
      ? part
      : part.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (m, label: string, url: string) => {
          if (allowed.has(normalizeUrl(url))) return m;
          removed++;
          return label;
        }),
  );
  return { text: out.join(""), removed };
}

export function linkifyKnownUrls(text: string, resultUrls: string[]): string {
  const known = new Map(resultUrls.map((u) => [normalizeUrl(u), u] as const));
  return text.replace(/(\]\()?(\(?)(https?:\/\/[^\s)<>\]|]+)(\)?)/g, (m, mdOpen: string | undefined, open: string, url: string, close: string) => {
    if (mdOpen) return m; // already a Markdown link target
    const clean = url.replace(/[.,;:!?'"]+$/, "");
    const trail = url.slice(clean.length);
    const hit = known.get(normalizeUrl(clean));
    if (!hit) return m;
    const link = `[${domainOf(hit)}](${hit})`;
    return open && close ? `(${link})${trail}` : `${open}${link}${trail}${close}`;
  });
}
