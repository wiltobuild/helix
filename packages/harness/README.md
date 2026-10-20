# @helix/harness

Chat-mode adapters implementing the frozen `@helix/contracts` interfaces. No runtime dependencies beyond contracts; no display status is stored.

```ts
import { createHarness, detectAll } from '@helix/harness';

const installed = await detectAll();
const harness = createHarness('codex', { codexSandbox: 'workspace-write' });
const session = await harness.start({ session: sessionEntity, cwd: worktreePath });
const unsubscribe = session.onEvent((emission) => appendWithEnvelope(emission));
await session.send('Run the focused tests.', 'queue');
await session.send('Stop that approach and inspect the handler.', 'interrupt');
// Both implementations also implement ApprovingHarnessSession.decide(id, decision).
await session.stop();
unsubscribe();
```

## API and behavior

- `createHarness(kind: AgentKind, options?: HarnessOptions)` returns an `AgentHarness` whose sessions implement `ApprovingHarnessSession`.
- `detectAll(options?: Partial<Record<KnownAgentKind, HarnessOptions>>): Promise<HarnessInfo[]>` probes Claude Code and Codex in that order. Individual `detect()` never throws. A found binary with a failed version/auth probe remains installed with unknown metadata.
- Options: `bin`, `extraArgs` (prepended, including for detection), `env` (merged with inherited environment), `cwd` (detection default), `requestTimeoutMs`, diagnostic `log`, `claudePermissionMode`, `codexApprovalPolicy`, and `codexSandbox`. Start's required `cwd` controls the session working directory. Prompts go through stdin, never the shell.
- A new session sends `Session.prompt`. A resumed session restores the conversation and waits for `send`; it does not repeat the original task. Save the live `resumeToken` after initialization/output, not only the value returned at start.
- Startup events are buffered for the first subscriber. Later subscribers receive future events only. Callbacks are isolated and receive copies. The daemon supplies timestamps/sequences for emissions and owns persistence and user-message events.
- `send(..., 'queue')` acknowledges acceptance into the queue; delivery waits for the active turn to complete. Interrupt mode waits for the current turn's terminal notification, then sends the replacement before earlier queued turns. Standalone `interrupt()` preserves the queue. `stop()` is idempotent and awaits observed process closure.
- Invalid output is logged without raw content and emits activity `unknown`. Only an observed child exit emits `exited`. Text is emitted from canonical messages/items rather than also emitting their deltas. Tool start and completion are separate append-only entries because contracts v1 has no tool-call update identity.
- Tool argument summaries contain command/path/query metadata, never arbitrary serialized arguments. Tool output summaries contain size/count/exit metadata, never file bodies or patches. Reasoning uses exposed summaries (Claude thinking blocks, Codex `summary`, never Codex raw `content`), capped at 400 characters.

## Protocols verified on this host (2026-10-20)

- Claude Code `2.1.293`: `-p --output-format stream-json --input-format stream-json --verbose`; long-lived stdin with SDK control initialization, `can_use_tool` approvals, and control-protocol interrupts. Uses `--permission-prompt-tool stdio` as in the official SDK, with explicit permission mode (`manual` by default). Other modes may automatically allow/deny actions before a host prompt occurs. `--resume=<token>` binds even dash-leading values safely.
- Codex `0.163.0-alpha.10.2`: `app-server --listen stdio://`; initialize/initialized, thread/start or thread/resume, turn/start, turn/interrupt, canonical item notifications, command/file/permissions approval requests. App-server support was confirmed with local help and generated protocol types. This adapter targets app-server-capable versions; it does not implement the older exec-only transport.
- Both `claude auth status` and `codex login status` reported not signed in. No inference was attempted. The checked-in fixtures are explicitly synthetic examples, not recordings of real model output.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Claude SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py), [Claude subprocess arguments](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py).

## Permissions and platform limitations

Both sessions resolve approval IDs via `decide(id, decision)`. Approval scope is once: Codex maps approval/rejection/change request to accept/decline/cancel; Claude maps the latter two to a denial with an explanatory message. Codex permission grants echo only the requested permission profile with turn scope. Unknown interactive RPC/control requests receive an explicit error instead of hanging.

Windows lookup uses PATH + PATHEXT. Native executables spawn without a shell; batch shims use `cmd /d /v:off /s /c` with quoted arguments. Quotes, `%`, `!`, `^`, NUL and line breaks are rejected in batch arguments because arbitrary shims can re-expand them; use a native executable for complex arguments. Stdin accepts arbitrary prompt characters. On Windows, a PowerShell/.NET supervisor enters a kill-on-close Job Object before launching the CLI and forwards raw bytes with per-chunk flushing. Stopping its retained process handle terminates all descendants, including when sandbox policy denies process enumeration; `taskkill /T /F` remains a fallback. Windows PowerShell and .NET (included with Windows 11) must permit this local helper; startup fails closed if they do not. POSIX uses a detached process group with TERM then KILL; descendants that deliberately detach themselves are outside that process-group guarantee.

Contracts v1 does not expose approval cancellation or structured tool-question answers. Cancelled backend approval requests are removed locally but cannot clear a daemon's projected pending approval through the current emission union. Unsupported Codex user-input/elicitation requests fail explicitly. The core must handle stop-related approval cleanup until a cancellation event exists. There is also no exit code/signal field in `HarnessEmission`; consumers receive the activity fact only.

## Verification

Default tests use only hand-authored JSONL and a small Node executable, including queue/interrupt, approvals, resume, startup failures, UTF-8/CRLF/noise and process-tree cleanup. `HELIX_E2E=1 pnpm --filter @helix/harness test:e2e` enables one real one-turn smoke per installed, signed-in CLI. In PowerShell set `$env:HELIX_E2E='1'` before running `pnpm.cmd --filter @helix/harness test:e2e`.

The fake harness is exported by `@helix/testing`: `createFakeHarness(steps | { kind?, turns })`. The first scripted turn starts immediately, subsequent sends consume successive turns, delays are relative, approval emissions pause until `decide`, and stop cancels timers. `passwordResetApiScript` contains the API worker's harness-visible events from `fixtures.passwordResetRun`. Fake resume tokens identify sessions; they do not restore a previous script cursor.
