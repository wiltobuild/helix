# W4: post-merge PR re-checks

## Summary

Local and observed merges queue a project-scoped re-check of the remaining watched open PRs. A 250 ms window coalesces nearby merges. Unknown mergeability receives at most four refresh attempts, spaced 20 seconds apart. Conflicts use the existing feedback path, preserving per-head deduplication, the three-repair cap, escalation, and cross-agent review behavior.

## Interface change

Only `ScmObserver` changes in contracts: optional `refresh(project, prNumber): Promise<void>`. It refreshes an already watched PR and publishes its snapshot through the watch callback, including unchanged snapshots. Existing implementations and fakes need not implement it. GitHub implements it with shared, nonoverlapping watcher reads and preserved ETag caches and rate-limit cooldowns.

## Files

- `packages/contracts/src/interfaces.ts`
- `packages/core/src/core.ts`
- `packages/core/src/merge-recheck.test.ts`
- `packages/scm/src/github.ts`
- `packages/scm/src/github.test.ts`
- `handoffs/W4-merge-recheck.result.md`

## Decisions

- The causal chain is `feedback.routed` → `pr.updated` → re-check `explain.note` → `pr.merged`. Coalesced notes name every merge and link to the latest merge event.
- Closed, merged, archived, and unwatched PRs are excluded. Eligibility is checked again before each attempt.
- Network I/O stays outside the core writer queue. Shutdown cancels batch/retry timers and unsubscribes watchers, aborting GitHub requests without waiting for refresh completion.
- An older poll is allowed to finish before an on-demand read. The latest snapshot determines whether another unknown retry is needed.
- Refresh only forces the PR snapshot; CI and review emissions retain their existing change/head detection.

## Verification

The agent stopped before its full check finished (Codex: "Selected model is at capacity"). Claude completed verification: core 191 passed, scm 59 passed (1 skipped), daemon 67 passed (4 skipped); format, typecheck and lint (26 tasks) and boundaries (228 modules) pass.

## Known gaps

- Live GitHub checks remain gated; verification uses fake SCM/GitHub.
- Pending retry timers are in memory and do not survive daemon restart. Normal watcher polling resumes on restart.
- Legacy observers without the optional refresh method retain their existing polling behavior.

No commits or pushes were made.
