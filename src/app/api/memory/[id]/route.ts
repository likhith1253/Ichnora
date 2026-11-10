import { getDb } from "@/lib/db";
import { deleteMemory } from "@/lib/db/repo";
import { badRequest, json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Forget one distilled memory item. Original messages are never touched. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const idn = resolveWorkspace(req, db);
  if (!idn.ok) return idn.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest("Invalid request");
  const ok = deleteMemory(db, idn.workspaceId, id);
  return ok ? json({ ok }) : json({ error: "Not found" }, 404);
}
