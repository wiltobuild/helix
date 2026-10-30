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

## Runtime repair boundary

The change above fixes Helix's handling; it cannot repair a locked executable in
the external Codex installation. Preserve the failed run as evidence. Before a
new real review, restore the affected Codex runtime through its normal maintenance
flow and verify sandboxed command execution. Do not kill unrelated processes,
change ACLs manually, share credentials, or switch to unrestricted execution.
Do not label a fresh review successful until it inspects the requested HEAD and
submits a real verdict. The original Daybreak run and both live servers were untouched.

## Regression coverage

`packages/harness/src/review-mode.test.ts` covers the recorded diagnostic and
ordinary failures that must not trigger abandonment. Existing core reviewer tests
cover `unknown` abandonment. Reviewer sandbox settings, read/write denials and
permission-expansion rejection remain covered.
