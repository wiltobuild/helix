# @helix/storage

Node 24 SQLite implementation of the frozen `HelixStore` contract. No native
dependency or build step is required.

```ts
import { openStore } from '@helix/storage';

const store = openStore(); // HELIX_DATA_DIR, otherwise ~/.helix/helix.db
// Also: openStore({ dataDir }) or openStore({ memory: true }).
const stop = store.subscribe(0, (event) => console.log(event.seq, event.type));
// await store.append(unsequencedEvents);
stop();
await store.close();
```

`createEventStore` is an alias for `openStore`. Opening is synchronous; the
contract's durable operations return promises. Keep one store instance per
daemon: subscriptions are in-process and only observe writes through that
instance. SQLite operations are synchronous and briefly occupy the event loop.

Events are committed atomically before subscribers are notified. Every input is
validated with `parseEvent` after sequence assignment. Failed batches leave no
events or consumed sequences. Event timestamps always come from the caller.
Reads use an exclusive cursor and cap the limit at `backfill.maxLimit` (1000).
Invalid cursors and nonpositive/noninteger limits are rejected.

Subscriptions catch up asynchronously in a microtask, then receive live events
from the same committed log. Each subscriber has its own cursor and event
objects. Reentrant appends are supported; callback exceptions and promise
rejections are isolated. Unsubscribe and close cancel pending deliveries. A slow
synchronous callback still blocks the daemon's event loop.

Project lookup updates are explicit, independent of event appends. Repository
path uniqueness uses exact strings; callers own canonicalization before saving
or looking up a path. Project listing is ordered by creation time, then ID.
`remember` preserves the first response for a `(scope, key)` pair. Both
`remember` and `recall` reject a mismatched request hash with
`IdempotencyConflictError` (`IDEMPOTENCY_CONFLICT`). Responses must be JSON
serializable. There is no automatic expiration.

`getMeta(scope, key)` / `setMeta(scope, key, value)` provide separate mutable JSON
metadata for resume tokens and delivery receipts. Missing keys return `undefined`;
`null` is an ordinary stored value. Writes atomically replace the scoped value,
survive restart, and do not emit events or enter recordings. Reads and writes
detach object values from their callers. Migration 2 adds the metadata table
without changing existing event, project, idempotency or recording data.

Exports include the complete project history, with the original genesis project
as the header and the last event timestamp as `recordedAt`. No implicit redaction
is performed. Imports are validated atomically and stored in separate replay
tables, preserving original IDs, sequences, and causal links. They do not update
live events, project lookup entries, or subscribers. Canonically equivalent
imports share a SHA-256 recording ID; different recordings of the same project
can coexist. The replay API has no update or deletion operations.

The returned `StorageStore` extends `HelixStore` with:

- `listRecordings(): Promise<RecordingInfo[]>` — metadata ordered by import time,
  then recording ID.
- `readRecording(id: string): Promise<Helixlog | undefined>` — isolated replay
  history, or `undefined` for an unknown ID.

The frozen import response has no recording ID; discover IDs through
`listRecordings`. This missing shared lookup seam is marked `CONTRACT-REQUEST`
in the implementation.

Domain errors extend the contracts' `HelixError`. Exported subclasses are
`EventValidationError`, `RecordingValidationError`, `IdempotencyConflictError`,
`ProjectConflictError`, and `StorageError`. Underlying database failures are
wrapped as `INTERNAL_ERROR` with the original failure in `cause`.

The database uses WAL, `synchronous=NORMAL`, foreign keys, and a five-second busy
timeout. In-memory SQLite uses its native memory journal (WAL requires a file).
Migrations run transactionally and record version/name in `schema_migrations`;
append migrations without editing shipped versions. Unknown or inconsistent
migration histories fail open rather than silently downgrading a database.

Run `pnpm --filter @helix/storage format`, `typecheck`, `lint`, and `test` from the
workspace root. The tests use temporary databases and no network or agents.
