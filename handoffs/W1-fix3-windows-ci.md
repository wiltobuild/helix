# W1 fix round 3: harness process tests hang on GitHub's Windows runner

Branch `wave1/fix-windows-ci`, based on `wave1/integration` at `ecf1497`. CI is `.github/workflows/ci.yml` (`pnpm check` on ubuntu-latest and windows-latest).

## Symptom

Today was the first time Windows CI got past the tooling step; earlier runs died there. Now **32 tests in `packages/harness/src/lifecycle.test.ts` fail on windows-latest only**. Every one fails after almost exactly 15 s with:

```
Error: Harness request timed out
  at Timeout._onTimeout src/session.ts:197:16
```

(`requestTimeoutMs: 15_000` comes from the test's `opts()`.) CI run: https://github.com/wiltobuild/helix/actions/runs/39811117446.

- These fail: every test that exchanges JSON-RPC/stream-json frames with `__fixtures__/fake-cli.cjs` over stdin/stdout (both `claude-code process lifecycle` and `codex process lifecycle`, the Git-instruction tests, `debug mode captures both directions…`, `resolves Codex approve-files/approve-permissions…`).
- These pass on the runner: tests where the child just prints and exits (`--version`, `status` detection). Ubuntu passes everything.
- **Locally (Windows 11, PowerShell 5.1) everything passes.** Claude timed the wrapper directly: one launch through `windows-job.ps1`, from spawn to first stdout byte of a ping/pong child, takes about 0.7 s, and six in parallel take about 1.7 s. So this is a hang, not slowness.
- The wrapper printed nothing to the CI log, but `session.ts:84` throws away child stderr content (it only logs "Harness wrote diagnostic output to stderr"), so a supervisor error or a .NET exception would be invisible.

On Windows every agent goes through `spawnExecutable` (`process.ts`), which launches `powershell.exe -File windows-job.ps1 -Launch <base64>`. The wrapper does the following:
1. compiles C# with `Add-Type`
2. puts itself in a job object with KILL_ON_JOB_CLOSE
3. starts the agent with redirected stdio
4. pumps bytes using `Task`-returning `Pump()` over `[Console]::OpenStandardInput()`/`OpenStandardOutput()`

The demo machine is Windows, and real agents use this exact path, so a fix that only skips the tests is not acceptable.

## Owned paths
`packages/harness/**` and this brief's result file. Do not edit `packages/contracts`, root config, the lockfile or `.github/`. You cannot commit or push; Claude runs CI.

## Required
1. **Find the root cause** by reading the code and comparing against how a GitHub Actions Windows runner differs from a desktop session. Candidates worth checking, though none is confirmed:
   - The runner process already being inside a job object (nested job or breakaway rules).
   - `[Console]::OpenStandardInput()` behaving differently when PowerShell's stdin is a pipe from a non-interactive service session.
   - Async `Task`s in Windows PowerShell 5.1 not being driven (no synchronization context, or the script thread blocking in `WaitForExit()` before the pumps start).
   - Console code page or encoding.
   - `Add-Type` compilation output in `%TEMP%` (8.3 short paths such as `RUNNER~1` occur on these runners).
   - Defender or AMSI blocking.
   - stdout from PowerShell being block-buffered when not attached to a console.

   Say which one it is and what evidence supports it. If you can't be certain without running on the runner, say so plainly and rank the candidates.
2. **Make the failure visible.** When a harness request times out, include the child's last ~4 KB of stderr in the error and in the session log. Add an opt-in `HELIX_DEBUG_PROCESS=1` that makes `windows-job.ps1` write timestamped stage markers (compiled, job entered, child started, first stdin byte, first stdout byte) to stderr. Do not change behavior when it's unset.
3. **Fix the wrapper** so stdin/stdout frames flow both ways on the runner, while keeping its guarantees: the whole process tree dies with the job, writes are unbuffered, and stdin, stdout and stderr progress independently. Prefer the least invasive change that addresses the cause you identified. If it reduces risk, also stop recompiling the C# on every launch by caching the compiled assembly, keyed by a hash of the source.
4. Keep every existing test. Add a test that a request timeout error includes the child's stderr.

## Verification
- `pnpm check` exits 0 locally.
- Result file `handoffs/W1-fix3-windows-ci.result.md`:
  - Summary
  - Root cause and its evidence or confidence
  - Files changed
  - What Claude should look for in the next windows-latest CI log if it still fails
  - Known gaps
