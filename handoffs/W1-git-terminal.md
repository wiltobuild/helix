# W1-git-terminal — worktrees and terminal host

**Owned paths:** `packages/git/**`, `packages/pty-host/**`

## packages/git — `WorktreeManager` (from `@helix/contracts`)
- Shell out to system `git` (`execFile`, no shell). Detect git ≥ 2.40; clear error otherwise.
- **create(projectId, sessionId, base)**: worktree under `<dataDir>/worktrees/<projectId>/<sessionId>`, branch `helix/<slug>` (slug from session title, passed via options; ensure uniqueness with a short suffix), from `base` (default the project's default branch; fetch is NOT done implicitly). Returns `{ branch, path, baseSha }`.
- **status(path)** → `{ dirty }` counting tracked, staged and untracked (respect .gitignore).
- **diff(path, scope)** → `DiffResponse` (`unifiedDiff` + per-file stats incl. renames, binary, untracked files as added). Scopes: `workspace` = working tree + index vs `baseSha`; `pr` = `merge-base(base, HEAD)..HEAD`; `last_turn` = vs a ref Helix sets after each agent turn — expose `markTurn(path)` that records `refs/helix/<sessionId>/last-turn` and use it.
- **remove(path, { force: false })** — refuse (typed `DirtyWorktreeError`, code `DIRTY_WORKTREE`) if dirty; otherwise `git worktree remove` + prune; never deletes the branch.
- **Per-repo lock:** serialize mutating git operations per repository (in-process async mutex keyed by the repo's common git dir).
- Helpers the core needs: `commitAll(path, message)`, `push(path, branch)` (uses existing git credentials; never prompts — set `GIT_TERMINAL_PROMPT=0`), `headSha(path)`, `defaultBranch(repoPath)`, `isGitRepo(path)`.
- Paths with spaces and Windows drive letters must work.

## packages/pty-host — `TerminalHost` (from `@helix/contracts`)
- `node-pty` (pin a release with Node 24 prebuilds for win32-x64, darwin, linux; verify `pnpm install` doesn't need a compiler here — if it does, say so and stop to report rather than adding build tooling).
- `spawn(sessionId, { command, args, cwd, env, cols, rows })`, `attach(sessionId, onOutput)` → `{ write, resize, detach }`, `kill(sessionId)` (tree kill), `list()`.
- **Scrollback:** keep the last 2 MB of output per session in memory and append raw output to `<dataDir>/terminals/<sessionId>.log` (rotate at 20 MB). `attach` first replays scrollback, then streams live. Multiple attachers allowed.
- Emit an `onExit(sessionId, code)` callback for the core.
- Windows uses ConPTY (node-pty default); handle `resize` before first output; strip nothing (UI renders ANSI via xterm.js).
- Surviving daemon restarts is **out of scope** for Wave 1 (document the gap).

## Tests
- git: real repos in temp dirs (init, commit, branch): create/diff (all scopes, rename, binary, untracked)/status/remove-refuses-dirty/remove-clean/lock serialization (two concurrent creates)/paths with spaces.
- pty-host: spawn `node -e` scripts that print, read stdin, and exit with codes; replay-then-live attach ordering; two attachers; resize; kill tree (spawn a child that spawns a grandchild — both die); log rotation threshold (use a small threshold via options).
