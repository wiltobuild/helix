# W3: cross-agent reviewer, UI (web app)

Branch `agent/reviewer-ui`, based on `agent/reviewer-contracts` (the frozen contracts). A parallel
Codex agent builds the backend on `agent/reviewer-backend` from the same base; you never touch
`packages/core/**`, `packages/harness/**`, `apps/daemon/**` or `apps/cli/**`. Build entirely
against the contracts and the `fixtures.crossReviewRun` fixture; you do not need the backend.

Read first: `CLAUDE.md`, `CONTRIBUTING.md`, `packages/contracts/src/{entities,events,projection,status}.ts`
(search for "review"), `packages/contracts/src/fixtures/cross-review.ts`,
`packages/contracts/src/review.test.ts`, then `apps/web/src/app/{App,Board,Inspector,PlanView,TimelineBar,RecordingControl}.tsx`,
`apps/web/src/data/{describe,useHelixSource,useDemoStream,recordings}.ts` and `packages/ui` primitives.
Match the existing design system, tone and component patterns; read
`docs/research/R4-ui-ux.md` for the visual direction.

## The feature

When a worker's PR is green, Helix starts a **reviewer session that is always the other agent
kind** (Claude Code reviews Codex, Codex reviews Claude Code; never self-review). The reviewer
submits a verdict (`approve` or `request_changes`) with findings; change requests go back to the
worker as `feedback.routed` with reason `review_findings`, and the same reviewer re-reviews the
new head. Projection exposes it on the **worker**: `SessionState.agentReview`
(`reviewerSessionId`, `headSha`, `status: reviewing | approved | changes_requested`, `review?`).
A review whose `headSha` differs from the PR head is stale. `deriveStatus` already gates
`ready_to_merge` on the cross review. `agent_review.abandoned` drops a review in progress.

Contracts are frozen. If you need a change, stop and write `CONTRACT-REQUEST:` with the reason in
your result file.

**Owned paths:** `apps/web/**`, `packages/ui/**` (only for a genuinely reusable primitive),
`handoffs/W3-reviewer-ui.result.md`. No root config, lockfile or dependency changes. You cannot
commit or push.

## Required

1. **Board.** Reviewer sessions are not separate cards. A worker card shows its cross review as a
   compact chip with the reviewer's agent badge: "Claude Code reviewing", "Changes requested · 2"
   (count of findings), "Approved by Codex", and nothing when there is no review. A stale review
   (head moved on) reads as reviewing the new head is pending, not as approved. Selecting the chip
   opens the worker in the Inspector on its Review section.
2. **Inspector, worker.** A Review section: verdict and summary, findings grouped by severity
   (blocker, major, minor, nit) with `file:line`, which head it applies to, and a link to open the
   reviewer's conversation. Show earlier verdicts for older heads collapsed (from the event log),
   so the request-changes → fix → approve story is visible. When the PR waits on the review, say so
   where the merge action is ("Waiting for Claude Code's review").
3. **Inspector, reviewer session.** Header names what it reviews ("Reviewing <worker title> · PR
   #7") and links back to the worker; the chat renders as usual.
4. **Plan view.** A node whose worker has a cross review shows the same state as the board chip,
   small.
5. **Timeline and Why.** `describe.ts` already has minimal sentences for the three new events;
   make them good (name the reviewer agent and the worker task; "requested changes (2 findings)"),
   give them tones (requested → review, approve → done, request_changes → failed,
   abandoned → needs or quiet; `feedback.routed` with `review_findings` → feedback) and
   provenance (a verdict is the reviewer agent's own judgment, so `agent`; requests and
   abandonment are `helix`). The Why chain from a routed review feedback must read back through
   the verdict and the request to the green CI. Update `replayPause` in `useDemoStream.ts` only if
   the tone mapping leaves review moments too short.
6. **Demo mode.** Add a third scenario, "Cross review", to the scenario switcher that replays
   `fixtures.crossReviewRun` (built in, no fetch), with `?demo=cross-review` selecting it. Keep the
   two existing scenarios and their recordings unchanged.

## Tests
Use `fixtures.crossReviewRun` and its milestones: chip text at each stage, findings rendering,
stale-review handling, inspector links both ways, describe/tone/provenance for every new event and
the new feedback reason, the Why chain, and the Cross review demo scenario. Follow the existing
test style (`apps/web/src/**/*.test.ts(x)`).

## Verification
`pnpm check` exits 0 (`pnpm.cmd check` in PowerShell). Also run `pnpm --filter @helix/web build:demo`
and confirm it builds. Report exact test counts.

## Result file (`handoffs/W3-reviewer-ui.result.md`)
Summary, files, decisions (with any UX trade-offs), verification, known gaps, any CONTRACT-REQUEST.
