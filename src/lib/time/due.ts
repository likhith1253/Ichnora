import { addDays, localDateOf, weekdayOf } from "./dates";

/**
 * Deadline resolution — the forward-looking counterpart of `parseDateRefs`.
 * "by Friday" in a commitment means the NEXT Friday (today if it is Friday),
 * never last Friday. Only explicit expressions produce a date: we never infer
 * a deadline the user did not state.
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export interface DueDate {
  date: string; // YYYY-MM-DD in the user's timezone
  phrase: string;
}

function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Upcoming occurrence of a month/day (this year, or next year if already past). */
function upcoming(month: number, day: number, today: string): string | null {
  const y = Number(today.slice(0, 4));
  const a = ymd(y, month, day);
  if (a && a >= today) return a;
  return ymd(y + 1, month, day);
}

function nextWeekday(today: string, target: number, allowToday: boolean): string {
  let ahead = (target - weekdayOf(today) + 7) % 7;
  if (ahead === 0 && !allowToday) ahead = 7;
  return addDays(today, ahead);
}

function endOfMonth(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Find a deadline in a sentence. Requires a deadline cue ("by", "before",
 * "until", "due", "on", "this", "next", "tomorrow", "tonight", "end of") so a
 * casual mention of a day is not mistaken for a due date.
 */
export function parseDueDate(sentence: string, now: Date, timeZone: string): DueDate | null {
  const today = localDateOf(now, timeZone);
  const s = sentence.toLowerCase();
  const cue = "(?:by|before|until|till|due(?: on| by)?|on|no later than)";
  const tests: Array<[RegExp, (m: RegExpMatchArray) => string | null]> = [
    [/\b(?:by |before )?(?:end of (?:the )?day|eod|tonight|today)\b/, () => today],
    [/\b(?:by |before )?(?:tomorrow|tmrw)\b/, () => addDays(today, 1)],
    [/\b(?:by |before )?(?:the )?end of (?:the |this )?week\b|\bby (?:the )?weekend\b/, () => nextWeekday(today, 5, true)],
    [/\b(?:by |before )?(?:the )?end of (?:the |this )?month\b/, () => endOfMonth(today)],
    [/\bnext week\b/, () => nextWeekday(today, 1, false)],
    [new RegExp(`\\b${cue}\\s+(\\d{4})-(\\d{2})-(\\d{2})\\b`), (m) => ymd(+m[1]!, +m[2]!, +m[3]!)],
    [new RegExp(`\\b${cue}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`), (m) => upcoming(MONTHS.indexOf(m[2]!.slice(0, 3)) + 1, +m[1]!, today)],
    [new RegExp(`\\b${cue}\\s+${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`), (m) => upcoming(MONTHS.indexOf(m[1]!.slice(0, 3)) + 1, +m[2]!, today)],
    [new RegExp(`\\b(?:${cue}\\s+)?next\\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b`), (m) => nextWeekday(today, WEEKDAYS.indexOf(m[1]!), false)],
    [new RegExp(`\\b(?:${cue}|this)\\s+(?:this\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b`), (m) => nextWeekday(today, WEEKDAYS.indexOf(m[1]!), true)],
  ];
  for (const [re, fn] of tests) {
    const m = s.match(re);
    if (!m) continue;
    const date = fn(m);
    if (date) return { date, phrase: sentence.slice(m.index ?? 0, (m.index ?? 0) + m[0].length).trim() };
  }
  return null;
}
