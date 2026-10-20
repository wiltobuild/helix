# Fixture provenance

These are **hand-authored protocol fixtures**, not captured inference output.
On 2026-10-20, local `claude --version` returned `2.1.293 (Claude Code)` and
`codex.cmd --version` returned `codex-cli 0.163.0-alpha.10.2`. Both CLIs reported
not signed in (`claude auth status`, `codex.cmd login status`). No real model call
was made; gated E2E tests can be run after signing in.

Claude's headless streaming flags and permission mode were checked against local
`--help`. Control framing and `--permission-prompt-tool stdio` follow the official
[SDK transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)
and [control loop](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).
Codex items and approval shapes were checked against `app-server generate-ts`
from the installed binary and the [app-server documentation](https://learn.chatgpt.com/docs/app-server).

Optional, irrelevant fields are omitted. The fixtures include future/unknown
messages, errors, command and file changes, exposed reasoning summaries, and
approval requests. Tests inject CRLF and byte-sized UTF-8 chunks explicitly.
`fake-cli.cjs` implements just the exercised protocol surface; it never calls a
model, GitHub, a shell command requested by a model, or the network.
