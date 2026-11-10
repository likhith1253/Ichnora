import { z } from "zod";

export const WorkspaceId = z.string().uuid();
export const ConversationId = z.string().uuid();

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

/** Workspace id comes from the browser (localStorage) via a header. */
export function workspaceFrom(req: Request): string | null {
  const parsed = WorkspaceId.safeParse(req.headers.get("x-workspace-id"));
  return parsed.success ? parsed.data : null;
}
