# Issue 97: Dot-to-Helix read-only adapter

## MCP test lifecycle follow-up (October 31)

Central candidate `0c31d41` failed two MCP tests under parallel repository load.
The coordinator log (`task-5/dot-local-full-check.log`, lines 738 onward) records
25 seconds of imports, a 15-second handshake-test deadline and the framing
watchdog killing its child. Both tests included cold TypeScript/SDK startup in
operation budgets; that evidence does not establish a post-ready shutdown hang.

The tests now initialize and reuse one real stdio mock in a bounded 60-second
setup phase, using Node's direct tsx loader to avoid the CLI relay process.
Operation tests retain their 15-second deadlines; the oversized-frame shutdown
watchdog retains 10 seconds and starts after the SDK handshake. The framing test
requires no protocol response, no secret in the caught error or stderr, and exit
without watchdog intervention. Cancellation and read-failure cases use the
official in-memory SDK transport with explicit start/abort events, removing
repeated child startup and polling. Runtime server code and budgets are unchanged.

A deterministic regression advances fake time by 20 seconds before readiness.
It failed with the previous eager-watchdog scheduling (expiry occurred before
readiness), then passed when the operation deadline was armed after readiness.
It also proves the unchanged 10-second deadline still fires after readiness.
This is controlled startup-delay evidence, not a simulated full CPU-load run.

Focused validation: 71 tests in four files passed; the standalone `mcp:proof`
completed the official SDK handshake and all four synthetic calls. Typecheck,
lint, formatting and whitespace checks are recorded with the final commit.
Independent Sol review found no remaining blockers in this test-only correction. Full parallel
repository validation is still pending the coordinator's explicit slot; the
unrelated web recording test failure is outside this package's ownership.
No live Helix request, dependency change or service activation was performed.

## Dependency integration follow-up

The coordinator authorized this isolated package manifest, root lockfile patch and
minimal targeted workspace override.
The official npm registry was queried again and confirmed runtime
`@modelcontextprotocol/server@2.3.1`, `zod@4.6.5`, and development
`@modelcontextprotocol/client@2.3.1`. These are now declared in the package, with
`mcp:stdio`, `mcp:mock` and `mcp:proof` scripts. pnpm 10.34.7 generated the adapter
importer and SDK dependency graph without changing existing dependency pins.
The generated lock initially selected transitive `jose@6.2.14` (October 29), which
was too recent. The targeted workspace override
`@modelcontextprotocol/client@2.3.1>jose: 6.2.12` now selects the September 5 release
within the SDK's `^6.1.3` range. Regeneration used pnpm; no integrity hash was
handwritten. The override affects no existing dependency edge.

Fresh official registry publication checks: server/client/core 2.3.1 October 5;
zod 4.6.5 September 13; eventsource 3.0.7 May 9, 2025; eventsource-parser 3.1.1
August 10, 2026; jose 6.2.12 September 5, 2026; pkce-challenge 5.0.1 November 23,
2025. Thus the direct pins and every new transitive selection meet the 14-day rule.

A fresh source snapshot at `task-12/mcp-frozen-final-20261031`, with no prior
node_modules, successfully ran:

```sh
pnpm --filter helix --filter @helix/dot-adapter install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
```

pnpm reported "Lockfile is up to date, resolution step is skipped" and installed
the root tools plus adapter. This replaces the earlier temporary dependency-link
workaround as the installation evidence. Lifecycle scripts were disabled, and no
live Helix read, credentials, tunnel, registration or persistent access was used.
Full repository validation remains deferred to the coordinator's validation slot;
final integration/publication and issue-scope reconciliation remain with them.

Final clean-snapshot results: package typecheck passed, 70 tests passed across
three files, and `pnpm --filter @helix/dot-adapter mcp:proof` completed negotiation,
listed exactly four tools and returned four successful synthetic results. Package
lint passed in the first clean snapshot; runtime source was unchanged by this
metadata integration. Formatting and whitespace checks passed. The frozen install
left the lockfile unchanged: SHA-256
`74850E6D8908ACE9EC180A16D2E3062F0D98B3F2FCEF8A074ABC8D0B4CDBFA47` matches source
and final verification snapshot. Independent Sol review found no remaining
findings and independently ran the final clean-snapshot proof successfully.

## MCP stdio follow-up (initial authoring record)

The later user request authorizes an actual read-only MCP wrapper. It uses the
official TypeScript SDK v2 and exposes `connectionstatus`, `journey`, `events` and
`diffcounts` over stdio. It forwards request cancellation to the core, caps incoming
frames at 16 KiB and tool text at 512 KiB, keeps stdout protocol-only, and retains
all existing scope/provenance/read budgets. `--mock` is explicit and every response
labels the source mode. The SDK child proof uses synthetic data only.

