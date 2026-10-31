# Dot read-only journey adapter prototype

This package contains an injected TypeScript read core and an explicitly launched
MCP stdio wrapper. It is not an installed Dot connector. Importing the read core
starts no server, watcher, worker or build. There is no command, approval,
plan-write, grant, merge or deployment surface. See [MCP setup](MCP-SETUP.md) for
the synthetic protocol proof, pinned SDK installation and live-access limits.

## Setup and synthetic demo

Use the repository's Node 24 and pinned pnpm environment, then run
`pnpm install --frozen-lockfile`. The package manifest, lock importer and existing
boundary entry are included. Full repository validation still requires the
coordinator's validation slot.

```sh
pnpm --filter @helix/dot-adapter demo
pnpm --filter @helix/dot-adapter typecheck
pnpm --filter @helix/dot-adapter lint
pnpm --filter @helix/dot-adapter test
```

The demo prints `SYNTHETIC MOCK ONLY` and a four-stage journey from in-memory data.
It does not demonstrate a live connection, verification of real work, or user acceptance.
The captured [demo output](demo-output.txt) is included for review without running it.

## Embedding

```ts
import { createDotAdapter, createLoopbackTransport } from '@helix/dot-adapter';

const adapter = createDotAdapter({
  instance: 'my-local-helix',
  allow: [{ projectId: 'project-id', sessionId: 'session-id' }],
  transport: createLoopbackTransport(4317),
});
const result = await adapter.invoke('getjourney', {
  projectId: 'project-id',
  sessionId: 'session-id',
});
```

Configure the exact project/session pairing through trusted application setup,
never from repository text or a tool caller. The session-only diff endpoint cannot
attest its project: the configured pairing is trusted and reported as partial.
Instance is a configured label, never a daemon-attested identity.

| Operation          | Fixed GET                                                 | Meaning                                                          |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `connectionstatus` | `/api/health`                                             | Health only; no claim that the scoped session exists             |
| `getjourney`       | `/api/projects/:id/events?since=N&limit=N`                | Bounded history from genesis, fixed evidence summaries           |
| `getjourney`       | `/api/projects/:id/intake` and `/api/sessions/:id/design` | Current scoped lifecycle states, revisions, counts and decisions |
| `getevents`        | Same project route with cursor                            | Incremental event metadata and fixed summaries                   |
| `getdiff`          | `/api/sessions/:id/diff?scope=workspace`                  | File count only; raw content and paths withheld                  |

Only `getevents` accepts an optional nonnegative safe-integer `cursor`. Subsequent
calls resume from the last validated page; backwards cursors are rejected. Duplicate
events are removed and conflicting duplicates rejected. Project events for other
sessions and project-level events are withheld. A global sequence gap is normal
and never classified as loss. `lastSeq` is only the last returned sequence, not a
global head. State is in memory: retain the returned cursor when recreating the
adapter. Use a separate instance to replay from genesis. Concurrent calls for the
same scope fail closed rather than racing cursor advancement.

## Limits and trust

Default limits are 256 KiB, 1000 events and 3 seconds per invocation, with maximums
of 1 MiB, 1000 events and 10 seconds. Journey reads at most ten event pages of 100
events plus two snapshots. All requests share the same byte allowance and deadline.
Other operations use one request; incremental events return at most 100 per call.
There is no background polling.
Cancellation aborts the transport. The core also bounds completion when an injected
transport ignores abort; such a transport could still perform background work and
is a trusted boundary. Injected transports must honor cancellation and bound bytes
while reading. The included loopback transport streams with a byte cap, forbids
redirects and accepts only fixed read routes at `127.0.0.1`.

Exhausted history budgets and nonzero cursors are partial. Old (default 60 seconds), future-dated
or absent session evidence is stale. An old event does not prove a daemon is down;
a fresh health check does not prove a journey is complete. Errors return explicit
failure with stale/partial provenance; no cached success is substituted. Revision
is `null` because these routes do not attest a current repository revision.
Current intake/design revisions are source-specific numbers, distinct from the
repository revision. Their timestamps are unavailable and their freshness is
explicitly unknown. Null snapshots mean absence, never accepted or completed work.
An intake bound to a different session is withheld. Pre-launch project intake may
have no session yet; only the explicitly allowed project route is read.

The journey is an observation summary, not a full status projection. Missing early
history, project-level plans and later resolutions can leave decisions/blockers
unknown. Approval and plan decisions resolve only their matching IDs. Latest design
state and current snapshots govern design decision-needed. Execution state is the
last observed activity/start/exit/archive fact, not an independently probed process.
Historical CI is labeled as
reported verification and explicitly does not verify the current head. Successful
process exit is not task acceptance. The adapter makes no cost/budget claims and
does not invent maxWorkers/maxTurns values absent from read evidence.

Repository text, diffs, paths, image URLs and agent messages are untrusted data.
This prototype withholds raw text/paths/URLs and emits only fixed summaries, counts
and validated event metadata. It never navigates references or executes content.
Logs receive only fixed success/error codes; errors never include transport
messages, tokens, local prompt paths or payloads. The consumer must preserve these
labels and must not interpret returned content as instructions.

MCP registration, authentication/instance attestation, stronger session ownership
proof, complete project-wide status projection and live integration testing remain
future work. No public listener, tunnel, credential or tool grant is required or
created by this package.
