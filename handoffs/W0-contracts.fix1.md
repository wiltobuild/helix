# W0-contracts — fix round 1 (from Claude's review)

The scaffold has been merged into your branch (`wave0/contracts`). Your standalone package.json/tsconfig were replaced by the scaffold's (extends `tsconfig.base.json`, which adds `exactOptionalPropertyTypes`; tests run through the root `vitest.config.ts` projects). Root `node_modules` is installed. **You cannot commit** (the sandbox makes `.git` read-only) — leave changes in the working tree; Claude commits.

Only edit `packages/contracts/**` and your result file. If the root vitest/eslint config genuinely needs a change to pick up your tests, describe the exact change in your result instead of making it.

## 1. Integrate with the scaffold (blocking)
- `pnpm --filter @helix/contracts typecheck` currently reports a type error; `pnpm --filter @helix/contracts test` fails (the root Vitest project likely only matches `src/**/*.test.ts` — your tests live in `tests/`). Move tests next to the code they test (`src/*.test.ts`) or otherwise make them run under the root config without changing root files.
- Remove standalone leftovers: `packages/contracts/vitest.config.ts`, `packages/contracts/.gitignore`.
- `pnpm check` at the repo root must pass (format, typecheck, lint, test, boundaries). Run `pnpm format` for Prettier.

## 2. Projection performance (should fix — the timeline scrubber depends on it)
`applyEvent` deep-clones the entire `ProjectState` on every event, so `projectUpTo(events, n)` is O(n × state size). A real run has thousands of events with growing chat history; dragging the scrubber recomputes repeatedly and will stutter.
- Split into an internal mutating reducer (`reduceInto(state, event)`) and keep the public `applyEvent(state, e)` pure by cloning once per call.
- `projectUpTo` must clone at most once (copy the starting state, then mutate in place while folding), and must not clone each input event more than needed.
- Add `createProjector(events)` returning `{ at(seq): ProjectState }` that caches checkpoints every 100 events, so scrubbing to any `seq` folds at most ~100 events from the nearest checkpoint. Returned states must still be safe to hold (treat them as read-only; document that callers must not mutate; freeze in dev if cheap).
- Add a perf test: a synthetic run of 5,000 events (mostly `chat.item` and `activity.changed`) — `createProjector(...).at(random seq)` × 200 completes in < 1 s on CI. Keep determinism and immutability tests passing.

## 3. Don't crash the UI on one bad event (should fix)
`applyEvent` throws on unknown sessions/approvals/PR mismatches. In the live app a single out-of-order or malformed event would blank the whole board.
- Add `options: { strict?: boolean }` (default **false**). Non-strict mode skips the offending event and records `{ seq, type, reason }` in a new `ProjectState.anomalies: Anomaly[]` (append-only, capped at 100). Strict mode keeps today's throws; the existing invariant tests run in strict mode.
- `project.added` mismatch / mixing projects still throws in both modes (that's a programming error, not data).

## 4. Answers to your open questions
- **Draft PRs** never reach `ready_to_merge` (they stay `in_review`). **Unresolved review threads > 0** also block `ready_to_merge`. Update `deriveStatus`, the precedence comment, and the table test.
- **Skipped/neutral checks** count as passed in `CheckSummary` (the SCM adapter normalizes them; document this on the schema).
- **Imported recordings** are replay-only and keep original IDs and seqs. Document on `recording.ts`.

## 5. Small items
- `explain.note` with a `planNodeId` but no `sessionId` is currently dropped from state. Attach it to the plan's orchestrator chat as a `plan_update` with that `nodeId`.
- Export a `HELIX_CONTRACTS_VERSION = 1` constant.

## Acceptance
1. `pnpm check` passes at the repo root (Windows).
2. All previous behavior tests pass; new tests for checkpoints, perf, non-strict anomalies, draft/threads gating, and orphan `explain.note`.
3. Result file: what changed, test counts, perf numbers measured, anything you disagree with.
