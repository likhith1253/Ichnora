import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listMessages, type Source } from "@/lib/db/repo";
import { runWebSearch, type Evidence } from "@/lib/agent/webSearchTool";
import { TokenGate } from "@/lib/agent/rateGate";
import { mapClaims } from "@/lib/research/claims";
import { pageTypeOf, provenanceOf } from "@/lib/research/official";
import { rankHits } from "@/lib/research/rank";
import { compareObservations, extractObservations, parseEffectiveDate, parsePrice, type Observation } from "@/lib/research/observations";
import { BudgetedSearch, CreditLedger } from "@/lib/search/budget";
import type { ExtractOutcome, SearchHit, SearchProvider, SearchQuery } from "@/lib/search/types";
import { CRM_ANSWER, FakeProvider, memDb, startMemory, turn } from "./helpers";

const NOW = "2026-11-10T10:00:00.000Z";
const hit = (url: string, title = "t", query = "q", publishedDate: string | null = null, score = 0.5): SearchHit => ({
  url, title, snippet: "s", publishedDate, score, retrievedAt: NOW, query,
});

describe("official-source identification", () => {
  it.each([
    ["https://www.hubspot.com/pricing/sales", ["HubSpot"], true, "pricing"],
    ["https://blog.hubspot.com/sales/hubspot-pricing", ["HubSpot"], true, "pricing"],
    ["https://www.freshworks.com/crm/pricing/", ["Freshsales"], true, "pricing"],
    ["https://aws.amazon.com/rds/postgresql/pricing/", ["AWS RDS"], true, "pricing"],
    ["https://www.pipedrive.com/en/blog/freshsales-vs-monday", ["Freshsales"], false, "comparison"],
    ["https://www.g2.com/products/hubspot/pricing", ["HubSpot"], false, "pricing"],
    ["https://nodejs.org/en/blog/release/v24.11.0", ["Node.js"], true, "changelog"],
  ])("%s", (url, entities, official, type) => {
    const p = provenanceOf(url, entities);
    expect(p.official).toBe(official);
    expect(p.pageType).toBe(type);
  });
  it("a vendor's blog comparing a competitor is NOT official for the competitor", () => {
    expect(provenanceOf("https://www.pipedrive.com/en/blog/freshsales-vs-monday", ["Freshsales"]).official).toBe(false);
    expect(pageTypeOf("https://www.pipedrive.com/en/blog/freshsales-vs-monday")).toBe("comparison");
  });
});

describe("ranking", () => {
  it("puts official pricing pages first, aggregators last", () => {
    const ranked = rankHits(
      [
        hit("https://www.g2.com/compare/hubspot-vs-pipedrive", "HubSpot vs Pipedrive", "HubSpot pricing", null, 0.99),
        hit("https://techcrunch.com/hubspot-raises-prices", "HubSpot raises prices", "HubSpot pricing", "2026-10-01", 0.9),
        hit("https://www.hubspot.com/pricing/sales", "Sales Hub pricing", "HubSpot pricing", null, 0.4),
      ],
      { query: "HubSpot Sales Hub pricing", today: "2026-11-10" },
    );
    expect(ranked.map((r) => r.provenance.domain)).toEqual(["hubspot.com", "techcrunch.com", "g2.com"]);
    expect(ranked[0]!.label).toMatch(/^OFFICIAL HubSpot/);
    expect(ranked[2]!.label).toMatch(/^third-party comparison/);
  });
});

class FakeEngine implements SearchProvider {
  readonly name = "fake";
  extractCalls: string[][] = [];
  constructor(private results: Record<string, SearchHit[]>, private extractOk = true) {}
  async search(q: SearchQuery) {
    return { query: q.query, hits: this.results[q.query] ?? [] };
  }
  async extract(urls: string[]): Promise<ExtractOutcome> {
    this.extractCalls.push(urls);
    return { pages: urls.map((url) => (this.extractOk ? { url, ok: true, content: "Professional: $100/seat/month billed annually. Effective 1 December 2026.", retrievedAt: NOW } : { url, ok: false, content: "", retrievedAt: NOW, error: "blocked" })) };
  }
}

