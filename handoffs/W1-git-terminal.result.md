**Summary:** Implemented both packages against frozen contracts. `pnpm check` exits **0**. Changes are uncommitted.

**Public API:** `GitWorktreeManager implements GitService`, `DirtyWorktreeError`, and `NodePtyHost implements TerminalHost`. Full signatures are in the [result file](C:/Users/Wil/Documents/Projects/helix-wt/w1-git-terminal/handoffs/W1-git-terminal.result.md).

**Files:** Only `packages/git/**`, `packages/pty-host/**`, and the result file changed.

**New dependencies:** [node-pty](https://registry.npmjs.org/node-pty) `1.2.0-beta.15` (2026-08-03); transitive [node-addon-api](https://registry.npmjs.org/node-addon-api) `7.1.1` (2024-07-12). Windows Node 24 prebuild verified; no compiler added.

**Decisions:** Private-index snapshots preserve staging; mutations share repository locks; terminal replay preserves ANSI and uses bounded scrollback and rotating logs.

**CONTRACT-REQUESTs:** None.

**Verification:**

- Default suite: **18 passed**, 10 opt-in skips.
- Git E2E suite: **18 passed**.
- PTY suite: **9 passed**, tree-kill test blocked.
- Root checks and `git diff --check`: **passed**.

**Known gaps / follow-ups:** Windows `taskkill` returned **Access denied**, so tree termination needs verification outside this sandbox. Claude must update the root lockfile. Linux/macOS native execution remains unverified; daemon restart recovery is intentionally out of scope.