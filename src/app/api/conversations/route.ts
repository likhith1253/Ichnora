import { getDb } from "@/lib/db";
import { createConversation, listConversations } from "@/lib/db/repo";
import { json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = getDb();
  const id = resolveWorkspace(req, db);
  if (!id.ok) return id.response;
  return json({ conversations: listConversations(db, id.workspaceId) });
}

export async function POST(req: Request) {
  const db = getDb();
  const id = resolveWorkspace(req, db);
  if (!id.ok) return id.response;
  return json({ conversation: createConversation(db, id.workspaceId) }, 201);
}
