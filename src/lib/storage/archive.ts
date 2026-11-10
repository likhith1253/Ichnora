import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import type { DB } from "../db";
import type { Message } from "../db/repo";

/**
 * Local Archival Subsystem.
 * Compresses older conversation transcripts into immutable, checksummed gzip segments,
 * records them in an archive catalog, and compacts them from active SQLite messages
 * while preserving full searchability and historical recall.
 */

export interface ArchiveRecord {
  workspaceId: string;
  conversationId: string;
  conversationTitle: string;
  messageCount: number;
  originalBytes: number;
  compressedBytes: number;
  segmentPath: string;
  sha256: string;
  startDate: string;
  endDate: string;
  archivedAt: string;
}

export type ArchivalState =
  | "ELIGIBLE"
  | "ARCHIVE_PENDING"
  | "COPYING"
  | "VERIFYING"
  | "ARCHIVED"
  | "SOURCE_COMPACTION"
  | "COMPLETED";

export interface ArchivedMessagePayload {
  conversation: {
    id: string;
    workspaceId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<Message & { sources?: unknown[]; extractions?: unknown[] }>;
}

export class ArchiveManager {
  constructor(private archiveDir: string) {
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  /**
   * Initialize archive catalog in SQLite database.
   */
  initSchema(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_catalog (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id       TEXT NOT NULL,
        conversation_id    TEXT NOT NULL UNIQUE,
        title              TEXT NOT NULL,
        message_count      INTEGER NOT NULL,
        original_bytes     INTEGER NOT NULL,
        compressed_bytes   INTEGER NOT NULL,
        segment_path       TEXT NOT NULL,
        sha256             TEXT NOT NULL,
        start_date         TEXT NOT NULL,
        end_date           TEXT NOT NULL,
        archived_at        TEXT NOT NULL,
        state              TEXT NOT NULL DEFAULT 'COMPLETED'
      );
      CREATE INDEX IF NOT EXISTS idx_archive_ws ON archive_catalog(workspace_id, archived_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archive_dates ON archive_catalog(workspace_id, start_date, end_date);

      CREATE TABLE IF NOT EXISTS archive_search_index (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id    TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        role            TEXT NOT NULL,
        local_date      TEXT NOT NULL,
        content         TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES archive_catalog(conversation_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_arch_search_date ON archive_search_index(workspace_id, local_date);

      CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
        content,
        content='archive_search_index',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS archive_search_ai AFTER INSERT ON archive_search_index BEGIN
        INSERT INTO archive_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS archive_search_ad AFTER DELETE ON archive_search_index BEGIN
        INSERT INTO archive_fts(archive_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
    `);
  }

  /**
   * Find conversations eligible for archival:
   * Has messages older than olderThanDays, or not updated within olderThanDays.
   */
  getEligibleConversations(
    db: DB,
    workspaceId: string,
    olderThanDays: number,
    now: Date = new Date()
  ): Array<{ id: string; title: string; updatedAt: string; messageCount: number }> {
    const cutoffDate = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();
    return db.prepare(`
      SELECT c.id, c.title, c.updated_at as updatedAt, COUNT(m.seq) as messageCount
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE c.workspace_id = ?
        AND c.updated_at <= ?
        AND c.id NOT IN (SELECT conversation_id FROM archive_catalog WHERE state = 'COMPLETED')
      GROUP BY c.id
      HAVING messageCount > 0
    `).all(workspaceId, cutoffDate) as Array<{ id: string; title: string; updatedAt: string; messageCount: number }>;
  }

  /**
   * Executes crash-safe archival for a conversation:
   * 1. COPYING: extract conversation + messages into payload, gzip compress to .gz
   * 2. VERIFYING: decompress and verify sha256 & integrity
   * 3. ARCHIVED: insert catalog row + populate archive search index
   * 4. SOURCE_COMPACTION: prune message content from active DB
   * 5. COMPLETED: final state
   */
  archiveConversation(db: DB, workspaceId: string, conversationId: string): ArchiveRecord {
    const conv = db.prepare(
      "SELECT id, workspace_id, title, created_at, updated_at FROM conversations WHERE id = ? AND workspace_id = ?"
    ).get(conversationId, workspaceId) as { id: string; workspace_id: string; title: string; created_at: string; updated_at: string } | undefined;

    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found in workspace ${workspaceId}`);
    }

    const rawRows = db.prepare(`
      SELECT id, conversation_id, workspace_id, role, content, status, created_at_utc, timezone, local_date, turn_index, metadata
      FROM messages WHERE conversation_id = ? ORDER BY seq ASC
    `).all(conversationId) as Array<{
      id: string;
      conversation_id: string;
      workspace_id: string;
      role: "user" | "assistant";
      content: string;
      status: "complete" | "error" | "cancelled";
      created_at_utc: string;
      timezone: string;
      local_date: string;
      turn_index: number;
      metadata: string;
    }>;

    if (rawRows.length === 0) {
      throw new Error(`Conversation ${conversationId} has no messages to archive`);
    }

    const messages: Message[] = rawRows.map((r) => ({
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
      metadata: JSON.parse(r.metadata || "{}"),
      sources: [],
    }));

    // Step 1: COPYING
    const payload: ArchivedMessagePayload = {
      conversation: {
        id: conv.id,
        workspaceId: conv.workspace_id,
        title: conv.title,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
      },
      messages,
    };

    const rawJson = JSON.stringify(payload);
    const originalBytes = Buffer.byteLength(rawJson, "utf8");
    const compressed = zlib.gzipSync(Buffer.from(rawJson, "utf8"), { level: 9 });
    const compressedBytes = compressed.byteLength;
    const sha256 = createHash("sha256").update(compressed).digest("hex");

    const segmentFilename = `${workspaceId}_${conversationId}_${Date.now()}.json.gz`;
    const segmentPath = path.join(this.archiveDir, segmentFilename);

    // Write segment file atomically
    const tempPath = `${segmentPath}.tmp`;
    fs.writeFileSync(tempPath, compressed);
    fs.renameSync(tempPath, segmentPath);

    // Step 2: VERIFYING
    const readBack = fs.readFileSync(segmentPath);
    const readHash = createHash("sha256").update(readBack).digest("hex");
    if (readHash !== sha256) {
      fs.unlinkSync(segmentPath);
      throw new Error("Archival checksum verification failed!");
    }
    const decompressed = zlib.gunzipSync(readBack).toString("utf8");
    const verifiedPayload = JSON.parse(decompressed) as ArchivedMessagePayload;
    if (verifiedPayload.messages.length !== messages.length) {
      fs.unlinkSync(segmentPath);
      throw new Error("Archival message count verification mismatch!");
    }

    // Step 3: ARCHIVED & Search index population
    const startDate = messages[0]?.localDate ?? "";
    const endDate = messages[messages.length - 1]?.localDate ?? "";
    const archivedAt = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO archive_catalog(
          workspace_id, conversation_id, title, message_count, original_bytes,
          compressed_bytes, segment_path, sha256, start_date, end_date, archived_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED')
        ON CONFLICT(conversation_id) DO UPDATE SET
          message_count = excluded.message_count,
          original_bytes = excluded.original_bytes,
          compressed_bytes = excluded.compressed_bytes,
          segment_path = excluded.segment_path,
          sha256 = excluded.sha256,
          archived_at = excluded.archived_at,
          state = 'COMPLETED'
      `).run(
        workspaceId,
        conversationId,
        conv.title,
        messages.length,
        originalBytes,
        compressedBytes,
        segmentPath,
        sha256,
        startDate,
        endDate,
        archivedAt
      );

      // Populate archive search index for historical queries
      const insertIndex = db.prepare(`
        INSERT INTO archive_search_index(workspace_id, conversation_id, message_id, role, local_date, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const m of messages) {
        insertIndex.run(workspaceId, conversationId, m.id, m.role, m.localDate, m.content);
      }

      // Step 4: SOURCE_COMPACTION (remove raw messages from active messages table)
      db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    })();

    return {
      workspaceId,
      conversationId,
      conversationTitle: conv.title,
      messageCount: messages.length,
      originalBytes,
      compressedBytes,
      segmentPath,
      sha256,
      startDate,
      endDate,
      archivedAt,
    };
  }

  /**
   * Search across all archives for a workspace (Transparent Historical Retrieval).
   */
  searchArchive(
    db: DB,
    workspaceId: string,
    query: string,
    limit: number = 10
  ): Array<{ conversationId: string; messageId: string; role: string; localDate: string; content: string; title: string }> {
    const norm = query.replace(/[^\w\s]/g, " ").trim();
    if (!norm) return [];

    try {
      const matchQuery = norm.split(/\s+/).filter(Boolean).map((t) => `"${t}"*`).join(" AND ");
      return db.prepare(`
        SELECT asi.conversation_id as conversationId, asi.message_id as messageId,
               asi.role, asi.local_date as localDate, asi.content, ac.title
        FROM archive_fts fts
        JOIN archive_search_index asi ON asi.id = fts.rowid
        JOIN archive_catalog ac ON ac.conversation_id = asi.conversation_id
        WHERE asi.workspace_id = ? AND archive_fts MATCH ?
        LIMIT ?
      `).all(workspaceId, matchQuery, limit) as Array<{
        conversationId: string;
        messageId: string;
        role: string;
        localDate: string;
        content: string;
        title: string;
      }>;
    } catch {
      return [];
    }
  }

  /**
   * Retrieve archived conversation by exact date (Historical Date Recall).
   */
  getArchiveByDate(
    db: DB,
    workspaceId: string,
    localDate: string
  ): Array<{ conversationId: string; title: string; messageId: string; role: string; content: string }> {
    return db.prepare(`
      SELECT asi.conversation_id as conversationId, ac.title, asi.message_id as messageId,
             asi.role, asi.content
      FROM archive_search_index asi
      JOIN archive_catalog ac ON ac.conversation_id = asi.conversation_id
      WHERE asi.workspace_id = ? AND asi.local_date = ?
      ORDER BY asi.id ASC
    `).all(workspaceId, localDate) as Array<{
      conversationId: string;
      title: string;
      messageId: string;
      role: string;
      content: string;
    }>;
  }

  /**
   * Restore/unpack archived conversation from disk segment.
   */
  restoreArchive(db: DB, conversationId: string): ArchivedMessagePayload {
    const row = db.prepare("SELECT segment_path, sha256 FROM archive_catalog WHERE conversation_id = ?").get(conversationId) as { segment_path: string; sha256: string } | undefined;
    if (!row) throw new Error(`Archive catalog entry for ${conversationId} not found`);

    if (!fs.existsSync(row.segment_path)) {
      throw new Error(`Archive segment file not found at ${row.segment_path}`);
    }

    const compressed = fs.readFileSync(row.segment_path);
    const hash = createHash("sha256").update(compressed).digest("hex");
    if (hash !== row.sha256) {
      throw new Error("Archive segment checksum corrupted!");
    }

    const json = zlib.gunzipSync(compressed).toString("utf8");
    return JSON.parse(json) as ArchivedMessagePayload;
  }

  /**
   * Delete archive files and catalog entries for account/workspace deletion.
   */
  deleteWorkspaceArchives(db: DB, workspaceId: string): number {
    const rows = db.prepare("SELECT segment_path FROM archive_catalog WHERE workspace_id = ?").all(workspaceId) as Array<{ segment_path: string }>;
    for (const r of rows) {
      try {
        if (fs.existsSync(r.segment_path)) fs.unlinkSync(r.segment_path);
      } catch {
        /* ignore */
      }
    }
    const res = db.prepare("DELETE FROM archive_catalog WHERE workspace_id = ?").run(workspaceId);
    return res.changes;
  }
}
