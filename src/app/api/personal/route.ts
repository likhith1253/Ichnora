import { getDb } from "@/lib/db";
import { getConfig } from "@/lib/env";
import { listPersonalMemories, openLoops } from "@/lib/personal/queries";
import { badRequest, json, workspaceFrom } from "@/lib/server/http";
import { isValidTimeZone, localDateOf } from "@/lib/time/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = new Set(["FACT", "PREFERENCE", "DECISION", "COMMITMENT", "ACTION_ITEM", "FOLLOW_UP", "PROJECT", "RELATIONSHIP"]);

/** Personal-memory inspector + open-loop feed (UI only — never a model tool). */
export async function GET(req: Request) {
  const ws = workspaceFrom(req);
  if (!ws) return badRequest("Missing or invalid x-workspace-id header");
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? undefined;
  if (type && !TYPES.has(type)) return badRequest("Unknown memory type");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const tzParam = url.searchParams.get("tz") ?? "";
  const tz = isValidTimeZone(tzParam) ? tzParam : getConfig().DEFAULT_TIMEZONE;
  const db = getDb();
  return json({
    today: localDateOf(new Date(), tz),
    items: listPersonalMemories(db, ws, { type, limit, offset }),
    loops: openLoops(db, ws, localDateOf(new Date(), tz)),
  });
}
