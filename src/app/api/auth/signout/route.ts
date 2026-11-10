import { getConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { readCookie } from "@/lib/auth/cookies";
import { revokeSession } from "@/lib/auth/sessions";
import { clearAuthCookie } from "@/lib/auth/flow";
import { sameOrigin } from "@/lib/auth/csrf";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out: revoke the server-side session and clear the cookie. */
export async function POST(req: Request) {
  const cfg = getConfig();
  if (!sameOrigin(req, cfg.PUBLIC_BASE_URL)) return json({ error: "Cross-site request rejected" }, 403);
  const token = readCookie(req, SESSION_COOKIE);
  if (token) revokeSession(getDb(), token);
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearAuthCookie(SESSION_COOKIE));
  return res;
}
