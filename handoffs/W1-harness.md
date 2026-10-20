# W1-harness — Claude Code and Codex adapters

**Owned paths:** `packages/harness/**`, `packages/testing/src/harness/**` (plus one export line for it in `packages/testing/src/index.ts`)

## Goal
Implement `AgentHarness` / `HarnessSession` from `@helix/contracts` for **Claude Code** and **Codex** in **Chat** mode (structured, programmatic). Emissions map onto Helix events: `chat.item`, `activity.changed`, `reasoning.summary`, `approval.requested`. This is how Helix knows what an agent is doing and why.

## Claude Code adapter
- Drive the `claude` CLI headlessly with streaming JSON: `claude -p --output-format stream-json --input-format stream-json --verbose` (verify flags against `claude --help` on this machine; record the version). Keep one long-lived process per session, writing user turns as JSON lines to stdin.
- Map stream messages: assistant text → `chat.item` message; `tool_use` / `tool_result` → `chat.item` tool_call (concise `inputSummary`/`outputSummary`, ≤ 200 chars each — never dump whole files); thinking/reasoning blocks if present → `reasoning.summary` (first ~400 chars, trimmed at a sentence); `result` → activity `idle`; process start → `starting` then `active` on first output; exit → `exited`.
- Permission requests: if the CLI exposes a permission-prompt mechanism (e.g. `--permission-prompt-tool` / MCP approval tool, or `--permission-mode`), surface them as `approval.requested` and resolve via a `decide(approvalId, decision)` method; otherwise run with an explicit permission mode chosen by options and document the limitation.
- Resume: capture the CLI's session id → `resumeToken`; `start({ resumeToken })` uses `--resume`.
- `send(text, 'queue')` writes the next user message after the current turn; `'interrupt'` interrupts the current turn (signal/escape per CLI support) then sends.

## Codex adapter
- Prefer `codex app-server` (JSON-RPC over stdio) if present in the installed CLI (`codex --help`); otherwise `codex exec --json` per turn with `codex exec resume <id>` for follow-ups. Record which you used and the version.
- Same mapping: agent messages, command/patch tool events, reasoning summaries, approvals (Codex approval requests → `approval.requested`), turn end → `idle`.
- On Windows the binary is invoked via `codex.cmd` (and `claude.cmd`/`claude.exe` as installed); resolve executables with a `which`-style lookup over PATH + PATHEXT, never hard-coded paths.

## Shared
- `detect()` → `HarnessInfo` (installed, version via `--version`, signedIn best-effort or `'unknown'`). Never throws.
- Process management: spawn without a shell where possible; when a `.cmd` shim requires a shell, quote safely. `stop()` kills the whole process tree (Windows: `taskkill /T /F` fallback). Child output decoding: UTF-8, CRLF-safe line splitting, tolerate partial lines and non-JSON noise (log and skip).
- Activity detection must never claim `exited` without an actual exit; parse failures → `unknown`, not crash.
- `createHarness(kind, options)` and `detectAll()` exports. Options include `bin` override, extra args, env, `cwd`.

## Fake harness (`packages/testing/src/harness/`)
`createFakeHarness(script)` implementing the same interfaces from a scripted list of emissions with delays — used by core/daemon tests and demos. Include a script reproducing the API worker in `fixtures.passwordResetRun`.

## Tests
- Parser unit tests from **recorded stream fixtures** you capture into `src/__fixtures__/` (save real output by running each CLI once in a temp dir with a trivial prompt if the CLI is installed and signed in — if not, hand-write fixtures from the CLIs' documented formats and say so). Cover: text, tool call, reasoning, approval, error, partial lines, CRLF, unknown message types.
- Process lifecycle with a fake executable (a tiny node script that emits a scripted stream): start → emissions → send queue/interrupt → stop kills tree.
- `HELIX_E2E=1` smoke test per CLI: one-turn "reply with the word ok" in a temp dir; asserts emissions arrive and process exits on stop.
