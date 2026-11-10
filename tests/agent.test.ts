import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listMessages } from "@/lib/db/repo";
import {
  assertSingleSearchTool,
  buildGroqRequest,
  buildOpenAIRequest,
  groqExecutedToolSources,
  openAIOutputSources,
  type LlmProvider,
  type ProviderEvent,
} from "@/lib/agent/provider";
import { collectSources, normalizeUrl, rewriteCitationMarkers } from "@/lib/agent/sources";
import { buildGeminiRequest, groundingSources, insertGroundingCitations } from "@/lib/agent/gemini";
import { runTurn } from "@/lib/agent/run";
import type { ModelRequest } from "@/lib/agent/prompt";
import { getConfig, parseDotEnv, providerStatus } from "@/lib/env";
import { chatHandler } from "@/lib/server/chat-handler";
import { collect, deps, FakeProvider, memDb, turn, TZ } from "./helpers";

const REQ: ModelRequest = { system: "s", memoryContext: "<memory_context>x</memory_context>", history: [{ role: "user", content: "a" }], user: "q", toolChoice: "auto" };

describe("request builders (tool surface)", () => {
  it("Groq: exactly one browser_search tool, memory as a separate system message", () => {
    const body = buildGroqRequest(REQ, { GROQ_MODEL: "openai/gpt-oss-120b", GROQ_REASONING_EFFORT: "medium" });
    expect(body.tools).toEqual([{ type: "browser_search" }]);
    expect(body.tool_choice).toBe("auto");
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["system", "system", "user", "user"]);
  });
  it("OpenAI Responses: exactly one web_search tool, sources included, store disabled", () => {
    const body = buildOpenAIRequest({ ...REQ, toolChoice: "required" }, { OPENAI_MODEL: "gpt-5-mini" });
    expect(body).toMatchObject({ tools: [{ type: "web_search" }], tool_choice: "required", include: ["web_search_call.action.sources"], store: false });
  });
  it("no tools at all when search is not allowed", () => {
    expect(buildGroqRequest({ ...REQ, toolChoice: "none" }, { GROQ_MODEL: "m", GROQ_REASONING_EFFORT: "low" }).tools).toBeUndefined();
  });
  it("the invariant rejects any extra or custom tool", () => {
    expect(() => assertSingleSearchTool([{ type: "browser_search" }, { type: "function" }])).toThrow();
    expect(() => assertSingleSearchTool([{ type: "function" }])).toThrow();
    expect(() => assertSingleSearchTool([{ type: "web_search" }])).not.toThrow();
  });
});

describe("source extraction", () => {
  it("reads Groq executed_tools search results and queries", () => {
    const r = groqExecutedToolSources([
      { type: "browser_search", arguments: '{"query":"neon pricing"}', search_results: { results: [{ title: "Neon pricing", url: "https://neon.com/pricing", content: "..." }] } },
    ]);
    expect(r).toEqual({ sources: [{ url: "https://neon.com/pricing", title: "Neon pricing", origin: "search" }], queries: ["neon pricing"] });
    expect(groqExecutedToolSources("garbage")).toEqual({ sources: [], queries: [] });
  });
  it("reads OpenAI web_search_call sources and url_citation annotations", () => {
    const r = openAIOutputSources([
      { type: "web_search_call", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a.com/x" }] } },
      { type: "message", content: [{ type: "output_text", text: "t", annotations: [{ type: "url_citation", url: "https://b.com", title: "B" }] }] },
    ]);
    expect(r.sources.map((s) => s.origin)).toEqual(["search", "citation"]);
    expect(r.queries).toEqual(["q"]);
  });
  it("dedupes, strips tracking params, and flags links the search never returned", () => {
    const s = collectSources(
      [
        { url: "https://neon.com/pricing?utm_source=x#plans", title: "Neon", origin: "search" },
        { url: "https://neon.com/pricing", title: null, origin: "search" },
        { url: "javascript:alert(1)", title: "x", origin: "search" },
      ],
      "See [Neon](https://neon.com/pricing) and [made up](https://example.org/fake).",
      "2026-11-10T00:00:00Z",
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ url: "https://neon.com/pricing", origin: "citation", title: "Neon" });
    expect(s[1]).toMatchObject({ url: "https://example.org/fake", origin: "answer_link" });
    expect(normalizeUrl("ftp://x")).toBeNull();
  });
  it("rewrites gpt-oss citation markers only to real search results", () => {
    const out = rewriteCitationMarkers("Price is $19【0†L1-L4】 and $25【7†L2】.", [{ url: "https://neon.com/pricing", origin: "search" }]);
    expect(out).toBe("Price is $19 [neon.com](https://neon.com/pricing) and $25.");
  });
});

