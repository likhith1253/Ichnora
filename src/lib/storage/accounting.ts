import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db";

export interface StorageAccounting {
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  archiveBytes: number;
  cacheBytes: number;
  totalStorageBytes: number;
  freeDiskBytes?: number;
  lowDiskWarning: boolean;
}

const LOW_DISK_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB warning threshold

function getFileSizeSafe(filePath: string): number {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      return stats.size;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function getDirectorySizeSafe(dirPath: string): number {
  let total = 0;
  try {
    if (fs.existsSync(dirPath)) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += getDirectorySizeSafe(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

/**
 * Calculates accurate storage consumption for SQLite, WAL, Archives, and Caches.
 */
export function getStorageAccounting(dbPath: string, archiveDir?: string): StorageAccounting {
  const dbBytes = getFileSizeSafe(dbPath);
  const walBytes = getFileSizeSafe(`${dbPath}-wal`);
  const shmBytes = getFileSizeSafe(`${dbPath}-shm`);

  const arcDir = archiveDir ?? path.join(path.dirname(dbPath), "archives");
  const archiveBytes = getDirectorySizeSafe(arcDir);

  let freeDiskBytes: number | undefined;
  try {
    if (fs.statfsSync) {
      const stat = fs.statfsSync(path.dirname(dbPath));
      freeDiskBytes = stat.bavail * stat.bsize;
    }
  } catch {
    /* statfs might not be available on all environments */
  }

  const totalStorageBytes = dbBytes + walBytes + shmBytes + archiveBytes;
  const lowDiskWarning = freeDiskBytes !== undefined && freeDiskBytes < LOW_DISK_THRESHOLD_BYTES;

  return {
    dbBytes,
    walBytes,
    shmBytes,
    archiveBytes,
    cacheBytes: 0, // Enriched if DB provides table metrics
    totalStorageBytes,
    freeDiskBytes,
    lowDiskWarning,
  };
}

/**
 * Validates SQLite DB health and ensures database is in a good operational state.
 */
export function checkDbIntegrity(db: DB): { ok: boolean; message: string } {
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const res = row?.integrity_check ?? Object.values(row ?? {})[0];
    const ok = String(res).toLowerCase() === "ok";
    return { ok, message: String(res) };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Safe checkpoint helper to keep WAL from growing unboundedly.
 */
export function checkpointWal(db: DB, mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
  } catch {
    /* ignore busy error */
  }
}

