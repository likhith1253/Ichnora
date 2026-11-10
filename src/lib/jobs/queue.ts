import type { DB } from "../db";

export type JobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "DEAD_LETTER";

export interface JobRecord {
  jobId: string;
  jobType: string;
  workspaceId: string | null;
  payload: string;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface EnqueueJobOptions {
  jobType: string;
  workspaceId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  delayMs?: number;
  now?: Date;
}

export class JobQueue {
  /**
   * Initializes the durable job table in SQLite.
   */
  initSchema(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_jobs (
        job_id          TEXT PRIMARY KEY,
        job_type        TEXT NOT NULL,
        workspace_id    TEXT,
        payload         TEXT NOT NULL DEFAULT '{}',
        status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','DEAD_LETTER')),
        attempt_count   INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL DEFAULT 3,
        next_attempt_at TEXT NOT NULL,
        lease_until     TEXT,
        started_at      TEXT,
        completed_at    TEXT,
        last_error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status_next ON durable_jobs(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_lease ON durable_jobs(lease_until);
    `);
  }

  /**
   * Enqueues a durable background job.
   */
  enqueue(db: DB, opts: EnqueueJobOptions): string {
    const now = opts.now ?? new Date();
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nextAttemptAt = new Date(now.getTime() + (opts.delayMs ?? 0)).toISOString();
    const payload = JSON.stringify(opts.payload ?? {});

    db.prepare(`
      INSERT INTO durable_jobs(job_id, job_type, workspace_id, payload, status, attempt_count, max_attempts, next_attempt_at)
      VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)
    `).run(jobId, opts.jobType, opts.workspaceId ?? null, payload, opts.maxAttempts ?? 3, nextAttemptAt);

    return jobId;
  }

  /**
   * Atomically leases the next eligible job for execution.
   * Recovers crashed/stalled jobs whose leases expired.
   */
  leaseNextJob(db: DB, leaseDurationMs: number = 60_000, now: Date = new Date()): JobRecord | null {
    const nowIso = now.getTime();
    const leaseUntilIso = new Date(nowIso + leaseDurationMs).toISOString();
    const nowStr = now.toISOString();

    return db.transaction(() => {
      // Find candidate job: either PENDING with next_attempt_at <= now, or RUNNING with expired lease
      const candidate = db.prepare(`
        SELECT job_id, job_type, workspace_id, payload, status, attempt_count, max_attempts, next_attempt_at, lease_until, started_at, completed_at, last_error
        FROM durable_jobs
        WHERE (status = 'PENDING' AND next_attempt_at <= ?)
           OR (status = 'RUNNING' AND lease_until IS NOT NULL AND lease_until <= ?)
        ORDER BY next_attempt_at ASC
        LIMIT 1
      `).get(nowStr, nowStr) as {
        job_id: string;
        job_type: string;
        workspace_id: string | null;
        payload: string;
        status: JobStatus;
        attempt_count: number;
        max_attempts: number;
        next_attempt_at: string;
        lease_until: string | null;
        started_at: string | null;
        completed_at: string | null;
        last_error: string | null;
      } | undefined;

      if (!candidate) return null;

      const newAttemptCount = candidate.attempt_count + 1;

      db.prepare(`
        UPDATE durable_jobs
        SET status = 'RUNNING',
            attempt_count = ?,
            lease_until = ?,
            started_at = ?
        WHERE job_id = ?
      `).run(newAttemptCount, leaseUntilIso, nowStr, candidate.job_id);

      return {
        jobId: candidate.job_id,
        jobType: candidate.job_type,
        workspaceId: candidate.workspace_id,
        payload: candidate.payload,
        status: "RUNNING" as JobStatus,
        attemptCount: newAttemptCount,
        maxAttempts: candidate.max_attempts,
        nextAttemptAt: candidate.next_attempt_at,
        leaseUntil: leaseUntilIso,
        startedAt: nowStr,
        completedAt: null,
        lastError: candidate.last_error,
      };
    })();
  }

  /**
   * Marks a job as successfully completed.
   */
  completeJob(db: DB, jobId: string, now: Date = new Date()): void {
    db.prepare(`
      UPDATE durable_jobs
      SET status = 'COMPLETED',
          lease_until = NULL,
          completed_at = ?
      WHERE job_id = ?
    `).run(now.toISOString(), jobId);
  }

  /**
   * Marks a job as failed, calculating exponential backoff or moving to DEAD_LETTER.
   */
  failJob(db: DB, jobId: string, error: string, now: Date = new Date()): void {
    const job = db.prepare(
      "SELECT attempt_count, max_attempts FROM durable_jobs WHERE job_id = ?"
    ).get(jobId) as { attempt_count: number; max_attempts: number } | undefined;

    if (!job) return;

    if (job.attempt_count >= job.max_attempts) {
      db.prepare(`
        UPDATE durable_jobs
        SET status = 'DEAD_LETTER',
            lease_until = NULL,
            last_error = ?
        WHERE job_id = ?
      `).run(error.slice(0, 1000), jobId);
    } else {
      // Exponential backoff: 2s, 4s, 8s...
      const backoffMs = Math.pow(2, job.attempt_count) * 1000;
      const nextAttempt = new Date(now.getTime() + backoffMs).toISOString();

      db.prepare(`
        UPDATE durable_jobs
        SET status = 'PENDING',
            lease_until = NULL,
            next_attempt_at = ?,
            last_error = ?
        WHERE job_id = ?
      `).run(nextAttempt, error.slice(0, 1000), jobId);
    }
  }

  /**
   * Prunes completed and dead-letter jobs older than retentionDays.
   */
  pruneHistory(db: DB, retentionDays: number = 7, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const res = db.prepare(`
      DELETE FROM durable_jobs
      WHERE status IN ('COMPLETED', 'DEAD_LETTER')
        AND (completed_at <= ? OR next_attempt_at <= ?)
    `).run(cutoff, cutoff);
    return res.changes;
  }
}

// Global job queue instance
const g = globalThis as unknown as { __minimiJobQueue?: JobQueue };
export function getJobQueue(): JobQueue {
  g.__minimiJobQueue ??= new JobQueue();
  return g.__minimiJobQueue;
}

