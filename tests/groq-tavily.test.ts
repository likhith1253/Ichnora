/**
 * Provider + search layer, fully mocked: a scripted Groq streaming client and
 * a fake fetch for Tavily. Validates the tool loop, request shapes, quota
 * handling and source provenance without any API key or network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildGroqBody, buildGroqMessages, foldToolExchange, GroqProvider, type ChatClient } from "@/lib/agent/groq";
import { assertSingleSearchTool, type ProviderEvent } from "@/lib/agent/provider";
import type { ModelRequest } from "@/lib/agent/prompt";
import { collectSources, linkifyKnownUrls, resolveNumberedCitations, rewriteCitationMarkers } from "@/lib/agent/sources";
import { parseToolArgs, runWebSearch, WEB_SEARCH_TOOL } from "@/lib/agent/webSearchTool";
import { getConfig } from "@/lib/env";
import { normalizeDate, resetTavilyBreaker, TavilySearch } from "@/lib/search/tavily";
import { sanitizeSearchQuery } from "@/lib/search/sanitize";
import type { SearchProvider, SearchQuery } from "@/lib/search/types";

const REQ: ModelRequest = { system: "rules", memoryContext: "<memory_context>m</memory_context>", history: [{ role: "user", content: "earlier" }], user: "q", toolChoice: "auto" };
const CFG = getConfig({ GROQ_API_KEY: "test", TAVILY_API_KEY: "test" } as unknown as NodeJS.ProcessEnv);
const NOW = () => new Date("2026-11-10T10:00:00Z");

afterEach(() => resetTavilyBreaker());

/* ------------------------------------------------------------ helpers */

type Json = Record<string, unknown>;
const chunk = (delta: Json): Json => ({ choices: [{ delta }] });
async function* gen(items: Json[]): AsyncIterable<Json> {
  for (const i of items) yield i;
}
function toolCall(args: object, id = "call_1"): Json[] {
  const s = JSON.stringify(args);
  return [
    chunk({ tool_calls: [{ index: 0, id, function: { name: "web_search", arguments: s.slice(0, 10) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: s.slice(10) } }] }),
  ];
}
const textChunks = (t: string) => t.match(/.{1,12}/gs)!.map((c) => chunk({ content: c }));

class ScriptedGroq implements ChatClient {
  bodies: Json[] = [];
  constructor(private rounds: Array<Json[] | Error>) {}
  async create(body: Json): Promise<AsyncIterable<Json>> {
    this.bodies.push(structuredClone(body));
    const next = this.rounds.shift();
    if (!next) throw new Error("no more scripted rounds");
    if (next instanceof Error) throw next;
    return gen(next);
  }
}

class FakeSearch implements SearchProvider {
  readonly name = "fake";
  calls: SearchQuery[] = [];
  async search(q: SearchQuery) {
    this.calls.push(q);
    return {
      query: q.query,
      hits: [
        { title: `${q.query} — official`, url: `https://${q.query.split(" ")[0]!.toLowerCase()}.com/pricing`, snippet: "Plan A $19/month", publishedDate: "2026-10-01", score: 0.9, retrievedAt: NOW().toISOString(), query: q.query },
      ],
    };
  }
}

async function run(p: GroqProvider, req = REQ) {
  const events: ProviderEvent[] = [];
  for await (const e of p.stream(req, new AbortController().signal)) events.push(e);
  return events;
}

/* ------------------------------------------------------------ request shape */

describe("Groq request (tool surface)", () => {
  it("offers exactly one tool — web_search — with a strict schema", () => {
    const body = buildGroqBody(buildGroqMessages(REQ, true), CFG, "auto");
    expect(body.tools).toEqual([WEB_SEARCH_TOOL]);
    assertSingleSearchTool(body.tools as object[]);
    expect(body.tool_choice).toBe("auto");
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(WEB_SEARCH_TOOL.function.parameters.additionalProperties).toBe(false);
  });
  it("sends no tools at all for recall/chat", () => {
    expect(buildGroqBody(buildGroqMessages(REQ, true), CFG, "none").tools).toBeUndefined();
  });
  it("keeps memory as a separate labelled system message", () => {
    const msgs = buildGroqMessages(REQ, true);
    expect(msgs.map((m) => m.role)).toEqual(["system", "system", "user", "user"]);
    expect(msgs[1]!.content).toContain("<memory_context>");
  });
  it("raises reasoning effort for forced change checks", () => {
    expect(buildGroqBody([], CFG, "required").reasoning_effort).toBe("medium");
    expect(buildGroqBody([], CFG, "auto").reasoning_effort).toBe("low");
  });
  it("the invariant rejects any other or extra tool", () => {
    expect(() => assertSingleSearchTool([WEB_SEARCH_TOOL, { type: "function", function: { name: "memory_lookup" } }])).toThrow();
    expect(() => assertSingleSearchTool([{ type: "function", function: { name: "fetch_url" } }])).toThrow();
    expect(() => assertSingleSearchTool([{ type: "browser_search" }])).toThrow();
  });
});

