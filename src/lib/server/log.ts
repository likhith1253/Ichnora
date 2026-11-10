/**
 * Log hygiene: never let credentials reach logs. Provider errors sometimes echo
 * request headers or keys; scrub anything that looks like a secret.
 */
const PATTERNS: RegExp[] = [
  /gsk_[A-Za-z0-9]{10,}/g, // Groq
  /tvly-[A-Za-z0-9-]{10,}/g, // Tavily
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /(Bearer\s+)[A-Za-z0-9._-]{12,}/gi,
  /("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (m, p1?: string) => (typeof p1 === "string" && m.startsWith(p1) ? `${p1}[redacted]` : "[redacted]"));
  return out;
}
