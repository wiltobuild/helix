# W2 guardrails: turn cap, parallel-worker limit, stop-all (issue #9)

Branch `agent/9-turn-cap-parallel-worker-limit-stop-all`, based on `main` at `bb15fd3`. That includes #4's approval gate: `schedule()` now runs only for approved plans. Read `CLAUDE.md`, `CONTRIBUTING.md`, `packages/core/README.md` and `packages/core/src/core.ts` first.

**Owned paths:**
- `packages/core/**`
- `apps/daemon/src/server.ts`
- `handoffs/W2-guardrails.result.md`

**Minimal contract extension, authorized by Wil (contracts are his side's single-owner area):**
- `packages/contracts/src/api.ts`: one new route plus its response schema.
- `packages/contracts/src/interfaces.ts`: one new `HelixCore` method.
- `apps/daemon/src/dispatch.ts`: one dispatch line.
- `apps/daemon/src/testing/fake-core.ts`: stub the new method.
- Regenerate any contract snapshot that changes.

Nothing else outside the owned paths. You cannot commit or push.

## Required

### 1. Per-task turn cap (default 20)
- Add `CoreDeps.limits?: { maxTurnsPerTask?: number; maxParallelWorkers?: number }`, defaulting to 20 and 3. Values must be positive integers, otherwise throw at construction.
- Count turns per **worker** session with the existing turn counter, including automatic repair turns (CI or review feedback). Orchestrator sessions are exempt.
- When a turn would exceed the cap, don't send it:
  - Record it as held so nothing is lost.
  - Emit `explain.note`: "Turn limit reached (20 turns). Helix paused this task; send a message to continue for another 20." The note's cause is the delivery that hit the cap.
  - Emit `activity.changed` with `waiting_input`, so `deriveStatus` shows **Needs you**.
- A **user** message to that session raises the cap by another `maxTurnsPerTask` and delivers. Automatic feedback never raises it.
- The cap survives a daemon restart: rebuild the count from the event log, using turn boundaries or the existing turn counting.

### 2. Max parallel workers per project (default 3)
- A worker **occupies a slot** from `session.started` until it is merged, archived or `exited`. Idle in review, waiting on CI, still counts, because the same worker repairs CI failures.
- `schedule()` starts ready nodes only while slots are free, in plan order (node order across plans, oldest plan first).
- Each ready node left waiting gets one `plan.node_updated` with a visible note, e.g. "Waiting: 3 of 3 worker slots are in use." Emit it once per node per blocking period, not on every pass.
- When a slot frees (`pr.merged`, `session.exited`, archive), run `schedule` again, caused by that event.
- Approval-gate behavior from #4 stays exactly as is.

### 3. Stop-all
- **Contract:** route `stopProjectAgents`, `POST /api/projects/:id/stop-all`, with `params: projectParams`, an empty request and response `{ stopped: SessionId[] }`. Add `HelixCore.stopAll(projectId): Promise<{ stopped: SessionId[] }>`.
- **Core:** stop every session in the project with a live runtime, orchestrator and workers, using the existing `stop()`. Return the ids actually stopped. Sessions that are already exited are skipped, not errors.
- **Core:** also pause scheduling for that project until a new plan is approved or a session is created. Otherwise a stop-all followed by a merge would restart workers. Document this.
- **Daemon:** keep `server.ts`'s Host/Origin protection applied (it is global; just confirm with a test).

## Verification
- `pnpm check` exits 0 (`pnpm.cmd` on Windows PowerShell).
- **Core tests:**
  - The cap: blocks at N, emits the note and `waiting_input`, a user message extends it, automatic feedback does not, and it survives a restart.
  - Parallel limit: 5 approved independent nodes with limit 3 → 3 start and 2 wait with the note; merging one starts the next, caused by the merge; an exited worker frees a slot.
  - stopAll: stops orchestrator and workers, returns their ids, skips exited ones, and nothing restarts afterwards.
- **Daemon test:** the stop-all route.
- Keep every existing test passing.

## Result file (`handoffs/W2-guardrails.result.md`)
Summary · public API and contract changes · files · decisions · verification (exact counts) · known gaps.
