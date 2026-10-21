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

Automatic feedback is deduped by project, PR, reason and head SHA. Counts rebuild
from `feedback.routed` events and cap at three per PR/reason. An exhausted reason
produces an explanation and `waiting_input`. Delivery waits while any approval
is pending or activity is blocked, and stale automatic feedback is not delivered
after its PR closes or merges. Terminal output never implies chat activity.

## Frozen-v1 workarounds

`CONTRACT-REQUEST` comments mark the absent durable resume-token/outbox seams and
reattach capability. Immutable idempotency records currently hold tokens keyed
by session/event, message modes and delivery receipts. Undelivered user messages
and feedback are reconstructed from the event log after restart. A crash between
`send()` acceptance and its receipt can redeliver a message: exactly-once delivery
requires a delivery ID/acknowledgment seam in the harness. A crash between the
user event append and mode persistence falls back to queue mode on recovery.

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
