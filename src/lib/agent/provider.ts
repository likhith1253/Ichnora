import type { AppConfig } from "../env";
import { TavilySearch } from "../search/tavily";
import { GroqProvider } from "./groq";
import type { ModelRequest } from "./prompt";
import type { RawSource } from "./sources";

/**
 * Provider boundary. Everything vendor-specific lives behind `LlmProvider`;
 * the agent and tests only see this event stream.
 *
 * Invariant: the ONLY tool ever placed in a model request is `web_search`
 * (implemented by the search layer). See `assertSingleSearchTool`.
 */

export type ProviderEvent =
  | { type: "phase"; phase: "thinking" | "searching" | "writing" }
  | { type: "search"; query?: string }
  | { type: "text"; delta: string }
  /** Discard streamed text so far (it was pre-tool-call chatter). */
  | { type: "reset" }
  | { type: "done"; text: string; sources: RawSource[]; searchQueries: string[]; searchUnavailable?: boolean; model?: string };

export interface LlmProvider {
  readonly name: "groq" | "fake";
  readonly model: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Plain JSON completion with NO tools (internal memory distillation). */
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export const SEARCH_TOOL_NAME = "web_search";

/** Guard used by the request builder and the test-suite. */
export function assertSingleSearchTool(tools: ReadonlyArray<object> | undefined): void {
  if (!tools) return;
  const only = tools[0] as { type?: unknown; function?: { name?: unknown } } | undefined;
  if (tools.length !== 1 || only?.type !== "function" || only.function?.name !== SEARCH_TOOL_NAME) {
    throw new Error(`Invariant violated: the model may only receive the single web_search tool, got ${JSON.stringify(tools)}`);
  }
}

export function createProvider(cfg: AppConfig): LlmProvider | null {
  if (!cfg.GROQ_API_KEY) return null;
  const search = cfg.TAVILY_API_KEY ? new TavilySearch(cfg.TAVILY_API_KEY, { maxResults: 5 }) : null;
  return new GroqProvider(cfg, search);
}
