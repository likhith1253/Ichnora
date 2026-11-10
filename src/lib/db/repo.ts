import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./index";
import { localDateOf } from "../time/dates";

/* ------------------------------------------------------------------ types */

export type Role = "user" | "assistant";
export type MessageStatus = "complete" | "error" | "cancelled";
export type SourceOrigin = "search" | "citation" | "answer_link";

export interface Source {
  url: string;
  title: string | null;
  domain: string;
  retrievedAt: string;
  origin: SourceOrigin;
  /** Search snippet shown to the model (untrusted). */
  snippet?: string | null;
  /** Publisher date estimated by the search engine (YYYY-MM-DD). */
  publishedDate?: string | null;
  /** The search query that surfaced this source. */
  query?: string | null;
}

export const MessageMetadataSchema = z
  .object({
    intent: z.string().optional(),
    searched: z.boolean().optional(),
    searchQueries: z.array(z.string()).optional(),
    memoryRefs: z.array(z.string()).optional(),
    error: z.string().optional(),
    model: z.string().optional(),
  })
  .catchall(z.unknown());
export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

export interface Message {
  id: string;
  conversationId: string;
  workspaceId: string;
  role: Role;
  content: string;
  status: MessageStatus;
  createdAtUtc: string;
  timezone: string;
  localDate: string;
  turnIndex: number;
  metadata: MessageMetadata;
  sources: Source[];
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export const FactSchema = z.object({
  entity: z.string().min(1).max(120),
  attribute: z.string().min(1).max(120),
  value: z.string().min(1).max(400),
  sourceUrl: z.string().url().max(2000).optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const MEMORY_TYPES = ["shortlist", "comparison", "research_snapshot", "decision", "constraint", "open_question", "topic"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryItem {
  id: string;
  workspaceId: string;
  conversationId: string;
  type: MemoryType;
  title: string;
  summary: string;
  entities: string[];
  facts: Fact[];
  sourceMessageIds: string[];
  baselineDate: string;
  createdAt: string;
  updatedAt: string;
  supersededBy: string | null;
}

export interface NewMemoryItem {
  type: MemoryType;
  title: string;
  summary: string;
  entities: string[];
  facts: Fact[];
}

/* ------------------------------------------------------------- row mapping */

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  created_at_utc: string;
  timezone: string;
  local_date: string;
  turn_index: number;
  metadata: string;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toMessage(r: MessageRow, sources: Source[] = []): Message {
  const meta = MessageMetadataSchema.safeParse(safeJson(r.metadata, {}));
  return {
    id: r.id,
    conversationId: r.conversation_id,
    workspaceId: r.workspace_id,
    role: r.role,
    content: r.content,
    status: r.status,
    createdAtUtc: r.created_at_utc,
    timezone: r.timezone,
    localDate: r.local_date,
    turnIndex: r.turn_index,
    metadata: meta.success ? meta.data : {},
    sources,
  };
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  type: MemoryType;
  title: string;
  summary: string;
  entities: string;
  facts: string;
  source_message_ids: string;
  baseline_date: string;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
}

function toMemory(r: MemoryRow): MemoryItem {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    conversationId: r.conversation_id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    entities: safeJson<string[]>(r.entities, []),
    facts: safeJson<Fact[]>(r.facts, []),
    sourceMessageIds: safeJson<string[]>(r.source_message_ids, []),
    baselineDate: r.baseline_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    supersededBy: r.superseded_by,
  };
}

const conv = (r: { id: string; workspace_id: string; title: string; created_at: string; updated_at: string }): Conversation => ({
  id: r.id,
  workspaceId: r.workspace_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/* ------------------------------------------------------------- workspaces */

export function ensureWorkspace(db: DB, id: string, now = new Date()): void {
  db.prepare("INSERT OR IGNORE INTO workspaces(id, created_at) VALUES (?, ?)").run(id, now.toISOString());
}

/* ---------------------------------------------------------- conversations */

export function createConversation(db: DB, workspaceId: string, title = "New conversation", now = new Date(), id: string = randomUUID()): Conversation {
  ensureWorkspace(db, workspaceId, now);
  const ts = now.toISOString();
  db.prepare("INSERT INTO conversations(id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, workspaceId, title, ts, ts);
  return { id, workspaceId, title, createdAt: ts, updatedAt: ts };
}

export function listConversations(db: DB, workspaceId: string): Conversation[] {
  return (db.prepare("SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as Parameters<typeof conv>[0][]).map(conv);
}

export function getConversation(db: DB, workspaceId: string, id: string): Conversation | null {
  const r = db.prepare("SELECT * FROM conversations WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as Parameters<typeof conv>[0] | undefined;
  return r ? conv(r) : null;
}

export function renameConversation(db: DB, workspaceId: string, id: string, title: string): boolean {
  return db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND workspace_id = ?").run(title, id, workspaceId).changes > 0;
}

export function deleteConversation(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM conversations WHERE id = ? AND workspace_id = ?").run(id, workspaceId).changes > 0;
}

function touchConversation(db: DB, id: string, ts: string): void {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, id);
}

/* --------------------------------------------------------------- messages */

export interface InsertMessageInput {
  conversationId: string;
  workspaceId: string;
  role: Role;
  content: string;
  timezone: string;
  createdAt?: Date;
  status?: MessageStatus;
  clientRequestId?: string | null;
  metadata?: MessageMetadata;
  id?: string;
}

export function insertMessage(db: DB, m: InsertMessageInput): Message {
  const createdAt = m.createdAt ?? new Date();
  const id = m.id ?? randomUUID();
  const ts = createdAt.toISOString();
  const localDate = localDateOf(createdAt, m.timezone);
  const turn = db.transaction(() => {
    const row = db
      .prepare("SELECT COALESCE(MAX(turn_index), -1) AS t FROM messages WHERE conversation_id = ?")
      .get(m.conversationId) as { t: number };
    // A user message opens a new turn; the assistant reply shares it.
    const turnIndex = m.role === "user" ? row.t + 1 : Math.max(row.t, 0);
    db.prepare(
      `INSERT INTO messages(id, conversation_id, workspace_id, role, content, status, created_at_utc, timezone, local_date, turn_index, client_request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, m.conversationId, m.workspaceId, m.role, m.content, m.status ?? "complete", ts, m.timezone, localDate, turnIndex, m.clientRequestId ?? null, JSON.stringify(m.metadata ?? {}));
    touchConversation(db, m.conversationId, ts);
    return turnIndex;
  })();
  return {
    id,
    conversationId: m.conversationId,
    workspaceId: m.workspaceId,
    role: m.role,
    content: m.content,
    status: m.status ?? "complete",
    createdAtUtc: ts,
    timezone: m.timezone,
    localDate,
    turnIndex: turn,
    metadata: m.metadata ?? {},
    sources: [],
  };
}

export function findByRequestId(db: DB, conversationId: string, requestId: string, role: Role): Message | null {
  const r = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND client_request_id = ? AND role = ?")
    .get(conversationId, requestId, role) as MessageRow | undefined;
  return r ? withSources(db, [r])[0]! : null;
}

function withSources(db: DB, rows: MessageRow[]): Message[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const srcRows = db
    .prepare(`SELECT * FROM turn_sources WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
    .all(...ids) as Array<{ message_id: string; url: string; title: string | null; domain: string; retrieved_at: string; origin: SourceOrigin; snippet: string | null; published_date: string | null; query: string | null }>;
  const byMsg = new Map<string, Source[]>();
  for (const s of srcRows) {
    const list = byMsg.get(s.message_id) ?? [];
    list.push({ url: s.url, title: s.title, domain: s.domain, retrievedAt: s.retrieved_at, origin: s.origin, snippet: s.snippet, publishedDate: s.published_date, query: s.query });
    byMsg.set(s.message_id, list);
  }
  return rows.map((r) => toMessage(r, byMsg.get(r.id) ?? []));
}

export function listMessages(db: DB, conversationId: string): Message[] {
  const rows = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId) as MessageRow[];
  return withSources(db, rows);
}

export function recentMessages(db: DB, conversationId: string, limit: number): Message[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND status = 'complete' ORDER BY seq DESC LIMIT ?")
    .all(conversationId, limit) as MessageRow[];
  return withSources(db, rows.reverse());
}

export function getMessages(db: DB, ids: string[]): Message[] {
  if (ids.length === 0) return [];
  const rows = db.prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`).all(...ids) as MessageRow[];
  return withSources(db, rows);
}

/** Messages whose *captured* local date falls in [start, end]. */
export function messagesOnDates(db: DB, workspaceId: string, start: string, end: string, limit = 40): Message[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE workspace_id = ? AND local_date BETWEEN ? AND ? AND status = 'complete' ORDER BY seq LIMIT ?")
    .all(workspaceId, start, end, limit) as MessageRow[];
  return withSources(db, rows);
}

/** The assistant reply for a given user message's turn. */
export function replyTo(db: DB, user: Message): Message | null {
  const r = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND turn_index = ? AND role = 'assistant' AND status = 'complete' ORDER BY seq LIMIT 1")
    .get(user.conversationId, user.turnIndex) as MessageRow | undefined;
  return r ? withSources(db, [r])[0]! : null;
}

export function searchMessages(db: DB, workspaceId: string, ftsQuery: string, limit = 8, excludeConversationId?: string): Array<Message & { rank: number }> {
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT m.*, bm25(message_fts) AS rank FROM message_fts
       JOIN messages m ON m.seq = message_fts.rowid
       WHERE message_fts MATCH ? AND m.workspace_id = ? AND m.status = 'complete'
         AND (? IS NULL OR m.conversation_id != ?)
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, workspaceId, excludeConversationId ?? null, excludeConversationId ?? null, limit) as Array<MessageRow & { rank: number }>;
  const msgs = withSources(db, rows);
  return msgs.map((m, i) => ({ ...m, rank: rows[i]!.rank }));
}

/* ---------------------------------------------------------------- sources */

export function insertSources(db: DB, messageId: string, sources: Source[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO turn_sources(message_id, url, title, domain, retrieved_at, origin, snippet, published_date, query) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const s of sources) stmt.run(messageId, s.url, s.title, s.domain, s.retrievedAt, s.origin, s.snippet ?? null, s.publishedDate ?? null, s.query ?? null);
  })();
}

/* ----------------------------------------------------------------- memory */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Store distilled memory. Within one conversation an item that overlaps an
 * existing item of the same type (same title or >=50% shared entities) is
 * updated in place — e.g. a shortlist refined over several turns. Across
 * conversations items are kept as separate dated snapshots so old baselines
 * survive for later "has it changed since?" questions.
 */
export function upsertMemoryItems(
  db: DB,
  ctx: { workspaceId: string; conversationId: string; sourceMessageIds: string[]; baselineDate: string; now?: Date },
  items: NewMemoryItem[],
): MemoryItem[] {
  const ts = (ctx.now ?? new Date()).toISOString();
  const existing = (db
    .prepare("SELECT * FROM memory_items WHERE conversation_id = ? AND superseded_by IS NULL")
    .all(ctx.conversationId) as MemoryRow[]).map(toMemory);
  const out: MemoryItem[] = [];
  db.transaction(() => {
    for (const item of items) {
      const ents = new Set(item.entities.map(norm));
      const match = existing.find((e) => {
        if (e.type !== item.type) return false;
        if (norm(e.title) === norm(item.title)) return true;
        if (ents.size === 0 || e.entities.length === 0) return false;
        const shared = e.entities.filter((x) => ents.has(norm(x))).length;
        return shared / Math.min(ents.size, e.entities.length) >= 0.5;
      });
      if (match) {
        const sourceIds = [...new Set([...match.sourceMessageIds, ...ctx.sourceMessageIds])];
        const entities = [...new Map([...match.entities, ...item.entities].map((e) => [norm(e), e])).values()];
        const facts = mergeFacts(match.facts, item.facts);
        db.prepare("UPDATE memory_items SET title = ?, summary = ?, entities = ?, facts = ?, source_message_ids = ?, updated_at = ? WHERE id = ?").run(
          item.title, item.summary, JSON.stringify(entities), JSON.stringify(facts), JSON.stringify(sourceIds), ts, match.id,
        );
        out.push({ ...match, title: item.title, summary: item.summary, entities, facts, sourceMessageIds: sourceIds, updatedAt: ts });
      } else {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO memory_items(id, workspace_id, conversation_id, type, title, summary, entities, facts, source_message_ids, baseline_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, ctx.workspaceId, ctx.conversationId, item.type, item.title, item.summary, JSON.stringify(item.entities), JSON.stringify(item.facts), JSON.stringify(ctx.sourceMessageIds), ctx.baselineDate, ts, ts);
        const created: MemoryItem = {
          id, workspaceId: ctx.workspaceId, conversationId: ctx.conversationId, type: item.type, title: item.title,
          summary: item.summary, entities: item.entities, facts: item.facts, sourceMessageIds: ctx.sourceMessageIds,
          baselineDate: ctx.baselineDate, createdAt: ts, updatedAt: ts, supersededBy: null,
        };
        existing.push(created);
        out.push(created);
      }
    }
  })();
  return out;
}

function mergeFacts(old: Fact[], next: Fact[]): Fact[] {
  const key = (f: Fact) => `${norm(f.entity)}|${norm(f.attribute)}`;
  const map = new Map(old.map((f) => [key(f), f]));
  for (const f of next) map.set(key(f), f);
  return [...map.values()].slice(0, 60);
}

export function listMemory(db: DB, workspaceId: string, limit = 200): MemoryItem[] {
  return (db
    .prepare("SELECT * FROM memory_items WHERE workspace_id = ? AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT ?")
    .all(workspaceId, limit) as MemoryRow[]).map(toMemory);
}

export function memoryForConversation(db: DB, conversationId: string): MemoryItem[] {
  return (db
    .prepare("SELECT * FROM memory_items WHERE conversation_id = ? AND superseded_by IS NULL ORDER BY updated_at DESC")
    .all(conversationId) as MemoryRow[]).map(toMemory);
}

export function memoryOnDates(db: DB, workspaceId: string, start: string, end: string): MemoryItem[] {
  return (db
    .prepare("SELECT * FROM memory_items WHERE workspace_id = ? AND baseline_date BETWEEN ? AND ? AND superseded_by IS NULL ORDER BY updated_at DESC")
    .all(workspaceId, start, end) as MemoryRow[]).map(toMemory);
}

export function searchMemory(db: DB, workspaceId: string, ftsQuery: string, limit = 8): Array<MemoryItem & { rank: number }> {
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT mi.*, bm25(memory_fts, 4.0, 1.0, 3.0) AS rank FROM memory_fts
       JOIN memory_items mi ON mi.seq = memory_fts.rowid
       WHERE memory_fts MATCH ? AND mi.workspace_id = ? AND mi.superseded_by IS NULL
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, workspaceId, limit) as Array<MemoryRow & { rank: number }>;
  return rows.map((r) => ({ ...toMemory(r), rank: r.rank }));
}

export function deleteMemory(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("DELETE FROM memory_items WHERE id = ? AND workspace_id = ?").run(id, workspaceId).changes > 0;
}

/* ---------------------------------------------------------------- metrics */

export interface TurnMetrics {
  intent: string;
  toolChoice: string;
  searches: number;
  firstTokenMs: number | null;
  totalMs: number;
  memoryMs: number;
  model: string;
}

export function insertMetrics(db: DB, messageId: string, m: TurnMetrics): void {
  db.prepare(
    "INSERT OR REPLACE INTO turn_metrics(message_id, intent, tool_choice, searches, first_token_ms, total_ms, memory_ms, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(messageId, m.intent, m.toolChoice, m.searches, m.firstTokenMs, m.totalMs, m.memoryMs, m.model);
}
