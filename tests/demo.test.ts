import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getConfig, type AppConfig } from "@/lib/env";
import { createSession, findSession } from "@/lib/auth/sessions";
import { getWorkspace } from "@/lib/auth/accounts";
import { createConversation, listConversations } from "@/lib/db/repo";
import { budgetStatus, consumeTurn, addCredits } from "@/lib/demo/budget";
import { clientIp, allowDemoCreation, recordDemoCreation, pruneDemoEvents } from "@/lib/demo/rate";
import { seedDemoWorkspace } from "@/lib/demo/seed";
import {
  cleanupDemoData,
  createDemoWorkspace,
  deleteExpiredDemos,
  getCachedDemoAnswer,
  putCachedDemoAnswer,
  resetDemoWorkspace,
  type DemoAnswer,
} from "@/lib/demo/store";
import { DEMO_PROMPTS, promptKey } from "@/lib/demo/prompts";
import { openLoops, listPersonalMemories } from "@/lib/personal/queries";
import { exportWorkspace } from "@/lib/server/export";
import { memDb } from "./helpers";

const CFG: AppConfig = getConfig({} as NodeJS.ProcessEnv);
const NOW = new Date("2026-11-10T10:00:00Z");

/** A stable, comparable dump of everything a demo workspace holds. */
function snapshot(db: ReturnType<typeof memDb>, workspaceId: string) {
  const e = exportWorkspace(db, workspaceId);
  return {
    conversations: (e.conversations as Array<{ title: string }>).map((c) => c.title),
    messages: (e.messages as Array<{ content: string }>).map((m) => m.content),
    memories: (e.memories as Array<{ type: string }>).map((m) => m.type),
  };
}

/* ---------------------------------------------------------------- seeding */

describe("demo seeding", () => {
  it("refuses to seed anything that is not a demo workspace", () => {
    const db = memDb();
    const local = randomUUID();
    db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run(local, NOW.toISOString());
    expect(() => seedDemoWorkspace({ db, workspaceId: local, now: NOW })).toThrow(/demo/i);
    expect(listConversations(db, local)).toHaveLength(0);
  });

  it("is deterministic: two fresh demos hold identical data", () => {
    const db = memDb();
    const a = createDemoWorkspace(db, CFG, NOW);
    const b = createDemoWorkspace(db, CFG, NOW);
    expect(snapshot(db, a.workspaceId)).toEqual(snapshot(db, b.workspaceId));
  });

  it("never puts demo data in a non-demo workspace", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const local = randomUUID();
    db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run(local, NOW.toISOString());
    expect(getWorkspace(db, demo.workspaceId)?.kind).toBe("demo");
    expect(listConversations(db, demo.workspaceId).length).toBeGreaterThan(0);
    expect(listConversations(db, local)).toHaveLength(0);
    expect(listPersonalMemories(db, local)).toHaveLength(0);
  });

  it("seeds the dated snapshot, the computed change report and the decision history", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const contents = (exportWorkspace(db, demo.workspaceId).messages as Array<{ content: string }>).map((m) => m.content).join("\n");
    expect(contents).toContain("What is the latest Node.js LTS version?");
    expect(contents).toContain("Is the CRM shortlist from 9 November still correct today?");
    expect(contents).toContain("We will use MongoDB for the database.");
    expect(contents).toContain("We will use PostgreSQL for the database.");

    const reports = db
      .prepare("SELECT COUNT(*) AS n FROM change_reports cr JOIN messages m ON m.id = cr.message_id WHERE m.workspace_id = ?")
      .get(demo.workspaceId) as { n: number };
    expect(reports.n).toBeGreaterThan(0);

    const types = listPersonalMemories(db, demo.workspaceId).map((v) => v.memory.type);
    expect(types).toContain("DECISION");
    expect(types).toContain("PREFERENCE");

    const loops = openLoops(db, demo.workspaceId, "2026-11-10");
    expect(loops.open.length + loops.waiting.length + loops.considering.length).toBeGreaterThan(0);
  });

  it("exposes five guided prompts that showcase the seeded features", () => {
    expect(DEMO_PROMPTS.length).toBeGreaterThanOrEqual(5);
    const texts = DEMO_PROMPTS.map((p) => p.text.toLowerCase()).join("\n");
    expect(texts).toContain("3 november");
    expect(texts).toContain("still correct");
    expect(texts).toContain("changed");
  });
});

/* ---------------------------------------------------------------- budgets */

describe("demo budgets", () => {
  it("enforces the per-demo model-turn allowance", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const cfg = { ...CFG, DEMO_MAX_TURNS: 2 };
    expect(consumeTurn(db, demo.workspaceId, cfg, NOW).ok).toBe(true);
    expect(consumeTurn(db, demo.workspaceId, cfg, NOW).ok).toBe(true);
    const third = consumeTurn(db, demo.workspaceId, cfg, NOW);
    expect(third.ok).toBe(false);
    expect(third.budget.exhausted).toBe(true);
    expect(budgetStatus(db, demo.workspaceId, cfg, NOW).turnsRemaining).toBe(0);
  });

  it("enforces the per-demo Tavily-credit allowance", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const cfg = { ...CFG, DEMO_MAX_CREDITS: 3 };
    addCredits(db, demo.workspaceId, 3, NOW);
    const spent = consumeTurn(db, demo.workspaceId, cfg, NOW);
    expect(spent.ok).toBe(false);
    expect(spent.budget.creditsRemaining).toBe(0);
    expect(spent.budget.exhausted).toBe(true);
  });

  it("charges nothing once a demo is exhausted", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const cfg = { ...CFG, DEMO_MAX_TURNS: 1 };
    consumeTurn(db, demo.workspaceId, cfg, NOW);
    consumeTurn(db, demo.workspaceId, cfg, NOW);
    expect(budgetStatus(db, demo.workspaceId, cfg, NOW).turnsUsed).toBe(1);
  });
});

