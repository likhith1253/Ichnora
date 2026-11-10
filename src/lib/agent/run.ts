import type { DB } from "../db";
import {
  createConversation,
  findByRequestId,
  getConversation,
  insertMessage,
  insertMetrics,
  insertSources,
  renameConversation,
  replyTo,
  upsertMemoryItems,
  type MemoryItem,
  type Message,
  type NewMemoryItem,
} from "../db/repo";
import { DISTILL_SYSTEM, distillUserPrompt, heuristicExtract, parseDistilled } from "../memory/extract";
import { retrieve, type Intent, type Retrieval, type ToolChoice } from "../memory/retrieval";
import { formatLongDate } from "../time/dates";
import { acquireConversationLock } from "./locks";
import { buildModelRequest } from "./prompt";
import type { LlmProvider } from "./provider";
import { collectSources, type RawSource } from "./sources";

export interface TurnInput {
  workspaceId: string;
  conversationId: string;
  text: string;
  timeZone: string;
  /** Client-generated id; makes retries idempotent. */
  requestId: string;
}

export interface MemorySummary {
  intent: Intent;
  toolChoice: ToolChoice;
  referent: { id: string; title: string; baselineDate: string } | null;
  dateHits: Array<{ phrase: string; start: string; end: string; found: number; assumption?: string }>;
  ambiguous: Array<{ id: string; title: string; baselineDate: string }>;
  relatedCount: number;
  noMemoryFound: boolean;
}

export type TurnEvent =
  | { type: "start"; userMessage: Message; memory: MemorySummary; conversationTitle: string }
  | { type: "phase"; phase: "retrieving" | "thinking" | "searching" | "writing" }
  | { type: "search"; query?: string; count: number }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; message: Message; replayed?: boolean }
  | { type: "memory"; items: Array<Pick<MemoryItem, "id" | "title" | "type" | "baselineDate">> }
  | { type: "error"; code: "config" | "busy" | "model" | "timeout" | "cancelled" | "not_found"; message: string; missingVar?: string };

export interface AgentDeps {
  db: DB;
  provider: LlmProvider | null;
  missingVar?: string;
  now?: () => Date;
  timeoutMs?: number;
  /** Use a small internal model call for memory distillation (default true). */
  modelDistill?: boolean;
}

export function summarizeRetrieval(r: Retrieval): MemorySummary {
  return {
    intent: r.intent,
    toolChoice: r.toolChoice,
    referent: r.referent ? { id: r.referent.id, title: r.referent.title, baselineDate: r.referent.baselineDate } : null,
    dateHits: r.dateHits.map((h) => ({ phrase: h.ref.phrase, start: h.ref.start, end: h.ref.end, found: h.turns.length, assumption: h.ref.assumption })),
    ambiguous: r.ambiguous.map((m) => ({ id: m.id, title: m.title, baselineDate: m.baselineDate })),
    relatedCount: r.relatedTurns.length + r.memory.length,
    noMemoryFound: r.noMemoryFound,
  };
}

function errorMessage(e: unknown): { code: "model" | "timeout"; message: string } {
  const err = e as { status?: number; name?: string; message?: string };
  if (err?.name === "TimeoutError" || /timed? ?out/i.test(err?.message ?? "")) return { code: "timeout", message: "The model took too long to respond. Please try again." };
  if (err?.status === 401 || err?.status === 403 || /api[ _-]?key (not valid|invalid)|API_KEY_INVALID/i.test(err?.message ?? ""))
    return { code: "model", message: "The API key was rejected. Check the key in .env.local (it takes priority over system-wide variables) and try again." };
  if (err?.status === 429 || err?.status === 413) return { code: "model", message: "The model provider's rate limit was reached (free tiers allow only a few requests per minute). Wait about a minute and retry." };
  if (err?.status === 404) return { code: "model", message: "The configured model was not found (404). Check GROQ_MODEL in .env.local." };
  if (err?.status === 503) return { code: "model", message: "The model is overloaded right now (503). Please retry in a moment." };
  if (err?.status && err.status >= 500) return { code: "model", message: `The model provider had an error (${err.status}). Please retry.` };
  return { code: "model", message: "The model request failed. Please retry." };
}

