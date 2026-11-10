import { z } from "zod";
import { getDb } from "@/lib/db";
import { deleteConversation, getConversation, listMessages, memoryForConversation, renameConversation } from "@/lib/db/repo";
import { badRequest, ConversationId, json, workspaceFrom } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function resolve(req: Request, ctx: Ctx) {
  const ws = workspaceFrom(req);
  const id = ConversationId.safeParse((await ctx.params).id);
  if (!ws || !id.success) return null;
  return { ws, id: id.data };
}

export async function GET(req: Request, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if (!r) return badRequest("Invalid workspace or conversation id");
  const db = getDb();
  const conversation = getConversation(db, r.ws, r.id);
  if (!conversation) return json({ conversation: null, messages: [], memory: [] });
  return json({ conversation, messages: listMessages(db, r.id), memory: memoryForConversation(db, r.id) });
}

const Patch = z.object({ title: z.string().trim().min(1).max(120) });

export async function PATCH(req: Request, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if (!r) return badRequest("Invalid workspace or conversation id");
  const body = Patch.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Title must be 1–120 characters");
  const ok = renameConversation(getDb(), r.ws, r.id, body.data.title);
  return ok ? json({ ok }) : json({ error: "Not found" }, 404);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const r = await resolve(req, ctx);
  if (!r) return badRequest("Invalid workspace or conversation id");
  const ok = deleteConversation(getDb(), r.ws, r.id);
  return ok ? json({ ok }) : json({ error: "Not found" }, 404);
}
