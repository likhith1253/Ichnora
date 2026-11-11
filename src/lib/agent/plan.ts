import type { Retrieval } from "../memory/retrieval";

/**
 * Search planning for change checks. When a re-check has a known baseline
 * (a research snapshot with named entities), the application already knows
 * exactly what must be searched: each entity's current pricing and/or recent
 * releases. Running those searches up front — through the same internal
 * web_search pipeline — lets the model answer in ONE round instead of spending
 * a round (and ~3-5K tokens on an 8K-tokens/minute budget) deciding to search.
 * The model still has the web_search tool for anything the plan missed.
 */
export function planRecheckQueries(r: Retrieval, userText: string, today: string, max = 5): string[] {
  if (r.intent !== "recall_and_verify" || !r.referent) return [];
  const entities = [...new Map(r.referent.entities.map((e) => [e.toLowerCase(), e.trim()] as const)).values()].filter(Boolean).slice(0, max);
  if (entities.length === 0) return [];
  const text = userText.toLowerCase();
  const baselineHasPrices = r.referent.facts.some((f) => /\$|€|£|₹|price|pricing|cost|per (?:user|seat)/i.test(`${f.attribute} ${f.value}`));
  const wantsPrice = /pric|cost|plan|tier|\$|cheap|expens/.test(text) || (baselineHasPrices && !/release|ship|launch|feature|version/.test(text));
  const wantsRelease = /ship|release|launch|feature|update|announce|version|new\b|big/.test(text);
  const year = today.slice(0, 4);
  const focus =
    wantsPrice && wantsRelease
      ? "pricing plans and latest product announcements"
      : wantsPrice
        ? "pricing plans"
        : wantsRelease
          ? "latest release changelog"
          : "latest";
  return entities.map((e) => `${e} ${focus} ${year}`);
}
