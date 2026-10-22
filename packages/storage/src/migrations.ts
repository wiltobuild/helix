import type { DatabaseSync } from 'node:sqlite';

// Forward-only: add migrations; never change SQL for a version already shipped.
const migrations = [
  {
    version: 1,
    name: 'initial_storage',
    sql: `
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY CHECK (seq > 0),
        project_id TEXT NOT NULL,
        session_id TEXT,
        plan_node_id TEXT,
        caused_by INTEGER,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        v INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX events_project_seq ON events(project_id, seq);
      CREATE INDEX events_session_seq ON events(session_id, seq);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE idempotency (
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        header_json TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE replay_events (
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (recording_id, seq)
      );
    `,
  },
] as const;

export function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    const applied = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all();
    for (const [index, row] of applied.entries()) {
      const migration = migrations[index];
      if (!migration || row.version !== migration.version || row.name !== migration.name) {
        throw new Error('Database migration history is not supported by this storage version');
      }
    }
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
