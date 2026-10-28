# W2 structured guardrail state

## Summary

Turn caps, worker-slot waits, and the Stop all scheduling pause now have structured
events and replay state. Core emits the new fields without changing its human-readable
notes. Web detection reads projected state, and the board explains how to resume scheduling.

## Contract changes

- Optional `explain.note.code`: `turn_limit_reached` or `turn_limit_extended`.
- Optional `plan.node_updated.waiting`: `worker_slot`; omission on a later update clears it.
- Project-level `scheduling.changed` with `{ paused: boolean }`; session and plan-node
  envelopes are rejected.
- `SessionState.turnLimited`, `PlanState.waitingNodes`, and
  `ProjectState.schedulingPaused`, with false/empty defaults and the requested clearing rules.
- The event-type enum and recording parser inherit the new event from `eventSchemas`.
  Existing v1 event payloads and recordings remain valid.

## Files

- `packages/contracts/src/events.ts`, `events.test.ts`: schemas, validation, legacy compatibility.
- `packages/contracts/src/projection.ts`, `projection.test.ts`,
  `__snapshots__/projection.test.ts.snap`: projected flags, wait clearing, immutable checkpoints,
  replay checks, and four updated golden snapshots.
- `packages/contracts/src/recording.test.ts`, `packages/contracts/README.md`: recording
  round-trip coverage and contract documentation.
- `packages/core/src/core.ts`, `guardrails.test.ts`: emission, pause/resume, structured recovery,
  legacy fallback, metadata precedence, deduplication, and causal links.
- `apps/web/src/data/describe.ts`, `describe.test.ts`: structured detection, display text,
  scheduling descriptions, tones, and provenance.
- `apps/web/src/app/App.tsx`, `Inspector.tsx`, `PlanView.tsx`: paused board banner,
  structured inspector callout, and paused waiting-node label.
- `apps/web/package.json`: run the web helper regression suite through Vitest.
- `handoffs/W2-structured-limits.result.md`: this result.

## Decisions

- Stop all emits an uncaused project event before stopping agents. Resume events link
  to the new session creation or plan approval and are emitted only when paused.
- Existing scheduling metadata is still written. Recovery gives the last valid scheduling
  event precedence, including `paused: false`; metadata is used only when no such event exists.
- Only core restart recovery interprets old guardrail wording when the structured field is
  absent. Comments explain the compatibility fallback. Projection and web detection do not
  infer guardrail state from legacy text.
- Inspector note matching selects display text only; `turnLimited` controls the callout even
  if wording changes. Worker-slot waits remain visible without note text.
- Session assignment clears a node's wait through both `session.created` and
  `plan.node_updated`. Projector checkpoints copy the mutable waiting map.
- React review: new UI conditions derive directly from projection state, the banner uses
  `role="status"`, and no new effects or duplicated state were introduced.

## Verification

`pnpm.cmd check` exited **0**: formatting, all 13 package typechecks, lint, tests,
and architecture boundaries passed. The boundary checker inspected **204 modules**.

The successful run used process-local environment settings, without repository configuration changes:

```powershell
$env:TURBO_CONCURRENCY = '1'
$env:TURBO_CACHE_DIR = Join-Path $env:TEMP 'helix-w2-turbo-cache'
pnpm.cmd check
```

Exact successful-run counts:

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| Contracts | 213 | 0 |
| Core | 137 | 0 |
| Web | 7 | 0 |
| API client | 10 | 0 |
| Testing helpers | 5 | 0 |
| CLI | 32 | 0 |
| Git | 15 | 9 |
| SCM | 56 | 1 |
| PTY host | 17 | 6 |
| Harness | 119 | 2 |
| Storage | 38 | 0 |
| Daemon | 64 | 4 |
| **Package tests** | **713** | **22** |
| Root tooling tests | 20 | 0 |
| **All tests** | **733** | **22** |

Core's count includes **23 guardrail cases**, covering emission, both resume paths,
changed-wording structured recovery, legacy text recovery, wait deduplication, causal links,
and scheduling-log precedence over stale metadata. Four golden projection snapshots were updated.
The web suite covers structured detection, display-only text lookup, missing notes, assigned
workers, paused labels, and both scheduling descriptions/tones/provenance values.

The initial unrestricted-concurrency check had one unrelated harness subprocess exceed its
existing 20-second timeout. That file passed **4/4** when rerun alone, and then passed within
the full successful serial run. No harness files or timeouts were changed. `git diff --check`
also passed. Full successful log: `%TEMP%/helix-w2-check-retry.log`.

## Known gaps

Legacy text-only events remain parseable and recoverable by core. Their text intentionally
does not set the new projection flags. No migration or rewriting of historical events is performed.
The 22 skipped cases retain their existing gates; no real-agent/GitHub opt-in run or manual
browser visual review was performed.
No commits or pushes were made. Root configuration and the lockfile were not changed.
