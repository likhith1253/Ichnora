import { getDb } from "@/lib/db";
import { getMessages, listMemory } from "@/lib/db/repo";
import { json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only memory inspector feed (a UI view — never a model tool). */
export async function GET(req: Request) {
  const db = getDb();
  const id = resolveWorkspace(req, db);
  if (!id.ok) return id.response;
  const items = listMemory(db, id.workspaceId).map((m) => {
    const origin = getMessages(db, m.sourceMessageIds.slice(0, 1))[0];
    return { ...m, origin: origin ? { conversationId: origin.conversationId, createdAtUtc: origin.createdAtUtc, timezone: origin.timezone, excerpt: origin.content.slice(0, 200) } : null };
  });
  return json({ items });
}
