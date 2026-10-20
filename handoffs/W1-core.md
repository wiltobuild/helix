# W1-core — HelixCore domain services

**Owned paths:** `packages/core/**`

## Goal
Implement `HelixCore` (interface in `@helix/contracts`) — the brain the daemon calls. It turns API commands into events, drives harnesses/worktrees/SCM through their **contract interfaces**, and closes the CI → fix loop. Neighbors (storage, harness, git, scm, pty-host) are being built in parallel: depend on `@helix/storage` etc. only through constructor injection typed by the contract interfaces, and test with fakes.

## API
`createHelixCore(deps: CoreDeps): HelixCore` where `CoreDeps = { store: EventStore & ProjectIndex & IdempotencyStore (define these minimal shapes locally, matching what W1-storage is told to export — see handoffs/W1-storage.md), harnesses: Record<AgentKind, AgentHarness>, worktrees: WorktreeManager & GitHelpers, scm?: ScmObserver, terminals: TerminalHost, clock: () => string /* ISO ts */, ids: (prefix) => string, log }`. Never call `Date.now()`/`Math.random()` directly — use `clock`/`ids` so tests are deterministic.

## Behavior
- **addProject** — validate the path is a git repo (via worktrees helper), detect default branch + GitHub remote (`owner/repo` from `origin` URL, https or ssh), save, emit `project.added`. Same `repoPath` twice → return the existing project.
- **createSession** — idempotent by key (same key + same body → same session; different body → `IDEMPOTENCY_CONFLICT`). Emit, in order and with correct `causedBy` chains: `session.created` → `worktree.created` (after `worktrees.create`) → `session.started`; then start the harness (`chat` interface) in the worktree with the prompt, piping every `HarnessEmission` to an event (`sessionId`, `planNodeId` from the session, `causedBy` = the event that triggered the turn). Terminal interface: spawn the agent CLI in `terminals` instead and emit `activity.changed` from process lifecycle only.
- **Turn bookkeeping:** after each turn ends (`activity → idle`), call `worktrees.markTurn`, compute diff stats → `worktree.diff_updated` (only if changed).
- **Shipping:** when a worker's turn ends with commits ahead of base and no PR yet, and the project has GitHub configured: `push` then `scm.openPr` (title = session title, body = prompt + plan node rationale + acceptance criteria) → `pr.opened`; then `scm.watch` → map emissions to `pr.updated`/`ci.updated`/`review.updated`/`pr.merged` events.
- **Feedback loop (the painkiller):** on `ci.updated` with new failures, or `review.updated` → `changes_requested`, or `pr.updated` → `mergeable: 'conflicting'`: build the message with `scm`'s `buildFeedbackMessage` (inject it as a function dep), emit `feedback.routed` (`causedBy` = the triggering event), then deliver it to the owning session with `send(text, 'queue')`. **Dedupe** per (prNumber, reason, headSha). Max 3 automatic fix attempts per PR per reason; after that emit an `explain.note` and leave it for the human (status goes to needs_you via an `activity.changed: waiting_input`).
- **Delivery policy:** never inject into a session with a pending approval or `blocked` activity — queue it and deliver after it unblocks.
- **sendMessage / stopSession / archiveSession / decideApproval** — emit the matching events; archive never removes a dirty worktree (call `remove` only when clean; otherwise keep it and say so in an `explain.note`).
- **diff / merge** — delegate; merge uses `expectedHeadSha` from the latest PR facts.
- **submitPlan / explain** — validate nodes (unique ids, deps exist, no cycles → `INVALID_REQUEST`), emit `plan.submitted`; for each node with no unmet deps, create a worker session (agent from the node) linked by `planNodeId`; when a node's PR merges, start dependents whose deps are all merged (emit `plan.node_updated` with a note). `explain` emits `explain.note`.
- **Recording** — `exportRecording` / `importRecording` delegate to the store.
- **start()** — reconciliation after restart: for sessions whose last activity isn't `exited`/archived, try `harness.start({ resumeToken })`; on failure emit `activity.changed: unknown` (never assume death). Re-attach `scm.watch` for open PRs.
- **shutdown()** — stop pollers, detach terminals, leave agent processes running only if the harness supports re-attach; otherwise stop them cleanly.

## Tests (all with fakes — write minimal in-package fakes for EventStore/WorktreeManager/ScmObserver/TerminalHost; use `@helix/testing`'s fake harness / fake GitHub if they exist by the time you finish, otherwise your own)
- Golden scenario: add project → submit plan with 3 nodes (2 independent, 1 dependent) → two workers start → API worker PR → CI fails → `feedback.routed` with correct `causedBy` → fix → passes → approved → merge → dependent node starts. Assert the full event type sequence and that `projectUpTo(...)` gives the expected board columns at 4 checkpoints.
- Idempotency, dedupe of repeated identical CI failures, 3-attempt cap, delivery held while approval pending, archive refuses dirty worktree, plan validation (cycle, missing dep), restart reconciliation emits `unknown` on resume failure.
- Determinism: same inputs → byte-identical event log.
