/**
 * Timezone-correct date helpers and a deterministic temporal-reference parser.
 * The model is never trusted to resolve dates: "last Tuesday", "3 November",
 * "yesterday" are resolved here against the user's IANA timezone.
 */

export interface DateRef {
  /** Inclusive local-date range (YYYY-MM-DD) in the user's timezone. */
  start: string;
  end: string;
  /** The phrase that produced this reference, e.g. "last Tuesday". */
  phrase: string;
  /** Disclosure of any assumption made while resolving. */
  assumption?: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar date (YYYY-MM-DD) of an instant in an IANA timezone. */
export function localDateOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Local wall-clock time (HH:MM) of an instant in an IANA timezone. */
export function localTimeOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

/** Calendar-day arithmetic on plain dates (timezone-free). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Locale-independent "Monday 9 November 2026" (stable for prompts and tests). */
export function formatLongDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wd = WEEKDAYS[weekdayOf(date)]!;
  const month = MONTHS[m - 1]!;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(wd)} ${d} ${cap(month)} ${y}`;
}

function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function monthIndex(token: string): number {
  const t = token.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(t)) + 1;
}

/** Most recent past-or-today occurrence of month/day. */
function resolveYearless(month: number, day: number, today: string): { date: string | null; assumption?: string } {
  const year = Number(today.slice(0, 4));
  const thisYear = ymd(year, month, day);
  if (thisYear && thisYear <= today) return { date: thisYear };
  const lastYear = ymd(year - 1, month, day);
  return {
    date: lastYear,
    assumption: lastYear
      ? `No year given; assumed ${lastYear.slice(0, 4)} (the most recent past ${MONTHS[month - 1]} ${day}).`
      : undefined,
  };
}

type Resolved = Omit<DateRef, "phrase"> | null;

/**
 * Extract every temporal reference from free text. Pure: `now` and `timeZone`
 * are injected so tests are deterministic.
 */
export function parseDateRefs(text: string, now: Date, timeZone: string): DateRef[] {
  const today = localDateOf(now, timeZone);
  const lower = text.toLowerCase();
  const found: Array<DateRef & { at: number }> = [];
  const taken: Array<[number, number]> = [];
  const isFree = (i: number, j: number) => taken.every(([a, b]) => j <= a || i >= b);

  const run = (re: RegExp, fn: (m: RegExpMatchArray) => Resolved) => {
    for (const m of lower.matchAll(re)) {
      const i = m.index ?? 0;
      const j = i + m[0].length;
      if (!isFree(i, j)) continue;
      const r = fn(m);
      if (!r) continue;
      taken.push([i, j]);
      found.push({ ...r, phrase: text.slice(i, j).trim(), at: i });
    }
  };
  const single = (d: string | null, assumption?: string): Resolved =>
    d ? { start: d, end: d, ...(assumption ? { assumption } : {}) } : null;

  run(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => single(ymd(+m[1]!, +m[2]!, +m[3]!)));
  run(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, "g"), (m) => {
    const day = +m[1]!;
    const month = monthIndex(m[2]!);
    if (m[3]) return single(ymd(+m[3], month, day));
    const r = resolveYearless(month, day, today);
    return single(r.date, r.assumption);
  });
  run(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"), (m) => {
    const month = monthIndex(m[1]!);
    const day = +m[2]!;
    if (m[3]) return single(ymd(+m[3], month, day));
    const r = resolveYearless(month, day, today);
    return single(r.date, r.assumption);
  });
  run(/\bday before yesterday\b/g, () => single(addDays(today, -2)));
  run(/\byesterday\b/g, () => single(addDays(today, -1)));
  run(/\b(\d{1,2}|a|one|two|three|four|five|six|seven)\s+days?\s+ago\b/g, (m) => {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    return single(addDays(today, -(words[m[1]!] ?? Number(m[1]))));
  });
  run(/\blast week\b/g, () => {
    const mondayOffset = (weekdayOf(today) + 6) % 7;
    const thisMonday = addDays(today, -mondayOffset);
    return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1) };
  });
  run(/\b(?:earlier )?this week\b/g, () => {
    const mondayOffset = (weekdayOf(today) + 6) % 7;
    return { start: addDays(today, -mondayOffset), end: today };
  });
  run(/\b(?:(last|past|previous|this|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g, (m) => {
    const target = WEEKDAYS.indexOf(m[2]!);
    let back = (weekdayOf(today) - target + 7) % 7;
    let assumption: string | undefined;
    if (back === 0) {
      back = 7;
      assumption = `Today is a ${m[2]}; interpreted "${m[0].trim()}" as ${addDays(today, -7)} (one week ago).`;
    }
    return single(addDays(today, -back), assumption);
  });
  run(/\b(?:earlier )?today\b|\bthis morning\b/g, () => single(today));

  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...r }) => r);
}
