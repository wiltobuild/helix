**Summary:** Implemented GitHub observation, guarded merges, feedback summaries, and fake GitHub. Changes are uncommitted.

**Public API:**

```ts
createGitHubScm(options?: GitHubScmOptions): ScmObserver
buildFeedbackMessage: FeedbackMessageBuilder
normalizeChecks(checks, statuses?): CheckSummary
normalizeReviews(reviews, unresolvedThreads?, requiredPending?, reviewDecision?): ReviewSummary
normalizeMergeable(value: boolean | null): PullRequestFacts['mergeable']
createFakeGitHub(options?): FakeGitHub
```

**Files:** Only owned paths and the [complete handoff](C:/Users/Wil/Documents/Projects/helix-wt/w1-scm/handoffs/W1-scm.result.md) changed.

**New dependencies:** None.

**Decisions:** Shared pollers, paginated REST/GraphQL reads, isolated subscribers, and caller-supplied feedback details.

**CONTRACT-REQUESTs:** Add an asynchronous error callback to `watch()`. The factory provides optional `onError` meanwhile.

**Verification:** `pnpm check` exited **0**. Package tests: **235 passed, one skipped**; tooling: **20 passed**. SCM: **56 passed**. Boundaries passed across **87 modules**.

**Known gaps:** Live smoke test not run; GitHub.com only. The handoff documents feedback-detail requirements and reconciliation after partial PR creation.