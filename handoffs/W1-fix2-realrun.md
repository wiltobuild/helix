# W1 fix round 2 — make real Codex runs reliable

Claude ran the first **real** Helix task: daemon (this branch) + UI, Codex agent, throwaway repo `C:\Users\Wil\AppData\Local\Temp\hx\demo-repo`, data dir `C:\Users\Wil\AppData\Local\Temp\hx\data`. Result: events #1–#11 arrived (worktree created, Codex active, its first shell commands), then **the run hung forever with no event, no error, no log line**.

Evidence:
- Codex's own rollout log (`~/.codex/sessions/2026/10/20/rollout-2026-10-20T21-35-46-*.jsonl`, read-only) ends with a code-mode `exec` tool call running `tools.apply_patch("*** Begin Patch\n*** Add File: …/CONTRIBUTING.md …")`, then nothing.
- No shell commands were running under `codex.exe app-server`; Codex was idle, waiting on the client.
- This Codex version's server→client requests (from `codex app-server generate-json-schema`, see `C:\Users\Wil\AppData\Local\Temp\hx\codex-schema\ServerRequest.json`): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `applyPatchApproval`, `execCommandApproval`. The adapter handles only the first two and permissions. The likely culprit is the legacy `applyPatchApproval` (code-mode `apply_patch`), but verify.

**Owned paths:** `packages/harness/**`, `packages/core/**`, `apps/daemon/**`, `packages/testing/src/harness/**`, result file. You cannot commit. W1-common rules apply.

## Required
1. **Never leave a Codex server request unanswered.** Handle every method in the schema above:
   - all approval kinds (incl. legacy `applyPatchApproval`, `execCommandApproval`) → `approval.requested` and resolve via `decide()` with the correct per-method response shape (read the generated schema files for each Params/Response);
   - `item/tool/requestUserInput` → a `chat.item` `question` + `activity: waiting_input`; answer with the user's next message;
   - `mcpServer/elicitation/request`, `item/tool/call`, `attestation/generate`, `account/chatgptAuthTokens/refresh` → respond immediately with a well-formed decline/error response the server accepts, and emit an `explain.note`-worthy log line;
   - any **unknown** method → JSON-RPC error response (`-32601`) immediately + log. Add a unit test per method using the schema shapes.
2. **Sensible defaults for Helix worktrees:** Codex `sandbox: 'workspace-write'` and `approvalPolicy: 'on-request'` are fine, but writes inside the session worktree must not need approval. If `on-request` still asks for in-worktree patches with this Codex version, auto-approve file changes whose paths are all inside the session worktree (log it as an `explain.note`), and surface anything outside the worktree or any command approval to the user.
3. **Protocol debug log:** when `HELIX_DEBUG_PROTOCOL=1`, append every raw JSON-RPC frame (both directions, timestamped, tokens redacted) to `<dataDir>/logs/<sessionId>.protocol.jsonl`. Off by default.
4. **Stall watchdog (core):** if a session is `active` and no harness emission arrives for 3 minutes (configurable), emit `explain.note` ("No activity from Codex for 3 minutes — it may be waiting on something Helix doesn't understand. Check the protocol log.") once per stall, and `activity.changed: unknown`. Resume normal status on the next emission.
5. **Harness detection is slow (~9 s per `/api/harnesses`).** Cache detection results in the daemon for 60 s; refresh in the background; first call may await.
6. **Default agent:** new projects default to a harness that is detected installed **and** signed in (prefer codex, then claude-code), not hard-coded claude-code.
7. **Repo path casing:** keep the case-insensitive lookup key, but store and return the user's original path casing in `Project.repoPath`.
8. **Terminal mode prompts:** deliver the prompt via PTY input after spawn instead of argv (so multi-line prompts work with `.cmd` shims).

## Verification
- `pnpm check` exits 0.
- New `HELIX_E2E=1` test in `apps/daemon`: real daemon + real Codex + temp repo, prompt "Create HELLO.md containing the word hello and commit it". Assert within 4 minutes: `activity idle`, `worktree.diff_updated` with ≥1 file, HELLO.md committed on the session branch, no unanswered server requests (protocol log), and no `unknown` activity. Claude will run this outside the sandbox — make it robust and well-logged.
- Result file per W1-common format, listing every server request method → handling → test.
