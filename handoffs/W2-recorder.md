# W2-F — Recorder + replay: `.helixlog` export/import, redaction, demo build

**Wave 2, Agent F.** Owner: Codex (`gpt-6.1-sol`, effort high).  
Do not touch: `packages/contracts/` (frozen), `packages/core/`, `apps/daemon/src/server.ts`, any file outside the owned paths below.

---

## Goal

Make recordings first-class: export a project as a `.helixlog` file, redact sensitive paths/tokens, import for replay, and add **replay-determinism tests** that run a real recorded log through the projector and compare the output to the same log replayed at a later time.

---

## Owned paths

```
packages/storage/src/            (RecordingStore + MetaStore implementations, SQLite migrations)
apps/daemon/src/recordings.ts    (recording export/import route handlers — already scaffolded)
apps/daemon/src/recordings.test.ts
scripts/demo-build.mjs           (new — strips live-mode code from web build)
handoffs/W2-recorder.result.md
```

---

## Acceptance criteria

1. `GET /api/recordings/:projectId/export` returns a valid `.helixlog` (NDJSON, `application/x-helixlog`). The `header.redactions` array lists every string that was redacted. At minimum, redact:
   - The user's home directory (replace with `~`).
   - Any value that looks like a GitHub token (`ghp_…`, `gho_…`, `github_pat_…`).
   - Worktree absolute paths (replace the repo-root prefix with `<repo>`).
   After redaction, `parseHelixlog(exported)` must succeed.
2. `POST /api/recordings/import` accepts a `.helixlog` body, validates it via `parseHelixlog`, stores the recording, and returns `{ project, eventCount, lastSeq }`. Imported recordings are replay-only — their events are never appended to the live daemon log.
3. `GET /api/recordings` returns the list from `HelixStore.listRecordings()` with correct `{ id, project, eventCount, recordedAt, redactions }`.
4. `HelixStore` implements `MetaStore` (`getMeta` / `setMeta` / `deleteMeta`) backed by a new `meta` SQLite table with an additive migration that does not break existing databases.
5. **Replay-determinism test** (in `apps/daemon/src/recordings.test.ts`):
   - Load the golden recording from `apps/daemon/src/codex-real.e2e.test.ts` (or a shorter hand-crafted fixture covering at least 20 events including `plan.submitted`, `plan.approved`, `worktree.created`, `pr.opened`, `ci.updated`, `feedback.routed`, `pr.merged`).
   - Project it with `project(events.slice(0, t))` for every t from 1 to N using `projectUpTo` from `@helix/contracts`.
   - Store the snapshots.
   - Re-run the same projection from the parsed `.helixlog` after a round-trip through `serializeHelixlog` / `parseHelixlog`.
   - Assert that every snapshot is deeply equal. This test must pass without a running daemon.
6. `scripts/demo-build.mjs` generates a static web build with `VITE_DEMO_MODE=1` — the app skips the SSE connection and instead reads `?demo=<url>` (a `.helixlog` URL) to populate its state. The script must produce a `dist/` that can be served with `npx serve dist` and survives `vite build --mode demo` without errors.
7. `pnpm check` passes on both Ubuntu and Windows.

---

## Contracts to implement (already in `packages/contracts`)

| Contract | Where |
|---|---|
| `RecordingStore.listRecordings()` | `HelixStore` impl in `packages/storage` |
| `RecordingStore.getRecording(id)` | `HelixStore` impl |
| `MetaStore` (`getMeta` / `setMeta` / `deleteMeta`) | `HelixStore` impl, new `meta` table |
| `listRecordings` route | `apps/daemon` route → `core.listRecordings()` |
| `RecordingListEntry` / `RecordingListResponse` | already in contracts |

---

## Migration rules

- New SQLite tables must use `CREATE TABLE IF NOT EXISTS`.
- New columns on existing tables must use `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
- A database with no `meta` table must open successfully on the new code; the migration adds the table on first open.
- Never drop columns or tables.

---

## Redaction spec

```ts
// Minimum required redactions (order matters — apply all, then validate):
function redact(text: string, repoPath: string, homeDir: string): { text: string; redactions: string[] }
```

Redact exact string matches (not regex on arbitrary content) for safety:
- `homeDir` → `~` (case-insensitive on Windows).
- `repoPath` → `<repo>`.
- Tokens matching `/\b(ghp|gho|github_pat)_[A-Za-z0-9_]+/g` → `[REDACTED_TOKEN]`.

---

## Test command

```bash
pnpm --filter @helix/storage test
pnpm --filter @helix/daemon test
```

---

## Windows gotchas

- `home dir` on Windows may be `C:\Users\...` — compare case-insensitively and normalise slashes before redaction.
- SQLite WAL mode: always call `PRAGMA journal_mode=WAL` after opening.

---

## Result file format

Write `handoffs/W2-recorder.result.md` with:
- Summary.
- Files changed.
- Decisions.
- Contract-change requests.
- Gaps.
