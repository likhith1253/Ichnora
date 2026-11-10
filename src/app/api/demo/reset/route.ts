import { getConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { readCookie } from "@/lib/auth/cookies";
import { rotateSession } from "@/lib/auth/sessions";
import { authCookie } from "@/lib/auth/flow";
import { sameOrigin } from "@/lib/auth/csrf";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { resetDemoWorkspace } from "@/lib/demo/store";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reset a disposable demo: the guest keeps the same account but its demo
 * workspace is replaced with a freshly seeded one. The session token is also
 * rotated (new token, old row deleted) so a captured cookie cannot outlive it.
 */
export async function POST(req: Request) {
  const cfg = getConfig();
  if (!cfg.DEMO_ENABLED) return json({ error: "The demo is disabled" }, 403);
  if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) return json({ error: "Cross-site request rejected" }, 403);

  const db = getDb();
  const token = readCookie(req, SESSION_COOKIE);
  const current = token ? rotateSession(db, token) : null;
  if (!current || current.session.kind !== "demo") {
    return json({ error: "No demo session", demoRequired: true }, 401);
  }

  const demo = resetDemoWorkspace(db, current.session.userId, cfg);
  if (!demo) return json({ error: "No demo session", demoRequired: true }, 401);

  const res = json({ ok: true, workspaceId: demo.workspaceId, expiresAt: demo.expiresAt });
  res.headers.append("Set-Cookie", authCookie(SESSION_COOKIE, current.token, cfg.DEMO_TTL_HOURS * 3600));
  return res;
}
