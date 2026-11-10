import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConversation, insertMessage } from "@/lib/db/repo";
import { classifyMessage } from "@/lib/personal/classify";
import { correctMemory, ingestUserMessage } from "@/lib/personal/store";
import { decisionTimeline, eventsOf, linksOf, listPersonalMemories, openLoops } from "@/lib/personal/queries";
import { parseDueDate } from "@/lib/time/due";
import { localDateOf } from "@/lib/time/dates";
import { memDb, TZ } from "./helpers";

// Monday 9 Nov 2026, 10:00 IST
const MON = new Date("2026-11-09T04:30:00Z");
const at = (iso: string) => new Date(iso);

function setup() {
  const db = memDb();
  const ws = randomUUID();
  const conv = createConversation(db, ws);
  const say = (text: string, when: Date = MON, conversationId = conv.id) => {
    const m = insertMessage(db, { conversationId, workspaceId: ws, role: "user", content: text, timezone: TZ, createdAt: when });
    return ingestUserMessage(db, { workspaceId: ws, conversationId, messageId: m.id, text, localDate: m.localDate, now: when, timeZone: TZ });
  };
  return { db, ws, conv, say };
}

describe("due dates (future-aware, never invented)", () => {
  it.each([
    ["I'll send it by Friday", "2026-11-13"],
    ["due next Monday", "2026-11-16"],
    ["by tomorrow", "2026-11-10"],
    ["by end of week", "2026-11-13"],
    ["by end of the month", "2026-11-30"],
    ["before 20 Nov", "2026-11-20"],
    ["by Nov 3", "2027-11-03"],
  ])("%s → %s", (s, d) => expect(parseDueDate(s, MON, TZ)?.date).toBe(d));
  it("a bare weekday mention without a deadline cue is not a due date", () => {
    expect(parseDueDate("I met Rahul Friday and he was great", MON, TZ)).toBeNull();
    expect(parseDueDate("I'll send the proposal to Rahul", MON, TZ)).toBeNull();
  });
  it("respects the user's timezone at midnight", () => {
    const late = at("2026-11-09T19:00:00Z"); // already Tuesday 00:30 in IST
    expect(localDateOf(late, TZ)).toBe("2026-11-10");
    expect(parseDueDate("by tomorrow", late, TZ)?.date).toBe("2026-11-11");
  });
});

describe("statement classification (intent classes)", () => {
  const kinds = (t: string) => classifyMessage(t, MON, TZ).candidates.map((c) => `${c.type}/${c.kind}/${c.status}`);
  it("explicit promise with owner, recipient and due date", () => {
    const [c] = classifyMessage("I'll send the project proposal to Rahul by Friday.", MON, TZ).candidates;
    expect(c).toMatchObject({ type: "COMMITMENT", kind: "promise", status: "OPEN", owner: "user", counterparty: "Rahul", dueDate: "2026-11-13", evidence: "explicit" });
    expect(c!.content).toBe("Send the project proposal to Rahul");
    expect(c!.quote).toBe("I'll send the project proposal to Rahul by Friday.");
  });
  it("hedged language is an intention, never a promise", () => {
    expect(kinds("I might email Rahul about the budget.")).toEqual(["ACTION_ITEM/intention/CONSIDERING"]);
    expect(kinds("Maybe I'll call the bank next week.")).toEqual(["ACTION_ITEM/intention/CONSIDERING"]);
  });
  it("hypotheticals and questions create nothing", () => {
    expect(kinds("If I had more time, I would rewrite the backend.")).toEqual([]);
    expect(kinds("Should I email Rahul?")).toEqual([]);
  });
  it("obligations and plans are distinguished from promises", () => {
    expect(kinds("I need to renew my passport by 20 Nov.")).toEqual(["ACTION_ITEM/obligation/OPEN"]);
    expect(kinds("I plan to refactor the auth module.")).toEqual(["ACTION_ITEM/intention/OPEN"]);
  });
  it("tasks owed by others become WAITING items", () => {
    expect(kinds("I'm waiting for Priya to send the contract.")).toEqual(["FOLLOW_UP/waiting/WAITING"]);
    expect(kinds("I asked Arjun to review the deck by Thursday.")).toEqual(["FOLLOW_UP/waiting/WAITING"]);
  });
  it("no deadline stated → no deadline stored", () => {
    expect(classifyMessage("I'll email Rahul the slides.", MON, TZ).candidates[0]!.dueDate).toBeNull();
  });
  it("completed activity is evidence, not a new task", () => {
    const r = classifyMessage("I sent Rahul the report yesterday.", MON, TZ);
    expect(r.candidates).toEqual([]);
    expect(r.signals[0]).toMatchObject({ kind: "completion", verbGroup: "send", eventDate: "2026-11-08" });
  });
  it("decisions: chosen / considering / rejected", () => {
    expect(kinds("We will use MongoDB.")).toEqual(["DECISION/chosen/ACTIVE"]);
    expect(kinds("After comparing the databases, PostgreSQL seems better.")).toEqual(["DECISION/considering/CONSIDERING"]);
    expect(kinds("We have ruled out MySQL.")).toEqual(["DECISION/rejected/ACTIVE"]);
  });
  it("preferences and facts", () => {
    expect(kinds("I prefer dark mode in every editor.")).toEqual(["PREFERENCE/like/ACTIVE"]);
    expect(kinds("Our team has 20 sales reps.")).toEqual(["FACT/stated/ACTIVE"]);
    expect(kinds("Rahul is my manager.")).toEqual(["RELATIONSHIP/stated/ACTIVE"]);
  });
});

