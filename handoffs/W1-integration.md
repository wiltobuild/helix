# W1-integration — wire the real daemon (milestone: one real task end to end)

All six Wave 1 packages are merged on `wave1/integration` (this worktree) and `pnpm check` passes (411 tests). Read `handoffs/W1-common.md` rules (they still apply, except the owned paths below) and `handoffs/W1-integration-notes.md`.

**Owned paths:** `apps/daemon/**`, `packages/core/**`, `apps/cli/**`, plus your result file. Read-only: everything else (contracts frozen; UI is Claude's). You cannot commit.

## 1. Compose the real core (blocking)
- In `apps/daemon`, add `createRealCore({ dataDir, env })` that composes: `openStore({ dataDir })` (@helix/storage), `GitWorktreeManager` (@helix/git, worktrees under `<dataDir>/worktrees`), `NodePtyHost` (@helix/pty-host, logs under `<dataDir>/terminals`), `createHarness('claude-code')` + `createHarness('codex')` (@helix/harness), `createGitHubScm()` (@helix/scm) **only if** a GitHub token resolves — otherwise run without SCM and log one clear line, and `buildFeedbackMessage`. Real `clock` (ISO now) and `ids` (`${prefix}_` + 26-char ULID-style or `crypto.randomUUID()` without dashes). Structured logger (console-based is fine; never log tokens or full prompts).
- `main.ts` uses it; delete `src/core-integration.d.ts` and any temporary augmentation. Graceful shutdown closes the store.
- Add root-independent scripts in `apps/daemon/package.json`: `start` (`tsx src/main.ts`) and `dev` (`tsx watch src/main.ts`). Respect `HELIX_DATA_DIR`, `HELIX_PORT`.

## 2. Fixes from Claude's review (see W1-integration-notes.md)
- core: startup reload must **not** use strict projection — load leniently, log anomalies (count + first few reasons), and expose `anomalies` count in `health()` only if contracts allow (health schema is `{status, version}` — if not allowed, log only and add a CONTRACT-REQUEST).
- daemon: bad `Host`/`Origin` → **403** `FORBIDDEN` (not 400).

## 3. CLI (minimal, for the orchestrator agent in Wave 2)
`apps/cli` — `helix` commands via `@helix/api-client`, base URL from `<dataDir>/run.json` or `HELIX_URL`: `status` (projects + sessions + derived status), `project add <path>`, `task "<title>" --agent codex|claude-code --prompt "..."`, `send <sessionId> "<text>" [--interrupt]`, `plan submit <file.json>`, `explain "<text>" --session <id> [--node <id>]`. Human-readable output by default, `--json` for machines. Exit codes: 0 ok, 1 usage, 2 API error (print the ErrorCode).

## 4. End-to-end integration test (the milestone, automated)
`apps/daemon/src/e2e.integration.test.ts` (runs by default; no real agents/GitHub): real store in a temp dir + real git temp repo with one commit + real `GitWorktreeManager` + **fake harness** (`@helix/testing`, scripted to edit a file and commit) + **fake GitHub** scm. Through the real HTTP server and `@helix/api-client`:
add project → create session (Idempotency-Key) → SSE receives `session.created`, `worktree.created`, `session.started`, harness `chat.item`s, `activity.changed: idle` → worktree diff via `/api/sessions/:id/diff` shows the change → (fake GitHub) PR opened → CI fails → `feedback.routed` with `causedBy` = the ci event → fix → CI passes → merge → `pr.merged`. Assert final `projectUpTo` board columns. Must pass on Windows.

Plus `HELIX_E2E=1` variant: same flow with the **real Codex harness** on a temp repo, no GitHub (stop after diff).

## Acceptance
- `pnpm check` exits 0; the integration test passes.
- `pnpm --filter @helix/daemon start` boots on 127.0.0.1:4317, `GET /api/health` → ok, `GET /api/harnesses` reports codex installed.
- Result file per W1-common format, plus exact commands to run the daemon and the CLI.