/* ------------------------------------------------------------ tool loop */

describe("Groq tool loop", () => {
  it("searches via the tool, feeds results back, and streams a cited final answer", async () => {
    const search = new FakeSearch();
    const groq = new ScriptedGroq([
      [chunk({ content: "Let me check." }), ...toolCall({ queries: ["Neon pricing", "Supabase pricing"], include_domains: ["neon.com", "supabase.com"] })],
      textChunks("Neon Launch is $19/month ([Neon](https://neon.com/pricing))."),
    ]);
    const events = await run(new GroqProvider(CFG, search, groq), { ...REQ, toolChoice: "required" });

    expect(search.calls.map((c) => c.query)).toEqual(["Neon pricing", "Supabase pricing"]);
    expect(search.calls[0]!.includeDomains).toEqual(["neon.com", "supabase.com"]);
    expect(groq.bodies[0]!.tool_choice).toBe("required");
    expect(groq.bodies[1]!.tool_choice).toBe("auto");
    const second = groq.bodies[1]!.messages as Json[];
    const toolMsg = second.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(String(toolMsg.content)).toContain("URL: https://neon.com/pricing");
    expect(String(toolMsg.content)).toContain("Published: 2026-10-01");
    expect(String(toolMsg.content)).toMatch(/UNTRUSTED/);

    expect(events.some((e) => e.type === "reset")).toBe(true); // pre-tool chatter discarded
    const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
    expect(done.text).toBe("Neon Launch is $19/month ([Neon](https://neon.com/pricing)).");
    expect(done.searchQueries).toEqual(["Neon pricing", "Supabase pricing"]);
    expect(done.sources[0]).toMatchObject({ url: "https://neon.com/pricing", publishedDate: "2026-10-01", snippet: "Plan A $19/month", query: "Neon pricing" });
    const stored = collectSources(done.sources, done.text, NOW().toISOString());
    expect(stored.find((s) => s.url === "https://neon.com/pricing")).toMatchObject({ origin: "citation", publishedDate: "2026-10-01" });
  });

  it("enforces the per-turn search budget and forces a final answer", async () => {
    const search = new FakeSearch();
    const cfg = { ...CFG, MAX_SEARCHES_PER_TURN: 3 };
    const groq = new ScriptedGroq([
      toolCall({ queries: ["a1", "b1", "c1", "d1"] }),
      textChunks("Done."),
    ]);
    const events = await run(new GroqProvider(cfg, search, groq));
    expect(search.calls).toHaveLength(3);
    expect(groq.bodies[1]!.tools).toBeUndefined(); // budget spent → no more tool offered
    expect((events.at(-1) as { text: string }).text).toBe("Done.");
  });

  it("never runs more than 3 model rounds (last one has no tools)", async () => {
    const search = new FakeSearch();
    const groq = new ScriptedGroq([
      toolCall({ queries: ["x1"] }, "c1"),
      toolCall({ queries: ["x2"] }, "c2"),
      textChunks("Final."),
    ]);
    await run(new GroqProvider({ ...CFG, MAX_SEARCHES_PER_TURN: 12 }, search, groq));
    expect(groq.bodies).toHaveLength(3);
    expect(groq.bodies[2]!.tools).toBeUndefined();
  });

  it("answers an unknown tool name with a correction, never executing it", async () => {
    const search = new FakeSearch();
    const groq = new ScriptedGroq([
      [chunk({ tool_calls: [{ index: 0, id: "z", function: { name: "delete_database", arguments: "{}" } }] })],
      textChunks("OK."),
    ]);
    await run(new GroqProvider(CFG, search, groq));
    expect(search.calls).toHaveLength(0);
    const tool = (groq.bodies[1]!.messages as Json[]).find((m) => m.role === "tool")!;
    expect(String(tool.content)).toMatch(/only tool is web_search/);
  });

  it("recovers when Groq rejects the tool call mid-stream (schema validation)", async () => {
    async function* failing(): AsyncIterable<Json> {
      yield chunk({ content: "Checking" });
      throw new Error("Tool call validation failed: parameters for tool web_search did not match schema");
    }
    let n = 0;
    const client: ChatClient = {
      async create(body) {
        n++;
        return n === 1 ? failing() : gen(textChunks(`ok:${String(body.tool_choice)}`));
      },
    };
    const events = await run(new GroqProvider(CFG, new FakeSearch(), client));
    expect(events.some((e) => e.type === "reset")).toBe(true);
    expect((events.at(-1) as { text: string }).text).toBe("ok:undefined");
  });

  it("degrades 'required' to 'auto' when Groq reports tool_use_failed", async () => {
    const groq = new ScriptedGroq([Object.assign(new Error("tool_use_failed"), { status: 400 }), textChunks("Answer.")]);
    const events = await run(new GroqProvider(CFG, new FakeSearch(), groq), { ...REQ, toolChoice: "required" });
    expect(groq.bodies.map((b) => b.tool_choice)).toEqual(["required", "auto"]);
    expect((events.at(-1) as { text: string }).text).toBe("Answer.");
  });

  it("without a search key: no tool offered, answer flagged unverified", async () => {
    const groq = new ScriptedGroq([textChunks("⚠️ Live web search is unavailable right now.")]);
    const events = await run(new GroqProvider(CFG, null, groq));
    expect(groq.bodies[0]!.tools).toBeUndefined();
    expect(String((groq.bodies[0]!.messages as Json[])[0]!.content)).toMatch(/Web search unavailable/);
    expect(events.at(-1)).toMatchObject({ type: "done", searchUnavailable: true });
  });
});

