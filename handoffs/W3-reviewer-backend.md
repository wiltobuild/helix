# W3: cross-agent reviewer, backend (core, harness, daemon, CLI)

Branch `agent/reviewer-backend`, based on `agent/reviewer-contracts` (the frozen contracts). A
parallel Codex agent builds the UI on `agent/reviewer-ui` from the same base; you never touch
`apps/web/**` or `packages/ui/**`.

Read first: `CLAUDE.md`, `CONTRIBUTING.md`, `packages/contracts/src/{entities,events,projection,status,interfaces,api}.ts`
(search for "review"), `packages/contracts/src/fixtures/cross-review.ts`,
`packages/contracts/src/review.test.ts`, `packages/core/src/core.ts` (`feedback`, `onScm`,
`endTurn`, `create`, `launch`, `schedule`, `stopProjectAgents`, `submitPlan`, `explain`),
`packages/core/src/reload.ts`, `packages/harness/src/{session,claude,codex,safe-commands,worktree-paths}.ts`,
`packages/harness/src/orchestrator/`, `apps/daemon/src/{real-core,helix-launcher,dispatch}.ts`,
`apps/cli/src/` (how `plan submit` and `explain` work).

## The feature

When a worker's PR is green on CI, Helix starts a **reviewer session that is always the other
agent kind**: Codex work is reviewed by Claude Code and Claude Code work by Codex
(`crossReviewerFor` in contracts). **Never fall back to self-review.** The reviewer reads the PR,
checks it against the task and acceptance criteria, and submits a verdict with findings via
`helix review submit`. "Request changes" routes the findings back to the worker as feedback; the
fix goes through CI again and the **same reviewer** re-reviews the new head. `deriveStatus` already
keeps the worker out of `ready_to_merge` until the review of the current head approves.

Contracts are frozen. If you need a contract change, stop and write `CONTRACT-REQUEST:` with the
reason in your result file instead of editing `packages/contracts/**`.

**Owned paths:** `packages/core/**`, `packages/harness/**`, `apps/daemon/**`, `apps/cli/**`,
`handoffs/W3-reviewer-backend.result.md`. No root config, lockfile or dependency changes. You
cannot commit or push.

## Required

### 1. Core lifecycle (`packages/core`)
- New deps: `CoreDeps.crossReview?: boolean` (default false; the daemon turns it on) and
  `CoreDeps.reviewerPrompt?: (ctx: { project; worker: Session; reviewer: Session; pr; node?: PlanNode }) => string`.
- **Trigger.** On `ci.updated` for a `worker` session whose PR is open with `checks.total > 0`,
  `failed === 0`, `pending === 0`, and whose current `pr.headSha` has no review in progress or
  verdict yet, start a review. Do not start reviews while scheduling is paused (Stop all), for
  archived/stopped workers, or when `crossReview` is off.
