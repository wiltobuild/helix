**Summary**

Implemented the self-contained `@helix/contracts` package, including the 44-event password-reset fixture. All **153 tests pass**.

**Commit blocked:** Git denied creation of `.git/worktrees/contracts/index.lock`. Nothing was committed or pushed; the pre-existing staged handoff remains unchanged.

**Public API overview**

The [single entry point](packages/contracts/src/index.ts) exports:

- Branded IDs, entity schemas and inferred types.
- Event schemas, `parseEvent`, `isEventOf`.
- `applyEvent`, `projectUpTo`, status derivation and board mapping.
- `whyChain`, `rationaleFor`.
- REST/SSE/WebSocket schemas, route table and JSON Schema generation.
- Harness, worktree, SCM and event-store interfaces.
- Recording schemas, parser and serializer.
- `fixtures` namespace.

Full export inventory and integration notes: [README](packages/contracts/README.md).

**Status precedence table**

First matching rule wins.

| Priority | Condition | Status | Column |
|---|---|---|---|
| 1 | Archived | archived | archive |
| 2 | PR merged | merged | archive |
| 3 | Approval pending / waiting / blocked | needs_you | needs_you |
| 4 | Active / starting | working | working |
| 5 | Open PR, failed checks | ci_failed | in_review |
| 6 | Open PR, changes requested | changes_requested | in_review |
| 7 | Open PR, checks passed, review approved/none, mergeable | ready_to_merge | ready_to_merge |
| 8 | Other open PR | in_review | in_review |
| 9 | Exited, no open PR | exited | archive |
| 10 | Everything else, including unknown | pending | pending |

**Decisions**

- Pinned Zod `4.6.5`, TypeScript `5.9.3`, Vitest `4.1.11`; used [Zod’s native JSON Schema export](https://zod.dev/json-schema).
- Agent kinds accept future names.
- Projection rejects incomplete or inconsistent history; daemon sequence gaps are valid.
- Backfill cursors are exclusive; `lastSeq` identifies the last returned event.
- Recordings preserve original IDs and sequences.
- Unspecified lifecycle payloads, response shapes and transport conventions are documented.

**Open questions for Claude**

- Should draft PRs or unresolved review threads prevent `ready_to_merge`?
- How should skipped/neutral checks map into check totals?
- Should imported recordings remain replay-only or receive remapped IDs/sequences?

**Verification**

Inside `packages/contracts`:

- `pnpm.cmd install --ignore-workspace` — passed.
- `pnpm.cmd typecheck` — passed.
- `pnpm.cmd test` — **153 passed**, 7 files.
- Four replay snapshots and 53 status cases pass.
- Final fixture state: **API merged, UI merged, E2E working**.
- Source import-boundary checks pass.

**Known gaps**

Root lint/format checks await scaffold integration. Browser compatibility uses the permitted source-boundary test, not a browser bundle.

After Git write access is restored, commit only the package:

```powershell
git add -- packages/contracts
git commit --only -m "[codex W0-contracts] add shared contracts and deterministic replay" -- packages/contracts
```