import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createConversation,
  insertMessage,
  listMemory,
  searchMemory,
  searchMessages,
  upsertMemoryItems,
} from "@/lib/db/repo";
import { heuristicExtract, parseDistilled, parseMarkdownTables } from "@/lib/memory/extract";
import { retrieve } from "@/lib/memory/retrieval";
import { CRM_ANSWER, FakeProvider, memDb, NOW, PG_ANSWER, startMemory, turn, TZ } from "./helpers";

describe("extraction", () => {
  it("parses tables into entities and baseline facts", () => {
    const [t] = parseMarkdownTables(PG_ANSWER);
    expect(t!.headers).toEqual(["Provider", "Entry paid plan", "Price"]);
    const [item] = heuristicExtract("Compare managed Postgres hosting options", PG_ANSWER, true);
    expect(item!.type).toBe("shortlist");
    expect(item!.entities).toEqual(["Neon", "Supabase", "AWS RDS", "Render"]);
    expect(item!.facts).toContainEqual({ entity: "Supabase", attribute: "Price", value: "$25/month" });
  });
  it("captures user constraints in the summary", () => {
    const [item] = heuristicExtract("Shortlist CRMs for a 20-person sales team", CRM_ANSWER, true);
    expect(item!.summary).toMatch(/20-person sales team/);
    expect(item!.entities).toHaveLength(5);
  });
  it("skips small talk", () => {
    expect(heuristicExtract("hi", "Hello! How can I help?", false)).toEqual([]);
  });
  it("validates model-distilled JSON and rejects malformed output", () => {
    const ok = parseDistilled('```json\n{"items":[{"type":"shortlist","title":"CRMs","summary":"Five CRMs","entities":["HubSpot","hubspot"],"facts":[]}]}\n```');
    expect(ok![0]!.entities).toEqual(["HubSpot"]);
    expect(parseDistilled('{"items":[{"type":"hack","title":"x"}]}')).toBeNull();
    expect(parseDistilled("not json")).toBeNull();
  });
  it("falls back to heuristics when the model distillation is malformed", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: PG_ANSWER }));
    p.distillReply = "{broken";
    await turn(db, p, { workspaceId: ws, text: "compare postgres hosts" });
    expect(listMemory(db, ws)[0]!.entities).toContain("Neon");
  });
  it("uses valid model distillation when available", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: PG_ANSWER }));
    p.distillReply = JSON.stringify({ items: [{ type: "comparison", title: "Postgres hosting prices", summary: "Neon vs Supabase", entities: ["Neon", "Supabase"], facts: [{ entity: "Neon", attribute: "Launch", value: "$19/month" }] }] });
    await turn(db, p, { workspaceId: ws, text: "compare postgres hosts" });
    expect(listMemory(db, ws)[0]).toMatchObject({ title: "Postgres hosting prices", type: "comparison" });
  });
});

