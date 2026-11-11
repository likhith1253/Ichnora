import type { DB } from "../db";
import { authMode, getConfig, type AppConfig, type AuthMode } from "../env";
import { getWorkspace, getUser, resolveOwnedWorkspace, type PublicUser } from "../auth/accounts";
import { readCookie } from "../auth/cookies";
import { sameOrigin } from "../auth/csrf";
import { findSession } from "../auth/sessions";
import { badRequest, json, workspaceFrom } from "./http";
import { maybeCleanupDemos } from "../demo/store";

/**
 * The single place that decides which workspace an API request acts on.
 *
 * - AUTH mode: the workspace comes ONLY from the session cookie. The
 *   `x-workspace-id` header is ignored, and every route 401s without a valid
 *   session. State-changing requests must also be same-origin (CSRF).
 * - LOCAL mode: the long-standing header behaviour is unchanged.
 */

export const SESSION_COOKIE = "minimi_session";

export type Identity =
  | { ok: true; workspaceId: string; user: PublicUser | null; demo: boolean; mode: AuthMode }
  | { ok: false; response: Response };

export function resolveWorkspace(req: Request, db: DB, cfg: AppConfig = getConfig()): Identity {
  const mode = authMode(cfg);
  maybeCleanupDemos(db, cfg); // throttled (≤ once / 10 min); expired demos & sessions go away

  if (mode === "auth") {
    if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) {
      return { ok: false, response: json({ error: "Cross-site request rejected" }, 403) };
    }
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? findSession(db, token) : null;
    if (!session) return { ok: false, response: json({ error: "Sign in required", authRequired: true }, 401) };

    const workspaceId = resolveOwnedWorkspace(db, session.userId, session.kind);
    if (!workspaceId) return { ok: false, response: json({ error: "Session expired", authRequired: true }, 401) };
    const user = session.kind === "user" ? getUser(db, session.userId) : null;
    if (session.kind === "user" && !user) return { ok: false, response: json({ error: "Session expired", authRequired: true }, 401) };
    return { ok: true, workspaceId, user, demo: session.kind === "demo", mode };
  }

  // LOCAL mode keeps the header behaviour, but a *demo* session cookie takes
  // precedence so "Try demo" can run without touching the visitor's own
  // workspace. Only kind 'demo' sessions are honoured here, never real accounts.
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const session = findSession(db, token);
    if (session?.kind === "demo") {
      if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) return { ok: false, response: json({ error: "Cross-site request rejected" }, 403) };
      const demoWs = resolveOwnedWorkspace(db, session.userId, "demo");
      if (demoWs) return { ok: true, workspaceId: demoWs, user: null, demo: true, mode };
    }
  }

  const ws = workspaceFrom(req);
  if (!ws) return { ok: false, response: badRequest("Missing or invalid x-workspace-id header") };
  const row = getWorkspace(db, ws);
  // The bare header may only open an unowned LOCAL workspace. Demo workspaces
  // need their session cookie (and expire); account workspaces need sign-in.
  if (row && (row.kind !== "local" || row.ownerUserId)) {
    return { ok: false, response: json({ error: "This workspace requires its own session", authRequired: row.kind === "user" }, 403) };
  }
  return { ok: true, workspaceId: ws, user: null, demo: false, mode };
}

/** DEMO budget enforcement is only meaningful inside a demo workspace. */
export function isDemoWorkspace(db: DB, workspaceId: string): boolean {
  return getWorkspace(db, workspaceId)?.kind === "demo";
}
