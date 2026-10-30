# W4 CI hardening result

## Summary

Changes are limited to `.github/workflows/ci.yml`, `packages/harness/src/orchestrator/prompt.test.ts`, and this result file on `agent/ci-hardening`. No commits, pushes, dependency changes, or lockfile changes.

## Flaky test: cause and fix

The last test in `prompt.test.ts` launched a fresh Node/tsx CLI and imported the entire harness public entry point to check Markdown loading and header output. It already had a 20-second subprocess deadline and a 25-second test deadline. Cold subprocess/loader startup and module loading under contention were unnecessary sources of latency; this was not a missing global timeout. The precise runner-side startup stall was not reproduced locally.

The replacement resets Vitest's module cache, spies on `process.cwd()` to return the system temporary directory, and dynamically imports the public entry module again. It compares the actual Markdown and header with the existing expected exports. The spy and module cache are restored in `finally`. This exercises fresh module-relative file loading without a subprocess, a real process-wide directory change, or a raised timeout. The old test ran from the package's src directory and only set `INIT_CWD` to a temporary directory.

This intentionally removes coverage of the external tsx CLI/package-resolver integration. Prompt content, header output, and fresh loading independent of `process.cwd()` remain covered; production code is unchanged.

## Workflow changes and runtime trade-off

- Replace the single check step with the same ordered format, typecheck, lint, test, and boundaries scripts. Root TypeScript checks, root ESLint, and tooling tests still run through those scripts.
- Step deadlines are respectively 2, 5, 3, 5, and 2 minutes. The job remains capped at 20 minutes, and both existing failure/cancellation process dumps remain unchanged. A hung check normally fails its step well before the job deadline, leaving time for diagnostics.
- Each Turbo invocation receives CI-only `--log-order=stream --output-logs=full --log-prefix=task --verbosity=2`. Verified against installed Turbo 2.11.7 help and a local probe. Debug lifecycle messages carry timestamps; task output streams immediately with package/task prefixes. GitHub's raw logs also timestamp output lines.
- Windows typecheck additionally receives `--concurrency=2`. Ubuntu concurrency and local scripts/configuration are unchanged. Harness process diagnostics remain enabled in the Test step.
- Healthy runs execute the same work and retain cache behavior. Separate steps add only shell startup overhead; limiting Windows typecheck may add some seconds but reduces simultaneous child/process-output handling. More verbose logs add modest output overhead. CI runtime impact still needs measurement after Claude pushes.

## Reading the next hang

Open the failed named step first. Find the last timestamped Turbo task/process event and the matching `@helix/<package>:<task>` output; distinguish cache replay from a cache miss/executing task. Enable GitHub log timestamps or download raw logs to timestamp ordinary task lines. Debug output includes task hashes, process shutdown/waiting, visitor completion, and cleanup, helping distinguish an active child from Turbo stalled after child exit. Compare with the following platform process dump (Windows includes PID, parent PID, and command line). A final task output line alone is not proof that its child is still running.

## Verification

- Read CLAUDE.md, CONTRIBUTING.md, README.md, docs/PLAN.md, workflow, root scripts, and Turbo configuration.
- The requested gh issue command was blocked by sandbox network restrictions. Read issue #12 and all three comments through the connected GitHub API instead, including the latest Turbo-only process dump.
- Targeted prompt tests: 4 passed, 120 ms test execution (2.60 seconds total).
- Workflow parsed with the already installed js-yaml 4.3.2; verified all five check steps have timeouts and both process-dump steps remain.
- First `pnpm.cmd check` exited 1: formatting, typechecking, lint, and 20 tooling tests passed; unchanged daemon tests failed (e2e.integration.test.ts: 60-second timeout; helix-launcher.test.ts: EBUSY during temporary-directory cleanup). The prompt test passed in the full run, with its fresh import taking 485 ms. The unchanged-command retry also exited 1: both daemon tests passed, but unchanged harness lifecycle tests failed (debug-mode transport request timeout; Codex timeout diagnostic missing the expected child stderr tail). The prompt tests passed again. Thus the required all-green full gate was not achieved.
- Standalone `pnpm.cmd boundaries` passed (227 modules); `git diff --check` passed.
- CI typecheck flags and Windows concurrency passed a root-script dry run, confirming argument forwarding to Turbo.

## Known gaps

Unchanged daemon/harness subprocess flakes prevented a green full check across two attempts; their files remain untouched because they are outside the owned paths. Turbo also warned that its shared worktree cache outside this workspace was not writable. The intermittent Turbo hang was not reproduced or proven fixed; reduced concurrency is a mitigation and the logging supports diagnosis. GitHub timeout/dump behavior and hosted Windows/Ubuntu timing require CI observation. A job-level cancellation or unusually slow setup can still leave less time for diagnostics. Keep the workflow steps synchronized if the root check script changes.
