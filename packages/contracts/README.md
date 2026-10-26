# @helix/contracts — v1 with Wave 2 plan contracts

Browser-safe shared contracts for the Helix daemon, CLI, adapters, UI and offline
replay. Import only `@helix/contracts`; fixtures are the `fixtures` namespace on
that entry. No workspace dependencies, I/O, clock reads, or random ID generation.

```ts
import { fixtures, parseEvent, projectUpTo, deriveStatus } from '@helix/contracts';

const result = parseEvent(fixtures.passwordResetRun[0]);
if (result.success) console.log(result.data.type);
const state = projectUpTo(fixtures.passwordResetRun, 44);
const api = state.sessions[fixtures.passwordResetIds.api];
if (api) console.log(deriveStatus(api)); // merged
```

## Public API

- Contract generation: `HELIX_CONTRACTS_VERSION = 1`.
- IDs: `ProjectId`, `SessionId`, `PlanId`, `PlanNodeId`, `ApprovalId`, `EventSeq`,
  `PullRequestNumber`, and corresponding lower-camel `*Schema` validators.
- Entities and schemas: `Project`, `KnownAgentKind`, `AgentKind`, `SessionRole`,
  `SessionInterface`, `Session`, `AgentActivity`, `PullRequestFacts`, `CheckSummary`,
  `ReviewSummary`, `Plan`, `PlanNode`, `PlanStatus`, `Approval`, `ApprovalDecision`, `ChatItem`.
  Shared validators: `timestampSchema`, `countSchema`, `planNodesSchema`.
- Events: `EventType`, `HelixEvent<T = EventType>`, `PayloadFor<T>`,
  `UnsequencedEvent`, `ParseEventResult`, `eventTypeSchema`, `eventSchemas`,
  `helixEventSchema`, `parseEvent`, `isEventOf`.
- Projection/status: `ProjectState`, `SessionState`, `Worktree`, `WorktreeState`,
  `applyEvent`, `projectUpTo`, `createProjector`, `Projector`, `ProjectionOptions`,
  `Anomaly`, `DisplayStatus`, `BoardColumn`, their schemas,
  `deriveStatus`, `boardColumn`, `whyChain`, `rationaleFor`.
- HTTP/transport: `routes`, `RouteName`, `toJsonSchema`, `routeJsonSchemas`,
  `sse`, `backfill`, `HarnessInfo`, `HealthResponse`, `HarnessesResponse`,
  `ProjectsResponse`, `CreateProjectRequest`, `CreateSessionRequest`,
  `MessageMode`, `SendMessageRequest`, `ApprovalDecisionRequest`,
  `SubmitPlanRequest`, `PlanDecisionRequest`, `PlanDecisionResponse`, `ExplainRequest`, `AcceptedResponse`, `MergeResponse`,
  `DiffScope`, `DiffFile`, `DiffResponse`, `EventsResponse`, `EventsQuery`,
  `SseQuery`, `SseMessage`, `TerminalInput`, `TerminalOutput`, `TerminalMessage`,
  `ErrorCode`, `ApiError`, `RecordingImportRequest`, `RecordingImportResponse`,
  and corresponding schemas; `cursorStringSchema`, `idempotencyHeadersSchema`,
  `sseHeadersSchema`.
- Adapters (types only): `Unsubscribe`, `HarnessEmissionType`, `HarnessEmission`,
  `HarnessStartOptions`, `AgentHarness`, `HarnessSession`, `WorktreeManager`,
  `OpenPrOptions`, `MergePrOptions`, `ScmEmissionType`, `ScmEmission`,
  `ScmObserver`, `EventStore`.
- Recording: `HelixlogHeader`, `Helixlog`, `HelixlogParseResult`,
  `helixlogHeaderSchema`, `helixlogSchema`, `parseHelixlog`, `serializeHelixlog`.
- `fixtures`: `passwordResetRun`, `passwordResetProject`, `passwordResetPlan`,
  `passwordResetIds`, `passwordResetMilestones`.

## Status precedence

First matching rule wins. The agent's active repair takes precedence over a
failed check or requested changes. A failed activity probe is `unknown`, not exit.

