# W2-G — Hardening + guardrails: daemon restart recovery, process kill, error surfaces, integration suite

**Wave 2, Agent G.** Owner: Codex (`gpt-6.1-sol`, effort high).  
Do not touch: `packages/contracts/` (frozen), `apps/web/`, any file outside the owned paths below.

---

## Goal

Harden the daemon so it survives crashes and bad data, fixes the 8 findings from the Wave 1 review (`handoffs/W1.review.md`), and adds an integration test suite that runs the full demo loop end-to-end without real agents.

---

## Owned paths

```
packages/core/src/           (fix Blocker-1, Blocker-2, Should-3..6 from W1.review.md)
packages/harness/src/        (fix Blocker-1, Should-4, Should-7, Should-8 from W1.review.md)
packages/pty-host/src/       (fix Should-7, Should-8)
packages/scm/src/            (fix Should-5, Should-6)
apps/daemon/src/             (fix Host/Origin → 403, /api/harnesses cache, lenient startup reload)
apps/daemon/src/e2e.integration.test.ts   (new or extend existing)
handoffs/W2-hardening.result.md
```

---

## Acceptance criteria

### Blocker fixes (must)

**B1 — Double initial prompt**  
Core owns initial prompt delivery. Adapter `start()` establishes the session connection without sending the first message. Core sends the prompt exactly once after `start()` resolves.  
_Test:_ with a real ProcessSession + in-memory transport, a fresh session receives `['first']`, not `['first', 'first']`.

**B2 — Dependent worker starts from stale base**  
Before scheduling a dependent worker, call `git.fetchBase(repoPath, defaultBranch)` and use the returned SHA — not the local `main` ref — as the worktree base.  
_Test:_ fake Git records the base SHA passed to `create()`; assert it matches `fetchBase()` output, not the local HEAD.

### Should-fix items (at least Should-3 through Should-6 required; 7 and 8 are high-priority)

**S3 — Interrupt causal links**  
Preserve the interrupted turn's cause until its terminal boundary. Insert the interrupt message ahead of any queued message in the pending-cause list. Only activate the interrupt's cause when it starts executing.

**S4 — Harness starts next turn before core finishes snapshotting**  
Dispatch the next queued turn from _inside_ core's end-of-turn bookkeeping, after `markTurn`, diff, and push complete. The harness's `completeTurn()` must not pump the queue directly.

**S5 — External merge loses `pr.merged`**  
Accept and deduplicate `pr.merged` even after a `pr.updated` with `state: 'merged'`. Either publish `pr.merged` first in SCM, or let core handle `pr.merged` on an already-merged PR by deduplicating on `mergeSha`.

**S6 — Review repairs stop after head change**  
Re-evaluate outstanding review feedback on every head change (same condition as CI routing). Keep per-head deduplication and the 3-attempt cap.

**S7 — Windows terminal executable resolution**  
Resolve terminal executables via the same logic as chat-mode harnesses: prefer the native binary; fall back to a `.cmd` shim launched through a shell that handles quotes/metacharacters in the prompt argument.

**S8 — Stop during PTY startup leaves terminal running**  
Track PTY startup readiness. A `kill()` during startup must cancel the spawn or wait for a valid PID and terminate it. Bound cleanup to 5 seconds.

### Daemon hardening (must)

- **Lenient startup reload:** `projectUpTo(..., { strict: false })` on daemon start. Log anomalies as `explain.note` events; do not crash.
- **Host/Origin → 403:** Return `{ error: { code: 'FORBIDDEN' } }` with HTTP 403 for Host/Origin mismatches (was 400 `INVALID_REQUEST`).
- **Harness detection cache:** Cache `GET /api/harnesses` for 60 seconds; refresh in the background. First call may still be slow.
- **`repoPath` canonical key:** Lowercase on Windows for lookup; display original casing in events. Use `os.platform() === 'win32' ? path.toLowerCase() : path` as the key.

### Integration test suite (must)

Extend or create `apps/daemon/src/e2e.integration.test.ts`:
1. **Plan approval gate:** submit a plan with two parallel nodes owning non-overlapping files → `plan.submitted`; approve → `plan.approved` → two sessions created; assert no session created before approval.
2. **Overlapping files rejection:** submit a plan where two parallel nodes declare the same file glob → `INVALID_REQUEST` + `plan.validation_failed`; no `plan.submitted`.
3. **Turn cap:** configure `HELIX_MAX_TURNS=2`; run a fake harness that emits 3 idle cycles; assert session stops with an `explain.note` after turn 2.
4. **Stop-all:** create 3 sessions, call `stopAll`, assert all are exited.
5. **Restart recovery:** write a corrupt JSON line into the SQLite events table; restart the daemon (in-process re-init); assert it starts successfully and subsequent `listProjects()` works.
6. **Replay determinism (smoke):** load the fixture from `W2-recorder` and assert `project(events)` is stable across two projections of the same event list.

All integration tests use fake harnesses and an in-memory (or temp-dir) SQLite. No real agents. No real GitHub. Gate the GitHub E2E behind `HELIX_E2E=1 HELIX_E2E_GITHUB=1` as before.

---

## Test command

```bash
pnpm --filter @helix/core test
pnpm --filter @helix/harness test
pnpm --filter @helix/pty-host test
pnpm --filter @helix/scm test
pnpm --filter @helix/daemon test
```

All must pass on Ubuntu and Windows.

---

## Windows gotchas

- Process-tree kill: the existing Windows job-object logic in `packages/harness/src/process.ts` is correct; do not regress it. Only add the startup-race guard.
- PTY PID `0` race: the ConPTY path can expose PID `0` until the async connection fires. Track readiness with a promise.

---

## Result file format

Write `handoffs/W2-hardening.result.md` with:
- Summary.
- Files changed.
- Which W1-review findings are fixed vs deferred, and why.
- Decisions.
- Contract-change requests.
- Gaps.
