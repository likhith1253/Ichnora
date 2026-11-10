import { getDb } from "../db";
import { getConfig, providerStatus } from "../env";
import { createProvider } from "./provider";
import type { AgentDeps } from "./run";

/** Production wiring. Config is read per request so .env changes need only a restart. */
export function productionDeps(): AgentDeps {
  const cfg = getConfig();
  const status = providerStatus(cfg);
  return {
    db: getDb(),
    provider: createProvider(cfg),
    missingVar: status.missingVar,
    timeoutMs: cfg.AGENT_TIMEOUT_MS,
    modelDistill: cfg.MEMORY_DISTILL === "model",
  };
}
