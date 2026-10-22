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
`@helix/testing` is limited to test/spec files and test directories **under `src/`**,
and only in packages permitted by the allowlist. This includes daemon tests; the
daemon must not import fakes in production. Production modules must not import test files.

Every workspace test must live under `src/`. The boundary gate rejects any
`*.test.*`, `*.spec.*`, or `test/`, `tests/`, or `__tests__/` directory outside it
(excluding generated output and dependency directories). Keep tests in the package
TypeScript and ESLint inputs, and keep package Vitest discovery under `src/`.

Relative imports must stay inside their package, including imports from config files.
Root-level bridge modules are forbidden. Use canonical `packages/` and `apps/`
folder casing so imports behave consistently on Windows and Linux. Declared public
CSS exports such as `@helix/ui/styles.css` are allowed and still obey direction rules.

Computed dynamic imports are rejected unless a reason-bearing exception comment
appears immediately before the enclosing statement (no intervening blank line):

```ts
// helix-boundaries-allow-dynamic-import: load a user-selected external plugin
const plugin = await import(pluginName);
```

The exception applies only to computed imports in that statement. It does not
authorize forbidden literal imports. Prefer literal imports; exceptions need review.

The root Vitest config discovers every workspace and loads its `vitest.config.ts`
when present. Without one, it uses the shared Node defaults in `vitest.shared.ts`.
Package configs can set setup files, timeouts, workers, and their environment without
root edits; project name and root come from the workspace manifest and directory.
For example (install jsdom in the package before selecting that environment):

```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

Put real-agent smoke tests under `src/` too, gated with
`test.skipIf(process.env.HELIX_E2E !== '1')`. Use `pnpm test:e2e` to set the flag
cross-platform and run the uncached Turbo `test:e2e` task. Packages participating
in smoke tests declare a `test:e2e` script that invokes their test suite. The normal
`test` task also forwards and hashes `HELIX_E2E`, but real external-state checks
should use the uncached command. Turbo filters, such as
`pnpm test:e2e --filter=@helix/harness`, are forwarded.

`pnpm test:tooling` runs the boundary checker regression fixtures in temporary
directories; `pnpm check` includes them through `pnpm test`.

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
