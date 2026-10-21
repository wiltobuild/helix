# W1 fix round 1A — the agent loop (core + harness + scm)

An independent reviewer audited Wave 1: `handoffs/W1.review.md`. Read it fully — every finding below was reproduced with real components. You own findings **1, 2 (core side), 3, 4, 5, 6, 7 (core side)**.

**Owned paths:** `packages/core/**`, `packages/harness/**`, `packages/scm/**`, `packages/testing/src/harness/**`, `packages/testing/src/github/**`, result file. Another agent is fixing `packages/git` and `packages/pty-host` in parallel (findings 2-git, 7-pty, 8). Contracts: Claude added `GitHelpers.fetchBase(repoPath, branch): Promise<string>` (fetches `origin/<branch>` and returns its SHA without touching the user's local branch) — use it; the git agent implements it. You cannot commit. Rules in `handoffs/W1-common.md` still apply.

## Required fixes
1. **Initial prompt sent twice (Blocker).** Core owns initial delivery. Adapter `start()` establishes the session and returns without starting a turn; core delivers the prompt as the first turn with `causedBy` = `session.started`. Update both real adapters and the fake harness so they share this contract; document it on `start()`.
2. **Dependents on stale base (Blocker, core side).** Before creating a dependent worker's worktree, call `fetchBase(project.repoPath, project.defaultBranch)` and create the worktree from the returned SHA. Emit an `explain.note` naming the base SHA and the merged prerequisites (`causedBy` = the `pr.merged` that unblocked it). If fetch fails, do not start the dependent: emit `explain.note` with the reason and set it `waiting_input`.
3. **Interrupt corrupts causality.** Keep the running turn's cause until its terminal boundary; an interrupting message is inserted *ahead* of already-queued ones; a turn's cause becomes active only when that turn actually starts.
4. **Next turn starts before end-of-turn bookkeeping.** Pending turns live in core, not in the harness. The harness runs one turn per `send`; core dispatches the next queued turn only after `markTurn`, diff, commit/push and PR handling for the previous turn complete. Remove auto-pumping from the harness session queue (keep the queue only for messages core explicitly sends while a turn is active, if the CLI requires it — document).
5. **External merges lose `pr.merged`.** Either SCM emits `pr.merged` before (or instead of) `pr.updated{state:'merged'}`, or core accepts and dedupes `pr.merged` after a merged-state update. Persisted log must contain exactly one `pr.merged` with `mergeSha` per merged PR, and dependents' `causedBy` must point to it.
6. **Review repairs stop after head change.** On a head change, re-evaluate outstanding review state (SCM re-emits `review.updated` for the new head when unresolved, or core re-checks). Keep per-head dedupe and the 3-attempt cap.
7. **Terminal mode executables (core side).** Core must not pass bare `claude`/`codex` to the terminal host: resolve the executable via the harness package's resolver (export it) and pass the resolved command + args. The pty-host agent is adding safe `.cmd` shim launching.

## Tests that would have caught these (add them)
- Compose **real core + real adapters with an in-memory transport** (not the fake harness) + in-memory SQLite: assert the prompt is delivered exactly once.
- Queue/interrupt causality: A running, B queued, C interrupts → A's terminal emissions cause = A; C runs next with cause C; then B with cause B.
- Turn boundary: the second turn does not start until the first turn's `markTurn` and diff calls resolve (use deferred promises).
- External merge via fake GitHub → exactly one `pr.merged` with `mergeSha`; dependent starts with `causedBy` = that event and from the fetched SHA (fake git records the base argument).
- Review: changes_requested on H1, push H2 still changes_requested → second routed repair for H2.

`pnpm check` must exit 0. Result file per W1-common format, mapping each finding → change → test.