Issue 97 was read but not changed: its original no-SDK scope needs reconciliation.
Package dependency and script proposals are in `packages/dot-adapter/MCP-SETUP.md`.
Required runtime pins: `@modelcontextprotocol/server: 2.3.1`, `zod: 4.6.5`;
dev pin: `@modelcontextprotocol/client: 2.3.1`. Manifest/lock/root edits remain
pending with the central owner. Isolated npm dependencies and ignored local
junctions enabled focused verification without changing those files.

Independent Sol review of this follow-up completed with no remaining blockers.
Review fixes cover redacted SDK argument/unknown-tool errors, strict timestamp
metadata, cancellation propagation, and oversized-frame shutdown. This review
does not approve installation, registration, publication or merge.

The synthetic proof is `packages/dot-adapter/mcp-proof-output.txt`. With the local
verification dependencies present, reproduce directly using:
`node node_modules/tsx/dist/cli.mjs packages/dot-adapter/src/mcp-proof.ts`.
The normal setup remains pending the manifest dependencies above and regenerated
`packages/dot-adapter` importer/resolved SDK dependencies in `pnpm-lock.yaml`.
No further boundary-map change is needed beyond the existing adapter entry.

Follow-up focused results: 70 tests passed across three files; package TypeScript,
ESLint with zero warnings, formatting and whitespace checks passed. The official
SDK client completed negotiation, discovered exactly four tools and successfully
called each against the synthetic child process. Both process cleanup and incoming
frame limits are tested. Full repository/frozen-install validation remains pending
central dependency integration and the coordinator's validation slot.

No real Helix read was retried after the earlier socket-access denial. No public
listener, tunnel, key, credential, account grant, connector registration or
persistent access was created. Hosted Dot does not read local Codex MCP config;
account/workspace eligibility, authorized authenticated transport and a live Dot
tool call remain separate unverified work. Full frozen workspace checks require
the dependency integration and coordinator validation slot.

The original core implementation notes below describe the earlier stage.

Base: `d1f9d4a66313669f24ffb4669d83916b1091da09`.
Branch: `feature/dot-readonly-journey-adapter`.
Owned paths: `packages/dot-adapter/**` and this handoff only.

The package exposes an injected read core for connection status, journey summaries,
event metadata and diff counts. It includes a bounded loopback GET transport but no
live connector registration, SDK dependency, server, monitor or write operation.
The demo is explicitly synthetic. See the package README for usage and limits.

## Central root-owner requests

1. Add `'dot-adapter': []` to `allowed` in `.dependency-cruiser.mjs`.
2. Add `packages/dot-adapter: {}` to the `importers` map in `pnpm-lock.yaml`.

No root dependency, workspace glob, TypeScript, ESLint, Turbo or test-discovery edit
is needed. `scripts/check-boundaries.mjs` discovers workspaces dynamically and
uses the imported dependency-cruiser rules; no independent package allowlist exists.
No contracts or UI changes are requested.

## Verification and review

Focused validation completed locally:

- `node node_modules/typescript/bin/tsc -p packages/dot-adapter/tsconfig.json --noEmit` passed.
- `node node_modules/eslint/bin/eslint.js "packages/dot-adapter/src/**/*.ts" --max-warnings 0` passed.
- `node node_modules/vitest/vitest.mjs run --config vitest.config.ts --project @helix/dot-adapter` passed: 59 tests in two files.
- Package/handoff Prettier formatting and `git diff --check` passed.
- Synthetic demo ran successfully; captured output is `packages/dot-adapter/demo-output.txt`.

Independent Sol review completed with no remaining blockers after regression fixes
for cancellation classification, streaming oversize, matching approval decisions,
validated acceptance evidence, pagination ordering and current design decisions.
This is prototype code review, not merge or production approval.

Local dependency setup used directory junctions to already installed tool packages
after offline installation lacked cache metadata. Only local ignored `node_modules`
links were created; source checkout contents and lockfile were not edited. This is
a local verification workaround, not the documented installation procedure.

Full `pnpm check` requires the coordinator's validation slot and central root edits.
No push, PR, merge, deployment, daemon restart or monitor activation is authorized.

## Known limits

Instance label is configured (`instanceVerified: false`), revision is unknown, and
diff scope relies on the trusted configured project/session pairing. Journey reads
up to ten pages from genesis (1000 total events), plus current project intake and
session design snapshots, under one shared byte/time budget. Incremental reads
are explicitly partial. Snapshot freshness is unknown, absence is explicit, and
acceptance is bound to the matching draft/design revision. Events
for other sessions/project-level events are withheld. Missing session evidence is
stale and gets a blocker. Raw diffs/text/URLs are withheld rather than exposed as
model instructions. Historical CI never claims current-head verification.

Actual MCP installation, live read smoke, session ownership attestation and full
history projection remain future work; nothing here activates them.
