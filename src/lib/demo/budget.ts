import type { DB } from "../db";
import type { AppConfig } from "../env";

/**
 * Per-demo budgets. A demo session can spend only a small, fixed slice of the
 * owner's free Groq and Tavily quotas. Cached (seeded or previously computed)
 * answers do not consume the model budget, so recall and memory keep working
 * even once the demo's live allowance is spent.
 */

export interface DemoBudget {
  workspaceId: string;
  turnsUsed: number;
  turnsMax: number;
  creditsUsed: number;
  creditsMax: number;
  turnsRemaining: number;
  creditsRemaining: number;
  exhausted: boolean;
}

interface Row {
  workspace_id: string;
  turns_used: number;
  credits_used: number;
}

export function ensureBudget(db: DB, workspaceId: string, now = new Date()): void {
  const ts = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO demo_budgets(workspace_id, turns_used, credits_used, created_at, updated_at) VALUES (?, 0, 0, ?, ?)").run(
    workspaceId, ts, ts,
  );
}

export function budgetStatus(db: DB, workspaceId: string, cfg: AppConfig, now = new Date()): DemoBudget {
  ensureBudget(db, workspaceId, now);
  const row = db.prepare("SELECT workspace_id, turns_used, credits_used FROM demo_budgets WHERE workspace_id = ?").get(workspaceId) as Row;
  const turnsMax = cfg.DEMO_MAX_TURNS;
  const creditsMax = cfg.DEMO_MAX_CREDITS;
  const turnsRemaining = Math.max(0, turnsMax - row.turns_used);
  const creditsRemaining = Math.max(0, creditsMax - row.credits_used);
  return {
    workspaceId,
    turnsUsed: row.turns_used,
    turnsMax,
    creditsUsed: row.credits_used,
    creditsMax,
    turnsRemaining,
    creditsRemaining,
    exhausted: turnsRemaining <= 0 || creditsRemaining <= 0,
  };
}

/** Reserve one model turn. Returns false (and charges nothing) when spent. */
export function consumeTurn(db: DB, workspaceId: string, cfg: AppConfig, now = new Date()): { ok: boolean; budget: DemoBudget } {
  ensureBudget(db, workspaceId, now);
  const before = budgetStatus(db, workspaceId, cfg, now);
  if (before.turnsRemaining <= 0 || before.creditsRemaining <= 0) return { ok: false, budget: before };
  db.prepare("UPDATE demo_budgets SET turns_used = turns_used + 1, updated_at = ? WHERE workspace_id = ?").run(now.toISOString(), workspaceId);
  return { ok: true, budget: budgetStatus(db, workspaceId, cfg, now) };
}

export function addCredits(db: DB, workspaceId: string, credits: number, now = new Date()): void {
  if (credits <= 0) return;
  ensureBudget(db, workspaceId, now);
  db.prepare("UPDATE demo_budgets SET credits_used = credits_used + ?, updated_at = ? WHERE workspace_id = ?").run(credits, now.toISOString(), workspaceId);
}
