import { getConfig, providerStatus } from "@/lib/env";
import { json } from "@/lib/server/http";
import { getDb, defaultDbPath } from "@/lib/db";
import { getStorageAccounting, checkDbIntegrity } from "@/lib/storage/accounting";
import { getCacheStore } from "@/lib/cache/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Configuration, storage, and architectural health for the UI and diagnostics. */
export async function GET() {
  try {
    const s = providerStatus(getConfig());
    let storage = null;
    let dbIntegrity = null;
    let cacheStats = null;

    try {
      const db = getDb();
      storage = getStorageAccounting(defaultDbPath());
      dbIntegrity = checkDbIntegrity(db);
      cacheStats = getCacheStore().getStats(db);
    } catch {
      /* non-fatal if DB not yet initialized */
    }

    return json({
      ...s,
      searchTool: "web_search",
      storage,
      dbIntegrity,
      cacheStats,
    });
  } catch (e) {
    return json({ configured: false, error: `Invalid configuration: ${(e as Error).message}` });
  }
}
