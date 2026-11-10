import type { MemoryItem, Message } from "../db/repo";
import { formatLongDate, localTimeOf } from "../time/dates";
import type { RecalledTurn, Retrieval } from "./retrieval";

const MAX_CONTEXT_CHARS = 14_000;

/** Neutralise anything that could close or spoof our delimiters. */
export function sanitizeUntrusted(text: string, max: number): string {
  const cleaned = text
    .replace(/<\/?\s*(memory_context|system|instructions?|developer)[^>]*>/gi, "[tag removed]")
    .split(String.fromCharCode(0))
    .join("");
  return cleaned.length > max ? `${cleaned.slice(0, max)} …[truncated]` : cleaned;
}

function when(m: Message): string {
  return `${formatLongDate(m.localDate)} at ${localTimeOf(new Date(m.createdAtUtc), m.timezone)} (${m.timezone})`;
}

function renderTurn(t: RecalledTurn, n: number, answerChars = 1800): string {
  const lines = [
    `[${n}] message_id=${t.user.id} — the user asked on ${when(t.user)}:`,
    `    USER (verbatim): """${sanitizeUntrusted(t.user.content, 1200)}"""`,
  ];
  if (t.assistant) {
    lines.push(`    ASSISTANT replied: """${sanitizeUntrusted(t.assistant.content, answerChars)}"""`);
    const srcs = t.assistant.sources.filter((s) => s.origin !== "answer_link").slice(0, 8);
    if (srcs.length) lines.push(`    Sources cited then: ${srcs.map((s) => s.url).join(" , ")}`);
    else lines.push("    Sources cited then: none recorded");
  } else {
    lines.push("    ASSISTANT replied: (no saved reply)");
  }
  return lines.join("\n");
}

function renderMemory(m: MemoryItem): string {
  const facts = m.facts
    .slice(0, 25)
    .map((f) => `      - ${f.entity} · ${f.attribute}: ${f.value}${f.sourceUrl ? ` (source then: ${f.sourceUrl})` : ""}`)
    .join("\n");
  return [
    `  • [${m.type}] "${sanitizeUntrusted(m.title, 160)}" — baseline date ${formatLongDate(m.baselineDate)} (memory_id=${m.id})`,
    `    Summary: ${sanitizeUntrusted(m.summary, 600)}`,
    m.entities.length ? `    Entities: ${m.entities.slice(0, 20).join(", ")}` : "",
    facts ? `    Recorded facts at baseline:\n${facts}` : "    Recorded facts at baseline: none (no exact baseline values were saved)",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Render retrieved memory as a bounded, clearly-labelled untrusted block. */
export function renderMemoryContext(r: Retrieval): string | null {
  const parts: string[] = [];

  for (const hit of r.dateHits) {
    const range = hit.ref.start === hit.ref.end ? formatLongDate(hit.ref.start) : `${formatLongDate(hit.ref.start)} – ${formatLongDate(hit.ref.end)}`;
    parts.push(`## Saved messages for "${hit.ref.phrase}" → ${range}${hit.ref.assumption ? `\nDate assumption: ${hit.ref.assumption}` : ""}`);
    if (hit.turns.length === 0) parts.push("NO saved user messages exist on this date.");
    else hit.turns.forEach((t, i) => parts.push(renderTurn(t, i + 1)));
  }

  if (r.carriedTurns.length) {
    parts.push("## Earlier turns this conversation was just discussing (the baseline for this follow-up)");
    r.carriedTurns.forEach((t, i) => parts.push(renderTurn(t, i + 1, 2400)));
  }

  if (r.referent) {
    parts.push("## Most likely referent for this follow-up (resolved by the application)");
    parts.push(renderMemory(r.referent));
    const covered = new Set([...r.dateHits.flatMap((h) => h.turns.map((t) => t.user.id)), ...r.carriedTurns.map((t) => t.user.id)]);
    const turns = r.referentTurns.filter((t) => !covered.has(t.user.id));
    if (turns.length) {
      parts.push("  Original turns this memory was distilled from:");
      turns.slice(0, 3).forEach((t, i) => parts.push(renderTurn(t, i + 1, 2400)));
    }
  }

  if (r.ambiguous.length > 1) {
    parts.push("## AMBIGUOUS referent — several saved topics fit equally well:");
    r.ambiguous.forEach((m) => parts.push(renderMemory(m)));
  }

  if (r.memory.length) {
    parts.push("## Other possibly relevant saved memory");
    r.memory.forEach((m) => parts.push(renderMemory(m)));
  }

  if (r.relatedTurns.length) {
    parts.push("## Related earlier discussions (keyword match)");
    r.relatedTurns.forEach((t, i) => parts.push(renderTurn(t, i + 1, 900)));
  }

  if (r.noMemoryFound) {
    parts.push("## Retrieval outcome\nNO matching saved conversation was found for what the user is referring to.");
  }

  if (parts.length === 0) return null;
  let body = parts.join("\n\n");
  if (body.length > MAX_CONTEXT_CHARS) body = `${body.slice(0, MAX_CONTEXT_CHARS)}\n…[memory context truncated]`;
  return body;
}
