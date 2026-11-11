import { randomUUID } from "node:crypto";
import type { DB } from "../db";
import { getConfig, type AppConfig } from "../env";
import { createGuestUser } from "../auth/accounts";
import { deleteExpiredSessions } from "../auth/sessions";
import { ensureBudget } from "./budget";
import { pruneDemoEvents } from "./rate";
import { promptKey } from "./prompts";
import { seedDemoWorkspace } from "./seed";

/**
 * Demo workspace lifecycle. A demo is a throwaway account that owns exactly one
 * `kind = 'demo'` workspace; it is seeded deterministically, expires, and is
 * cleaned up without ever touching real accounts.
 */

export interface DemoWorkspace {
  workspaceId: string;
  userId: string;
  expiresAt: string;
}

function insertDemoWorkspace(db: DB, userId: string, cfg: AppConfig, now: Date): DemoWorkspace {
  const workspaceId = randomUUID();
  const expiresAt = new Date(now.getTime() + cfg.DEMO_TTL_HOURS * 3_600_000).toISOString();
  db.prepare("INSERT INTO workspaces(id, created_at, owner_user_id, kind, expires_at) VALUES (?, ?, ?, 'demo', ?)").run(
    workspaceId,
    now.toISOString(),
    userId,
    expiresAt,
  );
  ensureBudget(db, workspaceId, now);
  seedDemoWorkspace({ db, workspaceId, now, timeZone: cfg.DEFAULT_TIMEZONE });
  return { workspaceId, userId, expiresAt };
}

/** Create a brand new, seeded, expiring demo workspace owned by a guest user. */
export function createDemoWorkspace(db: DB, cfg: AppConfig = getConfig(), now = new Date()): DemoWorkspace {
  // Guest user + workspace + seed in ONE transaction: a failed seed leaves nothing behind.
  return db.transaction(() => insertDemoWorkspace(db, createGuestUser(db, now), cfg, now))();
}

/** Replace an existing demo workspace with a freshly seeded one (same guest). */
export function resetDemoWorkspace(db: DB, userId: string, cfg: AppConfig = getConfig(), now = new Date()): DemoWorkspace | null {
  const existing = db.prepare("SELECT id FROM workspaces WHERE owner_user_id = ? AND kind = 'demo'").all(userId) as Array<{ id: string }>;
  return db.transaction(() => {
    for (const r of existing) db.prepare("DELETE FROM workspaces WHERE id = ?").run(r.id);
    return insertDemoWorkspace(db, userId, cfg, now);
  })();
}

/** Delete demo workspaces past their expiry and any guest left with nothing. */
export function deleteExpiredDemos(db: DB, now = new Date()): number {
  const ts = now.toISOString();
  const removed = db.prepare("DELETE FROM workspaces WHERE kind = 'demo' AND expires_at IS NOT NULL AND expires_at <= ?").run(ts).changes;
  // A demo session whose workspace is gone can no longer resolve: drop it.
  db.prepare(
    "DELETE FROM sessions WHERE kind = 'demo' AND user_id IN (SELECT id FROM users WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = users.id AND w.kind = 'demo'))",
  ).run();
  db.prepare(
    "DELETE FROM users WHERE name = 'Try demo' AND NOT EXISTS (SELECT 1 FROM oauth_accounts o WHERE o.user_id = users.id) AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = users.id) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = users.id)",
  ).run();
  return removed;
}

export interface CleanupResult {
  demos: number;
}

/** One pass of housekeeping: expired demos, sessions, cached answers, IP events. */
export function cleanupDemoData(db: DB, cfg: AppConfig = getConfig(), now = new Date()): CleanupResult {
  const demos = deleteExpiredDemos(db, now);
  deleteExpiredSessions(db, now);
  db.prepare("DELETE FROM demo_answer_cache WHERE expires_at <= ?").run(now.toISOString());
  pruneDemoEvents(db, new Date(now.getTime() - cfg.DEMO_RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString());
  return { demos };
}

const CLEANUP_INTERVAL_MS = 10 * 60_000;
const g = globalThis as unknown as { __minimiCleanupAt?: number };

/** Run housekeeping at most once every ten minutes (startup + periodic). */
export function maybeCleanupDemos(db: DB, cfg: AppConfig = getConfig(), now = new Date()): void {
  if (g.__minimiCleanupAt && now.getTime() - g.__minimiCleanupAt < CLEANUP_INTERVAL_MS) return;
  g.__minimiCleanupAt = now.getTime();
  try {
    cleanupDemoData(db, cfg, now);
  } catch {
    /* housekeeping must never break a request */
  }
}

/* ------------------------------------------------------- cached answers */

export interface DemoAnswer {
  text: string;
  sources: Array<{ url: string; title?: string | null; origin: "search" | "citation"; snippet?: string | null; publishedDate?: string | null; query?: string | null; retrievedAt?: string; official?: boolean; evidenceLevel?: "snippet" | "full_page"; sourceNo?: number }>;
  searched?: boolean;
  searchQueries?: string[];
  model?: string;
}

/** A previously computed answer for the same demo prompt, if still fresh. */
export function getCachedDemoAnswer(db: DB, text: string, now = new Date()): DemoAnswer | null {
  const key = promptKey(text);
  const row = db.prepare("SELECT payload, expires_at FROM demo_answer_cache WHERE key = ?").get(key) as { payload: string; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare("DELETE FROM demo_answer_cache WHERE key = ?").run(key);
    return null;
  }
  try {
    return JSON.parse(row.payload) as DemoAnswer;
  } catch {
    return null;
  }
}

export function putCachedDemoAnswer(db: DB, text: string, answer: DemoAnswer, cfg: AppConfig = getConfig(), now = new Date()): void {
  const key = promptKey(text);
  const expiresAt = new Date(now.getTime() + cfg.DEMO_CACHE_TTL_MINUTES * 60_000).toISOString();
  db.prepare(
    "INSERT INTO demo_answer_cache(key, payload, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at, expires_at = excluded.expires_at",
  ).run(key, JSON.stringify(answer), now.toISOString(), expiresAt);
}
