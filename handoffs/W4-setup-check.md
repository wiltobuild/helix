# W4: setup checks for a reliable live demo + fresh web page after rebuilds

Branch `agent/setup-check` from `main`. Two other Codex agents work in parallel on other branches; stay inside your owned paths. The web UI is being redesigned by a teammate, so **do not edit `apps/web/**` or `packages/ui/**`**. Your work is backend, API, and CLI only, so the new UI can use it.

Read first: `CLAUDE.md`, `CONTRIBUTING.md`, `packages/contracts/src/api.ts` (`harnesses` route and `harnessesResponseSchema`), `packages/harness/src` (`detect()` on each harness), `apps/daemon/src/{server,real-core,dispatch,lifecycle}.ts`, `apps/cli/src/cli.ts`, and `packages/scm` (how the GitHub token is resolved: `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`).

## 1. Setup checks
Before a live demo we need one call that says whether the machine is ready:
- **Agents:** for Codex and Claude Code, installed (and version) and signed in, using the harnesses' existing `detect()`.
- **GitHub:** whether a token resolves (never return or log the token itself), and which login it belongs to if cheaply available; `HELIX_GITHUB=off` reported as "off".
- **Tools:** `git`, `node`, and `pnpm` versions.
- **Config:** the effective non-secret daemon settings (`HELIX_REVIEWER`, `HELIX_AUTO_APPROVE`, `HELIX_MAX_WORKERS`, `HELIX_MAX_TURNS`, `HELIX_CODEX_MODEL`/`EFFORT`).

Add a `GET /api/setup` route: contracts in `packages/contracts/src/api.ts` (request/response schemas plus the route entry; strict schemas), a `HelixCore` method if that's the pattern (check how `harnesses` is wired), dispatch wiring, and a fake for `apps/daemon/src/testing`. Each check is `{ ok: boolean, detail: string }` plus any structured fields; one slow or failing probe must not fail the whole response. Use a short per-probe timeout, and run probes in parallel. Add `helix setup` (and `--json`) to the CLI, printing a readable checklist with ✓/✗ and a one-line fix for each failure (for example "run `gh auth login`").

## 2. index.html must not be cached
After a web rebuild, browsers kept a stale `index.html` that referenced deleted asset hashes, which showed a blank page until a hard reload. When the daemon serves the built web app, serve `index.html` (and the SPA fallback) with `Cache-Control: no-cache`, and serve hashed `assets/*` with long-lived immutable caching. Add a test.

## Tests
- Route conformance: the new route is in the daemon's "covers every ordinary route" table, with happy-path, validation and domain-error cases.
- Setup probes are injectable or mocked: all OK; agent missing; GitHub off; a probe that hangs times out without failing the response; the token is never present in the output.
- CLI `helix setup` human and `--json` output.
- `index.html` and fallback headers are `no-cache`, and assets are immutable.

## Owned paths
`packages/contracts/src/api.ts` (new route and schemas only), `packages/harness/src/**` only if `detect()` needs a small addition, `apps/daemon/**`, `apps/cli/**`, `packages/api-client/**` if the generated client needs it, `handoffs/W4-setup-check.result.md`. No root config, lockfile or dependency changes. You cannot commit or push.

## Verification
`pnpm.cmd check` exits 0. Report exact test counts. If the only failure is a known load-sensitive Windows harness test, rerun that file alone and report both results.

## Result file
`handoffs/W4-setup-check.result.md`: summary, API shape, files, decisions, verification, known gaps.
