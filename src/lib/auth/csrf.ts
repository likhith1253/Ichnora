/**
 * CSRF defence for state-changing requests. The app relies on a SameSite=Lax
 * session cookie, and additionally requires a same-origin signal (Origin, or
 * Referer as a fallback) on every non-idempotent request in AUTH mode.
 *
 * LOCAL mode has no ambient credentials, so the check is not applied there —
 * the existing header-only behaviour is preserved exactly.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function expectedOrigin(req: Request, baseUrl?: string): string {
  if (baseUrl) {
    try {
      return new URL(baseUrl).origin;
    } catch {
      /* fall through to the request URL */
    }
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

/** True when a state-changing request carries a matching same-origin signal. */
export function sameOrigin(req: Request, baseUrl?: string): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const expected = expectedOrigin(req, baseUrl);
  if (!expected) return false;
  const origin = req.headers.get("origin");
  if (origin) return origin === expected;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return false;
}
