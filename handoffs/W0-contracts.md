# W0-contracts — Shared contracts for Helix (draft v1)

You are Codex working on **Helix**. Read `docs/PLAN.md` §1–3 and `docs/PRD.html` (requirements section) first. The monorepo scaffold already exists; `pnpm check` must keep passing.

## Goal
Fill `packages/contracts` with the **single source of truth** every other package and the UI build against. Seven Codex agents and the UI will work in parallel against these types next, so precision matters more than breadth. Claude will review and freeze this as **contracts v1**.

Use **zod** (pin exact version) for runtime schemas; export inferred TS types. Generate JSON Schema for the REST layer with `zod-to-json-schema` (or zod's native JSON Schema export if the pinned version has it). No other runtime dependencies. No I/O, no Node-only APIs — this package must run in the browser too.

## Owned paths
`packages/contracts/**` only (plus your result file). Do not touch anything else.

## Required modules (`packages/contracts/src/`)

### 1. `ids.ts`
Branded string IDs: `ProjectId`, `SessionId`, `PlanId`, `PlanNodeId`, `EventSeq` (number), `ApprovalId`, `PullRequestNumber`. ULID-style string IDs (validate format loosely: non-empty, max 64). Helper `newId(prefix)` is NOT here (contracts stays pure) — only schemas.

### 2. `entities.ts`
- `Project` { id, name, repoPath, defaultBranch, github?: { owner, repo }, defaultAgent: AgentKind, createdAt }
- `AgentKind` = `'claude-code' | 'codex'` (extensible enum; design so adding a value is non-breaking)
- `SessionRole` = `'worker' | 'orchestrator' | 'reviewer'`
- `Session` { id, projectId, role, agent: AgentKind, model?, title, prompt, branch?, worktreePath?, planNodeId?, parentSessionId?, **variantOf?: SessionId** (reserved for bake-off; unused in MVP), interface: `'chat' | 'terminal'`, createdAt, archivedAt? }
- `AgentActivity` = `'starting' | 'active' | 'idle' | 'waiting_input' | 'blocked' | 'exited' | 'unknown'` — `unknown` is a first-class state (a failed probe is not death).
- `PullRequestFacts` { number, url, state: `'open'|'closed'|'merged'`, draft, headSha, mergeable: `'mergeable'|'conflicting'|'unknown'`, checks: CheckSummary, review: ReviewSummary, updatedAt }
- `CheckSummary` { total, passed, failed, pending, failingNames: string[] }
- `ReviewSummary` { decision: `'approved'|'changes_requested'|'review_required'|'none'`, unresolvedThreads: number }
- `Plan` { id, projectId, orchestratorSessionId, goal, nodes: PlanNode[], createdAt }
- `PlanNode` { id, title, description, acceptance: string[], dependsOn: PlanNodeId[], agent: AgentKind, rationale: string, sessionId? }
- `Approval` { id, sessionId, kind: `'command'|'file_write'|'migration'|'network'|'other'`, summary, detail, scope: `'once'|'session'`, requestedAt, decision?: `'approved'|'rejected'|'changes_requested'`, decidedAt? }
- `ChatItem` discriminated union on `kind`: `message` {role: user|assistant|system, text}, `tool_call` {tool, input summary, output summary?, status}, `plan_update`, `approval` (ref ApprovalId), `question` {prompt, options?}, `reasoning_summary` {text}.

### 3. `events.ts` — the core
Envelope:
```ts
HelixEvent<T extends EventType> = {
  seq: number;            // monotonic per daemon, assigned by storage; starts at 1
  ts: string;             // ISO-8601 UTC
  projectId: ProjectId;
  sessionId?: SessionId;
  planNodeId?: PlanNodeId;
  causedBy?: number;      // seq of the event that caused this one — powers the Why panel
  type: T;
  payload: PayloadFor<T>;
  v: 1;                   // schema version of the payload
}
```
Event types (each with a precise zod payload schema):
`project.added`, `session.created`, `session.started`, `session.exited`, `session.archived`, `activity.changed` {activity}, `chat.item` {item: ChatItem}, `approval.requested` {approval}, `approval.decided` {approvalId, decision}, `reasoning.summary` {text, source: 'agent'|'orchestrator'}, `plan.submitted` {plan}, `plan.node_updated` {nodeId, sessionId?, note?}, `explain.note` {text} (free-form "why" from the orchestrator via `helix explain`), `worktree.created` {branch, path, baseSha}, `worktree.diff_updated` {filesChanged, insertions, deletions}, `pr.opened` {pr}, `pr.updated` {pr}, `ci.updated` {prNumber, checks}, `review.updated` {prNumber, review}, `feedback.routed` {prNumber, reason: 'ci_failed'|'changes_requested'|'merge_conflict', summary, toSessionId}, `pr.merged` {prNumber, mergeSha}, `terminal.output_marker` {bytesOffset} (terminal bytes are NOT events; this only marks positions for replay alignment).

Export: `EventType` union, `eventSchemas` map, `parseEvent(unknown)` returning a typed result (no throw), `isEventOf(type)` guard.

### 4. `projection.ts` — UI state is a pure function of events
```ts
type ProjectState = {
  project: Project;
  sessions: Record<SessionId, SessionState>;
  plans: Record<PlanId, Plan & { nodeStatus: Record<PlanNodeId, DisplayStatus> }>;
  approvals: Record<ApprovalId, Approval>;
  lastSeq: number;
};
type SessionState = { session: Session; activity: AgentActivity; pr?: PullRequestFacts; worktree?: {...}; chat: ChatItem[]; lastEventSeq: number; pendingApprovalIds: ApprovalId[] };
function applyEvent(state: ProjectState | undefined, e: HelixEvent): ProjectState   // pure, immutable
function projectUpTo(events: HelixEvent[], seq: number): ProjectState                  // used by live view, scrubber, replay
```
Must be **deterministic** and **pure** (no Date.now, no randomness) — the timeline scrubber and demo mode depend on `projectUpTo(events, t)` producing identical state live and in replay.

### 5. `status.ts` — derived display status (never stored)
```ts
type DisplayStatus = 'pending' | 'working' | 'needs_you' | 'ci_failed' | 'changes_requested' | 'in_review' | 'ready_to_merge' | 'merged' | 'exited' | 'archived';
function deriveStatus(s: SessionState): DisplayStatus;
type BoardColumn = 'pending' | 'working' | 'needs_you' | 'in_review' | 'ready_to_merge' | 'archive';
function boardColumn(status: DisplayStatus): BoardColumn;
```
Status precedence (highest first):
1. `archived` — session archived
2. `merged` — PR merged
3. `needs_you` — any pending approval, or activity `waiting_input` / `blocked`
4. `working` — activity `active` or `starting` (this wins over CI/review failures: the agent is fixing them)
5. `ci_failed` — open PR with ≥1 failed check
6. `changes_requested` — open PR with review decision `changes_requested`
7. `ready_to_merge` — open PR, all checks passed (total > 0, pending = 0), review `approved` or `none`, mergeable = `mergeable`
8. `in_review` — any other open PR
9. `exited` — activity `exited` and no open PR
10. `pending` — everything else (including activity `unknown` with no PR)

Column mapping: `pending`→pending · `working`→working · `needs_you`→needs_you · `ci_failed`, `changes_requested`, `in_review`→in_review (the card label shows the failure; Helix routes the fix automatically) · `ready_to_merge`→ready_to_merge · `merged`, `exited`, `archived`→archive.

Document this in a comment and prove it with an **exhaustive table test** (`status.test.ts`, ≥ 25 rows covering every rule, every tie-break, and the `unknown` activity case).

### 6. `causality.ts`
`whyChain(events, seq): HelixEvent[]` — follows `causedBy` back to the root (cycle-safe, max depth 50). `rationaleFor(state, planNodeId)`.

### 7. `api.ts` — REST + SSE contract
Routes (request/response zod schemas + an exported `routes` table with method, path, schemas):
- `GET /api/health`, `GET /api/harnesses` → [{agent, installed, version?, signedIn?: boolean|'unknown'}]
- `GET /api/projects`, `POST /api/projects` {repoPath, name?}
- `GET /api/projects/:id/events?since=<seq>&limit=` → { events, lastSeq } (paged backfill)
- `GET /api/events` — SSE; each message `id: <seq>`, `event: helix`, `data: HelixEvent`; supports `Last-Event-ID`; heartbeat comment every 15 s
- `POST /api/projects/:id/sessions` {title, prompt, agent, model?, interface, planWithOrchestrator?: boolean} (header `Idempotency-Key` required)
- `POST /api/sessions/:id/messages` {text, mode: 'queue'|'interrupt'}
- `POST /api/sessions/:id/stop`, `POST /api/sessions/:id/archive`
- `POST /api/approvals/:id/decision` {decision}
- `GET /api/sessions/:id/diff?scope=workspace|pr|last_turn` → unified diff + file list
- `POST /api/sessions/:id/merge`
- `POST /api/plans` (used by `helix plan submit`) {projectId, orchestratorSessionId, goal, nodes}
- `POST /api/explain` {sessionId, planNodeId?, text, causedBy?}
- `GET /api/recordings/:projectId/export` → `.helixlog`; `POST /api/recordings/import`
- Terminal: `GET /mux?sessionId=` WebSocket — message schemas `{t:'in', data}`, `{t:'resize', cols, rows}`, `{t:'out', data}`, `{t:'exit', code}`
Error shape `{ error: { code: ErrorCode, message, details? } }` with an `ErrorCode` enum.

### 8. `interfaces.ts` — adapter interfaces (types only)
- `AgentHarness` { kind; detect(): Promise<HarnessInfo>; start(opts): Promise<HarnessSession>; } and `HarnessSession` { send(text, mode); interrupt(); stop(); onEvent(cb: (e: HarnessEmission) => void): Unsubscribe; resumeToken?: string } where `HarnessEmission` maps cleanly onto `chat.item` / `activity.changed` / `reasoning.summary` / `approval.requested`.
- `WorktreeManager` { create(projectId, sessionId, base): Promise<Worktree>; diff(path, scope); status(path) → {dirty: boolean}; remove(path, {force:false}) — must refuse dirty }
- `ScmObserver` { watch(project, prNumber): Unsubscribe; openPr(...); merge(...); }
- `EventStore` { append(events: Omit<HelixEvent,'seq'>[]): Promise<HelixEvent[]>; read(projectId, sinceSeq, limit); subscribe(sinceSeq, cb) }

### 9. `recording.ts`
`.helixlog` format: JSON Lines; first line `{format:'helixlog', version:1, project, recordedAt, redactions: string[]}`, then one `HelixEvent` per line. Schemas + `parseHelixlog(text)` / `serializeHelixlog(...)` (pure string functions).

### 10. `fixtures/` (exported as `@helix/contracts/fixtures`? — NO deep imports allowed; export from the main entry as `fixtures` namespace)
One realistic golden event stream, `passwordResetRun`, ~40 events: orchestrator plans "Add password reset" into 3 nodes (API by codex, form UI by claude-code, E2E tests depending on both); API PR fails CI on `token.test.ts` → `feedback.routed` (causedBy the ci event) → fix → pass; UI raises a migration approval → approved; both merge; E2E starts. Every follow-up event carries a correct `causedBy`. This is what the UI is built against before the backend exists and what replay tests use — make it read like a real run (real-looking titles, branches `helix/reset-api`, check names, plausible ISO timestamps spaced over ~40 minutes).

### 11. `index.ts`
Re-export everything from a single entry point.

## Tests (Vitest, in this package)
- Every event payload schema: one valid + one invalid sample.
- `status.test.ts` exhaustive table (see §5).
- `projection.test.ts`: `projectUpTo(passwordResetRun, n)` snapshots at 4 interesting seqs; determinism (same input → deep-equal output twice); immutability (input array and earlier states unmodified).
- `causality.test.ts`: why-chain for the CI fix event returns [fix, feedback.routed, ci.updated, pr.opened, …, plan.submitted]; cycle safety.
- `recording.test.ts`: round-trip serialize → parse equals original.

## Acceptance criteria
1. `pnpm check` passes at the root.
2. `packages/contracts` imports nothing from the workspace and nothing Node-specific (verify it bundles for the browser: add a test that imports the entry under `environment: 'happy-dom'` or simply assert no `node:` imports via a grep test).
3. All types are exported from `@helix/contracts`; no `any` in public types.
4. The golden fixture passes `parseEvent` for every event and produces the expected final board: API merged, UI merged, E2E working.

## Commit
Commit on the current branch in logical commits, messages prefixed `[codex W0-contracts]`. Do not push.

## Result file
Final message = markdown report: **Summary**, **Public API overview** (exports list), **Status precedence table**, **Decisions** (anything not specified here), **Open questions for Claude** (anything you think the contract gets wrong), **Verification** (commands + outcomes), **Known gaps**.
