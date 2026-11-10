import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deleteConversation, listMemory } from "@/lib/db/repo";
import { listPersonalMemories } from "@/lib/personal/queries";
import { deleteWorkspace, exportWorkspace } from "@/lib/server/export";
import { redact } from "@/lib/server/log";
import { CRM_ANSWER, FakeProvider, memDb, turn } from "./helpers";

describe("deletion policy", () => {
  it("deleting a conversation deletes everything derived from it (memories, research, observations)", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: CRM_ANSWER, sources: [{ url: "https://www.hubspot.com/pricing/sales", title: "h", origin: "search" }] }));
    const a = await turn(db, p, { workspaceId: ws, text: "I'll send Rahul the CRM shortlist by Friday. Shortlist 5 CRMs for my team." });
    const b = await turn(db, p, { workspaceId: ws, text: "We will use MongoDB for the database." });
    expect(listPersonalMemories(db, ws)).toHaveLength(2);
    expect(listMemory(db, ws).length).toBeGreaterThan(0);
    deleteConversation(db, ws, a.conversationId);
    expect(listPersonalMemories(db, ws).map((v) => v.memory.type)).toEqual(["DECISION"]);
    expect(listMemory(db, ws).every((m) => m.conversationId !== a.conversationId)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM observations o JOIN messages m ON m.id = o.message_id WHERE m.conversation_id = ?").get(a.conversationId) as { n: number }).n).toBe(0);
    expect(b.conversationId).toBeTruthy();
  });

  it("'forget everything' removes the whole workspace and nothing else", async () => {
    const db = memDb();
    const ws = randomUUID();
    const other = randomUUID();
    const p = new FakeProvider(() => ({ text: "ok" }));
    await turn(db, p, { workspaceId: ws, text: "I prefer dark mode." });
    await turn(db, p, { workspaceId: other, text: "I prefer light mode." });
    deleteWorkspace(db, ws);
    expect(listPersonalMemories(db, ws)).toHaveLength(0);
    expect(listPersonalMemories(db, other)).toHaveLength(1);
  });
});

describe("export", () => {
  it("includes messages, memories with provenance, and research", async () => {
    const db = memDb();
    const ws = randomUUID();
    await turn(db, new FakeProvider(() => ({ text: "ok" })), { workspaceId: ws, text: "I'll call Meera tomorrow." });
    const data = exportWorkspace(db, ws) as { messages: unknown[]; memories: Array<{ quote: string }>; memoryEvents: unknown[] };
    expect(data.messages).toHaveLength(2);
    expect(data.memories[0]!.quote).toBe("I'll call Meera tomorrow.");
    expect(data.memoryEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toMatch(/GROQ_API_KEY|TAVILY_API_KEY/);
  });
});

describe("log redaction", () => {
  it("scrubs keys and bearer tokens", () => {
    const s = redact('401 for key gsk_abcdefghijklmnopqrstuvwx with header Authorization: Bearer tvly-abcdefghijklmnop1234 {"api_key":"sk-1234567890abcdefghij"}');
    expect(s).not.toMatch(/gsk_abc|tvly-abc|sk-1234/);
    expect(s).toContain("[redacted]");
  });
});
