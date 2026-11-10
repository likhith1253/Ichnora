import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Runtime configuration. Read lazily (never at import time) so the app builds
 * and boots without any API key; chat requests surface a setup error instead.
 */
const schema = z.object({
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  /** gpt-oss reasoning effort; change checks are raised to at least "medium". */
  GROQ_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  TAVILY_API_KEY: z.string().optional(),
  /** Hard cap on Tavily queries per answer (1 credit each on the free plan). */
  MAX_SEARCHES_PER_TURN: z.coerce.number().int().min(1).max(12).default(6),
  MINIMI_DB_PATH: z.string().optional(),
  /** Used when the browser does not send a valid IANA timezone. */
  DEFAULT_TIMEZONE: z.string().min(1).default("Asia/Kolkata"),
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
 * so a stale system-wide key would silently shadow the project's key. For this
 * app's settings, non-empty values in .env.local (then .env) take precedence.
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
    GROQ_API_KEY: clean(env.GROQ_API_KEY),
    GROQ_MODEL: clean(env.GROQ_MODEL),
    GROQ_REASONING_EFFORT: clean(env.GROQ_REASONING_EFFORT)?.toLowerCase(),
    TAVILY_API_KEY: clean(env.TAVILY_API_KEY),
    MAX_SEARCHES_PER_TURN: clean(env.MAX_SEARCHES_PER_TURN),
    MINIMI_DB_PATH: clean(env.MINIMI_DB_PATH),
    DEFAULT_TIMEZONE: clean(env.DEFAULT_TIMEZONE),
    MEMORY_DISTILL: clean(env.MEMORY_DISTILL)?.toLowerCase(),
    AGENT_TIMEOUT_MS: clean(env.AGENT_TIMEOUT_MS),
  });
}

export interface ProviderStatus {
  provider: "groq";
  model: string;
  search: "tavily";
  /** Chat works (LLM key present). */
  configured: boolean;
  /** Live web search works (search key present). */
  searchConfigured: boolean;
  /** Missing LLM variable NAME (never a value). */
  missingVar?: string;
  missingVars: string[];
}

export function providerStatus(cfg: AppConfig = getConfig()): ProviderStatus {
  const missingVars = [...(cfg.GROQ_API_KEY ? [] : ["GROQ_API_KEY"]), ...(cfg.TAVILY_API_KEY ? [] : ["TAVILY_API_KEY"])];
  return {
    provider: "groq",
    model: cfg.GROQ_MODEL,
    search: "tavily",
    configured: Boolean(cfg.GROQ_API_KEY),
    searchConfigured: Boolean(cfg.TAVILY_API_KEY),
    missingVar: cfg.GROQ_API_KEY ? undefined : "GROQ_API_KEY",
    missingVars,
  };
}
