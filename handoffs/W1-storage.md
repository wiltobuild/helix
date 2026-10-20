# W1-storage — durable event store

**Owned paths:** `packages/storage/**`

## Goal
Implement the `EventStore` interface from `@helix/contracts` on SQLite, plus the small amount of other durable state the daemon needs. This is the source of truth for everything Helix shows.

## Requirements
- **Engine:** prefer Node 24's built-in `node:sqlite` (`DatabaseSync`) — no native build step on Windows. If it is unusable for a concrete reason, use `better-sqlite3` and explain why. WAL mode, `synchronous=NORMAL`, foreign keys on. No ORM needed; write a tiny forward-only migration runner (`migrations/NNN_name.sql` or TS array), with a `schema_migrations` table. Never edit an applied migration.
- **Location:** `openStore({ dataDir })`; default `dataDir` = `HELIX_DATA_DIR` env or `~/.helix` (use `os.homedir()`), DB at `<dataDir>/helix.db`. `openStore({ memory: true })` for tests.
- **Events table:** `seq INTEGER PRIMARY KEY` (daemon-global, strictly increasing from 1), `project_id`, `session_id`, `plan_node_id`, `caused_by`, `type`, `ts`, `v`, `payload_json`. Index `(project_id, seq)` and `(session_id, seq)`.
- **`append(events)`** — atomic (one transaction), assigns seqs, validates every event with `parseEvent` *after* assigning seq, rejects the whole batch if any is invalid (throw a typed error), returns the stored events. `ts` is supplied by the caller (store must not call `Date.now()` for event data).
- **`read(projectId, sinceSeq, limit)`** — exclusive cursor, ascending, `limit` capped at `backfill.maxLimit`.
- **`subscribe(sinceSeq, cb)`** — delivers every stored event with `seq > sinceSeq` in order, then live appends, with **no gaps and no duplicates**, even if appends happen during catch-up. In-process only (the daemon is the single writer). Returns `Unsubscribe`. A throwing subscriber must not break other subscribers or the append.
- **Projects table** — `projects(id, repo_path UNIQUE, name, created_at, json)`: `saveProject`, `getProject`, `listProjects`, `findProjectByRepoPath`. (Projects also appear as `project.added` events; this table is a lookup index.)
- **Idempotency** — `idempotency(key, scope, request_hash, response_json, created_at)`: `remember(scope, key, requestHash, response)` / `recall(scope, key)`; same key + different hash → typed `IdempotencyConflictError`.
- **Recording** — `exportProject(projectId): string` using `serializeHelixlog`; `importRecording(text)` stores events of an imported recording under their original ids in a **separate read-only replay namespace** (`replay_events` table keyed by recording id) — imported runs never mix with live seqs. Expose `listRecordings()` and `readRecording(id)`.
- Export `createEventStore`/`openStore` and the error classes from `@helix/storage`.

## Tests (must include)
- append/read/subscribe happy paths; batch atomicity on an invalid event; seq strictly increasing across projects; exclusive cursors; `limit` cap.
- **Gap-free subscribe under concurrency:** subscriber attached at seq N while 1,000 events are appended in interleaved batches → receives exactly N+1..end once each, in order.
- Re-open a file-backed DB in a temp dir → data persists; migrations idempotent.
- Round-trip: append `fixtures.passwordResetRun` (reassigning seqs) → export → parse → `projectUpTo` final state equals the projection of the original.
- Idempotency conflict.
- Perf: append 10,000 events in batches of 50 in < 3 s; `read` of 1,000 in < 50 ms (log numbers in the result; assert generous bounds).
