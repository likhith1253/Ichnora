import type { DB } from "../db";
import { hashToken, newId, newToken } from "./tokens";

/**
 * Server-side sessions. The browser holds an opaque token in an httpOnly
 * cookie; the database holds only its SHA-256 hash. Sessions expire, can be
 * rotated (new token, old row deleted) and revoked on sign-out.
 */

export interface Session {
  id: string;
  userId: string;
  kind: "user" | "demo";
  createdAt: string;
  expiresAt: string;
}

interface Row {
  id: string;
  user_id: string;
  kind: "user" | "demo";
  created_at: string;
  expires_at: string;
}

const toSession = (r: Row): Session => ({ id: r.id, userId: r.user_id, kind: r.kind, createdAt: r.created_at, expiresAt: r.expires_at });

export const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface CreateSessionInput {
  userId: string;
  kind?: "user" | "demo";
  userAgent?: string | null;
  ttlMs?: number;
  now?: Date;
}

export function createSession(db: DB, input: CreateSessionInput): { token: string; session: Session } {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const token = newToken();
  const id = newId();
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  db.prepare(
    "INSERT INTO sessions(id, user_id, kind, token_hash, created_at, expires_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.userId, input.kind ?? "user", hashToken(token), now.toISOString(), expiresAt, now.toISOString(), input.userAgent ?? null);
  return { token, session: { id, userId: input.userId, kind: input.kind ?? "user", createdAt: now.toISOString(), expiresAt } };
}

/** Resolve a token to a live session; expired rows are removed. */
export function findSession(db: DB, token: string, now = new Date()): Session | null {
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return null;
  }
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
  return toSession(row);
}

/** Issue a fresh token for the same session and delete the old row. */
export function rotateSession(db: DB, token: string, now = new Date(), ttlMs = DEFAULT_SESSION_TTL_MS): { token: string; session: Session } | null {
  const current = findSession(db, token, now);
  if (!current) return null;
  return db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(current.id);
    return createSession(db, { userId: current.userId, kind: current.kind, ttlMs, now });
  })();
}

export function revokeSession(db: DB, token: string): boolean {
  return db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token)).changes > 0;
}

export function deleteExpiredSessions(db: DB, now = new Date()): number {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString()).changes;
}
