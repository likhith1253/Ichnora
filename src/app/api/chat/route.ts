import { productionDeps } from "@/lib/agent/deps";
import { chatHandler } from "@/lib/server/chat-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = chatHandler(productionDeps);
