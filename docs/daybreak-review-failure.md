# Daybreak reviewer failure investigation

## Cause and evidence

Daybreak's homepage PR #3 (head `bcb355723d509cc916313fdd5a1f1e7afa1dfda7`)
and assembly PR #5 (head `a555d0d35ec0b6d62b6c3b9473e61b8bec50b1b7`)
received **no Codex review verdict**. Assembly did not retrospectively review the homepage.

- Homepage events 585, 609 and 613 recorded failed commands; 623 abandoned the
  review after two turns. Event 624 announced the existing CI/GitHub fallback.
- Assembly events 980 and 992 recorded the same failure; 999 abandoned the review.
- Raw Codex command records show exit -1 and exactly:
  `Failed to create unified exec process: helper_unknown_error: setup refresh had errors`.
- Windows sandbox diagnostics at 2026-10-29 23:35–23:36 UTC and
  2026-10-30 00:11 UTC identify runtime read/execute ACL validation of the
  app-managed `cua_node/.../bin/node_repl.exe` as failing with sharing violation
  `os error 32`. The executable was in use. No Git command ran.
- Claude's catalog and cart reviews submitted real approvals in events 631 and 688.

This is a sandbox bootstrap failure, not missing homepage files, a wrong HEAD,
verdict parsing failure, or an exhausted coding budget. Two turns were the
abandonment mechanism, not the initiating cause. Escalated read attempts were
declined by Helix's reviewer command policy; those declines did not cause the
original sandbox failure and are not a reason to disable the sandbox.

## Local correction

The Codex adapter recognizes the exact command-runner setup diagnostic with exit
-1 during a reviewer session, emits a fixed, actionable system message and marks
the harness unavailable. Core's existing `unknown` handling abandons the pending
review immediately, so its next idle notification cannot queue a verdict reminder.
Ordinary nonzero commands keep their existing behavior. Arbitrary stderr remains
redacted; this does not expose raw repository output or broaden permissions.

The existing contract deliberately removes an abandoned cross-agent review and
allows CI/GitHub review to determine readiness. Its tests assert that fallback.
This patch does not change that product policy, and explicitly says that CI is
not an AI approval. A mandatory successful AI-review gate would require a separate
contract/UI decision and a supported retry flow.

## Verified runtime repair

The normal standalone CLI was 0.161.0. Windows Restart Manager confirmed two
processes held the older app-managed executable. They were left running.
Disabling the optional browser MCP for a single diagnostic did not fix 0.161.0.
The already-installed 0.166.0 executable passed the identical workspace-write
sandbox Git probe; its setup log recorded `errors=[]`.

The supported `codex update` then upgraded the standalone CLI to 0.166.0.
A real native Codex review of correction commit `731b480` completed using
`gpt-6-astra`, medium effort, read-only sandbox and `approval_policy=never`.
It inspected the code and reported no actionable regressions; it did not run
tests. No process was killed, sandbox weakened, credential changed, or active
server restarted. The original Daybreak reviews remain failed historical records.

An elevated probe using the full Helix harness with automatic safe-command
approval was denied before execution. The approved, narrower native read-only
review verifies runtime recovery, not a new live Helix PR-review submission.

## Regression coverage

`packages/harness/src/review-mode.test.ts` covers the recorded diagnostic and
ordinary failures that must not trigger abandonment. Existing core reviewer tests
cover `unknown` abandonment. Reviewer sandbox settings, read/write denials and
permission-expansion rejection remain covered.

The 16 reviewer tests passed. Repository format, types and lint passed; its broad
test run had two pre-existing subprocess timeout failures. Both affected files
passed on a single-worker rerun (46 tests). Production build and architecture
checks passed. No test timeout or security rule was relaxed.
