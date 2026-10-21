# @helix/git

`GitWorktreeManager` implements the frozen `GitService` contract. Construct it
with `{ dataDir, projects }`, where `projects` is `Pick<ProjectIndex, 'getProject'>`.
Only `@helix/contracts` is needed from another workspace package.

- `create(projectId, sessionId, base?, options?: WorktreeCreateOptions): Promise<Worktree>`
  defaults an omitted/empty base to the project's default branch. Slugs are
  normalized and collisions get an eight-character suffix. Accepts a commit SHA
  as well as a ref; creation itself does not fetch.
- `fetchBase(repoPath, branch): Promise<string>` fetches the exact branch into
  `refs/remotes/origin/<branch>` under the shared repository lock, with credential
  prompts disabled. Returns that commit SHA without moving local branches,
  changing the index, or touching working files. The explicit refspec works even
  with a custom remote fetch mapping. Pass this SHA to `create` for fresh bases.
  Without origin, resolves `refs/heads/<branch>` and reports a `LocalBaseFallback`
  through the optional `onBaseFallback(result)` constructor callback, or
  `console.info` by default. The result contains `source: 'local'`, `repoPath`,
  `branch`, `sha`, and `reason: 'no-origin'`. Diagnostic callback failures are
  isolated. Fetch/resolution failures include branch context and Git diagnostics
  in a `HelixError`; a failed fetch never silently returns a stale tracking ref.
- `diff(path, scope): Promise<DiffResponse>` uses the creation SHA for `workspace`,
  the current base's merge-base with HEAD for `pr`, and a saved snapshot for
  `last_turn`. Untracked files appear as added. Binary counts are zero and the
  binary flag is true. Git rename detection uses its normal similarity threshold.
- `markTurn(path, sessionId): Promise<void>` snapshots HEAD plus current files,
  including untracked files, into `refs/helix/<sessionId>/last-turn`. The snapshot
  is a commit object with a fixed Helix identity; HEAD and the user's index do not
  move. Before the first mark, the last-turn baseline is the creation SHA.
- `status(path): Promise<{ dirty: boolean }>` includes staged, tracked, and
  untracked changes, respecting ignore rules.
- `remove(path, { force: false }): Promise<void>` rejects dirty worktrees with
  `DirtyWorktreeError extends HelixError`, code `DIRTY_WORKTREE`. It uses Git's
  non-force removal and prune, and never deletes the branch.
- `commitAll(path, message): Promise<string | undefined>` stages all changes and
  commits; an unchanged tree returns undefined. Existing identity and hooks apply.
- `push(path, branch): Promise<void>` pushes to origin with upstream tracking,
  credential prompts disabled, and SSH batch mode.
- `headSha(path): Promise<string>`, `commitsAhead(path, base): Promise<number>`,
  `defaultBranch(repoPath): Promise<string>`, `isGitRepo(path): Promise<boolean>`,
  `remoteUrl(repoPath, remote?): Promise<string | undefined>` implement GitHelpers.

Every subprocess uses `execFile`, an argument array, and no shell. Git 2.40+ is
required. Mutations share an in-process lock across manager instances, keyed by
the canonical common Git directory. This does not coordinate other processes or
external editors. Worktree metadata lives in the worktree's Git administration
directory, allowing another manager instance to read existing baselines.

Filesystem IDs accept ASCII letters, digits, underscores and hyphens, excluding
Windows reserved device names. Pass a worktree root to worktree operations.
Creation and removal manage only Helix worktrees. Generic Git helpers can operate
on other repositories. Default-branch detection prefers origin/HEAD, then local
main/master, then the current symbolic branch, without a network request.

Private-index snapshots write Git objects but preserve the actual index and user
files. They require a resolved index; conflicted indexes fail with HelixError.
Submodule HEAD changes are represented by Git; files inside a dirty submodule are
not recursively snapshotted. Branches and turn refs intentionally remain after
removal. Native Git failures use INTERNAL_ERROR because v1 has no Git-specific
error code. These adapters do not append domain events: the calling core owns
event envelopes and persistence.

Default tests use fakes and pure parsing. Set `HELIX_E2E=1` to run the real Git
suite, which uses isolated temporary repositories and a local bare push target.
