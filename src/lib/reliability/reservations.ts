import type { DB } from "../db";

export type QuotaResourceType = "groq_tokens" | "tavily_credits";
export type ReservationStatus = "RESERVED" | "COMMITTED" | "RELEASED" | "EXPIRED";

export interface ReservationRecord {
  reservationId: string;
  workspaceId: string;
  provider: string;
  resourceType: QuotaResourceType;
  amount: number;
  actualUsage: number | null;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
}

export class QuotaReservationManager {
  /**
   * Initialize reservation tables in SQLite.
   */
  initSchema(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_reservations (
        reservation_id   TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        provider         TEXT NOT NULL,
        resource_type    TEXT NOT NULL,
        amount           REAL NOT NULL,
        actual_usage     REAL,
        status           TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','COMMITTED','RELEASED','EXPIRED')),
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quota_ws ON quota_reservations(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_quota_exp ON quota_reservations(expires_at);
    `);
  }

  /**
   * Atomically reserve quota for a request if within workspace and provider limits.
   */
  reserve(
    db: DB,
    params: {
      workspaceId: string;
      provider: string;
      resourceType: QuotaResourceType;
      amount: number;
      maxLimit: number;
      ttlMs?: number;
      now?: Date;
    }
  ): { ok: boolean; reservationId?: string; remaining: number } {
    const now = params.now ?? new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? 60_000)).toISOString();
    const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return db.transaction(() => {
      // Clean expired reservations
      db.prepare("UPDATE quota_reservations SET status = 'EXPIRED' WHERE status = 'RESERVED' AND expires_at <= ?").run(now.toISOString());

      // Sum active reservations and committed usage for this workspace & resource type
      const usageRow = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN status = 'COMMITTED' THEN COALESCE(actual_usage, amount) ELSE amount END), 0) as total
        FROM quota_reservations
        WHERE workspace_id = ?
          AND resource_type = ?
          AND status IN ('RESERVED', 'COMMITTED')
      `).get(params.workspaceId, params.resourceType) as { total: number };

      const currentTotal = usageRow.total;
      const remaining = Math.max(0, params.maxLimit - currentTotal);

      if (currentTotal + params.amount > params.maxLimit) {
        return { ok: false, remaining };
      }

      db.prepare(`
        INSERT INTO quota_reservations(reservation_id, workspace_id, provider, resource_type, amount, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?)
      `).run(
        reservationId,
        params.workspaceId,
        params.provider,
        params.resourceType,
        params.amount,
        now.toISOString(),
        expiresAt
      );

      return { ok: true, reservationId, remaining: remaining - params.amount };
    })();
  }

  /**
   * Commit a reservation with actual usage.
   */
  commit(db: DB, reservationId: string, actualUsage?: number): void {
    db.prepare(`
      UPDATE quota_reservations
      SET status = 'COMMITTED',
          actual_usage = ?
      WHERE reservation_id = ? AND status = 'RESERVED'
    `).run(actualUsage ?? null, reservationId);
  }

  /**
   * Release an unused reservation (e.g. if request was cancelled or failed early).
   */
  release(db: DB, reservationId: string): void {
    db.prepare(`
      UPDATE quota_reservations
      SET status = 'RELEASED'
      WHERE reservation_id = ? AND status = 'RESERVED'
    `).run(reservationId);
  }
}

const g = globalThis as unknown as { __minimiQuotaManager?: QuotaReservationManager };
export function getQuotaManager(): QuotaReservationManager {
  g.__minimiQuotaManager ??= new QuotaReservationManager();
  return g.__minimiQuotaManager;
}

