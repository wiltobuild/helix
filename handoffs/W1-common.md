# Wave 1 — common rules (read first)

You are one of **six Codex agents building Helix in parallel**, each in its own git worktree on its own branch (`wave1/<agent>`). Read `docs/PLAN.md` (§3 architecture) and `packages/contracts/README.md` before starting. Helix is an explainable orchestrator: every action is an append-only `HelixEvent`; the UI is `projectUpTo(events, seq)`; display status is always derived (`deriveStatus`), never stored.

## Hard rules
1. **Only edit your owned paths** (listed in your brief) plus your result file. Everything else is read-only — especially `packages/contracts/**` (frozen v1), root config, `packages/ui/**`, `apps/web/**`, `docs/**`.
2. **Program against contracts, not neighbors.** Import other workspace packages only where the boundary rules allow (`pnpm boundaries`), and only via `@helix/<name>`. Where you need a neighbor that is being built right now, use the interface from `@helix/contracts` and a local fake in your tests.
3. **Contract changes:** if a contract is wrong or missing, do NOT edit it. Work around it locally (clearly marked `// CONTRACT-REQUEST:`) and describe the exact change you need in your result file.
4. **Dependencies:** add npm deps only to your own packages' `package.json`, pinned exactly, releases ≥ 14 days old. Run `pnpm install` (network is enabled). Never touch the root `package.json`. Mention every new dependency in your result.
5. **Tests live in `src/**/*.test.ts`** next to the code. `pnpm check` at the repo root must exit 0 before you finish. Use `pnpm format` for Prettier.
6. **Windows first.** This machine is Windows 11; CI also runs Linux. Use `node:path`, never hand-built paths; no shell-specific syntax in scripts; kill process trees (not just the parent) on Windows; normalize CRLF where you parse tool output.
7. **No real agents, GitHub, or network in default tests.** Real-binary or real-GitHub smoke tests run only when `HELIX_E2E=1`.
8. **You cannot commit** — the sandbox makes `.git` read-only. Leave all changes in the working tree; Claude reviews and commits.
9. Never store display status. Never force-delete a dirty worktree. The daemon binds `127.0.0.1` only.

## Result file (your final message)
Markdown with: **Summary** · **Public API** (exports with signatures) · **Files** · **New dependencies** (name, version, release date) · **Decisions** (anything not specified) · **CONTRACT-REQUESTs** · **Verification** (commands + results, test counts) · **Known gaps / follow-ups**.
