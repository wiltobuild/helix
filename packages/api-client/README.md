# @helix/api-client

Browser-safe, schema-validated access to the frozen Helix routes. Node 24 and browsers
use the same implementation. No code generation or Node built-in imports.

```ts
import { createHelixClient, subscribeEvents } from '@helix/api-client';

const client = createHelixClient({ baseUrl: 'http://127.0.0.1:4317' });
const projects = await client.projects();
const project = projects[0];
if (project) {
  await client.createSession(
    project.id,
    { title: 'Task', prompt: 'Implement it', agent: 'codex', interface: 'chat' },
    { idempotencyKey: crypto.randomUUID() },
  );
  await client.projectEvents(project.id, { since: 0, limit: 100 });
}

const subscription = subscribeEvents({
  baseUrl: 'http://127.0.0.1:4317',
  onEvent: (event) => console.log(event),
  onStatus: (status) => console.log(status),
});
subscription.close();
```

The 16 HTTP methods retain the route table names. Arguments are path ID, request
body (when present), query (when present), and idempotency options (when required).
Query cursors/page sizes are numbers; the client serializes the contract's wire
strings. `sessionDiff(sessionId, { scope })` requires a scope. Import/export use raw
UTF-8 `.helixlog` text. Response failures throw `HelixApiError` with `code`, `status`
and optional validated `details`.

`client.events(options)` binds the client's URL and optional fetch implementation
to `subscribeEvents`. `client.terminal(sessionId)` returns a validated WS/WSS URL;
the terminal UI owns the WebSocket and uses the contract's terminal schemas.

SSE reconnects with jittered exponential backoff (250 ms to 10 s), sets both the
query cursor and `Last-Event-ID`, and ignores already-delivered sequences. Global
sequence gaps are valid. An incomplete or invalid frame does not advance the
cursor. `close()` aborts the reader and pending retry, and reports `closed` once.
Callbacks should complete synchronously and must not throw. A stream's project
filter remains fixed for its lifetime; create a new subscription to change it.
