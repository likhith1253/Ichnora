import { describe, expect, it } from "vitest";
import { addDays, formatLongDate, localDateOf, parseDateRefs } from "@/lib/time/dates";
import { analyzeQuery, ftsQuery } from "@/lib/memory/query";

const NOW = new Date("2026-11-10T10:00:00Z"); // Tuesday
const IST = "Asia/Kolkata";

const one = (text: string, now = NOW, tz = IST) => parseDateRefs(text, now, tz)[0];

describe("localDateOf", () => {
  it("uses the captured timezone, not UTC or the server zone", () => {
    const t = new Date("2026-11-02T20:00:00Z");
    expect(localDateOf(t, "UTC")).toBe("2026-11-02");
    expect(localDateOf(t, IST)).toBe("2026-11-03");
    expect(localDateOf(t, "America/Los_Angeles")).toBe("2026-11-02");
    expect(localDateOf(new Date("2026-11-03T03:00:00Z"), "America/Los_Angeles")).toBe("2026-11-02");
  });
  it("formats long dates locale-independently", () => {
    expect(formatLongDate("2026-11-09")).toBe("Monday 9 November 2026");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("parseDateRefs", () => {
  it.each([
    ["What did I ask you on 3 November?", "2026-11-03"],
    ["what did i ask on november 3rd", "2026-11-03"],
    ["on the 3rd of Nov", "2026-11-03"],
    ["2026-10-01 chat", "2026-10-01"],
    ["what did we discuss yesterday", "2026-11-09"],
    ["on Monday we shortlisted", "2026-11-09"],
    ["last Friday", "2026-11-06"],
    ["3 days ago", "2026-11-07"],
    ["Nov 3, 2025", "2025-11-03"],
  ])("%s → %s", (text, expected) => {
    expect(one(text)).toMatchObject({ start: expected, end: expected });
  });

  it("resolves a year-less future date to last year and discloses the assumption", () => {
    const r = one("what did I ask on 25 December?")!;
    expect(r.start).toBe("2025-12-25");
    expect(r.assumption).toMatch(/2025/);
  });

  it("'last Tuesday' said on a Tuesday means one week ago, with an assumption", () => {
    const r = one("Last Tuesday I asked you about Postgres")!;
    expect(r.start).toBe("2026-11-03");
    expect(r.assumption).toBeTruthy();
  });

  it("resolves relative dates in the user's timezone, near midnight", () => {
    // 2026-11-10T20:00Z is already Wednesday 11 Nov in IST but still Tuesday in New York.
    const late = new Date("2026-11-10T20:00:00Z");
    expect(one("yesterday", late, IST)!.start).toBe("2026-11-10");
    expect(one("yesterday", late, "America/New_York")!.start).toBe("2026-11-09");
  });

  it("last week is the previous Monday–Sunday", () => {
    expect(one("last week")).toMatchObject({ start: "2026-11-02", end: "2026-11-08" });
  });

  it("rejects impossible dates and ignores bare numbers", () => {
    expect(parseDateRefs("31 February", NOW, IST)).toHaveLength(0);
    expect(parseDateRefs("a 20-person team", NOW, IST)).toHaveLength(0);
  });
});

describe("analyzeQuery", () => {
  it("treats 'today' as the verification date, not a recall target", () => {
    const a = analyzeQuery("What did I ask you on 3 November? Is your answer still correct today?", NOW, IST);
    expect(a.dateRefs.map((d) => d.start)).toEqual(["2026-11-03"]);
    expect(a.asksRecall && a.asksFreshness).toBe(true);
  });
  it("detects pronoun follow-ups with no distinctive terms", () => {
    const a = analyzeQuery("Has any of them changed pricing or shipped something big since?", NOW, IST);
    expect(a.hasAnaphora).toBe(true);
    expect(a.asksFreshness).toBe(true);
    expect(a.strongTerms).toEqual([]);
    expect(a.weakTerms).toContain("pricing");
  });
  it("does not mistake a normal question for recall", () => {
    const a = analyzeQuery("Is it going to rain in Paris today?", NOW, IST);
    expect(a.asksRecall).toBe(false);
    expect(a.strongTerms).toContain("paris");
  });
  it("recognises greetings", () => {
    expect(analyzeQuery("hey there!", NOW, IST).isGreeting).toBe(true);
    expect(analyzeQuery("hey, what's the price of Notion?", NOW, IST).isGreeting).toBe(false);
  });
  it("builds injection-safe FTS queries", () => {
    expect(ftsQuery(['neon") OR *', "postgres"])).toBe('"neon) OR *" OR "postgres"');
  });
});
