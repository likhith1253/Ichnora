import { getDb } from "@/lib/db";
import { createConversation, listConversations } from "@/lib/db/repo";
import { json, badRequest, workspaceFrom } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ws = workspaceFrom(req);
  if (!ws) return badRequest("Missing or invalid x-workspace-id header");
  return json({ conversations: listConversations(getDb(), ws) });
}

export async function POST(req: Request) {
  const ws = workspaceFrom(req);
  if (!ws) return badRequest("Missing or invalid x-workspace-id header");
  return json({ conversation: createConversation(getDb(), ws) }, 201);
}
