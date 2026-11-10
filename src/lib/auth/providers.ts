import type { ProviderName } from "../env";

/**
 * OAuth 2.0 authorization-code flow, implemented directly over `fetch` so the
 * dependency surface stays tiny and every network step is mockable in tests
 * (see DESIGN.md for why this instead of `arctic`). GitHub and Google are the
 * only providers, and neither uses a password: the app never stores one.
 */

export interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  /** Google requires PKCE; GitHub accepts but does not require it (we always send state). */
  usesPkce: boolean;
  scope: string;
}

const ENDPOINTS: Record<ProviderName, ProviderEndpoints> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    usesPkce: false,
    scope: "read:user user:email",
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    usesPkce: true,
    scope: "openid email profile",
  },
};

export function endpoints(name: ProviderName): ProviderEndpoints {
  return ENDPOINTS[name];
}

export interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function authorizeUrl(name: ProviderName, input: AuthorizeInput): string {
  const ep = endpoints(name);
  const url = new URL(ep.authorizeUrl);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ep.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (name === "google") url.searchParams.set("access_type", "online");
  return url.toString();
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AccessToken {
  accessToken: string;
  tokenType: string;
}

export async function exchangeCode(name: ProviderName, input: ExchangeInput, fetchImpl: FetchLike = fetch): Promise<AccessToken> {
  const ep = endpoints(name);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const res = await fetchImpl(ep.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string; token_type?: string; error?: string };
  if (!json.access_token) throw new Error(`Token exchange returned no access token${json.error ? `: ${json.error}` : ""}`);
  return { accessToken: json.access_token, tokenType: json.token_type ?? "bearer" };
}

export interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export async function fetchProfile(name: ProviderName, accessToken: string, fetchImpl: FetchLike = fetch): Promise<OAuthProfile> {
  const ep = endpoints(name);
  const res = await fetchImpl(ep.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Profile fetch failed (${res.status})`);
  const p = (await res.json()) as Record<string, unknown>;

  if (name === "github") {
    const login = typeof p.login === "string" ? p.login : null;
    const id = p.id !== undefined ? String(p.id) : login;
    if (!id) throw new Error("GitHub profile had no id");
    let email = typeof p.email === "string" ? p.email : null;
    if (!email) email = await githubPrimaryEmail(accessToken, fetchImpl);
    return {
      providerUserId: id,
      email,
      name: typeof p.name === "string" ? p.name : login,
      avatarUrl: typeof p.avatar_url === "string" ? p.avatar_url : null,
    };
  }

  const sub = p.sub !== undefined ? String(p.sub) : null;
  if (!sub) throw new Error("Google profile had no sub");
  return {
    providerUserId: sub,
    email: typeof p.email === "string" ? p.email : null,
    name: typeof p.name === "string" ? p.name : null,
    avatarUrl: typeof p.picture === "string" ? p.picture : null,
  };
}

async function githubPrimaryEmail(accessToken: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const res = await fetchImpl("https://api.github.com/user/emails", { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>;
    return list.find((e) => e.primary && e.verified)?.email ?? list.find((e) => e.primary)?.email ?? list[0]?.email ?? null;
  } catch {
    return null;
  }
}
