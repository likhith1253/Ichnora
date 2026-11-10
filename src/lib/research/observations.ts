import type { Source } from "../db/repo";
import { parseMarkdownTables } from "../memory/extract";
import { normalizeUrl } from "../agent/sources";

/**
 * Research ledger: turn an answer's comparison table into normalised, dated
 * observations, and compare a baseline snapshot with a current one IN CODE.
 * The model writes prose; the application decides whether like is compared
 * with like and whether evidence is sufficient.
 */

export type EvidenceLevel = "full_page" | "snippet" | "recollection" | "unsourced";

export interface Observation {
  entity: string;
  entityNorm: string;
  attribute: string; // "price" | "release" | other header
  rawValue: string;
  amount: number | null;
  currency: string | null;
  period: "month" | "year" | "one_time" | null;
  billing: "monthly" | "annual" | null;
  unit: "user" | "seat" | null;
  tier: string | null;
  effectiveDate: string | null;
  sourceUrl: string | null;
  sourcePublished: string | null;
  evidenceLevel: EvidenceLevel;
  observedOn: string;
}

export type ChangeStatus = "CHANGED" | "NO_MATERIAL_CHANGE" | "UNABLE_TO_VERIFY";

export interface ChangeRow {
  entity: string;
  attribute: string;
  then: Pick<Observation, "rawValue" | "amount" | "currency" | "period" | "billing" | "tier" | "observedOn" | "sourceUrl" | "evidenceLevel"> | null;
  now: Pick<Observation, "rawValue" | "amount" | "currency" | "period" | "billing" | "tier" | "observedOn" | "sourceUrl" | "evidenceLevel" | "effectiveDate" | "sourcePublished"> | null;
  status: ChangeStatus;
  reason: string;
  deltaPct: number | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function normEntity(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(crm|inc|ltd|llc|sales hub|sales cloud|plan|pricing)\b/g, " ")
    .replace(/[^a-z0-9.+#]+/g, " ")
    .trim()
    .split(" ")[0]!;
}

const CURRENCY: Array<[RegExp, string]> = [
  [/US\$|\$|\busd\b/i, "USD"],
  [/€|\beur\b/i, "EUR"],
  [/£|\bgbp\b/i, "GBP"],
  [/₹|\binr\b|\brs\.?\s/i, "INR"],
];

/** Parse "$90/seat/mo (billed annually)" → amount 90, USD, month, annual, seat. */
export function parsePrice(raw: string, context = ""): Pick<Observation, "amount" | "currency" | "period" | "billing" | "unit"> {
  const s = `${raw} ${context}`.toLowerCase();
  const text = raw.replace(/,/g, "");
  const m = text.match(/(?:US\$|\$|€|£|₹|rs\.?\s?|usd\s?|eur\s?|inr\s?)\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:usd|eur|inr|\$)/i);
  const free = /\bfree\b|\$0\b/.test(raw.toLowerCase());
  const amount = m ? Number(m[1] ?? m[2]) : free ? 0 : null;
  const currency = CURRENCY.find(([re]) => re.test(raw))?.[1] ?? (amount !== null && amount > 0 ? null : null);
  const period: Observation["period"] = /\/\s?(?:mo|month)\b|per month|\bmonthly\b|a month|\/m\b/.test(s)
    ? "month"
    : /\/\s?(?:yr|year)\b|per year|\byearly\b|a year|\/y\b/.test(s)
      ? "year"
      : /one[- ]time|lifetime/.test(s)
        ? "one_time"
        : null;
  const billing: Observation["billing"] = /billed annually|annual(?:ly)? billing|paid annually|\(annual\)|annual plan|billed yearly|annual commitment/.test(s)
    ? "annual"
    : /billed monthly|month-to-month|monthly billing|\(monthly\)|paid monthly/.test(s)
      ? "monthly"
      : null;
  const unit: Observation["unit"] = /\bseat\b/.test(s) ? "seat" : /\buser\b/.test(s) ? "user" : null;
  return { amount: Number.isFinite(amount as number) ? amount : null, currency, period, billing, unit };
}

/** "effective 1 December 2026" / "starting Dec 1, 2026" / "from 2026-12-01" → YYYY-MM-DD. */
export function parseEffectiveDate(text: string): string | null {
  const s = text.toLowerCase();
  const iso = s.match(/\b(?:effective|starting|from|as of|takes effect(?: on)?)\s+(?:on\s+)?(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dm = s.match(/\b(?:effective|starting|from|as of|takes effect(?: on)?)\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*,?\s+(\d{4})/);
  if (dm && MONTHS.includes(dm[2]!)) return `${dm[3]}-${String(MONTHS.indexOf(dm[2]!) + 1).padStart(2, "0")}-${dm[1]!.padStart(2, "0")}`;
  const md = s.match(/\b(?:effective|starting|from|as of|takes effect(?: on)?)\s+(?:on\s+)?([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (md && MONTHS.includes(md[1]!)) return `${md[3]}-${String(MONTHS.indexOf(md[1]!) + 1).padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
  return null;
}

type Kind = "entity" | "price" | "tier" | "release" | "then" | "status" | "source" | "other";

function headerKind(h: string, i: number): Kind {
  const s = h.toLowerCase();
  if (i === 0) return "entity";
  if (/\bthen\b|baseline|earlier|previous|before|original/.test(s)) return "then";
  if (/status|change|verdict|result/.test(s)) return "status";
  if (/source|citation|evidence|link/.test(s)) return "source";
  if (/\bplan\b|tier|edition|package/.test(s) && !/price|cost/.test(s)) return "tier";
  if (/release|launch|shipped|update|feature|announce|changelog|version/.test(s)) return "release";
  if (/price|cost|pricing|per (?:user|seat)|\$|₹|€|\bnow\b|current|today/.test(s)) return "price";
  return "other";
}

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;

/**
 * Extract observations from every markdown table in an answer. Each row's
 * first cited link (validated against the turn's sources) becomes its
 * provenance; unsourced rows are kept but marked as such.
 */
export function extractObservations(answer: string, sources: Source[], observedOn: string, rawTablesMd?: string): Observation[] {
  const byUrl = new Map(sources.map((s) => [normalizeUrl(s.url), s] as const));
  const out: Observation[] = [];
  const md = rawTablesMd ?? answer;
  // parseMarkdownTables strips link markup; we need links per row → parse raw rows too.
  const rawRows = md.split(/\r?\n/).filter((l) => l.trim().startsWith("|") && !/^\|?\s*:?-{2,}/.test(l.trim()));
  for (const t of parseMarkdownTables(md)) {
    const kinds = t.headers.map(headerKind);
    for (const row of t.rows) {
      const entity = row[0]?.trim();
      if (!entity || entity.length > 80 || /^(total|note|-+)$/i.test(entity)) continue;
      const raw = rawRows.find((r) => r.includes(entity)) ?? "";
      const linkUrl = raw.match(LINK_RE)?.[2] ?? null;
      const src = linkUrl ? byUrl.get(normalizeUrl(linkUrl)) : undefined;
      const evidenceLevel: EvidenceLevel = src ? (src.evidenceLevel === "full_page" ? "full_page" : "snippet") : "unsourced";
      const tier = kinds.indexOf("tier") >= 0 ? (row[kinds.indexOf("tier")] ?? null) : null;
      kinds.forEach((k, i) => {
        if (k !== "price" && k !== "release") return;
        // Drop citation labels that the table cell carried, e.g. "(hubspot.com)" or "(hubspot.com, g2.com)".
        const value = row[i]
          ?.replace(/\s*\((?:\s*[a-z0-9-]+(?:\.[a-z0-9-]+)+\s*,?)+\)\s*/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!value || value === "-" || value.length > 300) return;
        const header = t.headers[i] ?? "";
        const price = k === "price" ? parsePrice(value, header) : { amount: null, currency: null, period: null, billing: null, unit: null };
        out.push({
          entity,
          entityNorm: normEntity(entity),
          attribute: k,
          rawValue: value,
          ...price,
          tier: tier?.trim() || null,
          effectiveDate: parseEffectiveDate(`${value} ${row.join(" ")}`),
          sourceUrl: src ? src.url : null,
          sourcePublished: src?.publishedDate ?? null,
          evidenceLevel,
          observedOn,
        });
      });
    }
  }
  return out;
}

/** Legacy baselines (research items saved before the ledger existed): facts JSON → observations. */
export function observationsFromFacts(facts: Array<{ entity: string; attribute: string; value: string; sourceUrl?: string }>, observedOn: string): Observation[] {
  return facts
    .filter((f) => headerKind(f.attribute, 1) === "price" || /[$€£₹]\s?\d/.test(f.value))
    .map((f) => ({
      entity: f.entity,
      entityNorm: normEntity(f.entity),
      attribute: "price",
      rawValue: f.value,
      ...parsePrice(f.value, f.attribute),
      tier: null,
      effectiveDate: null,
      sourceUrl: f.sourceUrl ?? null,
      sourcePublished: null,
      evidenceLevel: f.value.includes("(unverified)") ? ("recollection" as const) : f.sourceUrl ? ("snippet" as const) : ("unsourced" as const),
      observedOn,
    }));
}

const pick = (o: Observation) => ({
  rawValue: o.rawValue,
  amount: o.amount,
  currency: o.currency,
  period: o.period,
  billing: o.billing,
  tier: o.tier,
  observedOn: o.observedOn,
  sourceUrl: o.sourceUrl,
  evidenceLevel: o.evidenceLevel,
});

/**
 * Compare like with like. Rules (each is a test case):
 *  - no current evidence, or current value not backed by a web source → UNABLE TO VERIFY
 *  - different tier / billing basis / currency / period → UNABLE TO VERIFY (not comparable)
 *  - baseline had no exact amount → UNABLE TO VERIFY (exact change cannot be proven)
 *  - amounts equal (±0.5%) → NO MATERIAL CHANGE FOUND
 *  - otherwise CHANGED (with an effective date if one was stated — never dated by announcement)
 */
export function compareObservations(baseline: Observation[], current: Observation[], today: string): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const entities = [...new Set(baseline.filter((b) => b.attribute === "price").map((b) => b.entityNorm))];
  for (const e of entities) {
    const then = baseline.find((b) => b.entityNorm === e && b.attribute === "price")!;
    const nowAll = current.filter((c) => c.entityNorm === e && c.attribute === "price");
    // Prefer a current value on the same tier, then any.
    const now = nowAll.find((c) => c.tier && then.tier && c.tier.toLowerCase() === then.tier.toLowerCase()) ?? nowAll[0];
    const base = { entity: then.entity, attribute: "price", then: pick(then) };
    if (!now) {
      rows.push({ ...base, now: null, status: "UNABLE_TO_VERIFY", reason: "not re-checked in current sources", deltaPct: null });
      continue;
    }
    const nowPick = { ...pick(now), effectiveDate: now.effectiveDate, sourcePublished: now.sourcePublished };
    const row = (status: ChangeStatus, reason: string, deltaPct: number | null = null) => rows.push({ ...base, now: nowPick, status, reason, deltaPct });
    if (now.evidenceLevel === "unsourced" || now.evidenceLevel === "recollection") row("UNABLE_TO_VERIFY", "current value is not backed by a cited web source");
    else if (then.amount === null) row("UNABLE_TO_VERIFY", "no exact baseline price was recorded, so an exact change cannot be proven");
    else if (now.amount === null) row("UNABLE_TO_VERIFY", "no exact current price found in the sources");
    else if (then.tier && now.tier && then.tier.toLowerCase() !== now.tier.toLowerCase()) row("UNABLE_TO_VERIFY", `different plans compared (${then.tier} vs ${now.tier})`);
    else if (then.billing && now.billing && then.billing !== now.billing) row("UNABLE_TO_VERIFY", `different billing basis (${then.billing} vs ${now.billing})`);
    else if (then.currency && now.currency && then.currency !== now.currency) row("UNABLE_TO_VERIFY", `different currency (${then.currency} vs ${now.currency})`);
    else if (then.period && now.period && then.period !== now.period) row("UNABLE_TO_VERIFY", `different period (per ${then.period} vs per ${now.period})`);
    else {
      const delta = then.amount === 0 ? (now.amount === 0 ? 0 : 100) : ((now.amount - then.amount) / then.amount) * 100;
      if (Math.abs(delta) <= 0.5) row("NO_MATERIAL_CHANGE", "same price in the sources checked", 0);
      else if (now.effectiveDate && now.effectiveDate > today) row("CHANGED", `price change announced; takes effect ${now.effectiveDate} (not yet in force)`, Math.round(delta * 10) / 10);
      else row("CHANGED", now.effectiveDate ? `price changed (effective ${now.effectiveDate})` : "price differs from the baseline", Math.round(delta * 10) / 10);
    }
  }
  return rows;
}
