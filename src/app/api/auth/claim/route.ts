import { z } from "zod";
import { authMode, getConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { claimWorkspace } from "@/lib/auth/accounts";
import { readCookie } from "@/lib/auth/cookies";
import { findSession } from "@/lib/auth/sessions";
import { sameOrigin } from "@/lib/auth/csrf";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { badRequest, json, workspaceFrom } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ workspaceId: z.string().uuid() });

/**
 * Attach the browser's existing local workspace to the signed-in account.
 * Explicit, one-shot, and only ever for an unowned `kind = 'local'` workspace.
 */
export async function POST(req: Request) {
  const cfg = getConfig();
  if (authMode(cfg) !== "auth") return json({ error: "Not available in local mode" }, 400);
  if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) return json({ error: "Cross-site request rejected" }, 403);

  const db = getDb();
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? findSession(db, token) : null;
  if (!session || session.kind !== "user") return json({ error: "Sign in required", authRequired: true }, 401);

  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("A valid workspaceId is required");
    body = parsed.data;
  } catch {
    return badRequest("Body must be JSON");
  }

  // A workspace id is a bearer secret: require the browser that holds it to
  // present it in the header too, so a leaked id alone cannot be claimed.
  if (workspaceFrom(req) !== body.workspaceId) return json({ error: "Claim must come from the browser that holds this workspace" }, 403);
  const claimed = claimWorkspace(db, session.userId, body.workspaceId);
  return json({ ok: true, claimed });
}
