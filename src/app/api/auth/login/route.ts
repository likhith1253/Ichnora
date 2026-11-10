import { authMode, getConfig, providerConfig, type ProviderName } from "@/lib/env";
import { authorizeUrl } from "@/lib/auth/providers";
import { challengeFor, createState, createVerifier } from "@/lib/auth/pkce";
import { OAUTH_COOKIE, OAUTH_TTL_SECONDS, authCookie, baseOrigin, encodeState } from "@/lib/auth/flow";
import { json, safeInternalPath, see } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begin the OAuth authorization-code flow: store a signed state (with the PKCE
 * verifier and destination) in a short-lived httpOnly cookie, then redirect.
 */
export async function GET(req: Request) {
  const cfg = getConfig();
  if (authMode(cfg) !== "auth" || !cfg.AUTH_SECRET) return json({ error: "Authentication is not configured" }, 400);

  const url = new URL(req.url);
  const pc = providerConfig(url.searchParams.get("provider") ?? "", cfg);
  if (!pc) return json({ error: "Unknown or unconfigured provider" }, 400);

  const next = safeInternalPath(url.searchParams.get("next"), "/");
  const state = createState();
  const verifier = createVerifier();
  const redirectUri = `${baseOrigin(req, cfg)}/api/auth/callback/${pc.name}`;
  const target = authorizeUrl(pc.name as ProviderName, {
    clientId: pc.clientId,
    redirectUri,
    state,
    codeChallenge: challengeFor(verifier),
  });
  const cookie = authCookie(OAUTH_COOKIE, encodeState({ provider: pc.name, state, verifier, next }, cfg.AUTH_SECRET), OAUTH_TTL_SECONDS);
  return see(target, [cookie]);
}
