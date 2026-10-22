# W1 fix round 1B — git base fetch and terminal host robustness

An independent reviewer audited Wave 1: `handoffs/W1.review.md`. Read it fully. You own findings **2 (git side), 7 (pty side), 8**.

**Owned paths:** `packages/git/**`, `packages/pty-host/**`, result file. Another agent is fixing core/harness/scm in parallel. You cannot commit. Rules in `handoffs/W1-common.md` still apply.

## Required fixes
1. **`GitHelpers.fetchBase(repoPath, branch): Promise<string>`** (new in contracts, added by Claude). `git fetch origin <branch>` (no prompts: `GIT_TERMINAL_PROMPT=0`; respect the per-repo lock), then return the SHA of `refs/remotes/origin/<branch>`. Never modify the user's local branch or working tree. If there is no `origin` remote, return the local branch's SHA and say so via a typed result or log. Errors → `HelixError` with a clear message. Ensure `create(..., base)` accepts a SHA as `base`.
2. **Terminal executables on Windows (finding 7).** `spawn()` must resolve `command` like the shell would: search PATH with PATHEXT; prefer `.exe`/`.com`; for `.cmd`/`.bat` shims launch via `cmd.exe /d /s /c` with argument quoting that is safe for prompts containing spaces, quotes, `&`, `|`, `<`, `>`, `^`, `%` and `!` (document the escaping; add a test with a hostile argument that must arrive verbatim in the child). Absolute paths pass through. Non-Windows unchanged. Export the resolver for core.
3. **Stop during startup (finding 8).** Track startup readiness. `kill()` during startup either cancels the pending spawn or waits (bounded, e.g. 5 s) for a valid PID and then kills the tree; it never rejects with `INVALID_REQUEST` for a PID-0 race, and the terminal never survives a successful `kill()`. Same for daemon shutdown overlapping startup.

## Tests
- fetchBase against a temp bare "origin" + clone: remote advances → fetchBase returns the new SHA; local `main` unchanged; worktree created from that SHA contains the new commit.
- PATHEXT resolution and `.cmd` shim launch with a hostile argument (real ConPTY on Windows behind `HELIX_E2E=1`; resolver logic unit-tested everywhere).
- PID-0 race: fake pty with delayed PID → `kill()` resolves and the terminal is gone from `list()`.

`pnpm check` must exit 0. Result file per W1-common format.
