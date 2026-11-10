import type { Source, SourceOrigin } from "../db/repo";

/** A source as reported by the provider's web-search tool output. */
export interface RawSource {
  url: string;
  title?: string | null;
  origin: Exclude<SourceOrigin, "answer_link">;
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
  const add = (url: string, title: string | null | undefined, origin: SourceOrigin) => {
    const n = normalizeUrl(url);
    if (!n) return;
    const prev = byUrl.get(n);
    if (prev && rank[prev.origin] <= rank[origin]) {
      if (!prev.title && title) prev.title = title;
      return;
    }
    byUrl.set(n, { url: n, title: title?.trim() || prev?.title || null, domain: domainOf(n), retrievedAt, origin });
  };
  for (const s of raw) add(s.url, s.title, s.origin);
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
 * gpt-oss browser citations look like 【3†L10-L20】 or 【turn0search3】. Replace
 * them with a Markdown link to the matching search result when we can map the
 * index, otherwise drop the marker (never invent a URL).
 */
export function rewriteCitationMarkers(text: string, results: RawSource[]): string {
  return text.replace(/【([^】]{1,60})】/g, (_m, inner: string) => {
    const idx = inner.match(/(?:search|†?)(\d+)/);
    const n = idx ? Number(idx[1]) : NaN;
    const src = Number.isInteger(n) ? results[n] : undefined;
    if (!src) return "";
    return ` [${domainOf(src.url)}](${src.url})`;
  });
}