describe("turn reliability", () => {
  it("is idempotent for a retried request id", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: "Answer." }));
    const requestId = randomUUID();
    const first = await turn(db, p, { workspaceId: ws, text: "hello there friend, explain TCP", requestId });
    const again = await turn(db, p, { workspaceId: ws, conversationId: first.conversationId, text: "hello there friend, explain TCP", requestId });
    expect(again.events).toEqual([expect.objectContaining({ type: "done", replayed: true })]);
    expect(listMessages(db, first.conversationId)).toHaveLength(2);
    expect(p.requests).toHaveLength(1);
  });

  it("serialises overlapping turns in one conversation, preserving order", async () => {
    const db = memDb();
    const ws = randomUUID();
    const conv = randomUUID();
    const slow: LlmProvider = {
      name: "fake",
      model: "slow",
      async *stream(req: ModelRequest): AsyncIterable<ProviderEvent> {
        await new Promise((r) => setTimeout(r, req.user === "first" ? 60 : 1));
        yield { type: "done", text: `reply to ${req.user}`, sources: [], searchQueries: [] };
      },
      complete: async () => "",
    };
    await Promise.all([
      turn(db, slow, { workspaceId: ws, conversationId: conv, text: "first" }),
      turn(db, slow, { workspaceId: ws, conversationId: conv, text: "second" }),
    ]);
    const msgs = listMessages(db, conv);
    expect(msgs.map((m) => m.content)).toEqual(["first", "reply to first", "second", "reply to second"]);
    expect(msgs.map((m) => m.turnIndex)).toEqual([0, 0, 1, 1]);
  });

  it("persists a cancelled partial answer without polluting recall", async () => {
    const db = memDb();
    const ws = randomUUID();
    const conv = randomUUID();
    const ctrl = new AbortController();
    const p: LlmProvider = {
      name: "fake",
      model: "m",
      async *stream(_req, signal): AsyncIterable<ProviderEvent> {
        yield { type: "text", delta: "Partial " };
        ctrl.abort();
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
      },
      complete: async () => "",
    };
    const events = await collect(runTurn(deps(db, p), { workspaceId: ws, conversationId: conv, text: "long question", timeZone: TZ, requestId: randomUUID() }, ctrl.signal));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cancelled" });
    const msgs = listMessages(db, conv);
    expect(msgs[1]).toMatchObject({ status: "cancelled", content: "Partial" });
  });

  it("maps provider errors to friendly messages and records them", async () => {
    const db = memDb();
    const p: LlmProvider = {
      name: "fake",
      model: "m",
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ProviderEvent> {
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      },
      complete: async () => "",
    };
    const { events } = await turn(db, p, { workspaceId: randomUUID(), text: "price of notion" });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "model" });
    expect((events.at(-1) as { message: string }).message).toMatch(/API key was rejected/);
  });
});

