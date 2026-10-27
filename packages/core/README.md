# @helix/core

Domain orchestration implementing the frozen `HelixCore` interface. Domain interfaces come from `@helix/contracts`; storage, harnesses, Git, SCM and terminal
implementations are injected. Default terminal commands use the public executable
resolver from `@helix/harness`. There is no process spawning, network client or
persisted display status in this package.

## Public API

```ts
import { createHelixCore, type CoreDeps, type CoreLog } from '@helix/core';

const core = createHelixCore(deps); // HelixCore
await core.start();
```

`CoreDeps` requires `store: HelixStore`, `harnesses: Record<AgentKind, AgentHarness>`,
`worktrees: GitService`, `terminals: TerminalHost`,
`buildFeedbackMessage: FeedbackMessageBuilder`, `clock: () => string`,
`ids: (prefix: string) => string`, and `log: CoreLog`. Supply `scm?: ScmObserver`
for automatic PR shipping, observation, feedback and merge.
`CoreLog` exposes `error(message: string, error?: unknown): void`.

Optional composition hooks:

- `orchestratorPrompt({ project, session }): string` prepends planning instructions
  and a blank line to the first delivered message of an orchestrator session.
  `Session.prompt` remains exactly the user's text. Worker prompts and later
  messages are unchanged. Without the hook, delivery is unchanged.
- `harnessStartsWithPrompt(agent: AgentKind): boolean` is deprecated and ignored
  for compatibility with existing composition roots. All adapters establish a
  session without starting a turn. Core sends the initial prompt once, caused by
  `session.started`, and skips delivery when its persisted receipt exists.
- `terminalOptions(session: Session): TerminalSpawnOptions` supplies resolved
  executables, arguments and environment. The default resolves `claude` or
  `codex` through the harness PATH/PATHEXT resolver and passes the absolute command,
  model arguments, original prompt and worktree cwd to the terminal host. The
  terminal host owns safe shim launching and process-tree termination.
- `canReattach(agent: AgentKind): boolean` explicitly allows leaving a chat agent
  running on shutdown, provided a resume token has been captured. Defaults to
  false. A conversation resume token alone does not prove process reattachment.
- `limits?: { maxTurnsPerTask?: number; maxParallelWorkers?: number }` defaults to
  20 turns per worker and 3 worker slots per project. Supplied limits must be
  positive safe integers; invalid values throw during construction.

The returned object's API is exactly `HelixCore`, including `events` and
`terminals`. `PACKAGE_NAME` remains exported for scaffold compatibility.

## Behavior and lifecycle

Commands and callbacks share one ordered queue. Pending turns belong to core.
An interrupt is placed ahead of queued messages and cancels the current turn
without changing its cause. Core dispatches the next send only after the previous
turn has completed markTurn, diff, push and PR handling; only dispatch activates
the new cause. State is an in-memory projection
of the append-only log, rebuilt with the contracts projector. Call `start()` once
after construction to reconcile existing sessions and restore PR observation;
repeated calls are harmless. New commands also initialize the event cache lazily.
The composition root owns `store.close()` after shutting down consumers.

Startup replay is lenient. Normal histories use one efficient `projectUpTo` fold;
damaged histories fall back to per-event validation to count all anomalies and
isolate valid events before rebuilding delivery state. One log line per affected
project reports the count and first five reasons. Invalid events remain in the
append-only store but never become recovered deliveries. Missing/corrupt genesis
leaves that project unavailable until repaired, without preventing other projects
or health from loading. The frozen health schema permits only `{status, version}`;
an optional anomalies count is a contract request.

Session identities are reserved in the idempotency store before external effects.
Completed responses are stored separately, so concurrent/retried identical
requests return the original result and changed bodies conflict. Project paths
are resolved and normalized (case folded on Windows). Default project agent is
the first configured harness, or `claude-code` when the registry is empty.

Only worker sessions with GitHub configuration and commits ahead of base ship.
Every completed repair turn pushes again so the open PR sees the fix. PR merges
require derived `ready_to_merge` facts and pass the latest observed head SHA to
SCM using squash merge. Plan node IDs must be unique across the project because
v1 node events carry a node ID without a plan ID. Dependents require recorded
`pr.merged` events for all prerequisites. Core fetches the remote default branch
and creates their worktree from the returned SHA, explaining the base and merged
prerequisites with the unblocking merge as cause. Fetch failure leaves the worker
without a worktree in `waiting_input`; a later scheduling pass can retry it.
Merged-state PR snapshots do not unblock workers: core accepts and deduplicates
the subsequent `pr.merged` with its merge SHA, including after restart.

`submitPlan` records `plan.submitted` without starting any workers. Human approval
records `plan.approved` and schedules roots with that approval as their cause;
rejection records `plan.rejected` and permanently excludes the plan from scheduling.
Startup also honors this gate. For legacy histories only, an awaiting plan with
an existing node `sessionId` may continue scheduling its remaining dependents;
its projected status stays `awaiting_approval`, with no synthetic decision event.

