# W0-scaffold — Monorepo foundation for Helix

You are Codex working on **Helix**, an explainable agent orchestrator. Read `docs/PLAN.md` (architecture, ownership) and skim `docs/PRD.html` for context before starting. You own this package of work end to end; Claude reviews it before merge.

## Goal
Create the empty-but-working monorepo skeleton that seven parallel Codex agents will build inside next. No product logic. Everything must install, typecheck, lint, test, and pass boundary checks on **Windows and Linux**.

## Tooling (pin exact versions; choose stable releases at least 2 weeks old)
- Node 24 (`"engines": {"node": ">=24"}`, `.nvmrc` = `24`)
- pnpm 10 workspaces (`packageManager` field set to the installed pnpm version — run `pnpm -v`)
- Turborepo for task orchestration (`turbo.json` with `typecheck`, `lint`, `test`, `build`, `dev` pipelines; `dev` is persistent, uncached)
- TypeScript 5.x, **strict**, `"module": "NodeNext"`/`"moduleResolution": "NodeNext"` for Node packages, ESM everywhere (`"type": "module"`)
- Shared `tsconfig.base.json` at root; each package `tsconfig.json` extends it
- Vitest (root `vitest.workspace.ts` or projects config) — each package has its own `test` script
- ESLint 9 flat config + typescript-eslint (type-aware for `src/**`), Prettier (printWidth 100, singleQuote, semicolons), `.editorconfig`, `.gitattributes` with `* text=auto eol=lf`
- dependency-cruiser for architecture boundaries (`pnpm depcheck:arch` or `pnpm boundaries`)
- `tsx` for running TS apps in dev

## Workspace layout (create every package)
```
packages/contracts   @helix/contracts    shared types/schemas (zod) — Wave 0 contracts brief fills it
packages/testing     @helix/testing      fakes & fixture builders
packages/storage     @helix/storage      SQLite event store
packages/core        @helix/core         domain services
packages/harness     @helix/harness      Claude Code / Codex adapters
packages/pty-host    @helix/pty-host     terminal host
packages/git         @helix/git          worktree manager
packages/scm         @helix/scm          GitHub observer
packages/api-client  @helix/api-client   typed client + SSE subscriber
packages/ui          @helix/ui           STUB ONLY — Claude owns
apps/daemon          @helix/daemon       Fastify daemon (helixd)
apps/cli             @helix/cli          `helix` CLI (bin: helix)
apps/web             @helix/web          STUB ONLY — Claude owns
```
Each non-stub package gets: `package.json` (private, `"exports": {".": "./src/index.ts"}` — internal packages are consumed as TS source, no build step), `tsconfig.json`, `src/index.ts` exporting a single `export const PACKAGE_NAME = '@helix/<name>';`, `src/index.test.ts` with one passing test, and a 3–5 line `README.md` stating the package's responsibility (copy from the table above, expanded from PLAN.md).

`apps/daemon` and `apps/cli`: `dev` script runs `tsx watch src/main.ts`; `src/main.ts` prints a one-line banner and exits 0 (cli) / logs "helixd placeholder" and exits (daemon). `apps/cli` declares `"bin": {"helix": "./src/main.ts"}` placeholder.

**Stubs — `packages/ui` and `apps/web`:** create ONLY `package.json` (name, private, `"type": "module"`, scripts `typecheck`/`lint`/`test` that echo "owned by Claude — skipped" and exit 0) and `README.md` saying "Owned by Claude (UI). Do not edit." Do not add any src, Vite, React, or config files there.

## Dependency direction (enforce with dependency-cruiser; build must fail on violation)
- `contracts` → imports nothing from the workspace.
- `testing` → contracts only.
- `storage`, `harness`, `pty-host`, `git`, `scm` → contracts (+ testing in tests only).
- `core` → contracts, storage, harness, git, scm (+ testing in tests).
- `api-client` → contracts only.
- `apps/daemon` → any `packages/*` except `ui`; never imports `apps/*`.
- `apps/cli` → contracts, api-client only (the CLI is a pure HTTP client).
- `ui` → contracts only. `apps/web` → ui, contracts, api-client.
- Everywhere: **no deep imports** (`@helix/x/src/...` or relative paths crossing package roots). Only `@helix/<name>` entry points.
- Add one deliberately-skipped example in docs, not code — the rule set must pass on the clean tree.

## Root scripts
`dev`, `build`, `typecheck`, `lint`, `test`, `format`, `format:check`, `boundaries`, and `check` (= format:check + typecheck + lint + test + boundaries). `pnpm check` is the gate every future agent must pass.

## CI
`.github/workflows/ci.yml`: on push + pull_request; matrix `ubuntu-latest`, `windows-latest`; Node 24; pnpm via `pnpm/action-setup` (version from `packageManager`); cache pnpm store; run `pnpm install --frozen-lockfile` then `pnpm check`.

## Also add
- `CONTRIBUTING.md` (short): branch per work package `wave<N>/<agent>`, `pnpm check` must pass, never edit `packages/contracts` without Claude, never edit `packages/ui` or `apps/web`.
- Root `README.md`: append a "Development" section (prereqs: Node 24, pnpm 10, git; commands: `pnpm install`, `pnpm check`, `pnpm dev`). Keep the existing content above it.

## Do NOT touch
`docs/**`, `handoffs/**` (except writing your result file), `packages/ui/**` beyond the stub, `apps/web/**` beyond the stub.

## Acceptance criteria
1. `pnpm install` succeeds and produces `pnpm-lock.yaml`.
2. `pnpm check` exits 0 on this Windows machine.
3. Introducing a deep import (e.g. `@helix/storage/src/x`) or a forbidden edge (e.g. `contracts` → `storage`) makes `pnpm boundaries` fail — verify both temporarily, then revert.
4. `pnpm --filter @helix/cli dev` and `pnpm --filter @helix/daemon dev` start without error (stop them after verifying).
5. No files outside the allowed paths changed (`git status` clean apart from your work).
6. Line endings LF in committed files.

## Windows notes
Use cross-platform scripts only (no `rm -rf`, `&&` chains that assume bash are fine inside npm scripts; prefer `rimraf` if cleaning). Quote globs in scripts. Avoid symlink-dependent tooling.

## Commit
Commit your work on the current branch (`wave0/scaffold`) in logical commits, each message prefixed `[codex W0-scaffold]`. Do not push.

## Result file
Your final message must be a markdown report with: **Summary**, **Files/packages created**, **Pinned versions** (table), **Decisions** (anything you chose that the brief didn't specify), **Verification** (commands run + outcomes), **Contract/ownership questions**, **Known gaps**.
