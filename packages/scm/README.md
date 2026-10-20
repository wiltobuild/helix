# @helix/scm

GitHub implementation of the frozen `ScmObserver` contract, using Node fetch
and no new runtime dependencies.

## API

- `createGitHubScm({ token?, fetch?, pollMs?, onError? }): ScmObserver`
- `buildFeedbackMessage: FeedbackMessageBuilder`
- `normalizeChecks(checks: GitHubCheck[], statuses?: GitHubStatus[]): CheckSummary`
- `normalizeReviews(reviews: GitHubReview[], unresolvedThreads?, requiredPending?, reviewDecision?): ReviewSummary`
- `normalizeMergeable(value: boolean | null): PullRequestFacts['mergeable']`
- Exported types: `GitHubScmOptions`, `GitHubCheck`, `GitHubStatus`, `GitHubReview`.

Watching starts immediately. Subscribers share one repository/PR poller; a late
subscriber receives the current snapshot. Initial PR/CI/review facts are emitted,
then changed facts only. Changed heads emit CI even when check counts match.
Unsubscribing the last listener aborts HTTP and cancels polling. Subscriber
exceptions and mutations are isolated.

Default polling is 15 seconds, or 5 seconds while checks are pending. `pollMs`
can shorten either interval. REST pages use ETags; GraphQL thread pages are queried
each cycle without REST conditional caching. Rate limits share a cooldown across
the observer, honoring Retry-After seconds/dates and X-RateLimit-Reset, with a
60-second fallback. Other watch errors retry after at least 15 seconds. HTTP
requests time out after 30 seconds. Errors retain the last valid snapshot;
unreadable reviews never become an empty approval.

Credentials resolve from explicit token, GH_TOKEN, GITHUB_TOKEN, then
`gh auth token` without a shell. Windows timeout cleanup kills the process tree.
Tokens and child stderr are not logged. A 401 resets credential discovery. Only
api.github.com is contacted; redirects and Enterprise hosts are unsupported.

`openPr` creates the PR and hydrates its CI/review facts. If hydration fails after
creation, callers should reconcile before retrying creation. `merge` sends the
expected SHA and method, returns the merge SHA, and emits `pr.merged` to active
watchers. External merges are also detected. Local merges discard older in-flight
snapshots.

## Normalization and feedback

Check names are deduplicated by start/creation time, using IDs for ties or missing
timestamps (including queued reruns). Success, neutral and skipped pass. Failure,
timed_out, cancelled, action_required, startup_failure, error and stale fail.
Unfinished and unknown states remain pending. Failing names are sorted.

Latest submitted review per reviewer wins; drafts and deleted users are ignored.
Changes requested wins, then outstanding requested reviews or GraphQL
REVIEW_REQUIRED, then approval, then none. Requested teams are conservatively
treated as outstanding reviews. All unresolved threads count, including outdated
threads until resolved. All REST collections and GraphQL threads are paginated.

The exact feedback signature is `buildFeedbackMessage({ reason, pr, details? })`.
Output is one paragraph capped at 1,500 characters, with separate name/detail
budgets. The caller supplies the first failing annotation/log excerpt and review
comments in `details`, for example:
`Assertion failed. Ada, src/example.ts:42: Handle the missing value.`
At most 900 detail characters are retained. No full logs or comment bodies are
retrieved by this helper; the contract provides summary counts and a detail string.

## Fake GitHub

Import `createFakeGitHub` from `@helix/testing`. Defaults are acme/demo;
`createFakeGitHub({ owner, repo })` selects another repository. It exposes:

- `fetch`, `requests`, `owner`, `repo`
- `seedPr(patch?)`, `getPr(number)`, `setPr(number, patch)`
- `setChecks(number, checks, statuses?, sha?)`
- `scriptChecks(number, snapshots, sha?)`
- `setReviews(number, reviews, decision?)`, `setThreads(number, threads)`
- `rateLimitNext({ path?, status?, headers? }?)`
- `blockMerge(number, message, status?)`

Scripts consume one snapshot per first-page check request, then hold the last
state. Request records contain conditional headers and response status, never
authorization headers. The fake implements pagination, ETags/304, thread queries,
rate limits and expected-head merge conflicts without sockets or network calls.

## Verification and contract request

Default tests use injected fetch and mocked child processes. The read-only smoke
test runs only with HELIX_E2E=1, discovering a closed cli/cli PR. Optional overrides
are HELIX_E2E_OWNER, HELIX_E2E_REPO and HELIX_E2E_PR. GraphQL needs credentials.

CONTRACT-REQUEST: ScmObserver.watch returns only Unsubscribe and has no asynchronous
error channel. The factory accepts optional `onError(error: HelixError)` locally.
A future optional watch error callback would let core consume failures through
the interface. Without the callback, watch failures retry without a notification.

Format SCM with `pnpm --filter @helix/scm format`. Format the fake with
`pnpm exec prettier --write packages/testing/src/github packages/testing/src/index.ts`.
These commands select only owned paths.

API references: [GitHub REST pull requests](https://docs.github.com/en/rest/pulls/pulls),
[GitHub GraphQL pull requests](https://docs.github.com/en/graphql/reference/pulls).