/* ------------------------------------------------------------ tool args */

describe("web_search arguments", () => {
  it("accepts queries[] or a single query, dedupes, caps at 4", () => {
    expect(parseToolArgs('{"queries":["a b","a b","c d","e f","g h","i j","k l"]}').list).toEqual(["a b", "c d", "e f", "g h", "i j"]);
    expect(parseToolArgs('{"query":"neon pricing"}').list).toEqual(["neon pricing"]);
    expect(parseToolArgs("not json at all").list).toEqual(["not json at all"]);
    expect(parseToolArgs('{"queries":[]}').list).toEqual([]);
    expect(parseToolArgs('{"queries":["x y"],"include_domains":["javascript:alert(1)"]}').list).toEqual([]);
  });
  it("dedupes URLs across calls within one answer", async () => {
    const ctx = { signal: new AbortController().signal, seenUrls: new Set<string>(), budget: { remaining: 6 } };
    const s = new FakeSearch();
    const a = await runWebSearch('{"queries":["neon pricing"]}', s, ctx);
    const b = await runWebSearch('{"queries":["neon plans"]}', s, ctx);
    expect(a.hits).toHaveLength(1);
    expect(b.hits).toHaveLength(0);
    expect(b.content).toContain("no new results");
  });
});

/* ------------------------------------------------------------ Tavily */

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []) {
  return async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("Tavily search layer", () => {
  it("sends a free-tier request (basic depth, dates on, no answer) and maps results", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const t = new TavilySearch("tvly-test", {
      now: NOW,
      fetchImpl: fakeFetch(
        200,
        {
          query: "q",
          results: [
            { title: "Neon pricing", url: "https://neon.com/pricing", content: "Launch  plan\n $19 / month ".repeat(3), score: 0.93, published_date: "Wed, 01 Oct 2026 10:00:00 GMT" },
            { title: "bad", url: "javascript:alert(1)", content: "x" },
            { url: "https://example.com/no-title", content: "x" },
          ],
          response_time: 0.8,
        },
        seen,
      ),
    });
    const out = await t.search({ query: "neon pricing", topic: "news", timeRange: "month", includeDomains: ["neon.com"] }, new AbortController().signal);
    expect(seen[0]!.url).toBe("https://api.tavily.com/search");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({
      query: "neon pricing",
      topic: "news",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_published_date: true,
      time_range: "month",
      include_domains: ["neon.com"],
    });
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0]).toMatchObject({ url: "https://neon.com/pricing", publishedDate: "2026-10-01", score: 0.93, retrievedAt: "2026-11-10T10:00:00.000Z", query: "neon pricing" });
    expect(out.hits[0]!.snippet).not.toMatch(/\n| {2}/);
    expect(out.hits[1]!.title).toBe("https://example.com/no-title");
  });

  it("stops gracefully when the free quota is exhausted (432) and does not retry", async () => {
    let calls = 0;
    const t = new TavilySearch("k", {
      now: NOW,
      fetchImpl: async () => {
        calls++;
        return new Response('{"detail":{"error":"exceeds your plan"}}', { status: 432 });
      },
    });
    const a = await t.search({ query: "x" }, new AbortController().signal);
    const b = await t.search({ query: "y" }, new AbortController().signal);
    expect(a.error?.kind).toBe("quota");
    expect(b.error?.kind).toBe("quota");
    expect(calls).toBe(1); // circuit breaker: no hammering an exhausted plan
  });

  it("maps 401 / 429 / 5xx / network errors to non-fatal outcomes", async () => {
    for (const [status, kind] of [[401, "auth"], [429, "rate_limit"], [500, "failed"]] as const) {
      resetTavilyBreaker();
      const t = new TavilySearch("k", { now: NOW, fetchImpl: fakeFetch(status, {}) });
      expect((await t.search({ query: "x" }, new AbortController().signal)).error?.kind).toBe(kind);
    }
    const t = new TavilySearch("k", { now: NOW, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    expect((await t.search({ query: "x" }, new AbortController().signal)).error?.kind).toBe("failed");
  });

  it("quota exhaustion mid-turn tells the model to stop searching and flags the answer", async () => {
    const t = new TavilySearch("k", { now: NOW, fetchImpl: async () => new Response("{}", { status: 432 }) });
    const groq = new ScriptedGroq([toolCall({ queries: ["neon pricing"] }), textChunks("⚠️ unverified")]);
    const events = await run(new GroqProvider(CFG, t, groq));
    const tool = (groq.bodies[1]!.messages as Json[]).find((m) => m.role === "tool")!;
    expect(String(tool.content)).toMatch(/SEARCH UNAVAILABLE/);
    expect(groq.bodies[1]!.tools).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "done", searchUnavailable: true });
  });

  it("normalises dates", () => {
    expect(normalizeDate("2026-10-01T09:00:00Z")).toBe("2026-10-01");
    expect(normalizeDate("not a date")).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

describe("search query sanitisation (data minimisation)", () => {
  it("strips email addresses and collapses whitespace", () => {
    expect(sanitizeSearchQuery("pricing at   accounts@acme.co  please")).toBe("pricing at please");
    expect(sanitizeSearchQuery("contact rahul.sharma+leads@example.com about Neon pricing")).toBe("contact about Neon pricing");
    expect(sanitizeSearchQuery("neon pricing")).toBe("neon pricing");
    expect(sanitizeSearchQuery("   ")).toBe("");
  });

  it("never sends an email address to Tavily (search body)", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const t = new TavilySearch("tvly-test", { now: NOW, fetchImpl: fakeFetch(200, { results: [] }, seen) });
    await t.search({ query: "reach me at boss@acme.com for Neon pricing" }, new AbortController().signal);
    const body = JSON.parse(String(seen[0]!.init.body)) as { query: string };
    expect(body.query).not.toContain("@");
    expect(body.query).toContain("Neon pricing");
  });

  it("never sends an email address to Tavily (extract body)", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const t = new TavilySearch("tvly-test", { now: NOW, fetchImpl: fakeFetch(200, { results: [{ url: "https://neon.com/pricing", raw_content: "ok ".repeat(40) }] }, seen) });
    await t.extract(["https://neon.com/pricing"], "prices for team@acme.com", new AbortController().signal);
    const body = JSON.parse(String(seen[0]!.init.body)) as { query: string };
    expect(body.query).not.toContain("@");
  });

  it("skips a query that is pure identity data instead of calling out", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const t = new TavilySearch("tvly-test", { now: NOW, fetchImpl: fakeFetch(200, { results: [] }, seen) });
    const out = await t.search({ query: "person@example.com" }, new AbortController().signal);
    expect(seen).toHaveLength(0); // no network call at all
    expect(out.hits).toHaveLength(0);
  });
});

