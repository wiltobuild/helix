Reviewed `9573161` (`HEAD`, `wave0/scaffold`). No files modified. Import probes used in-memory substitutions against the actual checker.

1. **Should fix — Type-aware lint can replay stale success.**  
   [turbo.json:15](C:/Users/Wil/Documents/Projects/helix/turbo.json:15)

   `lint` has no `dependsOn`, so a consumer’s cache key excludes changes to workspace dependencies. ESLint uses those dependencies’ types.

   **Failure:** storage changes `save(): void` to `save(): Promise<void>`. An unchanged core call, `save();`, now violates `no-floating-promises`, but core’s cached lint success remains reusable. TypeScript permits the call.

   **Verified:** fresh ESLint reported the error only after the in-memory signature change; Turbo’s dry run showed no dependency tasks or storage inputs for core lint.

   **Fix:** add `dependsOn: ["^typecheck"]`, or an equivalent dependency-hashing task.

2. **Should fix — Root-level modules can bridge forbidden packages.**  
   [scripts/check-boundaries.mjs:20](C:/Users/Wil/Documents/Projects/helix/scripts/check-boundaries.mjs:20), [.dependency-cruiser.mjs:52](C:/Users/Wil/Documents/Projects/helix/.dependency-cruiser.mjs:52)

   The checker skips sources outside `packages/` and `apps/`, and does not reject workspace imports whose target lies outside both directories.

   **Failure:** contracts re-exports `../../../vitest.config.js`; that root module re-exports storage. Neither edge triggers the package-direction or entry-point checks.

   **Verified:** this bridge passed boundaries and contracts’ TypeScript check.

   **Fix:** reject first-party relative imports that escape a package root, including targets outside recognized workspaces. Put shared helpers in an explicitly governed package.

3. **Should fix — Windows directory casing bypasses boundary enforcement.**  
   [scripts/check-boundaries.mjs:14](C:/Users/Wil/Documents/Projects/helix/scripts/check-boundaries.mjs:14), [.dependency-cruiser.mjs:52](C:/Users/Wil/Documents/Projects/helix/.dependency-cruiser.mjs:52)

   Path separators are normalized, but root matching is case-sensitive. Windows resolves `Packages/` to the existing `packages/` directory.

   **Failure:** contracts imports `../../../Packages/storage/src/index.js`. The resolved path starts with uppercase `Packages`, bypassing both matchers.

   **Verified:** boundaries and contracts’ TypeScript check both passed. `forceConsistentCasingInFileNames` did not catch this case. Linux should reject the unresolved path, producing inconsistent local and CI results.

   **Fix:** canonicalize filesystem paths before applying both checks, or explicitly reject noncanonical workspace-root casing.

4. **Should fix — Computed dynamic imports silently escape inspection.**  
   [scripts/check-boundaries.mjs:21](C:/Users/Wil/Documents/Projects/helix/scripts/check-boundaries.mjs:21)

   The script validates only dependencies extracted by dependency-cruiser. Computed `import()` arguments produce no edge.

   **Failure:**
   ```ts
   const path = '../../storage/src/index.js';
   export const loaded = import(path);
   ```

   Placed in contracts, this crosses a forbidden boundary and uses a deep relative import.

   **Verified:** boundaries and TypeScript passed. The equivalent literal `import('../../storage/src/index.js')` was rejected.

   **Fix:** add an AST check requiring statically inspectable dynamic-import arguments. Give legitimate dynamic loaders narrow, explicit exceptions.

5. **Should fix — Turbo filters out the planned `HELIX_E2E` switch.**  
   [turbo.json:18](C:/Users/Wil/Documents/Projects/helix/turbo.json:18)

   Turbo runs in strict environment mode, with no declared test environment variables. PLAN specifies real-agent smoke tests behind `HELIX_E2E=1`.

   **Failure:** setting that flag before root `pnpm test` does not enable the smoke tests. Switching it also does not invalidate cached test results.

   **Verified:** dry runs with `HELIX_E2E=0` and `1` produced identical harness-test hashes and empty environment allowlists.

   **Fix:** declare the flag in test `env`. Prefer a separate uncached task for real-agent smoke tests, since external state is not represented by source hashes.

6. **Should fix — Tests outside `src/` can silently miss every substantive check.**  
   [vitest.config.ts:25](C:/Users/Wil/Documents/Projects/helix/vitest.config.ts:25), [packages/harness/tsconfig.json:3](C:/Users/Wil/Documents/Projects/helix/packages/harness/tsconfig.json:3), [packages/harness/package.json:11](C:/Users/Wil/Documents/Projects/helix/packages/harness/package.json:11)

   Vitest, package TypeScript configs, and package lint scripts all restrict discovery to `src/`. CONTRIBUTING nevertheless recognizes `test/`, `tests/`, and `__tests__/` as test locations for boundary exceptions.

   **Failure:** an agent adds `packages/harness/tests/adapter.test.ts`. Boundaries recognize it as test code, but it is neither executed, typechecked, nor linted. The retained scaffold test keeps the test command green.

   **Fix:** align discovery across the tools, or explicitly require tests under `src/` and reject misplaced test files.

7. **Should fix — Package-local Vitest configuration is ignored.**  
   [vitest.config.ts:20](C:/Users/Wil/Documents/Projects/helix/vitest.config.ts:20), [packages/harness/package.json:12](C:/Users/Wil/Documents/Projects/helix/packages/harness/package.json:12)

   Every package invokes the root config, whose projects are inline objects without `extends`. Installed Vitest initializes those projects with `configFile: false`.

   **Failure:** an agent adds `packages/harness/vitest.config.ts` with fixture setup, timeouts, or worker settings; none takes effect. Agents must instead coordinate edits to Claude-owned root configuration.

   **Fix:** discover package-local project configs from the root and share defaults through a common config.

**Verified working:** clean-tree boundaries passed; root and all 11 package TypeScript checks passed. Direct relative imports, re-exports, type-only imports, literal dynamic imports, forbidden test-to-production edges, and production access to `@helix/testing` were rejected. Allowed entry-point imports and test access to `@helix/testing` passed. Tracked files use LF; the working tree remained clean.

**Next-package caveat:** the NodeNext base is appropriate for Node packages. UI/web should override `module`, `moduleResolution`, `lib`, `jsx`, and `types` for browser/bundler use. Their missing configs are intentional stubs, not a scaffold defect.

Linux execution and the full Vitest suite were not rerun.