describe("two-stage retrieval inside the single tool", () => {
  const results = {
    "HubSpot pricing": [hit("https://blog.example.com/hubspot-review", "review", "HubSpot pricing", null, 0.9), hit("https://www.hubspot.com/pricing/sales", "Sales Hub pricing", "HubSpot pricing")],
    "Pipedrive pricing": [hit("https://www.pipedrive.com/en/pricing", "Pipedrive pricing", "Pipedrive pricing")],
    "Node.js history": [hit("https://en.wikipedia.org/wiki/Node.js", "Node.js", "Node.js history")],
  };
  const ctx = () => ({ signal: new AbortController().signal, seenUrls: new Set<string>(), budget: { remaining: 6 }, extractBudget: { remaining: 3 }, today: "2026-11-10" });

  it("reads official pricing pages in full, keeps others as snippets, and labels both", async () => {
    const engine = new FakeEngine(results);
    const run = await runWebSearch('{"queries":["HubSpot pricing","Pipedrive pricing"]}', engine, ctx());
    expect(engine.extractCalls).toEqual([["https://www.hubspot.com/pricing/sales", "https://www.pipedrive.com/en/pricing"]]);
    const hub = run.evidence.find((e) => e.url.includes("hubspot.com"))!;
    expect(hub).toMatchObject({ official: true, evidenceLevel: "full_page", pageType: "pricing" });
    expect(run.evidence.find((e) => e.url.includes("example.com"))).toMatchObject({ official: false, evidenceLevel: "snippet" });
    expect(run.content).toContain("FULL PAGE READ");
    expect(run.content).toContain("third-party");
    expect(run.content.indexOf("hubspot.com/pricing")).toBeLessThan(run.content.indexOf("example.com")); // official ranked first
  });

  it("never extracts for non-pricing/release questions (no wasted credits)", async () => {
    const engine = new FakeEngine(results);
    await runWebSearch('{"queries":["Node.js history"]}', engine, ctx());
    expect(engine.extractCalls).toEqual([]);
  });

  it("respects the per-turn extract budget and reports failed reads honestly", async () => {
    const engine = new FakeEngine(results, false);
    const c = { ...ctx(), extractBudget: { remaining: 1 } };
    const run = await runWebSearch('{"queries":["HubSpot pricing","Pipedrive pricing"]}', engine, c);
    expect(engine.extractCalls[0]).toHaveLength(1);
    expect(c.extractBudget.remaining).toBe(0);
    expect(run.content).toContain("full page could not be read: blocked");
    expect(run.evidence.every((e: Evidence) => e.evidenceLevel === "snippet")).toBe(true);
  });
});

describe("Tavily credit budget", () => {
  it("records usage, keeps a reserve for change checks, and refuses locally when exhausted", async () => {
    const db = memDb();
    let now = new Date("2026-11-10T00:00:00Z");
    const ledger = new CreditLedger(db, { monthlyLimit: 5, reserve: 2 }, () => now);
    const engine = new FakeEngine({ q: [hit("https://a.com/x")] });
    const s = new BudgetedSearch(engine, ledger);
    const sig = new AbortController().signal;
    for (let i = 0; i < 3; i++) expect((await s.search({ query: "q" }, sig)).error).toBeUndefined();
    expect(ledger.usedThisMonth()).toBe(3);
    expect((await s.search({ query: "q" }, sig)).error?.kind).toBe("budget"); // reserve protected
    s.context.priority = "high";
    expect((await s.search({ query: "q" }, sig)).error).toBeUndefined();
    expect((await s.search({ query: "q" }, sig)).error).toBeUndefined();
    expect((await s.search({ query: "q" }, sig)).error?.kind).toBe("budget"); // hard stop at the limit
    now = new Date("2026-12-01T00:00:00Z"); // new month
    expect((await s.search({ query: "q" }, sig)).error).toBeUndefined();
  });
  it("trusts the account's reported usage when it is higher than the local ledger", () => {
    const ledger = new CreditLedger(memDb(), { monthlyLimit: 1000, reserve: 100 });
    ledger.setAccountUsage(950);
    expect(ledger.remaining()).toBe(50);
    expect(ledger.canSpend(1, "normal")).toBe(false);
    expect(ledger.canSpend(1, "high")).toBe(true);
  });
});

