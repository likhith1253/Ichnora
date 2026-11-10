import { z } from "zod";
import { getDb } from "@/lib/db";
import { deleteConversation, getConversation, listMessages, memoryForConversation, renameConversation } from "@/lib/db/repo";
import { badRequest, ConversationId, json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function resolve(req: Request, ctx: Ctx) {
  const db = getDb();
  const identity = resolveWorkspace(req, db);
  if (!identity.ok) return { error: identity.response };
  const id = ConversationId.safeParse((await ctx.params).id);
  if (!id.success) return { error: badRequest("Invalid conversation id") };
  return { db, ws: identity.workspaceId, id: id.data };
}

export async function GET(req: Request, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if ("error" in r) return r.error;
  const conversation = getConversation(r.db, r.ws, r.id);
  if (!conversation) return json({ conversation: null, messages: [], memory: [] });
  return json({ conversation, messages: listMessages(r.db, r.id), memory: memoryForConversation(r.db, r.id) });
}

const Patch = z.object({ title: z.string().trim().min(1).max(120) });

export async function PATCH(req: Request, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if ("error" in r) return r.error;
  const body = Patch.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Title must be 1–120 characters");
  const ok = renameConversation(r.db, r.ws, r.id, body.data.title);
  return ok ? json({ ok }) : json({ error: "Not found" }, 404);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if ("error" in r) return r.error;
  const ok = deleteConversation(r.db, r.ws, r.id);
  return ok ? json({ ok }) : json({ error: "Not found" }, 404);
}
