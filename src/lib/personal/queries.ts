import type { DB } from "../db";
import { addDays } from "../time/dates";
import { normName, toMemory, type Memory, type MemoryEvent, type MemoryLink } from "./store";

/**
 * Read side of personal memory. All structured queries are SQL (status, dates,
 * entities); topical lookups use FTS5. Nothing here is exposed to the model as
 * a tool — results are injected as bounded, labelled context.
 */

type Row = Parameters<typeof toMemory>[0];

export interface OpenLoops {
  today: string;
  open: Memory[]; // promises + obligations
  waiting: Memory[]; // on other people
  overdue: Memory[];
  dueSoon: Memory[]; // within 7 days
  considering: Memory[]; // hedged intentions — not promises
  recentlyClosed: Memory[]; // completed/cancelled in the last 14 days
}

export function openLoops(db: DB, workspaceId: string, today: string, person?: string | null): OpenLoops {
  const byPerson = person ? " AND (lower(counterparty) = lower(?) OR lower(owner) = lower(?) OR content LIKE ?)" : "";
  const args = (extra: unknown[]) => (person ? [...extra, person, person, `%${person}%`] : extra);
  const q = (where: string, extra: unknown[] = [], order = "COALESCE(due_date, '9999') , seq") =>
    (db.prepare(`SELECT * FROM memories WHERE workspace_id = ? AND ${where}${byPerson} ORDER BY ${order} LIMIT 40`).all(...args([workspaceId, ...extra])) as Row[]).map(toMemory);
  const open = q("type IN ('COMMITMENT','ACTION_ITEM') AND status = 'OPEN'");
  const waiting = q("status = 'WAITING'");
  const considering = q("type IN ('COMMITMENT','ACTION_ITEM') AND status = 'CONSIDERING'");
  const recentlyClosed = q("type IN ('COMMITMENT','ACTION_ITEM','FOLLOW_UP') AND status IN ('COMPLETED','CANCELLED') AND updated_at >= ?", [`${addDays(today, -14)}T00:00:00Z`], "updated_at DESC");
  const live = [...open, ...waiting];
  return {
    today,
    open,
    waiting,
    overdue: live.filter((m) => m.dueDate !== null && m.dueDate < today),
    dueSoon: live.filter((m) => m.dueDate !== null && m.dueDate >= today && m.dueDate <= addDays(today, 7)),
    considering,
    recentlyClosed,
  };
}

export interface DecisionEntry {
  memory: Memory;
  links: MemoryLink[];
}

/** Chronological decision history for subjects matching the query terms. */
export function decisionTimeline(db: DB, workspaceId: string, terms: string[]): { subject: string; entries: DecisionEntry[] }[] {
  const all = (db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND type = 'DECISION' ORDER BY event_date, seq").all(workspaceId) as Row[]).map(toMemory);
  if (all.length === 0) return [];
  const t = terms.map((x) => x.toLowerCase());
  const subjects = [...new Set(all.map((m) => m.subject))].filter(
    (s) => t.length === 0 || t.some((term) => s.includes(term) || term.includes(s) || all.some((m) => m.subject === s && m.content.toLowerCase().includes(term))),
  );
  return subjects.map((subject) => ({
    subject,
    entries: all.filter((m) => m.subject === subject).map((memory) => ({ memory, links: linksOf(db, memory.id) })),
  }));
}

export function linksOf(db: DB, memoryId: string): MemoryLink[] {
  return (db
    .prepare("SELECT * FROM memory_links WHERE from_id = ? OR to_id = ? ORDER BY created_at")
    .all(memoryId, memoryId) as Array<{ from_id: string; to_id: string; relation: MemoryLink["relation"]; evidence_message_id: string | null; created_at: string }>).map((l) => ({
    fromId: l.from_id,
    toId: l.to_id,
    relation: l.relation,
    evidenceMessageId: l.evidence_message_id,
    createdAt: l.created_at,
  }));
}

export function eventsOf(db: DB, memoryId: string): MemoryEvent[] {
  return (db.prepare("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY id").all(memoryId) as Array<{
    memory_id: string; at: string; action: string; from_status: string | null; to_status: string | null; message_id: string | null; note: string | null;
  }>).map((e) => ({ memoryId: e.memory_id, at: e.at, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, messageId: e.message_id, note: e.note }));
}

/** Topical personal context for a query: FTS over memories + entity matches. Bounded. */
export function relevantPersonal(db: DB, workspaceId: string, opts: { ftsQuery: string; people: string[]; limit?: number }): Memory[] {
  const out = new Map<string, Memory>();
  const limit = opts.limit ?? 8;
  if (opts.ftsQuery) {
    const rows = db
      .prepare(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.workspace_id = ? AND m.status != 'SUPERSEDED' AND m.subject NOT LIKE 'evidence:%'
         ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(opts.ftsQuery, workspaceId, limit) as Row[];
    rows.forEach((r) => out.set(r.id, toMemory(r)));
  }
  for (const p of opts.people) {
    const rows = db
      .prepare(
        `SELECT m.* FROM memories m JOIN memory_entities me ON me.memory_id = m.id JOIN entities e ON e.id = me.entity_id
         WHERE m.workspace_id = ? AND e.norm = ? AND m.status != 'SUPERSEDED' ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(workspaceId, normName(p), limit) as Row[];
    rows.forEach((r) => out.set(r.id, toMemory(r)));
  }
  // Stable profile facts/preferences are always cheap and useful context.
  const profile = db
    .prepare("SELECT * FROM memories WHERE workspace_id = ? AND type IN ('FACT','PREFERENCE','RELATIONSHIP','PROJECT') AND status = 'ACTIVE' AND kind = 'stated' OR (workspace_id = ? AND type = 'PREFERENCE' AND status = 'ACTIVE') ORDER BY seq DESC LIMIT 4")
    .all(workspaceId, workspaceId) as Row[];
  profile.forEach((r) => out.set(r.id, toMemory(r)));
  return [...out.values()].slice(0, limit + 4);
}

export interface MemoryView {
  memory: Memory;
  links: MemoryLink[];
  events: MemoryEvent[];
  sourceMessage: { conversationId: string; createdAtUtc: string; timezone: string } | null;
}

/** Inspector feed for the UI (paginated). */
export function listPersonalMemories(db: DB, workspaceId: string, opts: { type?: string; limit?: number; offset?: number } = {}): MemoryView[] {
  const rows = (opts.type
    ? db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND type = ? AND subject NOT LIKE 'evidence:%' ORDER BY seq DESC LIMIT ? OFFSET ?").all(workspaceId, opts.type, opts.limit ?? 100, opts.offset ?? 0)
    : db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND subject NOT LIKE 'evidence:%' ORDER BY seq DESC LIMIT ? OFFSET ?").all(workspaceId, opts.limit ?? 100, opts.offset ?? 0)) as Row[];
  return rows.map((r) => {
    const memory = toMemory(r);
    const src = db.prepare("SELECT conversation_id, created_at_utc, timezone FROM messages WHERE id = ?").get(memory.sourceMessageId) as
      | { conversation_id: string; created_at_utc: string; timezone: string }
      | undefined;
    return {
      memory,
      links: linksOf(db, memory.id),
      events: eventsOf(db, memory.id),
      sourceMessage: src ? { conversationId: src.conversation_id, createdAtUtc: src.created_at_utc, timezone: src.timezone } : null,
    };
  });
}

export function getMemory(db: DB, workspaceId: string, id: string): Memory | null {
  const r = db.prepare("SELECT * FROM memories WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as Row | undefined;
  return r ? toMemory(r) : null;
}
