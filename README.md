# Helix

**An explainable agent orchestrator.** Helix runs Claude Code and Codex in parallel, each in its own git worktree, and carries every task from prompt → pull request → CI → merge. Unlike other orchestrators, it shows its reasoning: a live plan graph, a timeline you can rewind, and a **Why** panel for every decision.

> Status: Wave 0 (foundation). No app code yet.

## Docs
- [Product Requirements (PRD)](https://claude.ai/artifact/APjpMcKMGE8DTrRyeLus4M), also in [`docs/PRD.html`](docs/PRD.html)
- [Implementation plan](docs/PLAN.md)
- [Research](docs/research/): product teardown, architecture patterns, stack, UI/UX

## Team
- Wil Sheppard ([@wiltobuild](https://github.com/wiltobuild))
- Abheeshu Dhungana ([@abheeshudhungana-source](https://github.com/abheeshudhungana-source))

## How we build
Codex agents build the daemon and integrations as parallel work packages; Claude owns the UI and reviews every package before merge. Every Codex brief and result lives in [`handoffs/`](handoffs/).

## Development

Prerequisites: Node 24, pnpm 10 (the exact version is pinned in `packageManager`), and git.

```sh
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` starts the CLI and daemon placeholder watchers. See
[CONTRIBUTING.md](CONTRIBUTING.md) for ownership and architecture rules.
