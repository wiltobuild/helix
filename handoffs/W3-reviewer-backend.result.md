# W3 reviewer backend result

## Summary

The cross-agent review backend now includes the stale-verdict fallback. The
round-1 contract blocker is resolved by the accepted contract update in 45643df
(merged as 51b0752). No further contract change is requested. Contracts, web/UI
paths, dependencies, root configuration and the lockfile were not edited in this
round. Nothing was committed or pushed by this agent.

Implemented:

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
- When a new head goes green but cross review is off or the cross reviewer cannot
  be detected or started, abandon the previous head's review on its original
  reviewer session, caused by that green CI event. A worker note explains the
  fallback to CI and human review. Same-head verdicts remain intact; no fabricated
  review request or self-review is used.

## Round 2

Core uses the accepted `agent_review.abandoned` semantics to clear stale approvals
and stale change requests when no new review can start. Abandonment names the old
head and previous reviewer; `causedBy` names the green `ci.updated` for the new
head. The worker explanation is linked to that abandonment. Duplicate CI updates
do not emit duplicate abandonment events.

Harness initialization now precedes `agent_review.requested`. If initialization
fails, core records the stale-review fallback without pretending that a new
review started. Failures after a real request retain the existing in-progress
abandonment path.

Added 24 regression cases: both worker agents, both verdicts, and review disabled,
missing harness, uninstalled harness, signed-out harness, detection failure and
startup failure. Each verifies same-head preservation, pending-CI preservation,
old-reviewer/old-head event identity, green-CI causality, worker explanation,
`ready_to_merge`, zero strict-projection anomalies and no new review request.

Round-2 edits are limited to `packages/core/src/core.ts`,
`packages/core/src/review.test.ts` and this handoff. The stray
`packages/core/reviewer-check.log` and earlier handoff check log are absent; no
verification log files are retained.

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

Final `pnpm.cmd check`: **exit 0**. Formatting, type checking, lint, tests and
architecture boundaries all passed. Boundaries checked **219 modules**.

- Workspace tests: **804 passed, 0 failed, 22 skipped** (826 total).
- Tooling tests: **20 passed, 0 failed, 0 skipped**.
- Combined: **824 passed, 0 failed, 22 skipped** (846 total).
- Targeted core review suite: **43 passed, 0 failed, 0 skipped**, including all
  **24 new round-2 cases**.

| Owned package | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Core | 180 | 0 | 0 |
| Harness | 136 | 0 | 2 |
| CLI | 40 | 0 | 0 |
| Daemon | 67 | 0 | 4 |

The initial full check exited 1 with **803 workspace tests passed, 1 failed,
22 skipped**, plus 20 tooling tests passed. Its only failure was the unchanged
`packages/harness/src/lifecycle.test.ts` case
`debug mode captures both directions of a real JSONL transport with no unanswered requests`,
which hit a harness request timeout. The isolated case passed (**1 passed,
41 filtered/skipped**), then the complete check passed without code or test
changes. The known Windows process test passed in both full runs; it was not
changed and did not require an isolated rerun.

No real-agent or real-GitHub E2E was run. `git diff --check` passed. Only the three
round-2 files listed above are modified, and both old standalone check-log paths
are absent.

## Known gaps

- No real-agent smoke test was run, and no optional real cross-review E2E test
  was added. Sandbox behavior is covered by adapter protocol/permission tests;
  real Codex/Claude execution remains for the explicitly gated human-run check.
- Review scratch artifacts are retained for inspection; no retention policy was
  requested.
