import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/lib/db";
import { RollingSummaryManager } from "../src/lib/agent/summaries";
import { ExecutionBudgetTracker, DEFAULT_TURN_BUDGET } from "../src/lib/agent/budgets";
import { createConversation, insertMessage } from "../src/lib/db/repo";

describe("Agent Orchestration Subsystem", () => {
  describe("RollingSummaryManager", () => {
    it("incrementally summarizes older conversation turns to keep context bounded", () => {
      const db = openDatabase(":memory:");
      const mgr = new RollingSummaryManager();
      mgr.initSchema(db);

      const ws = "ws-summary-1";
      db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run(ws, new Date().toISOString());

      const conv = createConversation(db, ws, "Thread with multiple turns", new Date("2026-11-01T10:00:00Z"));

      const msgs = [];
      for (let i = 1; i <= 8; i++) {
        const m = insertMessage(db, {
          conversationId: conv.id,
          workspaceId: ws,
          role: i % 2 === 1 ? "user" : "assistant",
          content: i % 2 === 1 ? `Question ${i}: tell me about product ${i}` : `Answer ${i}: Product ${i} has key features.`,
          timezone: "Asia/Kolkata",
          createdAt: new Date(`2026-11-01T10:0${i}:00Z`),
        });
        msgs.push(m);
      }

      const summary = mgr.updateRollingSummary(db, conv.id, msgs);
      expect(summary).not.toBeNull();
      expect(summary?.conversationId).toBe(conv.id);
      expect(summary?.summaryText).toContain("Earlier conversation summary");
      expect(summary?.summaryText).toContain("Question 1");

      const readBack = mgr.getSummary(db, conv.id);
      expect(readBack?.summaryText).toBe(summary?.summaryText);
    });
  });

  describe("ExecutionBudgetTracker", () => {
    it("tracks tool rounds, search queries, and token limits", () => {
      const tracker = new ExecutionBudgetTracker({
        ...DEFAULT_TURN_BUDGET,
        maxRounds: 3,
        maxSearchQueries: 5,
        maxExtractions: 2,
      });

      expect(tracker.canRunMoreRounds()).toBe(true);
      expect(tracker.remainingQueries()).toBe(5);
      expect(tracker.remainingExtractions()).toBe(2);

      tracker.recordRound({ promptTokens: 1200, completionTokens: 300 });
      tracker.recordQueries(3);
      tracker.recordExtractions(1);

      expect(tracker.remainingQueries()).toBe(2);
      expect(tracker.remainingExtractions()).toBe(1);
      expect(tracker.promptTokensUsed).toBe(1200);

      tracker.recordRound();
      tracker.recordRound();

      expect(tracker.canRunMoreRounds()).toBe(false);
    });
  });
});

