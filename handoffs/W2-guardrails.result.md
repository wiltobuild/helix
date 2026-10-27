# W2 guardrails result — issue #9

## Summary

Implemented worker turn caps, project worker-slot scheduling and stop-all on
`agent/9-turn-cap-parallel-worker-limit-stop-all`. No commit or push was made.
The remaining blocker is permission to update `apps/daemon/src/server.test.ts`:
the brief requires daemon tests but expressly excludes that file from ownership.
The structured scope request is pending. Its existing exhaustive route-list test
fails until the new route is added to its cases.

## Public API and contract changes

- `CoreDeps.limits?: { maxTurnsPerTask?: number; maxParallelWorkers?: number }`,
  defaulting to 20 and 3. Invalid supplied limits throw at construction.
- `HelixCore.stopAll(projectId): Promise<{ stopped: SessionId[] }>`.
- `routes.stopProjectAgents`: `POST /api/projects/:id/stop-all`, `projectParams`,
  empty request, HTTP 200, response `stopProjectAgentsResponseSchema` containing
  `{ stopped: SessionId[] }`.
- One dispatch entry and one typed fake-core stub. No event schemas changed.
  The existing projection snapshots do not change.

## Files

- `packages/core/src/core.ts`: limits, recovery, held deliveries, worker capacity,
  causal rescheduling, project pause and stop-all; suppress scheduling as soon as
  shutdown is requested, including already queued exit callbacks.
- `packages/core/src/guardrails.test.ts`: 16 new test cases.
- `packages/core/README.md`: limits, continuation, slot lifetime and scheduling pause.
- `packages/contracts/src/api.ts`: route and response schema.
- `packages/contracts/src/interfaces.ts`: one core method.
- `apps/daemon/src/dispatch.ts`: one dispatch entry.
- `apps/daemon/src/testing/fake-core.ts`: one method stub.
- `handoffs/W2-guardrails.result.md`: this handoff.

`apps/daemon/src/server.ts` required no change: its existing global Host/Origin
hook protects the new route. No other repository files were edited. The existing
untracked brief `handoffs/W2-guardrails.md` was left untouched.

## Decisions

- Worker turns include automatic repair deliveries. Orchestrators are exempt.
  Active/idle boundaries with distinct delivery causes rebuild the counter from
  the log; accepted-turn metadata covers a crash before adapter activity. User
  extension receipts persist additional tranches without trusting explanatory
  text as authorization. Answers inside an open turn do not add a turn.
- Over-limit deliveries remain held. Notes and `waiting_input` carry the blocked
  delivery's cause. A human continuation at the cap grants another configured
  tranche and delivers; held repairs retain their order across restart.
- Slots include manual workers and idle/review/CI/input-waiting workers, from
  `session.started` until an authoritative merge event, exit or archival.
  Scheduling preserves plan age and node order. Waiting notes deduplicate across
  passes and restart, independently for each project. Approval and legacy-plan
  behavior remain intact.
- Stop-all persists the project pause before invoking the existing stop path on
  all live runtimes, including orchestrators and terminals. Already exited
  sessions are skipped. A new approval or newly created session resumes scheduling;
  rejection, repeated approval and an idempotent retry of an old session do not.
  Failures do not prevent attempts to stop the remaining runtimes.
- No new dependencies, UI changes, event types or root configuration changes.

## Verification

- `pnpm.cmd --filter @helix/core test`: **11 files, 123 passed, 0 failed**,
  including all 107 pre-existing cases and 16 new guardrail cases.
- `pnpm.cmd --filter @helix/core typecheck`: exit 0.
- `pnpm.cmd --filter @helix/core lint`: exit 0.
- `git diff --check`: exit 0.
- `pnpm.cmd boundaries`: exit 0, **189 modules**.
- Temporary daemon route verification:
  `pnpm.cmd exec tsx "$env:TEMP/helix-stop-all-verification.mts"`: exit 0,
  **7 cases passed**: happy path, body validation, query validation, hostile Host,
  hostile Origin, no dispatch on rejected requests, allowed Origin/CORS.
- `pnpm.cmd --filter @helix/daemon test`: **54 passed, 1 failed, 3 skipped**
  across **5 executed and 2 skipped files**. The sole failure is the existing
  `contract routes > covers every ordinary route` case missing `stopProjectAgents`.
- Full `pnpm.cmd check`: **exit 1**. Format, all 13 package typechecks, all package
  lint tasks and **20/20 tooling tests** passed. Turbo reported **21 successful
  tasks out of 23** before aborting on the daemon route-list failure above.
  Contracts passed **200/200 tests**, including all existing projection snapshots.
  The final boundaries stage was not reached; the separate boundaries command
  passed as recorded above.

## Known gaps

- `pnpm.cmd check` cannot pass with the current authorized file scope because
  the exhaustive daemon route test must be updated in
  `apps/daemon/src/server.test.ts`. No edits to that file were made. A concrete
  proposed test patch is available at
  `C:/Users/Wil/AppData/Local/Temp/helix-stop-all-server-test.proposed.diff`;
  the full proposed file is `helix-stop-all-server.test.proposed.ts` alongside it.
  It adds the route conformance case, project-ID substitution and a permanent
  Host/Origin/validation/dispatch test.
- Real-agent/GitHub E2E tests were not enabled. Direct terminal PTY keystrokes
  retain the existing v1 behavior without chat turn boundaries; the turn cap
  guards core-managed chat/harness deliveries. Stop-all also stops terminal workers.
- The existing crash window between adapter send acceptance and receipt
  persistence remains: exactly-once delivery needs an adapter acknowledgment seam.
