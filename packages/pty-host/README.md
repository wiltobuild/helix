# @helix/pty-host

`NodePtyHost` implements the frozen `TerminalHost` contract. Construct with
`{ dataDir, scrollbackBytes?, logMaxBytes?, onError? }`. The defaults retain 2 MiB
of UTF-8 output in memory and rotate logs at 20 MiB. `spawnPty` and `killTree`
are optional test seams; default tests do not load native code.

- `spawn(sessionId, options: TerminalSpawnOptions): Promise<void>` starts a PTY
  with the supplied command, argument array, cwd, environment overrides and size
  (80 by 24 by default). Windows uses node-pty's ConPTY default.
- `attach(sessionId, onOutput: (message: TerminalOutput) => void): Promise<TerminalAttachment>`
  replays scrollback before live messages. Multiple attachers are independent;
  reentrant output is queued until replay ends. `write`, `resize`, and `detach`
  implement the contract. Resize works before first output.
- `kill(sessionId): Promise<void>` tears down the process tree before releasing
  the PTY handle. Windows uses `taskkill.exe /T /F`; Unix discovers descendants
  with `ps` and kills descendants plus the PTY process group.
- `onExit(callback): Unsubscribe` reports each session exit once.
- `list(): SessionId[]` returns live sessions only.
- `flush(): Promise<void>` drains log writes and reports disk failures.
- `close(): Promise<void>` kills live terminals and flushes logs.

Output retains ANSI and CRLF unchanged. Scrollback is bounded in UTF-8 bytes and
never begins inside a UTF-8 character. Logs append raw bytes to
`<dataDir>/terminals/<sessionId>.log`; `.log.1` retains the previous rotation.
Large chunks are split at the byte threshold, so a Unicode character may span
rotation files. The combined bytes are unchanged. Disk writes are serialized and
PTY reads pause while the log queue exceeds the scrollback budget. Disk errors
are reported by `flush()` and `onError`; output observer failures are isolated.

Exited sessions retain scrollback and their exit message for later attachers.
Session IDs cannot be reused within one host lifetime, avoiding ambiguous replay.
IDs must be safe filesystem components (letters, digits, underscore or hyphen;
no Windows device names). Unknown sessions use NOT_FOUND, duplicates or writes to
closed attachments use CONFLICT, and spawn/runtime failures use INTERNAL_ERROR.

Pinned native dependency: node-pty 1.2.0-beta.15, published 2026-08-03. The npm
archive contains win32-x64/arm64, darwin-x64/arm64, and linux-x64/arm64 prebuilds.
Stable 1.1.0 does not contain Linux prebuilds. No compiler or build tool is added.
The root lockfile and build allowlist remain owned by the integrator.

Daemon restart survival is out of scope: processes and in-memory scrollback are
not rediscovered; logs remain on disk but are not replayed on startup. The host
does not emit HelixEvents; the core owns session lifecycle event persistence.

Set `HELIX_E2E=1` to enable the real Node/PTY suite, including stdin, resize,
exit codes, raw log rotation, and child/grandchild termination. Unix termination
is not an OS containment boundary for processes that deliberately escape while
being enumerated. CI must exercise both Windows and Linux native paths.
