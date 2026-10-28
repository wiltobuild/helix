# W2: structured guardrail state (follow-up to #9 / #29)

Branch `agent/29-stop-all-button-and-visible-turn-cap-wor` (PR #30), already on top of `main`.

Today the #9 guardrail states exist **only as note text**:
- Core emits "Turn limit reached (…)" / "Turn allowance extended to …" `explain.note`s and "Waiting: N of M worker slots…" `plan.node_updated` notes.
- Core's restart recovery matches those strings (`packages/core/src/core.ts`: `'Turn limit reached ('`, `note?.startsWith('Waiting: ')`).
- The UI matches them too (`apps/web/src/data/describe.ts`: `TURN_LIMIT_PREFIX`, `SLOT_WAIT_PREFIX`, `turnLimitNote`, `slotWaitNote`, `slotWaiting`).
- The stop-all scheduling pause lives only in core metadata (`SCHEDULING_SCOPE`), so the UI can't see it.

Make these states **structured**, and make every consumer read the structure.

Read `CLAUDE.md`, `packages/contracts/src/events.ts`, `projection.ts`, `packages/core/src/core.ts` (turn limit, schedule, stopAll, reload), `apps/web/src/data/describe.ts`, `apps/web/src/app/{App,Inspector,PlanView,StopAll}.tsx` first.

**Owned paths:**
- `packages/contracts/**`, including fixtures and snapshots
- `packages/core/**`
- `apps/web/**`
- `apps/daemon/src/**/*.test.ts`, only if a fixture needs it
- `handoffs/W2-structured-limits.result.md`

No root config or lockfile changes. You cannot commit or push.

## Required

### 1. Contracts (additive, legacy events stay valid)
- **`explain.note`:** add optional `code: 'turn_limit_reached' | 'turn_limit_extended'`.
- **`plan.node_updated`:** add optional `waiting: 'worker_slot'`. Present means "this node is held back by the parallel-worker limit"; a later update without it clears the state.
- **New event `scheduling.changed`**, payload `{ paused: boolean }`, project-level with no session. Add it to `eventSchemas`, to the event-type list, and everywhere the code switches exhaustively over event types (projection, `describe.ts` `eventTone` / `describeEvent` / `provenance`, recordings, etc.).
- **Projection:**
  - `SessionState.turnLimited: boolean`. Set it on an `explain.note` with `code: 'turn_limit_reached'`. Clear it on `code: 'turn_limit_extended'`, on a user `chat.item` message, and on `activity.changed: 'active'`. Default `false`.
  - `PlanState.waitingNodes: Record<PlanNodeId, 'worker_slot'>`. Set it from `plan.node_updated` with `waiting`. Remove the entry on a later update for that node without `waiting`, or when the node gets a `sessionId`.
  - `ProjectState.schedulingPaused: boolean`, from `scheduling.changed`. Default `false`.
  - Update projection tests and the golden snapshot.

### 2. Core
- **Emit the structure.** Put `code: 'turn_limit_reached'` on the turn-limit note, `code: 'turn_limit_extended'` on the extension note, and `waiting: 'worker_slot'` on the slot-wait `plan.node_updated`. Keep the human-readable text exactly as it is.
- **stopAll** emits `scheduling.changed { paused: true }`, caused by nothing (it's a human command). Resuming, by approving a plan or creating a session, emits `{ paused: false }` when it was paused. Keep writing the existing metadata, so older stores still recover.
- **Restart recovery reads the structure:** `cappedDeliveries` from `code`, `waitingNodes` from `waiting`, `pausedProjects` from the last `scheduling.changed` (falling back to the metadata when the log has none). Keep the old **text matching only as a fallback** for events without the new fields, with a comment saying why.
- **Tests:**
  - the new fields are emitted
  - the pause and resume events
  - recovery from structured events
  - recovery from legacy text-only events still works

### 3. Web
- **Replace the text-matching helpers in `describe.ts`.**
  - `turnLimitNote(s)` becomes: is `s.turnLimited` set? Keep showing the latest limit note's text in the inspector callout by finding the newest system message that matches. That match is display-only, so wording drift can't break detection.
  - `slotWaitNote` / `slotWaiting` read `plan.waitingNodes`.
  - Delete the prefix constants.
- **Scheduling paused:**
  - When `state.schedulingPaused` is set, a waiting node reads **"Paused: scheduling is stopped"** instead of "Waiting for a worker slot".
  - The board shows a banner: "Scheduling is paused after Stop all. Approve a plan or create a task to resume."
- **New event descriptions:** `describeEvent` for `scheduling.changed` ("You stopped all agents; scheduling is paused." / "Scheduling resumed."), and `eventTone` for it.

## Verification
- `pnpm check` exits 0 (`pnpm.cmd` on Windows PowerShell).
- Contracts tests for the new fields, event and projection state; core tests as above.
- Report exact counts.

## Result file (`handoffs/W2-structured-limits.result.md`)
Summary · contract changes · files · decisions · verification · known gaps.
