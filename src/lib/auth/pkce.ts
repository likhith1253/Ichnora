import { createHash } from "node:crypto";
import { newToken } from "./tokens";

/**
 * PKCE (RFC 7636). The verifier stays on the server (in a short-lived cookie);
 * only its S256 challenge travels to the provider, so an intercepted code is
 * useless without the verifier.
 */

export function createVerifier(): string {
  return newToken(32); // 43-char base64url, within the 43–128 range
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createState(): string {
  return newToken(16);
}