describe("gpt-oss citation markers", () => {
  const urls = ["https://nodejs.org/en/about/previous-releases", "https://endoflife.date/nodejs"];
  it("converts markers to links only for URLs the search returned", () => {
    expect(rewriteCitationMarkers("Node 24 is LTS【1†https://nodejs.org/en/about/previous-releases】.", urls)).toBe(
      "Node 24 is LTS ([nodejs.org](https://nodejs.org/en/about/previous-releases)).",
    );
    expect(rewriteCitationMarkers("See【2†L10-L20】.", urls)).toBe("See ([endoflife.date](https://endoflife.date/nodejs)).");
    expect(rewriteCitationMarkers("Fake【1†https://evil.example/x】 and【9†L1】.", urls)).toBe("Fake and.");
  });
});

describe("bare URL linkification", () => {
  const urls = ["https://blog.hubspot.com/sales/hubspot-sales-hub-pricing"];
  it("links bare URLs the search returned, leaves others and existing links alone", () => {
    expect(linkifyKnownUrls("| 🔄 Changed |(https://blog.hubspot.com/sales/hubspot-sales-hub-pricing) |", urls)).toBe(
      "| 🔄 Changed |([blog.hubspot.com](https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)) |",
    );
    expect(linkifyKnownUrls("See https://blog.hubspot.com/sales/hubspot-sales-hub-pricing.", urls)).toBe(
      "See [blog.hubspot.com](https://blog.hubspot.com/sales/hubspot-sales-hub-pricing).",
    );
    expect(linkifyKnownUrls("[x](https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)", urls)).toBe("[x](https://blog.hubspot.com/sales/hubspot-sales-hub-pricing)");
    expect(linkifyKnownUrls("(https://unknown.example/a)", urls)).toBe("(https://unknown.example/a)");
  });
});

