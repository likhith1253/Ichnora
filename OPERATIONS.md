# Minimi — Operations Manual

This guide explains local storage layout, operational commands, diagnostic endpoints, maintenance routines, and disaster recovery procedures for Minimi.

---

## 1. Local Data Layout

All local persistent files reside in the application directory:
```text
data/
├── minimi.db              # Canonical active SQLite database (WAL mode)
├── minimi.db-wal          # SQLite Write-Ahead Log
├── minimi.db-shm          # Shared-memory index for WAL
├── archives/              # Compressed immutable archive segments (.json.gz)
│   └── <ws>_<conv>_<ts>.json.gz
└── backups/               # Automated & manual hot backups
    └── backup_<timestamp>/
        ├── minimi.db      # Hot SQLite snapshot
        ├── manifest.json  # Checksum & file manifest
        └── archives/      # Archive segment copies
```

---

## 2. Diagnostics & Health Monitoring

The diagnostic endpoint `/api/status` provides real-time health information:
- Configured LLM provider & search tool contract (`web_search`).
- Storage footprint: DB bytes, WAL bytes, SHM bytes, archive bytes, and disk headroom warning.
- SQLite database integrity check result (`PRAGMA integrity_check`).
- Cache statistics: hit count, miss count, in-memory bytes, and persistent cache row count.

```bash
# Check system status
curl http://localhost:3000/api/status
```

---

## 3. Storage Maintenance & Local Archival

### Inspecting Storage
Storage metrics are reported via `getStorageAccounting(dbPath)`. A low-disk warning triggers when available disk space falls below 50MB.

### Archiving Old Conversations
Conversations older than a specified threshold (e.g. 30 days) can be archived into compressed `.json.gz` segments:
```typescript
import { ArchiveManager } from "@/lib/storage/archive";
import { getDb } from "@/lib/db";

const db = getDb();
const mgr = new ArchiveManager("data/archives");
mgr.initSchema(db);

// Archive conversation
mgr.archiveConversation(db, workspaceId, conversationId);
```
Archival yields **>94% disk space reduction** on archived messages while preserving full-text searchability via `archive_fts` and date-based recall.

---

## 4. Cache Management

Minimi uses a multi-tier cache (`BoundedLRUCache` + persistent SQLite `local_cache`):
- **Pruning Expired Entries:** Automatically handled by background jobs or manual call:
  ```typescript
  import { getCacheStore } from "@/lib/cache/store";
  getCacheStore().prune(db);
  ```
- **Workspace Invalidation:** Invalidate all cached data for a specific workspace on user deletion:
  ```typescript
  getCacheStore().invalidateWorkspace(db, workspaceId);
  ```

---

## 5. Backup & Disaster Recovery

### Creating a Hot Backup
Backups use the SQLite Online Backup API and run safely during concurrent WAL writes:
```typescript
import { BackupManager } from "@/lib/storage/backup";
import { getDb } from "@/lib/db";

const backupMgr = new BackupManager();
await backupMgr.createBackup(getDb(), "manual_backup");
```

### Restoring from a Backup
Restoration validates SHA-256 checksums before unpacking:
```typescript
const backupMgr = new BackupManager();
const { restoredDbPath, manifest } = backupMgr.restoreBackup("manual_backup", "data/restored");
```

---

## 6. Durable Job Worker

Background maintenance jobs run via the durable SQLite queue (`durable_jobs`):
```typescript
import { runJobWorkerPass } from "@/lib/jobs/worker";

// Run a single worker pass (leases and processes up to 5 jobs)
await runJobWorkerPass();
```
Job types supported: `cleanup_demos`, `prune_caches`, `checkpoint_wal`, `check_integrity`, `archive_eligible`, `backup_snapshot`.

