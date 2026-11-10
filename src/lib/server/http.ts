import { z } from "zod";

export const WorkspaceId = z.string().uuid();
export const ConversationId = z.string().uuid();

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

/** Redirect response that can also set cookies (Response.redirect cannot). */
export function see(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status, headers });
}

/** Workspace id comes from the browser (localStorage) via a header. */
export function workspaceFrom(req: Request): string | null {
  const parsed = WorkspaceId.safeParse(req.headers.get("x-workspace-id"));
  return parsed.success ? parsed.data : null;
}

/** Only same-origin, relative redirect targets are allowed (no open redirects). */
export function safeInternalPath(raw: string | null, fallback = "/"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return fallback;
  return raw;
}
