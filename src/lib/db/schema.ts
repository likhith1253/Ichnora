/**
 * Forward-only migrations. Each entry runs once inside a transaction and is
 * recorded in `schema_migrations`. Never edit a shipped migration; append.
 */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_conversations_ws ON conversations(workspace_id, updated_at DESC);

-- Immutable source of truth: original user and assistant messages.
CREATE TABLE messages (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','error','cancelled')),
  created_at_utc     TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  local_date         TEXT NOT NULL,
  turn_index         INTEGER NOT NULL,
  client_request_id  TEXT,
  metadata           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, turn_index, seq);
CREATE INDEX idx_messages_date ON messages(workspace_id, local_date);
CREATE UNIQUE INDEX idx_messages_request ON messages(conversation_id, client_request_id, role)
  WHERE client_request_id IS NOT NULL;

CREATE VIRTUAL TABLE message_fts USING fts5(
  content, content='messages', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;

-- Web sources that support an assistant turn (provenance for citations).
CREATE TABLE turn_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT,
  domain        TEXT NOT NULL,
  retrieved_at  TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('search','citation','answer_link')),
  UNIQUE(message_id, url)
);

-- Distilled, traceable memory. Always points back to source messages.
CREATE TABLE memory_items (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  entities            TEXT NOT NULL DEFAULT '[]',
  facts               TEXT NOT NULL DEFAULT '[]',
  source_message_ids  TEXT NOT NULL DEFAULT '[]',
  baseline_date       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  superseded_by       TEXT
);
CREATE INDEX idx_memory_ws ON memory_items(workspace_id, updated_at DESC);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, summary, entities, content='memory_items', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER memory_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts(rowid, title, summary, entities) VALUES (new.seq, new.title, new.summary, new.entities);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, summary, entities) VALUES ('delete', old.seq, old.title, old.summary, old.entities);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, summary, entities) VALUES ('delete', old.seq, old.title, old.summary, old.entities);
  INSERT INTO memory_fts(rowid, title, summary, entities) VALUES (new.seq, new.title, new.summary, new.entities);
END;

-- Latency/observability per turn (no content, no secrets).
CREATE TABLE turn_metrics (
  message_id        TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  intent            TEXT NOT NULL,
  tool_choice       TEXT NOT NULL,
  searches          INTEGER NOT NULL,
  first_token_ms    INTEGER,
  total_ms          INTEGER NOT NULL,
  memory_ms         INTEGER NOT NULL,
  model             TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "source_evidence",
    sql: `
ALTER TABLE turn_sources ADD COLUMN snippet TEXT;
ALTER TABLE turn_sources ADD COLUMN published_date TEXT;
ALTER TABLE turn_sources ADD COLUMN query TEXT;
`,
  },
];