- **Pick the reviewer.** `crossReviewerFor(worker.agent)`. If that is undefined or its harness is
  not configured/available, emit one `explain.note` on the worker (for example "No cross-agent
  reviewer is available (Codex is not installed); Helix never lets an agent review its own work, so
  this PR relies on CI and human review") and do not request a review.
- **First review** creates a session: `role: 'reviewer'`, the cross agent, `parentSessionId` = the
  worker, title `Review: <worker title>`, `interface: 'chat'`, **no `planNodeId`** (it must not
  claim the worker's plan node). Its `cwd` is a fresh scratch dir `<dataDir-or-tmp>/reviews/<reviewerSessionId>`
  (core gets the base from a dep or the worktree manager; choose and document). Start the harness
  with `review: { worktreePath: <worker worktree path> }`. Do not create a git worktree for it.
  Emit `agent_review.requested` on the reviewer session (`causedBy` = the green `ci.updated`), then
  deliver the reviewer prompt.
- **Re-review**: when the worker's new head goes green, reuse the reviewer session (send it a
  message naming the new head and what changed since its last verdict) and emit a new
  `agent_review.requested`. If the reviewer session has exited, create a new one.
- **`submitReview(request)`** (replace the stub): validate the request; the reviewer session must
  exist with role `reviewer`, the worker's `agentReview` must be `reviewing` for this reviewer and
  `headSha`, and the worker's PR head must still equal `headSha`, otherwise `INVALID_REQUEST`
  ("the PR moved on; review the new head"). Emit `agent_review.submitted` on the reviewer session,
  `causedBy` the matching `agent_review.requested`. On `request_changes`, call the existing
  `feedback()` path with reason `'review_findings'` so the three-attempt cap, dedupe per head and
  escalation still apply. Format the routed message in core (not the SCM builder): one header line
  naming the reviewer agent and PR, then one line per finding `[severity] title (file:line): detail`,
  details trimmed, whole message at most 2,500 characters. Approvals route nothing.
- **No verdict.** If the reviewer's turn ends with the review still `reviewing`, send one reminder
  ("submit your verdict with `helix review submit`"). If the next turn also ends without one, or
  the reviewer exits, fails or is stopped, emit `agent_review.abandoned` with a plain reason and an
  `explain.note` on the worker. The PR then falls back to CI and GitHub review.
- **Stop all / archive / PR closed or merged**: stop reviewer sessions too; abandon any review in
  progress. Reviewers do not take worker slots (`HELIX_MAX_WORKERS`) but count as running agents for
  Stop all.
- **Restart** (`reload.ts`): a daemon restart must not double-request or lose a review in progress;
  resume the reviewer like other sessions, rebuilding state from the projection.
- `merge` keeps requiring `ready_to_merge` (which now includes the cross review).

### 2. Harness (`packages/harness`)
- **Review mode** (`HarnessStartOptions.review`): decline every file write outside `cwd` with a
  clear message ("Reviewers report findings; they never edit the code under review"), for both
  adapters.
  - Codex: run the reviewer with sandbox `workspace-write` rooted at the scratch `cwd` so the OS
    sandbox blocks writes to the worktree; make sure `helix review submit` can still reach the local
    daemon (check how the orchestrator's `helix` calls work under Codex and match that).
  - Claude Code: `acceptEdits` stays limited to `cwd`; any Write/Edit/MultiEdit/NotebookEdit
    targeting a path outside `cwd` is denied by the adapter without asking the user.
- **Safe commands**: extend `isSafeCommand` to accept extra read roots, so a reviewer can
  `cd <worktree> && git diff <base>...HEAD`, `git -C <worktree> diff|log|show|status`, `cat`/`grep`
  inside the worktree, and `helix review submit <file>` without approval. Writes, installs and
  scripts inside the worktree are **not** auto-approved for reviewers (CI already ran them).
  Keep every existing test passing; add tests for the reviewer cases.
- **Reviewer prompt**: `packages/harness/src/reviewer/prompt.md` plus an exported `reviewerPrompt()`
  like `orchestratorPrompt()`. It tells the reviewer: it is the cross-agent reviewer for another
  agent's PR; CI already passed; read the diff against the base branch and the task/acceptance
  criteria; look for correctness bugs, missed requirements, risky changes and missing tests, not
  style nits; never edit the worktree; write the verdict JSON (the `agentReviewSchema` shape, with a
  short example) to a file in its cwd and run `helix review submit <file> --head <sha>` with the head
  named in the request; one verdict per request.
  `request_changes` only for blocker/major issues; nits go in an approval.

### 3. CLI (`apps/cli`)
`helix review submit <file|-> --head <sha>`: reads the JSON (`agentReviewSchema`), takes the
reviewer session from `HELIX_SESSION_ID` and the head from `--head` (every review request message
names it; the head changes between re-reviews, so it cannot be a process env var), calls
`POST /api/reviews`, and prints a one-line result (`--json` prints the event). Validation errors
print readable messages, like `plan submit`.

### 4. Daemon (`apps/daemon`)
- `real-core.ts`: `crossReview` on by default; `HELIX_REVIEWER=off` turns it off (validate on/off
  like `HELIX_AUTO_APPROVE`). Pass `reviewerPrompt`.
- `helix-launcher.ts` `sessionEnvironment`: reviewers get the same `HELIX_DATA_DIR`,
  `HELIX_SESSION_ID`, `HELIX_PROJECT_ID` and launcher `PATH` as orchestrators.
- Wire `submitReview` (already dispatched) to the real core.

## Tests
- Core, with fake harnesses and fake SCM: green CI starts a cross reviewer of the other kind
  (both directions); no reviewer available → note, no request, never self-review; approve →
  `ready_to_merge`; request_changes → `review_findings` feedback to the worker → new head green →
  same reviewer re-requested → approve; stale head rejected; three-attempt cap; no verdict →
  reminder → `agent_review.abandoned`; Stop all abandons; restart does not double-request. The
  resulting event log must project with `strict: true` and zero anomalies.
- Harness: review-mode write denial for both adapters; Codex sandbox args for reviewers; safe
  commands with read roots.
- CLI and daemon: `review submit` happy path and validation errors; env and `HELIX_REVIEWER` parsing.
- Optional, gated on `HELIX_E2E=1` and **not run by you**: a real cross-review smoke modeled on
  `orchestrator-real.e2e.test.ts`.

## Verification
`pnpm check` exits 0 (`pnpm.cmd check` in PowerShell). Report exact test counts.

## Result file (`handoffs/W3-reviewer-backend.result.md`)
Summary, public API, files, decisions, verification, known gaps, any CONTRACT-REQUEST.