| Priority | Condition                                                                                                      | Status            | Board column   |
| -------- | -------------------------------------------------------------------------------------------------------------- | ----------------- | -------------- |
| 1        | Session archived                                                                                               | archived          | archive        |
| 2        | PR merged                                                                                                      | merged            | archive        |
| 3        | Pending approval, waiting_input, or blocked                                                                    | needs_you         | needs_you      |
| 4        | active or starting                                                                                             | working           | working        |
| 5        | Open PR with failed checks                                                                                     | ci_failed         | in_review      |
| 6        | Open PR with changes_requested review                                                                          | changes_requested | in_review      |
| 7        | Open non-draft PR, total > 0, all passed, none pending, approved/none review, no unresolved threads, mergeable | ready_to_merge    | ready_to_merge |
| 8        | Other open PR                                                                                                  | in_review         | in_review      |
| 9        | exited without open PR                                                                                         | exited            | archive        |
| 10       | Everything else, including unknown without PR                                                                  | pending           | pending        |

`plans[*].nodeStatus` is a recomputed projection cache, never an event or persisted
source of truth. Draft PRs and unresolved review threads block readiness, so an
otherwise ready PR remains `in_review` until both gates clear.

## Event and replay decisions

### Wave 2 plans and metadata

- New submissions require `files: string[]` on every node. Entries are positive,
  slash-separated repository-relative globs, such as `src/api/**`. Absolute paths,
  backslashes, empty path segments, `.`/`..` segments, control characters and
  leading negation are rejected. An empty array declares no file ownership; it
  must never be interpreted as unrestricted access. Overlap analysis and worker
  enforcement belong to core (#4), not this schema.
- Stored v1 plans without `files` still parse, normalizing missing declarations to
  `[]`. This is replay compatibility, not evidence of permission to edit files.
  Existing plan IDs, event sequences and causal links remain intact.
- `PlanState.status` starts at `awaiting_approval`. A `plan.approved` event carries
  `{ planId, approvedBy: 'human' }`; `plan.rejected` carries `{ planId, reason }`.
  The projector records `decidedAt` plus `approvedBy` or `rejectionReason`, and
  adds a plan-update entry to the orchestrator's chat. It does not start workers
  or infer approval from worker activity. Legacy plans without decision events
  remain awaiting approval, even when their historical workers are present.
- Decision events require an existing plan in the same project. If an envelope
  session is supplied, it must be the plan's orchestrator. Duplicate or conflicting
  decision events are anomalies (or errors in strict mode), never state reversals.
  Command handlers must make identical retries idempotent without appending twice.
- `routes.decidePlan` defines `POST /api/plans/:id/decision`, with request
  `{ decision: 'approve' | 'reject', reason?: string }` and response
  `{ planId, status: 'approved' | 'rejected' }`. A supplied reason must be nonblank;
  rejection without one records `Rejected by human`. `HelixCore.decidePlan` is
  the corresponding domain seam. The server must establish human authorization;
  the literal in the event is a provenance assertion, not authentication.
- `HelixStore` now includes `MetaStore`: `getMeta(scope, key)` returns a JSON
  `MetaValue` or `undefined` for a missing key; `setMeta(scope, key, value)`
  atomically replaces a value. `null` is a stored value, not deletion. Values
  must survive restart, remain isolated by scope/key, and not alias caller objects.
  Metadata emits no events and is excluded from recordings. This is distinct from
  immutable `remember`/`recall` command responses. Core's migration of resume
  tokens and delivery receipts to this seam is #4 work.

The golden fixture submits its plan at sequence 5 and records human approval at
sequence 6, before worker creation. Later sequence numbers and causal links are
unchanged; the fixture's file declarations are disjoint for concurrent workers.

### Common event rules

- IDs are branded at parsing boundaries. String IDs accept 1–64 characters;
  numeric IDs are positive safe integers. Sequence cursors may be zero. SHA fields
  are nonempty strings so adapters are not coupled to one Git hash length.
- `AgentKind` accepts future nonempty strings. `knownAgentKindSchema` lists current
  capabilities. Consumers must use capability detection and a fallback label for
  an unknown agent; widening this list does not invalidate older readers.
- Schemas reject unknown object fields except HTTP headers. UTC timestamps require
  `Z`. Event payload versions other than `v: 1` are rejected.
- `eventSchemas[type]` validates a full envelope;
  `eventSchemas[type].shape.payload` validates its payload. `parseEvent` returns
  Zod's `{ success, data | error }` result. `isEventOf` narrows already-typed events.
- Lifecycle payloads: `project.added: {project}`, `session.created: {session}`,
  `session.started: {}`, `session.archived: {}`, `session.exited: {code, signal?}`.
  A null exit code means no numeric exit code was available. Start changes activity
  to `starting`; a separate activity event reports `active`.
- Chat tool calls use `inputSummary`, `outputSummary?`, and
  `status: pending | running | succeeded | failed`. `plan_update` carries
  `{planId, nodeId?, text}`. Questions carry string options. These are summaries,
  not raw tool input/output or hidden reasoning.
- `applyEvent` requires one project's history beginning with `project.added`.
  By default it skips invalid payloads, missing references and duplicate/reversed
  seqs, appending `{seq, type, reason}` to `state.anomalies` (newest 100 retained).
  References are validated before mutation, so skipped events have no partial
  effects. `lastSeq` advances past a rejected event without ever moving backward.
  Pass `{strict:true}` to `applyEvent`, `projectUpTo`, or `createProjector` for
  fail-fast behavior. Missing genesis, mismatched project genesis and mixed
  projects always throw: no valid project state can represent those inputs.
  Global daemon seq gaps are valid. `projectUpTo` sorts a copy and includes events
  through the cursor. Select a project before replaying a global SSE stream.
- Events changing a session's activity, chat, worktree or PR need `sessionId` for
  projection. Approval and plan events can resolve ownership from their payloads.
  Envelope validation is structural; referential integrity requires prior history.
- New sessions have `unknown` activity. Unstarted plan nodes show `pending`.
  Session creation and `plan.node_updated` associate sessions with plan nodes.
  `reasoning.summary`, approvals, routed feedback, plan updates and explain notes
  appear in projected chat. Emit these semantic events once; emitting an additional
  equivalent `chat.item` intentionally produces another chat entry.
  An `explain.note` with only a `planNodeId` attaches to that plan's orchestrator
  chat as a `plan_update` carrying the node ID.
- Approval decisions clear the pending ID and use event time for `decidedAt`.
  They do not imply that a waiting/blocked agent resumed: emit `activity.changed`.
  PR merges preserve branch `headSha`; `mergeSha` remains in the event log.
- No input events or prior states are mutated. `applyEvent` clones state once;
  `projectUpTo` folds into one internal mutable state without repeatedly cloning
  growing chat history. Each event is parsed once during a full replay.
  Terminal bytes are excluded; markers update last-event position only.
- `createProjector(events)` eagerly validates and snapshots the supplied history,
  caching checkpoints every 100 event positions (not numeric sequence values).
  `at(seq)` binary-searches the cursor and folds at most 99 events. Shared immutable
  history avoids deep-copying every chat item at every checkpoint or lookup.
  Returned states are deeply frozen in all environments and must be treated as
  read-only. Holding an earlier result is safe across later lookups. The projector
  is a snapshot, not a live subscription; rebuild it when history changes. Strict
  mode validates the entire supplied history during construction.
- `whyChain` returns target first, then parents, including the root; it stops at a
  missing parent, cycle or 50 events. `rationaleFor` returns undefined if absent.
- Check counts partition total; SCM adapters normalize skipped/neutral checks as
  passed. Plan submission validates unique node IDs,
  unique/known dependencies, and an acyclic graph. These semantic checks require
  Zod in addition to the generated structural JSON Schema.

## HTTP and adapter decisions

- The route table contains 18 entries with method/path, request/response schemas,
  success status, and params/query/headers where applicable. No-body HTTP requests
  normalize to `{}`. Every failure uses `apiErrorSchema`.
- Health returns `{status:'ok', version}`; `/api/harnesses` returns the harness
  array. Create operations return the created entity. Message/stop return
  `{accepted:true}` with 202. Archive/approval return the updated entity. Merge
  returns `{mergeSha}`. Explain returns the appended `explain.note` envelope.
- Query/header values are wire strings. Headers must be normalized to lowercase.
  Session creation requires `idempotency-key`; the daemon owns key scoping,
  retention, and request fingerprint validation.
- Backfill `since` is exclusive (default 0), `limit` defaults to 100 with max 1000.
  `lastSeq` means the final returned event seq, or requested since for an empty
  page. It is not the daemon high-water mark; this prevents skipped pages.
- SSE is `/api/events`, optionally filtered by `projectId`, with `since` fallback.
  `Last-Event-ID` takes precedence. Frames use `id: <seq>`, `event: helix`, and
  JSON event data; a comment heartbeat is sent every 15 seconds. `sseMessageSchema`
  describes a decoded frame and validates id/data agreement.
- Diff scope is required; a diff contains `unifiedDiff` and file entries with path,
  optional oldPath, status, insertions/deletions, and binary flag.
- WebSocket `/mux?sessionId=` has separate input and output unions. Data is UTF-8
  text, including terminal escape sequences. Resize dimensions are positive
  integers; exit code may be null when unavailable.
- `routeJsonSchemas()` generates JSON Schema draft 2020-12 via Zod's native export.
  Refinements (count sums, DAGs, SSE id equality, cursor numeric bounds) are not
  representable there; handlers must also validate with the Zod schemas.
- `HarnessEmission` and `ScmEmission` carry `{type,payload}` without sequence,
  clock or storage concerns. The daemon supplies envelope metadata. `watch` keeps
  the two required arguments and accepts an optional event callback.
- `EventStore.append` uses a distributive `UnsequencedEvent` rather than plain
  `Omit<HelixEvent,'seq'>` to retain discriminant/payload correlation. Append is
  atomic. Subscribe catches up and switches to live delivery without gaps.
- Worktree removal's only force option is the literal `false`, and adapters must
  reject dirty tracked, staged and untracked files. SCM merge uses expectedHeadSha
  to guard against merging a branch that changed after validation.

## Recordings

Import/export bodies use raw UTF-8 JSON Lines (`application/x-helixlog`). The first
line is the header; later lines are events. `parseHelixlog` is nonthrowing and
reports a one-based line on failure. CRLF, a BOM, and an optional trailing newline
are supported. Blank interior lines are rejected. A recording requires matching
project genesis and increasing project-local event subsequences; gaps are valid.
`serializeHelixlog({header, events})` validates and writes one trailing newline.
It throws ZodError for invalid input. Neither function performs redaction or I/O.
Imported recordings are replay-only and preserve original IDs, seqs and causal
links. They must never be appended to the live daemon log or remapped on import.

## Verification and integration

Run from the workspace root:

```sh
pnpm --filter @helix/contracts typecheck
pnpm --filter @helix/contracts test
pnpm format
pnpm check
```

On this Windows host, use `pnpm.cmd` because PowerShell script execution is
disabled. The package inherits the scaffold's strict TypeScript settings, including
`exactOptionalPropertyTypes`. Tests and snapshots live under `src` and run through
the root Vitest projects. Standalone Vitest, ignore and pnpm store configurations
have been removed; the shared scaffold owns tooling and dependencies.

Pinned versions: Zod 4.6.5 (2026-09-13), TypeScript 5.9.3 (2025-09-30),
Vitest 4.1.11 (2026-08-18), verified against npm publication metadata on
2026-10-20. Native JSON Schema export avoids a second runtime dependency.

Tests cover every event payload, malformed envelopes, 57 precedence rows, all
column mappings, four compact state snapshots, all-prefix live/replay equality,
immutability, causality cycles/depth, recording errors and round trips, transport
validation, JSON Schema generation, and source import boundaries. The import
boundary check is the brief's grep-test alternative, not a real browser bundle.
Snapshots retain board, chat, PR, worktree, approval and plan status facts.
Checkpoint tests cover boundary cursors, sequence gaps, held-result immutability,
anomaly recovery and a seeded 200-lookup benchmark over 5,000 events (under 1 second).

No adapter, network, storage, process management or actual redaction is implemented
in this pure contracts package.

## Review questions before freezing

Draft/thread gating, skipped/neutral checks and replay-only imports are resolved
by Claude's fix-round-1 review. Confirm the remaining chosen health/lifecycle/chat
shapes, success responses, paging semantics, and plan graph validation before the
downstream agents depend on them.
