**R3 — Recommended architecture**

Build a **TypeScript/Node.js 24 application with Fastify, Postgres, Drizzle, and pg-boss**, exposing REST commands and SSE updates. Keep agent processes behind a separate execution service. Use a React web interface first; add an Electron desktop shell when packaging becomes necessary.

Orchestrator’s documented workflow combines isolated coding workspaces, conversations/terminals, and PR/CI feedback. That makes process supervision and repository ownership central requirements. This recommendation does **not** claim to reproduce its internal implementation. [Orchestrator documentation](https://docs.orchestrator.inc/)

All architecture choices below are **proposals**. **INFERRED:** sharing TypeScript contracts across the interface, API, scheduler, and adapters should reduce integration work for parallel coding agents compared with a mixed Python/TypeScript backend.

**Runtime, storage, and transport**

- **TypeScript, strict mode; Node.js 24 LTS.** Python remains suitable for isolated specialist tools, but adds little to this primarily I/O-oriented control plane. Node 24 is currently LTS; pin runtime and dependency versions. [Node releases](https://nodejs.org/en/about/previous-releases)
- **pnpm workspace monorepo.** Keep independently runnable API, worker, runner, and UI applications. Start as a modular monolith rather than separate network services for every package.
- **Postgres + Drizzle.** Use relational constraints for ownership, transactions for state transitions, and JSONB for versioned event payloads. Drizzle supports transactions and savepoints. [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- **Do not maintain SQLite/Postgres parity initially.** SQLite is attractive for installation simplicity, but WAL still permits only one writer at a time, and pg-boss requires Postgres. A later standalone edition deserves a separate storage decision. [SQLite WAL](https://www.sqlite.org/wal.html)
- **Fastify REST + OpenAPI:** `POST /runs`, `/runs/{id}/messages`, `/runs/{id}/cancel`, `/approvals/{id}/decisions`; GET endpoints for snapshots, artifacts, and events. Require idempotency keys on commands and optimistic versions on conflicting mutations. Fastify supports JSON Schema validation and serialization. [Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- **SSE for run updates**, using persisted event sequence numbers as IDs and replaying after `Last-Event-ID`. Add heartbeats, bounded buffers, and snapshot fallback after retention expiry. Use **WebSocket only for interactive terminals**, including stdin and resize. SSE is a one-way server-to-client transport. [SSE documentation](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

**Queue and durable execution**

| Option | Recommendation |
|---|---|
| **pg-boss** | Default: Postgres-backed jobs, retries, scheduling, and enqueueing inside existing database transactions fit a compact local deployment. [Documentation](https://github.com/timgit/pg-boss) |
| **Temporal** | Prefer when long-lived workflows, complex recovery, and workflow evolution justify a dedicated orchestration platform. Its local development server is a single binary; production operations remain a separate concern. [Deployment guide](https://docs.temporal.io/self-hosted-guide) |
| **Inngest** | Strong alternative for step checkpoints, retries, and external-event waits, particularly with a hosted control plane. [Durable workflows](https://www.inngest.com/docs/durable-execution/durable-workflows) |
| **Restate** | Consider for durable service/object semantics. Nondeterministic operations must be wrapped for replay. [Durable steps](https://docs.restate.dev/develop/ts/durable-steps) |
| **BullMQ** | Reasonable with existing queue infrastructure. Current docs also offer a Postgres backend; Redis remains its default and most battle-tested backend. [Backend documentation](https://docs.bullmq.io/guide/postgresql) |

With pg-boss, **the application must implement durable run state**. Execute bounded steps, persist results, and enqueue successors transactionally. Human waits become persisted states, not sleeping workers. Use leases, heartbeats, fencing tokens, retry limits, cancellation, and reconciliation.

Do not promise exactly-once external actions: a crash after a tool succeeds but before recording success creates uncertainty. Use operation IDs, provider idempotency where available, and explicit reconciliation for ambiguous outcomes.

**Contracts and parallel ownership**

Freeze `packages/contracts` first: JSON Schemas, TypeScript DTOs, event envelopes, error codes, status transitions, capability flags, protocol versions, and canonical fixtures. Exclude ORM entities and provider-specific SDK types. Give contract changes one reviewer.

| Agent | Owned paths | Public boundary |
|---|---|---|
| 1 | `packages/contracts`, `packages/testing` | Schemas, fixtures, compatibility checks |
| 2 | `packages/storage`, migrations | `EventStore.append(expectedVersion, events)`, repositories, transactional job enqueue |
| 3 | `packages/orchestration`, `apps/worker` | `Scheduler.advance`, `dispatch`, `cancel`, `reconcile` |
| 4 | `packages/providers`, `packages/harnesses` | `ModelProvider.stream`; `AgentHarness.start/send/stop/inspect` |
| 5 | `packages/execution`, `apps/runner` | `Executor.execute/cancel/inspect`; sandbox and process lifecycle |
| 6 | `packages/git`, `packages/integrations` | `WorkspaceManager.create/diff/release`; PR/CI adapter |
| 7 | `apps/api`, `packages/security` | REST/SSE, authentication, authorization, secrets |
| 8 | `apps/web`, optional `apps/desktop` | Typed API client, run board, chat, terminal |

For five agents, combine 1+2, 4+6, and 7+8. Assign one integrator ownership of root configuration, lockfile, and migration ordering. Each agent works in a separate branch/worktree and implements against shared fakes. Ban cross-package imports into private implementation files.

**Draft core data model**

All tenant-owned records carry `workspace_id`; IDs are UUIDs and timestamps UTC.

| Entity | Key fields |
|---|---|
| Workspace / Membership | id, name; user_id, role |
| Project | id, repository_location, default_branch, execution_policy_id |
| AgentDefinition | id, version, harness, model_config, instructions_hash, tool_policy |
| Run | id, project_id, parent_run_id, agent_version, status, version, budget, cancellation_requested_at |
| Step / Dependency | id, run_id, kind, status, input_ref, output_ref; predecessor_id, successor_id |
| StepAttempt | id, step_id, attempt_number, lease_owner, fencing_token, heartbeat_at, deadline, error |
| Message | id, run_id, sender, recipient, role, content_ref, reply_to_id, dedupe_key |
| ToolCall / Approval | operation_id, attempt_id, tool, argument_hash, status, result_ref; scope_hash, decision, actor, expiry |
| Worktree | id, project_id, run_id, branch, base_sha, path, lease, state |
| Artifact | id, run_id, storage_uri, content_hash, media_type, size |
| Event | id, run_id, sequence, type, schema_version, payload, actor, causation_id, correlation_id, timestamp |
| SecretRef / Integration | id, scope, backend_locator; provider, external_id, credential_ref |

Enforce unique `(run_id, sequence)`, `(step_id, attempt_number)`, and scoped command idempotency keys.

Use **event sourcing for run lifecycle**, with transactional projections for current runs/steps/messages. Allocate sequence numbers under a run-row lock; commit events, projections, and jobs together. Replay rebuilds projections—it must never repeat tools. Store large logs/artifacts separately; persist coalesced message chunks rather than every token.

Event types: `run.created`, `run.started`, `run.waiting`, `run.resumed`, `run.cancel_requested`, `run.cancelled`, `run.completed`, `run.failed`; `step.scheduled`, `step.started`, `step.retry_scheduled`, `step.completed`, `step.failed`; `message.appended`; `tool.requested`, `tool.completed`, `tool.failed`, `tool.outcome_unknown`; `approval.requested`, `approval.decided`; `workspace.created`, `workspace.released`; `artifact.created`; `budget.exceeded`; `pr.updated`, `ci.updated`.

**Providers, execution, and repositories**

Separate **model providers** from **coding-agent harnesses**. A model adapter handles Anthropic, OpenAI, or local inference; a harness adapter supervises an existing coding agent and its session protocol. Normalize text/tool deltas, usage, finish reasons, errors, and cancellation. Preserve provider extensions and declare capabilities instead of assuming compatibility. Ollama documents a specific compatibility surface that should receive its own contract tests. [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility)

Run generated commands outside the API process. Default to Linux containers through Docker Desktop/WSL2 on Windows, Docker Desktop on macOS, and Docker Engine on Linux. Use non-root users, resource limits, restricted mounts, network policy, and no Docker socket inside agent containers. Containers share a kernel; use VM isolation for hostile workloads. [Windows setup](https://docs.docker.com/desktop/setup/install/windows-install/), [Docker security](https://docs.docker.com/engine/security/)

Keep Git administration in the trusted runner. Allocate one branch/worktree per coding session, serialize repository administration, and merge through an integration queue. Worktrees share repository metadata and are **not security boundaries**. Avoid exposing the common Git directory to untrusted containers; use disposable clones or patch transfer there. Preserve dirty workspaces after failures. [Git worktree](https://git-scm.com/docs/git-worktree)

**Security, observability, and verification**

For local use, bind to loopback, authenticate sessions, validate origins, and protect mutations against CSRF. For teams, use OIDC authorization-code authentication with PKCE and workspace roles. [OIDC specification](https://openid.net/specs/openid-connect-core-1_0.html)

Store secret references in Postgres; use OS credential storage locally and a managed secret store remotely. If Electron is adopted, reject Linux `safeStorage`’s unprotected `basic_text` fallback. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

Instrument API→queue→worker→provider/tool with OpenTelemetry traces and metrics; use redacted structured logs. Track queue delay, retries, orphan processes, token usage, costs, and approval latency. JavaScript traces/metrics are stable; logs remain in development. [OpenTelemetry](https://opentelemetry.io/docs/languages/js/)

Use deterministic fake LLM streams and fake harnesses for contract tests; real Postgres for transactional tests; crash injection around tool completion and commit; SSE reconnect tests; replay equivalence tests; and Windows/macOS/Linux CI for paths, quoting, process termination, and Git lifecycle.

**Evidence limits:** no cited page was blocked. This was documentation research, not installation testing; native harness compatibility and sandbox behavior on each OS remain acceptance-test requirements.