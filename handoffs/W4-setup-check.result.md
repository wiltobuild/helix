# W4 setup checks and rebuild cache policy

## Summary

Implemented GET /api/setup and helix setup (including --json), with isolated parallel readiness probes. The daemon now revalidates index.html and SPA fallbacks and caches hashed assets immutably. Worked on the existing agent/setup-check branch. No commits or pushes; no UI, dependency, lockfile, or root configuration changes.

## API shape

GET /api/setup accepts an empty request and rejects unexpected query/body fields. The strict response contains:

- agents.codex and agents.claude-code: ok, detail, installed, signedIn (boolean or "unknown"), optional version and fix.
- github: ok, detail, status ("on", "off", or "unavailable"), tokenResolved, optional login and fix.
- tools.git, tools.node, tools.pnpm: ok, detail, optional version and fix.
- config: ok, detail, optional reviewer, autoApprove, maxWorkers, maxTurns, codexModel, codexEffort and fix. Successful checks include all effective settings; null model/effort means the Codex CLI's configured default.

The route automatically adds client.setup() to the schema-derived API client. No client generation or client source change was needed.

## Decisions

- Added a daemon-local optional SetupCore.setup extension because the shared HelixCore interface lives outside the owned paths. Real composition and daemon fakes provide it; embedded cores without it use the same default setup service.
- Reused each harness's detect() without changing harness code. Each setup request performs fresh detection using short internal harness timeouts.
- All agent, tool, GitHub, and configuration probes run concurrently, with a three-second outer deadline per check. Failures and timeouts produce actionable checks without rejecting the response. Tool processes are terminated on cancellation; harness processes retain their existing bounded probe cleanup.
- Reused the daemon's credential-resolution logic, preserving GH_TOKEN, GITHUB_TOKEN, then gh auth token precedence. Token and configuration helpers moved into daemon-local modules and remain re-exported from real-core.ts for compatibility.
- HELIX_GITHUB=off is a successful, explicitly disabled check and skips token/login lookup. A resolved token is not a claim that GitHub has validated its permissions. Login is optional, obtained from /user with at most 500 ms extra lookup time inside the probe deadline.
- Only selected non-secret settings are returned. Effective defaults are reviewer on, auto-approve on, 3 workers, 20 turns, and Codex-configured model/effort. Configuration uses the same parsers as daemon startup.
- Probe error bodies and stderr never reach the response or logs. Known environment/resolved credentials are redacted from output strings.
- CLI exits 0 when all checks pass, 1 for failed readiness checks or invalid arguments, and 2 for daemon/transport errors. Human output includes a fix for every failure; JSON output is the response object.
- index.html, root, and SPA fallback GET/HEAD responses use Cache-Control: no-cache. assets/* filenames with an eight-or-more-character hash use public, max-age=31536000, immutable. Other static files also revalidate.

## Files

- packages/contracts/src/api.ts: setup request/response schemas, types, and route only.
- apps/daemon/src/setup.ts: injectable probes and daemon-local setup port.
- apps/daemon/src/config.ts and credentials.ts: shared daemon configuration and token helpers.
- apps/daemon/src/real-core.ts and dispatch.ts: composition and dispatch.
- apps/daemon/src/server.ts: HTML and asset cache policy.
- apps/daemon/src/testing/fake-core.ts and setup-fixture.ts: setup fake.
- apps/daemon/src/setup.test.ts and server.test.ts: probe isolation, secrets, strict schemas, route conformance, typed client, and cache-header coverage.
- apps/cli/src/cli.ts and setup.test.ts: command, checklist, JSON, exit status and validation.
- handoffs/W4-setup-check.result.md: this report.

## Verification

Focused rerun: 3 test files passed, 58 tests passed, 0 failed.

Final pnpm.cmd check exited 0: formatting, all 13 package typechecks, lint, tests, and architecture boundaries passed (233 modules).

Final exact counts: 863 workspace tests passed, 22 skipped, 0 failed across 67 passed and 7 skipped test files. Tooling added 20 passed, 0 failed tests. Combined: 883 passed, 22 skipped, 0 failed (905 total).

| Package | Passed | Skipped |
| --- | ---: | ---: |
| contracts | 225 | 0 |
| api-client | 10 | 0 |
| testing | 5 | 0 |
| cli | 43 | 0 |
| git | 15 | 9 |
| pty-host | 17 | 6 |
| web | 55 | 0 |
| scm | 56 | 1 |
| storage | 38 | 0 |
| core | 182 | 0 |
| daemon | 76 | 4 |
| harness | 141 | 2 |
| tooling | 20 | 0 |

The UI package has no tests. External-agent/GitHub and other gated integration tests retain their existing skips.

Verification history, without changing existing test implementations or thresholds:

- The first full gate stopped at lint; the new mock callbacks and configuration callback were corrected to satisfy require-await, and the fetch mock now handles Request inputs explicitly. Direct lint then passed.
- A subsequent concurrent full gate hit the existing contracts projection performance assertion: 224 passed, 1 failed; 1,005.27 ms exceeded the 1,000 ms threshold. Rerunning projection.test.ts alone passed all 32 tests. A serial package run subsequently passed all 225 contracts tests.
- That serial run hit the known Windows lifecycle stderr-tail timeout assertion for Codex: harness had 140 passed, 1 failed, 2 skipped (143 total).
- The requested lifecycle.test.ts-only rerun had 41 passed and 1 failed (42 total), this time the Claude Code variant of the same stderr-tail assertion.
- The final full gate passed all 42 lifecycle tests and all 141 non-skipped harness tests. No harness source or test was edited.
- Used TURBO_CACHE_DIR=apps/daemon/node_modules/.cache/w4-turbo for the final runs because the default shared worktree cache was not writable. Also ran turbo run test --concurrency=1 during diagnosis. Final pnpm.cmd check used the ordinary scripts, with 18 of 23 test-stage tasks cached.

Evidence remains in the ignored apps/daemon/.w4-check-last.log, .w4-tests-serial.log, and .w4-harness-alone.log files.

Initial targeted run before fixes: 2 files failed, 11 passed, 3 skipped; 3 tests failed, 116 passed, 4 skipped (123 total). Fixed the Fastify reply header API call and Windows encoding in the new test assertions. The focused rerun above passed.

## Known gaps

Live external-agent and GitHub E2E checks remain opt-in; this task verifies setup behavior with injectable probes. GitHub login can be absent on slow/offline networks. A timed-out agent is reported as not confirmed installed, with unknown sign-in status. Setup reports tool versions rather than checking version compatibility. The UI can consume the new endpoint, but UI integration is intentionally left to its owner.
