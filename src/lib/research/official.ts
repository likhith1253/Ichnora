/**
 * Source provenance: is a URL the vendor's own site, and what kind of page is
 * it? Deterministic and explainable — labels, not fake-precision scores.
 */

export type PageType = "pricing" | "changelog" | "docs" | "announcement" | "blog" | "news" | "comparison" | "other";

export interface Provenance {
  /** The page is on a domain owned by one of the named entities. */
  official: boolean;
  /** Which entity it is official for, when known. */
  entity: string | null;
  pageType: PageType;
  /** Host without "www." */
  domain: string;
}

/** Products whose vendor domain is not derivable from the product name. */
const ALIAS_DOMAINS: Record<string, string[]> = {
  freshsales: ["freshworks.com"],
  "sales cloud": ["salesforce.com"],
  "sales hub": ["hubspot.com"],
  "aws rds": ["aws.amazon.com", "amazon.com"],
  rds: ["aws.amazon.com"],
  aws: ["aws.amazon.com", "amazon.com"],
  "google cloud": ["cloud.google.com"],
  gcp: ["cloud.google.com"],
  azure: ["azure.microsoft.com", "microsoft.com"],
  neon: ["neon.tech", "neon.com"],
  node: ["nodejs.org"],
  "node.js": ["nodejs.org"],
  nodejs: ["nodejs.org"],
  postgres: ["postgresql.org"],
  postgresql: ["postgresql.org"],
  "zoho crm": ["zoho.com"],
  zoho: ["zoho.com"],
  github: ["github.com", "github.blog"],
  openai: ["openai.com"],
  render: ["render.com"],
  supabase: ["supabase.com"],
  vercel: ["vercel.com"],
};

/** Well-known third-party publishers / aggregators (never "official" for a vendor). */
const THIRD_PARTY = /(?:^|\.)(g2\.com|capterra\.com|getapp\.com|trustradius\.com|forbes\.com|techradar\.com|zapier\.com|medium\.com|reddit\.com|quora\.com|youtube\.com|facebook\.com|linkedin\.com|wikipedia\.org|softwareadvice\.com|nerdwallet\.com|pcmag\.com|investopedia\.com)$/;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function registrable(host: string): string {
  const parts = host.split(".");
  // Handle co.uk / com.au style suffixes conservatively.
  if (parts.length >= 3 && /^(co|com|org|net)$/.test(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

export function pageTypeOf(url: string, title = ""): PageType {
  const s = `${url} ${title}`.toLowerCase();
  if (/\b(vs|versus|alternatives?|compare|comparison|best-|top-\d+|review)\b|-vs-/.test(s)) return "comparison";
  if (/pricing|\/price|\/plans\b|plans-and-pricing|\bprice\b/.test(s)) return "pricing";
  if (/changelog|release-?notes|\/releases?\/|\/releases\b|what'?s-?new|\bupdates?\b/.test(s)) return "changelog";
  if (/\/docs?\b|documentation|developer|\/guide|\/help\b|support\./.test(s)) return "docs";
  if (/\/news\b|newsroom|press|announce/.test(s)) return "announcement";
  if (/\bblog\b|\/blog\/|\/resources\//.test(s)) return "blog";
  return "other";
}

function entityKeys(entity: string): string[] {
  const norm = entity.toLowerCase().replace(/\s+/g, " ").trim();
  const keys = new Set<string>(ALIAS_DOMAINS[norm] ?? []);
  const first = norm.split(/[\s(]/)[0]!.replace(/[^a-z0-9]/g, "");
  if (ALIAS_DOMAINS[first]) ALIAS_DOMAINS[first]!.forEach((d) => keys.add(d));
  if (first.length >= 3) keys.add(first); // "hubspot" → matches hubspot.com / blog.hubspot.com
  return [...keys];
}

/**
 * Official = the page's registrable domain belongs to a named entity:
 * hubspot.com for "HubSpot", freshworks.com for "Freshsales" (alias table).
 */
export function provenanceOf(url: string, entities: string[], title = ""): Provenance {
  const domain = hostOf(url);
  const reg = registrable(domain);
  const pageType = pageTypeOf(url, title);
  if (!domain || THIRD_PARTY.test(reg)) return { official: false, entity: null, pageType, domain };
  for (const e of entities) {
    for (const k of entityKeys(e)) {
      const hit = k.includes(".") ? domain === k || domain.endsWith(`.${k}`) : reg.split(".")[0] === k;
      if (hit) return { official: true, entity: e, pageType, domain };
    }
  }
  return { official: false, entity: null, pageType, domain };
}

/** Candidate entity names in a search query ("HubSpot Sales Hub pricing 2026" → ["HubSpot Sales Hub", "HubSpot"]). */
export function entitiesInQuery(query: string, includeDomains: string[] = []): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9.+#-]*(?:\s+[A-Z][A-Za-z0-9.+#-]*){0,2})/g)) {
    const phrase = m[1]!;
    if (/^(The|What|How|Is|Are|Pricing|Price|Plans?|Release|Notes|Changelog|Latest|Current|New|Best|Top)$/i.test(phrase)) continue;
    out.add(phrase);
    out.add(phrase.split(/\s+/)[0]!);
  }
  for (const d of includeDomains) out.add(d.replace(/^www\./, "").split(".")[0]!);
  return [...out];
}

/** What the query is after, used to decide whether a full-page read is worth a credit. */
export function queryNeeds(query: string): { pricing: boolean; releases: boolean } {
  const q = query.toLowerCase();
  return {
    pricing: /\b(pric|cost|plan|tier|per (?:user|seat)|subscription|\$|₹|€)/.test(q),
    releases: /\b(release|changelog|launch|shipped|new feature|announce|version|update)/.test(q),
  };
}
