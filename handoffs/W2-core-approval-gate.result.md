# W2 core: approval gate, ownership checks and orchestrator start

## Summary

Implemented the plan approval gate, conservative file ownership validation,
shared-interface warnings, orchestrator initial instructions and durable metadata
with read-through migration. Added the post-merge conflict regression; existing
SCM watch routing already provides the required causal, deduplicated feedback.

## Public API changes

- Exported `globsMayOverlap(a: string, b: string): boolean` from `@helix/core`.
- Added optional `CoreDeps.orchestratorPrompt?: (ctx: { project: Project; session: Session }) => string`.
- `submitPlan` now leaves workers pending until `decidePlan(approve)` records
  approval. New tasks require non-empty `files`; parallel overlapping claims
  produce `INVALID_REQUEST` naming tasks and conflicting glob pairs.
- No contracts, other packages, root configuration or lockfile changes.

## Files

- `packages/core/src/core.ts`: approval scheduling, initial prompt composition,
  metadata writes and migration reads.
- `packages/core/src/plan-validation.ts`: pure glob intersection, transitive
  ownership validation and shared-interface warning generation.
- `packages/core/src/index.ts`: exported glob helper.
- `packages/core/src/approval-gate.test.ts`: approval, rejection, restart, legacy,
  overlap validation, warnings, initial instructions and merge-conflict coverage.
- `packages/core/src/plan-validation.test.ts`: symmetric glob table tests.
- `packages/core/src/metadata.test.ts`: mutable latest tokens and legacy upgrade.
- `packages/core/src/core.test.ts`, `packages/core/src/agent-loop.test.ts`:
  approve plans before checking workers; retain legacy receipt coverage.
- `packages/core/src/plan-decision.test.ts`: updated stale test comment.
- `packages/core/README.md`: behavior, keyword rule, metadata and contract request.
- `handoffs/W2-core-approval-gate.result.md`: this result.

## Decisions

- Scheduler accepts approved plans and the required legacy exception: awaiting
  plans with an existing node session. Rejected plans never pass the gate.
  Legacy projected status remains awaiting; no decision event is fabricated.
- Root creation uses the recorded approval as its cause, including recovery
  after approval was persisted before scheduling. Dependents retain the latest
  prerequisite merge as their cause.
- Ownership compares case-insensitive path segments, with whole `**` matching
  zero or more segments and wildcard-bearing segments conservatively matching
  any one segment. Ordered nodes may overlap through transitive dependencies.
- Warnings use whole phrase matches for `interface`, `contract`, `shared type`,
  `schema`, `API shape`, case-insensitive with optional plural `s`. Both nodes
  must mention a keyword and lack a common transitive dependency. One note per
  parallel pair follows and is caused by submission.
- Initial instructions are delivered to orchestrators through normal delivery
  (also terminal initial paste); stored prompts stay exactly as submitted.
- Metadata scopes retain their existing names. Resume keys are now session IDs;
  receipt/mode keys remain event sequences. Missing metadata reads through legacy
  idempotency records and writes back migrated values. Existing metadata wins.
  Command reservation/result idempotency remains on `remember`/`recall`.
- SCM continues watching other open PRs after a merge. Its conflicting update
  produces feedback caused by that PR update exactly once per reason/head.

## CONTRACT-REQUESTs

- Add the exact field `env?: Record<string, string>` to `HarnessStartOptions`:
  `type HarnessStartOptions = { session: Session; cwd: string; resumeToken?: string; env?: Record<string, string> }`.
  Harness adapters should apply this per-session environment when starting agent
  processes, allowing the composition root to prepend the `helix` CLI directory
  to PATH. No process-wide PATH workaround was added.
- Existing limitations remain: harness delivery IDs/acknowledgments for exactly-once
  delivery, explicit process reattachment capability, and an optional health
  anomalies count. These are not needed for the implemented gate.

## Verification

- `pnpm.cmd check`: exit **0**. Formatting, root/workspace typechecking, lint,
  tooling tests, workspace tests and architecture boundaries passed.
- Core: **107 passed, 0 failed, 0 skipped**, across **10 test files**. This adds
  **36 cases** to the existing 71: 10 approval/lifecycle/validation scenarios,
  24 glob table rows (each checked in both directions), and 2 metadata scenarios.
- Workspace Vitest suites: **718 passed, 0 failed, 21 skipped**, across **46
  passed and 6 skipped files**. Gated external/integration checks remain skipped.
- Boundary/tooling regression tests: **20 passed, 0 failed, 0 skipped**.
  Combined test totals: **738 passed, 0 failed, 21 skipped**.
- Turbo tasks: typecheck **13/13**, lint **23/23**, test **23/23** successful.
  The test phase reused **20/23** unchanged cached tasks; core and daemon tests
  executed freshly.
- Architecture boundaries: **188 modules**, passed. `git diff --check`: passed.
- Turbo emitted non-fatal access-denied cache warnings in this restricted
  workspace; all verification phases completed successfully.

## Known gaps

- CLI PATH injection awaits the requested harness environment contract.
- Conservative glob checks can reject disjoint wildcard patterns. Interface
  keyword checks can warn about unrelated interfaces or miss descriptions without
  those keywords; warnings remain advisory.
- SCM exposes no explicit refresh operation; post-merge conflict feedback relies
  on the existing observer stream. The fake-SCM regression verifies routing after
  the update arrives.
- Existing crash windows between harness send and receipt persistence, or user
  event append and mode persistence, remain as documented in core's README.
- No live agent or GitHub checks were run. The full check includes the daemon's
  local HTTP/SQLite/Git integration. No commit or push was made.
