import { getDb } from "@/lib/db";
import { getMessages, listMemory } from "@/lib/db/repo";
import { badRequest, json, workspaceFrom } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only memory inspector feed (a UI view — never a model tool). */
export async function GET(req: Request) {
  const ws = workspaceFrom(req);
  if (!ws) return badRequest("Missing or invalid x-workspace-id header");
  const db = getDb();
  const items = listMemory(db, ws).map((m) => {
    const origin = getMessages(db, m.sourceMessageIds.slice(0, 1))[0];
    return { ...m, origin: origin ? { conversationId: origin.conversationId, createdAtUtc: origin.createdAtUtc, timezone: origin.timezone, excerpt: origin.content.slice(0, 200) } : null };
  });
  return json({ items });
}