describe("FTS and upsert", () => {
  it("searches messages and memory lexically, scoped to the workspace", () => {
    const db = memDb();
    const ws = randomUUID();
    const other = randomUUID();
    const c = createConversation(db, ws);
    const c2 = createConversation(db, other);
    insertMessage(db, { conversationId: c.id, workspaceId: ws, role: "user", content: "Managed Postgres hosting with branching", timezone: TZ });
    insertMessage(db, { conversationId: c2.id, workspaceId: other, role: "user", content: "Postgres in another workspace", timezone: TZ });
    expect(searchMessages(db, ws, '"postgres"')).toHaveLength(1);
    expect(searchMessages(db, ws, '"kubernetes"')).toHaveLength(0);
    expect(searchMessages(db, ws, '"branch"')).toHaveLength(1); // porter stemming

    upsertMemoryItems(db, { workspaceId: ws, conversationId: c.id, sourceMessageIds: ["m1"], baselineDate: "2026-11-03" }, [
      { type: "shortlist", title: "Postgres hosts", summary: "Neon, Supabase", entities: ["Neon", "Supabase"], facts: [] },
    ]);
    expect(searchMemory(db, ws, '"supabase"')).toHaveLength(1);
  });

  it("refines a shortlist in place within a conversation but keeps dated snapshots across conversations", () => {
    const db = memDb();
    const ws = randomUUID();
    const c = createConversation(db, ws);
    const base = { workspaceId: ws, conversationId: c.id, baselineDate: "2026-11-03" };
    upsertMemoryItems(db, { ...base, sourceMessageIds: ["a"] }, [{ type: "shortlist", title: "CRMs", summary: "v1", entities: ["HubSpot", "Pipedrive"], facts: [{ entity: "HubSpot", attribute: "price", value: "$90" }] }]);
    upsertMemoryItems(db, { ...base, sourceMessageIds: ["b"] }, [{ type: "shortlist", title: "CRM shortlist v2", summary: "v2", entities: ["HubSpot", "Pipedrive", "Zoho"], facts: [{ entity: "Zoho", attribute: "price", value: "$40" }] }]);
    let items = listMemory(db, ws);
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceMessageIds).toEqual(["a", "b"]);
    expect(items[0]!.facts).toHaveLength(2);

    const c2 = createConversation(db, ws);
    upsertMemoryItems(db, { workspaceId: ws, conversationId: c2.id, baselineDate: "2026-11-10", sourceMessageIds: ["c"] }, [{ type: "shortlist", title: "CRMs", summary: "recheck", entities: ["HubSpot"], facts: [] }]);
    items = listMemory(db, ws);
    expect(items).toHaveLength(2);
  });
});

describe("referent resolution", () => {
  async function twoTopics() {
    const db = memDb();
    const ws = randomUUID();
    await turn(db, new FakeProvider(() => ({ text: CRM_ANSWER })), { workspaceId: ws, text: "Shortlist 5 CRMs for my sales team", at: new Date("2026-11-09T06:00:00Z") });
    await turn(db, new FakeProvider(() => ({ text: PG_ANSWER })), { workspaceId: ws, text: "Compare Postgres hosting providers", at: new Date("2026-11-09T07:00:00Z") });
    return { db, ws };
  }

  it("asks a clarifying question when two recent topics fit equally", async () => {
    const { db, ws } = await twoTopics();
    const p = new FakeProvider(() => ({ text: "Do you mean the CRM shortlist or the Postgres hosts?" }));
    const { events } = await turn(db, p, { workspaceId: ws, text: "Have any of them changed?" });
    const mem = startMemory(events);
    expect(mem.intent).toBe("clarify");
    expect(mem.toolChoice).toBe("none");
    expect(mem.ambiguous.length).toBe(2);
    expect(p.last.system).toMatch(/clarifying question/);
  });

  it("a distinctive word disambiguates", async () => {
    const { db, ws } = await twoTopics();
    const r = retrieve(db, { workspaceId: ws, conversationId: randomUUID(), text: "Has CRM pricing for them changed since?", now: NOW, timeZone: TZ });
    expect(r.ambiguous).toHaveLength(0);
    expect(r.referent?.entities).toContain("HubSpot");
  });

  it("the active thread wins over other topics", async () => {
    const { db, ws } = await twoTopics();
    const p = new FakeProvider(() => ({ text: PG_ANSWER }));
    const { conversationId } = await turn(db, p, { workspaceId: ws, text: "Compare Neon and Supabase free tiers" });
    const r = retrieve(db, { workspaceId: ws, conversationId, text: "have they changed since?", now: NOW, timeZone: TZ });
    expect(r.referent?.conversationId).toBe(conversationId);
    expect(r.intent).toBe("recall_and_verify");
  });

  it("does not hijack unrelated questions that contain 'it'", async () => {
    const { db, ws } = await twoTopics();
    const r = retrieve(db, { workspaceId: ws, conversationId: randomUUID(), text: "Is it going to rain in Paris today?", now: NOW, timeZone: TZ });
    expect(r.intent).toBe("research");
    expect(r.referent).toBeNull();
  });
});
