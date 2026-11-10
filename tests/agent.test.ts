import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listMemory, listMessages } from "@/lib/db/repo";
import type { LlmProvider, ProviderEvent } from "@/lib/agent/provider";
import { runTurn } from "@/lib/agent/run";
import type { ModelRequest } from "@/lib/agent/prompt";
import { getConfig, parseDotEnv, providerStatus } from "@/lib/env";
import { chatHandler } from "@/lib/server/chat-handler";
import { collect, deps, FakeProvider, memDb, PG_ANSWER, turn, TZ } from "./helpers";


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
    expect(body).toContain("GROQ_API_KEY");
  });

  it("validates input", async () => {
    const handler = chatHandler(() => deps(memDb(), new FakeProvider()));
    const bad = (body: unknown, ws: string = randomUUID()) =>
      handler(new Request("http://x", { method: "POST", headers: { "x-workspace-id": ws }, body: JSON.stringify(body) }));
    expect((await bad({ conversationId: "nope", text: "hi", timeZone: TZ, requestId: randomUUID() })).status).toBe(400);
    expect((await bad({ conversationId: randomUUID(), text: "  ", timeZone: TZ, requestId: randomUUID() })).status).toBe(400);
    expect((await bad({ conversationId: randomUUID(), text: "hi", timeZone: TZ, requestId: randomUUID() }, "not-a-uuid")).status).toBe(400);
  });

  it("reports missing variable names without values", () => {
    expect(providerStatus(getConfig({} as NodeJS.ProcessEnv))).toMatchObject({
      provider: "groq",
      model: "openai/gpt-oss-120b",
      configured: false,
      searchConfigured: false,
      missingVar: "GROQ_API_KEY",
      missingVars: ["GROQ_API_KEY", "TAVILY_API_KEY"],
    });
    const s = providerStatus(getConfig({ GROQ_API_KEY: "gsk-secret" } as unknown as NodeJS.ProcessEnv));
    expect(s).toMatchObject({ configured: true, searchConfigured: false, missingVars: ["TAVILY_API_KEY"] });
    expect(JSON.stringify(s)).not.toContain("gsk-secret");
  });
});

describe("env file parsing", () => {
  it("parses .env syntax", () => {
    expect(parseDotEnv('# c\r\nGROQ_API_KEY="abc"\r\nexport X=1 # note\nEMPTY=\nbad line')).toEqual({ GROQ_API_KEY: "abc", X: "1", EMPTY: "" });
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

describe("search refusal fallback", () => {
  it("records an unverified answer when the provider ran without search", async () => {
    const db = memDb();
    const p: LlmProvider = {
      name: "fake",
      model: "m",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "done", text: "⚠️ Live web search is unavailable right now. Notion Plus was about $10/month as of my knowledge.", sources: [], searchQueries: [], searchUnavailable: true };
      },
      complete: async () => "",
    };
    const { events } = await turn(db, p, { workspaceId: randomUUID(), text: "price of notion plus" });
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.message.metadata).toMatchObject({ searched: false, searchUnavailable: true });
  });
  it("never stores unverified values as a clean baseline", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p: LlmProvider = {
      name: "fake",
      model: "m",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "done", text: PG_ANSWER, sources: [], searchQueries: [], searchUnavailable: true };
      },
      complete: async () => "",
    };
    await turn(db, p, { workspaceId: ws, text: "compare postgres hosts" });
    const [m] = listMemory(db, ws);
    expect(m!.summary).toMatch(/^Unverified/);
    expect(m!.facts.every((f) => f.value.endsWith("(unverified)"))).toBe(true);
  });
});

describe("timezone fallback", () => {
  it("uses the default timezone (Asia/Kolkata) when the client sends none or an invalid one", async () => {
    const db = memDb();
    const handler = chatHandler(() => deps(db, new FakeProvider()));
    const conv = randomUUID();
    const res = await handler(
      new Request("http://x", {
        method: "POST",
        headers: { "x-workspace-id": randomUUID() },
        body: JSON.stringify({ conversationId: conv, text: "hello there", timeZone: "Mars/Base", requestId: randomUUID() }),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(listMessages(db, conv)[0]!.timezone).toBe("Asia/Kolkata");
  });
});
