import { getDb } from "@/lib/db";
import { accountMetadata } from "@/lib/auth/accounts";
import { deleteWorkspace, exportWorkspace } from "@/lib/server/export";
import { json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Export all stored data for this workspace (download). Account metadata only, never tokens. */
export async function GET(req: Request) {
  const db = getDb();
  const id = resolveWorkspace(req, db);
  if (!id.ok) return id.response;
  const account = id.user ? accountMetadata(db, id.user.id) : null;
  const data = exportWorkspace(db, id.workspaceId, account);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="ichnora-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Delete every conversation, message, memory and research record of this workspace. */
export async function DELETE(req: Request) {
  const db = getDb();
  const id = resolveWorkspace(req, db);
  if (!id.ok) return id.response;
  deleteWorkspace(db, id.workspaceId);
  return json({ ok: true });
}
