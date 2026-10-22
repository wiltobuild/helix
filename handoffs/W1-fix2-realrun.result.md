**Summary**

Implemented **Helix commits; agents edit files**. Removed the writable-root override and deleted `git-common-dir.ts` and its tests.

Both adapters receive the requested Git ownership instruction: Codex through `developerInstructions`, Claude through `--append-system-prompt`. Verified against the installed schema and `claude --help`.

Core commits dirty worktrees before `markTurn`, diff collection and shipping. Commit messages include the bounded title, turn number, agent and last assistant summary. The SHA explanation is caused by the idle event.

Updated `handoffs/W1-fix2-realrun.result.md`. Changes remain uncommitted.

**Public API**

Existing exports remain unchanged:

```ts
createHelixCore(deps: CoreDeps): HelixCore;
detectAll(options?: Partial<Record<KnownAgentKind, HarnessOptions>>): Promise<HarnessInfo[]>;
```

Commits use the existing contract:

```ts
GitService.commitAll(path: string, message: string): Promise<string | undefined>;
```

New internal helper:

```ts
isGitWriteCommand(command: unknown): boolean;
```

**Files**

- Harness: adapter instructions, Git policy/denial handling, lifecycle and request tests.
- Core: turn-end commits, message formatting, failure handling and ordering/resume tests.
- Daemon: revised real Codex E2E and default integration test.
- Handoff: updated implementation details and verification.

Only owned paths changed.

**New dependencies**

None.

**Decisions**

Git write approvals are declined without surfacing `approval.requested`. Legacy Codex and Claude responses include the explanation directly. Modern Codex receives `decline`, followed by a `turn/steer` reminder because its decline response has no reason field.

| Server request | Handling | Coverage |
|---|---|---|
| `item/commandExecution/requestApproval` | Git decline/reminder; other commands require approval | Denial and three decisions |
| `item/fileChange/requestApproval` | Safe local auto-approval; otherwise user decision | Decisions and containment |
| `item/permissions/requestApproval` | Requested or empty permissions | Three decisions |
| `applyPatchApproval` | Safe local auto-approval; otherwise legacy decision | Decisions and containment |
| `execCommandApproval` | Git denial/reminder; otherwise user decision | Denial and three decisions |
| `item/tool/requestUserInput` | Question, waiting activity, next-message answers | Questions and core integration |
| `mcpServer/elicitation/request` | Immediate decline and note | Exact response |
| `item/tool/call` | Unsuccessful tool result and note | Exact response |
| `attestation/generate` | Error `-32000` and note | Error response |
| `account/chatgptAuthTokens/refresh` | Error `-32000` and note | Error response |
| Unknown method | Error `-32601` and note | Unknown request |

Clean turns advance numbering without committing. Commit failures preserve edits, explain the failure and block queued work before shipping. Git author identity remains the repository’s configured identity.

**CONTRACT-REQUESTs**

No new contract changes required. Earlier requests remain: harness explanation emissions, structured question/secret-answer metadata, and approval-cancellation emissions.

**Verification**

`pnpm.cmd check` exited **0**:

- **539 package tests + 20 tooling tests passed**; 20 gated tests skipped.
- Harness: 105 passed; core: 68 passed; daemon: 53 passed.
- Formatting, typechecking, lint and architecture boundaries passed.
- `git diff --check` passed.
- Default real-Git daemon integration passed with core performing commits.

**Known gaps / follow-ups**

The revised `HELIX_E2E=1` test awaits Claude’s outside-sandbox rerun. Its prompt is now “Create HELLO.md containing the word hello.” Assertions require a Helix commit on the session branch, matching SHA note, exactly one diff file, zero approvals, no unknown activity and no unanswered requests.

Git command recognition covers ordinary invocations and shell wrappers, not arbitrary aliases or generated scripts. Automatic commits apply to chat adapters, which expose turn boundaries.