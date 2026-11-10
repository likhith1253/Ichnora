import { getDb } from "../db";
import { getConfig, providerStatus } from "../env";
import { createProvider } from "./provider";
import type { AgentDeps } from "./run";

/** Production wiring. Config is re-read per request, so .env.local edits apply without a restart. */
export function productionDeps(): AgentDeps {
  const cfg = getConfig();
  const status = providerStatus(cfg);
  const db = getDb();
  return {
    db,
    provider: createProvider(cfg, db),
    missingVar: status.missingVar,
    timeoutMs: cfg.AGENT_TIMEOUT_MS,
    modelDistill: cfg.MEMORY_DISTILL === "model",
  };
}
