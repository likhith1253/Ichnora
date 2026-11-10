import { z } from "zod";
import { runTurn, type AgentDeps, type TurnEvent } from "../agent/run";
import { isValidTimeZone } from "../time/dates";
import { getConfig } from "../env";
import { addCredits, consumeTurn } from "../demo/budget";
import { demoPromptTexts, promptKey } from "../demo/prompts";
import { getCachedDemoAnswer, putCachedDemoAnswer, type DemoAnswer } from "../demo/store";
import { badRequest, ConversationId } from "./http";
import { resolveWorkspace } from "./identity";

function defaultTimeZone(): string {
  try {
    const tz = getConfig().DEFAULT_TIMEZONE;
    return isValidTimeZone(tz) ? tz : "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

const Body = z.object({
  conversationId: ConversationId,
  text: z.string().trim().min(1, "Message is empty").max(8000, "Message is too long (8000 characters max)"),
  // Optional: falls back to DEFAULT_TIMEZONE (Asia/Kolkata) when absent or invalid.
  timeZone: z.string().max(64).optional(),
  requestId: z.string().uuid(),
});

const SUGGESTED = new Set(demoPromptTexts().map(promptKey));

/** SSE adapter around `runTurn`. Exported for route tests with injected deps. */
export function chatHandler(getDeps: () => AgentDeps) {
  return async function POST(req: Request): Promise<Response> {
    const deps = getDeps();
    const cfg = getConfig();
    const id = resolveWorkspace(req, deps.db, cfg);
    if (!id.ok) return id.response;

    let body: z.infer<typeof Body>;
    try {
      const parsed = Body.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      body = parsed.data;
    } catch {
      return badRequest("Body must be JSON");
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (ev: TurnEvent) => {
          try {
            controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
          } catch {
            /* client went away */
          }
        };
        try {
          const timeZone = body.timeZone && isValidTimeZone(body.timeZone) ? body.timeZone : defaultTimeZone();

          // Demo budgets: replay a cached answer for free, otherwise reserve one
          // model turn. When the allowance is spent, memory and history still work.
          let cached: DemoAnswer | undefined;
          if (id.demo) {
            cached = getCachedDemoAnswer(deps.db, body.text) ?? undefined;
            if (!cached) {
              const spend = consumeTurn(deps.db, id.workspaceId, cfg);
              if (!spend.ok) {
                send({
                  type: "error",
                  code: "budget",
                  message: `This demo's live budget is spent (${spend.budget.turnsMax} answers, ${spend.budget.creditsMax} searches). Memory, open loops and history still work below — or sign in to keep your own data.`,
                });
                return;
              }
            }
          }

          for await (const ev of runTurn(deps, { ...body, timeZone, workspaceId: id.workspaceId, cached }, req.signal)) {
            send(ev);
            if (ev.type === "done" && id.demo) {
              const meta = ev.message.metadata;
              const searches = Array.isArray(meta.searchQueries) ? meta.searchQueries.length : 0;
              const pagesRead = typeof meta.pagesRead === "number" ? meta.pagesRead : 0;
              addCredits(deps.db, id.workspaceId, searches + Math.ceil(pagesRead / 5));
              if (!cached && SUGGESTED.has(promptKey(body.text))) {
                putCachedDemoAnswer(
                  deps.db,
                  body.text,
                  {
                    text: ev.message.content,
                    sources: ev.message.sources.map((s) => ({
                      url: s.url,
                      title: s.title,
                      origin: s.origin === "answer_link" ? "citation" : s.origin,
                      snippet: s.snippet ?? null,
                      publishedDate: s.publishedDate ?? null,
                      query: s.query ?? null,
                      retrievedAt: s.retrievedAt,
                      official: s.official ?? false,
                      evidenceLevel: s.evidenceLevel ?? "snippet",
                      sourceNo: s.sourceNo ?? undefined,
                    })),
                    searched: meta.searched,
                    searchQueries: meta.searchQueries,
                    model: meta.model,
                  },
                  cfg,
                );
              }
            }
          }
        } catch (e) {
          console.error("[chat] turn failed:", (e as Error).message);
          send({ type: "error", code: "model", message: "Something went wrong while answering. Please retry." });
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
