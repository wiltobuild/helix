# W2: per-session orchestrator environment (#19)

## Summary

Implemented per-session process environments through contracts, both harness adapters, core, and real daemon composition. Orchestrators receive the planning prompt and a working local helix launcher; workers inherit their normal adapter environment. Replaced the externally configured CLI smoke with a self-contained daemon smoke.

## Public API

- `HarnessStartOptions.env?: Record<string, string>`: session additions override the adapter base environment without mutating it or `process.env`.
- `CoreDeps.sessionEnv?: (ctx: { project: Project; session: Session }) => Record<string, string> | undefined`: evaluated on each chat process launch/resume and each terminal spawn.
- No new dependencies, root configuration changes, or lockfile changes.

## Files

- `packages/contracts/src/interfaces.ts`: documented optional start environment only.
- `packages/harness/src/{harness,process}.ts`: session environment merge shared by Codex and Claude Code, including Windows case-insensitive replacement.
- `packages/harness/src/lifecycle.test.ts`, `__fixtures__/fake-cli.cjs`: child-observed overrides, both PATH casings, and isolation of later sessions.
- `packages/core/src/core.ts`, `session-env.test.ts`: callback plumbing and orchestrator/worker launch, resume, and terminal tests.
- `apps/daemon/src/real-core.ts`, `real-core.test.ts`: prompt/environment composition and hook assertions.
- `apps/daemon/src/helix-launcher.ts`, `helix-launcher.test.ts`: platform launcher generation, session environment, and real CLI-to-test-daemon status integration.
- `apps/daemon/src/orchestrator-real.e2e.test.ts`: new gated real orchestrator smoke.
- Deleted `apps/cli/src/orchestrator.e2e.test.ts`; changed only the smoke note in `apps/cli/README.md`.

## Decisions

- Resolve the workspace from the daemon source module, independent of process cwd. Resolve tsx from that workspace's node_modules/.bin and invoke the CLI source by absolute path.
- Write a CRLF helix.cmd with delayed expansion disabled on Windows; write an executable POSIX shell script elsewhere. Quote literal paths and forward arguments with %* / "$@".
- Prepend the daemon data directory's bin to the configured base PATH, falling back to the inherited PATH when omitted. Only orchestrators receive the discovery directory and session/project identities.
- Merge terminal additions over the supplied terminal options without mutating the options provider's environment.
- The real smoke uses a throwaway git app and port-zero daemon, polls for submission for six minutes, waits for idle, and checks awaiting approval, task file claims/rationales, no worker creation, unchanged worktree and HEAD, and no unanswered protocol requests. It always stops the orchestrator and retains diagnostics.
- Explicitly blank inherited HELIX_URL in the smoke's harness base environment so run.json discovery stays isolated.

## Verification

Final `pnpm.cmd check` exited **0** on Windows with `HELIX_E2E=0` and `TURBO_CACHE_DIR` set to a writable temporary directory. Formatting, all workspace typechecks, lint, tests, and architecture boundaries passed (197 modules). `git diff --check` also passed.

| Workspace | Passed | Skipped | Total |
| --- | ---: | ---: | ---: |
| contracts | 200 | 0 | 200 |
| api-client | 10 | 0 | 10 |
| testing | 5 | 0 | 5 |
| pty-host | 17 | 6 | 23 |
| scm | 56 | 1 | 57 |
| storage | 33 | 0 | 33 |
| git | 15 | 9 | 24 |
| cli | 32 | 0 | 32 |
| core | 128 | 0 | 128 |
| daemon | 62 | 4 | 66 |
| harness | 117 | 2 | 119 |
| **Vitest total** | **675** | **22** | **697** |
| Node tooling | 20 | 0 | 20 |
| **Combined** | **695** | **22** | **717** |

Zero failures in the final check. Vitest reported 51 passed and 7 skipped files (58 total). All 12 new ordinary tests passed: four adapter cases, five core cases, and three launcher/environment cases. The launcher integration executed `helix --json status` against a real test daemon using its temporary run.json.

An initial parallel test run timed out the existing, unmodified orchestrator prompt export test's 20-second tsx subprocess. The unchanged full-check rerun passed that test in 2.9 seconds; successful workspace results were reused from Turbo's cache. The earlier shared-cache access warnings were avoided by using the temporary cache directory.

Final check log: `C:/Users/Wil/AppData/Local/Temp/helix-w2-check-final.log`.

## Known gaps

- The real HELIX_E2E smoke was deliberately not run; Claude will run it.
- This workstation runs Windows. POSIX launcher generation is unit tested; POSIX execution remains for Linux CI.
- No commit or push performed.
