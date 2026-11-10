import { getDb } from "@/lib/db";
import { getConfig } from "@/lib/env";
import { listPersonalMemories, openLoops } from "@/lib/personal/queries";
import { badRequest, json } from "@/lib/server/http";
import { resolveWorkspace } from "@/lib/server/identity";
import { isValidTimeZone, localDateOf } from "@/lib/time/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = new Set(["FACT", "PREFERENCE", "DECISION", "COMMITMENT", "ACTION_ITEM", "FOLLOW_UP", "PROJECT", "RELATIONSHIP"]);

/** Personal-memory inspector + open-loop feed (UI only — never a model tool). */
export async function GET(req: Request) {
  const db = getDb();
  const idn = resolveWorkspace(req, db);
  if (!idn.ok) return idn.response;
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? undefined;
  if (type && !TYPES.has(type)) return badRequest("Unknown memory type");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const tzParam = url.searchParams.get("tz") ?? "";
  const tz = isValidTimeZone(tzParam) ? tzParam : getConfig().DEFAULT_TIMEZONE;
  return json({
    today: localDateOf(new Date(), tz),
    items: listPersonalMemories(db, idn.workspaceId, { type, limit, offset }),
    loops: openLoops(db, idn.workspaceId, localDateOf(new Date(), tz)),
  });
}
