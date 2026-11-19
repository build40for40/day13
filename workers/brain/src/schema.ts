/** Append-only: once the Worker has been deployed, never edit a migration, add a new one. */
const migrations: string[] = [
  `
  CREATE TABLE files (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'memory', 'session', 'idea', 'question', 'task', 'thought', 'topic')),
    frontmatter TEXT NOT NULL DEFAULT '{}',
    body TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE file_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('created', 'modified', 'deleted')),
    kind TEXT NOT NULL,
    frontmatter TEXT NOT NULL,
    body TEXT NOT NULL,
    actor TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX file_versions_path ON file_versions (path, id);

  CREATE TABLE links (
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (src, dst, kind)
  );
  CREATE INDEX links_dst ON links (dst);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    context TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    turns TEXT NOT NULL DEFAULT '[]',
    facts TEXT NOT NULL DEFAULT '[]',
    user_turns INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    reflect_after TEXT,
    reflection_attempts INTEGER NOT NULL DEFAULT 0,
    reflected_at TEXT,
    reflection TEXT,
    reflection_error TEXT
  );
  CREATE INDEX sessions_ended_at ON sessions (ended_at);


  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Lets new kinds like 'event' in. SQLite can't change a CHECK in place, so the table is rebuilt without one and its rows copied over.
  `
  CREATE TABLE files_next (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    frontmatter TEXT NOT NULL DEFAULT '{}',
    body TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  INSERT INTO files_next (path, kind, frontmatter, body, updated_at) SELECT path, kind, frontmatter, body, updated_at FROM files;
  DROP TABLE files;
  ALTER TABLE files_next RENAME TO files;
  `,
  // Filing moves from sessions to batches of log entries. Whatever a session still had waiting to be filed becomes a closed batch.
  `
  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    last_entry_at TEXT NOT NULL,
    last_entry_id INTEGER NOT NULL DEFAULT 0,
    user_entries INTEGER NOT NULL DEFAULT 0,
    chars INTEGER NOT NULL DEFAULT 0,
    filed_through INTEGER NOT NULL DEFAULT 0,
    tried_through INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    close_reason TEXT,
    file_after TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    settled_at TEXT,
    reflection TEXT,
    error TEXT
  );
  CREATE INDEX batches_settled_at ON batches (settled_at);

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX entries_batch ON entries (batch_id, id);
  CREATE INDEX entries_source ON entries (source, id);

  INSERT INTO batches (id, started_at, last_entry_at, user_entries, closed_at, close_reason, file_after, attempts)
  SELECT id, started_at, last_message_at, user_turns, COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 'migrated',
    COALESCE(reflect_after, ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), reflection_attempts
  FROM sessions WHERE reflected_at IS NULL AND reflection_error IS NULL AND user_turns > 0;

  INSERT INTO entries (batch_id, at, source, role, text, tool_calls)
  SELECT s.id, json_extract(t.value, '$.at'), CASE WHEN s.model = 'capture' THEN 'app' ELSE 'voice:' || s.id END,
    json_extract(t.value, '$.role'), COALESCE(json_extract(t.value, '$.text'), ''), COALESCE(json_extract(t.value, '$.tool_calls'), '[]')
  FROM sessions s, json_each(s.turns) t
  WHERE s.reflected_at IS NULL AND s.reflection_error IS NULL AND s.user_turns > 0
  ORDER BY s.started_at, s.rowid, t.key;

  UPDATE batches SET
    last_entry_id = COALESCE((SELECT MAX(id) FROM entries WHERE batch_id = batches.id), 0),
    chars = COALESCE((SELECT SUM(LENGTH(text)) FROM entries WHERE batch_id = batches.id), 0);

  DELETE FROM sessions WHERE model = 'capture' AND reflected_at IS NULL AND reflection_error IS NULL;
  `,
];

export const SCHEMA_VERSION = migrations.length;

/** Applies pending migrations and returns the version the database started at. */
export function migrate(sql: SqlStorage, now: string): number {
  sql.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const from = sql.exec<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").one().version;
  for (let version = from + 1; version <= migrations.length; version++) {
    sql.exec(migrations[version - 1]);
    sql.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, now);
  }
  return from;
}
