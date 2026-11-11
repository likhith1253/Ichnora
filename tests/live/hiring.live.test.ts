/**
 * LIVE evaluation of the three hiring-challenge examples (+ open loops) against
 * the real Groq model and Tavily search, using a throwaway SQLite file.
 * Historical turns are produced by the real agent with a backdated clock, then
 * the follow-up runs "today". Writes eval/live.md with what actually happened.
 *
 * Costs (approx.): ~25–40 Tavily credits, ~10 Groq requests. Run: npm run eval:live
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "@/lib/db";
import { listMessages, type Message } from "@/lib/db/repo";
import { getConfig } from "@/lib/env";
import { createProvider } from "@/lib/agent/provider";
import { runTurn, type TurnEvent } from "@/lib/agent/run";

const cfg = getConfig();
const enabled = Boolean(cfg.GROQ_API_KEY && cfg.TAVILY_API_KEY);
const TZ = "Asia/Kolkata";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-live-"));
const db: DB = openDatabase(path.join(dir, "live.db"));
const report: string[] = [];

interface Result {
  events: TurnEvent[];
  msg: Message | null;
  ms: number;
  conversationId: string;
}

async function ask(ws: string, text: string, at?: Date, conversationId = randomUUID()): Promise<Result> {
  const t0 = Date.now();
  const events: TurnEvent[] = [];
  const deps = { db, provider: createProvider(cfg, db), now: () => at ?? new Date(), timeoutMs: 240_000, modelDistill: false };
  for await (const e of runTurn(deps, { workspaceId: ws, conversationId, text, timeZone: TZ, requestId: randomUUID() }, new AbortController().signal)) events.push(e);
  const msg = listMessages(db, conversationId).filter((m) => m.role === "assistant").at(-1) ?? null;
  const ms = Date.now() - t0;
  const start = events.find((e) => e.type === "start");
  const err = events.find((e) => e.type === "error");
  const metrics = db.prepare("SELECT prompt_tokens, completion_tokens, search_credits, rounds FROM turn_metrics WHERE message_id = ?").get(msg?.id ?? "") as
    | { prompt_tokens: number | null; completion_tokens: number | null; search_credits: number | null; rounds: number | null }
    | undefined;
  const srcs = msg?.sources ?? [];
  report.push(
    `### "${text}"${at ? ` _(asked as of ${at.toISOString().slice(0, 16)}Z)_` : ""}`,
    "",
    `- intent: \`${start && start.type === "start" ? start.memory.intent : "?"}\`, tool_choice: \`${start && start.type === "start" ? start.memory.toolChoice : "?"}\`${start && start.type === "start" && start.memory.referent ? `, referent: “${start.memory.referent.title.slice(0, 70)}” (${start.memory.referent.baselineDate})` : ""}`,
    `- latency: ${(ms / 1000).toFixed(1)} s · rounds: ${metrics?.rounds ?? "-"} · tokens in/out: ${metrics?.prompt_tokens ?? "-"}/${metrics?.completion_tokens ?? "-"} · search credits: ${metrics?.search_credits ?? 0}`,
    `- searches: ${JSON.stringify(msg?.metadata.searchQueries ?? [])}`,
    `- sources: ${srcs.length} (${srcs.filter((s) => s.official).length} official, ${srcs.filter((s) => s.evidenceLevel === "full_page").length} read in full, ${srcs.filter((s) => s.origin === "citation").length} cited) · claim coverage: ${msg?.metadata.claimCoverage ?? "n/a"}`,
    ...(msg?.metadata.changeReport
      ? [
          `- computed change report (baseline ${(msg.metadata.changeReport as { baselineDate: string }).baselineDate}):`,
          ...((msg.metadata.changeReport as { rows: Array<{ entity: string; status: string; reason: string }> }).rows.map((r) => `  - ${r.entity}: **${r.status}** — ${r.reason}`)),
        ]
      : []),
    err && err.type === "error" ? `- ERROR: ${err.code} ${err.message}` : "",
    "",
    "<details><summary>Answer</summary>",
    "",
    (msg?.content ?? "(none)").slice(0, 4000),
    "",
    "</details>",
    "",
  );
  return { events, msg, ms, conversationId };
}

const intent = (r: Result) => {
  const s = r.events.find((e) => e.type === "start");
  return s && s.type === "start" ? s.memory : null;
};

describe.runIf(enabled)("live: hiring examples", () => {
  it("Example 1 — Monday CRM shortlist → has any of them changed?", async () => {
    const ws = randomUUID();
    report.push("## Example 1 — CRM shortlist change check", "");
    const seed = await ask(ws, "We're a 20-person sales team. Shortlist 5 CRM tools with their current per-user pricing for a suitable plan.", new Date("2026-11-09T05:00:00Z"));
    expect(seed.msg?.status).toBe("complete");
    const r = await ask(ws, "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
    expect(intent(r)).toMatchObject({ intent: "recall_and_verify", toolChoice: "required" });
    expect(r.msg?.metadata.searched).toBe(true);
  });

  it("Example 2 — 3 November exact recall → still correct today?", async () => {
    const ws = randomUUID();
    report.push("## Example 2 — exact recall and re-verification", "");
    await ask(ws, "What is the latest LTS version of Node.js?", new Date("2026-11-02T20:00:00Z")); // 01:30 IST on 3 Nov
    const conv = randomUUID();
    const r1 = await ask(ws, "What did I ask you on 3 November?", undefined, conv);
    expect(intent(r1)).toMatchObject({ intent: "recall", toolChoice: "none" });
    expect(r1.msg?.content).toContain("What is the latest LTS version of Node.js?");
    const r2 = await ask(ws, "Is your answer still correct today?", undefined, conv);
    expect(intent(r2)).toMatchObject({ intent: "recall_and_verify", toolChoice: "required" });
  });

  it("Example 3 — last Tuesday's Postgres hosting → has pricing changed?", async () => {
    const ws = randomUUID();
    report.push("## Example 3 — Postgres hosting pricing", "");
    // "Last Tuesday" relative to the real run date (most recent Tuesday before today, IST).
    const today = new Date(Date.now() + 5.5 * 3600_000);
    const back = ((today.getUTCDay() - 2 + 7) % 7) || 7;
    const lastTuesday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back, 6, 0, 0));
    await ask(ws, "I need managed Postgres hosting for a side project. Compare entry pricing for Neon, Supabase and Render.", lastTuesday);
    const r = await ask(ws, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(intent(r)).toMatchObject({ intent: "recall_and_verify", toolChoice: "required" });
  });

  it("Open loops and no-memory honesty", async () => {
    const ws = randomUUID();
    report.push("## Open loops, decisions and honesty", "");
    await ask(ws, "I'll send the project proposal to Rahul by Friday, and I might email Priya about the budget.", new Date("2026-11-09T05:00:00Z"));
    await ask(ws, "We will use MongoDB for the database.", new Date("2026-11-03T05:00:00Z"));
    await ask(ws, "After comparing the databases, PostgreSQL seems better because we need joins.", new Date("2026-11-05T05:00:00Z"));
    await ask(ws, "We have finalized PostgreSQL.", new Date("2026-11-07T05:00:00Z"));
    const loops = await ask(ws, "What commitments do I have?");
    expect(intent(loops)?.intent).toBe("open_loops");
    const dec = await ask(ws, "How has my thinking about the database changed?");
    expect(intent(dec)?.intent).toBe("decision_history");
    const none = await ask(ws, "What did I ask you on 20 October?");
    expect(intent(none)).toMatchObject({ intent: "recall", noMemoryFound: true });
  });
});

afterAll(() => {
  if (!enabled) return;
  const out = [
    "# Live evaluation (real Groq + Tavily)",
    "",
    `Run on ${new Date().toISOString()} with model \`${cfg.GROQ_MODEL}\` and Tavily basic search/extract on free tiers. Historical turns were produced by the real agent with a backdated clock; follow-ups ran at real time. Answers are reproduced verbatim (truncated).`,
    "",
    ...report,
  ].join("\n");
  fs.mkdirSync(path.resolve(__dirname, "../../eval"), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, "../../eval/live.md"), out);
  db.close();
});
