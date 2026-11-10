/**
 * Deterministic evaluation harness. Computes metrics from labelled fixtures
 * (tests/eval/dataset.ts) against the real implementation. Safety invariants
 * are hard assertions; quality metrics have floors so regressions fail CI.
 * `npm run eval` also writes eval/results.json and EVALUATION.md.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createConversation, insertMessage } from "@/lib/db/repo";
import { classifyMessage } from "@/lib/personal/classify";
import { ingestUserMessage } from "@/lib/personal/store";
import { openLoops } from "@/lib/personal/queries";
import { retrieve } from "@/lib/memory/retrieval";
import { parseDateRefs, localDateOf } from "@/lib/time/dates";
import { parseDueDate } from "@/lib/time/due";
import { provenanceOf } from "@/lib/research/official";
import { compareObservations, parsePrice, type Observation } from "@/lib/research/observations";
import { answerLinks, collectSources, linkifyKnownUrls, rewriteCitationMarkers, stripUnknownLinks } from "@/lib/agent/sources";
import { CRM_ANSWER, FakeProvider, memDb, turn } from "../helpers";
import { CHANGES, CITATIONS, CLASSIFICATION, DATES, LIFECYCLE, OFFICIAL, ROUTING } from "./dataset";

const TZ = "Asia/Kolkata";
const results: Record<string, Record<string, number | string>> = {};
const failures: Record<string, string[]> = {};
const ratio = (a: number, b: number) => (b === 0 ? 1 : Math.round((a / b) * 1000) / 1000);
function record(section: string, metrics: Record<string, number | string>, fails: string[]) {
  results[section] = metrics;
  failures[section] = fails;
}

describe("A. statement classification", () => {
  it("measures commitment precision/recall, type accuracy, due dates and counterparties", () => {
    const now = new Date("2026-11-09T04:30:00Z");
    const definite = (k: string) => k === "COMMITMENT/promise" || k === "ACTION_ITEM/obligation";
    let tp = 0, fp = 0, fn = 0, exact = 0, dueOk = 0, dueN = 0, inventedDue = 0, cpOk = 0, cpN = 0;
    const fails: string[] = [];
    for (const c of CLASSIFICATION) {
      const got = classifyMessage(c.text, now, TZ).candidates;
      const kinds = got.map((g) => `${g.type}/${g.kind}`);
      const gotDef = kinds.filter(definite).length;
      const expDef = c.expect.filter(definite).length;
      tp += Math.min(gotDef, expDef);
      fp += Math.max(0, gotDef - expDef);
      fn += Math.max(0, expDef - gotDef);
      if (JSON.stringify(kinds) === JSON.stringify(c.expect)) exact++;
      else fails.push(`${c.text} → ${JSON.stringify(kinds)} (expected ${JSON.stringify(c.expect)})`);
      if (c.dueDate !== undefined) {
        dueN++;
        if ((got[0]?.dueDate ?? null) === c.dueDate) dueOk++;
        else fails.push(`due: ${c.text} → ${got[0]?.dueDate} (expected ${c.dueDate})`);
      }
      if (c.dueDate === null && got[0]?.dueDate) inventedDue++;
      if (c.counterparty !== undefined) {
        cpN++;
        if ((got[0]?.counterparty ?? null) === c.counterparty) cpOk++;
        else fails.push(`counterparty: ${c.text} → ${got[0]?.counterparty}`);
      }
    }
    const m = {
      cases: CLASSIFICATION.length,
      commitment_precision: ratio(tp, tp + fp),
      commitment_recall: ratio(tp, tp + fn),
      type_accuracy: ratio(exact, CLASSIFICATION.length),
      due_date_accuracy: ratio(dueOk, dueN),
      invented_due_dates: inventedDue,
      counterparty_accuracy: ratio(cpOk, cpN),
    };
    record("A. Statement classification", m, fails);
    expect(m.commitment_precision).toBe(1); // never invent a promise
    expect(m.invented_due_dates).toBe(0);
    expect(m.type_accuracy).toBeGreaterThanOrEqual(0.9);
  });
});

describe("B. commitment lifecycle", () => {
  it("measures completion accuracy and premature completions", () => {
    let ok = 0, premature = 0;
    const fails: string[] = [];
    for (const c of LIFECYCLE) {
      const db = memDb();
      const ws = randomUUID();
      const conv = createConversation(db, ws);
      for (const s of c.steps) {
        const at = new Date(s.at);
        const msg = insertMessage(db, { conversationId: conv.id, workspaceId: ws, role: "user", content: s.text, timezone: TZ, createdAt: at });
        ingestUserMessage(db, { workspaceId: ws, conversationId: conv.id, messageId: msg.id, text: s.text, localDate: msg.localDate, now: at, timeZone: TZ });
      }
      const L = openLoops(db, ws, localDateOf(new Date(c.steps.at(-1)!.at), TZ));
      const open = [...L.open, ...L.waiting].map((m) => m.content);
      const closed = L.recentlyClosed.map((m) => m.content);
      const openOk = c.expectOpen.every((e) => open.some((o) => o.includes(e))) && open.length === c.expectOpen.length;
      const closedOk = c.expectClosed.every((e) => closed.some((o) => o.includes(e))) && closed.length === c.expectClosed.length;
      premature += closed.filter((x) => !c.expectClosed.some((e) => x.includes(e))).length;
      if (openOk && closedOk) ok++;
      else fails.push(`${c.name}: open=${JSON.stringify(open)} closed=${JSON.stringify(closed)}`);
    }
    const m = { cases: LIFECYCLE.length, lifecycle_accuracy: ratio(ok, LIFECYCLE.length), premature_completions: premature };
    record("B. Commitment lifecycle", m, fails);
    expect(m.premature_completions).toBe(0);
    expect(m.lifecycle_accuracy).toBe(1);
  });
});

describe("C. routing (intent + search decision)", () => {
  it("measures intent accuracy and unnecessary/missed search rates", async () => {
    const db = memDb();
    const ws = randomUUID();
    const p = new FakeProvider(() => ({ text: CRM_ANSWER }));
    await turn(db, new FakeProvider(() => ({ text: "Node.js 24 is the active LTS (24.11.0) per nodejs.org.", queries: ["node"] })), { workspaceId: ws, text: "What is the latest Node.js LTS version?", at: new Date("2026-11-02T20:00:00Z") });
    await turn(db, p, { workspaceId: ws, text: "We're a 20-person sales team. Shortlist 5 CRM tools with pricing.", at: new Date("2026-11-09T06:30:00Z") });
    await turn(db, p, { workspaceId: ws, text: "I'll send the proposal to Rahul by Friday. We will use MongoDB for the database.", at: new Date("2026-11-09T07:00:00Z") });
    await turn(db, p, { workspaceId: ws, text: "We have finalized PostgreSQL.", at: new Date("2026-11-09T08:00:00Z") });
    const now = new Date("2026-11-10T10:00:00Z");
    let intentOk = 0, noneN = 0, unnecessary = 0, reqN = 0, missed = 0;
    const fails: string[] = [];
    for (const c of ROUTING) {
      const r = retrieve(db, { workspaceId: ws, conversationId: randomUUID(), text: c.text, now, timeZone: TZ });
      if (r.intent === c.intent) intentOk++;
      else fails.push(`${c.text} → ${r.intent}/${r.toolChoice} (expected ${c.intent}/${c.toolChoice})`);
      if (c.toolChoice === "none") {
        noneN++;
        if (r.toolChoice !== "none") unnecessary++;
      }
      if (c.toolChoice === "required") {
        reqN++;
        if (r.toolChoice !== "required") missed++;
      }
    }
    const m = { cases: ROUTING.length, intent_accuracy: ratio(intentOk, ROUTING.length), unnecessary_search_rate: ratio(unnecessary, noneN), missed_required_search_rate: ratio(missed, reqN) };
    record("C. Routing", m, fails);
    expect(m.unnecessary_search_rate).toBe(0);
    expect(m.missed_required_search_rate).toBe(0);
    expect(m.intent_accuracy).toBeGreaterThanOrEqual(0.9);
  });
});

describe("D. temporal resolution", () => {
  it("measures date accuracy across timezones and deadline phrasing", () => {
    let ok = 0;
    const fails: string[] = [];
    for (const c of DATES) {
      const now = new Date(c.nowIso);
      const got = c.kind === "past" ? (parseDateRefs(c.text, now, c.tz)[0]?.start ?? null) : (parseDueDate(c.text, now, c.tz)?.date ?? null);
      if (got === c.expect) ok++;
      else fails.push(`${c.text} @${c.nowIso} ${c.tz} → ${got} (expected ${c.expect})`);
    }
    const m = { cases: DATES.length, temporal_accuracy: ratio(ok, DATES.length) };
    record("D. Temporal resolution", m, fails);
    expect(m.temporal_accuracy).toBe(1);
  });
});

describe("E. official-source labelling", () => {
  it("measures official precision and recall", () => {
    let tp = 0, fp = 0, fn = 0;
    const fails: string[] = [];
    for (const c of OFFICIAL) {
      const got = provenanceOf(c.url, c.entities).official;
      if (got && c.official) tp++;
      else if (got && !c.official) {
        fp++;
        fails.push(`false official: ${c.url}`);
      } else if (!got && c.official) {
        fn++;
        fails.push(`missed official: ${c.url}`);
      }
    }
    const m = { cases: OFFICIAL.length, official_precision: ratio(tp, tp + fp), official_recall: ratio(tp, tp + fn) };
    record("E. Official-source labelling", m, fails);
    expect(m.official_precision).toBe(1); // never call a third-party page official
    expect(m.official_recall).toBeGreaterThanOrEqual(0.9);
  });
});

describe("F. citation validity", () => {
  it("every rendered citation resolves to a returned source; unknown URLs are dropped", () => {
    let valid = 0, total = 0, unsupportedShownAsEvidence = 0, ok = 0;
    const fails: string[] = [];
    for (const c of CITATIONS) {
      // Full post-processing pipeline: marker rewrite → bare-URL linkify → unknown-link stripping.
      const out = stripUnknownLinks(linkifyKnownUrls(rewriteCitationMarkers(c.text, c.known), c.known), c.known).text;
      const links = answerLinks(out).map((l) => l.url);
      const sources = collectSources(c.known.map((url) => ({ url, origin: "search" as const })), out, "2026-11-10T00:00:00Z");
      const asEvidence = sources.filter((s) => s.origin !== "answer_link").map((s) => s.url);
      for (const l of links) {
        total++;
        if (c.known.includes(l)) valid++;
      }
      unsupportedShownAsEvidence += asEvidence.filter((u) => !c.known.includes(u)).length;
      const expectedValid = c.validLinks.every((v) => links.includes(v));
      if (expectedValid && !out.includes("【")) ok++;
      else fails.push(`${c.text} → ${out}`);
    }
    const m = { cases: CITATIONS.length, case_accuracy: ratio(ok, CITATIONS.length), rendered_link_validity: ratio(valid, total), unsupported_sources_shown_as_evidence: unsupportedShownAsEvidence };
    record("F. Citation validity", m, fails);
    expect(m.unsupported_sources_shown_as_evidence).toBe(0);
    expect(m.case_accuracy).toBe(1);
    expect(m.rendered_link_validity).toBe(1);
  });
});

describe("G. change detection", () => {
  it("classifies CHANGED / NO MATERIAL CHANGE / UNABLE TO VERIFY like-for-like", () => {
    const today = "2026-11-10";
    const mk = (o: { raw: string; tier?: string; header?: string; evidence?: Observation["evidenceLevel"]; effective?: string }, date: string): Observation => ({
      entity: "X", entityNorm: "x", attribute: "price", rawValue: o.raw, ...parsePrice(o.raw, o.header ?? ""), tier: o.tier ?? null,
      effectiveDate: o.effective ?? null, sourceUrl: "https://x.com/pricing", sourcePublished: null, evidenceLevel: o.evidence ?? "full_page", observedOn: date,
    });
    let ok = 0, falseNoChange = 0;
    const fails: string[] = [];
    for (const c of CHANGES) {
      const [row] = compareObservations([mk(c.then, "2026-11-03")], c.now ? [mk(c.now, today)] : [], today);
      if (row!.status === c.expect) ok++;
      else fails.push(`${c.name} → ${row!.status} (${row!.reason}); expected ${c.expect}`);
      if (row!.status === "NO_MATERIAL_CHANGE" && c.expect !== "NO_MATERIAL_CHANGE") falseNoChange++;
    }
    const m = { cases: CHANGES.length, change_detection_accuracy: ratio(ok, CHANGES.length), false_no_change: falseNoChange };
    record("G. Change detection", m, fails);
    expect(m.false_no_change).toBe(0); // absence of evidence is never "no change"
    expect(m.change_detection_accuracy).toBe(1);
  });
});

afterAll(() => {
  if (!process.env.EVAL_WRITE) return;
  const root = path.resolve(__dirname, "../..");
  fs.mkdirSync(path.join(root, "eval"), { recursive: true });
  fs.writeFileSync(path.join(root, "eval", "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results, failures }, null, 2));
  const lines = [
    "# Evaluation results",
    "",
    `Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)} from the labelled fixtures in \`tests/eval/dataset.ts\`. Deterministic: no network, no API keys. Numbers are computed, not entered by hand. Live behaviour against Groq and Tavily is reported separately in \`eval/live.md\`.`,
    "",
  ];
  for (const [section, m] of Object.entries(results)) {
    lines.push(`## ${section}`, "", "| Metric | Value |", "|---|---|", ...Object.entries(m).map(([k, v]) => `| ${k.replace(/_/g, " ")} | ${v} |`), "");
    const f = failures[section] ?? [];
    lines.push(f.length ? `Failures (${f.length}):\n${f.map((x) => `- ${x}`).join("\n")}\n` : "No failures.\n");
  }
  fs.writeFileSync(path.join(root, "EVALUATION.md"), lines.join("\n"));
});
