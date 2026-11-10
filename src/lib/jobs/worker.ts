import { getDb } from "../db";
import { getJobQueue } from "./queue";
import { ArchiveManager } from "../storage/archive";
import { getCacheStore } from "../cache/store";
import { cleanupDemoData } from "../demo/store";
import { checkDbIntegrity, checkpointWal } from "../storage/accounting";
import { BackupManager } from "../storage/backup";
import path from "node:path";

export interface WorkerRunResult {
  jobsExecuted: number;
  errors: number;
}

/**
 * Executes a single maintenance pass across the durable job queue.
 */
export async function runJobWorkerPass(db = getDb()): Promise<WorkerRunResult> {
  const queue = getJobQueue();
  queue.initSchema(db);

  let jobsExecuted = 0;
  let errors = 0;

  // Process up to 5 jobs per pass
  for (let i = 0; i < 5; i++) {
    const job = queue.leaseNextJob(db, 30_000);
    if (!job) break;

    jobsExecuted++;
    try {
      if (job.jobType === "cleanup_demos") {
        cleanupDemoData(db);
      } else if (job.jobType === "prune_caches") {
        getCacheStore().prune(db);
      } else if (job.jobType === "checkpoint_wal") {
        checkpointWal(db, "PASSIVE");
      } else if (job.jobType === "check_integrity") {
        const res = checkDbIntegrity(db);
        if (!res.ok) throw new Error(`Integrity check failed: ${res.message}`);
      } else if (job.jobType === "archive_eligible" && job.workspaceId) {
        const arcDir = path.join(process.cwd(), "data", "archives");
        const mgr = new ArchiveManager(arcDir);
        mgr.initSchema(db);
        const payload = JSON.parse(job.payload || "{}") as { olderThanDays?: number };
        const eligible = mgr.getEligibleConversations(db, job.workspaceId, payload.olderThanDays ?? 30);
        for (const c of eligible) {
          mgr.archiveConversation(db, job.workspaceId, c.id);
        }
      } else if (job.jobType === "backup_snapshot") {
        const mgr = new BackupManager();
        await mgr.createBackup(db);
      }

      queue.completeJob(db, job.jobId);
    } catch (e) {
      errors++;
      queue.failJob(db, job.jobId, (e as Error).message);
    }
  }

  return { jobsExecuted, errors };
}

