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
import { runTurn } from "@/lib/agent/run";
import type { ModelRequest } from "@/lib/agent/prompt";
import { getConfig, providerStatus } from "@/lib/env";
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
    expect((events.at(-1) as { message: string }).message).toMatch(/401/);
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
    expect(body).toContain("GROQ_API_KEY");
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
    expect(providerStatus(getConfig({} as NodeJS.ProcessEnv))).toMatchObject({ provider: "groq", configured: false, missingVar: "GROQ_API_KEY", model: "openai/gpt-oss-120b" });
    const s = providerStatus(getConfig({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-secret" } as unknown as NodeJS.ProcessEnv));
    expect(s).toMatchObject({ provider: "openai", configured: true });
    expect(JSON.stringify(s)).not.toContain("sk-secret");
  });
});