describe("chat route + config", () => {
  it("streams an SSE setup error when no key is configured", async () => {
    const db = memDb();
    const handler = chatHandler(() => deps(db, null));
    const res = await handler(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "x-workspace-id": randomUUID(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: randomUUID(), text: "hi", timeZone: TZ, requestId: randomUUID() }),
      }),
    );
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain("GEMINI_API_KEY");
  });

  it("validates input", async () => {
    const handler = chatHandler(() => deps(memDb(), new FakeProvider()));
    const bad = (body: unknown, ws: string = randomUUID()) =>
      handler(new Request("http://x", { method: "POST", headers: { "x-workspace-id": ws }, body: JSON.stringify(body) }));
    expect((await bad({ conversationId: randomUUID(), text: "hi", timeZone: "Mars/Base", requestId: randomUUID() })).status).toBe(400);
    expect((await bad({ conversationId: "nope", text: "hi", timeZone: TZ, requestId: randomUUID() })).status).toBe(400);
    expect((await bad({ conversationId: randomUUID(), text: "  ", timeZone: TZ, requestId: randomUUID() })).status).toBe(400);
    expect((await bad({ conversationId: randomUUID(), text: "hi", timeZone: TZ, requestId: randomUUID() }, "not-a-uuid")).status).toBe(400);
  });

  it("reports missing variable names without values", () => {
    expect(providerStatus(getConfig({} as NodeJS.ProcessEnv))).toMatchObject({ provider: "gemini", configured: false, missingVar: "GEMINI_API_KEY", model: "gemini-2.5-flash" });
    expect(providerStatus(getConfig({ LLM_PROVIDER: "groq" } as unknown as NodeJS.ProcessEnv))).toMatchObject({ provider: "groq", missingVar: "GROQ_API_KEY" });
    const s = providerStatus(getConfig({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-secret" } as unknown as NodeJS.ProcessEnv));
    expect(s).toMatchObject({ provider: "openai", configured: true });
    expect(JSON.stringify(s)).not.toContain("sk-secret");
  });
});

describe("Gemini adapter", () => {
  it("offers exactly one googleSearch tool, none for recall, and turns 'required' into an instruction", () => {
    const auto = buildGeminiRequest(REQ, { GEMINI_MODEL: "gemini-2.5-flash" });
    expect(auto.config.tools).toEqual([{ googleSearch: {} }]);
    assertSingleSearchTool(auto.config.tools as object[]);
    expect(auto.contents.at(-1)!.parts!.at(-1)!.text).toContain("<memory_context>");
    expect(auto.contents.at(-1)!.parts!.at(-1)!.text).toContain("<user_message>\nq\n</user_message>");
    expect(buildGeminiRequest({ ...REQ, toolChoice: "none" }, { GEMINI_MODEL: "gemini-2.5-flash" }).config.tools).toBeUndefined();
    const req = buildGeminiRequest({ ...REQ, toolChoice: "required" }, { GEMINI_MODEL: "gemini-2.5-flash" });
    expect(String(req.config.systemInstruction)).toMatch(/MUST run Google Search/);
    expect(req.config.thinkingConfig).toEqual({ thinkingBudget: -1 });
    expect(buildGeminiRequest(REQ, { GEMINI_MODEL: "gemini-3-flash-preview" }).config.thinkingConfig).toBeUndefined();
  });
  it("rejects a second tool", () => {
    expect(() => assertSingleSearchTool([{ googleSearch: {} }, { functionDeclarations: [] }])).toThrow();
    expect(() => assertSingleSearchTool([{ codeExecution: {} }])).toThrow();
  });
  it("merges consecutive same-role turns", () => {
    const r = buildGeminiRequest({ ...REQ, memoryContext: null, history: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "c" }] }, { GEMINI_MODEL: "gemini-2.5-flash" });
    expect(r.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });
  it("attaches citations from grounding supports to the right sentence, using only returned sources", () => {
    const sources = groundingSources([
      { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title: "neon.com" } },
      { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", title: "supabase.com" } },
    ]);
    expect(sources[0]).toMatchObject({ domain: "neon.com", origin: "search" });
    const text = "Neon Launch costs $19/month. Supabase Pro costs $25/month.";
    const out = insertGroundingCitations(
      text,
      [
        { segment: { text: "Supabase Pro costs $25/month." }, groundingChunkIndices: [1] },
        { segment: { text: "Neon Launch costs $19/month." }, groundingChunkIndices: [0, 0, 9] },
        { segment: { text: "not in the answer" }, groundingChunkIndices: [0] },
      ],
      sources,
    );
    expect(out).toBe(
      "Neon Launch costs $19/month. ([neon.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA)) Supabase Pro costs $25/month. ([supabase.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB))",
    );
    const stored = collectSources(sources, out, "2026-11-10T00:00:00Z");
    expect(stored.map((s) => [s.domain, s.origin])).toEqual([["neon.com", "citation"], ["supabase.com", "citation"]]);
  });
});

describe("env file parsing", () => {
  it("parses .env syntax", () => {
    expect(parseDotEnv('# c\r\nGEMINI_API_KEY="abc"\r\nexport X=1 # note\nEMPTY=\nbad line')).toEqual({ GEMINI_API_KEY: "abc", X: "1", EMPTY: "" });
  });
  it("maps invalid-key errors to a clear message", async () => {
    const p: LlmProvider = {
      name: "fake",
      model: "m",
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ProviderEvent> {
        throw Object.assign(new Error('{"error":{"message":"API key not valid. Please pass a valid API key."}}'), { status: 400 });
      },
      complete: async () => "",
    };
    const { events } = await turn(memDb(), p, { workspaceId: randomUUID(), text: "price of notion" });
    expect((events.at(-1) as { message: string }).message).toMatch(/API key was rejected/);
  });
});
