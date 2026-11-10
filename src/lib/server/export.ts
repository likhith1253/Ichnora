import type { DB } from "../db";

/**
 * Data portability: everything the app stores for a workspace, as JSON.
 * Secrets are never stored in the database, so nothing needs scrubbing here.
 */
export function exportWorkspace(db: DB, workspaceId: string): Record<string, unknown> {
  const all = (sql: string) => db.prepare(sql).all(workspaceId);
  return {
    exportedAt: new Date().toISOString(),
    workspaceId,
    conversations: all("SELECT id, title, created_at, updated_at FROM conversations WHERE workspace_id = ? ORDER BY created_at"),
    messages: all(
      "SELECT id, conversation_id, role, content, status, created_at_utc, timezone, local_date, turn_index, metadata FROM messages WHERE workspace_id = ? ORDER BY seq",
    ),
    sources: all(
      "SELECT s.message_id, s.url, s.title, s.domain, s.retrieved_at, s.origin, s.official, s.evidence_level, s.published_date, s.query FROM turn_sources s JOIN messages m ON m.id = s.message_id WHERE m.workspace_id = ?",
    ),
    researchSnapshots: all("SELECT id, conversation_id, type, title, summary, entities, facts, source_message_ids, baseline_date, created_at, updated_at FROM memory_items WHERE workspace_id = ?"),
    observations: all("SELECT * FROM observations WHERE workspace_id = ?"),
    memories: all("SELECT * FROM memories WHERE workspace_id = ? ORDER BY seq"),
    memoryLinks: all("SELECT l.* FROM memory_links l JOIN memories m ON m.id = l.from_id WHERE m.workspace_id = ?"),
    memoryEvents: all("SELECT e.* FROM memory_events e JOIN memories m ON m.id = e.memory_id WHERE m.workspace_id = ? ORDER BY e.id"),
    entities: all("SELECT id, name, kind, aliases, first_seen, last_seen, mention_count FROM entities WHERE workspace_id = ?"),
  };
}

/** "Forget everything": deleting the workspace cascades to every derived table. */
export function deleteWorkspace(db: DB, workspaceId: string): boolean {
  return db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId).changes > 0;
}