describe("stable numbered citations", () => {
  const urls = ["https://www.hubspot.com/pricing/sales", "https://neon.tech/pricing", "https://supabase.com/pricing"];
  it("resolves [n] and [n, m] to the exact returned URLs", () => {
    expect(resolveNumberedCitations("Pro is $90/seat [1]. Launch $19 [2, 3].", urls)).toBe(
      "Pro is $90/seat ([hubspot.com](https://www.hubspot.com/pricing/sales)). Launch $19 ([neon.tech](https://neon.tech/pricing), [supabase.com](https://supabase.com/pricing)).",
    );
  });
  it("drops out-of-range numbers and leaves markdown links and code alone", () => {
    expect(resolveNumberedCitations("x [9] y", urls)).toBe("x  y");
    expect(resolveNumberedCitations("[1](https://keep.me) `arr[1]`", urls)).toBe("[1](https://keep.me) `arr[1]`");
    expect(resolveNumberedCitations("no results [1]", [])).toBe("no results [1]");
  });
});

describe("final-round tool call recovery", () => {
  it("nudges once when the model calls a tool on the no-tools round", async () => {
    const search = new FakeSearch();
    let n = 0;
    const client: ChatClient = {
      async create(body) {
        n++;
        if (n === 1) return gen(toolCall({ queries: ["neon pricing"] }));
        if (n === 2) return gen(toolCall({ queries: ["again"] }, "c2"));
        if (n === 3) throw new Error("Tool choice is none, but model called a tool");
        return gen(textChunks(`final:${(body.messages as Json[]).at(-1)!.role}`));
      },
    };
    const events = await run(new GroqProvider({ ...CFG, MAX_SEARCHES_PER_TURN: 12 }, search, client));
    expect((events.at(-1) as { text: string }).text).toBe("final:system");
  });
  it("folds the tool exchange into plain evidence so no tool structure remains", () => {
    const msgs: Json[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "a", content: "[1] OFFICIAL x — URL: https://x.com" },
    ];
    foldToolExchange(msgs);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(String(msgs[2]!.content)).toContain("[1] OFFICIAL x");
  });
  it("resolves bare gpt-oss markers like 【3】", () => {
    expect(rewriteCitationMarkers("Price $90【1】.", ["https://www.hubspot.com/pricing/sales"])).toBe("Price $90 ([hubspot.com](https://www.hubspot.com/pricing/sales)).");
  });
});

describe("planned re-check searches", () => {
  it("runs the app's planned searches before round 1, then lets the model answer in one round", async () => {
    const search = new FakeSearch();
    const groq = new ScriptedGroq([textChunks("HubSpot is $100 now [1].")]);
    const events = await run(new GroqProvider(CFG, search, groq), { ...REQ, toolChoice: "required", plannedQueries: ["HubSpot pricing plans 2026", "Pipedrive pricing plans 2026"] });
    expect(search.calls.map((c) => c.query)).toEqual(["HubSpot pricing plans 2026", "Pipedrive pricing plans 2026"]);
    expect(groq.bodies).toHaveLength(1); // one model round
    expect(groq.bodies[0]!.tools).toBeUndefined(); // answered from planned evidence in one round
    const sys = (groq.bodies[0]!.messages as Json[]).map((m) => String(m.content)).join("\n");
    expect(sys).toContain("Evidence gathered by web search for this re-check");
    const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
    expect(done.text).toContain("[hubspot.com](https://hubspot.com/pricing)");
    expect(done.searchQueries).toHaveLength(2);
  });
});
