import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Opaque token primitives. Session tokens are random, high-entropy strings;
 * only their SHA-256 hash is ever persisted, so a database leak does not
 * expose usable tokens. Tokens are never logged.
 */

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newId(): string {
  return randomUUID();
}
