# Helix — instructions for coding agents

Helix is an explainable agent orchestrator: it runs Claude Code and Codex in parallel, each on its own branch, and brings every task to a merge-ready pull request that a human approves. Read `README.md`, `docs/PLAN.md` and `CONTRIBUTING.md` before changing code.

Two people build this repo, each with their own agents: Wil (`wiltobuild`) and Abheeshu (`abheeshudhungana-source`). Agents coordinate through GitHub issues, never by editing the same files at the same time. Follow the protocol below exactly.

## Coordination protocol

1. **Never start work without a claimed issue.** Work comes from open issues labeled `agent-task`.
2. **Find and claim work with the script, not by hand:**
   ```sh
   node scripts/agent-tasks.mjs list           # what's ready, claimed, or blocked
   node scripts/agent-tasks.mjs next           # first task ready to claim
   node scripts/agent-tasks.mjs claim <issue>  # assigns your human, labels in-progress, creates the branch
   ```
   If `claim` says the task is taken or blocked, pick another. Never claim an issue that is already assigned to someone.
3. **Edit only the paths listed under "Owns" in the issue.** Everything else is read-only for that task. If you need a change outside those paths, stop and comment on the issue instead of editing.
4. **Single-owner areas.** `packages/contracts`, root config (root `package.json`, lockfile, `turbo.json`, `tsconfig*.json`, `eslint.config.mjs`, `.dependency-cruiser.mjs`, `scripts/check-boundaries.mjs`, CI), `packages/ui` and `apps/web` are owned by Wil's side. If your task needs a contract change, open an issue labeled `contract-request` describing the exact change, link it from your task, and work around it locally until it lands.
5. **Before opening a PR:** run `pnpm check` (use `pnpm.cmd` on Windows PowerShell). It must pass: format, typecheck, lint, tests and architecture boundaries.
6. **Open the PR against the base branch** named in the issue (currently `wave1/integration`) with `Closes #<issue>` in the description. Summarize what changed, how you verified it, and anything you could not verify.
7. **Never merge.** A human merges after review. Never push to someone else's branch or to the base branch directly.
8. **If you stop before finishing**, push your branch, comment where you got to, and run `node scripts/agent-tasks.mjs release <issue>` so the other side can pick it up.

## Engineering rules (from the plan)

- Display status is derived, never stored. Every event carries `causedBy` when it has a cause.
- Agents in Helix edit files only; Helix itself commits at the end of each turn.
- Never force-delete a dirty worktree. The daemon binds `127.0.0.1` only.
- Tests live under `src/` next to the code. Real-agent or real-GitHub tests are gated with `HELIX_E2E=1`.
- Pin new dependencies exactly, to releases at least 14 days old, and add them only to the package your issue owns.
