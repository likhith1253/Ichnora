/** Personal memory through the full turn pipeline (fake model, real retrieval + persistence). */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeProvider, memDb, startMemory, turn } from "./helpers";

const MON = new Date("2026-11-09T04:30:00Z");
const WED = new Date("2026-11-11T06:00:00Z");

describe("open loops in conversation", () => {
  it("captures a promise from chat and answers 'what's pending?' from memory without searching", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: "Noted." }));
    const first = await turn(db, p, { workspaceId: ws, text: "I'll send the project proposal to Rahul by Friday.", at: MON });
    expect(first.events.find((e) => e.type === "personal")).toMatchObject({ created: [{ type: "COMMITMENT", dueDate: "2026-11-13", status: "OPEN" }] });

    const q = await turn(db, p, { workspaceId: ws, text: "What commitments do I have?", at: WED });
    expect(startMemory(q.events)).toMatchObject({ intent: "open_loops", toolChoice: "none" });
    expect(p.lastBody.tools).toBeUndefined();
    expect(p.last.memoryContext).toContain("Send the project proposal to Rahul");
    expect(p.last.memoryContext).toContain("due Friday 13 November 2026");
    expect(p.last.memoryContext).toContain(`"I'll send the project proposal to Rahul by Friday."`);
  });

  it("completion in the same message as the question is applied before answering", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: "ok" }));
    await turn(db, p, { workspaceId: ws, text: "I'll send Rahul the report by Friday. I'll also call Meera tomorrow.", at: MON });
    const r = await turn(db, p, { workspaceId: ws, text: "I sent Rahul the report yesterday. What's still pending?", at: WED });
    expect(r.events.find((e) => e.type === "personal")).toMatchObject({ transitions: [{ from: "OPEN", to: "COMPLETED" }] });
    const ctx = p.last.memoryContext!;
    const openBlock = ctx.split("Waiting on others")[0]!;
    expect(openBlock).toContain("Call Meera");
    expect(openBlock).not.toMatch(/\[OPEN\] Send Rahul the report/);
    expect(ctx).toMatch(/Recently closed[\s\S]*\[COMPLETED\] Send Rahul the report/);
  });

  it("filters by person: 'what did I promise Rahul?'", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: "ok" }));
    await turn(db, p, { workspaceId: ws, text: "I'll send the proposal to Rahul by Friday. I'll call Meera tomorrow.", at: MON });
    await turn(db, p, { workspaceId: ws, text: "What did I promise Rahul?", at: MON });
    expect(p.last.memoryContext).toContain("proposal to Rahul");
    expect(p.last.memoryContext).not.toContain("Call Meera");
  });

  it("the assistant's suggestions never become the user's commitments", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: "I'll remind you to email Rahul by Friday. You should send the proposal." }));
    const r = await turn(db, p, { workspaceId: ws, text: "Any tips for writing proposals?", at: MON });
    expect(r.events.find((e) => e.type === "personal")).toBeUndefined();
    await turn(db, p, { workspaceId: ws, text: "What's pending?", at: MON });
    expect(p.last.memoryContext).toContain("Commitments & obligations: none recorded.");
  });
});

describe("decision history in conversation", () => {
  it("reconstructs how thinking changed, without searching", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: "ok" }));
    await turn(db, p, { workspaceId: ws, text: "We will use MongoDB for the database.", at: new Date("2026-11-03T05:00:00Z") });
    await turn(db, p, { workspaceId: ws, text: "After comparing the databases, PostgreSQL seems better because we need joins.", at: new Date("2026-11-05T05:00:00Z") });
    await turn(db, p, { workspaceId: ws, text: "We have finalized PostgreSQL.", at: new Date("2026-11-07T05:00:00Z") });
    const r = await turn(db, p, { workspaceId: ws, text: "How has my thinking about the database changed?", at: new Date("2026-11-10T05:00:00Z") });
    expect(startMemory(r.events)).toMatchObject({ intent: "decision_history", toolChoice: "none" });
    const ctx = p.last.memoryContext!;
    const i1 = ctx.indexOf("Tuesday 3 November 2026");
    const i2 = ctx.indexOf("Thursday 5 November 2026");
    const i3 = ctx.indexOf("Saturday 7 November 2026");
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(ctx).toContain("stated reason: we need joins");
    expect(ctx).toContain("later superseded");
  });

  it("says so when no decision is recorded", async () => {
    const db = memDb();
    const p = new FakeProvider(() => ({ text: "No decision recorded." }));
    const r = await turn(db, p, { workspaceId: randomUUID(), text: "Why did we choose Kafka?" });
    expect(startMemory(r.events).intent).toBe("decision_history");
    expect(p.last.memoryContext).toContain("NO recorded decisions match this question.");
  });
});
