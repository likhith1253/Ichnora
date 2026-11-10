import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DB } from "../../db";
import { defaultDbPath } from "../../db";

export interface BackupManifest {
  version: number;
  dbPath: string;
  backupTime: string;
  dbSha256: string;
  archiveFiles: string[];
  dbSizeBytes: number;
}

export interface BackupOptions {
  backupDir?: string;
  archiveDir?: string;
  maxBackupsToRetain?: number;
}

export class BackupManager {
  private backupDir: string;
  private archiveDir: string;
  private maxBackups: number;

  constructor(opts: BackupOptions = {}) {
    this.backupDir = opts.backupDir ?? path.join(process.cwd(), "data", "backups");
    this.archiveDir = opts.archiveDir ?? path.join(process.cwd(), "data", "archives");
    this.maxBackups = opts.maxBackupsToRetain ?? 5;
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  /**
   * Creates an online hot backup using SQLite Online Backup API.
   * Generates a manifest with SHA-256 and copies associated archive files.
   */
  async createBackup(db: DB, targetName?: string): Promise<{ manifestPath: string; backupDbPath: string; manifest: BackupManifest }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = targetName ?? `backup_${timestamp}`;
    const targetDir = path.join(this.backupDir, name);
    fs.mkdirSync(targetDir, { recursive: true });

    const backupDbPath = path.join(targetDir, "minimi.db");

    // Perform SQLite Online Backup (safe during WAL writes)
    await db.backup(backupDbPath);

    // Compute checksum of the backed up database
    const dbBytes = fs.readFileSync(backupDbPath);
    const dbSha256 = createHash("sha256").update(dbBytes).digest("hex");

    // Track included archive segment files
    const archiveFiles: string[] = [];
    if (fs.existsSync(this.archiveDir)) {
      const targetArchiveDir = path.join(targetDir, "archives");
      fs.mkdirSync(targetArchiveDir, { recursive: true });

      const files = fs.readdirSync(this.archiveDir).filter((f) => f.endsWith(".json.gz"));
      for (const f of files) {
        const src = path.join(this.archiveDir, f);
        const dst = path.join(targetArchiveDir, f);
        fs.copyFileSync(src, dst);
        archiveFiles.push(f);
      }
    }

    const manifest: BackupManifest = {
      version: 1,
      dbPath: defaultDbPath(),
      backupTime: new Date().toISOString(),
      dbSha256,
      archiveFiles,
      dbSizeBytes: dbBytes.byteLength,
    };

    const manifestPath = path.join(targetDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    this.rotateBackups();

    return { manifestPath, backupDbPath, manifest };
  }

  /**
   * Restores a backup to a specified directory, validating checksum and schema.
   */
  restoreBackup(backupName: string, restoreDir: string): { restoredDbPath: string; manifest: BackupManifest } {
    const targetDir = path.join(this.backupDir, backupName);
    const manifestPath = path.join(targetDir, "manifest.json");

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Backup manifest not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
    const srcDbPath = path.join(targetDir, "minimi.db");

    if (!fs.existsSync(srcDbPath)) {
      throw new Error(`Backup database file not found at ${srcDbPath}`);
    }

    // Verify SHA-256 before restoring
    const bytes = fs.readFileSync(srcDbPath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== manifest.dbSha256) {
      throw new Error("Backup integrity check failed: database checksum mismatch!");
    }

    fs.mkdirSync(restoreDir, { recursive: true });
    const restoredDbPath = path.join(restoreDir, "minimi.db");
    fs.copyFileSync(srcDbPath, restoredDbPath);

    // Restore archive segments if present
    const srcArchives = path.join(targetDir, "archives");
    if (fs.existsSync(srcArchives)) {
      const dstArchives = path.join(restoreDir, "archives");
      fs.mkdirSync(dstArchives, { recursive: true });
      for (const f of fs.readdirSync(srcArchives)) {
        fs.copyFileSync(path.join(srcArchives, f), path.join(dstArchives, f));
      }
    }

    return { restoredDbPath, manifest };
  }

  /**
   * Keeps only the newest `maxBackups` backup snapshots.
   */
  rotateBackups(): number {
    let deleted = 0;
    try {
      const dirs = fs
        .readdirSync(this.backupDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (d.name.startsWith("backup_") || d.name.startsWith("manual_")))
        .map((d) => ({
          name: d.name,
          fullPath: path.join(this.backupDir, d.name),
          birthtime: fs.statSync(path.join(this.backupDir, d.name)).birthtimeMs,
        }))
        .sort((a, b) => b.birthtime - a.birthtime);

      if (dirs.length > this.maxBackups) {
        const toDelete = dirs.slice(this.maxBackups);
        for (const item of toDelete) {
          fs.rmSync(item.fullPath, { recursive: true, force: true });
          deleted++;
        }
      }
    } catch {
      /* ignore */
    }
    return deleted;
  }
}
