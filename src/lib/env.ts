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
  /** Full-page reads (Tavily Extract) per answer; 1 credit per 5 successful pages. */
  MAX_EXTRACTS_PER_TURN: z.coerce.number().int().min(0).max(6).default(3),
  /** Monthly Tavily credits on the plan, and how many to keep for change checks. */
  TAVILY_MONTHLY_CREDITS: z.coerce.number().int().min(1).default(1000),
  TAVILY_RESERVE_CREDITS: z.coerce.number().int().min(0).default(100),
  /** Groq tokens-per-minute limit used for pacing (free tier: 8000). */
  GROQ_TPM_LIMIT: z.coerce.number().int().min(1000).default(8000),
  MINIMI_DB_PATH: z.string().optional(),
  /** Used when the browser does not send a valid IANA timezone. */
  DEFAULT_TIMEZONE: z.string().min(1).default("Asia/Kolkata"),
  /** "heuristic" (default, zero extra API calls) or "model" (one small extra call per research turn). */
  MEMORY_DISTILL: z.enum(["heuristic", "model"]).default("heuristic"),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),

  /* ---- identity (all optional; without them the app is single-user "local" mode) ---- */
  /** Signs the session cookie. Required for AUTH mode; any long random string. */
  AUTH_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Absolute origin used to build OAuth callback URLs (default: derived from the request). */
  PUBLIC_BASE_URL: z.string().optional(),

  /* ---- demo (always optional; LOCAL mode works without any of them) ---- */
  DEMO_ENABLED: z.enum(["1", "0", "true", "false", "yes", "no", "on", "off"]).default("true").transform((v) => v === "1" || v === "true" || v === "yes" || v === "on"),
  /** How long a demo workspace lives before it is cleaned up. */
  DEMO_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Model turns allowed per demo workspace. */
  DEMO_MAX_TURNS: z.coerce.number().int().min(1).max(100).default(8),
  /** Tavily credits allowed per demo workspace. */
  DEMO_MAX_CREDITS: z.coerce.number().int().min(0).max(200).default(15),
  /** How long a cached demo answer stays fresh. */
  DEMO_CACHE_TTL_MINUTES: z.coerce.number().int().min(5).max(2880).default(240),
  /** Demo creations allowed per IP, and the window those are counted over. */
  DEMO_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(5),
  DEMO_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
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
    MAX_EXTRACTS_PER_TURN: clean(env.MAX_EXTRACTS_PER_TURN),
    TAVILY_MONTHLY_CREDITS: clean(env.TAVILY_MONTHLY_CREDITS),
    TAVILY_RESERVE_CREDITS: clean(env.TAVILY_RESERVE_CREDITS),
    GROQ_TPM_LIMIT: clean(env.GROQ_TPM_LIMIT),
    MINIMI_DB_PATH: clean(env.MINIMI_DB_PATH),
    DEFAULT_TIMEZONE: clean(env.DEFAULT_TIMEZONE),
    MEMORY_DISTILL: clean(env.MEMORY_DISTILL)?.toLowerCase(),
    AGENT_TIMEOUT_MS: clean(env.AGENT_TIMEOUT_MS),
    AUTH_SECRET: clean(env.AUTH_SECRET),
    GITHUB_CLIENT_ID: clean(env.GITHUB_CLIENT_ID),
    GITHUB_CLIENT_SECRET: clean(env.GITHUB_CLIENT_SECRET),
    GOOGLE_CLIENT_ID: clean(env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: clean(env.GOOGLE_CLIENT_SECRET),
    PUBLIC_BASE_URL: clean(env.PUBLIC_BASE_URL),
    DEMO_ENABLED: clean(env.DEMO_ENABLED)?.toLowerCase(),
    DEMO_TTL_HOURS: clean(env.DEMO_TTL_HOURS),
    DEMO_MAX_TURNS: clean(env.DEMO_MAX_TURNS),
    DEMO_MAX_CREDITS: clean(env.DEMO_MAX_CREDITS),
    DEMO_CACHE_TTL_MINUTES: clean(env.DEMO_CACHE_TTL_MINUTES),
    DEMO_RATE_LIMIT_MAX: clean(env.DEMO_RATE_LIMIT_MAX),
    DEMO_RATE_LIMIT_WINDOW_MINUTES: clean(env.DEMO_RATE_LIMIT_WINDOW_MINUTES),
  });
}

/* ----------------------------------------------------------------- identity */

export type AuthMode = "local" | "auth";
export const PROVIDER_NAMES = ["github", "google"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderConfig {
  name: ProviderName;
  clientId: string;
  clientSecret: string;
}

/** Providers that have both a client id and secret. */
export function configuredProviders(cfg: AppConfig = getConfig()): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  if (cfg.GITHUB_CLIENT_ID && cfg.GITHUB_CLIENT_SECRET) out.push({ name: "github", clientId: cfg.GITHUB_CLIENT_ID, clientSecret: cfg.GITHUB_CLIENT_SECRET });
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) out.push({ name: "google", clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET });
  return out;
}

export function providerConfig(name: string, cfg: AppConfig = getConfig()): ProviderConfig | null {
  return configuredProviders(cfg).find((p) => p.name === name) ?? null;
}

/**
 * AUTH mode needs at least one fully configured provider *and* a secret to
 * sign the session cookie. With none of them the app is single-user "local".
 */
export function authMode(cfg: AppConfig = getConfig()): AuthMode {
  return cfg.AUTH_SECRET && configuredProviders(cfg).length > 0 ? "auth" : "local";
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
  /** "local" (single user, no sign-in) or "auth" (OAuth configured). */
  authMode: AuthMode;
  /** Names of the configured OAuth providers — never their keys. */
  providers: ProviderName[];
  /** Whether "Try demo" is available. */
  demo: boolean;
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
    authMode: authMode(cfg),
    providers: configuredProviders(cfg).map((p) => p.name),
    demo: cfg.DEMO_ENABLED,
  };
}
