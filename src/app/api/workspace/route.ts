import { getDb } from "@/lib/db";
import { deleteWorkspace, exportWorkspace } from "@/lib/server/export";
import { badRequest, json, workspaceFrom } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Export all stored data for this workspace (download). */
export async function GET(req: Request) {
  const ws = workspaceFrom(req);
  if (!ws) return badRequest("Missing or invalid x-workspace-id header");
  const data = exportWorkspace(getDb(), ws);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="minimi-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Delete every conversation, message, memory and research record of this workspace. */
export async function DELETE(req: Request) {
  const ws = workspaceFrom(req);
  if (!ws) return badRequest("Missing or invalid x-workspace-id header");
  deleteWorkspace(getDb(), ws);
  return json({ ok: true });
}
