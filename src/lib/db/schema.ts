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
  {
    version: 3,
    name: "personal_memory",
    sql: `
-- Entities: people, organisations, products, topics — normalised with aliases.
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  norm          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('person','org','product','topic')),
  aliases       TEXT NOT NULL DEFAULT '[]',
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, norm)
);

CREATE TABLE entity_mentions (
  entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  local_date       TEXT NOT NULL,
  PRIMARY KEY (entity_id, message_id)
);
CREATE INDEX idx_mentions_conv ON entity_mentions(conversation_id);

-- Typed personal memory. Every row is traceable to the verbatim user quote
-- and the message it came from; it is deleted with its source conversation.
CREATE TABLE memories (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('FACT','PREFERENCE','DECISION','COMMITMENT','ACTION_ITEM','FOLLOW_UP','PROJECT','RELATIONSHIP')),
  kind                TEXT NOT NULL,           -- e.g. promise|obligation|intention|waiting|chosen|considering|rejected|stated
  subject             TEXT NOT NULL,           -- normalised topic key used for dedupe/supersession
  content             TEXT NOT NULL,           -- normalised description
  quote               TEXT NOT NULL,           -- verbatim user sentence (evidence)
  owner               TEXT,                    -- 'user' | 'team' | person name
  counterparty        TEXT,                    -- e.g. Rahul
  due_date            TEXT,                    -- YYYY-MM-DD, only when explicitly stated
  event_date          TEXT NOT NULL,           -- local date the statement refers to / was made
  status              TEXT NOT NULL CHECK (status IN ('ACTIVE','OPEN','WAITING','COMPLETED','CANCELLED','SUPERSEDED','CONSIDERING')),
  confidence          REAL NOT NULL,
  evidence            TEXT NOT NULL CHECK (evidence IN ('explicit','inferred','external','suggestion')),
  rationale           TEXT,                    -- only reasoning the user actually expressed
  alternatives        TEXT NOT NULL DEFAULT '[]',
  mention_count       INTEGER NOT NULL DEFAULT 1,
  user_corrected      INTEGER NOT NULL DEFAULT 0,
  extraction_version  INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_memories_ws_type ON memories(workspace_id, type, status);
CREATE INDEX idx_memories_subject ON memories(workspace_id, subject);
CREATE INDEX idx_memories_due ON memories(workspace_id, due_date);

CREATE TABLE memory_entities (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE memory_links (
  from_id              TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id                TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation             TEXT NOT NULL CHECK (relation IN ('SUPERSEDES','CONTRADICTS','SUPPORTS','RELATED_TO','COMPLETED_BY','FOLLOWS_FROM')),
  evidence_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);

-- Append-only audit trail: creation, reinforcement, status changes, user corrections.
CREATE TABLE memory_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  note         TEXT
);
CREATE INDEX idx_memory_events ON memory_events(memory_id, id);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, quote, subject, content='memories', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, quote, subject) VALUES (new.seq, new.content, new.quote, new.subject);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, quote, subject) VALUES ('delete', old.seq, old.content, old.quote, old.subject);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content, quote, subject ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, quote, subject) VALUES ('delete', old.seq, old.content, old.quote, old.subject);
  INSERT INTO memories_fts(rowid, content, quote, subject) VALUES (new.seq, new.content, new.quote, new.subject);
END;
`,
  },
  {
    version: 4,
    name: "research_ledger",
    sql: `
-- Source provenance: official vs third-party, snippet vs full page.
ALTER TABLE turn_sources ADD COLUMN official INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn_sources ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'snippet';
ALTER TABLE turn_sources ADD COLUMN source_no INTEGER;

-- Full-page extractions actually read (relevant passages only, bounded).
CREATE TABLE source_extractions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  retrieved_at  TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  chars         INTEGER NOT NULL,
  excerpt       TEXT,
  error         TEXT
);
CREATE INDEX idx_extractions_msg ON source_extractions(message_id);

-- Dated, normalised observations: the research ledger used for change detection.
CREATE TABLE observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id      TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity           TEXT NOT NULL,
  entity_norm      TEXT NOT NULL,
  attribute        TEXT NOT NULL,           -- 'price' | 'release' | free-form column header
  raw_value        TEXT NOT NULL,
  amount           REAL,
  currency         TEXT,
  period           TEXT,                    -- month | year | one_time | null
  billing          TEXT,                    -- monthly | annual | null (how it is billed)
  unit             TEXT,                    -- user | seat | null
  tier             TEXT,
  observed_on      TEXT NOT NULL,           -- research date (local)
  effective_date   TEXT,                    -- when a price/change takes effect, if stated
  source_url       TEXT,
  source_published TEXT,
  evidence_level   TEXT NOT NULL CHECK (evidence_level IN ('full_page','snippet','recollection','unsourced'))
);
CREATE INDEX idx_observations_entity ON observations(workspace_id, entity_norm, attribute, observed_on);

-- Which source supports which statement in an answer.
CREATE TABLE claim_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  claim       TEXT NOT NULL,
  url         TEXT NOT NULL,
  official    INTEGER NOT NULL DEFAULT 0,
  evidence_level TEXT NOT NULL
);
CREATE INDEX idx_claims_msg ON claim_evidence(message_id);

-- Computed then/now comparisons attached to a re-check answer.
CREATE TABLE change_reports (
  message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  baseline_snapshot_id TEXT,
  baseline_date TEXT,
  checked_on  TEXT NOT NULL,
  rows        TEXT NOT NULL                 -- JSON ChangeRow[]
);

-- External API usage ledger (credits / tokens), for budgets and observability.
CREATE TABLE api_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,                -- tavily | groq
  kind        TEXT NOT NULL,                -- search | extract | chat
  month       TEXT NOT NULL,                -- YYYY-MM (UTC)
  units       REAL NOT NULL,                -- credits or tokens
  at          TEXT NOT NULL,
  message_id  TEXT
);
CREATE INDEX idx_usage_month ON api_usage(provider, month);

ALTER TABLE turn_metrics ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE turn_metrics ADD COLUMN completion_tokens INTEGER;
ALTER TABLE turn_metrics ADD COLUMN search_credits REAL;
ALTER TABLE turn_metrics ADD COLUMN rounds INTEGER;
`,
  },
];
