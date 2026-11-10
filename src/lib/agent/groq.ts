import OpenAI from "openai";
import type { AppConfig } from "../env";
import type { Extraction, SearchProvider } from "../search/types";
import type { ModelRequest } from "./prompt";
import { assertSingleSearchTool, type LlmProvider, type ProviderEvent } from "./provider";
import { linkifyKnownUrls, resolveNumberedCitations, rewriteCitationMarkers, type RawSource } from "./sources";
import { runWebSearch, WEB_SEARCH_TOOL, type Evidence } from "./webSearchTool";
import { sharedGate, TokenGate } from "./rateGate";

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

/** search round(s) + a guaranteed final answer; 3 keeps re-sent context within free-tier TPM. */
const MAX_ROUNDS = 3;

const NO_SEARCH_NOTE = `## Web search unavailable for this turn
Live search is not available (not configured, or its free quota is used up). You have NO current web access.
- Start with one short line: "⚠️ Live web search is unavailable right now, so this is not verified against current sources."
- Answer from the memory context and general knowledge only; mark anything time-sensitive as unverified.
- For change checks, restate the saved baseline and mark every item ❓ UNABLE TO VERIFY. Never claim something changed or stayed the same.`;

const TOOL_NOTES = `## Using web_search
- Batch: put every query you need into ONE call (up to 5), e.g. one per product. Use include_domains for official sites when known and topic "news" for recent announcements.
- Cite by result number in square brackets right after the claim it supports, e.g. "Launch is $19/month [3]" or "[2, 5]". In tables, put [n] in the cell (or a Source column) of the row it supports. The app turns [n] into the exact link. Never invent numbers or URLs, and never write "(search snippet)" or "(full page)" instead of a citation.
- Use published dates in results to judge freshness; prefer dated changelog/pricing pages.
- For pricing or releases of NAMED products, set include_domains to their official domains (e.g. ["hubspot.com","pipedrive.com"]). If official results are thin, a second call without include_domains is fine.
- Label every link with its real domain or page title. Never call a third-party blog or comparison site the "official pricing page"; say what it is (e.g. "per a Pipedrive blog comparison").
- State the billing basis you saw (monthly vs annual, per seat) exactly as the source says; if a source doesn't say, write "billing basis unclear".`;

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
  // Mid-stream failures arrive without an HTTP status, so match on the text.
  return (err?.status === undefined || err.status === 400) && /tool_use_failed|tool call validation|did not match schema|did not call a tool|Tool choice is required/i.test(`${err?.message ?? ""} ${err?.error?.code ?? ""}`);
}

/**
 * Replace assistant tool_calls + tool results with one system message holding
 * the same evidence (numbers preserved), in place. Used only for the final
 * synthesis retry.
 */
export function foldToolExchange(messages: Msg[]): void {
  const evidence: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") {
      evidence.unshift(String(m.content));
      messages.splice(i, 1);
    } else if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      messages.splice(i, 1);
    }
  }
  if (evidence.length) messages.push({ role: "system", content: `Evidence gathered by web search this turn (cite by [n]):\n\n${evidence.join("\n\n")}` });
}

export function calledToolWhenNone(e: unknown): boolean {
  return /tool choice is none,? but model called a tool/i.test(String((e as { message?: string })?.message ?? ""));
}

