import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Runtime configuration. Read lazily (never at import time) so the app builds
 * and boots without any API key; chat requests surface a setup error instead.
 */
const schema = z.object({
  LLM_PROVIDER: z.enum(["gemini", "openai"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  /** Tried in order when the primary model is overloaded (503) or unavailable (404). */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default("gemini-3.1-flash-lite")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  MINIMI_DB_PATH: z.string().optional(),
  /** "heuristic" (default, zero extra API calls) or "model" (one small extra call per research turn). */
  MEMORY_DISTILL: z.enum(["heuristic", "model"]).default("heuristic"),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
});

export type AppConfig = z.infer<typeof schema>;

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Minimal KEY=VALUE parser for .env files (comments, quotes, CRLF). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Next.js never lets .env files override variables already set on the machine,
 * so a stale system-wide GEMINI_API_KEY would silently shadow the project's key.
 * For this app's own settings, non-empty values in the project's .env.local
 * (then .env) take precedence over the process environment.
 */
function projectEnv(): NodeJS.ProcessEnv {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      const vars = parseDotEnv(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
      for (const [k, v] of Object.entries(vars)) if (v.trim()) merged[k] = v;
    } catch {
      /* file absent */
    }
  }
  return merged as NodeJS.ProcessEnv;
}

export function getConfig(env: NodeJS.ProcessEnv = projectEnv()): AppConfig {
  return schema.parse({
    LLM_PROVIDER: clean(env.LLM_PROVIDER)?.toLowerCase(),
    GEMINI_API_KEY: clean(env.GEMINI_API_KEY) ?? clean(env.GOOGLE_API_KEY),
    GEMINI_MODEL: clean(env.GEMINI_MODEL),
    GEMINI_FALLBACK_MODELS: clean(env.GEMINI_FALLBACK_MODELS),
    OPENAI_API_KEY: clean(env.OPENAI_API_KEY),
    OPENAI_MODEL: clean(env.OPENAI_MODEL),
    MINIMI_DB_PATH: clean(env.MINIMI_DB_PATH),
    MEMORY_DISTILL: clean(env.MEMORY_DISTILL)?.toLowerCase(),
    AGENT_TIMEOUT_MS: clean(env.AGENT_TIMEOUT_MS),
  });
}

export interface ProviderStatus {
  provider: AppConfig["LLM_PROVIDER"];
  model: string;
  configured: boolean;
  /** Name of the env var the user must set — never its value. */
  missingVar?: string;
}

export function providerStatus(cfg: AppConfig = getConfig()): ProviderStatus {
  if (cfg.LLM_PROVIDER === "gemini") {
    return {
      provider: "gemini",
      model: cfg.GEMINI_MODEL,
      configured: Boolean(cfg.GEMINI_API_KEY),
      missingVar: cfg.GEMINI_API_KEY ? undefined : "GEMINI_API_KEY",
    };
  }
  return {
    provider: "openai",
    model: cfg.OPENAI_MODEL,
    configured: Boolean(cfg.OPENAI_API_KEY),
    missingVar: cfg.OPENAI_API_KEY ? undefined : "OPENAI_API_KEY",
  };
}
