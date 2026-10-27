# W2: per-session agent env so the orchestrator can run `helix` (issue #19)

Branch `agent/19-per-session-agent-env-so-the-orchestrato`, based on `main` at `6d1e4d9`. That includes:
- #4: core approval gate, `CoreDeps.orchestratorPrompt`
- #5: `@helix/harness` exports `orchestratorPrompt()`; the CLI's `plan submit` / `plan show` / `explain` read `HELIX_SESSION_ID` / `HELIX_PROJECT_ID`
- #9: limits
- #22: daemon env config (`HELIX_CODEX_MODEL`, `HELIX_CODEX_EFFORT`, `HELIX_MAX_TURNS`, `HELIX_MAX_WORKERS`, `HELIX_GITHUB`)

Read `CLAUDE.md`, `CONTRIBUTING.md`, `packages/harness/src/orchestrator/prompt.md`, `apps/cli/README.md`, `apps/daemon/src/real-core.ts` and `apps/daemon/src/codex-real.e2e.test.ts` first.

**Owned paths:**
- `packages/contracts/src/interfaces.ts`: only `HarnessStartOptions.env`
- `packages/harness/src/**` except `src/orchestrator/`
- `packages/core/**`
- `apps/daemon/src/**`
- `apps/cli/src/orchestrator.e2e.test.ts`: delete it, replaced below
- `apps/cli/README.md`: smoke-test note only
- `handoffs/W2-orchestrator-env.result.md`

No root config or lockfile changes, no new dependencies. You cannot commit or push.

## Required

### 1. Contract
`HarnessStartOptions = { session; cwd; resumeToken?; env?: Record<string, string> }`. Document it: per-session additions merged over the adapter's base environment.

### 2. Harness adapters
Codex and Claude Code apply `start.env` over their base environment (`HarnessOptions.env` / `process.env`) for that session's process only. On Windows, keys are case-insensitive: a supplied `Path`/`PATH` must replace the existing one, never leave two. Test both adapters with the fake CLI: the child sees the variables, and a second session started without env does not.

### 3. Core
Add `CoreDeps.sessionEnv?: (ctx: { project: Project; session: Session }) => Record<string, string> | undefined`. Core passes the result:
- as `env` to `harness.start` on every launch and resume
- merged into `TerminalSpawnOptions.env` for terminal sessions

Test that orchestrator sessions receive the env and workers receive whatever `sessionEnv` returns for them.

### 4. Daemon wiring (`real-core.ts`)
- **Pass `orchestratorPrompt` from `@helix/harness`** into `createHelixCore`.
- **Write a `helix` launcher** into `<dataDir>/bin/` at start-up:
  - `helix.cmd` on Windows; an executable `helix` shell script on POSIX
  - it runs the repo's `tsx` (resolve it from the workspace's `node_modules/.bin`) on `apps/cli/src/main.ts`, with all arguments forwarded
  - quote paths safely, because the repo path may contain spaces
- **Supply `sessionEnv`.** For **orchestrator** sessions only:
  - `HELIX_DATA_DIR` = the daemon's data dir (the CLI finds the daemon through `run.json` there)
  - `HELIX_SESSION_ID`, `HELIX_PROJECT_ID`
  - `PATH` = `<dataDir>/bin` first, then the base PATH

  Return `undefined` for workers.
- **Tests:** the launcher files exist and are well-formed; `sessionEnv` gives orchestrators the variables and workers nothing; and the launcher actually runs `helix --json status` against a test daemon started with `startDaemon` in a temp data dir.

### 5. Real orchestrator smoke: replace `apps/cli/src/orchestrator.e2e.test.ts`
Write `apps/daemon/src/orchestrator-real.e2e.test.ts`, gated only on `HELIX_E2E=1` and **self-contained** like `codex-real.e2e.test.ts`:
1. Make a temp git repo with a small app: a couple of source files and a test.
2. `createRealCore` with env `HELIX_GITHUB=off`, `HELIX_CODEX_MODEL=gpt-6.1-sol`, `HELIX_CODEX_EFFORT=medium`, `HELIX_DEBUG_PROTOCOL=1`, then `startDaemon` on port 0.
3. Add the project and create an orchestrator session (`planWithOrchestrator: true`) for a small two-part goal.
4. Wait, with a generous timeout of about 6 minutes, for a `plan.submitted` event from that orchestrator.

Assert:
- every node has non-empty `files` and a rationale
- the plan's status is `awaiting_approval`
- **no worker `session.created`** before approval
- the orchestrator made **no changes** in its worktree
- no unanswered protocol requests

Then stop the orchestrator. Keep the artifacts folder on failure and print its path.

Delete the old CLI smoke file and update the smoke-test note in `apps/cli/README.md`.

## Verification
- `pnpm check` exits 0 (`pnpm.cmd` on Windows PowerShell).
- Report exact test counts.
- **Don't run** the `HELIX_E2E` smoke; Claude will run it.

## Result file (`handoffs/W2-orchestrator-env.result.md`)
Summary · public API · files · decisions · verification · known gaps.