export function evidenceToSources(evidence: Evidence[]): RawSource[] {
  return evidence.map((e) => ({
    url: e.url,
    title: e.title,
    origin: "search" as const,
    snippet: e.excerpt ? e.excerpt.slice(0, 600) : e.snippet,
    publishedDate: e.publishedDate,
    query: e.query,
    retrievedAt: e.retrievedAt,
    official: e.official,
    evidenceLevel: e.evidenceLevel,
    sourceNo: e.sourceNo,
  }));
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq" as const;
  readonly model: string;
  private client: ChatClient;
  private raw: OpenAI | null = null;

  private gate: TokenGate;

  constructor(
    private cfg: AppConfig,
    private search: SearchProvider | null,
    client?: ChatClient,
    gate?: TokenGate,
  ) {
    this.model = cfg.GROQ_MODEL;
    // Injected (test) clients get a private, unbounded gate; production shares one per process.
    this.gate = gate ?? (client ? new TokenGate(Number.MAX_SAFE_INTEGER) : sharedGate(cfg.GROQ_TPM_LIMIT));
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
    const numbered: Evidence[] = [];
    const extractions: Extraction[] = [];
    const extractBudget = { remaining: this.cfg.MAX_EXTRACTS_PER_TURN };
    const extracted = new Set<string>();
    const queries: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0, rounds: 0, waitedMs: 0 };
    // Change checks get the credit reserve; routine questions cannot drain it.
    const budgeted = this.search as (SearchProvider & { context?: { priority: "normal" | "high"; messageId: string | null } }) | null;
    if (budgeted?.context) budgeted.context.priority = req.toolChoice === "required" ? "high" : "normal";
    let searchUnavailable = req.toolChoice !== "none" && !searchAvailable;
    let text = "";

    yield { type: "phase", phase: req.toolChoice === "none" || !searchAvailable ? "thinking" : "searching" };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const canSearch = searchAvailable && !searchUnavailable && req.toolChoice !== "none" && budget.remaining > 0 && round < MAX_ROUNDS - 1;
      let choice: "auto" | "required" | "none" = canSearch ? (round === 0 && req.toolChoice === "required" ? "required" : "auto") : "none";

      text = "";
      let calls = new Map<number, { id: string; name: string; args: string }>();
      // Groq validates tool calls server-side; a malformed call can fail at
      // request time OR mid-stream. Either way: retry the round with a weaker
      // tool policy (required → auto → none) instead of failing the turn.
      for (let attempt = 0; ; attempt++) {
        calls = new Map();
        let writing = false;
        try {
          const body = buildGroqBody(messages, this.cfg, choice);
          const estimate = Math.round(JSON.stringify(body.messages).length / 4) + 800;
          usage.waitedMs += await this.gate.waitFor(estimate, signal);
          usage.rounds++;
          const t0 = Date.now();
          const stream = await this.client.create(body, signal);
          let roundTokens = 0;
          for await (const chunk of stream) {
            const u = ((chunk.x_groq as Json | undefined)?.usage ?? chunk.usage) as { prompt_tokens?: number; completion_tokens?: number } | undefined;
            if (u && typeof u.prompt_tokens === "number" && roundTokens === 0) {
              usage.promptTokens += u.prompt_tokens;
              usage.completionTokens += u.completion_tokens ?? 0;
              roundTokens = u.prompt_tokens + (u.completion_tokens ?? 0);
            }
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
          this.gate.record(roundTokens || estimate);
          // Observability: sizes and latency only — never content or keys.
          console.info(`[groq] round=${round + 1} tool_choice=${choice} tokens=${roundTokens || `~${estimate}`} ms=${Date.now() - t0}`);
          break;
        } catch (e) {
          if (signal.aborted || attempt >= 2) throw e;
          if (choice === "none" && calledToolWhenNone(e)) {
            // gpt-oss (harmony format) keeps emitting tool calls while the
            // conversation still contains tool-call structure. Fold the tool
            // exchange into plain evidence text so the final request has none.
            foldToolExchange(messages);
            messages.push({ role: "system", content: "Do not call any tools. Write the final answer now using only the evidence above, citing it as [n]." });
            if (text) yield { type: "reset" };
            text = "";
            continue;
          }
          if (!toolUseFailed(e) || choice === "none") throw e;
          choice = choice === "required" ? "auto" : "none";
          if (text) yield { type: "reset" };
          text = "";
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
        const run = await runWebSearch(c.args, this.search, { signal, seenUrls, budget, numbered, extractBudget, extracted, entities: req.entities, today: req.today });
        for (const q of run.queries) {
          queries.push(q);
          yield { type: "search", query: q };
        }
        extractions.push(...run.extractions);
        if (run.unavailable) searchUnavailable = true;
        messages.push({ role: "tool", tool_call_id: c.id, content: run.content });
      }
      if (searchUnavailable) messages[0] = { role: "system", content: `${String(messages[0]!.content)}\n\n${NO_SEARCH_NOTE}` };
      yield { type: "phase", phase: "thinking" };
    }

    const urls = numbered.map((h) => h.url);
    text = linkifyKnownUrls(resolveNumberedCitations(rewriteCitationMarkers(text, urls), urls), urls);
    yield { type: "done", text, sources: evidenceToSources(numbered), searchQueries: queries, searchUnavailable, extractions, usage };
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
