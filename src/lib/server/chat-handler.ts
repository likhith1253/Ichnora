import { z } from "zod";
import { runTurn, type AgentDeps, type TurnEvent } from "../agent/run";
import { isValidTimeZone } from "../time/dates";
import { getConfig } from "../env";

function defaultTimeZone(): string {
  try {
    const tz = getConfig().DEFAULT_TIMEZONE;
    return isValidTimeZone(tz) ? tz : "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}
import { badRequest, ConversationId, workspaceFrom } from "./http";




const Body = z.object({
  conversationId: ConversationId,
  text: z.string().trim().min(1, "Message is empty").max(8000, "Message is too long (8000 characters max)"),
  // Optional: falls back to DEFAULT_TIMEZONE (Asia/Kolkata) when absent or invalid.
  timeZone: z.string().max(64).optional(),
  requestId: z.string().uuid(),
});

/** SSE adapter around `runTurn`. Exported for route tests with injected deps. */
export function chatHandler(getDeps: () => AgentDeps) {
  return async function POST(req: Request): Promise<Response> {
    const workspaceId = workspaceFrom(req);
    if (!workspaceId) return badRequest("Missing or invalid x-workspace-id header");
    let body: z.infer<typeof Body>;
    try {
      const parsed = Body.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      body = parsed.data;
    } catch {
      return badRequest("Body must be JSON");
    }

    const deps = getDeps();
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
          for await (const ev of runTurn(deps, { ...body, timeZone, workspaceId }, req.signal)) send(ev);
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

