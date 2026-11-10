import { randomUUID } from "node:crypto";
import type { DB } from "../db";
import { classifyMessage, contentTokens, EXTRACTION_VERSION, type Candidate, type MemoryStatus, type MemoryType, type Signal } from "./classify";

/**
 * Personal memory persistence: dedupe/reinforcement, supersession with
 * history, evidence-based lifecycle transitions, entity links and an
 * append-only event log. Everything runs in one transaction per message.
 */

export interface Memory {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourceMessageId: string;
  type: MemoryType;
  kind: string;
  subject: string;
  content: string;
  quote: string;
  owner: string | null;
  counterparty: string | null;
  dueDate: string | null;
  eventDate: string;
  status: MemoryStatus;
  confidence: number;
  evidence: "explicit" | "inferred" | "external" | "suggestion";
  rationale: string | null;
  alternatives: string[];
  mentionCount: number;
  userCorrected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLink {
  fromId: string;
  toId: string;
  relation: "SUPERSEDES" | "CONTRADICTS" | "SUPPORTS" | "RELATED_TO" | "COMPLETED_BY" | "FOLLOWS_FROM";
  evidenceMessageId: string | null;
  createdAt: string;
}

export interface MemoryEvent {
  memoryId: string;
  at: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  messageId: string | null;
  note: string | null;
}

export interface IngestResult {
  created: Memory[];
  reinforced: Memory[];
  transitions: Array<{ memory: Memory; from: MemoryStatus; to: MemoryStatus; quote: string }>;
}

interface Row {
  id: string;
  workspace_id: string;
  conversation_id: string;
  source_message_id: string;
  type: MemoryType;
  kind: string;
  subject: string;
  content: string;
  quote: string;
  owner: string | null;
  counterparty: string | null;
  due_date: string | null;
  event_date: string;
  status: MemoryStatus;
  confidence: number;
  evidence: Memory["evidence"];
  rationale: string | null;
  alternatives: string;
  mention_count: number;
  user_corrected: number;
  created_at: string;
  updated_at: string;
}

export function toMemory(r: Row): Memory {
  let alternatives: string[] = [];
  try {
    alternatives = JSON.parse(r.alternatives) as string[];
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    conversationId: r.conversation_id,
    sourceMessageId: r.source_message_id,
    type: r.type,
    kind: r.kind,
    subject: r.subject,
    content: r.content,
    quote: r.quote,
    owner: r.owner,
    counterparty: r.counterparty,
    dueDate: r.due_date,
    eventDate: r.event_date,
    status: r.status,
    confidence: r.confidence,
    evidence: r.evidence,
    rationale: r.rationale,
    alternatives,
    mentionCount: r.mention_count,
    userCorrected: r.user_corrected === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/\b(inc|ltd|llc|corp|co)\b\.?/g, "").replace(/[^a-z0-9.+#]+/g, " ").trim();
}

/* ------------------------------------------------------------ entities */

export function upsertEntity(db: DB, workspaceId: string, name: string, kind: "person" | "org" | "product" | "topic", at: string): string {
  const norm = normName(name);
  const row = db.prepare("SELECT id, aliases FROM entities WHERE workspace_id = ? AND norm = ?").get(workspaceId, norm) as { id: string; aliases: string } | undefined;
  if (row) {
    const aliases = new Set(JSON.parse(row.aliases) as string[]);
    aliases.add(name);
    db.prepare("UPDATE entities SET last_seen = ?, mention_count = mention_count + 1, aliases = ? WHERE id = ?").run(at, JSON.stringify([...aliases].slice(0, 12)), row.id);
    return row.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO entities(id, workspace_id, name, norm, kind, aliases, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, workspaceId, name, norm, kind, JSON.stringify([name]), at, at);
  return id;
}

export function recordMention(db: DB, entityId: string, messageId: string, conversationId: string, localDate: string): void {
  db.prepare("INSERT OR IGNORE INTO entity_mentions(entity_id, message_id, conversation_id, local_date) VALUES (?, ?, ?, ?)").run(entityId, messageId, conversationId, localDate);
}

/* ------------------------------------------------------------ helpers */

function event(db: DB, memoryId: string, at: string, action: string, opts: { from?: string | null; to?: string | null; messageId?: string | null; note?: string | null } = {}): void {
  db.prepare("INSERT INTO memory_events(memory_id, at, action, from_status, to_status, message_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    memoryId, at, action, opts.from ?? null, opts.to ?? null, opts.messageId ?? null, opts.note ?? null,
  );
}

function link(db: DB, fromId: string, toId: string, relation: MemoryLink["relation"], messageId: string | null, at: string): void {
  db.prepare("INSERT OR IGNORE INTO memory_links(from_id, to_id, relation, evidence_message_id, created_at) VALUES (?, ?, ?, ?, ?)").run(fromId, toId, relation, messageId, at);
}

function setStatus(db: DB, m: Memory, to: MemoryStatus, at: string, messageId: string | null, note: string): void {
  db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(to, at, m.id);
  event(db, m.id, at, "status_changed", { from: m.status, to, messageId, note });
}

function get(db: DB, id: string): Memory {
  return toMemory(db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row);
}

function insert(db: DB, ctx: Ctx, c: Candidate, extra: Partial<Pick<Memory, "alternatives">> = {}): Memory {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO memories(id, workspace_id, conversation_id, source_message_id, type, kind, subject, content, quote, owner, counterparty, due_date, event_date,
       status, confidence, evidence, rationale, alternatives, extraction_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, ctx.workspaceId, ctx.conversationId, ctx.messageId, c.type, c.kind, c.subject, c.content, c.quote, c.owner, c.counterparty, c.dueDate, c.eventDate,
    c.status, c.confidence, c.evidence, c.rationale, JSON.stringify(extra.alternatives ?? c.alternatives), EXTRACTION_VERSION, ctx.at, ctx.at,
  );
  event(db, id, ctx.at, "created", { to: c.status, messageId: ctx.messageId, note: `extracted (${c.kind}, confidence ${c.confidence})` });
  for (const p of new Set([...c.people, ...(c.counterparty ? [c.counterparty] : [])])) {
    const eid = upsertEntity(db, ctx.workspaceId, p, "person", ctx.at);
    db.prepare("INSERT OR IGNORE INTO memory_entities(memory_id, entity_id) VALUES (?, ?)").run(id, eid);
  }
  return get(db, id);
}

interface Ctx {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  localDate: string;
  at: string;
}

const LIVE = "status NOT IN ('SUPERSEDED','COMPLETED','CANCELLED')";

function choiceOf(m: Memory | Candidate): string {
  return (m.content.match(/^(?:Chose|Considering|Rejected)\s+(.+?)\s+for\s+/)?.[1] ?? "").toLowerCase();
}

/* ------------------------------------------------------------ candidates */

function applyCandidate(db: DB, ctx: Ctx, c: Candidate, out: IngestResult): void {
  const same = (db
    .prepare(`SELECT * FROM memories WHERE workspace_id = ? AND type = ? AND subject = ? AND ${LIVE} ORDER BY seq DESC`)
    .all(ctx.workspaceId, c.type, c.subject) as Row[]).map(toMemory);

  if (c.type === "DECISION") {
    const prior = (db
      .prepare(`SELECT * FROM memories WHERE workspace_id = ? AND type = 'DECISION' AND subject = ? ORDER BY seq`)
      .all(ctx.workspaceId, c.subject) as Row[]).map(toMemory);
    const newChoice = choiceOf(c);
    const sameChoiceLive = prior.find((p) => p.status !== "SUPERSEDED" && choiceOf(p) === newChoice && p.kind === c.kind);
    if (sameChoiceLive) return reinforce(db, ctx, sameChoiceLive, c, out);
    // Alternatives = other options the user actually discussed for this subject.
    // Keep the user's own spelling ("MongoDB"), dedupe case-insensitively.
    const display = (m: Memory) => m.content.match(/^(?:Chose|Considering|Rejected)\s+(.+?)\s+for\s+/)?.[1] ?? "";
    const altMap = new Map<string, string>();
    for (const a of [...c.alternatives, ...prior.map(display)]) if (a && a.toLowerCase() !== newChoice) altMap.set(a.toLowerCase(), altMap.get(a.toLowerCase()) ?? a);
    const alternatives = [...altMap.values()];
    const created = insert(db, ctx, c, { alternatives });
    out.created.push(created);
    for (const p of prior.filter((p) => p.status === "ACTIVE" || p.status === "CONSIDERING")) {
      if (p.kind === "rejected" && c.kind !== "chosen") continue;
      if (c.kind === "considering" && p.kind === "chosen") {
        // Reconsidering a made decision: keep it active, but record the tension.
        if (choiceOf(p) !== newChoice) link(db, created.id, p.id, "CONTRADICTS", ctx.messageId, ctx.at);
        continue;
      }
      link(db, created.id, p.id, choiceOf(p) === newChoice ? "FOLLOWS_FROM" : "SUPERSEDES", ctx.messageId, ctx.at);
      if (choiceOf(p) !== newChoice && p.kind === "chosen" && c.kind === "chosen") link(db, created.id, p.id, "CONTRADICTS", ctx.messageId, ctx.at);
      if (c.kind === "chosen" || (c.kind === "rejected" && choiceOf(p) === newChoice)) setStatus(db, p, "SUPERSEDED", ctx.at, ctx.messageId, `superseded by: ${c.quote}`);
    }
    return;
  }

  if (c.type === "COMMITMENT" || c.type === "ACTION_ITEM" || c.type === "FOLLOW_UP") {
    const dup = same.find((m) => (m.counterparty ?? "") === (c.counterparty ?? "")) ??
      (db
        .prepare(`SELECT * FROM memories WHERE workspace_id = ? AND type IN ('COMMITMENT','ACTION_ITEM') AND subject = ? AND ${LIVE}`)
        .all(ctx.workspaceId, c.subject) as Row[]).map(toMemory)[0];
    if (dup) return reinforce(db, ctx, dup, c, out);
    out.created.push(insert(db, ctx, c));
    return;
  }

  // FACT / PREFERENCE / PROJECT / RELATIONSHIP: same subject, different content → supersede (history kept).
  const existing = same[0];
  if (existing) {
    const a = contentTokens(existing.content).join(" ");
    const b = contentTokens(c.content).join(" ");
    if (a === b) return reinforce(db, ctx, existing, c, out);
    const created = insert(db, ctx, c);
    out.created.push(created);
    link(db, created.id, existing.id, "SUPERSEDES", ctx.messageId, ctx.at);
    if (c.type === "PREFERENCE" && existing.kind !== c.kind) link(db, created.id, existing.id, "CONTRADICTS", ctx.messageId, ctx.at);
    setStatus(db, existing, "SUPERSEDED", ctx.at, ctx.messageId, `superseded by: ${c.quote}`);
    return;
  }
  out.created.push(insert(db, ctx, c));
}

/** Repeated mention: strengthen the existing record instead of duplicating it. */
function reinforce(db: DB, ctx: Ctx, m: Memory, c: Candidate, out: IngestResult): void {
  const notes: string[] = [];
  let status = m.status;
  let type = m.type;
  let kind = m.kind;
  if (m.kind === "intention" && c.kind === "promise") {
    status = "OPEN";
    type = "COMMITMENT";
    kind = "promise";
    notes.push("intention firmed into a promise");
  }
  const due = c.dueDate ?? m.dueDate;
  if (c.dueDate && m.dueDate && c.dueDate !== m.dueDate) notes.push(`due date changed ${m.dueDate} → ${c.dueDate}`);
  db.prepare(
    "UPDATE memories SET mention_count = mention_count + 1, confidence = MAX(confidence, ?), due_date = ?, status = ?, type = ?, kind = ?, updated_at = ? WHERE id = ?",
  ).run(c.confidence, due, status, type, kind, ctx.at, m.id);
  event(db, m.id, ctx.at, "reinforced", { from: m.status, to: status, messageId: ctx.messageId, note: notes.join("; ") || `mentioned again: ${c.quote}` });
  out.reinforced.push(get(db, m.id));
}

/* ------------------------------------------------------------ signals */

function score(m: Memory, s: Signal): number {
  let sc = 0;
  const mTokens = new Set(contentTokens(`${m.content} ${m.counterparty ?? ""}`));
  const overlap = s.objectTokens.filter((t) => mTokens.has(t)).length;
  sc += overlap;
  const vg = m.subject.split(":")[1];
  if (s.verbGroup && vg && s.verbGroup === vg) sc += 2;
  if (m.counterparty && s.people.some((p) => p.toLowerCase() === m.counterparty!.toLowerCase())) sc += 2;
  return sc;
}

function applySignal(db: DB, ctx: Ctx, s: Signal, out: IngestResult): void {
  const pool =
    s.kind === "counterpart_done"
      ? (db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND status = 'WAITING'").all(ctx.workspaceId) as Row[]).map(toMemory)
      : (db
          .prepare("SELECT * FROM memories WHERE workspace_id = ? AND type IN ('COMMITMENT','ACTION_ITEM') AND status IN ('OPEN','CONSIDERING') AND source_message_id != ?")
          .all(ctx.workspaceId, ctx.messageId) as Row[]).map(toMemory);
  const ranked = pool.map((m) => ({ m, sc: score(m, s) })).sort((a, b) => b.sc - a.sc);
  const best = ranked[0];
  if (!best) return;
  // Require real evidence: a counterparty match for waiting items; verb+object or strong overlap otherwise.
  const threshold = s.kind === "counterpart_done" ? 2 : 3;
  if (best.sc < threshold) return;
  if (s.kind === "counterpart_done" && !(best.m.counterparty && s.people.includes(best.m.counterparty))) return;
  if (ranked[1] && ranked[1].sc === best.sc) {
    event(db, best.m.id, ctx.at, "ambiguous_evidence", { messageId: ctx.messageId, note: `"${s.quote}" may refer to this or another item; not auto-closed` });
    return;
  }
  const to: MemoryStatus = s.kind === "cancellation" ? "CANCELLED" : "COMPLETED";
  // Store the evidence itself as a memory so COMPLETED_BY links to a quotable record.
  const evidence = insert(db, ctx, {
    type: "FACT",
    kind: s.kind === "cancellation" ? "cancellation" : "completion",
    subject: `evidence:${best.m.id}`,
    content: s.quote.replace(/[.!]+$/, ""),
    quote: s.quote,
    owner: s.kind === "counterpart_done" ? (s.people[0] ?? null) : "user",
    counterparty: best.m.counterparty,
    dueDate: null,
    eventDate: s.eventDate,
    status: "ACTIVE",
    confidence: 0.9,
    evidence: "explicit",
    rationale: null,
    alternatives: [],
    people: s.people,
    verbGroup: s.verbGroup,
    objectTokens: s.objectTokens,
  });
  link(db, best.m.id, evidence.id, "COMPLETED_BY", ctx.messageId, ctx.at);
  setStatus(db, best.m, to, ctx.at, ctx.messageId, s.quote);
  out.transitions.push({ memory: get(db, best.m.id), from: best.m.status, to, quote: s.quote });
}

/* ------------------------------------------------------------ entry point */

export function ingestUserMessage(
  db: DB,
  input: { workspaceId: string; conversationId: string; messageId: string; text: string; localDate: string; now: Date; timeZone: string },
): IngestResult {
  const out: IngestResult = { created: [], reinforced: [], transitions: [] };
  const { candidates, signals } = classifyMessage(input.text, input.now, input.timeZone);
  const ctx: Ctx = { workspaceId: input.workspaceId, conversationId: input.conversationId, messageId: input.messageId, localDate: input.localDate, at: input.now.toISOString() };
  db.transaction(() => {
    const people = new Set([...candidates.flatMap((c) => c.people), ...signals.flatMap((s) => s.people)]);
    for (const p of people) recordMention(db, upsertEntity(db, input.workspaceId, p, "person", ctx.at), input.messageId, input.conversationId, input.localDate);
    // Signals first: "I sent the report; I'll call Rahul tomorrow" closes before opening.
    for (const s of signals) applySignal(db, ctx, s, out);
    for (const c of candidates) applyCandidate(db, ctx, c, out);
  })();
  return out;
}

/* ------------------------------------------------------------ user correction */

export interface MemoryPatch {
  status?: MemoryStatus;
  content?: string;
  dueDate?: string | null;
}

export function correctMemory(db: DB, workspaceId: string, id: string, patch: MemoryPatch, now = new Date()): Memory | null {
  const row = db.prepare("SELECT * FROM memories WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as Row | undefined;
  if (!row) return null;
  const m = toMemory(row);
  const at = now.toISOString();
  db.transaction(() => {
    const changes: string[] = [];
    if (patch.content !== undefined && patch.content !== m.content) changes.push(`content: "${m.content}" → "${patch.content}"`);
    if (patch.dueDate !== undefined && patch.dueDate !== m.dueDate) changes.push(`due: ${m.dueDate ?? "none"} → ${patch.dueDate ?? "none"}`);
    db.prepare("UPDATE memories SET content = ?, due_date = ?, status = ?, user_corrected = 1, confidence = 1.0, evidence = 'explicit', updated_at = ? WHERE id = ?").run(
      patch.content ?? m.content,
      patch.dueDate !== undefined ? patch.dueDate : m.dueDate,
      patch.status ?? m.status,
      at,
      id,
    );
    event(db, id, at, "corrected", { from: m.status, to: patch.status ?? m.status, note: `user correction${changes.length ? `: ${changes.join("; ")}` : ""}` });
  })();
  return get(db, id);
}

export function deletePersonalMemory(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM memories WHERE id = ? AND workspace_id = ?").run(id, workspaceId).changes > 0;
}
