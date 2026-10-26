# W1 fix round 3 result

## Summary

Replaced the Windows supervisor's async stream bridge with three dedicated blocking I/O threads over redirected standard handles. Each write is flushed before reading again. The existing non-inheritable kill-on-close job still contains the supervisor before the CLI starts, and bounded output draining still precedes supervisor exit. No breakaway flags were added.

Request timeout errors and the session diagnostic log now include the last 4096 bytes of child stderr. `HELIX_DEBUG_PROCESS=1` enables UTC stage markers on supervisor stderr. Pump failures now print their direction and exception stack instead of disappearing into an unobserved Task. Existing tests remain; four transport/diagnostic cases were added.

## Root cause and confidence

**The runner-specific trigger is not proven.** The strongest hypothesis is .NET Framework's console-input handling of a live redirected pipe in the runner's noninteractive environment. This is a transport fix for that hypothesis, with diagnostics for the next runner execution.

Evidence and ranking:

1. **Console-input pipe wait: leading candidate, moderate confidence.** `Console.OpenStandardInput()` returns a Framework console stream whose read calls `WaitForAvailableConsoleInput` before `ReadFile`. The [reference source](https://raw.githubusercontent.com/microsoft/referencesource/main/mscorlib/system/io/__consolestream.cs) shows this extra wait. The [published desktop CLR helper](https://raw.githubusercontent.com/dotnet/coreclr/release/1.0.0/src/classlibnative/bcltype/console.cpp) peeks for pipe data and can enter an infinite handle wait if none is available. That is an avoidable dependency on console/pipe wait behavior; it does not establish exactly where this runner blocked. The new non-owning, one-byte-buffer `FileStream` wrappers use the redirected pipe handles directly, with no console-input wait or encoding selection. Windows Server runner service/session and pipe timing differ from this Windows 11 desktop; the actual runner handle state was unavailable.
2. **Async pipe implementation/scheduling: secondary candidate, lower confidence.** Framework [Stream async methods](https://raw.githubusercontent.com/microsoft/referencesource/main/mscorlib/system/io/stream.cs) can adapt blocking operations through worker tasks. The old stdin Task was never observed, and output faults were only examined after child exit. Dedicated threads eliminate both thread-pool dependence in byte copying and inline work before the first incomplete await. A missing PowerShell synchronization context alone is not a convincing explanation: the old awaits already used `ConfigureAwait(false)`, and C# Tasks do not require PowerShell to drive them.
3. **Nested-job restrictions: unlikely given the reported passing probes.** Every probe uses the same compilation, job entry and child startup. A job-assignment error should terminate the supervisor rather than leave a child waiting for a frame. [Windows supports nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) starting with Windows 8 / Server 2012. This change keeps containment and does not attempt breakaway.
4. **Code page, compilation/temp paths, Defender/AMSI, output buffering: low confidence.** The bridge already copied bytes and explicitly flushed writes. A universal compile/startup block conflicts with successful version/auth probes. There is no runner evidence identifying an encoding, temp-directory or security-product error.

The unchanged baseline passed locally: 105 tests passed, two real-agent tests skipped. An independent original-wrapper echo probe also passed with stdin delayed two seconds. Thus there is no local reproduction proving a particular runner deadlock. The GitHub connector returned 404 for the supplied run; the failure pattern above comes from the brief, not independently downloaded logs.

## Files changed

- `packages/harness/src/windows-job.ps1`: raw standard handles, independent threads, flushes, opt-in stages, pump exception reporting.
- `packages/harness/src/session.ts`: bounded byte tail, included in timeout errors and logs.
- `packages/harness/src/options.ts` and `packages/harness/README.md`: diagnostic behavior and Windows transport documentation.
- `packages/harness/src/lifecycle.test.ts` and `src/__fixtures__/fake-cli.cjs`: both adapters verify stderr content, UTF-8, truncation and session logging on request timeout. Existing timeout assertions accept appended diagnostics.
- `packages/harness/src/process.test.ts` and `src/__fixtures__/pipe-cli.cjs`: Windows pipe tests with debug off/on; 128 KB stderr, stdout before first input, multiple UTF-8 frames with stdin open, EOF and successful exit, timestamped markers.
- This result file. The supplied brief is untouched. No changes to contracts, root configuration, lockfile or CI; no commit or push.

## Verification

Full `pnpm.cmd check` **exited 0** locally on Windows, Node 24.18.0: formatting, typechecking, lint, tooling tests, workspace tests and architecture boundaries (181 modules). Harness: **109 passed, two gated real-agent tests skipped**; tooling: **20 passed**. Turbo replayed unchanged package results and executed the harness, core and daemon suites. The existing lifecycle cases, including both descendant-cleanup cases, passed. `git diff --check` also passed.

The two new Windows pipe cases pass locally, with debug both off and on. The first development run exposed a test assertion that failed to account for stage markers interleaved with stderr; the corrected assertion removes markers before comparing the complete payload.

## What Claude should look for if windows-latest still fails

Ordinary request failures now show `Child stderr (last 4096 bytes)` directly in the exception printed by Vitest, and the same text reaches `options.log`. This works without debug enabled.

For stage diagnostics, run the harness suite directly from the repository root in a diagnostic Windows step:

```powershell
$env:HELIX_DEBUG_PROCESS = '1'
pnpm.cmd exec vitest run --config vitest.config.ts --project @helix/harness
```

Use direct Vitest for this diagnostic rerun: the current Turbo strict environment only declares `HELIX_E2E` for test tasks, so setting a workflow environment variable and running ordinary `pnpm check` can filter out `HELIX_DEBUG_PROCESS`. No root/CI changes were made here.

- No `compiled`: PowerShell or Add-Type startup; look for `Helix Windows process supervisor failed` and its exception stack.
- `compiled`, no `job entered`: job creation/configuration/assignment.
- `job entered`, no `child started pid=...`: launch configuration or process startup.
- Child started, no `first stdin byte`: the Node-to-supervisor-to-child input path has not completed its first write and flush.
- First stdin byte, no first stdout byte: the child has not replied or the stdout bridge has stalled; look for a directional pump exception.
- Both first-byte markers: each direction forwarded at least one chunk; investigate protocol content and subsequent frames using the protocol logger. Child startup output alone does not establish a successful handshake.

Markers appear once per direction after successful forwarding and flushing. Their order can interleave across threads; the stderr tail is bounded, so later noisy child output can evict earlier markers. Successful tests capture stderr and need not print the markers.

## Known gaps

- Claude must run windows-latest to confirm the runner fix; its exact .NET/runtime/handle state was not inspected. No Linux run or real-agent invocation was performed here.
- The stderr tail is attached to request timeouts. An immediate supervisor failure can instead reject with `Harness process exited`; its exception is written to raw supervisor stderr, so capture that stream directly if the exit happens before a timeout.
- Assembly compilation remains per launch. It is not supported as the cause by the passing probes/timings; adding an assembly cache would introduce file permissions, locking and invalidation paths without evidence that they are needed.
- A tail beginning midway through a UTF-8 character may contain a replacement character at its first byte boundary. The retained data itself is capped at 4096 bytes.

## Root cause, confirmed by Claude on the runner (diagnostic workflow, run 39819270252)

The real cause was not in the wrapper. On windows-latest, the same harness suite gave these results:

| How it ran | Result |
|---|---|
| Vitest directly | 109 passed |
| `turbo run test --env-mode=loose` | 109 passed |
| `turbo run test` (strict env, as in `pnpm check`) | 36 failed, all request timeouts |

Turbo's strict env mode stripped the Windows system variables that PowerShell, .NET and the agent processes need. A direct probe of the wrapper on the runner passed every stage in about 1.5 s. The runner was already inside a job object, and the nested job worked.

Fix: `globalPassThroughEnv` in `turbo.json` now lists the standard Windows system variables. They are passed through without affecting cache hashes, and the list covers `dev` as well. The thread-per-direction wrapper and the stderr tail stay in, as better diagnostics; they were not the fix.
