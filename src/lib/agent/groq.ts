import OpenAI from "openai";
import type { AppConfig } from "../env";
import type { SearchHit, SearchProvider } from "../search/types";
import type { ModelRequest } from "./prompt";
import { assertSingleSearchTool, type LlmProvider, type ProviderEvent } from "./provider";
import type { RawSource } from "./sources";
import { runWebSearch, WEB_SEARCH_TOOL } from "./webSearchTool";

/**
 * Groq chat-completions adapter (OpenAI-compatible API) running a bounded
 * tool loop: the model may call `web_search` (our only tool), we execute it via
 * the search layer, feed results back, and stream the final answer.
 */

type Json = Record<string, unknown>;
type Msg = Json;

/** Minimal client surface — lets tests inject a scripted Groq. */
export interface ChatClient {
  create(body: Json, signal: AbortSignal): Promise<AsyncIterable<Json>>;
}

const MAX_ROUNDS = 4;

const NO_SEARCH_NOTE = `## Web search unavailable for this turn
Live search is not available (not configured, or its free quota is used up). You have NO current web access.
- Start with one short line: "⚠️ Live web search is unavailable right now, so this is not verified against current sources."
- Answer from the memory context and general knowledge only; mark anything time-sensitive as unverified.
- For change checks, restate the saved baseline and mark every item ❓ Cannot verify. Never claim something changed or stayed the same.`;

const TOOL_NOTES = `## Using web_search
- Batch: put every query you need into ONE call (up to 4), e.g. one per product. Use include_domains for official sites when known and topic "news" for recent announcements.
- Cite with Markdown links using the exact URLs returned. Never cite a URL that was not returned.
- Use published dates in results to judge freshness; prefer dated changelog/pricing pages.`;

export function buildGroqMessages(req: ModelRequest, searchAvailable: boolean): Msg[] {
  const wantsSearch = req.toolChoice !== "none";
  const system = `${req.system}\n\n${wantsSearch ? (searchAvailable ? TOOL_NOTES : NO_SEARCH_NOTE) : ""}`.trim();
  const messages: Msg[] = [{ role: "system", content: system }];
  if (req.memoryContext) messages.push({ role: "system", content: req.memoryContext });
  for (const t of req.history) messages.push({ role: t.role, content: t.content });
  messages.push({ role: "user", content: req.user });
  return messages;
}

