# W1-daemon — helixd HTTP/SSE/WS server + typed API client

**Owned paths:** `apps/daemon/**`, `packages/api-client/**`

## Goal
The daemon is a thin transport layer over `HelixCore` (interface in `@helix/contracts`). All domain logic lives in `@helix/core` (being built in parallel by another agent) — the daemon validates, calls `HelixCore`, maps errors, and streams events. The API client is shared by the CLI and the React app.

## apps/daemon
- **Fastify** (pin a current v5 release). Register every route from `routes` in `@helix/contracts` generically: validate params/query/headers/body with the route's zod schemas, call the matching `HelixCore` method, validate the response in dev/test (`NODE_ENV !== 'production'`), return the route's status. 404 for unknown routes. Errors → `apiErrorSchema` shape; `HelixError` (from contracts) maps `code` → HTTP status (`INVALID_REQUEST` 400, `NOT_FOUND` 404, `CONFLICT`/`IDEMPOTENCY_CONFLICT`/`DIRTY_WORKTREE`/`MERGE_BLOCKED` 409, `HARNESS_UNAVAILABLE` 503, else 500). Never leak stack traces.
- **Idempotency:** `createSession` requires `Idempotency-Key`; pass it to `HelixCore`.
- **SSE `/api/events`:** use `core.events.subscribe(since)`; cursor from `Last-Event-ID` header over `since` query (`sse.cursorPrecedence`); optional `projectId` filter; heartbeat comment every `sse.heartbeatMs`; `id: <seq>`, `event: helix`; clean up the subscription on client disconnect; backpressure: if the socket buffer exceeds 1 MB, close the stream (client reconnects with Last-Event-ID).
- **WebSocket `/mux?sessionId=`:** `@fastify/websocket`; attach via `core.terminals.attach(sessionId, onOutput)`; parse inbound with `terminalInputSchema`; `out`/`exit` frames; detach on close.
- **Security:** bind `127.0.0.1` only (`HELIX_PORT`, default 4317). Reject requests whose `Origin` header is present and not `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the Vite dev origin `http://localhost:5317`. Reject `Host` headers that aren't loopback (DNS-rebinding protection).
- **Static UI:** if `apps/web/dist` exists (resolve relative to the daemon package, overridable by `HELIX_WEB_DIST`), serve it at `/` with SPA fallback to `index.html` for non-`/api` paths.
- **Run file:** on listen, write `<dataDir>/run.json` `{ pid, port, startedAt, version }`; remove on graceful shutdown (SIGINT/SIGTERM + Windows `SIGBREAK`); call `core.shutdown()`.
- `createServer({ core, port?, webDist? })` exported for tests; `src/main.ts` wires the real core: `import { createHelixCore } from '@helix/core'` — that package is being built now; until it lands, keep `main.ts` compiling by importing it and handling a missing implementation gracefully at runtime is NOT required — just write the wiring as if `createHelixCore(options): Promise<HelixCore>` exists and mark it `// INTEGRATION:` (Claude wires it at merge).

## packages/api-client
- `createHelixClient({ baseUrl, fetch? })` → one typed method per route, derived from the `routes` table (no codegen): e.g. `client.createSession(projectId, body, { idempotencyKey })`, `client.projectEvents(projectId, { since, limit })`. Validate responses with zod; throw a typed `HelixApiError` carrying `ErrorCode`.
- `subscribeEvents({ baseUrl, since, projectId, onEvent, onStatus })` — works in browsers (`EventSource` is not enough: it can't set headers; use `fetch` streaming + a small SSE parser) and Node 24. Auto-reconnect with exponential backoff (250 ms → 10 s, jitter), resumes from the last seen seq, de-duplicates by seq, reports `onStatus('connecting'|'live'|'reconnecting'|'closed')`. Returns `{ close() }`.
- Browser-safe: no `node:` imports.

## Tests
- Daemon via `fastify.inject` with an in-memory **fake HelixCore** you write in `src/testing/`: every route (happy path + validation error + mapped domain error), idempotency header required, Origin/Host rejection, SPA fallback, unknown route.
- Real-socket SSE test: start on port 0, subscribe with the api-client, append events through the fake core's in-memory EventStore, kill the connection mid-stream, verify resume with no gaps/dupes.
- WS `/mux` round-trip with a fake TerminalHost.
- api-client: SSE parser edge cases (multi-line data, comments, partial chunks, CRLF).