/* ------------------------------------------------------------ expiry / cleanup */

describe("demo expiry and cleanup", () => {
  it("deletes expired demos together with their guest user and session", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const { token } = createSession(db, { userId: demo.userId, kind: "demo", now: NOW });
    expect(findSession(db, token, NOW)).not.toBeNull();

    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(deleteExpiredDemos(db, later)).toBe(1);
    expect(getWorkspace(db, demo.workspaceId)).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(demo.userId) as { n: number }).n).toBe(0);
    expect(findSession(db, token, later)).toBeNull();
  });

  it("keeps unexpired demos and real account data untouched", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    expect(deleteExpiredDemos(db, new Date(NOW.getTime() + 3_600_000))).toBe(0);
    expect(getWorkspace(db, demo.workspaceId)).not.toBeNull();
  });

  it("cleanupDemoData prunes expired sessions and cached answers in one pass", () => {
    const db = memDb();
    const demo = createDemoWorkspace(db, CFG, NOW);
    const { token } = createSession(db, { userId: demo.userId, kind: "demo", now: NOW, ttlMs: 1000 });
    putCachedDemoAnswer(db, DEMO_PROMPTS[0]!.text, { text: "answer", sources: [] }, CFG, NOW);
    // Past both the demo TTL (hours) and the answer-cache TTL (minutes).
    const later = new Date(NOW.getTime() + (CFG.DEMO_TTL_HOURS + 1) * 3_600_000);
    const res = cleanupDemoData(db, CFG, later);
    expect(res.demos).toBeGreaterThanOrEqual(1);
    expect(findSession(db, token, later)).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM demo_answer_cache").get() as { n: number }).n).toBe(0);
  });
});

/* ----------------------------------------------------------------- reset */

describe("reset demo", () => {
  it("replaces the demo workspace with a freshly seeded one", () => {
    const db = memDb();
    const first = createDemoWorkspace(db, CFG, NOW);
    createConversation(db, first.workspaceId, "extra scratch chat");
    const second = resetDemoWorkspace(db, first.userId, CFG, NOW);
    expect(second).not.toBeNull();
    expect(second!.workspaceId).not.toBe(first.workspaceId);
    expect(getWorkspace(db, first.workspaceId)).toBeNull();
    expect(listConversations(db, second!.workspaceId).length).toBeGreaterThan(0);
    expect(listConversations(db, second!.workspaceId).map((c) => c.title)).not.toContain("extra scratch chat");
  });
});

/* -------------------------------------------------------- answer cache */

describe("guided-prompt answer cache", () => {
  const answer: DemoAnswer = { text: "cached answer", sources: [], searched: false };

  it("serves a cached answer until its TTL, keyed case- and space-insensitively", () => {
    const db = memDb();
    const prompt = DEMO_PROMPTS[0]!.text;
    putCachedDemoAnswer(db, prompt, answer, CFG, NOW);
    expect(getCachedDemoAnswer(db, prompt, new Date(NOW.getTime() + 60_000))?.text).toBe("cached answer");
    expect(getCachedDemoAnswer(db, `  ${prompt.toUpperCase()}  `, new Date(NOW.getTime() + 60_000))?.text).toBe("cached answer");
    expect(promptKey("  A  b ")).toBe("a b");
    expect(getCachedDemoAnswer(db, prompt, new Date(NOW.getTime() + (CFG.DEMO_CACHE_TTL_MINUTES + 1) * 60_000))).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM demo_answer_cache").get() as { n: number }).n).toBe(0);
  });

  it("returns null for an unknown prompt", () => {
    const db = memDb();
    expect(getCachedDemoAnswer(db, "never asked", NOW)).toBeNull();
  });
});

/* ------------------------------------------------------------ rate limiting */

describe("demo creation rate limit", () => {
  it("limits creations per IP and rolls over with the window", () => {
    const db = memDb();
    const cfg = { ...CFG, DEMO_RATE_LIMIT_MAX: 2, DEMO_RATE_LIMIT_WINDOW_MINUTES: 60 };
    expect(allowDemoCreation(db, "1.2.3.4", cfg, NOW)).toBe(true);
    recordDemoCreation(db, "1.2.3.4", NOW);
    recordDemoCreation(db, "1.2.3.4", NOW);
    expect(allowDemoCreation(db, "1.2.3.4", cfg, NOW)).toBe(false);
    expect(allowDemoCreation(db, "5.6.7.8", cfg, NOW)).toBe(true); // different IP is unaffected
    expect(allowDemoCreation(db, "1.2.3.4", cfg, new Date(NOW.getTime() + 61 * 60_000))).toBe(true);
  });

  it("prunes events older than the window", () => {
    const db = memDb();
    recordDemoCreation(db, "1.2.3.4", NOW);
    const before = new Date(NOW.getTime() + 60_000).toISOString();
    expect(pruneDemoEvents(db, before)).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM demo_ip_events").get() as { n: number }).n).toBe(0);
  });

  it("reads the client IP from proxy headers", () => {
    // Forwarding headers are client-controlled: ignored unless TRUST_PROXY.
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }))).toBe("direct");
    // Behind a trusted proxy, the right-most hop (appended by the proxy) is used.
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }), true)).toBe("10.0.0.1");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "8.8.8.8" } }), true)).toBe("8.8.8.8");
    expect(clientIp(new Request("http://x"))).toBe("direct");
  });
});
