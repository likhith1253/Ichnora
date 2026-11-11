import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema";
import { maybeCleanupDemos } from "../demo/store";

export type DB = Database.Database;

export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
  }
}

export function defaultDbPath(): string {
  // Retained MINIMI_DB_PATH and ./data/minimi.db for backward compatibility with existing local databases.
  const configured = process.env.MINIMI_DB_PATH?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), "data", "minimi.db");
}

// Survive Next.js dev hot-reloads without leaking connections.
const g = globalThis as unknown as { __ichnoraDb?: DB };

export function getDb(): DB {
  if (!g.__ichnoraDb) {
    g.__ichnoraDb = openDatabase(defaultDbPath());
    // Startup housekeeping: drop expired demo workspaces, sessions and cached
    // answers. Never fatal, and at most once every ten minutes per process.
    try {
      maybeCleanupDemos(g.__ichnoraDb);
    } catch {
      /* housekeeping must never prevent the app from booting */
    }
  }
  return g.__ichnoraDb;
}

/** Test hook: swap the process-wide database. */
export function setDbForTesting(db: DB | undefined): void {
  g.__ichnoraDb = db;
}
