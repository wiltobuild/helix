# W3 reviewer backend result

## Summary

Implementation stopped at the frozen-contract blocker below, as instructed. This
branch is not ready for integration until the fallback contract is resolved.
Contracts, web/UI paths, dependencies, root configuration and the lockfile are
unchanged. Nothing was committed or pushed.

Implemented before discovering the blocker:

- Green-CI cross-agent reviewer creation, scratch directories, same-session
  re-review, current-head verdict validation and causal review events.
- Core-formatted review findings through the existing feedback deduplication and
  three-attempt escalation path; approvals route no feedback.
- One missing-verdict reminder, abandonment, worker notes, reviewer termination
  on Stop all/archive/PR close, and pending-review recovery without duplicate
  request events.
- Reviewer read roots, file-write denial, Codex scratch sandbox and local-daemon
  network access, a reviewer prompt, CLI file/stdin submissions, daemon environment
  wiring and the on/off reviewer setting.

## CONTRACT-REQUEST

CONTRACT-REQUEST: permit a causal fallback event to clear a stale completed review
when the current head cannot obtain a cross-agent reviewer. The current frozen
contracts cannot represent the required CI/human fallback in this case.

Reproduction using the frozen `crossReviewRun` fixture and strict projection:

1. Replay the fixture through the final approval of the worker's current head.
2. Apply `pr.updated` with a different head and passing checks. Suppose the other
   harness is now unavailable, or cross review has been switched off.
3. `deriveStatus` returns `in_review`: the old `agentReview` remains, and only a
   current-head approval clears the gate.
4. Attempt `agent_review.abandoned` naming the existing reviewer and previously
   reviewed head. Strict projection rejects it with
   `Review verdict requires a matching review in progress` because the prior
   review is already approved (the same problem applies to a prior change request).

This was reproduced against the unchanged contracts with a read-only Node/tsx
script. Emitting a fabricated `agent_review.requested` followed by abandonment
would clear the state, but violates the explicit instruction not to request a
review when no cross reviewer is available. Self-review is not an option.

Suggested minimal contract change: allow `agent_review.abandoned` to clear a
matching stale completed review when its head differs from the worker's current
head, with a reason and causal event. Alternatively define an explicit waiver or
fallback event. Update event semantics and strict-projection tests accordingly.
Then core can record the unavailable-reviewer fallback without inventing a review
request. No contract files were edited.

## Public API

- `CoreDeps.crossReview?: boolean`, default false.
- `CoreDeps.dataDir?: string`: scratch base, default `tmpdir()`.
- `CoreDeps.reviewerPrompt?: ({ project, worker, reviewer, pr, node? }) => string`;
  defaults to the harness reviewer prompt.
- Existing frozen `HelixCore.submitReview` now validates and submits verdicts.
- Harness exports `REVIEWER_PROMPT` and `reviewerPrompt()`.
- `isSafeCommand(command, cwd, readRoots?, executionCwd?)` supports reviewer reads.
- `helix review submit <file|-> --head <sha>`; `--json` prints the submitted event.
  Reviewer identity comes from `HELIX_SESSION_ID` on every invocation; the head
  comes only from the command argument. `CliOptions.stdin` supports test injection.
- Daemon `crossReviewFromEnv()` defaults on and validates `HELIX_REVIEWER=on|off`.
  Reviewers receive the same Helix launcher/discovery/identity variables as
  orchestrators. The existing `/api/reviews` dispatch already calls the real core.

## Files

- `packages/core/src/core.ts`, `review.test.ts`.
- `packages/harness/src/claude.ts`, `codex.ts`, `harness.ts`, `session.ts`,
  `safe-commands.ts`, `index.ts`, `review-mode.test.ts`, `reviewer/index.ts`,
  `reviewer/prompt.md`.
- `apps/cli/src/cli.ts`, `review-input.ts`, `review.test.ts`.
- `apps/daemon/src/real-core.ts`, `real-core.test.ts`, `helix-launcher.ts`,
  `helix-launcher.test.ts`.
- This handoff.

## Decisions

- Scratch is `<dataDir-or-tmp>/reviews/<reviewerSessionId>`, persisted as the
  reviewer's session cwd via `worktreePath`; no `worktree.created` event or git
  worktree is created, and no plan node is claimed.
- Requests and reminders are reconstructed from the existing projection/history.
  The existing generic `reload.ts` already projects the frozen review events;
  recovery changes belong in core's launch/delivery path. A pending request is
  resumed without another `agent_review.requested`. Abandoned heads are not
  automatically requested again, avoiding an endless failure loop.
- Ordinary reviewer shutdown preserves pending review facts for restart. Explicit
  stop, archive and PR closure abandon pending reviews.
- Review mode declines unknown/write-capable shell approval requests as well as
  out-of-scratch file edits and Codex permission expansion. Scripts and installs
  are never automatically approved. Reviewer temporary directories also point at
  scratch so launcher/tsx helpers can operate inside the write boundary.
- Codex uses `workspace-write` and an explicit per-turn scratch writable root;
  network access enables the launcher to post to the local daemon. Fields checked
  against the [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
  and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Verification

`pnpm.cmd check` **exited 1** on the final run. Formatting, type checking and lint
passed. Workspace tests: **778 passed, 1 failed, 22 skipped** (801 total). Tooling
tests: **20 passed, 0 failed, 0 skipped**. Combined: **798 passed, 1 failed,
22 skipped** (821 total).

| Owned package | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Core | 156 | 0 | 0 |
| Harness | 135 | 1 | 2 |
| CLI | 40 | 0 | 0 |
| Daemon | 67 | 0 | 4 |

All **38 newly added tests passed**: 19 core lifecycle, 10 harness, 8 CLI and
1 daemon setting test. Core lifecycle tests use strict projection and check zero
anomalies.

The full check failed in the unchanged
`packages/harness/src/process.test.ts:164`, test
`kills every live agent tree when the host process exits abruptly`: its initial
`expect(alive(grandchild)).toBe(true)` received false. It failed in two full runs
but passed when rerun alone (**1 passed, 6 filtered/skipped**). Process code and
that test were not changed; the full-check exit-zero requirement remains unmet.

`pnpm.cmd boundaries` passed separately: **219 modules**. No real-agent or
real-GitHub E2E was run. `git diff --check` passed; the branch is
`agent/reviewer-backend`.

## Known gaps

- The CONTRACT-REQUEST above blocks complete fallback behavior and completion of
  the requested feature. The current unavailable-reviewer branch records the
  note but cannot remove a stale completed review gate.
- The full repository check is not green because of the Windows process test
  described above, despite its isolated rerun passing.
- No real-agent smoke test was run, and no optional real cross-review E2E test
  was added. Sandbox behavior is covered by adapter protocol/permission tests;
  real Codex/Claude execution remains for the explicitly gated human-run check.
- Review scratch artifacts are retained for inspection; no retention policy was
  requested.
