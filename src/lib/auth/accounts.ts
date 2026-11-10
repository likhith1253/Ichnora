import { randomUUID } from "node:crypto";
import type { DB } from "../db";
import type { ProviderName } from "../env";
import type { OAuthProfile } from "./providers";

/**
 * Accounts and the workspaces they own. A user is created on first sign-in and
 * identified thereafter by (provider, provider_user_id), so signing in again
 * with the same provider account is always the same user. Demo sessions use a
 * lightweight "guest" user that owns exactly one demo workspace.
 */

export interface PublicUser {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export type WorkspaceKind = "local" | "user" | "demo";

export interface WorkspaceRow {
  id: string;
  ownerUserId: string | null;
  kind: WorkspaceKind;
  expiresAt: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  created_at: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

const toUser = (r: UserRow): PublicUser => ({ id: r.id, name: r.name, email: r.email, avatarUrl: r.avatar_url, createdAt: r.created_at });

export function getUser(db: DB, id: string): PublicUser | null {
  const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return r ? toUser(r) : null;
}

interface WorkspaceDbRow {
  id: string;
  owner_user_id: string | null;
  kind: WorkspaceKind;
  expires_at: string | null;
  created_at: string;
}

export function getWorkspace(db: DB, id: string): WorkspaceRow | null {
  const r = db.prepare("SELECT id, owner_user_id, kind, expires_at, created_at FROM workspaces WHERE id = ?").get(id) as WorkspaceDbRow | undefined;
  return r ? { id: r.id, ownerUserId: r.owner_user_id, kind: r.kind, expiresAt: r.expires_at, createdAt: r.created_at } : null;
}

/** Find or create the single personal workspace owned by a real user. */
export function ensurePersonalWorkspace(db: DB, userId: string, now = new Date()): string {
  const existing = db.prepare("SELECT id FROM workspaces WHERE owner_user_id = ? AND kind = 'user' ORDER BY created_at LIMIT 1").get(userId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare("INSERT INTO workspaces(id, created_at, owner_user_id, kind) VALUES (?, ?, ?, 'user')").run(id, now.toISOString(), userId);
  return id;
}

/** The workspace a session points at: the user's personal workspace, or a demo. */
export function resolveOwnedWorkspace(db: DB, userId: string, kind: "user" | "demo", now = new Date()): string | null {
  if (kind === "user") return ensurePersonalWorkspace(db, userId, now);
  const r = db.prepare("SELECT id, expires_at FROM workspaces WHERE owner_user_id = ? AND kind = 'demo' ORDER BY created_at DESC LIMIT 1").get(userId) as { id: string; expires_at: string | null } | undefined;
  if (!r) return null;
  if (r.expires_at && r.expires_at <= now.toISOString()) return null;
  return r.id;
}

/**
 * Attach an existing, unowned local workspace to an account. Never automatic:
 * the caller must have obtained explicit user confirmation. Any empty personal
 * workspace that was auto-created on sign-in is discarded, so the claimed data
 * is the one the user then sees.
 */
export function claimWorkspace(db: DB, userId: string, workspaceId: string): boolean {
  const ws = getWorkspace(db, workspaceId);
  if (!ws || ws.ownerUserId || ws.kind !== "local") return false;
  return db.transaction(() => {
    const claimed =
      db.prepare("UPDATE workspaces SET owner_user_id = ?, kind = 'user' WHERE id = ? AND owner_user_id IS NULL AND kind = 'local'").run(userId, workspaceId).changes > 0;
    if (!claimed) return false;
    const empty = db
      .prepare(
        "SELECT id FROM workspaces w WHERE w.owner_user_id = ? AND w.kind = 'user' AND w.id <> ? AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.workspace_id = w.id)",
      )
      .all(userId, workspaceId) as Array<{ id: string }>;
    for (const e of empty) db.prepare("DELETE FROM workspaces WHERE id = ?").run(e.id);
    return true;
  })();
}

export interface UpsertResult {
  user: PublicUser;
  created: boolean;
}

/** Idempotent sign-in: same (provider, provider_user_id) → same user. */
export function upsertUserFromProfile(db: DB, provider: ProviderName, profile: OAuthProfile, now = new Date()): UpsertResult {
  const ts = now.toISOString();
  return db.transaction(() => {
    const existing = db
      .prepare("SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?")
      .get(provider, profile.providerUserId) as { user_id: string } | undefined;
    if (existing) {
      db.prepare("UPDATE users SET updated_at = ?, name = COALESCE(?, name), email = COALESCE(?, email), avatar_url = COALESCE(?, avatar_url) WHERE id = ?").run(
        ts, profile.name, profile.email, profile.avatarUrl, existing.user_id,
      );
      return { user: getUser(db, existing.user_id)!, created: false };
    }
    const id = randomUUID();
    db.prepare("INSERT INTO users(id, created_at, updated_at, name, email, avatar_url) VALUES (?, ?, ?, ?, ?, ?)").run(id, ts, ts, profile.name, profile.email, profile.avatarUrl);
    db.prepare("INSERT INTO oauth_accounts(id, user_id, provider, provider_user_id, email, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      randomUUID(), id, provider, profile.providerUserId, profile.email, ts,
    );
    return { user: getUser(db, id)!, created: true };
  })();
}

/** A throwaway user that owns exactly one demo workspace (no OAuth account). */
export function createGuestUser(db: DB, now = new Date()): string {
  const id = randomUUID();
  const ts = now.toISOString();
  db.prepare("INSERT INTO users(id, created_at, updated_at, name, email, avatar_url) VALUES (?, ?, ?, ?, NULL, NULL)").run(id, ts, ts, "Try demo");
  return id;
}

/** Delete an account: its workspaces (and everything derived) cascade away. */
export function deleteAccount(db: DB, userId: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function accountMetadata(db: DB, userId: string): Record<string, unknown> | null {
  const user = getUser(db, userId);
  if (!user) return null;
  const accounts = db.prepare("SELECT provider, email, created_at FROM oauth_accounts WHERE user_id = ?").all(userId);
  const workspaces = db.prepare("SELECT id, kind, created_at, expires_at FROM workspaces WHERE owner_user_id = ?").all(userId);
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, providers: accounts, workspaces };
}
