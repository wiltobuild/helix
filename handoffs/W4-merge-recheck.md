# W4: re-check open PRs after every merge

Branch `agent/merge-recheck` from `main`. Two other Codex agents work in parallel on other branches; stay inside your owned paths.

Read first: `CLAUDE.md`, `CONTRIBUTING.md`, `docs/PRD.html` (search "re-check"), `packages/contracts/src/{events,interfaces,projection}.ts`, `packages/core/src/core.ts` (`onScm`, `feedback`, `watch`, `schedule`, merge handling), `packages/scm/src/github.ts` (the polling watcher), and the existing tests in `packages/core/src/*.test.ts` and `packages/scm/src/*.test.ts`.

## The feature (PRD P1)
"User can rely on Helix to re-check open pull requests after each merge and send new conflicts back to their worker."

Today a worker only learns about a merge conflict if the SCM poll happens to report `mergeable: 'conflicting'` for its PR, and GitHub computes mergeability lazily, so after another PR merges, the others can sit at a stale or `unknown` mergeability for a long time.

## Required
1. After any `pr.merged` in a project, Helix promptly re-checks every **other** open PR it watches in that project: ask the SCM to refresh those PRs now (not waiting for the next poll), and follow up while GitHub still reports `mergeable: unknown`, with a bounded retry (for example a few attempts over about a minute). Add whatever the SCM interface needs for an on-demand refresh. That is `ScmObserver` in `packages/contracts/src/interfaces.ts`: you may change **only** that interface (keep it backward compatible, an optional method is fine) and must keep every implementation and fake compiling.
2. When a refreshed PR turns out `conflicting`, the existing `feedback(id, 'merge_conflict', …)` path routes it to the owning worker (dedupe per head, three-attempt cap, escalation unchanged). Record why: the routed feedback (or an `explain.note`) must be causally linked (`causedBy`) to the `pr.merged` that triggered the re-check, so the timeline's Why chain reads "conflict ← re-check ← PR #N merged".
3. No re-check storms: one re-check per merge, coalesced if several merges land close together; never re-check archived or closed PRs; stop on daemon shutdown.
4. Cross-agent reviews (`agent_review.*`) are unaffected: a conflict fix produces a new head, which already restarts CI and review.

## Tests
- Core with fake SCM: merging PR A triggers a refresh of open PR B; B reports `unknown`, then `conflicting`, so `merge_conflict` feedback goes to B's worker with the causal chain back to A's `pr.merged`; a clean B routes nothing; archived and closed PRs aren't refreshed; two quick merges cause one coalesced re-check; strict projection with zero anomalies.
- SCM: the on-demand refresh emits updates through the existing watcher path without breaking poll pacing or ETag caching.

## Owned paths
`packages/core/**`, `packages/scm/**`, `packages/contracts/src/interfaces.ts` (only `ScmObserver`), `apps/daemon/src/testing/**` (fakes only, if the interface needs it), `handoffs/W4-merge-recheck.result.md`. No root config, lockfile or dependency changes. You cannot commit or push.

## Verification
`pnpm.cmd check` exits 0. Report exact test counts. If the only failure is a known load-sensitive Windows harness test (for example `process.test.ts` "kills every live agent tree…"), rerun that file alone and report both results.

## Result file
`handoffs/W4-merge-recheck.result.md`: summary, interface change, files, decisions, verification, known gaps.
