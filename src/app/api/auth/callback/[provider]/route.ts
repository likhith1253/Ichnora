import { authMode, getConfig, providerConfig, type ProviderName } from "@/lib/env";
import { getDb } from "@/lib/db";
import { exchangeCode, fetchProfile } from "@/lib/auth/providers";
import { upsertUserFromProfile } from "@/lib/auth/accounts";
import { DEFAULT_SESSION_TTL_MS, createSession } from "@/lib/auth/sessions";
import {
  OAUTH_COOKIE,
  authCookie,
  baseOrigin,
  clearAuthCookie,
  decodeState,
  sameSecret,
} from "@/lib/auth/flow";
import { SESSION_COOKIE } from "@/lib/server/identity";
import { readCookie } from "@/lib/auth/cookies";
import { json, safeInternalPath, see } from "@/lib/server/http";
import { redact } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (reason: string) => see(`/signin?error=${reason}`, [clearAuthCookie(OAUTH_COOKIE)]);

/**
 * OAuth callback. Verifies the signed state against the cookie (and the
 * provider echo), exchanges the code with its PKCE verifier, signs the user in
 * and redirects to the original same-origin destination.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const cfg = getConfig();
  if (authMode(cfg) !== "auth" || !cfg.AUTH_SECRET) return json({ error: "Authentication is not configured" }, 400);

  const pc = providerConfig(provider, cfg);
  if (!pc) return json({ error: "Unknown or unconfigured provider" }, 400);

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const cookieValue = readCookie(req, OAUTH_COOKIE);
  const state = cookieValue ? decodeState(cookieValue, cfg.AUTH_SECRET) : null;
  if (!state || state.provider !== pc.name || !stateParam || !sameSecret(state.state, stateParam)) return fail("state");
  if (!code) return fail("denied");

  const db = getDb();
  try {
    const redirectUri = `${baseOrigin(req, cfg)}/api/auth/callback/${pc.name}`;
    const token = await exchangeCode(pc.name as ProviderName, {
      code,
      codeVerifier: state.verifier,
      redirectUri,
      clientId: pc.clientId,
      clientSecret: pc.clientSecret,
    });
    const profile = await fetchProfile(pc.name as ProviderName, token.accessToken);
    const { user } = upsertUserFromProfile(db, pc.name as ProviderName, profile);
    const { token: sessionToken } = createSession(db, {
      userId: user.id,
      kind: "user",
      userAgent: req.headers.get("user-agent"),
      ttlMs: DEFAULT_SESSION_TTL_MS,
    });
    const session = authCookie(SESSION_COOKIE, sessionToken, Math.floor(DEFAULT_SESSION_TTL_MS / 1000));
    const next = safeInternalPath(state.next, "/");
    return see(`${next}${next.includes("?") ? "&" : "?"}welcome=1`, [clearAuthCookie(OAUTH_COOKIE), session]);
  } catch (e) {
    console.error("[auth] callback failed:", redact(String((e as Error).message)));
    return fail("exchange");
  }
}