describe("commitment lifecycle", () => {
  it("completion evidence closes the matching commitment and is linked", () => {
    const { db, ws, say } = setup();
    const opened = say("I'll send Rahul the report by Friday.").created[0]!;
    const res = say("I sent Rahul the report yesterday.", at("2026-11-11T06:00:00Z"));
    expect(res.transitions).toHaveLength(1);
    expect(res.transitions[0]).toMatchObject({ from: "OPEN", to: "COMPLETED" });
    const links = linksOf(db, opened.id);
    expect(links.find((l) => l.relation === "COMPLETED_BY")).toBeTruthy();
    expect(eventsOf(db, opened.id).map((e) => e.action)).toEqual(["created", "status_changed"]);
    expect(openLoops(db, ws, "2026-11-11").open).toHaveLength(0);
    expect(openLoops(db, ws, "2026-11-11").recentlyClosed[0]!.id).toBe(opened.id);
  });

  it("a merely related conversation does not complete a task", () => {
    const { db, ws, say } = setup();
    say("I'll send Rahul the report by Friday.");
    say("Rahul's report looks long, I sent a meme to Kiran.", at("2026-11-10T06:00:00Z"));
    expect(openLoops(db, ws, "2026-11-10").open).toHaveLength(1);
  });

  it("ambiguous completion evidence is logged, not applied", () => {
    const { db, ws, say } = setup();
    say("I'll send the invoice to Rahul.");
    say("I'll send the invoice to Meera.");
    say("I sent the invoice.", at("2026-11-10T06:00:00Z"));
    expect(openLoops(db, ws, "2026-11-10").open).toHaveLength(2);
  });

  it("repeating a commitment reinforces it instead of duplicating; due-date change is recorded", () => {
    const { db, ws, say } = setup();
    const first = say("I'll send the deck to Rahul by Friday.").created[0]!;
    const again = say("Reminder to myself: I'll send the deck to Rahul by Thursday.", at("2026-11-10T04:30:00Z"));
    expect(again.created).toHaveLength(0);
    expect(again.reinforced[0]!.id).toBe(first.id);
    const loops = openLoops(db, ws, "2026-11-10");
    expect(loops.open).toHaveLength(1);
    expect(loops.open[0]).toMatchObject({ mentionCount: 2, dueDate: "2026-11-12" });
    expect(eventsOf(db, first.id)[1]!.note).toMatch(/due date changed 2026-11-13 → 2026-11-12/);
  });

  it("an intention firms into a promise on repetition", () => {
    const { db, ws, say } = setup();
    say("I might email Rahul the budget.");
    say("I'll email Rahul the budget tomorrow.", at("2026-11-10T04:30:00Z"));
    const loops = openLoops(db, ws, "2026-11-10");
    expect(loops.considering).toHaveLength(0);
    expect(loops.open[0]).toMatchObject({ type: "COMMITMENT", kind: "promise" });
  });

  it("waiting items close when the other person delivers", () => {
    const { db, ws, say } = setup();
    say("I'm waiting for Priya to send the signed contract.");
    expect(openLoops(db, ws, "2026-11-09").waiting).toHaveLength(1);
    say("Priya sent the signed contract this morning.", at("2026-11-10T04:30:00Z"));
    expect(openLoops(db, ws, "2026-11-10").waiting).toHaveLength(0);
  });

  it("cancellation needs a matching item", () => {
    const { db, ws, say } = setup();
    say("I'll call the vendor about the refund.");
    say("I no longer need to call the vendor about the refund.", at("2026-11-10T04:30:00Z"));
    expect(openLoops(db, ws, "2026-11-10").recentlyClosed[0]!.status).toBe("CANCELLED");
  });

  it("overdue and due-soon are computed in the user's local date", () => {
    const { db, ws, say } = setup();
    say("I'll send the proposal to Rahul by Friday.");
    expect(openLoops(db, ws, "2026-11-12").dueSoon).toHaveLength(1);
    expect(openLoops(db, ws, "2026-11-14").overdue).toHaveLength(1);
  });

  it("filters loops by person", () => {
    const { db, ws, say } = setup();
    say("I'll send the proposal to Rahul by Friday.");
    say("I'll call Meera tomorrow.");
    expect(openLoops(db, ws, "2026-11-09", "Rahul").open.map((m) => m.counterparty)).toEqual(["Rahul"]);
  });
});

