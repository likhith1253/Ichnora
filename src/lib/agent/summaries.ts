import type { DB } from "../db";
import type { Message } from "../db/repo";

export interface ConversationSummary {
  conversationId: string;
  coveredTurnStart: number;
  coveredTurnEnd: number;
  lastMessageId: string;
  summaryText: string;
  updatedAt: string;
}

/**
 * Incremental rolling summaries for long conversations.
 * Maintains a compact rolling summary so Groq prompt contexts stay bounded
 * without losing older context.
 */
export class RollingSummaryManager {
  initSchema(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id    TEXT PRIMARY KEY,
        covered_turn_start INTEGER NOT NULL,
        covered_turn_end   INTEGER NOT NULL,
        last_message_id    TEXT NOT NULL,
        summary_text       TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);
  }

  getSummary(db: DB, conversationId: string): ConversationSummary | null {
    try {
      const row = db.prepare(`
        SELECT conversation_id, covered_turn_start, covered_turn_end, last_message_id, summary_text, updated_at
        FROM conversation_summaries WHERE conversation_id = ?
      `).get(conversationId) as {
        conversation_id: string;
        covered_turn_start: number;
        covered_turn_end: number;
        last_message_id: string;
        summary_text: string;
        updated_at: string;
      } | undefined;

      if (!row) return null;
      return {
        conversationId: row.conversation_id,
        coveredTurnStart: row.covered_turn_start,
        coveredTurnEnd: row.covered_turn_end,
        lastMessageId: row.last_message_id,
        summaryText: row.summary_text,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Deterministically updates or creates a rolling summary from older messages.
   */
  updateRollingSummary(
    db: DB,
    conversationId: string,
    messages: Message[],
    now: Date = new Date()
  ): ConversationSummary | null {
    if (messages.length < 6) return null; // Only summarize threads with at least 3 turns

    // Summarize older messages, leaving recent ones for raw context
    const olderMessages = messages.slice(0, messages.length - 4);
    if (olderMessages.length === 0) return null;

    const first = olderMessages[0]!;
    const last = olderMessages[olderMessages.length - 1]!;

    const keyPoints: string[] = [];
    for (const m of olderMessages) {
      if (m.role === "user") {
        const clean = m.content.replace(/\s+/g, " ").trim().slice(0, 100);
        keyPoints.push(`User asked: "${clean}"`);
      } else if (m.role === "assistant" && m.status === "complete") {
        const firstLine = m.content.split("\n")[0]?.replace(/\s+/g, " ").trim().slice(0, 120);
        if (firstLine) keyPoints.push(`Assistant: ${firstLine}`);
      }
    }

    const summaryText = `Earlier conversation summary (${olderMessages.length} messages):\n` + keyPoints.slice(-8).map((p) => `- ${p}`).join("\n");

    db.prepare(`
      INSERT INTO conversation_summaries(conversation_id, covered_turn_start, covered_turn_end, last_message_id, summary_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        covered_turn_start = excluded.covered_turn_start,
        covered_turn_end = excluded.covered_turn_end,
        last_message_id = excluded.last_message_id,
        summary_text = excluded.summary_text,
        updated_at = excluded.updated_at
    `).run(conversationId, first.turnIndex, last.turnIndex, last.id, summaryText, now.toISOString());

    return {
      conversationId,
      coveredTurnStart: first.turnIndex,
      coveredTurnEnd: last.turnIndex,
      lastMessageId: last.id,
      summaryText,
      updatedAt: now.toISOString(),
    };
  }
}
