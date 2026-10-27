# W2-E — Orchestrator agent: `helix` CLI + plan approval gate

**Wave 2, Agent E.** Owner: Codex (`gpt-6.1-sol`, effort high).  
Do not touch: `packages/contracts/` (frozen after Claude lands W2 contract changes), `apps/web/`, `apps/daemon/src/server.ts`, any file outside the owned paths below.

---

## Goal

Implement the `helix` CLI that the orchestrator agent uses, and add the **plan approval gate** to core: _nothing spawns until `plan.approved` is emitted_.

---

## Owned paths

```
packages/core/src/           (orchestrator wiring, plan gate, scheduling, guardrails)
apps/cli/src/                (helix CLI binary)
handoffs/W2-orchestrator.result.md
```

---

## Acceptance criteria

1. `POST /api/plans` succeeds and emits `plan.submitted`; no worker session is spawned yet.
2. `POST /api/plans/:id/decision` with `{ decision: "approved" }` emits `plan.approved` and then begins spawning workers in dependency order (roots first; dependents only after their prerequisite sessions have merged).
3. `POST /api/plans/:id/decision` with `{ decision: "rejected" }` emits `plan.rejected` and spawns nothing.
4. Plan submission fails with `INVALID_REQUEST` + a `plan.validation_failed` event when two parallel nodes declare overlapping `files` globs. Serialize-or-dedicate is the caller's responsibility — rejection is the gate.
5. Dependent workers start from a freshly fetched `origin/<defaultBranch>` SHA (not local `main`) so they always include merged prerequisites.
6. `helix` CLI binary is callable from an agent's working directory:
   - `helix plan submit <plan.json>` → `POST /api/plans`; prints the plan id; exits non-zero on error.
   - `helix spawn <planNodeId>` → `POST /api/projects/:id/sessions` with the node's config; prints session id.
   - `helix send <sessionId> <message>` → `POST /api/sessions/:id/messages`; mode=queue by default; `--interrupt` flag for interrupt.
   - `helix status <sessionId>` → derived status from the latest project events for that session.
   - `helix explain "<text>" [--caused-by <seq>]` → `POST /api/explain`.
   - `helix stop-all` → `POST /api/projects/:id/stop-all`.
   - All commands read `HELIX_DAEMON_URL` (default `http://localhost:4317`) and `HELIX_PROJECT_ID` from the environment.
7. Turn cap guardrail: a session that completes more than 20 agent turns (configurable via `HELIX_MAX_TURNS`) is stopped and surfaced as a `session.exited` + `explain.note` with reason "turn cap reached".
8. Max parallel workers guardrail: no more than 4 worker sessions run at once across a project (configurable via `HELIX_MAX_WORKERS`); excess nodes stay pending until a slot opens.
9. `pnpm check` passes (format, typecheck, lint, boundaries, all tests) on both Ubuntu and Windows.

---

## Contracts to implement (already in `packages/contracts`)

| Contract | Where |
|---|---|
| `decidePlan` route (`POST /api/plans/:id/decision`) | daemon route → `core.decidePlan()` |
| `plan.approved`, `plan.rejected`, `plan.validation_failed` events | emitted from `core.decidePlan()` / `core.submitPlan()` |
| `PlanNode.files` glob array | validated in `submitPlan` for overlaps |
| `stopAll` route (`POST /api/projects/:id/stop-all`) | daemon route → `core.stopAll()` |
| `MetaStore` (via `HelixStore`) | use for storing resume tokens / delivery receipts (replacing the `IdempotencyStore` workaround) |

---

## Key behaviours to preserve (do not regress)

- Status is never stored — `deriveStatus(facts)` is the only path.
- Dirty worktrees are never force-deleted.
- Replay determinism: live UI state at t == replayed UI state at t.
- No merge without a human click (merge still comes through `POST /api/sessions/:id/merge`).
- Append-only event store — no event mutations.

---

## Fakes for missing neighbours

- Use the existing `FakeCore` in `apps/daemon/src/testing/fake-core.ts` for CLI integration tests.
- For the plan gate tests, use an in-memory `HelixStore` (already in `packages/storage/src/index.ts` behind the test export).

---

## Test command

```bash
pnpm --filter @helix/core test
pnpm --filter @helix/cli test
```

---

## Windows gotchas

- CLI shebang: use `#!/usr/bin/env node` and ship a `helix.cmd` wrapper via the `bin` field in `package.json` so `helix` resolves without `.cmd` on Windows.
- Path separators: always use `path.posix` / forward slashes in glob comparisons.

---

## Result file format

Write `handoffs/W2-orchestrator.result.md` with:
- Summary (2–3 sentences).
- Files changed (list).
- Decisions made (any schema or behaviour choices).
- Contract-change requests (new additions you need Claude to approve — do NOT edit contracts directly).
- Gaps / known issues.
