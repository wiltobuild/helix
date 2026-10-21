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

`createRealCore({ dataDir, env }): Promise<HelixCore>` composes SQLite, Git
worktrees, node-pty, Claude Code and Codex harnesses, feedback formatting and
optional GitHub SCM. Worktrees and terminal logs live under `dataDir/worktrees`
and `dataDir/terminals`. Shutdown stops adapters and closes SQLite, including
startup failures. Tokens resolve from GH_TOKEN, GITHUB_TOKEN, then `gh auth token`;
without a token the daemon logs one line and runs without SCM. Structured logs
omit raw errors, tokens and prompts. Rejected Host/Origin requests return 403
FORBIDDEN. Health retains the frozen `{status, version}` schema.

From any directory within this workspace:

```sh
pnpm --filter @helix/daemon start
pnpm --filter @helix/daemon dev
```

On Windows PowerShell, use `pnpm.cmd` if script execution is disabled.

Default tests include real SQLite, temporary Git repositories and worktrees,
local bare pushes, HTTP/SSE, a scripted harness and fake GitHub: CI fails,
feedback triggers a committed repair, CI passes and the PR merges. They require
Git but no agent binaries, credentials or external services. The optional real
Codex variant stops after a committed diff and uses no GitHub:

```powershell
$env:HELIX_E2E = '1'
pnpm.cmd exec vitest run --project @helix/daemon apps/daemon/src/e2e.integration.test.ts
Remove-Item Env:HELIX_E2E
```