export function buildGroqBody(
  messages: Msg[],
  cfg: Pick<AppConfig, "GROQ_MODEL" | "GROQ_REASONING_EFFORT">,
  toolChoice: "auto" | "required" | "none",
): Json {
  const effort = toolChoice === "required" && cfg.GROQ_REASONING_EFFORT === "low" ? "medium" : cfg.GROQ_REASONING_EFFORT;
  const body: Json = {
    model: cfg.GROQ_MODEL,
    messages,
    stream: true,
    temperature: 0.3,
    max_completion_tokens: 3000,
    reasoning_effort: effort,
  };
  if (toolChoice !== "none") {
    const tools = [WEB_SEARCH_TOOL];
    assertSingleSearchTool(tools);
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  return body;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toolUseFailed(e: unknown): boolean {
  const err = e as { status?: number; message?: string; error?: { code?: string } };
  return err?.status === 400 && /tool_use_failed|tool call validation|did not call a tool|Tool choice is required/i.test(`${err.message ?? ""} ${err.error?.code ?? ""}`);
}

export function hitsToSources(hits: SearchHit[]): RawSource[] {
  return hits.map((h) => ({
    url: h.url,
    title: h.title,
    origin: "search" as const,
    snippet: h.snippet,
    publishedDate: h.publishedDate,
    query: h.query,
    retrievedAt: h.retrievedAt,
  }));
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq" as const;
  readonly model: string;
  private client: ChatClient;
  private raw: OpenAI | null = null;

  constructor(
    private cfg: AppConfig,
    private search: SearchProvider | null,
    client?: ChatClient,
  ) {
    this.model = cfg.GROQ_MODEL;
    if (client) this.client = client;
    else {
      const raw = new OpenAI({ apiKey: cfg.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1", maxRetries: 2, timeout: cfg.AGENT_TIMEOUT_MS });
      this.raw = raw;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client = { create: (body, signal) => raw.chat.completions.create(body as any, { signal }) as unknown as Promise<AsyncIterable<Json>> };
    }
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const searchAvailable = this.search !== null;
    const messages = buildGroqMessages(req, searchAvailable);
    const budget = { remaining: this.cfg.MAX_SEARCHES_PER_TURN };
    const seenUrls = new Set<string>();
    const hits: SearchHit[] = [];
    const queries: string[] = [];
    let searchUnavailable = req.toolChoice !== "none" && !searchAvailable;
    let text = "";

    yield { type: "phase", phase: req.toolChoice === "none" || !searchAvailable ? "thinking" : "searching" };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const canSearch = searchAvailable && !searchUnavailable && req.toolChoice !== "none" && budget.remaining > 0 && round < MAX_ROUNDS - 1;
      let choice: "auto" | "required" | "none" = canSearch ? (round === 0 && req.toolChoice === "required" ? "required" : "auto") : "none";

      let stream: AsyncIterable<Json> | null = null;
      for (let attempt = 0; attempt < 3 && !stream; attempt++) {
        try {
          stream = await this.client.create(buildGroqBody(messages, this.cfg, choice), signal);
        } catch (e) {
          if (signal.aborted || !toolUseFailed(e) || choice === "none") throw e;
          choice = choice === "required" ? "auto" : "none"; // degrade, don't fail the turn
        }
      }

      text = "";
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let writing = false;
      for await (const chunk of stream!) {
        const delta = ((chunk.choices as Json[] | undefined)?.[0]?.delta ?? {}) as Json;
        const content = str(delta.content);
        if (content) {
          if (!writing) {
            writing = true;
            yield { type: "phase", phase: "writing" };
          }
          text += content;
          yield { type: "text", delta: content };
        }
        for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as Json[]) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const prev = calls.get(idx) ?? { id: "", name: "", args: "" };
          const fn = (tc.function ?? {}) as Json;
          calls.set(idx, {
            id: str(tc.id) ?? prev.id,
            name: prev.name + (str(fn.name) ?? ""),
            args: prev.args + (typeof fn.arguments === "string" ? fn.arguments : ""),
          });
        }
      }

      if (calls.size === 0) break; // final answer

      // Tool round: discard any pre-tool chatter from the visible answer.
      if (text) yield { type: "reset" };
      text = "";
      const list = [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: list.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
      });
      yield { type: "phase", phase: "searching" };
      for (const c of list) {
        if (c.name !== "web_search" || !this.search) {
          messages.push({ role: "tool", tool_call_id: c.id, content: `Unknown tool "${c.name}". The only tool is web_search.` });
          continue;
        }
        const run = await runWebSearch(c.args, this.search, { signal, seenUrls, budget });
        for (const q of run.queries) {
          queries.push(q);
          yield { type: "search", query: q };
        }
        hits.push(...run.hits);
        if (run.unavailable) searchUnavailable = true;
        messages.push({ role: "tool", tool_call_id: c.id, content: run.content });
      }
      if (searchUnavailable) messages[0] = { role: "system", content: `${String(messages[0]!.content)}\n\n${NO_SEARCH_NOTE}` };
      yield { type: "phase", phase: "thinking" };
    }

    yield { type: "done", text, sources: hitsToSources(hits), searchQueries: queries, searchUnavailable };
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    if (!this.raw) return "";
    const res = await this.raw.chat.completions.create(
      {
        model: this.cfg.GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_completion_tokens: 1500,
        response_format: { type: "json_object" },
        reasoning_effort: "low",
      },
      { signal },
    );
    return res.choices[0]?.message?.content ?? "";
  }
}
