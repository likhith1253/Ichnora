import type { DB } from "../db";
import {
  getMessages,
  memoryForConversation,
  memoryOnDates,
  listMemory,
  messagesOnDates,
  recentMessages,
  replyTo,
  searchMemory,
  searchMessages,
  type MemoryItem,
  type Message,
} from "../db/repo";
import { analyzeQuery, ftsQuery, tokenize, type QueryAnalysis } from "./query";
import { localDateOf, type DateRef } from "../time/dates";

/**
 * What the agent is being asked to do, decided by application code.
 *  - chat:              greetings / small talk (no search)
 *  - recall:            "what did I ask on 3 Nov?" (no search; answer from DB)
 *  - recall_and_verify: recall + "is it still correct / has it changed?" (search required)
 *  - clarify:           a pronoun with several equally plausible referents (no search)
 *  - research:          everything else (model decides whether to search)
 */
export type Intent = "chat" | "recall" | "recall_and_verify" | "clarify" | "research";
export type ToolChoice = "auto" | "required" | "none";

export interface RecalledTurn {
  user: Message;
  assistant: Message | null;
}

export interface Retrieval {
  analysis: QueryAnalysis;
  intent: Intent;
  toolChoice: ToolChoice;
  /** Turns found by explicit date reference, grouped per reference. */
  dateHits: Array<{ ref: DateRef; turns: RecalledTurn[] }>;
  /** Turns recalled by the previous reply in this thread (carry-over). */
  carriedTurns: RecalledTurn[];
  /** Best referent for pronouns / implicit follow-ups. */
  referent: MemoryItem | null;
  /** Original turns the referent was distilled from (traceability). */
  referentTurns: RecalledTurn[];
  /** Set when the referent is ambiguous — the agent must ask, not guess. */
  ambiguous: MemoryItem[];
  /** Other relevant memory items and older turns (lexical). */
  memory: MemoryItem[];
  relatedTurns: RecalledTurn[];
  /** Recent turns of the active conversation (sent as chat history). */
  thread: Message[];
  /** True when the user referred to the past but nothing was found. */
  noMemoryFound: boolean;
}

export interface RetrieveInput {
  workspaceId: string;
  conversationId: string;
  text: string;
  now: Date;
  timeZone: string;
  /** The just-inserted user message; excluded from recall results. */
  excludeMessageId?: string;
}

const HIGH_VALUE = new Set(["shortlist", "comparison", "research_snapshot", "decision"]);
const THREAD_LIMIT = 12;

function toTurns(db: DB, users: Message[]): RecalledTurn[] {
  return users.filter((m) => m.role === "user").map((u) => ({ user: u, assistant: replyTo(db, u) }));
}

function inRefs(date: string, refs: DateRef[]): boolean {
  return refs.some((r) => date >= r.start && date <= r.end);
}

function termHits(item: MemoryItem, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = new Set(tokenize(`${item.title} ${item.summary} ${item.entities.join(" ")}`));
  return terms.filter((t) => hay.has(t) || [...hay].some((h) => h.startsWith(t) || t.startsWith(h) && h.length >= 4)).length;
}

interface Scored {
  item: MemoryItem;
  score: number;
  anchored: boolean; // matched by conversation, date or a distinctive term
}

export function scoreCandidates(
  candidates: MemoryItem[],
  a: QueryAnalysis,
  ctx: { conversationId: string; today: string; boostIds?: Set<string> },
): Scored[] {
  const out: Scored[] = [];
  for (const item of candidates) {
    const sameConv = item.conversationId === ctx.conversationId || item.sourceMessageIds.some((id) => ctx.boostIds?.has(id));
    const dateMatch = inRefs(item.baselineDate, a.dateRefs);
    const strong = termHits(item, a.strongTerms);
    const weak = termHits(item, a.weakTerms);
    const ageDays = Math.max(0, (Date.parse(ctx.today) - Date.parse(item.baselineDate)) / 86_400_000);
    let score = 0;
    if (sameConv) score += 6;
    if (dateMatch) score += 5;
    score += 4 * strong + 0.75 * weak;
    if (HIGH_VALUE.has(item.type)) score += item.type === "shortlist" ? 1.5 : 1;
    score += 2 * Math.exp(-ageDays / 14);
    // An explicit date that does not match is evidence *against* the item.
    if (a.dateRefs.length > 0 && !dateMatch) score -= 3;
    out.push({ item, score, anchored: sameConv || dateMatch || strong > 0 });
  }
  return out.sort((x, y) => y.score - x.score);
}

