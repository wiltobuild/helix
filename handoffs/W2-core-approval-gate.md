# W2 core: plan approval gate, file-ownership checks, orchestrator start (issue #4)

Branch `agent/4-plan-approval-gate-file-ownership-checks`, based on `main` at `0c83d4c`. #3 (PR #13) already landed the contracts:
- `PlanNode.files` (repo-relative globs)
- `plan.approved` / `plan.rejected`
- `PlanState.status`: `awaiting_approval` | `approved` | `rejected`
- `core.decidePlan`
- `HelixStore.getMeta` / `setMeta`

Read `CLAUDE.md`, `CONTRIBUTING.md`, `packages/core/README.md` and `packages/core/src/core.ts` first.

**Owned paths:** `packages/core/**` and `handoffs/W2-core-approval-gate.result.md`. Do not edit `packages/contracts`, other packages, root config or the lockfile. If you need a contract change, list it under CONTRACT-REQUESTs in the result file and work around it in core. You cannot commit or push.

## Required

### 1. Approval gate
- `submitPlan` emits `plan.submitted` and **does not schedule**. Nothing in the plan starts.
- `decidePlan(approve)` emits `plan.approved`, then calls `schedule(projectId, approved.seq)`. Root workers' `session.created` must be caused by the `plan.approved` event.
- `decidePlan(reject)` emits `plan.rejected`. No worker is ever created for that plan, including after a restart.
- `schedule()` skips any plan that isn't approved. This must also hold in `start()`, which reschedules every project on restart.
- **Legacy plans.** Plans recorded before #3 have no decision event and replay as `awaiting_approval`, but their workers already ran. A plan that is `awaiting_approval` and already has a node with a `sessionId` must be treated as approved for scheduling, so its remaining dependents still start after a restart. Add a test for exactly this.

### 2. File-ownership validation in `submitPlan`
- Two nodes are **parallel** when neither is reachable from the other through `dependsOn`, transitively. Nodes ordered by dependencies may overlap freely.
- Reject the plan with `INVALID_REQUEST` when two parallel nodes declare overlapping `files`. The message names both node ids and each conflicting glob pair, e.g. `Parallel tasks "api" and "ui" both claim files: src/shared/** ↔ src/shared/types.ts`.
- Overlap must be **conservative**: when in doubt, report an overlap. Put it in a pure, exported helper (`globsMayOverlap(a, b)`) with table tests. Compare segment by segment:
  - `**` overlaps any number of segments.
  - A segment containing `*`, `?`, `[` or `{` overlaps any single segment.
  - Literal segments compare case-insensitively, because Windows is case-insensitive.
  - Different lengths overlap only through `**`.
- A node with an empty `files` array in a **new** submission is rejected with `INVALID_REQUEST`, because every task must declare what it touches. Legacy replays keep `files: []`; never reject on reload.

### 3. Shared-interface warning (documented rule)
- Document in `packages/core/README.md`: when parallel tasks share a new interface, the plan must include a contract task that both depend on.
- After `plan.submitted`, emit one `explain.note` on the orchestrator session, caused by `plan.submitted`, for each pair of parallel nodes whose descriptions both mention a shared interface but that have no common dependency. Use a simple, documented keyword check, e.g. `interface`, `contract`, `shared type`, `schema`, `API shape`. This is a warning, not a rejection.

### 4. Orchestrator start
- Add an optional `CoreDeps.orchestratorPrompt?: (ctx: { project: Project; session: Session }) => string`.
- For a session created with `planWithOrchestrator: true`, the **first delivered message** is `orchestratorPrompt(...)` followed by a blank line and the user's prompt. The stored `Session.prompt` stays exactly what the user typed.
- Without the dependency, behavior is unchanged.
- Putting the `helix` CLI on the agent's PATH needs harness env support (`HarnessStartOptions` has no env). Record it as a CONTRACT-REQUEST with the exact proposed field; don't work around it.

### 5. Re-check open PRs after a merge
Conflict routing already exists. Add a core test with the fake SCM:
1. Two parallel workers each have an open PR.
2. A merges.
3. SCM reports B `mergeable: 'conflicting'`.
4. Assert `feedback.routed` with reason `merge_conflict` to B's session, caused by B's `pr.updated`, routed exactly once.

If anything is missing to make that work, fix it in core.

### 6. Resume tokens and delivery receipts on `getMeta`/`setMeta`
- Replace the `RESUME_SCOPE`, `DELIVERY_SCOPE` and `MESSAGE_SCOPE` uses of `remember`/`recall` with `getMeta`/`setMeta`. Store one latest resume token per session, not one per event.
- **Read-through migration:** if the new metadata is missing, fall back to the old `recall` records, so a daemon upgraded mid-session keeps its resume tokens and doesn't redeliver messages. Test that upgrade path.

## Verification
- `pnpm check` exits 0 (use `pnpm.cmd` on Windows PowerShell).
- New tests:
  - submit → no worker; approve → worker, caused by `plan.approved`; reject → never
  - restart with an awaiting plan → no worker; restart with an approved plan → dependents still start
  - legacy plan restart
  - overlap: rejected for parallel nodes, allowed for dependency-ordered nodes; `globsMayOverlap` table; empty `files` rejected
  - shared-interface note
  - orchestrator first message includes the injected prompt
  - merge-conflict re-check
  - meta migration read-through
- Keep every existing test passing. Update tests that assumed immediate scheduling to approve first.

## Result file (`handoffs/W2-core-approval-gate.result.md`)
Summary · public API changes · files · decisions · CONTRACT-REQUESTs · verification (exact counts) · known gaps.
