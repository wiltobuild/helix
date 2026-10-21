## Summary

Implemented findings **1, 2 (core), 3, 4, 5, 6, and 7 (core)**. **`pnpm check` exited 0.**

Updated `handoffs/W1-fix1-loop.result.md` with the complete report. Changes remain uncommitted. The only modified daemon file is the authorized integration test.

| Finding | Change | Regression coverage |
|---|---|---|
| **1 — Duplicate initial prompt** | Real adapters and fake initialize without starting a turn; core delivers the initial prompt. | Real core + both adapters + in-memory transport/SQLite assert exactly one delivery. Daemon flow asserts exactly `[prompt, repairSummary]`. |
| **2 — Stale dependent base** | Fetch the default branch before worktree creation and use the returned SHA. Explain SHA/prerequisites with the unblocking merge as cause. Fetch failure leaves the dependent `waiting_input`. | External-merge integration verifies fetched base, causal links, and no launch on fetch failure. |
| **3 — Interrupt causality** | Preserve the running turn’s cause through its terminal boundary; prioritize interrupts ahead of queued messages. | Both adapters verify A running, B queued, C interrupt → causes and execution order A, C, B. |
| **4 — Premature next turn** | Core owns pending turns; adapter auto-pumping removed. Dispatch waits for bookkeeping. | Deferred `markTurn`, diff, push, and PR creation each block the next turn. |
| **5 — Missing merge event** | Accept and deduplicate authoritative `pr.merged` after merged snapshots, including recovery. | Exactly one merge event with SHA; dependent points to it. Restart and duplicate notifications covered. |
| **6 — Review repairs stop** | SCM re-emits outstanding review state when the head changes. | Repairs route for H1/H2/H3; same-head polling deduplicates; H4 reaches the three-attempt cap. |
| **7 — Terminal executables** | Export harness resolver; core passes resolved executable and argument array. | Claude/Codex `.cmd` paths, metacharacter arguments, and missing executables covered. |

The daemon test retains the full **HTTP → SQLite → local Git → task → SSE → diff → failed CI → repair → green CI → merge** flow.

## Public API

- New export: `resolveExecutable(name: string, env?: NodeJS.ProcessEnv, cwd?: string): Promise<string | undefined>`.
- `AgentHarness.start(options: HarnessStartOptions): Promise<HarnessSession>` now initializes only.
- `HarnessSession.send(text: string, mode: MessageMode): Promise<void>` starts one explicit turn.
- `createHelixCore(deps: CoreDeps): HelixCore` remains unchanged.
- `harnessStartsWithPrompt` remains accepted for compatibility, deprecated and ignored.

## Files

- Core: implementation, README, existing tests, new `agent-loop.test.ts`.
- Harness: adapters, session lifecycle, resolver export, documentation, tests, scoped formatting script.
- Testing: shared fake harness and tests.
- SCM: review emission, documentation, tests.
- Authorized daemon exception: `apps/daemon/src/e2e.integration.test.ts`.
- Report: `handoffs/W1-fix1-loop.result.md`.

## New dependencies

None. No lockfile changes.

## Decisions

- Core exclusively queues pending turns and dispatches interrupts after current bookkeeping.
- Preserve SCM snapshot-before-merge ordering; core handles it correctly.
- Use the latest prerequisite merge event as the dependent’s unblocking cause.
- Failed fetches retain worker identity for retry on a later scheduling pass.
- Preserve existing shipping policy: agents commit; core snapshots, pushes, and handles PRs.

## CONTRACT-REQUESTs

Document shared `start()` as initialization-only and `send()` as one explicit turn with caller-owned pending messages. This request is marked locally; contracts remain unchanged.

Existing durable delivery acknowledgment, resume, reattach, approval cancellation, and process-exit requests remain follow-ups. The provided `fetchBase` contract is consumed unchanged.

## Verification

- **Root `pnpm.cmd check`: exit 0** — formatting, type checking, linting, tooling tests, workspace tests, and boundaries passed.
- Owned package tests: **153 passed, 3 gated skips**.
- Daemon integration target: **1 passed, 1 gated skip**.
- Full daemon suite: **51 passed, 1 gated skip**.
- Architecture boundaries: **160 modules passed**.
- Scoped formatting and final `git diff --check`: passed.

The root check used a writable worktree-local Turbo cache; no root configuration changed.

## Known gaps / follow-ups

- Git and PTY implementation fixes remain the parallel agent’s responsibility.
- Live Claude/Codex and GitHub smoke tests remain gated by `HELIX_E2E=1`.
- Exactly-once delivery across crashes still requires durable harness acknowledgments.
- Failed dependent fetches retry on a later scheduling pass; no new retry endpoint was added.