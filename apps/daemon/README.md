# @helix/daemon

The transport layer consumes `HelixCore`, `EventStore` and `TerminalHost` from
`@helix/contracts`. It contains no domain state or stored display statuses.

- `createServer({ core, port?, webDist? })` returns a Fastify instance for injection
  or embedding. It shuts the supplied core down when closed.
- `startDaemon({ core, dataDir, version, port?, webDist? })` starts the core, listens
  on `127.0.0.1`, writes `run.json`, and returns `{ server, port, stop() }`.
  `stop()` is idempotent. SIGINT/SIGTERM and Windows SIGBREAK call it.
- `parsePort(value)` validates the port, defaulting to 4317. Port 0 is supported
  for tests; run.json records the actual assigned port.

Environment: `HELIX_PORT`, `HELIX_WEB_DIST`, `HELIX_DATA_DIR` (default `~/.helix`).
The static UI defaults to `apps/web/dist`, resolved relative to this package.
The lifecycle helper always binds loopback; embedders must also use loopback.

All contract HTTP routes validate requests, call a typed core dispatch map, and
validate successful responses outside production. Errors use `apiErrorSchema`;
internal messages and arbitrary error details are omitted to avoid exposing
stacks or implementation details. Host and Origin checks apply to HTTP, SSE,
static assets and WS upgrades. Allowed origins also receive CORS/preflight
headers so the Vite frontend can connect directly.

SSE uses the event store's atomic replay/live subscription, header-over-query
cursor precedence, project filtering and 15-second comment heartbeats. Slow
clients disconnect above 1 MiB queued output and resume through the client.
Terminal WS input is schema-validated, bounded while attachment is pending, and
detached even when the browser disconnects before attachment resolves.

Integration: `main.ts` follows this handoff's assumed async options factory.
`core-integration.d.ts` temporarily declares that missing export. Remove this
augmentation and compose the real core dependencies at merge: the core handoff
currently describes a synchronous factory accepting injected `CoreDeps`.

Tests use a local fake core and loopback sockets only. No agent binaries, GitHub
or external services are needed.
