import { authMode, configuredProviders, getConfig } from "@/lib/env";
import { getDb } from "@/lib/db";
import { getUser } from "@/lib/auth/accounts";
import { readCookie } from "@/lib/auth/cookies";
import { findSession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who the caller is, for the UI. Never creates a workspace, so a first sign-in
 * can decide whether to offer claiming the browser's existing local data.
 */
export async function GET(req: Request) {
  const cfg = getConfig();
  const mode = authMode(cfg);
  const providers = configuredProviders(cfg).map((p) => p.name);
  const db = getDb();
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? findSession(db, token) : null;
  const demo = session?.kind === "demo";
  const user = mode === "auth" && session && session.kind === "user" ? getUser(db, session.userId) : null;
  return json({ mode, signedIn: Boolean(user), user, demo, providers, demoEnabled: cfg.DEMO_ENABLED });
}
