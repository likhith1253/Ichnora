import { timingSafeEqual } from "node:crypto";
import { getConfig, type AppConfig } from "../env";
import { clearCookie, serializeCookie } from "./cookies";
import { sign, verify } from "./sign";

/**
 * Shared pieces of the OAuth handshake: where the app lives, how the short-lived
 * state cookie is written, and how the signed state is read back. Kept separate
 * so every route uses identical, auditable logic.
 */

export const OAUTH_COOKIE = "minimi_oauth";
/** The handshake cookie (state + PKCE verifier + intended destination) lives 10 minutes. */
export const OAUTH_TTL_SECONDS = 600;

/** Secure cookies in production (https); plain http on localhost is not marked Secure. */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

export function baseOrigin(req: Request, cfg: AppConfig = getConfig()): string {
  if (cfg.PUBLIC_BASE_URL) {
    try {
      return new URL(cfg.PUBLIC_BASE_URL).origin;
    } catch {
      /* fall through to the request URL */
    }
  }
  return new URL(req.url).origin;
}

export interface OAuthState {
  provider: string;
  state: string;
  verifier: string;
  /** Where to land after sign-in; only same-origin paths survive `safeInternalPath`. */
  next: string;
}

export function encodeState(s: OAuthState, secret: string): string {
  return sign(JSON.stringify(s), secret);
}

export function decodeState(raw: string, secret: string): OAuthState | null {
  const payload = verify(raw, secret);
  if (!payload) return null;
  try {
    const o = JSON.parse(payload) as OAuthState;
    if (!o || typeof o.provider !== "string" || typeof o.state !== "string" || typeof o.verifier !== "string" || typeof o.next !== "string") return null;
    return o;
  } catch {
    return null;
  }
}

/** Constant-time string comparison for the state parameter. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authCookie(name: string, value: string, maxAgeSeconds: number, secure = secureCookies()): string {
  return serializeCookie(name, value, { maxAge: maxAgeSeconds, httpOnly: true, sameSite: "Lax", secure, path: "/" });
}

export function clearAuthCookie(name: string): string {
  return clearCookie(name, { path: "/" });
}
