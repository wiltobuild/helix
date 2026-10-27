# W2 orchestrator: planner prompt and `helix` CLI plan flow (issue #5)

Branch `agent/5-planner-prompt-and-helix-cli-plan-flow`, based on `main` at `b437a54`. That includes:
- #3: `PlanNode.files` (required, non-empty for new plans), `plan.approved` / `plan.rejected`, `POST /api/plans/:id/decision`
- #4: the core approval gate, file-overlap rejection, the shared-interface warning, `CoreDeps.orchestratorPrompt`
- #9: limits and stop-all

Read `CLAUDE.md`, `CONTRIBUTING.md`, `apps/cli/README.md`, `apps/cli/src/cli.ts`, `packages/core/README.md` and `packages/contracts/src/entities.ts` (plan schema) first.

**Owned paths:**
- `packages/harness/src/orchestrator/**` (new)
- `packages/harness/src/index.ts`: export only
- `packages/harness/package.json`: only if needed to ship the `.md` file
- `apps/cli/**`
- `handoffs/W2-orchestrator.result.md`

Don't edit contracts, core, the daemon or root config. You cannot commit or push.

## Required

### 1. Orchestrator prompt: `packages/harness/src/orchestrator/prompt.md`
A clear, concise system prompt for the orchestrator agent. It must tell the agent to:
- **Inspect the repository read-only**, never editing, creating or deleting files, and never running git write commands. The orchestrator plans; workers build.
- **Split the user's goal into tasks that can run independently** where possible, with `dependsOn` for real ordering.
- **Give every task:**
  - `id` (short kebab-case)
  - `title`
  - `description` (the full instruction a worker will receive)
  - `acceptance` (checkable criteria)
  - `files` (repo-relative globs it expects to touch, never empty)
  - `dependsOn`
  - `agent` (`codex` unless told otherwise)
  - a one-line `rationale`
- **Never let two parallel tasks claim overlapping files.** If they would, either order them with `dependsOn` or give the file to one task.
- **When parallel tasks share a new interface,** add a contract task that defines it and that both depend on.
- **Write `plan.json`** in the documented `SubmitPlanRequest` shape (`projectId`, `orchestratorSessionId`, `goal`, `nodes`), using `HELIX_PROJECT_ID` and `HELIX_SESSION_ID` from the environment, then run `helix plan submit plan.json`.
- **If submit prints validation errors,** fix the plan and resubmit.
- **After a successful submit,** tell the user the plan is waiting for their approval in Helix, then stop. Never try to approve it.
- **Use `helix explain "<why>" --node <id>`** to record reasoning worth keeping.

Include one short, generic example plan (two tasks plus a contract task) in the prompt.

### 2. Export the prompt from `@helix/harness`
- `export const ORCHESTRATOR_PROMPT: string`, loaded from the `.md`
- `export function orchestratorPrompt(ctx: { project: Project; session: Session }): string`, matching `CoreDeps.orchestratorPrompt`. It prepends a short header with the project name, default branch, project id and session id to `ORCHESTRATOR_PROMPT`.

Make sure the `.md` is loadable both from source (tsx / Vitest) and however the package is consumed today. Test that.

### 3. CLI
- **`helix plan submit <file.json>`:**
  - Validate locally with `submitPlanRequestSchema` before calling the daemon.
  - Print each problem on its own line with its JSON path (e.g. `nodes[1].files: must not be empty`). Also run the core-side rules you can check offline: empty `files`, and overlapping files between parallel tasks.
  - Reuse `globsMayOverlap` from `@helix/core` **only if** `.dependency-cruiser.mjs` allows the CLI to depend on core; otherwise skip the overlap check and leave it to the daemon.
  - Exit 1 for local validation errors (2 stays for API/transport errors, as today).
  - Fill in `projectId` and `orchestratorSessionId` from `HELIX_PROJECT_ID` / `HELIX_SESSION_ID` when the file omits them.
- **`helix plan show <planId>` (new):** find the plan by replaying project events, as `status` does, and print the goal, its status (`awaiting_approval` / `approved` / `rejected`) and each task (id, agent, `dependsOn`, files, node status). `--json` prints the plan state.
- **`helix explain <text>`:** `--session` defaults to `HELIX_SESSION_ID`, and `--node` is optional. Error clearly when neither the flag nor the variable is set.
- Update the usage text and `apps/cli/README.md`, including the environment variables `HELIX_URL`, `HELIX_DATA_DIR`, `HELIX_SESSION_ID` and `HELIX_PROJECT_ID`.

### 4. Not in this task (record under CONTRACT-REQUESTs / follow-ups)
Running a real orchestrator end to end needs #19 (`HarnessStartOptions.env`), so the daemon can put the `helix` CLI on the agent's `PATH` and set `HELIX_URL`, `HELIX_SESSION_ID` and `HELIX_PROJECT_ID`. It also needs the daemon to pass `orchestratorPrompt` into core. Neither is owned here.

Still write the `HELIX_E2E=1` smoke test the issue asks for (in the CLI or harness package). Gate it so it **skips with a clear message** when the wiring isn't available yet.

## Verification
- `pnpm check` exits 0 (`pnpm.cmd` on Windows PowerShell).
- **CLI tests:**
  - local validation errors with paths, and exit 1
  - env fallback for the project and session ids
  - `plan show` output, human and `--json`
  - `explain` using `HELIX_SESSION_ID`
- **Harness test:** the prompt loads, contains the key rules, and `orchestratorPrompt()` includes the header.

## Result file (`handoffs/W2-orchestrator.result.md`)
Summary · public API · files · decisions · CONTRACT-REQUESTs / follow-ups · verification (exact counts) · known gaps.
