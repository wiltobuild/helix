# Helix

**An explainable agent orchestrator.** Helix runs Claude Code and Codex in parallel, each on its own branch, and brings every task to a merge-ready pull request that you approve. Every step is recorded with its cause, so you can replay the project's history and see why each change happened.

> Status: Waves 0–2 complete and the UI rebuilt as Concept 3 ("Flow Observatory"). The daemon, Claude Code and Codex adapters, worktrees, the GitHub CI loop, the orchestrator with plan approval, cross-agent review, recorded replay and the hosted demo all work. The app is a plan graph you approve before anything runs, a lane timeline you can replay, and a Why chain for every event.

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

`pnpm dev` starts the daemon on `127.0.0.1:4317` and the web app on `http://localhost:5317`. Open the web app and add a local git repository to start a task, or open `http://localhost:5317/?demo` to watch a recorded run with nothing else set up. Workers need the Codex or Claude Code CLI installed and signed in.

See [CONTRIBUTING.md](CONTRIBUTING.md) for ownership and architecture rules.
