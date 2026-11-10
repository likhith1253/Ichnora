import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/lib/db";
import { ArchiveManager } from "../src/lib/storage/archive";
import { getStorageAccounting, checkDbIntegrity } from "../src/lib/storage/accounting";
import { insertMessage, createConversation } from "../src/lib/db/repo";

describe("Storage & Archival Subsystem", () => {
  it("compresses conversations into verified segments and reduces active table size", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-archive-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    const arcDir = path.join(tmpDir, "archives");

    const db = openDatabase(dbPath);
    const mgr = new ArchiveManager(arcDir);
    mgr.initSchema(db);

    const ws = "ws-test-1";
    db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run(ws, new Date().toISOString());

    const conv = createConversation(db, ws, "November Research on CRM Pricing", new Date("2026-11-03T10:00:00Z"));

    // Insert 10 synthetic messages with substantial content
    for (let i = 1; i <= 10; i++) {
      insertMessage(db, {
        conversationId: conv.id,
        workspaceId: ws,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `Message ${i}: Researching CRM pricing options for Hubspot, Salesforce, and Pipedrive. Plan details: Hubspot Starter is $20/month per user, Salesforce Essentials is $25/month. Continuous text padding: ${"x".repeat(300)}`,
        timezone: "Asia/Kolkata",
        createdAt: new Date(`2026-11-03T10:${i < 10 ? "0" + i : i}:00Z`),
      });
    }

    const beforeMsgCount = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?").get(conv.id) as { c: number }).c;
    expect(beforeMsgCount).toBe(10);

    // Archive conversation
    const record = mgr.archiveConversation(db, ws, conv.id);

    expect(record.conversationId).toBe(conv.id);
    expect(record.messageCount).toBe(10);
    expect(record.compressedBytes).toBeLessThan(record.originalBytes);
    expect(fs.existsSync(record.segmentPath)).toBe(true);

    // Active messages table is compacted
    const afterMsgCount = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?").get(conv.id) as { c: number }).c;
    expect(afterMsgCount).toBe(0);

    // Historical search still works via archive FTS5
    const searchHits = mgr.searchArchive(db, ws, "Hubspot Salesforce");
    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits[0]?.title).toBe("November Research on CRM Pricing");

    // Date recall works
    const dateHits = mgr.getArchiveByDate(db, ws, "2026-11-03");
    expect(dateHits.length).toBe(10);

    // Unpack / restore matches original
    const restored = mgr.restoreArchive(db, conv.id);
    expect(restored.messages.length).toBe(10);
    expect(restored.messages[0]?.content).toContain("Message 1");

    // Clean up
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("checks database integrity and storage accounting", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-acct-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    const db = openDatabase(dbPath);

    const integrity = checkDbIntegrity(db);
    expect(integrity.ok).toBe(true);

    const acct = getStorageAccounting(dbPath);
    expect(acct.dbBytes).toBeGreaterThan(0);
    expect(acct.lowDiskWarning).toBe(false);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
