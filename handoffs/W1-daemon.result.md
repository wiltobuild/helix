**Summary** — Implemented the daemon’s HTTP/SSE/WebSocket transports and typed API client. Changes are uncommitted.

**Public API** — Exports include:

- `createServer(options: ServerOptions)`
- `startDaemon(options: DaemonOptions)`
- `createHelixClient(options): HelixClient`
- `subscribeEvents(options): EventSubscription`
- `createSseParser(onFrame)`, `HelixApiError`, `parsePort`, `DEFAULT_PORT`

Full signatures and route methods are in the [result file](C:/Users/Wil/Documents/Projects/helix-wt/w1-daemon/handoffs/W1-daemon.result.md).

**Files** — Only `apps/daemon/**`, `packages/api-client/**`, and the result file changed.

**New dependencies**

| Package | Version | Release date |
|---|---|---|
| fastify | 5.12.5 | 2026-09-16 |
| @fastify/websocket | 11.3.3 | 2026-10-03 |
| @fastify/static | 10.1.5 | 2026-09-26 |
| zod | 4.6.5 | 2026-09-13 |
| ws | 8.22.0 | 2026-09-26 |
| @types/ws | 8.18.2 | 2026-09-29 |

**Decisions** — Domain logic and idempotency remain in `HelixCore`. The terminal client helper returns a validated WebSocket URL.

**CONTRACT-REQUESTs** — None.

**Verification** — Root `pnpm check` exited **0**. All **58 focused tests** passed: 48 daemon, 10 API client. Formatting, typecheck, lint, and boundaries passed.

**Known gaps / follow-ups** — Claude must compose the real core dependencies in `main.ts`, remove the temporary factory augmentation, and regenerate the shared root lockfile at merge.