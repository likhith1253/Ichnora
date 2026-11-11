import { getConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { createSession, revokeSession } from "@/lib/auth/sessions";
import { readCookie } from "@/lib/auth/cookies";
import { authCookie } from "@/lib/auth/flow";
import { sameOrigin } from "@/lib/auth/csrf";
import { getWorkspace } from "@/lib/auth/accounts";
import { SESSION_COOKIE, resolveWorkspace } from "@/lib/server/identity";
import { createDemoWorkspace, maybeCleanupDemos } from "@/lib/demo/store";
import { budgetStatus } from "@/lib/demo/budget";
import { DEMO_PROMPTS } from "@/lib/demo/prompts";
import { allowDemoCreation, clientIp, recordDemoCreation } from "@/lib/demo/rate";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Demo metadata for the UI. Public: always returns whether the demo is enabled
 * and the guided prompts. Inside a live demo it also reports the remaining
 * budget and the expiry, so the banner can be honest about what is left.
 */
export async function GET(req: Request) {
  const cfg = getConfig();
  const db = getDb();
  const base = { enabled: cfg.DEMO_ENABLED, prompts: DEMO_PROMPTS };
  const id = resolveWorkspace(req, db, cfg);
  if (!id.ok || !id.demo) return json(base);
  const budget = budgetStatus(db, id.workspaceId, cfg);
  const ws = getWorkspace(db, id.workspaceId);
  return json({ ...base, budget, expiresAt: ws?.expiresAt ?? null });
}

/**
 * Start a disposable demo: a guest account owns one seeded `kind = 'demo'`
 * workspace, reached through a demo session cookie. Rate limited per IP.
 */
export async function POST(req: Request) {
  const cfg = getConfig();
  if (!cfg.DEMO_ENABLED) return json({ error: "The demo is disabled" }, 403);
  if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) return json({ error: "Cross-site request rejected" }, 403);

  const db = getDb();
  maybeCleanupDemos(db, cfg);

  const ip = clientIp(req, cfg.TRUST_PROXY);
  if (!allowDemoCreation(db, ip, cfg)) {
    return json({ error: "Too many demos have been started from here. Please try again a little later." }, 429);
  }

  // The demo cookie replaces any existing session cookie; revoke that session
  // server-side so it cannot linger unreferenced for its full lifetime.
  const previous = readCookie(req, SESSION_COOKIE);
  if (previous) revokeSession(db, previous);

  const demo = createDemoWorkspace(db, cfg);
  recordDemoCreation(db, ip);
  const { token } = createSession(db, {
    userId: demo.userId,
    kind: "demo",
    ttlMs: cfg.DEMO_TTL_HOURS * 3_600_000,
    userAgent: req.headers.get("user-agent"),
  });

  const res = json({ ok: true, workspaceId: demo.workspaceId, expiresAt: demo.expiresAt });
  res.headers.append("Set-Cookie", authCookie(SESSION_COOKIE, token, cfg.DEMO_TTL_HOURS * 3600));
  return res;
}