describe("decision history and contradictions", () => {
  it("keeps every step and links supersession/contradiction", () => {
    const { db, ws, say } = setup();
    say("We will use MongoDB for the database.", at("2026-11-03T05:00:00Z"));
    say("After comparing the databases, PostgreSQL seems better because of joins.", at("2026-11-05T05:00:00Z"));
    say("We have finalized PostgreSQL.", at("2026-11-07T05:00:00Z"));
    const [tl] = decisionTimeline(db, ws, ["database"]);
    expect(tl!.subject).toBe("database");
    expect(tl!.entries.map((e) => [e.memory.eventDate, e.memory.kind, e.memory.status])).toEqual([
      ["2026-11-03", "chosen", "SUPERSEDED"],
      ["2026-11-05", "considering", "SUPERSEDED"],
      ["2026-11-07", "chosen", "ACTIVE"],
    ]);
    const final = tl!.entries[2]!;
    expect(final.memory.alternatives).toContain("MongoDB");
    expect(final.links.some((l) => l.relation === "CONTRADICTS")).toBe(true);
    expect(tl!.entries[1]!.memory.rationale).toBe("of joins");
  });

  it("only records reasoning that was expressed", () => {
    const { db, ws, say } = setup();
    say("We will use Postgres.");
    expect(decisionTimeline(db, ws, ["database"])[0]!.entries[0]!.memory.rationale).toBeNull();
  });

  it("preference changes supersede but preserve history", () => {
    const { db, ws, say } = setup();
    say("I prefer Notion for notes.");
    say("I prefer Obsidian for notes now.", at("2026-11-10T05:00:00Z"));
    const all = listPersonalMemories(db, ws, { type: "PREFERENCE" });
    expect(all.map((v) => v.memory.status).sort()).toEqual(["ACTIVE", "SUPERSEDED"]);
  });
});

describe("user correction", () => {
  it("records the correction with provenance and raises confidence", () => {
    const { db, ws, say } = setup();
    const m = say("I'll send the proposal to Rahul by Friday.").created[0]!;
    const fixed = correctMemory(db, ws, m.id, { dueDate: "2026-11-16" }, at("2026-11-10T00:00:00Z"))!;
    expect(fixed).toMatchObject({ dueDate: "2026-11-16", userCorrected: true, confidence: 1 });
    expect(eventsOf(db, m.id).at(-1)!.note).toMatch(/due: 2026-11-13 → 2026-11-16/);
  });
});
