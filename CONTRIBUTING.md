# Contributing to Helix

Use one branch per work package: `wave<N>/<agent>`. Run `pnpm check` before review;
formatting, typechecking, lint, tests, and architecture boundaries must all pass.
Claude reviews every work package before merge.

Never edit `packages/contracts` without Claude. Never edit `packages/ui` or
`apps/web`; Claude owns both. Root tooling and the lockfile are centrally owned by
Claude after Wave 0.

Internal packages expose TypeScript source through `@helix/<name>`. Declare workspace
dependencies with `workspace:*` and import only these entry points. Dependencies must
follow the allowlist in `.dependency-cruiser.mjs`. Test-only access to
`@helix/testing` is limited to `*.test.ts`, `*.spec.ts`, or files under
`test/`, `tests/`, and `__tests__/`. Production modules must not import test files.

Skipped example (documentation only; intentionally invalid and never executed):

```text
// packages/contracts/src/index.ts
import { PACKAGE_NAME } from '@helix/storage/src/index';
```

That example violates both dependency direction and the entry-point rule.
`pnpm boundaries` and `pnpm build` reject it.

Packages have no emitted build artifacts yet. `pnpm build` validates boundaries and
types, then runs any package build tasks added by future owners. For development,
`pnpm dev` starts the CLI and daemon placeholder watchers. On Windows PowerShell,
use `pnpm.cmd` if local execution policy blocks the `pnpm.ps1` shim.
