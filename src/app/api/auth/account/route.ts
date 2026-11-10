import { authMode, getConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { deleteAccount } from "@/lib/auth/accounts";
import { readCookie } from "@/lib/auth/cookies";
import { findSession } from "@/lib/auth/sessions";
import { clearAuthCookie } from "@/lib/auth/flow";
import { sameOrigin } from "@/lib/auth/csrf";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete the signed-in account. Removing the user cascades to its workspaces,
 * so every conversation, memory and research record goes with it.
 */
export async function DELETE(req: Request) {
  const cfg = getConfig();
  if (authMode(cfg) !== "auth") return json({ error: "Not available in local mode" }, 400);
  if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) return json({ error: "Cross-site request rejected" }, 403);

  const db = getDb();
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? findSession(db, token) : null;
  if (!session || session.kind !== "user") return json({ error: "Sign in required", authRequired: true }, 401);

  deleteAccount(db, session.userId);
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearAuthCookie(SESSION_COOKIE));
  return res;
}
