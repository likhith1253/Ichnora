import type { Source } from "../db/repo";
import { normalizeUrl } from "../agent/sources";

/**
 * Claim → evidence associations. A "claim" is the sentence or table row a
 * citation sits in; only links that resolve to a source returned this turn
 * count. Also measures how many factual-looking claims (numbers, prices,
 * dates) carry a citation — a coverage signal, not a truth guarantee.
 */

export interface ClaimEvidence {
  claim: string;
  url: string;
  official: boolean;
  evidenceLevel: "snippet" | "full_page";
}

export interface ClaimReport {
  claims: ClaimEvidence[];
  factualClaims: number;
  citedFactualClaims: number;
  /** cited / factual, or null when the answer makes no factual-looking claims. */
  coverage: number | null;
}

const FACTUAL = /[$€£₹]\s?\d|\d+(?:\.\d+)?\s?%|\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b|\bv?\d+\.\d+(?:\.\d+)?\b|\bper (?:user|seat|month|year)\b/i;

function units(answer: string): string[] {
  const out: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^\|?\s*:?-{2,}/.test(t) || /^#+\s/.test(t)) continue;
    if (t.startsWith("|")) out.push(t);
    else out.push(...t.split(/(?<=[.!?])\s+(?=[A-Z(])/));
  }
  return out.filter((u) => u.length > 3);
}

export function mapClaims(answer: string, sources: Source[]): ClaimReport {
  const byUrl = new Map(sources.filter((s) => s.origin !== "answer_link").map((s) => [normalizeUrl(s.url), s] as const));
  const claims: ClaimEvidence[] = [];
  let factual = 0;
  let cited = 0;
  for (const u of units(answer)) {
    const links = [...u.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => byUrl.get(normalizeUrl(m[1]!))).filter((s): s is Source => !!s);
    const text = u.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[|*_`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    const isFactual = FACTUAL.test(text) && !/^(?:item|crm|provider|plan|status)\b/i.test(text);
    if (isFactual) factual++;
    if (links.length) {
      if (isFactual) cited++;
      for (const s of links) claims.push({ claim: text, url: s.url, official: Boolean(s.official), evidenceLevel: s.evidenceLevel ?? "snippet" });
    }
  }
  return { claims, factualClaims: factual, citedFactualClaims: cited, coverage: factual ? Math.round((cited / factual) * 100) / 100 : null };
}
