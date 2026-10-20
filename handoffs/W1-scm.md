# W1-scm — GitHub observer and PR facts

**Owned paths:** `packages/scm/**`, `packages/testing/src/github/**` (plus one export line for it in `packages/testing/src/index.ts`)

## Goal
Implement `ScmObserver` from `@helix/contracts` for GitHub: open PRs, observe PR/CI/review state efficiently, and merge. Emissions become `pr.updated`, `ci.updated`, `review.updated`, `pr.merged` events, which drive the board and the CI → fix feedback loop.

## Requirements
- **Auth:** token from `GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token` (spawn, no shell). Never log tokens. If unavailable → typed error with code `UNAUTHORIZED` and a human-readable fix ("run `gh auth login`").
- **HTTP:** plain `fetch` against REST v3 (optionally GraphQL for review threads). Pin no SDK unless it clearly saves work; if you use Octokit, pin it.
- **openPr** → creates PR (`draft` supported), returns normalized `PullRequestFacts`.
- **watch(project, prNumber, onEvent)** → polls with **ETags / If-None-Match** (304s don't count against rate limits): PR (state, draft, mergeable, headSha), combined check runs + statuses for `headSha`, reviews + unresolved review threads (GraphQL `reviewThreads(isResolved)`). Emit only when normalized facts **change** (deep compare). Poll interval 15 s default, 5 s while checks are pending, backs off on 403/429 using `Retry-After`/`X-RateLimit-Reset`. One poller per PR; `Unsubscribe` stops it.
- **Normalization** (document on functions):
  - `CheckSummary`: `success`, `neutral`, `skipped` → passed; `failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure` → failed (`failingNames` = check names); `queued`, `in_progress`, `pending`, `waiting` → pending. Dedupe re-runs by check name (latest wins).
  - `ReviewSummary.decision`: latest review per reviewer; any `CHANGES_REQUESTED` → `changes_requested`; ≥1 `APPROVED` and none outstanding → `approved`; required reviewers pending → `review_required`; else `none`. `unresolvedThreads` from GraphQL.
  - `mergeable`: GitHub `mergeable` true/false/null → `mergeable`/`conflicting`/`unknown`.
- **merge({ expectedHeadSha, method })** — passes `sha` to GitHub to prevent merging a moved head; maps 405/409 → `MERGE_BLOCKED` with GitHub's reason; returns `mergeSha`; emits `pr.merged`.
- **Feedback summaries** (pure helper for core): `summarizeFailure(facts, details)` → one concise paragraph for the agent: failing check names, the first failing annotation/log excerpt if available (≤ 1,500 chars total), and unresolved review comments (author, path:line, body trimmed). Exported as `buildFeedbackMessage(...)`. Never include raw full logs.
- `createGitHubScm({ token?, fetch?, pollMs? })` export.

## Fake GitHub (`packages/testing/src/github/`)
`createFakeGitHub()` — in-memory server shaped like the REST/GraphQL endpoints you call (as an injectable `fetch`), supporting ETags/304, scripted check transitions (`pending → failure → success`), reviews/threads, merge (incl. head-moved conflict), rate-limit responses. Used by core tests.

## Tests
- Normalization tables for checks, reviews, mergeable.
- ETag: second poll gets 304 and emits nothing.
- Scenario on the fake: open PR → pending → `ci.updated` failed with `failingNames` → new head → success → review approved → merge emits `pr.merged`.
- Rate-limit backoff honored (fake timers).
- Head-moved merge → `MERGE_BLOCKED`.
- `buildFeedbackMessage` length cap and content.
- `HELIX_E2E=1`: read-only smoke against a public repo PR (e.g. fetch facts for a known closed PR) — no writes.
