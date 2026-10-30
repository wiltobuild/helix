# W4: CI reliability (issue #12 Windows hang, flaky orchestrator-prompt test)

Branch `agent/ci-hardening` from `main`. Two other Codex agents work in parallel on other branches; stay inside your owned paths.

Read first: `CLAUDE.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `turbo.json`, root `package.json` scripts, and GitHub issue #12 including its comments (`gh issue view 12 --repo wiltobuild/helix --comments`). The latest comment has a process dump showing **Turbo itself** stuck during `typecheck` on windows-latest: no `tsc`, vitest or agent child processes alive, 14 minutes of silence after `@helix/daemon:typecheck` started. Hangs are intermittent; the same commit usually passes.

## 1. Make the next Windows hang diagnosable, and less likely
- In CI only (not for local runs), make Turbo's output stream per task with timestamps, so a hang shows exactly which task was last running and when it started. Prefer Turbo's own flags (`--log-order=stream`, `--output-logs`, and a verbosity flag if available in the pinned Turbo version; check `node_modules/turbo` for the version and its `--help`).
- Add a cheap mitigation that doesn't slow Ubuntu: for example, run `typecheck` with lower concurrency on Windows, or split `pnpm check` into separate CI steps (format, typecheck, lint, test, boundaries) so a hang is attributed to one step, each with its own `timeout-minutes`. Keep the existing process-dump steps working on failure or timeout.
- Keep the job's total runtime about the same on a healthy run, and explain the trade-off in the PR result.

## 2. The flaky orchestrator-prompt test
One test that loads the orchestrator prompt by spawning `tsx` (or otherwise depends on a subprocess) has intermittently timed out under load, then passed on rerun. Find it (search `apps/cli/src`, `apps/daemon/src` and `packages/harness/src` tests touching `orchestratorPrompt`, `prompt.md` or a `tsx` subprocess), find why it's slow (cold `tsx` startup? a missing timeout?), and fix the root cause. Prefer testing without a subprocess where the behavior allows; otherwise give it an explicit timeout that fits a loaded Windows runner and a clear failure message. Don't just raise a global timeout.

## Owned paths
`.github/workflows/**`, `turbo.json`, root `package.json` (scripts only, no dependency changes), the flaky test file and any helper it needs, `handoffs/W4-ci-hardening.result.md`. No lockfile or dependency changes. You cannot commit or push; Claude will push and watch CI.

## Verification
`pnpm.cmd check` exits 0 locally. Validate the workflow YAML (for example `node -e` with a YAML parse if a parser is already installed, or careful review). State exactly what CI will do differently, and how to read a future hang from the new logs.

## Result file
`handoffs/W4-ci-hardening.result.md`: summary, the flaky test's root cause and fix, workflow changes, verification, known gaps.
