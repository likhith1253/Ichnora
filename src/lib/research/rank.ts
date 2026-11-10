import type { SearchHit } from "../search/types";
import { entitiesInQuery, provenanceOf, queryNeeds, type Provenance } from "./official";

/**
 * Source ranking. A transparent ordering, not a precision score:
 *   1. official page of the right type (pricing for price questions, changelog for releases)
 *   2. any official page
 *   3. third-party primary reporting (news/docs)
 *   4. comparison/aggregator pages
 * Ties are broken by the engine's relevance and by freshness.
 */

export interface RankedHit extends SearchHit {
  provenance: Provenance;
  tier: 1 | 2 | 3 | 4;
  /** Short human-readable reason shown to the model and in the UI. */
  label: string;
}

function tierOf(p: Provenance, needs: { pricing: boolean; releases: boolean }): RankedHit["tier"] {
  const rightType = (needs.pricing && p.pageType === "pricing") || (needs.releases && (p.pageType === "changelog" || p.pageType === "announcement"));
  if (p.official && rightType) return 1;
  if (p.official) return 2;
  if (p.pageType === "comparison") return 4;
  return 3;
}

export function labelOf(p: Provenance): string {
  const kind = p.pageType === "other" ? "page" : p.pageType === "changelog" ? "changelog / release notes" : `${p.pageType} page`;
  if (p.official) return `OFFICIAL ${p.entity ?? p.domain} ${kind}`;
  return `third-party ${kind} (${p.domain})`;
}

export function rankHits(hits: SearchHit[], ctx: { query: string; includeDomains?: string[]; entities?: string[]; today?: string }): RankedHit[] {
  const entities = [...new Set([...(ctx.entities ?? []), ...entitiesInQuery(ctx.query, ctx.includeDomains)])];
  const needs = queryNeeds(ctx.query);
  const fresh = (d: string | null) => (d && ctx.today ? (Date.parse(ctx.today) - Date.parse(d)) / 86_400_000 < 365 : false);
  return hits
    .map((h) => {
      const provenance = provenanceOf(h.url, entities, h.title);
      return { ...h, provenance, tier: tierOf(provenance, needs), label: labelOf(provenance) };
    })
    .sort((a, b) => a.tier - b.tier || Number(fresh(b.publishedDate)) - Number(fresh(a.publishedDate)) || (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Pick pages worth a full read: official pages of the needed type first; never
 * more than `max`, never a page already read this turn, never aggregators.
 */
export function pickForExtraction(ranked: RankedHit[], query: string, max: number, already: Set<string>): RankedHit[] {
  const needs = queryNeeds(query);
  if (!needs.pricing && !needs.releases) return [];
  return ranked.filter((h) => h.tier <= 2 && !already.has(h.url)).slice(0, max);
}
