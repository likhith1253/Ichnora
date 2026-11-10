import { z } from "zod";

/**
 * Runtime configuration. Read lazily (never at import time) so the app builds
 * and boots without any API key; chat requests surface a setup error instead.
 */
const schema = z.object({
  LLM_PROVIDER: z.enum(["gemini", "groq", "openai"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  // Free tier: Google Search grounding is available on the 2.5 Flash family only.
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  GROQ_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
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

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse({
    LLM_PROVIDER: clean(env.LLM_PROVIDER)?.toLowerCase(),
    GEMINI_API_KEY: clean(env.GEMINI_API_KEY) ?? clean(env.GOOGLE_API_KEY),
    GEMINI_MODEL: clean(env.GEMINI_MODEL),
    GROQ_API_KEY: clean(env.GROQ_API_KEY),
    GROQ_MODEL: clean(env.GROQ_MODEL),
    GROQ_REASONING_EFFORT: clean(env.GROQ_REASONING_EFFORT),
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
  if (cfg.LLM_PROVIDER === "openai") {
    return {
      provider: "openai",
      model: cfg.OPENAI_MODEL,
      configured: Boolean(cfg.OPENAI_API_KEY),
      missingVar: cfg.OPENAI_API_KEY ? undefined : "OPENAI_API_KEY",
    };
  }
  return {
    provider: "groq",
    model: cfg.GROQ_MODEL,
    configured: Boolean(cfg.GROQ_API_KEY),
    missingVar: cfg.GROQ_API_KEY ? undefined : "GROQ_API_KEY",
  };
}
