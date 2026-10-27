# W2 orchestrator result — issue #5

## Summary

Implemented the planner system prompt, its public harness exports, and the CLI
plan submission/inspection flow on
`agent/5-planner-prompt-and-helix-cli-plan-flow` (base `b437a54`).
The repository stays read-only during planning; plan submission waits for human
approval. All edits are within owned paths. No commit or push was made.

## Public API

- `@helix/harness`: `ORCHESTRATOR_PROMPT: string`, loaded from `prompt.md` using
  a module-relative file URL.
- `@helix/harness`: `orchestratorPrompt(ctx: { project: Project; session: Session }): string`,
  compatible with `CoreDeps.orchestratorPrompt`; prepends project name, default
  branch, project id and session id.
- `helix plan submit <file.json>`: schema and empty-file validation before daemon
  discovery, per-problem JSON paths, exit 1 for local errors, and environment
  fallback for omitted project/session ids. Explicit values take precedence.
- `helix plan show <planId> [--json]`: replays paginated project events; human
  output includes goal, approval status and task id/title/agent/dependencies/files/
  derived status. JSON returns the contracts `PlanState`. Unknown plans exit 2
  with `NOT_FOUND`.
- `helix explain <text> [--session <id>] [--node <id>]`: session defaults to
  `HELIX_SESSION_ID`, with a clear missing-configuration error.

## Files

- `packages/harness/src/orchestrator/prompt.md`: planning rules and a valid
  three-node contract/service/screen example.
- `packages/harness/src/orchestrator/index.ts`: prompt loader and contextual header.
- `packages/harness/src/orchestrator/prompt.test.ts`: Markdown, rules, header,
  example schema and tsx package-entry loading tests.
- `packages/harness/src/index.ts`: exports only.
- `apps/cli/src/cli.ts`: commands, replay, usage and explain defaults.
- `apps/cli/src/plan-input.ts`: local schema validation and error paths.
- `apps/cli/src/plan-flow.test.ts`: 21 CLI behavior tests.
- `apps/cli/src/orchestrator.e2e.test.ts`: gated real-orchestrator smoke.
- `apps/cli/README.md`: commands, environment variables, validation, output and
  smoke prerequisites.
- `handoffs/W2-orchestrator.result.md`: this handoff.

The pre-existing untracked `handoffs/W2-orchestrator.md` was left unchanged.

## Decisions

- `.dependency-cruiser.mjs` permits CLI dependencies only on contracts and the
  API client. File-overlap validation stays with the daemon; no core import,
  duplicated overlap algorithm, dependency or root-config change was added.
- Legacy recorded plans may have empty `files`; the submission helper rejects
  them for new submissions even when other schema errors are also present.
- Human validation output uses one line per problem. JSON preserves the existing
  error envelope with newline-separated problems in `error.message`.
- The planning artifact is the sole file-write exception and lives in a temporary
  directory outside the repository. Workers own all repository changes.
- Node-specific explanation notes follow successful submission because core
  rejects unknown plan-node ids. The orchestrator then reports awaiting approval
  and stops.
- Packages currently export TypeScript source and emit no build artifacts. The
  Markdown ships beside its module through the existing source export; no harness
  manifest change is needed. Vitest and a separate tsx process exercise loading.
- Plan/node statuses come directly from the contracts projector.

## CONTRACT-REQUESTs / follow-ups

1. **#19:** add `env?: Record<string, string>` to `HarnessStartOptions` and pass
   per-session environment through adapters. Daemon composition must expose the
   `helix` executable on agent PATH and set `HELIX_URL`, `HELIX_SESSION_ID` and
   `HELIX_PROJECT_ID`. Do not mutate process-wide environment as a workaround.
2. **Daemon composition:** import `orchestratorPrompt` from `@helix/harness` and
   supply it to `createHelixCore`. No daemon/core/contracts paths were edited.
3. Once both are available, run the documented smoke against an isolated daemon
   and registered repository with signed-in Codex. Set `HELIX_E2E=1`,
   `HELIX_ORCHESTRATOR_E2E_READY=1`, `HELIX_URL` and `HELIX_PROJECT_ID`.
   The smoke creates/stops its own orchestrator, verifies a three-node plan,
   node explanation, CLI inspection and no workers before approval. It leaves the
   unapproved plan in the isolated event log.

## Verification

- `pnpm.cmd check`: **exit 0**. Formatting, typechecking, lint, tooling tests,
  workspace tests and architecture boundaries all passed.
- Full workspace tests: **663 passed, 22 skipped, 0 failed** across 11 packages
  with Vitest suites (UI/web report no tests). Unchanged packages used the existing
  shared worktree cache. Tooling regression tests: **20 passed, 0 skipped**.
- CLI: **32 passed, 1 skipped** across 4 files (3 passed, 1 skipped).
- Harness: **113 passed, 2 skipped** across 9 files (8 passed, 1 skipped).
- New focused tests: **25 passed** (21 CLI behavior tests and 4 prompt tests),
  including the public package export in a separate tsx process.
- `HELIX_E2E=1` with readiness unset, running only
  `apps/cli/src/orchestrator.e2e.test.ts --reporter=verbose`: **exit 0,
  1 skipped**, with the explicit missing-wiring message; no real agent started.
- Architecture gate: **194 modules**, no violations.
- Turbo emitted cache-write access warnings in this sandbox; command exits and
  all verification gates were successful.

## Known gaps

A real orchestrator end-to-end run remains unavailable until the two composition
follow-ups land. The smoke skips with an explicit prerequisite message even when
`HELIX_E2E=1`, unless readiness is also configured. Parallel file overlap is
validated only by the daemon, as required by the dependency allowlist.
