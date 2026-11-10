import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/lib/db";
import { ArchiveManager } from "../src/lib/storage/archive";
import { insertMessage, createConversation } from "../src/lib/db/repo";
import { getStorageAccounting } from "../src/lib/storage/accounting";
import { CacheStore } from "../src/lib/cache/store";

async function runBenchmark() {
  console.log("=== MINIMI STORAGE & PERFORMANCE BENCHMARK ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-benchmark-"));
  const dbPath = path.join(tmpDir, "benchmark.db");
  const arcDir = path.join(tmpDir, "archives");

  const db = openDatabase(dbPath);
  const mgr = new ArchiveManager(arcDir);
  mgr.initSchema(db);
  const cacheStore = new CacheStore();
  cacheStore.initSchema(db);

  const ws = "ws-benchmark";
  db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run(ws, new Date().toISOString());

  const CONVERSATION_COUNT = 50;
  const MESSAGES_PER_CONV = 40; // Total 2,000 realistic messages
  const totalMessages = CONVERSATION_COUNT * MESSAGES_PER_CONV;

  console.log(`Generating synthetic dataset: ${CONVERSATION_COUNT} conversations, ${totalMessages} messages...`);

  const t0Insert = performance.now();
  const convIds: string[] = [];

  for (let c = 0; c < CONVERSATION_COUNT; c++) {
    const conv = createConversation(db, ws, `Conversation ${c + 1}: Architecture and Cloud Hosting Evaluation`, new Date("2026-11-01T10:00:00Z"));
    convIds.push(conv.id);

    db.transaction(() => {
      for (let m = 0; m < MESSAGES_PER_CONV; m++) {
        insertMessage(db, {
          conversationId: conv.id,
          workspaceId: ws,
          role: m % 2 === 1 ? "user" : "assistant",
          content: `Turn ${m + 1} of Conv ${c + 1}: Investigating Postgres pricing comparison between Supabase, Neon, and AWS RDS. Notes: Neon charges $0.16/CU-hour. Supabase Pro is $25/month. Disk storage details: ${"sample evidence text ".repeat(15)}`,
          timezone: "Asia/Kolkata",
          createdAt: new Date(`2026-11-01T10:${(m % 50 < 10 ? "0" : "") + (m % 50)}:00Z`),
        });
      }
    })();
  }

  const insertDuration = performance.now() - t0Insert;
  console.log(`Insert completed in ${Math.round(insertDuration)}ms (${Math.round((totalMessages / insertDuration) * 1000)} msg/sec)`);

  const initialAcct = getStorageAccounting(dbPath, arcDir);
  console.log(`Active DB Size before archival: ${Math.round(initialAcct.dbBytes / 1024)} KB`);

  // Measure Date Recall Latency on Active DB
  const t0DateRecall = performance.now();
  const activeHits = db.prepare("SELECT * FROM messages WHERE workspace_id = ? AND local_date = '2026-11-01' LIMIT 50").all(ws);
  const dateRecallMs = performance.now() - t0DateRecall;
  console.log(`Date recall latency (Active DB): ${dateRecallMs.toFixed(3)}ms (found ${activeHits.length} items)`);

  // Archive 30 conversations (~1,200 messages)
  console.log("Archiving 30 older conversations into compressed segments...");
  const t0Archive = performance.now();
  let totalOrigBytes = 0;
  let totalCompBytes = 0;

  for (let c = 0; c < 30; c++) {
    const rec = mgr.archiveConversation(db, ws, convIds[c]!);
    totalOrigBytes += rec.originalBytes;
    totalCompBytes += rec.compressedBytes;
  }
  const archiveDuration = performance.now() - t0Archive;

  const postArchAcct = getStorageAccounting(dbPath, arcDir);
  console.log(`Archive completed in ${Math.round(archiveDuration)}ms`);
  console.log(`Raw message payload: ${Math.round(totalOrigBytes / 1024)} KB`);
  console.log(`Compressed archive payload: ${Math.round(totalCompBytes / 1024)} KB`);
  const compressionRatio = ((1 - totalCompBytes / totalOrigBytes) * 100).toFixed(1);
  console.log(`Compression ratio: ${compressionRatio}% space reduction`);
  console.log(`Archive storage directory: ${Math.round(postArchAcct.archiveBytes / 1024)} KB`);

  // Measure Historical FTS Search across Archives
  const t0ArchSearch = performance.now();
  const archHits = mgr.searchArchive(db, ws, "Supabase Neon");
  const archSearchMs = performance.now() - t0ArchSearch;
  console.log(`Archive search latency: ${archSearchMs.toFixed(3)}ms (found ${archHits.length} items)`);

  // Measure Cache Hit Latency
  cacheStore.set(db, { key: "bench-key", namespace: "bench", value: { text: "cached answer" }, ttlMs: 60_000 });
  const t0CacheHit = performance.now();
  const cacheHit = cacheStore.get(db, "bench-key");
  const cacheHitMs = performance.now() - t0CacheHit;
  console.log(`Cache hit latency: ${cacheHitMs.toFixed(3)}ms (hit: ${Boolean(cacheHit)})`);

  console.log("=== BENCHMARK COMPLETED SUCCESSFULLY ===");
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

runBenchmark().catch(console.error);
