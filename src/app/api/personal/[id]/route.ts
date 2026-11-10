import { z } from "zod";
import { getDb } from "@/lib/db";
import { correctMemory, deletePersonalMemory } from "@/lib/personal/store";
import { badRequest, json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z
  .object({
    status: z.enum(["ACTIVE", "OPEN", "WAITING", "COMPLETED", "CANCELLED", "SUPERSEDED", "CONSIDERING"]).optional(),
    content: z.string().trim().min(2).max(400).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");

/** User correction: recorded as an event with provenance; the original quote is kept. */
export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const idn = resolveWorkspace(req, db);
  if (!idn.ok) return idn.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest("Invalid request");
  const body = Patch.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest(body.error.issues.map((i) => i.message).join("; "));
  const m = correctMemory(db, idn.workspaceId, id, body.data);
  return m ? json({ memory: m }) : json({ error: "Not found" }, 404);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const db = getDb();
  const idn = resolveWorkspace(req, db);
  if (!idn.ok) return idn.response;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest("Invalid request");
  return deletePersonalMemory(db, idn.workspaceId, id) ? json({ ok: true }) : json({ error: "Not found" }, 404);
}