export function retrieve(db: DB, input: RetrieveInput): Retrieval {
  const a = analyzeQuery(input.text, input.now, input.timeZone);
  const today = localDateOf(input.now, input.timeZone);
  const exclude = (m: Message) => m.id !== input.excludeMessageId;

  const thread = recentMessages(db, input.conversationId, THREAD_LIMIT + 1).filter(exclude).slice(-THREAD_LIMIT);

  // 1. Exact date lookup on the captured local date of each message.
  const dateHits = a.dateRefs.map((ref) => {
      const users = messagesOnDates(db, input.workspaceId, ref.start, ref.end).filter((m) => m.role === "user" && exclude(m));
      let turns = toTurns(db, users);
      // Narrow to topic if the user named one ("last Tuesday … Postgres hosting").
      if (a.strongTerms.length > 0 && turns.length > 3) {
        const topical = turns.filter((t) => {
          const hay = new Set(tokenize(`${t.user.content} ${t.assistant?.content ?? ""}`));
          return a.strongTerms.some((s) => hay.has(s));
        });
        if (topical.length > 0) turns = topical;
      }
      return { ref, turns: turns.slice(0, 8) };
    });

  // 1b. Carry-over: turns the previous reply in this thread recalled, so
  // "is your answer still correct?" right after a recall keeps its baseline.
  const lastAssistant = [...thread].reverse().find((m) => m.role === "assistant");
  const carriedIds = Array.isArray(lastAssistant?.metadata.recalledMessageIds)
    ? (lastAssistant!.metadata.recalledMessageIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 10)
    : [];
  const carriedTurns = a.dateRefs.length === 0 && carriedIds.length > 0 ? toTurns(db, getMessages(db, carriedIds)) : [];
  const boostIds = new Set(carriedTurns.flatMap((t) => [t.user.id, t.assistant?.id ?? ""]));

  // 2. Candidate memory items from every channel.
  const strongQ = ftsQuery(a.strongTerms);
  const allQ = ftsQuery([...a.strongTerms, ...a.weakTerms]);
  const pool = new Map<string, MemoryItem>();
  const add = (items: MemoryItem[]) => items.forEach((m) => pool.set(m.id, m));
  add(memoryForConversation(db, input.conversationId));
  for (const r of a.dateRefs) add(memoryOnDates(db, input.workspaceId, r.start, r.end));
  add(searchMemory(db, input.workspaceId, allQ, 10));
  add(listMemory(db, input.workspaceId, 20).filter((m) => HIGH_VALUE.has(m.type)));
  if (boostIds.size) add(listMemory(db, input.workspaceId, 200).filter((m) => m.sourceMessageIds.some((id) => boostIds.has(id))));
  const scored = scoreCandidates([...pool.values()], a, { conversationId: input.conversationId, today, boostIds });

  // 3. Referent resolution for pronouns / implicit follow-ups.
  // A follow-up needs a referent when it points back ("them", "still correct?")
  // without naming enough to stand alone, or explicitly refers to the past.
  const needsReferent =
    ((a.hasAnaphora || a.asksFreshness) && a.strongTerms.length <= 1) || a.refersToPast || a.dateRefs.length > 0;
  let referent: MemoryItem | null = null;
  let ambiguous: MemoryItem[] = [];
  if (needsReferent && scored.length > 0) {
    const [top, second] = scored;
    const tied =
      !top!.anchored &&
      second !== undefined &&
      second.item.conversationId !== top!.item.conversationId &&
      HIGH_VALUE.has(second.item.type) &&
      top!.score - second.score < 1.0;
    if (tied && a.hasAnaphora) ambiguous = scored.slice(0, 3).filter((s) => top!.score - s.score < 1.0).map((s) => s.item);
    else if (top!.anchored || top!.score >= 2.5) referent = top!.item;
  }
  const referentTurns = referent ? toTurns(db, getMessages(db, referent.sourceMessageIds)) : [];

  // 4. Lexical recall over old messages from other conversations.
  const seen = new Set<string>([
    ...thread.map((m) => m.id),
    ...dateHits.flatMap((h) => h.turns.map((t) => t.user.id)),
    ...referentTurns.map((t) => t.user.id),
    ...carriedTurns.map((t) => t.user.id),
  ]);
  const related = strongQ
    ? searchMessages(db, input.workspaceId, strongQ, 6, input.conversationId).filter((m) => exclude(m))
    : [];
  const relatedUsers: Message[] = [];
  for (const m of related) {
    const user = m.role === "user" ? m : findUserOfTurn(db, m);
    if (user && !seen.has(user.id)) {
      seen.add(user.id);
      relatedUsers.push(user);
    }
  }
  const relatedTurns = toTurns(db, relatedUsers).slice(0, 3);

  const memory = scored
    .filter((s) => s.item.id !== referent?.id && (s.anchored || s.score >= 3))
    .slice(0, 4)
    .map((s) => s.item);

  const anyDateHit = dateHits.some((h) => h.turns.length > 0);
  const pastFound = anyDateHit || carriedTurns.length > 0 || referent !== null || ambiguous.length > 0 || relatedTurns.length > 0;
  const pastAsked = a.asksRecall || a.refersToPast || (a.hasAnaphora && a.strongTerms.length <= 1 && thread.length === 0);
  // Date asked but nothing on that date = honest "nothing found", even if other memory exists.
  const dateMiss = a.dateRefs.length > 0 && dateHits.length > 0 && !anyDateHit && (a.asksRecall || a.refersToPast);
  const noMemoryFound = pastAsked && (!pastFound || dateMiss);

  let intent: Intent;
  let toolChoice: ToolChoice;
  if (a.isGreeting) {
    intent = "chat";
    toolChoice = "none";
  } else if (ambiguous.length > 1) {
    intent = "clarify";
    toolChoice = "none";
  } else if ((a.asksRecall || a.refersToPast || referent || carriedTurns.length > 0) && a.asksFreshness && !noMemoryFound && (anyDateHit || referent || carriedTurns.length > 0)) {
    intent = "recall_and_verify";
    toolChoice = "required";
  } else if (a.asksRecall && !a.asksFreshness) {
    intent = "recall";
    toolChoice = "none";
  } else {
    intent = "research";
    toolChoice = "auto";
  }

  return {
    analysis: a,
    intent,
    toolChoice,
    dateHits,
    carriedTurns,
    referent,
    referentTurns,
    ambiguous,
    memory,
    relatedTurns,
    thread,
    noMemoryFound,
  };
}

function findUserOfTurn(db: DB, m: Message): Message | null {
  const row = db
    .prepare("SELECT id FROM messages WHERE conversation_id = ? AND turn_index = ? AND role = 'user' LIMIT 1")
    .get(m.conversationId, m.turnIndex) as { id: string } | undefined;
  return row ? (getMessages(db, [row.id])[0] ?? null) : null;
}
