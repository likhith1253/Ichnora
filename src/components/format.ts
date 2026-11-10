// Date helpers. All times render in the viewer's local timezone; YYYY-MM-DD
// calendar dates are treated as dates (no timezone shift).

export const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ymd(d: string): string {
  const s = d.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : d;
}

export const dayLabel = (d: string, withYear = false) =>
  new Date(`${ymd(d)}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

export const shortDate = (d: string) =>
  new Date(`${ymd(d)}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Whole days from `today` to `d` (both YYYY-MM-DD). */
export function daysBetween(today: string, d: string): number {
  return Math.round((Date.parse(`${ymd(d)}T00:00:00Z`) - Date.parse(`${ymd(today)}T00:00:00Z`)) / 86_400_000);
}

export function relativeDue(today: string, due: string): string {
  const n = daysBetween(today, due);
  if (n === 0) return "due today";
  if (n === 1) return "due tomorrow";
  if (n === -1) return "1 day overdue";
  if (n < 0) return `${-n} days overdue`;
  if (n < 7) return `due in ${n} days`;
  return `due ${dayLabel(due)}`;
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