describe("price normalisation", () => {
  it.each([
    ["$90/seat/mo (billed annually)", "", { amount: 90, currency: "USD", period: "month", billing: "annual", unit: "seat" }],
    ["₹1,200 per user per month", "", { amount: 1200, currency: "INR", period: "month", unit: "user" }],
    ["$1,080 per year", "", { amount: 1080, period: "year" }],
    ["€25", "Price (per user/month, billed monthly)", { amount: 25, currency: "EUR", period: "month", billing: "monthly", unit: "user" }],
    ["Free", "", { amount: 0 }],
    ["Contact sales", "", { amount: null }],
  ])("%s", (raw, ctx, expected) => expect(parsePrice(raw, ctx)).toMatchObject(expected));
  it("parses effective dates separately from publication dates", () => {
    expect(parseEffectiveDate("New pricing effective 1 December 2026")).toBe("2026-12-01");
    expect(parseEffectiveDate("starting Jan 15, 2027")).toBe("2027-01-15");
    expect(parseEffectiveDate("announced on 5 November 2026")).toBeNull();
  });
});

const obs = (o: Partial<Observation>): Observation => ({
  entity: "HubSpot", entityNorm: "hubspot", attribute: "price", rawValue: "$90", amount: 90, currency: "USD", period: "month", billing: "annual",
  unit: "seat", tier: "Professional", effectiveDate: null, sourceUrl: "https://www.hubspot.com/pricing", sourcePublished: null, evidenceLevel: "full_page", observedOn: "2026-11-09", ...o,
});

describe("change detection computed in code", () => {
  const T = "2026-11-10";
  it("CHANGED with delta when like is compared with like", () => {
    const [r] = compareObservations([obs({})], [obs({ amount: 100, rawValue: "$100", observedOn: T })], T);
    expect(r).toMatchObject({ status: "CHANGED", deltaPct: 11.1 });
  });
  it("NO MATERIAL CHANGE only with a sourced current value", () => {
    expect(compareObservations([obs({})], [obs({ observedOn: T })], T)[0]!.status).toBe("NO_MATERIAL_CHANGE");
    expect(compareObservations([obs({})], [obs({ observedOn: T, evidenceLevel: "unsourced", sourceUrl: null })], T)[0]).toMatchObject({
      status: "UNABLE_TO_VERIFY",
      reason: expect.stringMatching(/not backed by a cited web source/),
    });
  });
  it("refuses to compare different billing bases, tiers, currencies", () => {
    expect(compareObservations([obs({})], [obs({ amount: 100, billing: "monthly" })], T)[0]!.reason).toMatch(/billing basis/);
    expect(compareObservations([obs({})], [obs({ amount: 50, tier: "Starter" })], T)[0]!.reason).toMatch(/different plans/);
    expect(compareObservations([obs({})], [obs({ currency: "EUR" })], T)[0]!.reason).toMatch(/currency/);
  });
  it("absence of current evidence is not 'no change'", () => {
    expect(compareObservations([obs({})], [], T)[0]).toMatchObject({ status: "UNABLE_TO_VERIFY", now: null });
  });
  it("a missing baseline amount means the exact change cannot be proven", () => {
    expect(compareObservations([obs({ amount: null, rawValue: "around 90" })], [obs({ observedOn: T })], T)[0]!.reason).toMatch(/no exact baseline/);
  });
  it("announced-but-future prices are labelled by effective date, not announcement date", () => {
    const [r] = compareObservations([obs({})], [obs({ amount: 100, effectiveDate: "2026-12-01", sourcePublished: "2026-11-05" })], T);
    expect(r!.reason).toMatch(/takes effect 2026-12-01 \(not yet in force\)/);
  });
});

