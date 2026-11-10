import { getConfig, providerStatus } from "@/lib/env";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Configuration health for the UI. Reports variable NAMES only, never values. */
export async function GET() {
  try {
    const s = providerStatus(getConfig());
    return json({ ...s, searchTool: s.provider === "groq" ? "browser_search" : "web_search" });
  } catch (e) {
    return json({ configured: false, error: `Invalid configuration: ${(e as Error).message}` });
  }
}