Scheduling admits ready nodes in node order, oldest plan first, while project
worker slots are available. A worker holds a slot from `session.started` until
`pr.merged`, exit or archival, including time idle, in review, waiting on CI or
waiting for human input. Manually created workers also occupy slots. Each ready
node waiting for capacity gets one visible `plan.node_updated` note per blocking
period, recovered on restart. Merge, exit and archival schedule another pass;
workers admitted from the queue carry the freeing event as their cause.

Chat worker turns, including automatic CI/review/conflict repairs, consume the
turn allowance. Orchestrators are exempt. Core holds an over-limit delivery,
explains the limit with that delivery as cause, and emits `waiting_input` so the
derived status is Needs you. A user message at the limit adds another tranche of
`maxTurnsPerTask` and delivers; automatic feedback cannot grant more turns.
Answers to a question inside an existing turn do not consume another turn.
Held repairs remain queued after continuation. Recovery counts distinct delivery
causes at active/idle turn boundaries in the event log, supplemented by accepted
turn receipts for a crash before adapter activity. User extension receipts persist
the allowance; explanatory text alone cannot grant turns.

`stopAll(projectId): Promise<{ stopped: SessionId[] }>` stops all live runtimes
in that project, including orchestrators and terminal workers, through the same
stop path as `stopSession`. Already exited sessions are skipped. It persists a
project scheduling pause **before** stopping anything, so exits, later merges and
daemon restart cannot start queued workers. A newly approved plan or a newly
created session resumes scheduling; rejection, repeated approval of an old plan
and an idempotent retry of an existing session do not. The daemon exposes this as
`POST /api/projects/:id/stop-all`, with an empty request and HTTP 200 response
`{ stopped: SessionId[] }`, under its global Host/Origin protection. A stop failure
does not prevent attempts to stop the remaining runtimes; it fails the command
after those attempts and leaves scheduling paused.

Every newly submitted task must declare a non-empty `files` array of repository-relative
globs. Legacy replay may still contain `files: []`. Tasks ordered by dependencies,
including transitive dependencies, may share files. Parallel tasks cannot have
potentially overlapping claims. The exported pure `globsMayOverlap(a, b)` helper
compares slash-separated segments case-insensitively: `**` consumes zero or more
segments, and any segment containing `*`, `?`, `[` or `{` conservatively matches
any single segment. Different lengths overlap only through `**`. This deliberately
permits false positives; use dependencies or narrower ownership to resolve them.

When parallel tasks share a new interface, include a contract task that both
depend on, so the interface merges first. Core warns after submission when both
descriptions contain any of `interface`, `contract`, `shared type`, `schema`, or
`API shape` (case-insensitive whole phrases, optional plural `s`) and their
transitive dependency sets have no common node. One `explain.note` per pair is
attached to the orchestrator and caused by `plan.submitted`. This heuristic is
advisory; it cannot establish whether two descriptions refer to the same interface.

Open PRs remain watched after another PR merges. A subsequent SCM `pr.updated`
reporting `mergeable: 'conflicting'` routes a repair to that PR's worker, caused by
the update and deduplicated by PR/reason/head. `ScmObserver` exposes a watch stream;
core relies on its updates rather than an explicit refresh operation.

Automatic feedback is deduped by project, PR, reason and head SHA. Counts rebuild
from `feedback.routed` events and cap at three per PR/reason. An exhausted reason
produces an explanation and `waiting_input`. Delivery waits while any approval
is pending or activity is blocked, and stale automatic feedback is not delivered
after its PR closes or merges. Terminal output never implies chat activity.

## Frozen-v1 workarounds

Mutable `getMeta`/`setMeta` records hold one latest resume token per session,
message modes and delivery receipts. If metadata is absent, core reads the old
immutable `recall` records and copies recovered values into metadata. Legacy
resume tokens are scanned newest event first. Command idempotency remains on
`remember`/`recall`. Undelivered user messages
and feedback are reconstructed from the event log after restart. A crash between
`send()` acceptance and its receipt can redeliver a message: exactly-once delivery
requires a delivery ID/acknowledgment seam in the harness. A crash between the
user event append and mode persistence falls back to queue mode on recovery.

`CONTRACT-REQUEST`: add `env?: Record<string, string>` to `HarnessStartOptions`
so the composition root and harness can put the `helix` CLI on the agent's PATH.
Core does not modify process-wide environment variables as a workaround.
Explicit harness reattachment capability is also still absent.

Adapters must emit activity transitions at turn boundaries. V1 has no turn ID to
disambiguate overlapping turns. External worktree/PR creation and event append
also cannot be one atomic transaction; adapters should reconcile their existing
artifacts after a crash. Terminal processes absent from `TerminalHost.list()` are
marked unknown on restart instead of being respawned or declared dead.

## Verification

```sh
pnpm --filter @helix/core format
pnpm --filter @helix/core typecheck
pnpm --filter @helix/core lint
pnpm --filter @helix/core test
pnpm check
```

Use `pnpm.cmd` in Windows PowerShell. Tests include real adapters over an in-memory
byte transport, in-memory SQLite, real SCM over fake GitHub, and contract-typed fakes:
the golden three-node plan, full event sequence, four board checkpoints, causal
links, replay determinism, idempotency, feedback limits, approvals, safe archival,
plan validation, recovery and shutdown. No real agents, Git, GitHub or network are
invoked by tests. No npm dependencies were added.