describe("observations from an answer table", () => {
  it("links each row to its validated source and evidence level", () => {
    const sources: Source[] = [
      { url: "https://www.hubspot.com/pricing/sales", title: "x", domain: "hubspot.com", retrievedAt: NOW, origin: "citation", official: true, evidenceLevel: "full_page" },
    ];
    const answer = `| CRM | Plan | Now | Status |\n|---|---|---|---|\n| HubSpot | Professional | $100/seat/month (billed annually) [hubspot.com](https://www.hubspot.com/pricing/sales) | Changed |\n| Zoho CRM | Standard | $14/user/month | ? |`;
    const o = extractObservations(answer, sources, "2026-11-10");
    expect(o[0]).toMatchObject({ entityNorm: "hubspot", amount: 100, billing: "annual", tier: "Professional", evidenceLevel: "full_page" });
    expect(o[1]).toMatchObject({ entityNorm: "zoho", amount: 14, evidenceLevel: "unsourced" });
  });
});

describe("claim → evidence mapping", () => {
  it("links claims to the source next to them and measures coverage of factual claims", () => {
    const sources: Source[] = [{ url: "https://neon.com/pricing", title: "x", domain: "neon.com", retrievedAt: NOW, origin: "citation", official: true, evidenceLevel: "snippet" }];
    const r = mapClaims("Neon Launch is $19/month ([neon.com](https://neon.com/pricing)). Supabase Pro is $25/month. Both are good.", sources);
    expect(r.claims).toEqual([{ claim: "Neon Launch is $19/month (neon.com).", url: "https://neon.com/pricing", official: true, evidenceLevel: "snippet" }]);
    expect(r).toMatchObject({ factualClaims: 2, citedFactualClaims: 1, coverage: 0.5 });
  });
  it("links to URLs not returned by search do not count", () => {
    const r = mapClaims("Price is $5 ([x](https://made-up.example/p)).", []);
    expect(r.claims).toEqual([]);
    expect(r.coverage).toBe(0);
  });
});

describe("token-per-minute gate", () => {
  it("waits when the window is full and never longer than the cap", async () => {
    let t = 0;
    const slept: number[] = [];
    const gate = new TokenGate(8000, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    gate.record(7000);
    expect(await gate.waitFor(500)).toBe(0); // fits
    const waited = await gate.waitFor(2000);
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(25_000);
    expect(gate.used()).toBeLessThanOrEqual(7000);
  });
});

describe("change report end to end (fake model)", () => {
  it("stores a computed then/now report on a re-check answer", async () => {
    const db = memDb();
    const ws = randomUUID();
    const sources = [{ url: "https://www.hubspot.com/pricing/sales", title: "HubSpot", origin: "search" as const, official: true, evidenceLevel: "full_page" as const }];
    await turn(db, new FakeProvider(() => ({ text: CRM_ANSWER, sources, queries: ["crm"] })), { workspaceId: ws, text: "Shortlist 5 CRMs for a 20-person sales team", at: new Date("2026-11-09T06:30:00Z") });
    const p = new FakeProvider(() => ({
      text: "| CRM | Plan | Now | Status |\n|---|---|---|---|\n| HubSpot | Sales Hub Professional | $100 per user/month, billed annually ([hubspot.com](https://www.hubspot.com/pricing/sales)) | Changed |",
      sources,
      queries: ["HubSpot pricing"],
    }));
    const { events, conversationId } = await turn(db, p, { workspaceId: ws, text: "Has any of them changed pricing since?" });
    expect(startMemory(events).intent).toBe("recall_and_verify");
    const msg = listMessages(db, conversationId).find((m) => m.role === "assistant")!;
    const report = msg.metadata.changeReport as { rows: Array<{ entity: string; status: string; deltaPct: number | null }>; baselineDate: string };
    expect(report.baselineDate).toBe("2026-11-09");
    expect(report.rows.find((r) => r.entity === "HubSpot")).toMatchObject({ status: "CHANGED", deltaPct: 11.1 });
    expect(report.rows.find((r) => r.entity === "Zoho CRM")).toMatchObject({ status: "UNABLE_TO_VERIFY" });
    expect(msg.metadata.claimCoverage).toBe(1);
  });
});
