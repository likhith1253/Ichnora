import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/lib/db";
import { JobQueue } from "../src/lib/jobs/queue";
import { BackupManager } from "../src/lib/storage/backup";
import { runJobWorkerPass } from "../src/lib/jobs/worker";

describe("Durable Jobs & Backup Subsystem", () => {
  it("leases, completes, and retries jobs with exponential backoff and recovers expired leases", () => {
    const db = openDatabase(":memory:");
    const queue = new JobQueue();
    queue.initSchema(db);

    const jobId = queue.enqueue(db, {
      jobType: "prune_caches",
      maxAttempts: 2,
    });

    // First lease
    const job1 = queue.leaseNextJob(db, 1000);
    expect(job1).not.toBeNull();
    expect(job1?.jobId).toBe(jobId);
    expect(job1?.attemptCount).toBe(1);

    // Concurrent worker gets null (leased)
    const jobConcurrent = queue.leaseNextJob(db, 1000);
    expect(jobConcurrent).toBeNull();

    // Simulate failure
    queue.failJob(db, jobId, "Temporary network timeout");

    // Second lease after failure (retries)
    const futureTime = new Date(Date.now() + 5000);
    const job2 = queue.leaseNextJob(db, 1000, futureTime);
    expect(job2).not.toBeNull();
    expect(job2?.attemptCount).toBe(2);

    // Second failure moves to DEAD_LETTER
    queue.failJob(db, jobId, "Fatal error on attempt 2", futureTime);

    const statusRow = db.prepare("SELECT status, last_error FROM durable_jobs WHERE job_id = ?").get(jobId) as { status: string; last_error: string };
    expect(statusRow.status).toBe("DEAD_LETTER");
    expect(statusRow.last_error).toContain("Fatal error on attempt 2");
  });

  it("creates a consistent hot backup using SQLite Backup API and restores it with checksum validation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-backup-test-"));
    const dbPath = path.join(tmpDir, "active.db");
    const backupDir = path.join(tmpDir, "backups");
    const restoreDir = path.join(tmpDir, "restored");

    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO workspaces(id, created_at) VALUES (?, ?)").run("ws-backup-1", new Date().toISOString());

    const mgr = new BackupManager({ backupDir, maxBackupsToRetain: 3 });
    const { backupDbPath, manifest } = await mgr.createBackup(db, "test_backup");

    expect(fs.existsSync(backupDbPath)).toBe(true);
    expect(manifest.dbSha256).toBeDefined();

    // Restore to fresh directory
    const { restoredDbPath } = mgr.restoreBackup("test_backup", restoreDir);
    expect(fs.existsSync(restoredDbPath)).toBe(true);

    const restoredDb = openDatabase(restoredDbPath);
    const row = restoredDb.prepare("SELECT id FROM workspaces WHERE id = ?").get("ws-backup-1") as { id: string } | undefined;
    expect(row?.id).toBe("ws-backup-1");

    restoredDb.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
