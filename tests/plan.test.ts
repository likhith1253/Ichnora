import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planRecheckQueries } from "@/lib/agent/plan";
import { retrieve } from "@/lib/memory/retrieval";
import { CRM_ANSWER, FakeProvider, memDb, NOW, turn, TZ } from "./helpers";

describe("re-check planning", () => {
  async function crmWorkspace() {
    const db = memDb();
    const ws = randomUUID();
    await turn(db, new FakeProvider(() => ({ text: CRM_ANSWER })), { workspaceId: ws, text: "Shortlist 5 CRMs for a 20-person sales team with pricing", at: new Date("2026-11-09T06:00:00Z") });
    return { db, ws };
  }
  it("plans one query per baseline entity, covering pricing and releases when asked", async () => {
    const { db, ws } = await crmWorkspace();
    const r = retrieve(db, { workspaceId: ws, conversationId: randomUUID(), text: "Has any of them changed pricing or shipped something big since?", now: NOW, timeZone: TZ });
    const q = planRecheckQueries(r, "Has any of them changed pricing or shipped something big since?", "2026-11-10");
    expect(q).toHaveLength(5);
    expect(q[0]).toBe("HubSpot pricing plans and latest product announcements 2026");
    expect(q.join(" ")).toContain("Freshsales");
  });
  it("focuses on pricing when only pricing is asked", async () => {
    const { db, ws } = await crmWorkspace();
    const r = retrieve(db, { workspaceId: ws, conversationId: randomUUID(), text: "Has their pricing changed since?", now: NOW, timeZone: TZ });
    expect(planRecheckQueries(r, "Has their pricing changed since?", "2026-11-10")[0]).toBe("HubSpot pricing plans 2026");
  });
  it("plans nothing for normal research or recall", async () => {
    const { db, ws } = await crmWorkspace();
    for (const text of ["What is the price of Notion Plus?", "What did I ask you on Monday?"]) {
      const r = retrieve(db, { workspaceId: ws, conversationId: randomUUID(), text, now: NOW, timeZone: TZ });
      expect(planRecheckQueries(r, text, "2026-11-10")).toEqual([]);
    }
  });
});
