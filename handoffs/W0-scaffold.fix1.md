# W0-scaffold — fix round 1

An independent Codex reviewer audited your scaffold; its report is `handoffs/W0-scaffold.review.md` (read it — each finding includes a verified failure scenario). Claude has since merged the UI branch onto `wave0/scaffold`, which changed some root files you created:
- `eslint.config.mjs`: lints `.ts`/`.tsx` everywhere, adds `eslint-plugin-react-hooks` for UI `.tsx`, no longer ignores `packages/ui` / `apps/web`.
- `.prettierignore`: UI is formatted now.
- `scripts/check-boundaries.mjs`: allows declared style entry points `@helix/<pkg>/<file>.css` (needed for `@helix/ui/styles.css`).
- `package.json`: `packageManager` is `pnpm@10.34.7` (pnpm's auto-switch to 10.34.6 fails on this machine); adds `eslint-plugin-react-hooks`.
Keep all of those behaviors.

**You cannot commit** (the sandbox makes `.git` read-only). Leave changes in the working tree; Claude reviews and commits. Do not touch `packages/ui/**`, `apps/web/**`, `packages/contracts/**`, `docs/**`, or other handoff files.

## Fix every "Should fix" in the review
1. **Lint cache staleness** — `lint` must depend on upstream type changes (`dependsOn: ["^typecheck"]` or equivalent hashing). Prove with `turbo run lint --dry=json` that core's lint hash changes when storage's source changes.
2. **Root-level bridge modules** — reject first-party relative imports that escape a package root, including to files outside `packages/` and `apps/`.
3. **Windows path casing** — canonicalize resolved paths (realpath/true-case) before matching, or reject non-canonical workspace-root casing. Must behave identically on Windows and Linux.
4. **Computed dynamic imports** — fail on `import()` with a non-literal argument in workspace source (AST check; TypeScript compiler API is already available). Allow an explicit, documented escape hatch comment (e.g. `// helix-boundaries-allow-dynamic-import: <reason>`).
5. **`HELIX_E2E`** — declare it in Turbo `env` for `test`, and add a separate uncached `test:e2e` task/script (`HELIX_E2E=1`, cross-platform — use a small node script, not shell env syntax) for real-agent smoke tests.
6. **Tests outside `src/`** — require tests under `src/`; make `pnpm boundaries` (or a sibling check in `pnpm check`) fail if any `*.test.*`/`*.spec.*` or `test/`/`tests/`/`__tests__/` exists outside `src/` in a workspace package. Update CONTRIBUTING.
7. **Package-local Vitest config** — let packages add their own `vitest.config.ts` that the root projects pick up (e.g. root discovers `packages/*/vitest.config.ts` and falls back to a shared default). Add a shared default for `environment: 'node'`. UI (`packages/ui`, `apps/web`) will later need `environment: 'jsdom'` via their own config — make that possible without editing root.

## Plus two from Claude
8. Remove `testing` from `daemon`'s **production** allowlist (tests may still import it). Fakes must not ship in the daemon.
9. Add a regression test file for the boundary checker itself (`scripts/check-boundaries.test.mjs` or similar, run by `pnpm check`) covering: allowed entry import, deep import, forbidden edge, root bridge, wrong-case path, computed dynamic import, css entry point allowed, test outside src rejected. Use fixture trees in a temp dir; do not leave probes in the repo.

## Acceptance
- `pnpm check` exits 0 (Windows) and every probe above behaves as specified.
- Result file: each finding → what changed → how you verified it.
