import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HMAC signer for short-lived, cookie-held handshake values (the OAuth
 * state). AUTH_SECRET is the key. Signing makes the value tamper-evident even
 * though it travels through the browser.
 */

export function sign(payload: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${mac}`;
}

export function verify(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = Buffer.from(signed.slice(0, dot), "base64url").toString("utf8");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const given = signed.slice(dot + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}
