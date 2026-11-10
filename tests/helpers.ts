import { randomUUID } from "node:crypto";
import { openDatabase, type DB } from "@/lib/db";
import { buildGeminiRequest } from "@/lib/agent/gemini";
import { buildGroqRequest, type LlmProvider, type ProviderEvent } from "@/lib/agent/provider";
import type { ModelRequest } from "@/lib/agent/prompt";
import type { RawSource } from "@/lib/agent/sources";
import { runTurn, type AgentDeps, type TurnEvent } from "@/lib/agent/run";

export const TZ = "Asia/Kolkata";
/** Tuesday 10 November 2026, 15:30 IST. */
export const NOW = new Date("2026-11-10T10:00:00Z");

export interface Script {
  text: string;
  sources?: RawSource[];
  queries?: string[];
}

/**
 * Deterministic stand-in for the LLM at the provider boundary. It records each
 * request and the exact provider body that would be sent to Groq, and "searches"
 * only when the request allows tools — mimicking the real contract.
 */
export class FakeProvider implements LlmProvider {
  readonly name = "fake" as const;
  readonly model = "fake-model";
  requests: ModelRequest[] = [];
  bodies: Array<Record<string, unknown>> = [];
  geminiBodies: Array<ReturnType<typeof buildGeminiRequest>> = [];
  distillReply = ""; // empty → heuristic extraction
  constructor(private script: (req: ModelRequest) => Script = () => ({ text: "OK." })) {}

  setScript(fn: (req: ModelRequest) => Script) {
    this.script = fn;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    this.bodies.push(buildGroqRequest(req, { GROQ_MODEL: "openai/gpt-oss-120b", GROQ_REASONING_EFFORT: "medium" }));
    this.geminiBodies.push(buildGeminiRequest(req, { GEMINI_MODEL: "gemini-2.5-flash" }));
    const s = this.script(req);
    const canSearch = req.toolChoice !== "none";
    const sources = canSearch ? (s.sources ?? []) : [];
    if (canSearch) for (const q of s.queries ?? []) yield { type: "search", query: q };
    for (const chunk of s.text.match(/.{1,40}/gs) ?? []) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      yield { type: "text", delta: chunk };
    }
    yield { type: "done", text: s.text, sources, searchQueries: canSearch ? (s.queries ?? []) : [] };
  }

  async complete(): Promise<string> {
    return this.distillReply;
  }

  get last(): ModelRequest {
    return this.requests[this.requests.length - 1]!;
  }
  get lastBody(): Record<string, unknown> {
    return this.bodies[this.bodies.length - 1]!;
  }
}

export function memDb(): DB {
  return openDatabase(":memory:");
}

export function deps(db: DB, provider: LlmProvider | null, now: Date = NOW): AgentDeps {
  return { db, provider, now: () => now, missingVar: provider ? undefined : "GEMINI_API_KEY", modelDistill: true, timeoutMs: 10_000 };
}

export async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Run one real turn through the full pipeline at a fixed instant. */
export async function turn(
  db: DB,
  provider: LlmProvider | null,
  opts: { workspaceId: string; conversationId?: string; text: string; at?: Date; tz?: string; requestId?: string },
): Promise<{ events: TurnEvent[]; conversationId: string }> {
  const conversationId = opts.conversationId ?? randomUUID();
  const events = await collect(
    runTurn(
      deps(db, provider, opts.at ?? NOW),
      { workspaceId: opts.workspaceId, conversationId, text: opts.text, timeZone: opts.tz ?? TZ, requestId: opts.requestId ?? randomUUID() },
      new AbortController().signal,
    ),
  );
  return { events, conversationId };
}

export function doneText(events: TurnEvent[]): string {
  const d = events.find((e) => e.type === "done");
  return d && d.type === "done" ? d.message.content : "";
}

export function startMemory(events: TurnEvent[]) {
  const s = events.find((e) => e.type === "start");
  if (!s || s.type !== "start") throw new Error("no start event");
  return s.memory;
}

/* ----------------------------------------------------------- fixtures */

export const CRM_ANSWER = `For a 20-person sales team, here is a shortlist of 5 CRMs (checked on 9 November 2026):

| CRM | Plan for 20 reps | Price (per user/month, billed annually) | Recent release |
|---|---|---|---|
| HubSpot | Sales Hub Professional | $90 | Breeze AI agents (Sept 2026) |
| Salesforce | Sales Cloud Enterprise | $165 | Agentforce 3 (June 2026) |
| Pipedrive | Professional | $49 | Pipedrive AI email writer |
| Zoho CRM | Enterprise | $40 | Zia LLM (2026) |
| Freshsales | Pro | $39 | Freddy AI copilot |

Sources: [HubSpot pricing](https://www.hubspot.com/pricing/sales), [Salesforce pricing](https://www.salesforce.com/sales/pricing/), [Pipedrive pricing](https://www.pipedrive.com/en/pricing).`;

export const CRM_SOURCES: RawSource[] = [
  { url: "https://www.hubspot.com/pricing/sales", title: "HubSpot Sales Hub pricing", origin: "search" },
  { url: "https://www.salesforce.com/sales/pricing/", title: "Sales Cloud pricing", origin: "search" },
  { url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive pricing", origin: "search" },
];

export const PG_ANSWER = `Here's how managed Postgres hosting compares on entry pricing (checked 3 November 2026):

| Provider | Entry paid plan | Price |
|---|---|---|
| Neon | Launch | $19/month |
| Supabase | Pro | $25/month |
| AWS RDS | db.t4g.micro | ~$12/month + storage |
| Render | Basic-256mb | $6/month |

Neon and Supabase are the easiest to start with; RDS is cheapest at scale.`;
