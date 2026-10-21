**Summary:** Fixed base-fetch reporting, Windows executable/shim handling, and startup-stop races. Changes remain uncommitted.

**Public API:**
- `fetchBase(repoPath, branch): Promise<string>`
- `resolveExecutable(command, options?): Promise<string>`
- `resolveTerminalCommand(command, args, options?): Promise<TerminalCommand>`

**Files:** Only owned packages and the [full result file](C:/Users/Wil/Documents/Projects/helix-wt/w1-fixB/handoffs/W1-fix1-host.result.md) changed.

**New dependencies:** None.

**Decisions:** Typed fallback diagnostics, documented batch escaping, and five-second startup/exit waits.

**CONTRACT-REQUESTs:** None.

**Verification:** `pnpm check` exited **0** with serial concurrency: 441 package tests and 20 tooling tests passed. All 24 Git tests and both real ConPTY hostile-argument tests passed.

**Known gaps / follow-ups:** Two real PTY tree-kill tests require rerunning outside the sandbox, where `taskkill /T /F` returned “Access denied.” Batch arguments containing line breaks are explicitly rejected.