/**
 * One user turn, end to end. Yields UI events; persists everything.
 * Order of durability: user message → (stream) → assistant message + sources
 * + metrics → memory. The conversation lock is held until memory is committed.
 */
export async function* runTurn(deps: AgentDeps, input: TurnInput, signal: AbortSignal): AsyncGenerator<TurnEvent> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  if (!deps.provider) {
    yield {
      type: "error",
      code: "config",
      missingVar: deps.missingVar,
      message: `Chat is not configured yet. Add ${deps.missingVar ?? "an API key"} to .env.local and restart \`npm run dev\`.`,
    };
    return;
  }
  const provider = deps.provider;

  let conversation = getConversation(db, input.workspaceId, input.conversationId);
  if (!conversation) conversation = createConversation(db, input.workspaceId, "New conversation", now(), input.conversationId);

  let release: (() => void) | null = null;
  try {
    release = await acquireConversationLock(conversation.id);
  } catch (e) {
    yield { type: "error", code: "busy", message: (e as Error).message };
    return;
  }

  try {
    // Idempotency: a retried request never duplicates messages.
    const existingUser = findByRequestId(db, conversation.id, input.requestId, "user");
    if (existingUser) {
      const reply = replyTo(db, existingUser);
      if (reply) {
        yield { type: "done", message: reply, replayed: true };
        return;
      }
    }

    const t0 = performance.now();
    const userMessage =
      existingUser ??
      insertMessage(db, {
        conversationId: conversation.id,
        workspaceId: input.workspaceId,
        role: "user",
        content: input.text,
        timezone: input.timeZone,
        createdAt: now(),
        clientRequestId: input.requestId,
      });
    if (conversation.title === "New conversation") {
      const title = input.text.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
      renameConversation(db, input.workspaceId, conversation.id, title);
      conversation = { ...conversation, title };
    }

    const retrieval = retrieve(db, {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      text: input.text,
      now: now(),
      timeZone: input.timeZone,
      excludeMessageId: userMessage.id,
    });
    const memoryMs = Math.round(performance.now() - t0);
    yield { type: "start", userMessage, memory: summarizeRetrieval(retrieval), conversationTitle: conversation.title };

    const request = buildModelRequest({ retrieval, userText: input.text, now: now(), timeZone: input.timeZone });
    if (request.toolChoice === "required") yield { type: "phase", phase: "searching" };
    else yield { type: "phase", phase: "thinking" };

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(new DOMException("Timed out", "TimeoutError")), deps.timeoutMs ?? 120_000);

    let text = "";
    let raw: RawSource[] = [];
    let queries: string[] = [];
    let searches = 0;
    let searchUnavailable = false;
    let modelUsed = provider.model;
    let firstTokenMs: number | null = null;
    let failure: { code: "model" | "timeout" | "cancelled"; message: string } | null = null;

    try {
      for await (const ev of provider.stream(request, ctrl.signal)) {
        if (ev.type === "text") {
          if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
          text += ev.delta;
          yield { type: "delta", text: ev.delta };
        } else if (ev.type === "search") {
          searches++;
          yield { type: "search", query: ev.query, count: searches };
        } else if (ev.type === "reset") {
          text = "";
          yield { type: "reset" };
        } else if (ev.type === "phase") {
          yield { type: "phase", phase: ev.phase };
        } else if (ev.type === "done") {
          text = ev.text || text;
          raw = ev.sources;
          queries = ev.searchQueries;
          searchUnavailable = Boolean(ev.searchUnavailable);
          if (ev.model) modelUsed = ev.model;
          searches = Math.max(searches, queries.length, raw.length > 0 ? 1 : 0);
        }
      }
    } catch (e) {
      if (signal.aborted) failure = { code: "cancelled", message: "Stopped." };
      else if (ctrl.signal.aborted) failure = { code: "timeout", message: "The model took too long to respond. Please try again." };
      else failure = errorMessage(e);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }

    if (!failure && !text.trim()) failure = { code: "model", message: "The model returned an empty answer. Please retry." };

    const finalText = text.trim();
    const createdAt = now();
    const status = failure ? (failure.code === "cancelled" ? "cancelled" : "error") : "complete";
    const assistant = insertMessage(db, {
      conversationId: conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: failure ? finalText || failure.message : finalText,
      timezone: input.timeZone,
      createdAt,
      status,
      clientRequestId: status === "complete" ? input.requestId : null,
      metadata: {
        intent: retrieval.intent,
        searched: searches > 0,
        ...(searchUnavailable ? { searchUnavailable: true } : {}),
        searchQueries: queries,
        memoryRefs: retrieval.referent ? [retrieval.referent.id] : [],
        recalledMessageIds: [
          ...new Set([
            ...retrieval.dateHits.flatMap((h) => h.turns.map((t) => t.user.id)),
            ...retrieval.referentTurns.map((t) => t.user.id),
            ...retrieval.carriedTurns.map((t) => t.user.id),
          ]),
        ].slice(0, 10),
        model: modelUsed,
        ...(failure ? { error: failure.message } : {}),
      },
    });
    const sources = collectSources(raw, finalText, createdAt.toISOString());
    insertSources(db, assistant.id, sources);
    insertMetrics(db, assistant.id, {
      intent: retrieval.intent,
      toolChoice: retrieval.toolChoice,
      searches,
      firstTokenMs,
      totalMs: Math.round(performance.now() - t0),
      memoryMs,
      model: modelUsed,
    });

    if (failure) {
      yield { type: "error", code: failure.code, message: failure.message };
      return;
    }
    yield { type: "done", message: { ...assistant, sources } };

    // Memory commit (still under the lock so the next turn can rely on it).
    if (retrieval.intent === "chat" || retrieval.intent === "recall" || retrieval.intent === "clarify") return;
    let items: NewMemoryItem[] | null = null;
    if (deps.modelDistill !== false) {
      try {
        const ac = AbortSignal.timeout(20_000);
        const json = await provider.complete(DISTILL_SYSTEM, distillUserPrompt(input.text, finalText), ac);
        items = parseDistilled(json);
      } catch {
        items = null; // fall back to deterministic extraction
      }
    }
    if (!items || items.length === 0) items = heuristicExtract(input.text, finalText, searches > 0);
    if (items.length === 0) return;
    // Without a web check, values are model recollection — never a verified baseline.
    if (searchUnavailable) {
      items = items.map((i) => ({
        ...i,
        summary: `Unverified (answered without web search): ${i.summary}`.slice(0, 800),
        facts: i.facts.map((f) => ({ ...f, value: `${f.value} (unverified)`.slice(0, 400), sourceUrl: undefined })),
      }));
    }
    // A freshness check creates a NEW dated snapshot; the old baseline stays intact.
    const saved = upsertMemoryItems(
      db,
      {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        sourceMessageIds: [userMessage.id, assistant.id],
        baselineDate: userMessage.localDate,
        now: createdAt,
      },
      items.map((i) =>
        retrieval.intent === "recall_and_verify" && retrieval.referent
          ? { ...i, summary: `${i.summary} (Re-check of "${retrieval.referent.title}" from ${formatLongDate(retrieval.referent.baselineDate)}.)`.slice(0, 800) }
          : i,
      ),
    );
    yield { type: "memory", items: saved.map((m) => ({ id: m.id, title: m.title, type: m.type, baselineDate: m.baselineDate })) };
  } finally {
    release?.();
  }
}
