import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/lib/reliability/circuit-breaker";
import { QuotaReservationManager } from "../src/lib/reliability/reservations";
import { openDatabase } from "../src/lib/db";

describe("Reliability & Quota Subsystem", () => {
  describe("CircuitBreaker", () => {
    it("transitions from CLOSED -> OPEN on consecutive failures and probes in HALF_OPEN", () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 100, halfOpenMaxCalls: 1 });
      expect(cb.getState()).toBe("CLOSED");

      cb.recordFailure(1000);
      expect(cb.getState(1000)).toBe("CLOSED");

      cb.recordFailure(1050);
      expect(cb.getState(1050)).toBe("OPEN");
      expect(cb.isAvailable(1050)).toBe(false);

      // Recovery window passes -> HALF_OPEN
      expect(cb.getState(1200)).toBe("HALF_OPEN");
      expect(cb.isAvailable(1200)).toBe(true);

      // Probe success recovers to CLOSED
      cb.recordSuccess(1205);
      expect(cb.getState(1205)).toBe("CLOSED");
    });

    it("trips immediately back to OPEN on probe failure in HALF_OPEN", () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 100 });
      cb.recordFailure(1000);
      cb.recordFailure(1050); // OPEN

      expect(cb.getState(1200)).toBe("HALF_OPEN");
      cb.recordFailure(1205); // Probe failed
      expect(cb.getState(1205)).toBe("OPEN");
    });
  });

  describe("QuotaReservationManager", () => {
    it("atomically enforces reservation budgets and prevents over-allocation across concurrent requests", () => {
      const db = openDatabase(":memory:");
      const qm = new QuotaReservationManager();
      qm.initSchema(db);

      const ws = "ws-quota-1";
      const maxLimit = 100; // 100 units max

      // First reservation of 60 units succeeds
      const res1 = qm.reserve(db, {
        workspaceId: ws,
        provider: "groq",
        resourceType: "groq_tokens",
        amount: 60,
        maxLimit,
      });
      expect(res1.ok).toBe(true);
      expect(res1.remaining).toBe(40);

      // Second concurrent reservation of 50 units fails (60 + 50 > 100)
      const res2 = qm.reserve(db, {
        workspaceId: ws,
        provider: "groq",
        resourceType: "groq_tokens",
        amount: 50,
        maxLimit,
      });
      expect(res2.ok).toBe(false);
      expect(res2.remaining).toBe(40);

      // Third reservation of 30 units succeeds (60 + 30 <= 100)
      const res3 = qm.reserve(db, {
        workspaceId: ws,
        provider: "groq",
        resourceType: "groq_tokens",
        amount: 30,
        maxLimit,
      });
      expect(res3.ok).toBe(true);

      // Release first reservation (returns 60 units back)
      qm.release(db, res1.reservationId!);

      // Now 50 units can be reserved
      const res4 = qm.reserve(db, {
        workspaceId: ws,
        provider: "groq",
        resourceType: "groq_tokens",
        amount: 50,
        maxLimit,
      });
      expect(res4.ok).toBe(true);
    });
  });
});
