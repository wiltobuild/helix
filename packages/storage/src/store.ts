/* eslint-disable @typescript-eslint/require-await -- DatabaseSync implements the Promise-based frozen contracts. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  backfill,
  HelixError,
  isHelixError,
  metaValueSchema,
  parseEvent,
  parseHelixlog,
  projectSchema,
  serializeHelixlog,
  type HelixEvent,
  type Helixlog,
  type HelixlogHeader,
  type HelixStore,
  type MetaValue,
  type Project,
  type ProjectId,
  type RecordingImportResponse,
  type UnsequencedEvent,
  type Unsubscribe,
} from '@helix/contracts';
import {
  EventValidationError,
  IdempotencyConflictError,
  ProjectConflictError,
  RecordingValidationError,
  StorageError,
} from './errors.js';
import { migrate } from './migrations.js';

export interface OpenStoreOptions {
  dataDir?: string;
  memory?: boolean;
}

// CONTRACT-REQUEST: add recording IDs and lookup methods to the shared recording seam.
// Import's frozen RecordingImportResponse is returned exactly, without extra properties.
export type RecordingInfo = RecordingImportResponse & { id: string; importedAt: string };
export interface StorageStore extends HelixStore {
  listRecordings(): Promise<RecordingInfo[]>;
  readRecording(id: string): Promise<Helixlog | undefined>;
}

type EventRow = {
  seq: number;
  project_id: string;
  session_id: string | null;
  plan_node_id: string | null;
  caused_by: number | null;
  type: string;
  ts: string;
  v: number;
  payload_json: string;
};
type RecordingRow = {
  id: string;
  header_json: string;
  event_count: number;
  last_seq: number;
  imported_at: string;
};
type Subscriber = { cursor: number; cb: (event: HelixEvent) => void; active: boolean };

// Only validated, committed events enter this table. Avoid revalidating every read.
function decodeEvent(row: EventRow): HelixEvent {
  return {
    seq: row.seq,
    projectId: row.project_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.plan_node_id === null ? {} : { planNodeId: row.plan_node_id }),
    ...(row.caused_by === null ? {} : { causedBy: row.caused_by }),
    type: row.type,
    ts: row.ts,
    v: row.v,
    payload: JSON.parse(row.payload_json) as unknown,
  } as HelixEvent;
}

function checkCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HelixError('INVALID_REQUEST', 'Sequence cursor must be a nonnegative safe integer');
  }
}

class SqliteStore implements StorageStore {
  private closed = false;
  private scheduled = false;
  private readonly subscribers = new Set<Subscriber>();
  private readonly insertEvent: StatementSync;
  private readonly readProject: StatementSync;
  private readonly readGlobal: StatementSync;
  private readonly lastSeq: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insertEvent = db.prepare(`INSERT INTO events
      (seq, project_id, session_id, plan_node_id, caused_by, type, ts, v, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.readProject = db.prepare(
      'SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    );
    this.readGlobal = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
    this.lastSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events');
  }

  private run<T>(operation: () => T): T {
    if (this.closed) throw new StorageError('Store is closed');
    try {
      return operation();
    } catch (error) {
      if (isHelixError(error)) throw error;
      throw new StorageError('SQLite storage operation failed', error);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async append(events: UnsequencedEvent[]): Promise<HelixEvent[]> {
    const stored = this.run(() =>
      this.transaction(() => {
        let seq = this.lastSeq.get()!.seq as number;
        return events.map((event, index) => {
          const parsed = parseEvent({ ...event, seq: ++seq });
          if (!parsed.success) throw new EventValidationError(index, parsed.error.issues);
          const value = parsed.data;
          this.insertEvent.run(
            value.seq,
            value.projectId,
            value.sessionId ?? null,
            value.planNodeId ?? null,
            value.causedBy ?? null,
            value.type,
            value.ts,
            value.v,
            JSON.stringify(value.payload),
          );
          return value;
        });
      }),
    );
    if (stored.length) this.scheduleDelivery();
    return stored;
  }

  async read(projectId: ProjectId, sinceSeq: number, limit: number): Promise<HelixEvent[]> {
    return this.run(() => {
      checkCursor(sinceSeq);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new HelixError('INVALID_REQUEST', 'Limit must be a positive safe integer');
      }
      const rows = this.readProject.all(projectId, sinceSeq, Math.min(limit, backfill.maxLimit));
      return (rows as EventRow[]).map(decodeEvent);
    });
  }

  subscribe(sinceSeq: number, cb: (event: HelixEvent) => void): Unsubscribe {
    return this.run(() => {
      checkCursor(sinceSeq);
      const subscriber = { cursor: sinceSeq, cb, active: true };
      this.subscribers.add(subscriber);
      this.scheduleDelivery();
      return () => {
        subscriber.active = false;
        this.subscribers.delete(subscriber);
      };
    });
  }

  private scheduleDelivery(): void {
    if (this.scheduled || this.closed || !this.subscribers.size) return;
    this.scheduled = true;
    queueMicrotask(() => {
      try {
        // The committed database is the queue. Reentrant appends cannot overtake
        // catch-up, and each subscriber owns its cursor and decoded event objects.
        for (const subscriber of this.subscribers) {
          while (subscriber.active && !this.closed) {
            const rows = this.readGlobal.all(subscriber.cursor, backfill.maxLimit) as EventRow[];
            if (!rows.length) break;
            for (const row of rows) {
              if (!subscriber.active || this.closed) break;
              subscriber.cursor = row.seq;
              try {
                const result: unknown = subscriber.cb(decodeEvent(row));
                // Also isolate rejected promises from accidentally async callbacks.
                void Promise.resolve(result).catch(() => undefined);
              } catch {
                // Observer failures must never roll back a commit or stall delivery.
              }
            }
          }
        }
      } finally {
        this.scheduled = false;
        // A later observer may append after an earlier observer has caught up.
        // Schedule another pass so that earlier cursors cannot be stranded.
        if (!this.closed && this.subscribers.size) {
          const end = this.lastSeq.get()!.seq as number;
          if ([...this.subscribers].some((subscriber) => subscriber.cursor < end)) {
            this.scheduleDelivery();
          }
        }
      }
    });
  }

  async saveProject(project: Project): Promise<void> {
    this.run(() => {
      const parsed = projectSchema.safeParse(project);
      if (!parsed.success)
        throw new HelixError('INVALID_REQUEST', 'Invalid project', parsed.error.issues);
      const value = parsed.data;
      this.transaction(() => {
        const existing = this.db
          .prepare('SELECT id FROM projects WHERE repo_path = ?')
          .get(value.repoPath);
        if (existing && existing.id !== value.id) throw new ProjectConflictError(value.repoPath);
        this.db
          .prepare(
            `INSERT INTO projects (id, repo_path, name, created_at, json)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          repo_path=excluded.repo_path, name=excluded.name, created_at=excluded.created_at, json=excluded.json`,
          )
          .run(value.id, value.repoPath, value.name, value.createdAt, JSON.stringify(value));
      });
    });
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    return this.run(() => {
      const row = this.db.prepare('SELECT json FROM projects WHERE id = ?').get(id);
      return row ? (JSON.parse(row.json as string) as Project) : undefined;
    });
  }

  async listProjects(): Promise<Project[]> {
    return this.run(() =>
      this.db
        .prepare('SELECT json FROM projects ORDER BY created_at, id')
        .all()
        .map((row) => JSON.parse(row.json as string) as Project),
    );
  }

  async findProjectByRepoPath(repoPath: string): Promise<Project | undefined> {
    return this.run(() => {
      const row = this.db.prepare('SELECT json FROM projects WHERE repo_path = ?').get(repoPath);
      return row ? (JSON.parse(row.json as string) as Project) : undefined;
    });
  }

  async getMeta(scope: string, key: string): Promise<MetaValue | undefined> {
    return this.run(() => {
      const row = this.db
        .prepare('SELECT value_json FROM metadata WHERE scope = ? AND key = ?')
        .get(scope, key);
      return row ? metaValueSchema.parse(JSON.parse(row.value_json as string)) : undefined;
    });
  }

  async setMeta(scope: string, key: string, value: MetaValue): Promise<void> {
    this.run(() => {
      const parsed = metaValueSchema.safeParse(value);
      if (!parsed.success) throw new HelixError('INVALID_REQUEST', 'Metadata must be a JSON value');
      this.db
        .prepare(
          `INSERT INTO metadata (scope, key, value_json) VALUES (?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json`,
        )
        .run(scope, key, JSON.stringify(parsed.data));
    });
  }

  async recall(scope: string, key: string, requestHash: string): Promise<unknown> {
    return this.run(() => {
      const row = this.db
        .prepare('SELECT request_hash, response_json FROM idempotency WHERE scope = ? AND key = ?')
        .get(scope, key);
      if (!row) return undefined;
      if (row.request_hash !== requestHash) throw new IdempotencyConflictError(scope, key);
      return JSON.parse(row.response_json as string) as unknown;
    });
  }

  async remember(
    scope: string,
    key: string,
    requestHash: string,
    response: unknown,
  ): Promise<void> {
    this.run(() =>
      this.transaction(() => {
        const existing = this.db
          .prepare('SELECT request_hash FROM idempotency WHERE scope = ? AND key = ?')
          .get(scope, key);
        if (existing) {
          if (existing.request_hash !== requestHash) throw new IdempotencyConflictError(scope, key);
          return; // First successful result wins, including its original creation time.
        }
        let json: string | undefined;
        try {
          json = JSON.stringify(response);
        } catch {
          throw new HelixError('INVALID_REQUEST', 'Idempotency response must be JSON serializable');
        }
        if (json === undefined)
          throw new HelixError('INVALID_REQUEST', 'Idempotency response must be JSON serializable');
        this.db
          .prepare(
            `INSERT INTO idempotency (scope, key, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)`,
          )
          .run(scope, key, requestHash, json, new Date().toISOString());
      }),
    );
  }

  async exportProject(projectId: ProjectId): Promise<string> {
    return this.run(() => {
      const events = (
        this.db
          .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY seq')
          .all(projectId) as EventRow[]
      ).map(decodeEvent);
      const first = events[0];
      if (!first)
        throw new HelixError('NOT_FOUND', 'Project has no recorded events', { projectId });
      if (first.type !== 'project.added')
        throw new RecordingValidationError('Project history must begin with project.added');
      try {
        return serializeHelixlog({
          header: {
            format: 'helixlog',
            version: 1,
            project: first.payload.project,
            recordedAt: events.at(-1)!.ts,
            redactions: [],
          },
          events,
        });
      } catch {
        throw new RecordingValidationError('Project history is not a valid recording');
      }
    });
  }

  async importRecording(text: string): Promise<RecordingImportResponse> {
    return this.run(() => {
      const parsed = parseHelixlog(text);
      if (!parsed.success) throw new RecordingValidationError('Invalid recording', parsed.error);
      const log = parsed.data;
      const id = createHash('sha256').update(serializeHelixlog(log)).digest('hex');
      const eventCount = log.events.length;
      const lastSeq = log.events.at(-1)!.seq;
      this.transaction(() => {
        if (this.db.prepare('SELECT id FROM recordings WHERE id = ?').get(id)) return;
        this.db
          .prepare(
            `INSERT INTO recordings (id, header_json, event_count, last_seq, imported_at)
          VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, JSON.stringify(log.header), eventCount, lastSeq, new Date().toISOString());
        const insert = this.db.prepare(
          'INSERT INTO replay_events (recording_id, seq, event_json) VALUES (?, ?, ?)',
        );
        for (const event of log.events) insert.run(id, event.seq, JSON.stringify(event));
      });
      return { project: log.header.project, eventCount, lastSeq };
    });
  }

  async listRecordings(): Promise<RecordingInfo[]> {
    return this.run(() =>
      (
        this.db.prepare('SELECT * FROM recordings ORDER BY imported_at, id').all() as RecordingRow[]
      ).map((row) => ({
        id: row.id,
        project: (JSON.parse(row.header_json) as HelixlogHeader).project,
        eventCount: row.event_count,
        lastSeq: row.last_seq,
        importedAt: row.imported_at,
      })),
    );
  }

  async readRecording(id: string): Promise<Helixlog | undefined> {
    return this.run(() => {
      const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as
        RecordingRow | undefined;
      if (!row) return undefined;
      const events = this.db
        .prepare('SELECT event_json FROM replay_events WHERE recording_id = ? ORDER BY seq')
        .all(id)
        .map((event) => JSON.parse(event.event_json as string) as HelixEvent);
      return { header: JSON.parse(row.header_json) as HelixlogHeader, events };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.run(() => this.db.close());
    this.closed = true;
    for (const subscriber of this.subscribers) subscriber.active = false;
    this.subscribers.clear();
  }
}

/** Opens synchronously; all durable operations use the asynchronous HelixStore seam. */
export function openStore(options: OpenStoreOptions = {}): StorageStore {
  let db: DatabaseSync | undefined;
  try {
    let path = ':memory:';
    if (!options.memory) {
      const dataDir = options.dataDir ?? process.env.HELIX_DATA_DIR ?? join(homedir(), '.helix');
      mkdirSync(dataDir, { recursive: true });
      path = join(dataDir, 'helix.db');
    }
    db = new DatabaseSync(path);
    db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
    );
    migrate(db);
    return new SqliteStore(db);
  } catch (error) {
    db?.close();
    throw new StorageError('Unable to open Helix store', error);
  }
}

export const createEventStore = openStore;
