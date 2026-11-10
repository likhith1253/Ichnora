import { getDb } from "@/lib/db";
import { deleteMemory } from "@/lib/db/repo";
import { badRequest, json, workspaceFrom } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Forget one distilled memory item. Original messages are never touched. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const ws = workspaceFrom(req);
  const { id } = await ctx.params;
  if (!ws || !/^[0-9a-f-]{36}$/i.test(id)) return badRequest("Invalid request");
  const ok = deleteMemory(getDb(), ws, id);
  return ok ? json({ ok }) : json({ error: "Not found" }, 404);
}
