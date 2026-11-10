import OpenAI from "openai";
import { GeminiProvider } from "./gemini";
import type { AppConfig } from "../env";
import type { ModelRequest } from "./prompt";
import type { RawSource } from "./sources";

/**
 * Provider boundary. Everything vendor-specific lives here; the rest of the
 * app sees `LlmProvider`. Tests substitute a scripted fake.
 *
 * The ONLY tool ever placed in a request is the provider's hosted web search
 * (`googleSearch` on Gemini, `web_search` on OpenAI). See `assertSingleSearchTool`.
 */

export type ProviderEvent =
  | { type: "phase"; phase: "thinking" | "searching" | "writing" }
  | { type: "search"; query?: string }
  | { type: "text"; delta: string }
  | { type: "done"; text: string; sources: RawSource[]; searchQueries: string[]; searchUnavailable?: boolean; model?: string };

export interface LlmProvider {
  readonly name: "gemini" | "openai" | "fake";
  readonly model: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Plain completion with NO tools (internal memory distillation). */
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export const SEARCH_TOOL_TYPES = new Set(["web_search", "googleSearch"]);

/** The tool's identity: `type` for OpenAI-style tools, the single key for Gemini (`{ googleSearch: {} }`). */
function toolKind(t: object): string {
  const typed = (t as { type?: unknown }).type;
  if (typeof typed === "string") return typed;
  const keys = Object.keys(t);
  return keys.length === 1 ? keys[0]! : JSON.stringify(keys);
}

/** Guard used by every request builder and the test-suite. */
export function assertSingleSearchTool(tools: ReadonlyArray<object> | undefined): void {
  if (!tools) return;
  if (tools.length !== 1 || !SEARCH_TOOL_TYPES.has(toolKind(tools[0]!))) {
    throw new Error(`Invariant violated: the model may only receive one web-search tool, got ${JSON.stringify(tools)}`);
  }
}

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/* ---------------------------------------------------------------- OpenAI */

export function buildOpenAIRequest(req: ModelRequest, cfg: Pick<AppConfig, "OPENAI_MODEL">): Json {
  const input: Json[] = [];
  if (req.memoryContext) input.push({ role: "developer", content: req.memoryContext });
  for (const t of req.history) input.push({ role: t.role, content: t.content });
  input.push({ role: "user", content: req.user });
  const body: Json = {
    model: cfg.OPENAI_MODEL,
    instructions: req.system,
    input,
    store: false,
    stream: true,
  };
  if (req.toolChoice !== "none") {
    const tools = [{ type: "web_search" }];
    assertSingleSearchTool(tools);
    body.tools = tools;
    body.tool_choice = req.toolChoice;
    body.include = ["web_search_call.action.sources"];
  }
  return body;
}

/** Sources from a completed Responses API `output` array. */
export function openAIOutputSources(output: unknown): { sources: RawSource[]; queries: string[] } {
  const sources: RawSource[] = [];
  const queries: string[] = [];
  if (!Array.isArray(output)) return { sources, queries };
  for (const item of output as Json[]) {
    if (item.type === "web_search_call") {
      const action = (item.action ?? {}) as Json;
      if (typeof action.query === "string") queries.push(action.query);
      for (const s of (Array.isArray(action.sources) ? action.sources : []) as Json[]) {
        const url = str(s.url);
        if (url) sources.push({ url, title: str(s.title) ?? null, origin: "search" });
      }
    }
    if (item.type === "message") {
      for (const c of (Array.isArray(item.content) ? item.content : []) as Json[]) {
        for (const a of (Array.isArray(c.annotations) ? c.annotations : []) as Json[]) {
          const url = str(a.url);
          if (a.type === "url_citation" && url) sources.push({ url, title: str(a.title) ?? null, origin: "citation" });
        }
      }
    }
  }
  return { sources, queries };
}

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  readonly model: string;
  private client: OpenAI;
  constructor(private cfg: AppConfig) {
    this.model = cfg.OPENAI_MODEL;
    this.client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY, maxRetries: 2, timeout: cfg.AGENT_TIMEOUT_MS });
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const body = buildOpenAIRequest(req, this.cfg);
    let text = "";
    let writing = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await this.client.responses.create(body as any, { signal })) as unknown as AsyncIterable<Json>;
    for await (const ev of stream) {
      switch (ev.type) {
        case "response.web_search_call.in_progress":
        case "response.web_search_call.searching":
          yield { type: "phase", phase: "searching" };
          break;
        case "response.web_search_call.completed":
          yield { type: "search" };
          break;
        case "response.reasoning_summary_text.delta":
          break;
        case "response.output_text.delta": {
          const d = str(ev.delta);
          if (d) {
            if (!writing) {
              writing = true;
              yield { type: "phase", phase: "writing" };
            }
            text += d;
            yield { type: "text", delta: d };
          }
          break;
        }
        case "response.completed": {
          const resp = (ev.response ?? {}) as Json;
          const r = openAIOutputSources(resp.output);
          yield { type: "done", text, sources: r.sources, searchQueries: [...new Set(r.queries)] };
          return;
        }
        case "response.failed":
        case "error":
          throw new Error(str(((ev.response as Json | undefined)?.error as Json | undefined)?.message) ?? str(ev.message) ?? "Model request failed");
      }
    }
    yield { type: "done", text, sources: [], searchQueries: [] };
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await this.client.responses.create(
      { model: this.cfg.OPENAI_MODEL, instructions: system, input: user, store: false, text: { format: { type: "json_object" } } },
      { signal },
    );
    return res.output_text ?? "";
  }
}

export function createProvider(cfg: AppConfig): LlmProvider | null {
  if (cfg.LLM_PROVIDER === "gemini") return cfg.GEMINI_API_KEY ? new GeminiProvider(cfg) : null;
  return cfg.OPENAI_API_KEY ? new OpenAIProvider(cfg) : null;
}
